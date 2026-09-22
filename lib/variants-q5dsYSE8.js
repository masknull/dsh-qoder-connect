import crypto, { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { EMPTY_RESPONSE_CODE, LlmError, ProviderRequestId, ReasoningEffortId, ToolCallId, attributionHeaders, contentHasImage, createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
//#region src/paths.ts
/**
* The plugin's data directory — the ONE place every file the plugin owns
* lives.
*
* Layout: `<profile>/.dsh-qoder-connect/state/` (the profile discovered
* the same way the credential store always did). Everything — PAT files,
* saved catalogs, probe records, the host heartbeat, and the machine-id
* seed — writes there, so a profile directory never collects loose
* `.qoder-*` files and the whole plugin's footprint is one folder.
*
* Fallbacks, in order: `DSH_QODER_DATA_DIR` env override → the discovered
* profile → the Harness home (a checkout running its own tests, or a host
* loading the plugin from outside any profile).
*
* Split out of `auth.ts` so catalog/probe/heartbeat stores can import the
* directory without pulling in the credential code (and its upstream
* dependency) — these modules stay leaf-light on purpose.
*
* @module dsh-qoder-connect/paths
*/
/** The per-profile directory the plugin's data folder lives under. */
const QODER_DATA_DIR_NAME = ".dsh-qoder-connect";
/** The directory inside the data dir where the rebuildable state files live. */
const QODER_STATE_DIR_NAME = "state";
/** Environment override for the whole data directory. */
const QODER_DATA_DIR_ENV = "DSH_QODER_DATA_DIR";
const PROFILES_DIR_NAME = "profiles";
/** The npm name of this package, as a profile's manifest declares it. */
const PLUGIN_PACKAGE_NAME = "dsh-qoder-connect";
function pluginPackageRoot() {
	try {
		return dirname(dirname(fileURLToPath(import.meta.url)));
	} catch {
		return;
	}
}
/**
* Whether a profile directory declares this plugin.
*
* Read from the profile's manifest rather than inferred from this module's own
* location, because DSH installs a plugin into a profile by *link*: the manifest
* carries `"dsh-qoder-connect": "link:/path/to/checkout"`, while Node
* resolves the module to that real path, which lies outside `$DSH_HOME` entirely.
* Walking up from the module would therefore miss the profile for exactly the
* install shape a developer uses.
*/
function profileDeclaresPlugin(profileDir) {
	try {
		const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
		return typeof manifest.dependencies?.[PLUGIN_PACKAGE_NAME] === "string" || typeof manifest.devDependencies?.[PLUGIN_PACKAGE_NAME] === "string";
	} catch {
		return false;
	}
}
/**
* Whether a profile's installed copy of this plugin resolves to this package.
*
* This is what separates two profiles that both declare the plugin — a `web` and
* a `desktop` profile can each list it — so the data directory follows the
* profile whose copy is actually running rather than the first one found.
*/
function profileLinksToThisPackage(profileDir) {
	const own = pluginPackageRoot();
	if (own === void 0) return false;
	try {
		return realpathSync(join(profileDir, "node_modules", PLUGIN_PACKAGE_NAME)) === realpathSync(own);
	} catch {
		return false;
	}
}
/**
* The profile directory this plugin belongs to, or undefined when none can be
* determined.
*
* A single declaring profile is accepted without the link test, so a normal
* (non-linked) install still resolves.
*/
function discoverProfileDir() {
	const profilesRoot = join(resolveDshHome(), PROFILES_DIR_NAME);
	let entries;
	try {
		entries = readdirSync(profilesRoot, { withFileTypes: true });
	} catch {
		return;
	}
	const candidates = [];
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const dir = join(profilesRoot, entry.name);
		if (profileDeclaresPlugin(dir)) candidates.push(dir);
	}
	if (candidates.length === 0) return void 0;
	if (candidates.length === 1) return candidates[0];
	return candidates.find((candidate) => profileLinksToThisPackage(candidate));
}
/**
* The plugin's data directory: `<profile>/.dsh-qoder-connect`.
*
* Falls back to the Harness home when no profile can be discovered — a
* checkout running its own tests, or a host that loads the plugin from
* outside a profile — so the plugin always has somewhere to write, and
* `DSH_QODER_DATA_DIR` overrides either way.
*/
function qoderPluginDataDir() {
	const override = process.env[QODER_DATA_DIR_ENV];
	if (override !== void 0 && override.trim() !== "") return override;
	const base = discoverProfileDir() ?? resolveDshHome();
	return join(base, QODER_DATA_DIR_NAME);
}
/**
* The directory the rebuildable state files live in:
* `<data dir>/state/` (saved catalogs, probe records, the host heartbeat).
*/
function qoderStateDir() {
	return join(qoderPluginDataDir(), QODER_STATE_DIR_NAME);
}
/**
* The plugin-owned seed for the Qoder transport's machine id.
*
* The transport's `getMachineId(paths)` helper reads a list of trusted
* locations and writes its created UUID into the last one; this is the
* DSH-side location the host wires into that chain, so the identifier stays
* inside the plugin's own folder instead of scattering files near `$HOME`.
*/
function qoderMachineIdPath() {
	return join(qoderStateDir(), ".qoder-machine-id");
}
//#endregion
//#region src/auth.ts
/**
* Qoder credential storage — one Personal Access Token per variant.
*
* Every credential the plugin holds is a PAT the human pasted into the
* variant's card (or exported into the environment, or saved by the CLI).
* There is no device flow, no token refresh, and no expiry: a PAT is valid
* until the user revokes it, so this store only reads, writes, and deletes a
* small JSON document.
*
* One file per variant inside the plugin's data directory
* (`<.dsh-qoder-connect>/`). The on-disk schema is
* `{version: 2, pat, region, savedAt}` — deliberately narrower than the
* WorkBuddy-era document it replaces: anything this file does not name is
* not a fact the plugin knows.
*
* @module dsh-qoder-connect/auth
*/
/** The on-disk document version this writer produces. */
const AUTH_SCHEMA_VERSION = 2;
/** Environment fallback for the global arm when no file exists. */
const QODER_PAT_ENV_GLOBAL = "QODER_PERSONAL_ACCESS_TOKEN";
/** Environment fallback for the China arm when no file exists. */
const QODER_PAT_ENV_CN = "QODER_CN_PERSONAL_ACCESS_TOKEN";
/** Basename of the China variant's credential file inside the data directory. */
const QODER_AUTH_FILENAME = ".qoder-auth.json";
/** Last four characters of a token, for display. */
function patTail(pat) {
	const trimmed = pat.trim();
	return trimmed.length >= 4 ? trimmed.slice(-4) : void 0;
}
/**
* Stable identity key for a credential, used by probe records and saved
* catalogs.
*
* A PAT is a bearer secret, so the key is its one-way hash rather than any
* suffix of it: surfaces that show the key (cards, JSON diagnostics) leak
* nothing usable, while two reads of the same token still correlate locally.
*/
function qoderCredentialIdentity(credential) {
	return `pat:${createHash("sha256").update(credential.pat).digest("hex").slice(0, 16)}`;
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRegion(value) {
	return value === "global" || value === "china";
}
var QoderCredentialStore = class {
	variant;
	ownPath;
	logger;
	/** The legacy-file warning is emitted once per process, not per read. */
	legacyWarned = false;
	constructor(options) {
		this.variant = options.variant;
		this.ownPath = options.ownPath ?? join(qoderPluginDataDir(), options.variant.ownFilename);
		this.logger = options.logger;
	}
	/** Absolute path of this variant's credential file, for display and tests. */
	ownAuthPath() {
		return this.ownPath;
	}
	/**
	* The credential currently in effect, or `undefined` when there is none.
	*
	* Resolution order: the plugin-owned file, then the arm's environment
	* variable (only when no file exists — a saved token always wins over a
	* stray env), then nothing. There is no refresh and no expiry check: a PAT
	* lives until revoked.
	*/
	async current() {
		const stored = await this.readOwn();
		if (stored !== void 0) return stored;
		return this.fromEnvironment();
	}
	/**
	* The credential, or a thrown `MISSING_CREDENTIAL` error.
	*
	* Callers that serve requests (the shim, the catalog sweep) use this so the
	* absence of a token surfaces as the same classified failure the transport
	* itself raises when a saved token turns out empty.
	*/
	async resolve() {
		const credential = await this.current();
		if (credential === void 0 || credential.pat.trim() === "") throw new Error("qoder: MISSING_CREDENTIAL — no Personal Access Token is configured. Add one in the Qoder settings card.");
		return credential;
	}
	/** The token in effect as a bare string, rejecting when there is none. */
	async patPromise() {
		return (await this.resolve()).pat;
	}
	/**
	* Persist a token for this variant. The caller is responsible for having
	* validated it against the region first (`validateApiKey` upstream).
	*/
	async save(pat, source = "card") {
		const trimmed = pat.trim();
		if (trimmed === "") throw new Error("qoder: cannot save an empty Personal Access Token");
		const credential = {
			pat: trimmed,
			region: this.variant.region,
			savedAtMs: Date.now(),
			source
		};
		await this.writeOwn(credential);
		return credential;
	}
	/** Remove the stored credential. A missing file is not an error. */
	async clear() {
		try {
			await rm(this.ownPath, { force: true });
		} catch {}
	}
	/** Alias kept for call-site readability (`logout` is just clearing). */
	async logout() {
		await this.clear();
	}
	/** Redacted summary for the card, the PAT route, and doctor output. */
	async status() {
		const base = {
			filePath: this.ownPath,
			region: this.variant.region
		};
		const credential = await this.current();
		if (credential === void 0) return {
			state: "missing",
			...base,
			...this.pendingLegacyReason === void 0 ? {} : { reason: this.pendingLegacyReason }
		};
		const tail = patTail(credential.pat);
		return {
			state: "configured",
			...base,
			pat: {
				source: credential.source,
				...credential.savedAtMs === void 0 ? {} : { savedAtMs: credential.savedAtMs },
				...tail === void 0 ? {} : { patTail: tail }
			}
		};
	}
	/** Set when a read found a stale WorkBuddy-era file; consumed once. */
	pendingLegacyReason;
	async fromEnvironment() {
		const name = this.variant.region === "china" ? QODER_PAT_ENV_CN : QODER_PAT_ENV_GLOBAL;
		const value = process.env[name]?.trim();
		if (value === void 0 || value === "") return void 0;
		return {
			pat: value,
			region: this.variant.region,
			source: "env"
		};
	}
	async readOwn() {
		let text;
		try {
			text = await readFile(this.ownPath, "utf8");
		} catch (error) {
			this.pendingLegacyReason = void 0;
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.pendingLegacyReason = void 0;
			return;
		}
		if (!isRecord$1(parsed)) {
			this.pendingLegacyReason = void 0;
			return;
		}
		if (typeof parsed["accessToken"] === "string" && parsed["pat"] === void 0) {
			this.pendingLegacyReason = "stale WorkBuddy credential file; save a Qoder Personal Access Token instead";
			if (!this.legacyWarned) {
				this.legacyWarned = true;
				this.logger?.warn?.(`qoder: ${this.variant.displayName}: ${this.ownPath} holds a WorkBuddy-era credential; it is ignored. Save a Qoder Personal Access Token to replace it.`);
			}
			return;
		}
		this.pendingLegacyReason = void 0;
		const pat = typeof parsed["pat"] === "string" ? parsed["pat"].trim() : "";
		if (pat === "") return void 0;
		const region = isRegion(parsed["region"]) ? parsed["region"] : this.variant.region;
		const savedAt = typeof parsed["savedAt"] === "number" && Number.isFinite(parsed["savedAt"]) ? parsed["savedAt"] : void 0;
		return {
			pat,
			region,
			...savedAt === void 0 ? {} : { savedAtMs: savedAt },
			source: "card"
		};
	}
	async writeOwn(credential) {
		const document = {
			version: AUTH_SCHEMA_VERSION,
			pat: credential.pat,
			region: credential.region,
			savedAt: credential.savedAtMs ?? Date.now()
		};
		const directory = dirname(this.ownPath);
		try {
			await mkdir(directory, {
				recursive: true,
				mode: 448
			});
		} catch {}
		await writeFileAtomic(this.ownPath, `${JSON.stringify(document, null, 2)}\n`, {
			mode: 384,
			dirMode: 448
		});
		this.pendingLegacyReason = void 0;
	}
};
/**
* The plugin-owned credential path for one variant's default filename.
* Kept as a free function for the CLI, which builds no store per display line.
*/
function qoderOwnAuthPath(variant) {
	return join(qoderPluginDataDir(), variant.ownFilename);
}
//#endregion
//#region src/status-paths.ts
/** Plugin-owned status endpoint consumed by its browser half. */
const QODER_STATUS_PATH = "/plugins/dsh-qoder-connect/status";
/**
* Plugin-owned probe control endpoint.
*
* Separate from the status route because it accepts writes: the status route's
* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
* not the same as authorizing a state-changing action. This route therefore
* also requires the in-process key the browser half receives with the status
* document.
*/
const QODER_PROBE_PATH = "/plugins/dsh-qoder-connect/probe";
/**
* Plugin-owned PAT endpoint, one per variant.
*
* A POST here saves (validates and persists) a Personal Access Token, or
* clears the stored one. Unlike the read-only status GET it is a write —
* it persists a credential — so it also requires the in-process key the
* browser half receives with the status document.
*/
const QODER_AUTH_PATH = "/plugins/dsh-qoder-connect/auth";
/**
* The international (Qoder Global) variant's own triple of routes.
*
* Kept as separate constants rather than a computed suffix so both halves
* reference literal strings: the browser bundle and the host bundle are built
* independently, and a shared expression is one build-config drift away from
* the desk asking a route the host never mounted.
*/
const QODER_GLOBAL_STATUS_PATH = "/plugins/dsh-qoder-connect/global/status";
const QODER_GLOBAL_PROBE_PATH = "/plugins/dsh-qoder-connect/global/probe";
const QODER_GLOBAL_AUTH_PATH = "/plugins/dsh-qoder-connect/global/auth";
//#endregion
//#region src/catalog.ts
/**
* The built-in roster, transcribed from the transport's own `defaultModels`
* (`src/qoder/catalog.ts`) — the Qoder model keys both regions start from
* before the first successful discovery: `cmodel`, `auto`, `ultimate`,
* `performance`, `efficient`, `lite`.
*
* It exists so the provider registers with a usable catalog while the first
* fetch is in flight or the endpoint is unreachable, and it is deliberately
* *not* a promise about the upstream's current state: the discovery answer
* replaces it at startup. No per-region roster is invented here — the
* transport ships one shared default set, and this mirror keeps the same
* discipline. Reasoning and rate metadata are absent because the defaults
* declare none; those rows offer no thinking control until the upstream says
* otherwise.
*/
const FALLBACK_QODER_MODELS = [
	{
		id: "cmodel",
		name: "Cantus (Qoder)",
		contextWindow: 1e6,
		maxTokens: 32768,
		supportsImages: true,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	},
	{
		id: "auto",
		name: "Qoder Auto",
		contextWindow: 18e4,
		maxTokens: 32768,
		supportsImages: true,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	},
	{
		id: "ultimate",
		name: "Qoder Ultimate",
		contextWindow: 1e6,
		maxTokens: 32768,
		supportsImages: true,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	},
	{
		id: "performance",
		name: "Qoder Performance",
		contextWindow: 1e6,
		maxTokens: 32768,
		supportsImages: true,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	},
	{
		id: "efficient",
		name: "Qoder Efficient",
		contextWindow: 18e4,
		maxTokens: 32768,
		supportsImages: true,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	},
	{
		id: "lite",
		name: "Qoder Lite",
		contextWindow: 18e4,
		maxTokens: 32768,
		supportsImages: false,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	}
];
/**
* Mutable catalog shared by the shim's `/v1/models` and the adapter.
*
* Visibility is separate from content. A variant with no usable credential
* must expose *no* models rather than a fallback roster: the DSH model picker
* drops an empty group, so an empty catalog is exactly how a provider hides
* without touching registration. Serving the fallback to a signed-out user
* instead offers models that can only fail (the transport throws
* `MISSING_CREDENTIAL` on the first message), which is worse than showing
* nothing.
*
* The flag defaults to visible so a directly-constructed catalog behaves as
* it always has; the plugin runtime applies the credential gate.
*/
var QoderCatalog = class {
	models;
	visible = true;
	useMaximumContextWindow = false;
	/** Per-model window overrides (model id → tokens); an override wins over the preference. */
	modelContextWindows = {};
	constructor(initial = FALLBACK_QODER_MODELS) {
		this.models = initial;
	}
	/** Current entries; empty while the variant has no usable credential. */
	current() {
		if (!this.visible) return [];
		return this.models.map((model) => {
			const override = this.modelContextWindows[model.id];
			if (override !== void 0 && override > 0) return {
				...model,
				defaultContextWindow: model.defaultContextWindow ?? model.contextWindow,
				contextWindow: override
			};
			const maximum = model.supportedContextWindows === void 0 ? void 0 : Math.max(...model.supportedContextWindows);
			return this.useMaximumContextWindow && maximum !== void 0 && maximum > model.contextWindow ? {
				...model,
				defaultContextWindow: model.defaultContextWindow ?? model.contextWindow,
				contextWindow: maximum
			} : model;
		});
	}
	/** Replace the list; callers invalidate their adapter snapshot after this. */
	set(models) {
		this.models = [...models];
	}
	/** Whether this variant's models are exposed at all. */
	isVisible() {
		return this.visible;
	}
	/**
	* Show or hide the whole catalog. Returns whether the value changed, so the
	* caller can skip an invalidation that would re-render an identical list.
	*/
	setVisible(visible) {
		if (this.visible === visible) return false;
		this.visible = visible;
		return true;
	}
	/** Select the largest declared window where the upstream offers one. */
	setUseMaximumContextWindow(useMaximum) {
		if (this.useMaximumContextWindow === useMaximum) return false;
		this.useMaximumContextWindow = useMaximum;
		return true;
	}
	/**
	* Replace the per-model window overrides wholesale. Returns whether the map
	* changed, so the caller can skip an invalidation over an identical write.
	*/
	setModelContextWindows(modelContextWindows) {
		const next = { ...modelContextWindows };
		if (JSON.stringify(next) === JSON.stringify(this.modelContextWindows)) return false;
		this.modelContextWindows = next;
		return true;
	}
	/**
	* Models to fall back to when the upstream fetch fails; ignores
	* visibility, because the caller asking for the fallback already knows the
	* credential state.
	*/
	fallback() {
		return this.models;
	}
};
//#endregion
//#region src/catalog-store.ts
/**
* The last catalog that actually loaded, kept per variant and per account.
*
* Both the plan (§4 "降级顺序为同账号的最近成功目录 → 本版内置保守目录")
* and the README promise this fallback, and without it a restart always drops
* the user to the built-in roster even when a good catalog was fetched minutes
* earlier. The built-in roster is a snapshot taken once; a fetched catalog is
* what the upstream actually serves to this account.
*
* What it deliberately is *not*:
*
* - not a cache with a freshness policy — it never prevents a fetch, it only
*   answers when a fetch cannot;
* - not shared across accounts (a different account can see a different roster),
*   nor across variants (the two regions serve overlapping ids with different
*   capacity and rate answers);
* - not a place for secrets: model metadata only, never a token. The account
*   key is a one-way hash of the credential, not the credential itself.
*
* @module dsh-qoder-connect/catalog-store
*/
/** On-disk format this reader accepts; other versions are discarded. */
const CATALOG_FORMAT_VERSION = 1;
/** Plugin-owned saved-catalog path inside the plugin's state directory. */
function qoderCatalogPath(filename) {
	return join(qoderStateDir(), filename);
}
/** Whether a parsed value is a model row worth keeping. */
function isModel(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const row = value;
	return typeof row["id"] === "string" && row["id"] !== "" && typeof row["name"] === "string" && typeof row["contextWindow"] === "number" && Number.isFinite(row["contextWindow"]) && typeof row["maxTokens"] === "number" && Number.isFinite(row["maxTokens"]) && typeof row["supportsImages"] === "boolean";
}
/** Whether a parsed value is a saved catalog this reader can trust. */
function isSaved(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value;
	if (typeof entry["account"] !== "string" || entry["account"] === "") return false;
	if (typeof entry["source"] !== "string" || entry["source"] === "") return false;
	if (typeof entry["fetchedAtMs"] !== "number" || !Number.isFinite(entry["fetchedAtMs"])) return false;
	const models = entry["models"];
	if (!Array.isArray(models) || models.length === 0) return false;
	return models.every(isModel);
}
/**
* The last successful catalog per account, read once and written atomically.
*
* Malformed content reads as "nothing saved" rather than throwing: this file
* is an optimization for the offline and first-seconds cases, and a corrupt one
* must never be able to stop the plugin from serving models.
*/
var QoderCatalogStore = class {
	path;
	entries;
	constructor(options = {}) {
		this.path = typeof options === "string" ? options : options.path ?? qoderCatalogPath(".qoder-catalog.json");
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.entries !== void 0) return this.entries;
		const entries = {};
		if (existsSync(this.path)) try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const document = parsed;
				const raw = document["version"] === CATALOG_FORMAT_VERSION ? document["entries"] : void 0;
				if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
					for (const [key, value] of Object.entries(raw)) if (isSaved(value)) entries[key] = value;
				}
			}
		} catch {}
		this.entries = entries;
		return entries;
	}
	/** The saved catalog for one account, or `undefined` when there is none. */
	get(account) {
		const entry = this.load()[account];
		return entry === void 0 ? void 0 : entry;
	}
	/**
	* Remember a catalog for an account, replacing whatever was saved before.
	*
	* A failed write is swallowed: the plugin has already served these models,
	* and losing the *memory* of them is not worth surfacing.
	*/
	set(account, catalog) {
		const entries = this.load();
		entries[account] = {
			account,
			...catalog
		};
		this.persist();
	}
	/** Forget one account's catalog — used when that account signs out. */
	delete(account) {
		const entries = this.load();
		if (!(account in entries)) return;
		delete entries[account];
		this.persist();
	}
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: CATALOG_FORMAT_VERSION,
				entries: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {}
	}
};
//#endregion
//#region src/probe.ts
/**
* The reasoning-effort probe: decide whether a model's `reasoning_effort`
* parameter is actually validated, and if so which canonical values it accepts.
*
* Implements `docs/reasoning-effort-probe-plan.md` §4. The order matters and is
* not an optimization:
*
* 1. **Baseline** (no `reasoning_effort`) proves the model, credential, and
*    request shape work at all, so a later rejection can be attributed.
* 2. **Sentinel** (a fresh random, impossible-to-collide value) answers the one
*    question a per-level sweep cannot: does the upstream validate the field?
*    A model that accepts the sentinel answers 200 to *everything*, so its
*    per-level results would be uniformly false positives.
* 3. **Levels**, only after the sentinel was refused.
*
* The result is an observation, never a capability claim. Even a fully
* successful sweep means "the upstream accepted these spellings", not "these
* spellings change how the model thinks".
*
* @module dsh-qoder-connect/probe
*/
/**
* The canonical values a probe tests, in a fixed order.
*
* `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
* by policy — disabling thinking is a separate capability the upstream must
* declare through `canDisableThinking`, never something probing may infer.
*/
const PROBE_EFFORT_CANDIDATES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Prompt body used by every probe request; carries nothing user-specific. */
const PROBE_PROMPT = "ping";
/** Default sentinel: unmistakably non-canonical, different on every call. */
function randomSentinel() {
	return `probe_sentinel_${randomBytes(12).toString("hex")}`;
}
/**
* The transport's rejection code for an effort the model does not advertise
* (`src/qoder/transport/wire/serialize.ts`).
*
* With the Qoder upstream this rejection is raised *locally* against the
* discovery catalog before any network call: a probe therefore measures the
* catalog's declaration as much as the endpoint behind it. That is a weaker
* finding than the WorkBuddy-era one, and it is what the plan's Stage D will
* weigh; the sequence below still distinguishes "advertises and validates"
* (per-level refusals after an accepted baseline) from "accepts anything the
* catalog does not name" — the sentinel answers that question against the
* same vocabulary the request path will later enforce.
*/
const INVALID_EFFORT_CODE = "UNSUPPORTED_REASONING_EFFORT";
/** Whether an attempt is an attributable rejection of the effort value. */
function isEffortRejection(attempt) {
	return attempt.status === 400 && attempt.errorCode === INVALID_EFFORT_CODE;
}
/** Whether an attempt shows the upstream accepted the request and streamed. */
function isAcceptance(attempt) {
	return attempt.status === 200 && attempt.streamed;
}
/** Why an attempt ended in `unknown`, phrased for a log line. */
function unknownReason(stage, attempt) {
	const code = attempt.errorCode === void 0 ? "" : ` (${attempt.errorCode})`;
	const detail = attempt.detail === void 0 ? "" : `: ${attempt.detail}`;
	return `${stage} status ${attempt.status}${code}${detail}`;
}
/**
* Probe one model.
*
* `options.candidates` exists so tests can shorten the sweep; production always
* uses {@link PROBE_EFFORT_CANDIDATES}.
*/
async function probeModel(options) {
	const sentinel = options.sentinel ?? randomSentinel;
	const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES;
	const timeoutMs = options.timeoutMs ?? 3e4;
	let requests = 0;
	const attempt = async (effort) => {
		requests += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await options.send(effort, controller.signal);
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		} finally {
			clearTimeout(timer);
		}
	};
	const baseline = await attempt(void 0);
	if (!isAcceptance(baseline)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("baseline", baseline)
	};
	const sentinelAttempt = await attempt(sentinel());
	if (isAcceptance(sentinelAttempt)) return {
		validation: "non-validating",
		efforts: [],
		requests
	};
	if (!isEffortRejection(sentinelAttempt)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("sentinel", sentinelAttempt)
	};
	const accepted = [];
	for (const effort of candidates) {
		const levelAttempt = await attempt(effort);
		if (isAcceptance(levelAttempt)) {
			accepted.push(effort);
			continue;
		}
		if (isEffortRejection(levelAttempt)) continue;
		return {
			validation: "unknown",
			efforts: [],
			requests,
			reason: unknownReason(`level ${effort}`, levelAttempt)
		};
	}
	return {
		validation: "validating",
		efforts: accepted,
		requests
	};
}
//#endregion
//#region src/qoder/transport/endpoints.ts
const qoderRegionEndpoints = {
	global: {
		baseUrl: "https://api3.qoder.sh/",
		openApiUrl: "https://openapi.qoder.sh",
		centerUrl: "https://center.qoder.sh"
	},
	china: {
		baseUrl: "https://gateway.qoder.com.cn/",
		openApiUrl: "https://openapi.qoder.com.cn",
		centerUrl: "https://gateway.qoder.com.cn"
	}
};
/** Signed path of the center image upload route; it never carries an `/algo` prefix. */
const qoderImageUploadPath = "/api/v2/image/upload";
qoderRegionEndpoints.global.baseUrl;
qoderRegionEndpoints.global.openApiUrl;
function resolveQoderEndpoints(region = "global") {
	return qoderRegionEndpoints[region] ?? qoderRegionEndpoints.global;
}
function getQoderChatUrl(region = "global") {
	const { baseUrl } = resolveQoderEndpoints(region);
	return `${baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}
function getQoderModelListUrl(region = "global") {
	const { baseUrl } = resolveQoderEndpoints(region);
	return `${baseUrl}algo/api/v2/model/list?Encode=1`;
}
function getQoderImageUploadUrl(region = "global", requestId) {
	const { centerUrl } = resolveQoderEndpoints(region);
	const base = `${centerUrl.replace(/\/+$/u, "")}/algo${qoderImageUploadPath}`;
	return requestId === void 0 ? base : `${base}?request_id=${encodeURIComponent(requestId)}`;
}
function getQoderExchangeUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/api/v1/jobToken/exchange`;
}
function getQoderUserInfoUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/api/v1/userinfo`;
}
function getQoderUsageUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/api/v2/quota/usage`;
}
function getQoderUserPlanUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/api/v2/user/plan`;
}
function getQoderUserStatusUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/api/v3/user/status`;
}
function getQoderCampaignsUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/sash/api/v1/me/campaigns`;
}
function getQoderClaimCampaignUrl(region = "global", campaignId) {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`;
}
//#endregion
//#region src/qoder/errors.ts
/**
* DSH-compatible LLM error representation.
*
* @module dsh-provider-qoder/qoder/errors
*/
var QoderLlmError = class extends LlmError {
	constructor(message, code = "UNKNOWN_ERROR", options) {
		super(message, code, options);
	}
};
function qoderHttpError(message, response) {
	const { status } = response;
	const code = status === 401 || status === 403 ? "AUTH" : status === 408 ? "TIMEOUT" : status === 429 ? "RATE_LIMIT" : status >= 500 && status <= 599 ? "SERVER" : status >= 400 && status <= 499 ? "INVALID_REQUEST" : "PROVIDER_ERROR";
	const providerRetryAfterMs = retryAfterMs(response.headers?.get("retry-after") ?? null);
	const requestId = qoderRequestId(response.headers);
	return new QoderLlmError(message, code, {
		status,
		...providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs },
		...requestId === void 0 ? {} : { requestId }
	});
}
function qoderRequestId(headers) {
	const normalized = (headers?.get("x-request-id") ?? headers?.get("request-id") ?? headers?.get("x-amzn-requestid"))?.trim();
	return normalized ? ProviderRequestId(normalized) : void 0;
}
/**
* Whether this failure is an upstream authorization rejection worth one
* re-auth retry.
*
* The job token the transport signs requests with is cached in memory; an
* upstream that invalidates it mid-lifetime (gateway rotation or a fault
* window) answers HTTP 401/403 before any payload is produced. That state is
* distinguishable from a genuinely revoked PAT only by trying a fresh
* exchange, so callers clear their credential cache and retry once before
* reporting `AUTH` to the user.
*/
function isQoderAuthRejection(error) {
	return error instanceof LlmError && (error.code === "AUTH" || error.failure.status === 401 || error.failure.status === 403);
}
function retryAfterMs(value, nowMs = Date.now()) {
	const normalized = value?.trim();
	if (!normalized) return void 0;
	if (/^\d+$/u.test(normalized)) {
		const delayMs = Number(normalized) * 1e3;
		return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : void 0;
	}
	const retryAt = Date.parse(normalized);
	if (Number.isNaN(retryAt)) return void 0;
	const delayMs = retryAt - nowMs;
	return delayMs > 0 ? delayMs : void 0;
}
//#endregion
//#region src/qoder/transport/machine-id.ts
function defaultMachineIdPaths() {
	return [join(homedir(), ".qoder", ".auth", "machine_id"), join(homedir(), ".dsh", "qoder", "machine_id")];
}
/** Read Qoder's machine id or create the DSH-owned fallback. */
function getMachineId(paths = defaultMachineIdPaths()) {
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const value = readFileSync(path, "utf8").trim();
			if (value) return value;
		} catch {}
	}
	const machineId = crypto.randomUUID();
	const savePath = paths.at(-1);
	if (savePath !== void 0) try {
		mkdirSync(dirname(savePath), { recursive: true });
		writeFileSync(savePath, machineId, {
			encoding: "utf8",
			flag: "wx"
		});
	} catch {
		try {
			const existing = readFileSync(savePath, "utf8").trim();
			if (existing) return existing;
		} catch {}
	}
	return machineId;
}
//#endregion
//#region src/qoder/transport/logging.ts
const sensitiveKey = /(?:authorization|credential|password|secret|token)/iu;
const identifierKey = /^(?:accountId|id|uid|userId)$/iu;
const tokenValue = /\b(?:jrt|jt|pt)-[\w.-]+\b/giu;
const bearerValue = /Bearer\s+[^\s,;]+/giu;
const maxDepth = 4;
const maxEntries = 50;
const maxStringLength = 500;
function maskIdentifier(value) {
	const text = String(value);
	return text.length <= 4 ? "[REDACTED]" : `…${text.slice(-4)}`;
}
function maskEmail(value) {
	const text = String(value);
	const at = text.indexOf("@");
	if (at <= 0) return "[REDACTED]";
	return `${text.slice(0, 1)}***${text.slice(at)}`;
}
function redactString(value) {
	return (value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…` : value).replace(tokenValue, "[REDACTED]").replace(bearerValue, "Bearer [REDACTED]");
}
/** Redact credentials and bound arbitrary provider values before logging them. */
function redactLogValue(value, depth = 0) {
	if (typeof value === "string") return redactString(value);
	if (value === null || typeof value !== "object") return value;
	if (depth >= maxDepth) return "[TRUNCATED]";
	if (value instanceof Error) return {
		name: value.name,
		message: redactString(value.message),
		..."code" in value ? { code: redactLogValue(value.code, depth + 1) } : {}
	};
	if (Array.isArray(value)) return value.slice(0, maxEntries).map((item) => redactLogValue(item, depth + 1));
	return Object.fromEntries(Object.entries(value).slice(0, maxEntries).map(([key, item]) => {
		if (sensitiveKey.test(key)) return [key, "[REDACTED]"];
		if (identifierKey.test(key)) return [key, maskIdentifier(item)];
		if (key.toLowerCase() === "email") return [key, maskEmail(item)];
		return [key, redactLogValue(item, depth + 1)];
	}));
}
/** Parse JSON-shaped diagnostics when possible, then apply the same redaction boundary. */
function redactLogPayload(text) {
	try {
		return redactLogValue(JSON.parse(text));
	} catch {
		return redactLogValue(text);
	}
}
/** Log one successfully parsed non-stream response through the shared redaction policy. */
function logParsedResponse(logger, operation, result) {
	logger?.debug?.("[Qoder Response] Parsed", redactLogValue({
		operation,
		result
	}));
}
//#endregion
//#region src/qoder/transport/wire/cosy.ts
/**
* COSY authentication headers and signature algorithm for Qoder services.
*
* Implements RSA + AES + MD5 signature generation required by the upstream
* Qoder gateway.
*
* @module dsh-provider-qoder/qoder/transport/wire/cosy
*/
const qoderRSAPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const qoderIdeVersion = "1.1.47";
const defaultUserAgent = `qoder/${qoderIdeVersion}`;
const qoderDesktopVersion = "0.3.4";
const qoderDesktopUserAgent = "Qoder";
const qoderDataPolicy = "disagree";
const qoderLoginVersion = "v2";
const qoderMachineOs = process.platform === "win32" ? process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows" : process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
const qoderMachineTypeMagic = "5";
function computeSigPath(urlStr) {
	let sigPath = new URL(urlStr).pathname;
	if (sigPath.startsWith("/algo")) sigPath = sigPath.substring(5);
	return sigPath;
}
function rsaEncryptBase64(data) {
	const key = {
		key: qoderRSAPublicKey,
		padding: crypto.constants.RSA_PKCS1_PADDING
	};
	return crypto.publicEncrypt(key, typeof data === "string" ? Buffer.from(data) : data).toString("base64");
}
function aesEncryptCBCBase64(plaintext, keyStr) {
	const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(keyStr), Buffer.from(keyStr));
	let encrypted = cipher.update(plaintext, "utf8", "base64");
	encrypted += cipher.final("base64");
	return encrypted;
}
function buildAuthHeaders(body, requestURL, creds) {
	if (!creds.userID) throw new Error("cosy: user id is empty");
	if (!creds.authToken) throw new Error("cosy: auth token is empty");
	const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
	const userInfo = {
		uid: creds.userID,
		security_oauth_token: creds.authToken,
		name: creds.name || "",
		aid: "",
		email: creds.email || ""
	};
	const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey);
	const cosyKey = rsaEncryptBase64(aesKey);
	const timestamp = Math.floor(Date.now() / 1e3).toString();
	const cosyPayload = {
		version: "v1",
		requestId: crypto.randomUUID(),
		info: infoB64,
		cosyVersion: qoderIdeVersion,
		ideVersion: ""
	};
	const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString("base64");
	const sigPath = computeSigPath(requestURL);
	const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${body ? Buffer.isBuffer(body) ? body.toString("utf8") : body : ""}\n${sigPath}`;
	const sig = crypto.createHash("md5").update(sigInput).digest("hex");
	const bodyHash = crypto.createHash("md5").update(body || "").digest("hex");
	const bodyLen = body ? (Buffer.isBuffer(body) ? body.length : Buffer.from(body).length).toString() : "0";
	const machineID = creds.machineID || getMachineId();
	return {
		Authorization: `Bearer COSY.${payloadB64}.${sig}`,
		"Cosy-Key": cosyKey,
		"Cosy-User": creds.userID,
		"Cosy-Date": timestamp,
		"Cosy-Version": qoderIdeVersion,
		"Cosy-Machineid": machineID,
		"Cosy-Machinetoken": machineID,
		"Cosy-Machinetype": qoderMachineTypeMagic,
		"Cosy-Machineos": qoderMachineOs,
		"Cosy-Clienttype": "5",
		"Cosy-Clientip": "127.0.0.1",
		"Cosy-Bodyhash": bodyHash,
		"Cosy-Bodylength": bodyLen,
		"Cosy-Sigpath": sigPath,
		"Cosy-Data-Policy": qoderDataPolicy,
		"Cosy-Organization-Id": "",
		"Cosy-Organization-Tags": "",
		"Login-Version": qoderLoginVersion,
		"X-Request-Id": crypto.randomUUID()
	};
}
const defaultMaxJsonBytes = 2097152;
const defaultMaxErrorBytes = 16384;
const metadataRetryBaseDelayMs = 200;
const maxProviderRetryDelayMs = 1e4;
function opaqueCredentialKey(value) {
	return createHash("sha256").update(value).digest("hex");
}
function retryableMetadataError(error) {
	return error instanceof QoderLlmError && [
		"RATE_LIMIT",
		"SERVER",
		"TIMEOUT",
		"TRANSPORT"
	].includes(error.code);
}
function abortableDelay(ms, signal) {
	if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
async function retryMetadataRead(signal, operation) {
	try {
		return await operation();
	} catch (error) {
		if (!retryableMetadataError(error) || signal.aborted) throw error;
		const providerDelay = error.failure.providerRetryAfterMs;
		await abortableDelay(providerDelay === void 0 ? metadataRetryBaseDelayMs + Math.floor(Math.random() * 41) : Math.min(providerDelay, maxProviderRetryDelayMs), signal);
		return operation();
	}
}
function withDeadline(signal, timeoutMs) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return {
		timeoutSignal,
		signal: signal === void 0 ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
	};
}
async function readLimitedText(response, maxBytes, label) {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel().catch(() => void 0);
		throw new QoderLlmError(`${label} exceeded its response size limit.`, "MALFORMED_RESPONSE");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new QoderLlmError(`${label} exceeded its response size limit.`, "MALFORMED_RESPONSE");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}
var SingleFlight = class {
	flights = /* @__PURE__ */ new Map();
	run(key, signal, start, abortedError) {
		if (signal?.aborted) return Promise.reject(abortedError());
		let flight = this.flights.get(key);
		if (flight === void 0 || flight.controller.signal.aborted) {
			const controller = new AbortController();
			const created = {};
			created.controller = controller;
			created.settled = false;
			created.waiters = 0;
			created.promise = start(controller.signal).finally(() => {
				created.settled = true;
				if (this.flights.get(key) === created) this.flights.delete(key);
			});
			flight = created;
			this.flights.set(key, created);
		}
		flight.waiters++;
		return new Promise((resolve, reject) => {
			let finished = false;
			const finish = (callback) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", onAbort);
				flight.waiters--;
				if (flight.waiters === 0 && !flight.settled) {
					if (this.flights.get(key) === flight) this.flights.delete(key);
					flight.controller.abort("all callers aborted");
				}
				callback();
			};
			const onAbort = () => finish(() => reject(abortedError()));
			signal?.addEventListener("abort", onAbort, { once: true });
			flight.promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
		});
	}
};
async function openApiJsonRequest(fetchImpl, options) {
	const method = options.method ?? (options.body !== void 0 ? "POST" : "GET");
	const timeoutMs = options.timeoutMs ?? 15e3;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = options.signal === void 0 ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
	const startedAt = performance.now();
	options.logger?.debug?.(`[Qoder ${options.operation}] Requesting`, {
		url: options.url,
		method
	});
	try {
		const headers = {
			accept: "application/json",
			"user-agent": options.userAgent ?? defaultUserAgent,
			"cosy-version": "1.0.1",
			"cosy-clienttype": "5",
			...options.headers
		};
		if (options.token) headers.authorization = `Bearer ${options.token}`;
		if (options.machineId) {
			headers["Cosy-MachineToken"] = options.machineId;
			headers["Cosy-MachineType"] = "host";
		}
		let bodyText;
		if (options.body !== void 0) {
			headers["content-type"] = "application/json";
			bodyText = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
		}
		const response = await fetchImpl(options.url, {
			method,
			headers,
			...bodyText === void 0 ? {} : { body: bodyText },
			signal: requestSignal
		});
		options.logger?.debug?.(`[Qoder ${options.operation}] Request completed`, {
			status: response.status,
			statusText: response.statusText,
			durationMs: Math.round(performance.now() - startedAt),
			...qoderRequestId(response.headers) === void 0 ? {} : { requestId: qoderRequestId(response.headers) }
		});
		const text = await readLimitedText(response, response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes, `Qoder ${options.operation} response`);
		if (!response.ok) {
			options.logger?.error?.(`[Qoder ${options.operation}] Request failed`, redactLogPayload(text));
			throw qoderHttpError(`Failed to execute Qoder ${options.operation} with status ${response.status}.`, response);
		}
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			options.logger?.error?.(`[Qoder ${options.operation}] Invalid JSON response`, redactLogPayload(text));
			throw new QoderLlmError(`Failed to parse Qoder ${options.operation} JSON response`, "MALFORMED_RESPONSE");
		}
		if (options.logCategory) logParsedResponse(options.logger, options.logCategory, data);
		return data;
	} catch (error) {
		if (error instanceof QoderLlmError) throw error;
		if (options.signal?.aborted) throw new QoderLlmError(`Qoder ${options.operation} request was aborted.`, "ABORTED");
		if (timeoutSignal.aborted) throw new QoderLlmError(`Qoder ${options.operation} request timed out.`, "TIMEOUT");
		throw new QoderLlmError(`Qoder ${options.operation} network request failed.`, "TRANSPORT", { cause: error });
	}
}
//#endregion
//#region src/qoder/transport/auth.ts
const expiryBufferMs = 3e5;
const defaultExpiryMs = 864e5;
const defaultAuthTimeoutMs = 15e3;
function abortedError() {
	return new QoderLlmError("Qoder authentication was aborted.", "ABORTED");
}
async function waitForFlight(promise, signal) {
	if (signal === void 0) return promise;
	if (signal.aborted) throw abortedError();
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortedError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
var QoderAuthService = class {
	cache = /* @__PURE__ */ new Map();
	inFlight = /* @__PURE__ */ new Map();
	fetchImpl;
	timeoutMs;
	resolveMachineId;
	region;
	logger;
	constructor(options = {}) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? defaultAuthTimeoutMs;
		this.resolveMachineId = options.resolveMachineId ?? getMachineId;
		this.region = options.region ?? "global";
		this.logger = options.logger;
	}
	clear(pat) {
		if (pat) this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`);
		else this.cache.clear();
	}
	/**
	* Exchange a fresh job token OUTSIDE the single-flight, for the self-heal
	* retry. The shared flight can be aborted by a departing concurrent waiter
	* (the quota poll, the catalog sweep), and a retry that joins it would then
	* be cancelled by a path that has nothing to do with the chat. The result
	* replaces the cache entry.
	*/
	async exchangeFresh(pat, signal) {
		this.clear(pat);
		return await this.exchangeAndResolve(pat, signal ?? AbortSignal.timeout(this.timeoutMs));
	}
	async getCredentials(pat, signal) {
		if (!pat || typeof pat !== "string") throw new QoderLlmError("Qoder Personal Access Token is missing or invalid. Configure Qoder in the Qoder settings page.", "MISSING_CREDENTIAL");
		if (signal?.aborted) throw abortedError();
		const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`;
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now() + expiryBufferMs) return cached.creds;
		let entry = this.inFlight.get(cacheKey);
		if (entry === void 0 || entry.controller.signal.aborted) {
			const controller = new AbortController();
			const created = {};
			created.controller = controller;
			created.waiters = 0;
			created.settled = false;
			created.timeout = setTimeout(() => controller.abort("authentication timeout"), this.timeoutMs);
			created.promise = this.exchangeAndResolve(pat, controller.signal).finally(() => {
				created.settled = true;
				clearTimeout(created.timeout);
				if (this.inFlight.get(cacheKey) === created) this.inFlight.delete(cacheKey);
			});
			entry = created;
			this.inFlight.set(cacheKey, entry);
		}
		entry.waiters++;
		try {
			return await waitForFlight(entry.promise, signal);
		} finally {
			entry.waiters--;
			if (entry.waiters === 0 && !entry.settled) {
				if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey);
				entry.controller.abort("all callers aborted");
			}
		}
	}
	async exchangeAndResolve(pat, signal) {
		let jobToken;
		let expiresAt = Date.now() + defaultExpiryMs;
		const data = await openApiJsonRequest(this.fetchImpl, {
			url: getQoderExchangeUrl(this.region),
			body: { personal_token: pat },
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "Auth",
			logCategory: "auth.exchange"
		});
		if (!data.token) throw new QoderLlmError("Qoder PAT exchange returned no job token.", "AUTH");
		jobToken = data.token;
		if (data.expires_at) {
			const parsed = Date.parse(data.expires_at);
			if (!Number.isNaN(parsed)) expiresAt = parsed;
		} else if (typeof data.expires_in === "number" && data.expires_in > 0) expiresAt = Date.now() + data.expires_in;
		const userInfo = await retryMetadataRead(signal, () => this.fetchUserInfo(jobToken, signal));
		const creds = {
			userID: userInfo.userID,
			authToken: jobToken,
			name: userInfo.name || "Qoder User",
			email: userInfo.email,
			machineID: this.resolveMachineId()
		};
		const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`;
		this.cache.set(cacheKey, {
			creds,
			expiresAt
		});
		return creds;
	}
	async fetchUserInfo(jobToken, signal) {
		const info = await openApiJsonRequest(this.fetchImpl, {
			url: getQoderUserInfoUrl(this.region),
			token: jobToken,
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "UserInfo",
			logCategory: "auth.user-info"
		});
		if (!info.id) throw new QoderLlmError("Qoder identity lookup returned no user id.", "AUTH");
		return {
			userID: info.id,
			email: info.email ?? "",
			name: info.name ?? info.username ?? ""
		};
	}
};
//#endregion
//#region src/qoder/catalog.ts
const reasoningEffortOrder = /* @__PURE__ */ new Map([
	["low", 0],
	["medium", 1],
	["high", 2],
	["xhigh", 3],
	["max", 4]
]);
function positiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function contextOptionsOf(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const options = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
		const entry = raw;
		const tokenCount = positiveNumber(entry.token_count);
		const isDefault = typeof entry.is_default === "boolean" ? entry.is_default : void 0;
		if (tokenCount === void 0) continue;
		options[key] = {
			...tokenCount === void 0 ? {} : { tokenCount },
			...isDefault === void 0 ? {} : { isDefault }
		};
	}
	if (Object.keys(options).length === 0) return void 0;
	return options;
}
function reasoningEffortsOf(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const enabled = value.enabled;
	if (typeof enabled !== "object" || enabled === null || Array.isArray(enabled)) return {};
	const rawEfforts = enabled.efforts;
	if (typeof rawEfforts !== "object" || rawEfforts === null || Array.isArray(rawEfforts)) return {};
	const efforts = [];
	let defaultEffort;
	for (const [id, raw] of Object.entries(rawEfforts)) {
		if (!id.trim() || typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
		const entry = raw;
		efforts.push({
			id,
			name: id,
			...typeof entry.description === "string" && entry.description.trim() ? { description: entry.description.trim() } : {}
		});
		if (entry.is_default === true) defaultEffort = id;
	}
	return {
		...efforts.length === 0 ? {} : { efforts: efforts.sort((left, right) => (reasoningEffortOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (reasoningEffortOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)) },
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
function thinkingDefault(value, fallback, onConflict) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
	const config = value;
	const isDefault = (entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.is_default === true;
	const enabled = isDefault(config.enabled);
	const disabled = isDefault(config.disabled);
	if (enabled && disabled) onConflict?.("thinking-defaults");
	return enabled === disabled ? fallback : enabled;
}
function normalizeQoderModels(payload, onConflict) {
	if (typeof payload !== "object" || payload === null || !Array.isArray(payload.assistant)) return [];
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of payload.assistant) {
		if (typeof raw !== "object" || raw === null || raw.enable !== true) continue;
		const id = typeof raw.key === "string" ? raw.key.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const contextOptions = contextOptionsOf(raw.context_config);
		const defaultOptions = Object.values(contextOptions ?? {}).filter((option) => option.isDefault && option.tokenCount !== void 0);
		if (defaultOptions.length > 1) onConflict?.("context-defaults");
		const contextWindow = (defaultOptions.length === 1 ? defaultOptions[0]?.tokenCount : void 0) ?? positiveNumber(raw.max_input_tokens) ?? 18e4;
		const maxContextWindow = Math.max(positiveNumber(raw.max_input_tokens) ?? 0, contextWindow, ...Object.values(contextOptions ?? {}).map((option) => option.tokenCount ?? 0));
		const isReasoning = thinkingDefault(raw.thinking_config, raw.is_reasoning === true, onConflict);
		const priceFactor = typeof raw.price_factor === "number" && Number.isFinite(raw.price_factor) && raw.price_factor >= 0 ? raw.price_factor : void 0;
		const reasoning = reasoningEffortsOf(raw.thinking_config);
		models.push({
			id,
			name: typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name.trim() : id,
			contextWindow,
			maxContextWindow,
			maxTokens: positiveNumber(raw.max_output_tokens) ?? 32768,
			source: typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : "system",
			isReasoning,
			supportsEffort: reasoning.efforts !== void 0,
			supportsImages: raw.is_vl === true,
			...reasoning.efforts === void 0 ? {} : { reasoningEfforts: reasoning.efforts },
			...reasoning.defaultEffort === void 0 ? {} : { defaultReasoningEffort: reasoning.defaultEffort },
			...priceFactor === void 0 ? {} : { priceFactor },
			...contextOptions === void 0 ? {} : { contextOptions }
		});
	}
	return models;
}
//#endregion
//#region src/qoder/transport/catalog-reader.ts
async function fetchQoderModels(credentials, options = {}) {
	const url = getQoderModelListUrl(options.region);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const startedAt = performance.now();
	const deadline = withDeadline(options.signal, options.timeoutMs ?? 15e3);
	options.logger?.debug?.("[Qoder Models] Requesting model catalog", { url });
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: {
				accept: "application/json",
				...buildAuthHeaders(null, url, credentials)
			},
			signal: deadline.signal
		});
		options.logger?.debug?.("[Qoder Models] Catalog request completed", {
			url,
			status: response.status,
			durationMs: Math.round(performance.now() - startedAt),
			...qoderRequestId(response.headers) === void 0 ? {} : { requestId: qoderRequestId(response.headers) }
		});
		const text = await readLimitedText(response, response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes, "Qoder model discovery response");
		if (!response.ok) {
			options.logger?.error?.("[Qoder Models] Catalog request failed", redactLogPayload(text));
			throw qoderHttpError(`Qoder model discovery failed with HTTP status ${response.status}.`, response);
		}
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new QoderLlmError("Qoder model discovery returned invalid JSON.", "MALFORMED_RESPONSE");
		}
		const models = normalizeQoderModels(payload, (conflict) => {
			options.logger?.warn?.("[Qoder Models] Conflicting catalog defaults; using fallback", { conflict });
		});
		if (models.length === 0) throw new QoderLlmError("Qoder model discovery returned no enabled models.", "EMPTY_RESPONSE");
		return models;
	} catch (error) {
		if (error instanceof QoderLlmError) throw error;
		if (options.signal?.aborted) throw new QoderLlmError("Qoder model discovery was aborted.", "ABORTED");
		if (deadline.timeoutSignal.aborted) throw new QoderLlmError("Qoder model discovery timed out.", "TIMEOUT");
		options.logger?.error?.("[Qoder Models] Catalog network request failed", redactLogValue(error));
		throw new QoderLlmError("Qoder model discovery network request failed.", "TRANSPORT", { cause: error });
	}
}
//#endregion
//#region src/qoder/transport/wire/translate.ts
function unsupported(message) {
	return new QoderLlmError(message, "UNSUPPORTED_CONTENT");
}
function toolResultText(block) {
	let text = "";
	for (const nested of block.content) {
		if (nested.type === "image") continue;
		if (nested.type !== "text") throw unsupported(`Qoder tool results support text only; received nested ${String(nested.type)} content.`);
		text += nested.text;
	}
	return text;
}
/**
* Check message shapes without performing any provider I/O.
*
* Callers run this before resolving credentials so an invalid request never
* consumes a Qoder subscription.
*/
function validateMessageShapes(messages) {
	for (const message of messages) {
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		if (toolResults.length > 0) {
			if (message.role !== "user" || toolResults.length !== message.content.length) throw unsupported("Qoder tool-result messages cannot contain sibling content or use a non-user role.");
			for (const result of toolResults) toolResultText(result);
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text") continue;
			if (block.type === "image") {
				if (message.role !== "user") throw unsupported("Qoder image content is valid only in user messages.");
				continue;
			}
			if (block.type === "tool-call") {
				if (message.role !== "assistant") throw unsupported("Qoder tool calls are valid only in assistant messages.");
				continue;
			}
			if (block.type === "reasoning") continue;
			throw unsupported(`Qoder transport encountered unsupported block type: ${String(block.type)}`);
		}
	}
}
/** Reject a batch that exceeds the deployment image policy before any upload work starts. */
function enforceImageLimits(images, attachments) {
	const limits = attachments.imageLimits;
	if (images.length > limits.maxImagesPerMessage) throw unsupported(`Qoder accepts at most ${limits.maxImagesPerMessage} images per message; received ${images.length}.`);
	let total = 0;
	for (const image of images) total += image.attachment.bytes;
	if (total > limits.maxMessageImageBytes) throw unsupported("Qoder message image content exceeds the configured total byte limit.");
}
async function resolveImagePart(block, context) {
	const { attachments, uploader, credentials, signal } = context;
	if (attachments === void 0) throw new QoderLlmError("Qoder image input requires the DSH attachment service.", "ATTACHMENT");
	let image;
	try {
		const limits = attachments.imageLimits;
		image = await attachments.readImageRequest(block.attachment, {
			maxPixels: limits.maxImagePixels,
			maxBytes: limits.maxImageBytes
		}, signal);
	} catch (error) {
		if (signal?.aborted) throw new QoderLlmError("Qoder image preparation was aborted.", "ABORTED", { cause: error });
		if (error instanceof QoderLlmError) throw error;
		throw new QoderLlmError("Qoder could not prepare an image attachment.", "ATTACHMENT", { cause: error });
	}
	if (uploader !== void 0 && credentials !== void 0) return {
		type: "image_url",
		image_url: { url: await uploader.resolveImageUrl(image, credentials, signal) }
	};
	return {
		type: "image_url",
		image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}` }
	};
}
function translateTools(tools) {
	return (tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
}
async function validateAndTranslateMessages(messages, systemPrompt, attachments, signal, pipeline) {
	validateMessageShapes(messages);
	const context = {
		attachments,
		signal,
		uploader: pipeline?.uploader,
		credentials: pipeline?.credentials
	};
	const preserveThinking = pipeline?.preserveThinking ?? true;
	const output = [];
	if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) output.push({
		role: "system",
		content: systemPrompt
	});
	for (const message of messages) {
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		if (toolResults.length > 0) {
			if (message.role !== "user" || toolResults.length !== message.content.length) throw unsupported("Qoder tool-result messages cannot contain sibling content or use a non-user role.");
			for (const result of toolResults) {
				output.push({
					role: "tool",
					tool_call_id: String(result.toolCallId),
					content: toolResultText(result)
				});
				const images = result.content.filter((block) => block.type === "image");
				if (images.length > 0) {
					if (attachments !== void 0) enforceImageLimits(images, attachments);
					output.push({
						role: "user",
						content: [{
							type: "text",
							text: `[${images.length} image${images.length === 1 ? "" : "s"} returned by the previous tool call]`
						}, ...await Promise.all(images.map((image) => resolveImagePart(image, context)))]
					});
				}
			}
			continue;
		}
		let text = "";
		let reasoningText = "";
		const userContent = [];
		const pendingImages = [];
		let hasImage = false;
		const toolCalls = [];
		for (const block of message.content) {
			if (block.type === "text") {
				text += block.text;
				if (message.role === "user") userContent.push({
					type: "text",
					text: block.text
				});
				continue;
			}
			if (block.type === "image") {
				hasImage = true;
				pendingImages.push({
					slot: userContent.length,
					block
				});
				userContent.push(void 0);
				continue;
			}
			if (block.type === "tool-call") {
				toolCalls.push({
					id: String(block.id),
					type: "function",
					function: {
						name: block.name,
						arguments: block.arguments
					}
				});
				continue;
			}
			if (block.type === "reasoning") {
				if (message.role === "assistant") reasoningText += block.text;
				continue;
			}
		}
		if (message.role === "assistant") {
			const hasReasoning = preserveThinking && reasoningText.length > 0;
			if (!text && toolCalls.length === 0 && !hasReasoning) continue;
			output.push({
				role: "assistant",
				content: text || " ",
				...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
				...hasReasoning ? { reasoning_content: reasoningText } : {}
			});
			continue;
		}
		if (pendingImages.length > 0) {
			if (attachments !== void 0) enforceImageLimits(pendingImages.map((pending) => pending.block), attachments);
			await Promise.all(pendingImages.map(async (pending) => {
				userContent[pending.slot] = await resolveImagePart(pending.block, context);
			}));
		}
		output.push({
			role: message.role,
			content: hasImage ? userContent.filter((part) => part !== void 0) : text
		});
	}
	return output;
}
//#endregion
//#region src/qoder/transport/wire/serialize.ts
/** Build the minimum qodercli request envelope for a validated DSH request. */
function stableHash(prefix, ...inputs) {
	const hash = crypto.createHash("sha256");
	hash.update(prefix);
	for (const input of inputs) {
		hash.update("\0");
		hash.update(input);
	}
	return hash.digest("hex").slice(0, 16);
}
function stableChatRecordId(model, messages, tools, maxTokens) {
	const hash = crypto.createHash("sha256");
	hash.update("qoder-record");
	hash.update("\0");
	hash.update(model);
	hash.update("\0");
	hash.update(JSON.stringify(messages));
	hash.update("\0");
	hash.update(JSON.stringify(tools));
	hash.update("\0");
	hash.update(`mt=${maxTokens}`);
	return hash.digest("hex").slice(0, 16);
}
/**
* Reject an unusable request before any credential resolution or provider I/O.
*
* Image publication needs credentials, so message translation now runs after
* authentication. This static pass preserves the guarantee that a request the
* provider cannot serve never reaches the network.
*/
function validateQoderRequestShape(options, model) {
	if (options.reasoningEffort !== void 0) {
		const effort = String(options.reasoningEffort);
		if (!model?.reasoningEfforts?.some((candidate) => candidate.id === effort)) throw new QoderLlmError(`Qoder model "${options.model}" does not advertise reasoning effort "${effort}".`, "UNSUPPORTED_REASONING_EFFORT");
	}
	if (options.messages.some((message) => contentHasImage(message.content)) && model?.supportsImages !== true) throw new QoderLlmError(`Qoder model "${options.model}" does not advertise image input.`, "UNSUPPORTED_CONTENT");
	validateMessageShapes(options.messages);
}
/** Translate a request whose shape has already been validated. */
function translateQoderMessages(options, attachments, pipeline) {
	return validateAndTranslateMessages(options.messages, options.system, attachments, options.signal, pipeline);
}
async function validateQoderRequest(options, model, attachments) {
	validateQoderRequestShape(options, model);
	return validateAndTranslateMessages(options.messages, options.system, attachments, options.signal);
}
async function buildQoderRequestBody(options, userId, translatedMessages, model, attachments) {
	if (!userId) throw new QoderLlmError("Qoder request identity is missing.", "AUTH");
	const modelKey = options.model || "cmodel";
	const messages = translatedMessages ?? await validateQoderRequest(options, model, attachments);
	const modelMaxTokens = model?.maxTokens ?? 32768;
	const maxTokens = Math.min(options.maxTokens ?? modelMaxTokens, modelMaxTokens);
	const isReasoning = options.reasoningEffort !== void 0 || (model?.isReasoning ?? false);
	const tools = translateTools(options.tools);
	const defaultContexts = Object.values(model?.contextOptions ?? {}).filter((option) => option.isDefault === true && typeof option.tokenCount === "number" && Number.isFinite(option.tokenCount) && option.tokenCount > 0);
	const contextConfig = model?.contextOptions === void 0 || defaultContexts.length !== 1 ? void 0 : Object.fromEntries(Object.entries(model.contextOptions).map(([key, value]) => [key, {
		...value.tokenCount === void 0 ? {} : { token_count: value.tokenCount },
		...value.isDefault === void 0 ? {} : { is_default: value.isDefault }
	}]));
	let lastUserText = "";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === void 0) continue;
		if (message.role === "user") {
			const content = message.content;
			lastUserText = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
			break;
		}
	}
	const stablePart = stableHash("qoder-session", userId, modelKey);
	const sessionId = options.sessionId === void 0 ? `${stablePart}-${crypto.randomUUID()}` : `${stablePart}-${String(options.sessionId)}`;
	const recordId = stableChatRecordId(modelKey, messages, tools, maxTokens);
	return {
		request_id: crypto.randomUUID(),
		request_set_id: recordId,
		chat_record_id: recordId,
		session_id: sessionId,
		stream: true,
		chat_task: "FREE_INPUT",
		is_reply: true,
		is_retry: false,
		source: 1,
		version: "3",
		session_type: "qodercli",
		agent_id: "agent_common",
		task_id: "common",
		code_language: "",
		chat_prompt: "",
		image_urls: null,
		aliyun_user_type: "",
		system: "",
		messages,
		tools,
		parameters: {
			max_tokens: maxTokens,
			...options.reasoningEffort === void 0 ? {} : { reasoning_effort: String(options.reasoningEffort) }
		},
		chat_context: {
			chatPrompt: "",
			imageUrls: null,
			extra: {
				context: [],
				modelConfig: {
					key: modelKey,
					is_reasoning: isReasoning
				},
				originalContent: lastUserText
			},
			features: [],
			text: lastUserText
		},
		model_config: {
			key: modelKey,
			is_reasoning: isReasoning,
			max_output_tokens: maxTokens,
			source: model?.source || "system",
			...contextConfig === void 0 ? {} : { context_config: contextConfig }
		},
		business: {
			product: "cli",
			version: "1.0.0",
			type: "agent",
			stage: "start",
			id: crypto.randomUUID(),
			name: lastUserText.substring(0, 30),
			begin_at: Date.now()
		}
	};
}
const mediaTypeExtensions = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif"
};
function aborted$2() {
	return new QoderLlmError("Qoder image upload was aborted.", "ABORTED");
}
/** Encode one image as a single-field multipart payload using the Qoder boundary shape. */
function buildQoderImageMultipart(data, mediaType, boundaryId = crypto.randomUUID()) {
	const boundary = `----qodercli-${boundaryId}`;
	const extension = mediaTypeExtensions[mediaType] ?? "png";
	const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${extension}"\r\nContent-Type: ${mediaType}\r\n\r\n`, "utf8");
	const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
	return {
		body: Buffer.concat([
			header,
			Buffer.from(data),
			footer
		]),
		boundary
	};
}
/**
* Extract the durable object URL from a center upload response.
*
* @param payload - parsed response body.
* @returns the first usable absolute URL, or undefined when none is present.
*/
function readQoderImageUrl(payload) {
	if (payload === null || typeof payload !== "object") return void 0;
	const root = payload;
	const result = root.result;
	const data = root.data;
	const candidates = [
		root.url,
		result?.url,
		result?.oss_url,
		data?.url,
		data?.oss_url
	];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed.length === 0) continue;
		if (!URL.canParse(trimmed)) continue;
		return trimmed;
	}
}
function dataUrl(image) {
	return `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}
/**
* Publishes request images to the Qoder center service and remembers the result.
*
* Publication never fails a model request: any upstream problem degrades to an
* inline data URL so the turn proceeds with the same content it would have
* carried before the pipeline existed.
*/
var QoderImageUploader = class {
	cache = /* @__PURE__ */ new Map();
	flights = new SingleFlight();
	fetchImpl;
	region;
	logger;
	timeoutMs;
	cacheTtlMs;
	cacheCapacity;
	maxConcurrency;
	refreshCredentials;
	now;
	active = 0;
	queue = [];
	constructor(options = {}) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.region = options.region ?? "global";
		this.logger = options.logger;
		this.timeoutMs = options.timeoutMs ?? 3e4;
		this.cacheTtlMs = options.cacheTtlMs ?? 18e5;
		this.cacheCapacity = options.cacheCapacity ?? 512;
		this.maxConcurrency = options.maxConcurrency ?? 4;
		this.refreshCredentials = options.refreshCredentials;
		this.now = options.now ?? Date.now;
	}
	/**
	* Resolve the wire URL for one request image.
	*
	* @param image - request-encoded image produced by the DSH attachment store.
	* @param credentials - credentials authorizing the center exchange.
	* @param signal - optional caller cancellation.
	* @returns a center object URL, or an inline data URL when publication fails.
	* @throws QoderLlmError with code `ABORTED` only when the caller cancels.
	*/
	async resolveImageUrl(image, credentials, signal) {
		if (signal?.aborted) throw aborted$2();
		const key = this.cacheKey(image, credentials);
		const cached = this.cache.get(key);
		if (cached !== void 0) {
			if (cached.expiresAt > this.now()) {
				this.cache.delete(key);
				this.cache.set(key, cached);
				this.logger?.debug?.("[image-upload] cache hit", {
					url: cached.url,
					region: this.region,
					mediaType: image.mediaType,
					bytes: image.data.byteLength
				});
				return cached.url;
			}
			this.cache.delete(key);
		}
		return this.flights.run(key, signal, async (sharedSignal) => {
			const url = await this.publish(image, credentials, sharedSignal);
			if (url !== void 0) {
				this.remember(key, url);
				return url;
			}
			return dataUrl(image);
		}, aborted$2);
	}
	/**
	* Derive the deduplication identity for one request image.
	*
	* `variantId` is the attachment store's deterministic cache and upload index
	* over the attachment, the request policy, and the encoder parameters, so it
	* identifies these exact bytes without rehashing them. Region and subscriber
	* are included because a center object is never shared across either.
	*/
	cacheKey(image, credentials) {
		const hash = crypto.createHash("sha256");
		hash.update(getQoderImageUploadUrl(this.region));
		hash.update("\0");
		hash.update(credentials.userID);
		hash.update("\0");
		hash.update(image.mediaType);
		hash.update("\0");
		const variantId = typeof image.variantId === "string" ? image.variantId : "";
		if (variantId.length > 0) hash.update(variantId);
		else hash.update(crypto.createHash("sha256").update(Buffer.from(image.data)).digest("hex"));
		return hash.digest("hex");
	}
	remember(key, url) {
		this.cache.delete(key);
		this.cache.set(key, {
			url,
			expiresAt: this.now() + this.cacheTtlMs
		});
		while (this.cache.size > this.cacheCapacity) {
			const oldest = this.cache.keys().next();
			if (oldest.done === true) break;
			this.cache.delete(oldest.value);
		}
	}
	async withSlot(signal, operation) {
		if (signal.aborted) throw aborted$2();
		if (this.active >= this.maxConcurrency) {
			this.logger?.debug?.("[image-upload] queued", {
				region: this.region,
				active: this.active,
				queued: this.queue.length + 1
			});
			await new Promise((resolve, reject) => {
				const onAbort = () => {
					const index = this.queue.indexOf(release);
					if (index !== -1) this.queue.splice(index, 1);
					reject(aborted$2());
				};
				const release = () => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				this.queue.push(release);
			});
		} else this.active++;
		try {
			if (signal.aborted) throw aborted$2();
			return await operation();
		} finally {
			const next = this.queue.shift();
			if (next !== void 0) next();
			else this.active--;
		}
	}
	/** Attempt publication, returning undefined when the request must degrade. */
	async publish(image, credentials, signal) {
		return this.withSlot(signal, async () => {
			const first = await this.attempt(image, credentials, signal);
			if (first.url !== void 0) return first.url;
			if (!first.retryable || this.refreshCredentials === void 0) {
				this.warnDegraded(first.reason);
				return;
			}
			let refreshed;
			this.logger?.debug?.("[image-upload] refreshing credentials before retry", {
				region: this.region,
				reason: first.reason
			});
			try {
				refreshed = await this.refreshCredentials(signal);
			} catch (error) {
				if (signal.aborted) throw aborted$2();
				this.warnDegraded("credential refresh failed", error);
				return;
			}
			const second = await this.attempt(image, refreshed, signal);
			if (second.url !== void 0) return second.url;
			this.warnDegraded(second.reason);
		});
	}
	warnDegraded(reason, cause) {
		this.logger?.warn?.("[image-upload] upload failed, keeping base64 image", {
			region: this.region,
			reason
		}, ...cause === void 0 ? [] : [redactLogValue(cause)]);
	}
	async attempt(image, credentials, signal) {
		const requestId = crypto.randomUUID();
		const url = getQoderImageUploadUrl(this.region, requestId);
		const multipart = buildQoderImageMultipart(image.data, image.mediaType);
		const signedBody = Buffer.from(String(multipart.body.length), "utf8");
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const requestSignal = AbortSignal.any([signal, timeout]);
		const startedAt = this.now();
		const details = {
			requestId,
			region: this.region,
			mediaType: image.mediaType,
			bytes: image.data.byteLength,
			timeoutMs: this.timeoutMs
		};
		this.logger?.debug?.("[image-upload] started", details);
		try {
			const response = await this.fetchImpl(url, {
				method: "PUT",
				headers: {
					...buildAuthHeaders(signedBody, url, credentials),
					"AI-CLIENT-TIMESTAMP": String(Math.floor(this.now() / 1e3)),
					"Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
					"Content-Length": String(multipart.body.length),
					"accept": "application/json"
				},
				body: new Uint8Array(multipart.body),
				signal: requestSignal
			});
			this.logger?.debug?.("[image-upload] response received", {
				requestId,
				status: response.status,
				elapsedMs: this.now() - startedAt
			});
			const text = await readLimitedText(response, defaultMaxJsonBytes, "Qoder image upload response");
			if (!response.ok) return {
				retryable: response.status === 401 || response.status === 403,
				reason: `HTTP ${response.status}`
			};
			let payload;
			try {
				payload = JSON.parse(text);
			} catch {
				return {
					retryable: false,
					reason: "invalid JSON response"
				};
			}
			const resolved = readQoderImageUrl(payload);
			if (resolved === void 0) return {
				retryable: false,
				reason: "response carried no image URL"
			};
			this.logger?.debug?.("[image-upload] succeeded", {
				...details,
				status: response.status,
				elapsedMs: this.now() - startedAt,
				url: resolved
			});
			return {
				url: resolved,
				retryable: false,
				reason: ""
			};
		} catch (error) {
			const failureDetails = {
				requestId,
				region: this.region,
				elapsedMs: this.now() - startedAt
			};
			if (signal.aborted) {
				this.logger?.debug?.("[image-upload] aborted", failureDetails);
				throw aborted$2();
			}
			if (timeout.aborted) {
				this.logger?.debug?.("[image-upload] timed out", failureDetails);
				return {
					retryable: false,
					reason: "upload timed out"
				};
			}
			this.logger?.debug?.("[image-upload] network failure", failureDetails, redactLogValue(error));
			return {
				retryable: false,
				reason: "network failure"
			};
		}
	}
};
//#endregion
//#region src/qoder/transport/account-reader.ts
const defaultUsageTtlMs = 6e4;
const defaultUsageTimeoutMs = 15e3;
function normalizeQuota(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const total = typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : typeof raw.cap === "number" && Number.isFinite(raw.cap) ? raw.cap : typeof raw.remaining === "number" && typeof raw.used === "number" ? raw.used + raw.remaining : 0;
	const used = typeof raw.used === "number" && Number.isFinite(raw.used) ? raw.used : 0;
	const remaining = typeof raw.remaining === "number" && Number.isFinite(raw.remaining) ? raw.remaining : Math.max(0, total - used);
	let percentage;
	if (typeof raw.percentage === "number" && Number.isFinite(raw.percentage)) percentage = raw.percentage <= 1 && total > 1 ? raw.percentage * 100 : raw.percentage;
	else percentage = total > 0 ? used / total * 100 : 0;
	const unit = typeof raw.unit === "string" && raw.unit.length > 0 ? raw.unit : "credits";
	return {
		total,
		used,
		remaining,
		percentage,
		unit
	};
}
function normalizeExpiresAt(rawExpires) {
	if (rawExpires === void 0 || rawExpires === null) return void 0;
	if (typeof rawExpires === "number" && rawExpires > 0) return new Date(rawExpires).toISOString();
	if (typeof rawExpires === "string" && rawExpires.length > 0) {
		const parsed = Date.parse(rawExpires);
		if (!Number.isNaN(parsed) && parsed > 0) return new Date(parsed).toISOString();
	}
}
function asString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function asBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function asNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const num = Number(value);
		if (Number.isFinite(num)) return num;
	}
}
function normalizeOrganization(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const obj = raw;
	const orgId = asString(obj.org_id) ?? asString(obj.orgId) ?? asString(obj.id);
	const orgName = asString(obj.org_name) ?? asString(obj.orgName) ?? asString(obj.name);
	if (!orgId || !orgName) return void 0;
	return {
		orgId,
		orgName,
		...asString(obj.role_name) ?? asString(obj.roleName) !== void 0 ? { roleName: asString(obj.role_name) ?? asString(obj.roleName) } : {},
		isSuspended: asBoolean(obj.is_suspended) ?? asBoolean(obj.isSuspended) ?? false,
		canManageSubscriptions: asBoolean(obj.can_manage_subscriptions) ?? asBoolean(obj.canManageSubscriptions) ?? false,
		resourcePackageFeatureEnabled: asBoolean(obj.resource_package_feature_enabled) ?? asBoolean(obj.resourcePackageFeatureEnabled) ?? false
	};
}
function normalizeFeatureAllowed(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const obj = raw;
	return {
		quest: asBoolean(obj.quest) ?? false,
		wiki: asBoolean(obj.wiki) ?? false,
		codeReview: asBoolean(obj.code_review) ?? asBoolean(obj.codeReview) ?? false
	};
}
function normalizePlan(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const obj = raw;
	const userType = asString(obj.user_type) ?? asString(obj.userType);
	const planTierName = asString(obj.plan_tier_name) ?? asString(obj.planTierName) ?? asString(obj.plan_name) ?? asString(obj.planName);
	if (!userType || !planTierName) return void 0;
	const organization = normalizeOrganization(obj.organization);
	const isPersonalVersion = asBoolean(obj.is_personal_version) ?? asBoolean(obj.isPersonalVersion) ?? organization === void 0;
	const startDate = normalizeExpiresAt(obj.start_date ?? obj.startDate);
	const endDate = normalizeExpiresAt(obj.end_date ?? obj.endDate);
	const planTier = asString(obj.plan_tier) ?? asString(obj.planTier);
	const isHighestTier = asBoolean(obj.is_highest_tier) ?? asBoolean(obj.isHighestTier);
	const isRenewed = asBoolean(obj.is_renewed) ?? asBoolean(obj.isRenewed);
	const featureAllowed = normalizeFeatureAllowed(obj.feature_allowed ?? obj.featureAllowed);
	return {
		userType,
		planTierName,
		...planTier !== void 0 ? { planTier } : {},
		isPersonalVersion,
		...isHighestTier !== void 0 ? { isHighestTier } : {},
		...isRenewed !== void 0 ? { isRenewed } : {},
		...startDate !== void 0 ? { startDate } : {},
		...endDate !== void 0 ? { endDate } : {},
		...organization !== void 0 ? { organization } : {},
		...featureAllowed !== void 0 ? { featureAllowed } : {},
		raw
	};
}
function normalizeStatus(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const obj = raw;
	const featureSwitches = obj.featureSwitches ?? obj.feature_switches;
	const teamSwitches = obj.teamSwitches ?? obj.team_switches;
	const allowByok = asNumber(featureSwitches?.allow_byok ?? featureSwitches?.allowByok) ?? 0;
	const teamAllowByok = asNumber(teamSwitches?.allow_byok ?? teamSwitches?.allowByok);
	const isPrivacyPolicyModifiable = asBoolean(obj.isPrivacyPolicyModifiable ?? obj.is_data_policy_modifiable);
	return {
		allowByok,
		...teamAllowByok !== void 0 ? { teamAllowByok } : {},
		...isPrivacyPolicyModifiable !== void 0 ? { isPrivacyPolicyModifiable } : {},
		raw
	};
}
var QoderUsageReader = class {
	authService;
	fetchImpl;
	ttlMs;
	timeoutMs;
	region;
	logger;
	cache = /* @__PURE__ */ new Map();
	flights = new SingleFlight();
	constructor(options) {
		this.authService = options.authService;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.ttlMs = options.ttlMs ?? defaultUsageTtlMs;
		this.timeoutMs = options.timeoutMs ?? defaultUsageTimeoutMs;
		this.region = options.region ?? "global";
		this.logger = options.logger;
	}
	async readAccount(pat, options) {
		if (!pat || typeof pat !== "string") throw new QoderLlmError("Qoder Personal Access Token is missing or invalid.", "MISSING_CREDENTIAL");
		const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`;
		if (!options?.force) {
			const cached = this.cache.get(cacheKey);
			if (cached && cached.expiresAt > Date.now()) return cached.info;
		}
		return this.flights.run(cacheKey, options?.signal, (sharedSignal) => this.loadAccount(pat, sharedSignal, cacheKey), () => new QoderLlmError("Qoder account request was aborted.", "ABORTED"));
	}
	async loadAccount(pat, signal, cacheKey) {
		try {
			return await this.loadAccountWith(pat, signal, cacheKey);
		} catch (error) {
			if (!isQoderAuthRejection(error) || signal.aborted) throw error;
			this.logger?.warn?.("[Qoder Account] Usage read rejected as unauthorized; exchanging a fresh job token and retrying once");
		}
		this.authService.clear(pat);
		return this.loadAccountWith(pat, signal, cacheKey);
	}
	async loadAccountWith(pat, signal, cacheKey) {
		const creds = await this.authService.getCredentials(pat, signal);
		const profile = {
			id: creds.userID,
			name: creds.name || "Qoder User",
			email: creds.email || ""
		};
		const [usage, plan, status] = await Promise.all([
			retryMetadataRead(signal, () => this.fetchUsage(creds.authToken, signal)),
			this.safeFetchPlan(creds.authToken, signal),
			this.safeFetchStatus(creds.authToken, creds.machineID, signal)
		]);
		const accountInfo = {
			profile,
			usage,
			...plan !== void 0 ? { plan } : {},
			...status !== void 0 ? { status } : {},
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		this.cache.set(cacheKey, {
			info: accountInfo,
			expiresAt: Date.now() + this.ttlMs
		});
		return accountInfo;
	}
	clear(pat) {
		if (pat) this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`);
		else this.cache.clear();
	}
	async fetchUsage(jobToken, signal) {
		const data = await openApiJsonRequest(this.fetchImpl, {
			url: getQoderUsageUrl(this.region),
			token: jobToken,
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "Usage",
			logCategory: "account.usage"
		});
		return {
			userQuota: normalizeQuota(data.userQuota),
			addOnQuota: normalizeQuota(data.addOnQuota),
			orgResourcePackage: normalizeQuota(data.orgResourcePackage),
			totalUsagePercentage: typeof data.totalUsagePercentage === "number" ? data.totalUsagePercentage : void 0,
			isQuotaExceeded: typeof data.isQuotaExceeded === "boolean" ? data.isQuotaExceeded : false,
			expiresAt: normalizeExpiresAt(data.expiresAt),
			raw: data
		};
	}
	async fetchPlan(jobToken, signal) {
		return normalizePlan(await openApiJsonRequest(this.fetchImpl, {
			url: getQoderUserPlanUrl(this.region),
			token: jobToken,
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "Plan",
			logCategory: "account.plan"
		}));
	}
	async safeFetchPlan(jobToken, signal) {
		try {
			return await this.fetchPlan(jobToken, signal);
		} catch (error) {
			if (signal.aborted) throw error;
			this.logger?.warn?.("[Qoder Plan] Failed to load user plan (degraded)", error instanceof Error ? error.message : error);
			return;
		}
	}
	async fetchStatus(jobToken, machineId, signal) {
		return normalizeStatus(await openApiJsonRequest(this.fetchImpl, {
			url: getQoderUserStatusUrl(this.region),
			token: jobToken,
			machineId,
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "Status",
			logCategory: "account.status"
		}));
	}
	async safeFetchStatus(jobToken, machineId, signal) {
		try {
			return await this.fetchStatus(jobToken, machineId, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			this.logger?.warn?.("[Qoder Status] Failed to load user status (degraded)", error instanceof Error ? error.message : error);
			return;
		}
	}
};
//#endregion
//#region src/qoder/transport/checkin.ts
const defaultCheckInTimeoutMs = 15e3;
var QoderCheckInService = class {
	authService;
	fetchImpl;
	region;
	variantId;
	logger;
	timeoutMs;
	constructor(options) {
		this.authService = options.authService;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.region = options.region ?? "china";
		this.variantId = options.variantId ?? "qoder";
		this.logger = options.logger;
		this.timeoutMs = options.timeoutMs ?? defaultCheckInTimeoutMs;
	}
	async fetchCampaigns(token, signal) {
		const url = getQoderCampaignsUrl(this.region);
		const { openApiUrl } = resolveQoderEndpoints(this.region);
		const data = await openApiJsonRequest(this.fetchImpl, {
			url,
			token,
			headers: {
				"cosy-clienttype": "10",
				"cosy-version": qoderDesktopVersion,
				"user-agent": qoderDesktopUserAgent,
				origin: openApiUrl
			},
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "Campaigns",
			logCategory: "campaigns.list"
		});
		return Array.isArray(data?.campaigns) ? data.campaigns : [];
	}
	async claimCampaign(token, campaignId, signal) {
		const url = getQoderClaimCampaignUrl(this.region, campaignId);
		const { openApiUrl } = resolveQoderEndpoints(this.region);
		return openApiJsonRequest(this.fetchImpl, {
			url,
			method: "POST",
			token,
			headers: {
				"cosy-clienttype": "10",
				"cosy-version": qoderDesktopVersion,
				"user-agent": qoderDesktopUserAgent,
				origin: openApiUrl
			},
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "ClaimCampaign",
			logCategory: "campaigns.claim"
		});
	}
	getTodayDateString() {
		const now = /* @__PURE__ */ new Date();
		const utc8Time = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 6e4);
		return `${utc8Time.getFullYear()}-${String(utc8Time.getMonth() + 1).padStart(2, "0")}-${String(utc8Time.getDate()).padStart(2, "0")}`;
	}
	async checkIn(pat, signal) {
		const today = this.getTodayDateString();
		const nowMs = Date.now();
		if (!pat || typeof pat !== "string" || pat.trim() === "") return {
			variantId: this.variantId,
			date: today,
			timestamp: nowMs,
			status: "error",
			message: "No PAT available"
		};
		const executeWithToken = async (authToken) => {
			const benefitCampaign = (await this.fetchCampaigns(authToken, signal)).find((c) => c.actionType === "CLAIM_BENEFIT");
			if (!benefitCampaign) return {
				variantId: this.variantId,
				date: today,
				timestamp: nowMs,
				status: "no-campaign",
				message: "No claimable benefit campaign found for this region"
			};
			if (benefitCampaign.claimStatus === "CLAIMED") return {
				variantId: this.variantId,
				date: today,
				timestamp: nowMs,
				status: "already-claimed",
				campaignKey: benefitCampaign.campaignKey,
				amount: benefitCampaign.benefit?.amount ?? 100,
				message: "Already claimed today"
			};
			const claimResult = await this.claimCampaign(authToken, benefitCampaign.campaignId, signal);
			const isClaimed = claimResult.status === "CLAIMED";
			const replayed = Boolean(claimResult.replayed);
			const amount = claimResult.benefit?.amount ?? benefitCampaign.benefit?.amount ?? 100;
			if (isClaimed) return {
				variantId: this.variantId,
				date: today,
				timestamp: nowMs,
				status: replayed ? "already-claimed" : "claimed",
				amount,
				campaignKey: benefitCampaign.campaignKey,
				message: replayed ? "Already claimed today" : `Successfully claimed ${amount} credits`
			};
			return {
				variantId: this.variantId,
				date: today,
				timestamp: nowMs,
				status: "error",
				campaignKey: benefitCampaign.campaignKey,
				message: `Claim returned status ${claimResult.status ?? "unknown"}`
			};
		};
		try {
			const creds = await this.authService.getCredentials(pat, signal);
			try {
				return await executeWithToken(creds.authToken);
			} catch (innerError) {
				if (isQoderAuthRejection(innerError)) {
					this.logger?.warn?.(`[Qoder CheckIn] Auth token rejected, retrying with fresh exchange`);
					return await executeWithToken((await this.authService.exchangeFresh(pat, signal)).authToken);
				}
				throw innerError;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger?.error?.(`[Qoder CheckIn] Check-in failed: ${message}`);
			return {
				variantId: this.variantId,
				date: today,
				timestamp: nowMs,
				status: "error",
				message
			};
		}
	}
};
//#endregion
//#region src/qoder/transport/wire/encoding.ts
/**
* Qoder WAF Body encoding algorithm.
*
* Re-arranges standard Base64 chunks and translates characters against
* a custom alphabet to satisfy Qoder upstream WAF requirements.
*
* The translation runs through a byte table applied to a Buffer instead of a
* per-character string loop. The loop form (`out += char` plus
* `alphabet.indexOf(char)`) costs ~800 ms on a 1 MB body and runs on the main
* thread once per model request, which saturated the Harness event loop as
* soon as a few large-context sessions were in flight. The table form is
* byte-for-byte identical (the input is always Base64, i.e. ASCII) and about
* 24x faster.
*
* @module dsh-provider-qoder/qoder/transport/wire/encoding
*/
const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/**
* Byte translation table: every byte maps to itself unless it is a Base64
* alphabet character (→ the custom alphabet) or the `=` pad (→ `$`).
*/
const encodeTable = (() => {
	const table = /* @__PURE__ */ new Uint8Array(256);
	for (let index = 0; index < 256; index++) table[index] = index;
	for (let index = 0; index < 64; index++) table[qoderStdAlphabet.charCodeAt(index)] = qoderCustomAlphabet.charCodeAt(index);
	table["=".charCodeAt(0)] = "$".charCodeAt(0);
	return table;
})();
function qoderEncodeBody(plaintext) {
	const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
	const n = std.length;
	const a = Math.floor(n / 3);
	const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
	const source = Buffer.from(rearranged, "latin1");
	const target = Buffer.allocUnsafe(n);
	for (let index = 0; index < n; index++) target[index] = encodeTable[source[index] ?? 0] ?? 0;
	return target.toString("latin1");
}
//#endregion
//#region src/qoder/transport/wire/thinking.ts
const thinkingTags = [{
	open: "<thinking>",
	close: "</thinking>"
}, {
	open: "<think>",
	close: "</think>"
}];
const allTags = thinkingTags.flatMap((tag) => [tag.open, tag.close]);
function trailingPrefixLength(text, candidates) {
	let best = 0;
	for (const candidate of candidates) {
		const limit = Math.min(text.length, candidate.length - 1);
		for (let length = limit; length > best; length--) if (text.endsWith(candidate.slice(0, length))) {
			best = length;
			break;
		}
	}
	return best;
}
function earliestTag(text, kind) {
	let found;
	for (const tag of thinkingTags) {
		const position = text.indexOf(tag[kind]);
		if (position !== -1 && (found === void 0 || position < found.position)) found = {
			position,
			tag
		};
	}
	return found;
}
function trimSeparator(text) {
	if (text.startsWith("\n\n")) return text.slice(2);
	if (text.startsWith("\n")) return text.slice(1);
	return text;
}
var NativeReasoningStripper = class {
	buffer = "";
	push(chunk) {
		this.buffer += chunk;
		let output = "";
		while (this.buffer) {
			let firstPosition = -1;
			let firstTag = "";
			for (const tag of allTags) {
				const position = this.buffer.indexOf(tag);
				if (position !== -1 && (firstPosition === -1 || position < firstPosition)) {
					firstPosition = position;
					firstTag = tag;
				}
			}
			if (firstPosition !== -1) {
				output += this.buffer.slice(0, firstPosition);
				this.buffer = this.buffer.slice(firstPosition + firstTag.length);
				continue;
			}
			const held = trailingPrefixLength(this.buffer, allTags);
			output += this.buffer.slice(0, this.buffer.length - held);
			this.buffer = this.buffer.slice(this.buffer.length - held);
			break;
		}
		return output;
	}
	finish() {
		const output = allTags.some((tag) => tag.startsWith(this.buffer)) ? "" : this.buffer;
		this.buffer = "";
		return output;
	}
};
var QoderThinkingParser = class {
	buffer = "";
	mode = "text";
	closingTag = thinkingTags[0].close;
	native = new NativeReasoningStripper();
	pushReasoning(chunk) {
		const text = this.native.push(chunk);
		return text ? [{
			type: "reasoning",
			text
		}] : [];
	}
	pushContent(chunk) {
		const output = [];
		const pendingReasoning = this.native.finish();
		if (pendingReasoning) output.push({
			type: "reasoning",
			text: pendingReasoning
		});
		this.buffer += chunk;
		while (this.buffer) {
			if (this.mode === "reasoning") {
				const closeAt = this.buffer.indexOf(this.closingTag);
				if (closeAt !== -1) {
					if (closeAt > 0) output.push({
						type: "reasoning",
						text: this.buffer.slice(0, closeAt)
					});
					this.buffer = trimSeparator(this.buffer.slice(closeAt + this.closingTag.length));
					this.mode = "text";
					continue;
				}
				const held = trailingPrefixLength(this.buffer, [this.closingTag]);
				const safeLength = this.buffer.length - held;
				if (safeLength > 0) output.push({
					type: "reasoning",
					text: this.buffer.slice(0, safeLength)
				});
				this.buffer = this.buffer.slice(safeLength);
				break;
			}
			const opener = earliestTag(this.buffer, "open");
			const closer = earliestTag(this.buffer, "close");
			if (opener !== void 0 && (closer === void 0 || opener.position < closer.position)) {
				if (opener.position > 0) output.push({
					type: "text",
					text: this.buffer.slice(0, opener.position)
				});
				this.buffer = this.buffer.slice(opener.position + opener.tag.open.length);
				this.closingTag = opener.tag.close;
				this.mode = "reasoning";
				continue;
			}
			if (closer !== void 0) {
				if (closer.position > 0) output.push({
					type: "text",
					text: this.buffer.slice(0, closer.position)
				});
				this.buffer = trimSeparator(this.buffer.slice(closer.position + closer.tag.close.length));
				continue;
			}
			const held = trailingPrefixLength(this.buffer, allTags);
			const safeLength = this.buffer.length - held;
			if (safeLength > 0) output.push({
				type: "text",
				text: this.buffer.slice(0, safeLength)
			});
			this.buffer = this.buffer.slice(safeLength);
			break;
		}
		return output;
	}
	finish() {
		const output = [];
		const pendingReasoning = this.native.finish();
		if (pendingReasoning) output.push({
			type: "reasoning",
			text: pendingReasoning
		});
		if (this.buffer) output.push({
			type: this.mode,
			text: this.buffer
		});
		this.buffer = "";
		return output;
	}
};
//#endregion
//#region src/qoder/transport/wire/sse.ts
/** Decode Qoder's outer SSE envelope and inner model chunks. */
const doneMarker = "[DONE]";
function malformed(message) {
	return new QoderLlmError(message, "MALFORMED_RESPONSE");
}
function parseEnvelope(rawData) {
	let value;
	try {
		value = JSON.parse(rawData);
	} catch {
		throw malformed("Malformed outer SSE JSON payload received from Qoder.");
	}
	if (value === null || typeof value !== "object") throw malformed("Malformed outer SSE envelope received from Qoder.");
	const envelope = value;
	if (envelope.statusCodeValue !== void 0 && typeof envelope.statusCodeValue !== "number") throw malformed("Qoder SSE envelope has an invalid status code.");
	if (envelope.statusCodeValue !== void 0 && (!Number.isInteger(envelope.statusCodeValue) || envelope.statusCodeValue < 100 || envelope.statusCodeValue > 599)) throw malformed("Qoder SSE envelope has an invalid status code.");
	if (envelope.statusCodeValue !== void 0 && envelope.statusCodeValue !== 200) {
		const status = envelope.statusCodeValue;
		throw qoderHttpError(envelope.body ? `Qoder service returned upstream error status ${status}: ${envelope.body}` : `Qoder service returned upstream error status ${status}.`, { status });
	}
	if (envelope.body !== void 0 && typeof envelope.body !== "string") throw malformed("Qoder SSE envelope has an invalid model body.");
	return envelope;
}
function parseInner(body) {
	try {
		const value = JSON.parse(body);
		if (value === null || typeof value !== "object") throw new Error("not an object");
		return value;
	} catch {
		throw malformed("Malformed inner model payload received from Qoder.");
	}
}
function tokenUsage(innerChunk) {
	if (!innerChunk.usage) return void 0;
	const usage = innerChunk.usage;
	const promptTokens = usage.prompt_tokens ?? 0;
	const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
	const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
	const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
		outputTokens: usage.completion_tokens ?? 0,
		...cacheReadTokens > 0 ? { cacheReadTokens } : {},
		...cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
		...reasoningTokens === void 0 ? {} : { reasoningTokens }
	};
}
function finishKind(value) {
	if (value === void 0 || value === null || value === "") return void 0;
	if (value === "stop") return "stop";
	if (value === "length") return "max-tokens";
	if (value === "tool_calls" || value === "toolUse") return "tool-calls";
	if (value === "content_filter") throw new QoderLlmError("Qoder blocked the response through its content filter.", "PROVIDER_ERROR");
	throw malformed(`Qoder returned unknown finish reason "${value}".`);
}
async function* parseQoderSse(stream, options = {}) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const thinkingParser = new QoderThinkingParser();
	const toolCalls = /* @__PURE__ */ new Map();
	let buffer = "";
	let sourceEnded = false;
	let sawDone = false;
	let nextBlockIndex = 0;
	let activeTextual;
	let pendingUsage;
	let terminalKind = "stop";
	let sawContent = false;
	const maxBufferChars = options.maxBufferChars ?? 2097152;
	const closeTextual = () => {
		if (activeTextual === void 0) return [];
		const state = activeTextual;
		activeTextual = void 0;
		return [{
			type: "block-end",
			index: state.index,
			block: state.type === "text" ? {
				type: "text",
				text: state.text
			} : {
				type: "reasoning",
				text: state.text
			}
		}];
	};
	const appendSegment = (segment) => {
		if (!segment.text) return [];
		const chunks = [];
		sawContent = true;
		if (activeTextual?.type !== segment.type) {
			chunks.push(...closeTextual());
			activeTextual = {
				type: segment.type,
				index: nextBlockIndex++,
				text: ""
			};
			chunks.push({
				type: "block-start",
				index: activeTextual.index,
				blockType: segment.type
			});
		}
		activeTextual.text += segment.text;
		chunks.push(segment.type === "text" ? {
			type: "text-delta",
			index: activeTextual.index,
			text: segment.text
		} : {
			type: "reasoning-delta",
			index: activeTextual.index,
			text: segment.text
		});
		return chunks;
	};
	const openToolCall = (state) => {
		if (!state.id || state.blockIndex !== void 0) return [];
		const chunks = closeTextual();
		state.blockIndex = nextBlockIndex++;
		sawContent = true;
		chunks.push({
			type: "block-start",
			index: state.blockIndex,
			blockType: "tool-call"
		});
		const argumentsDelta = state.arguments.slice(state.emittedArguments);
		state.emittedArguments = state.arguments.length;
		chunks.push({
			type: "tool-call-delta",
			index: state.blockIndex,
			id: ToolCallId(state.id),
			...state.name ? { name: state.name } : {},
			argumentsDelta
		});
		return chunks;
	};
	try {
		while (!sourceEnded && !sawDone) {
			const { done, value } = await reader.read();
			if (done) {
				sourceEnded = true;
				buffer += decoder.decode();
				if (buffer.length > 0 && !buffer.endsWith("\n")) buffer += "\n";
			} else {
				options.onActivity?.();
				buffer += decoder.decode(value, { stream: true });
				if (buffer.length > maxBufferChars) throw malformed("Qoder SSE frame exceeded its size limit.");
			}
			while (!sawDone) {
				const lineEnd = buffer.indexOf("\n");
				if (lineEnd === -1) break;
				let line = buffer.substring(0, lineEnd);
				buffer = buffer.substring(lineEnd + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				line = line.trim();
				if (!line.startsWith("data:")) continue;
				const rawData = line.substring(5).trim();
				if (!rawData) continue;
				if (rawData === doneMarker) {
					sawDone = true;
					break;
				}
				const body = parseEnvelope(rawData).body?.trim();
				if (!body) continue;
				if (body === doneMarker) {
					sawDone = true;
					break;
				}
				const innerChunk = parseInner(body);
				pendingUsage = tokenUsage(innerChunk) ?? pendingUsage;
				for (const choice of innerChunk.choices ?? []) {
					terminalKind = finishKind(choice.finish_reason) ?? terminalKind;
					const delta = choice.delta;
					if (!delta) continue;
					if (typeof delta.reasoning_content === "string" && delta.reasoning_content) for (const segment of thinkingParser.pushReasoning(delta.reasoning_content)) for (const chunk of appendSegment(segment)) yield chunk;
					if (typeof delta.content === "string" && delta.content) for (const segment of thinkingParser.pushContent(delta.content)) for (const chunk of appendSegment(segment)) yield chunk;
					if (delta.tool_calls !== void 0) {
						if (!Array.isArray(delta.tool_calls)) throw malformed("Qoder tool-call delta is not an array.");
						for (const rawCall of delta.tool_calls) {
							if (typeof rawCall !== "object" || rawCall === null || Array.isArray(rawCall)) throw malformed("Qoder tool-call delta is not an object.");
							const upstreamIndex = rawCall.index ?? 0;
							if (!Number.isInteger(upstreamIndex) || upstreamIndex < 0) throw malformed("Qoder tool-call delta has an invalid index.");
							let state = toolCalls.get(upstreamIndex);
							if (state === void 0) {
								state = {
									id: "",
									name: "",
									arguments: "",
									emittedArguments: 0
								};
								toolCalls.set(upstreamIndex, state);
							}
							if (rawCall.id !== void 0) {
								if (rawCall.id === "" || rawCall.id === null) {} else if (typeof rawCall.id !== "string") throw malformed("Qoder tool call has an invalid id.");
								else {
									if (state.id && state.id !== rawCall.id) throw malformed("Qoder changed a streamed tool-call id.");
									state.id = rawCall.id;
								}
							}
							let hasNewName = false;
							if (rawCall.function?.name !== void 0) {
								const name = rawCall.function.name;
								if (name === "" || name === null) {} else if (typeof name !== "string") throw malformed("Qoder tool call has an invalid name.");
								else {
									if (state.name && state.name !== name) throw malformed("Qoder changed a streamed tool-call name.");
									if (state.name !== name) {
										state.name = name;
										hasNewName = true;
									}
								}
							}
							if (rawCall.function?.arguments !== void 0) {
								if (typeof rawCall.function.arguments !== "string") throw malformed("Qoder tool-call arguments delta is not a string.");
								state.arguments += rawCall.function.arguments;
							}
							const wasOpen = state.blockIndex !== void 0;
							for (const chunk of openToolCall(state)) yield chunk;
							if (wasOpen && state.blockIndex !== void 0 && state.emittedArguments < state.arguments.length) {
								const argumentsDelta = state.arguments.slice(state.emittedArguments);
								state.emittedArguments = state.arguments.length;
								yield {
									type: "tool-call-delta",
									index: state.blockIndex,
									id: ToolCallId(state.id),
									...state.name ? { name: state.name } : {},
									argumentsDelta
								};
							} else if (wasOpen && state.blockIndex !== void 0 && hasNewName) yield {
								type: "tool-call-delta",
								index: state.blockIndex,
								id: ToolCallId(state.id),
								name: state.name,
								argumentsDelta: ""
							};
						}
					}
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
	if (!sawDone) throw new QoderLlmError("SSE stream ended prematurely without [DONE].", "TRANSPORT");
	for (const segment of thinkingParser.finish()) for (const chunk of appendSegment(segment)) yield chunk;
	for (const chunk of closeTextual()) yield chunk;
	for (const [, state] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
		if (!state.id || !state.name) throw malformed("Qoder completed an unidentifiable tool call.");
		const normalizedArguments = state.arguments.trim() ? state.arguments : "{}";
		try {
			JSON.parse(normalizedArguments);
		} catch {
			throw malformed(`Qoder completed tool call "${state.name}" with malformed JSON arguments.`);
		}
		for (const chunk of openToolCall(state)) yield chunk;
		if (state.blockIndex === void 0) throw malformed("Qoder failed to open a completed tool call.");
		if (state.emittedArguments === 0 && normalizedArguments === "{}") yield {
			type: "tool-call-delta",
			index: state.blockIndex,
			id: ToolCallId(state.id),
			name: state.name,
			argumentsDelta: "{}"
		};
		yield {
			type: "block-end",
			index: state.blockIndex,
			block: {
				type: "tool-call",
				id: ToolCallId(state.id),
				name: state.name,
				arguments: normalizedArguments
			}
		};
	}
	if (pendingUsage) yield {
		type: "usage",
		usage: pendingUsage
	};
	if (!sawContent) {
		yield {
			type: "finish",
			reason: {
				kind: "error",
				failure: {
					message: "Model returned a completed response with no content.",
					code: EMPTY_RESPONSE_CODE
				}
			}
		};
		return;
	}
	yield {
		type: "finish",
		reason: { kind: toolCalls.size > 0 ? "tool-calls" : terminalKind }
	};
}
//#endregion
//#region src/qoder/transport/chat.ts
/** Qoder chat request encoding, timeout lifecycle, and SSE streaming. */
function aborted$1(message) {
	return new QoderLlmError(message, "ABORTED");
}
async function* streamQoderChat(options, model, credentials, messages, dependencies) {
	const request = await buildQoderRequestBody(options, credentials.userID, messages, model);
	const encodedBody = qoderEncodeBody(JSON.stringify(request));
	const encodedBytes = Buffer.from(encodedBody, "utf8");
	const chatUrl = getQoderChatUrl(dependencies.region);
	const requestController = new AbortController();
	let headerTimedOut = false;
	let idleTimedOut = false;
	let idleTimer;
	let chunkCount = 0;
	let reqId;
	const startedAt = performance.now();
	let lastActivityAt = startedAt;
	const onCallerAbort = () => requestController.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onCallerAbort, { once: true });
	const headerTimer = setTimeout(() => {
		headerTimedOut = true;
		requestController.abort("response header timeout");
	}, dependencies.responseHeaderTimeoutMs);
	const resetIdleTimer = () => {
		lastActivityAt = performance.now();
		if (idleTimer !== void 0) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleTimedOut = true;
			requestController.abort("stream idle timeout");
		}, dependencies.streamIdleTimeoutMs);
	};
	try {
		const response = await dependencies.fetch(chatUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"accept": "text/event-stream",
				"cache-control": "no-cache",
				"accept-encoding": "identity",
				"x-model-key": options.model || "cmodel",
				"x-model-source": model?.source || "system",
				...attributionHeaders(),
				...buildAuthHeaders(encodedBytes, chatUrl, credentials)
			},
			body: encodedBytes,
			signal: requestController.signal
		});
		clearTimeout(headerTimer);
		reqId = qoderRequestId(response.headers);
		dependencies.logger?.debug?.("[Qoder Stream] Response headers received", {
			region: dependencies.region,
			status: response.status,
			durationMs: Math.round(performance.now() - startedAt),
			...reqId === void 0 ? {} : { requestId: reqId }
		});
		resetIdleTimer();
		if (!response.ok) throw qoderHttpError(`Qoder upstream service returned HTTP ${response.status}.`, response);
		if (!response.body) throw new QoderLlmError("Qoder response contains no readable body stream.", "EMPTY_RESPONSE");
		let firstChunkDurationMs;
		let tokenUsage;
		let finishReason;
		const streamStartedAt = performance.now();
		for await (const chunk of parseQoderSse(response.body, { onActivity: resetIdleTimer })) {
			chunkCount++;
			if (firstChunkDurationMs === void 0) {
				firstChunkDurationMs = Math.round(performance.now() - startedAt);
				dependencies.logger?.debug?.("[Qoder Stream] First chunk received", {
					durationMs: firstChunkDurationMs,
					...reqId === void 0 ? {} : { requestId: reqId }
				});
			}
			if (chunk.type === "usage") tokenUsage = chunk.usage;
			if (chunk.type === "finish") finishReason = chunk.reason.kind;
			yield chunk;
		}
		dependencies.logger?.debug?.("[Qoder Stream] Stream completed", {
			durationMs: Math.round(performance.now() - startedAt),
			streamDurationMs: Math.round(performance.now() - streamStartedAt),
			chunkCount,
			...finishReason === void 0 ? {} : { finishReason },
			...tokenUsage === void 0 ? {} : { usage: tokenUsage },
			...reqId === void 0 ? {} : { requestId: reqId }
		});
	} catch (error) {
		if (options.signal?.aborted) throw aborted$1("Request was aborted.");
		const elapsedMs = Math.round(performance.now() - startedAt);
		if (headerTimedOut) {
			const failure = new QoderLlmError("Qoder model request exceeded its response header timeout.", "TIMEOUT");
			dependencies.logger?.error?.("[Qoder Stream] Request failed", redactLogValue(failure), {
				phase: "header",
				elapsedMs,
				timeoutMs: dependencies.responseHeaderTimeoutMs
			});
			throw failure;
		}
		if (idleTimedOut) {
			const failure = new QoderLlmError("Qoder model stream exceeded its idle timeout.", "TIMEOUT");
			dependencies.logger?.error?.("[Qoder Stream] Request failed", redactLogValue(failure), {
				phase: "stream-idle",
				chunkCount,
				idleDurationMs: Math.round(performance.now() - lastActivityAt),
				elapsedMs,
				...reqId === void 0 ? {} : { requestId: reqId }
			});
			throw failure;
		}
		if (error instanceof QoderLlmError) {
			dependencies.logger?.error?.("[Qoder Stream] Request failed", redactLogValue(error), {
				chunkCount,
				elapsedMs,
				...reqId === void 0 ? {} : { requestId: reqId }
			});
			throw error;
		}
		const failure = new QoderLlmError("Qoder transport request failed.", "TRANSPORT", { cause: error });
		dependencies.logger?.error?.("[Qoder Stream] Request failed", redactLogValue(failure), {
			chunkCount,
			elapsedMs,
			...reqId === void 0 ? {} : { requestId: reqId },
			cause: redactLogValue(error)
		});
		throw failure;
	} finally {
		clearTimeout(headerTimer);
		if (idleTimer !== void 0) clearTimeout(idleTimer);
		options.signal?.removeEventListener("abort", onCallerAbort);
		requestController.abort("request complete");
	}
}
/**
* How long a rotated-token notice may wait for an accepting chat.
*
* The heal's own retry can lose a race with a transient fault and be rescued
* by a later attempt, so the notice is deferred until some chat is accepted.
* That deferral has to be bounded: an unbounded one let a rotation from
* minutes earlier surface as a fresh-looking row whose timestamp named a
* moment the user could not connect to the row appearing now. Five minutes
* comfortably covers the host's own retry cycle (its backoff caps at 10s)
* while keeping the row adjacent to the event it describes.
*/
const jobTokenNoticeMaxAgeMs = 3e5;
function aborted(message) {
	return new QoderLlmError(message, "ABORTED");
}
var DefaultQoderTransport = class {
	region;
	resolvePat;
	fetchImpl;
	logger;
	streamIdleTimeoutMs;
	responseHeaderTimeoutMs;
	metadataTimeoutMs;
	auth;
	usage;
	checkInService;
	modelFlights = new SingleFlight();
	attachments;
	imageUploader;
	preserveThinking;
	onJobTokenRefreshed;
	onJobTokenRefreshFailed;
	/**
	* Set when the self-heal exchanged a fresh job token, cleared when a chat
	* afterwards succeeds. The notice reports "the token was rotated because the
	* old one was rejected", which is true from that exchange on — so it must
	* not be tied to the heal's OWN retry, which can still lose a race with a
	* transient upstream timeout and be rescued by a later attempt.
	*/
	pendingRefreshAt;
	/**
	* Whether the current unresolved heal failure has already been reported.
	*
	* One upstream rejection can outlive many host-level retries (an observed
	* storm ran 59 of them across 75 steps), and the transport re-heals inside
	* every one of them. Without this latch the failure notice would print once
	* per retry; with it, the user is told once per outage. Cleared as soon as
	* any chat is accepted, so the next outage announces itself again.
	*/
	refreshFailureAnnounced = false;
	constructor(options) {
		this.region = options.region;
		this.resolvePat = options.resolvePat;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.logger = options.logger;
		this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 3e5;
		this.responseHeaderTimeoutMs = options.responseHeaderTimeoutMs ?? 6e4;
		this.metadataTimeoutMs = options.metadataTimeoutMs;
		this.attachments = options.attachments;
		this.preserveThinking = options.preserveThinking;
		this.onJobTokenRefreshed = options.onJobTokenRefreshed;
		this.onJobTokenRefreshFailed = options.onJobTokenRefreshFailed;
		this.auth = new QoderAuthService({
			fetch: this.fetchImpl,
			logger: this.logger,
			region: this.region,
			resolveMachineId: options.resolveMachineId
		});
		this.imageUploader = new QoderImageUploader({
			fetch: this.fetchImpl,
			logger: this.logger,
			region: this.region,
			...options.imageUploadTimeoutMs === void 0 ? {} : { timeoutMs: options.imageUploadTimeoutMs },
			...options.imageUrlCacheTtlMs === void 0 ? {} : { cacheTtlMs: options.imageUrlCacheTtlMs },
			refreshCredentials: async (signal) => {
				const pat = await this.requirePat(signal);
				this.auth.clear(pat);
				return this.auth.getCredentials(pat, signal);
			}
		});
		this.usage = new QoderUsageReader({
			authService: this.auth,
			fetch: this.fetchImpl,
			logger: this.logger,
			region: this.region,
			timeoutMs: this.metadataTimeoutMs
		});
		this.checkInService = new QoderCheckInService({
			authService: this.auth,
			fetch: this.fetchImpl,
			logger: this.logger,
			region: this.region,
			timeoutMs: this.metadataTimeoutMs
		});
	}
	stream(options, model) {
		return this.generate(options, model);
	}
	/**
	* Report the pending self-heal once a chat is accepted, then clear it.
	*
	* The notice means "the stale token was rejected, so it was rotated, and the
	* chat works again" — all three are true by the time a chat is accepted
	* after the refresh, no matter which attempt delivered it.
	*/
	flushPendingRefreshNotice() {
		if (this.pendingRefreshAt === void 0) return;
		const at = this.pendingRefreshAt;
		this.pendingRefreshAt = void 0;
		if (Date.now() - at > jobTokenNoticeMaxAgeMs) return;
		this.logger?.warn?.("[Qoder Stream] Job token was auto-refreshed after an upstream rejection; the chat has recovered");
		this.onJobTokenRefreshed?.({
			region: this.region,
			at
		});
	}
	/**
	* Drop a pending rotation notice whose heal did not rescue anything.
	*
	* The heal's own retry was rejected too, so "the rotation fixed it" is not
	* what happened. Leaving the notice pending made a LATER, unrelated chat
	* acceptance flush it — printing a success row that contradicts the failure
	* row already shown, stamped with the old rotation time.
	*/
	discardPendingRefreshNotice() {
		this.pendingRefreshAt = void 0;
	}
	/**
	* Note that the upstream accepted a chat, ending any unresolved heal failure.
	*
	* `streamChat` calls this the moment its first chunk arrives — the only point
	* at which "the credential was accepted" is actually known. A rejected chat
	* throws before that, so this never fires on a failing attempt.
	*/
	onChatAccepted() {
		this.refreshFailureAnnounced = false;
		this.flushPendingRefreshNotice();
	}
	async discoverModels(signal) {
		const pat = await this.requirePat(signal);
		const key = opaqueCredentialKey(pat);
		return this.modelFlights.run(key, signal, async (sharedSignal) => {
			const credentials = await this.auth.getCredentials(pat, sharedSignal);
			return retryMetadataRead(sharedSignal, () => fetchQoderModels(credentials, {
				fetch: this.fetchImpl,
				signal: sharedSignal,
				logger: this.logger,
				region: this.region,
				timeoutMs: this.metadataTimeoutMs
			}));
		}, () => aborted("Qoder model discovery was aborted."));
	}
	async readAccount(options) {
		const pat = await this.requirePat(options?.signal);
		return this.usage.readAccount(pat, {
			force: options?.force,
			signal: options?.signal
		});
	}
	async checkIn(signal) {
		const pat = await this.requirePat(signal);
		return this.checkInService.checkIn(pat, signal);
	}
	async requirePat(signal) {
		if (signal?.aborted) throw aborted("Qoder request was aborted.");
		const pat = (await this.resolvePat()).trim();
		if (!pat) throw new QoderLlmError("Qoder Personal Access Token is missing. Configure Qoder in the Qoder settings page.", "MISSING_CREDENTIAL");
		if (signal?.aborted) throw aborted("Qoder request was aborted.");
		return pat;
	}
	/**
	* Stream one chat, reporting acceptance as soon as the FIRST chunk arrives.
	*
	* `streamQoderChat` throws before yielding anything when the upstream rejects
	* the request, so a first chunk means the credential was accepted. Reporting
	* at that moment — rather than after the whole stream drains — matters
	* because the consumer may close the stream early, and code after a
	* completed `yield*` would then never run.
	*
	* @param onAccepted - Called once, before the first chunk is forwarded.
	*/
	async *streamChat(options, model, credentials, messages, onAccepted) {
		const stream = streamQoderChat(options, model, credentials, messages, {
			fetch: this.fetchImpl,
			logger: this.logger,
			region: this.region,
			responseHeaderTimeoutMs: this.responseHeaderTimeoutMs,
			streamIdleTimeoutMs: this.streamIdleTimeoutMs
		});
		const first = await stream.next();
		onAccepted();
		if (!first.done) yield first.value;
		yield* stream;
	}
	async *generate(options, model) {
		if (options.signal?.aborted) throw aborted("Request was aborted prior to generation.");
		validateQoderRequestShape(options, model);
		const pat = await this.requirePat(options.signal);
		const credentials = await this.auth.getCredentials(pat, options.signal);
		const messages = await translateQoderMessages(options, this.attachments, {
			uploader: this.imageUploader,
			credentials,
			preserveThinking: this.preserveThinking
		});
		const chatCredentials = await this.auth.getCredentials(pat, options.signal);
		try {
			yield* this.streamChat(options, model, chatCredentials, messages, () => {
				this.onChatAccepted();
			});
			return;
		} catch (error) {
			if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error;
			this.logger?.warn?.("[Qoder Stream] Chat rejected as unauthorized; exchanging a fresh job token and retrying once", { status: error.failure.status });
		}
		let lastRejection;
		for (let round = 0; round < 2; round++) {
			const refreshed = await this.auth.exchangeFresh(pat, options.signal);
			this.pendingRefreshAt = Date.now();
			try {
				yield* this.streamChat(options, model, refreshed, messages, () => {
					this.onChatAccepted();
				});
				return;
			} catch (error) {
				if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error;
				lastRejection = error;
				if (round + 1 < 2) {
					this.logger?.warn?.("[Qoder Stream] Fresh job token also rejected; waiting 2s and retrying once more", {
						status: error.failure.status,
						round: round + 1
					});
					await new Promise((resolve, reject) => {
						const timer = setTimeout(resolve, 2e3);
						options.signal?.addEventListener("abort", () => {
							clearTimeout(timer);
							reject(aborted("Request was aborted during the re-auth backoff."));
						}, { once: true });
					});
				}
			}
		}
		this.discardPendingRefreshNotice();
		if (!this.refreshFailureAnnounced) {
			this.refreshFailureAnnounced = true;
			this.logger?.warn?.("[Qoder Stream] Job token refresh did not recover the chat; the upstream still rejects it", { status: lastRejection instanceof LlmError ? lastRejection.failure.status : void 0 });
			this.onJobTokenRefreshFailed?.({
				region: this.region,
				at: Date.now(),
				...lastRejection instanceof LlmError && lastRejection.failure.status !== void 0 ? { status: lastRejection.failure.status } : {}
			});
		}
		throw lastRejection;
	}
};
//#endregion
//#region src/qoder/transport/index.ts
function createQoderTransport(options) {
	return new DefaultQoderTransport(options);
}
//#endregion
//#region src/upstream.ts
/**
* Qoder upstream client — the loopback shim's OpenAI-shaped surface, carried
* over to the Qoder transport.
*
* The plugin's browser card, the CLI, and DSH's pi-ai adapter all reach Qoder
* through this one module. The wire reality changed underneath the WorkBuddy
* edition it replaces: there is no HTTP endpoint that accepts an OpenAI JSON
* body any more. Instead this module
*
* - **translates** the narrow OpenAI chat-completions request the shim forwards
*   (model, messages, tools, `max_tokens`, `temperature`, `stop`,
*   `reasoning_effort`) into dsh-llm's `GenerateOptions`, and
* - **re-serializes** the transport's `StreamChunk` vocabulary back into
*   `chat.completion.chunk` SSE frames, so the adapter side needs nothing
*   Qoder-specific, and
* - maps catalog discovery (`transport.discoverModels`) into the plugin's
*   model rows, and the account read (`transport.readAccount`) into the
*   card's credit shape.
*
* Failure classification follows the transport's error taxonomy
* (`QoderLlmError.failure.code` plus the HTTP status it carried); the
* WorkBuddy-era session/credit marker lists are gone with the upstream they
* described.
*
* @module dsh-qoder-connect/upstream
*/
/** HTTP status the shim answers each failure kind with. */
const KIND_STATUS = {
	missing_credential: 401,
	auth: 401,
	soft_rate: 429,
	quota_exceeded: 402,
	server: 502,
	client: 400
};
/**
* Normalize a billing rate label for display.
*
* Qoder reports a `priceFactor` number; the host spells it `x<n>` (and the
* WorkBuddy-era saved files sometimes carried a trailing " credits"). The card
* wants one shape: a trimmed multiplier without the suffix.
*/
function normalizeCredits(credits) {
	if (credits === void 0) return void 0;
	const trimmed = credits.trim().replace(/\s+credits?$/iu, "");
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Classify a raw HTTP upstream failure from status and a body excerpt.
*
* Status first, then phrases: a throttling body often also says "quota
* exceeded", and reading that as an exhausted balance parks a healthy account
* until the next billing day instead of retrying shortly.
*/
function classifyUpstreamError(status, body) {
	const lower = body.toLowerCase();
	if (status === 402) return "quota_exceeded";
	if (status === 429) return "soft_rate";
	if (status === 401 || status === 403) return "auth";
	for (const marker of [
		"quota exceeded",
		"insufficient quota",
		"quota_exhausted",
		"exhausted"
	]) if (lower.includes(marker)) return "quota_exceeded";
	for (const marker of [
		"rate limit",
		"too many requests",
		"throttl"
	]) if (lower.includes(marker)) return "soft_rate";
	for (const marker of [
		"invalid token",
		"invalid pat",
		"invalid job token",
		"token expired",
		"token has expired",
		"unauthorized",
		"forbidden",
		"not authenticated"
	]) if (lower.includes(marker)) return "auth";
	if (status === 0 || status >= 500) return "server";
	return "client";
}
/**
* Map one structured transport failure onto the shim's error kind.
*
* The transport's taxonomy (`src/qoder/errors.ts`) codes an HTTP 402 as
* `INVALID_REQUEST`, so the status gets the last say for the quota and auth
* families before the code-based defaults apply.
*/
function kindFromQoderFailure(failure) {
	if (failure.code === "MISSING_CREDENTIAL") return "missing_credential";
	if (failure.code === "AUTH" || failure.status === 401 || failure.status === 403) return "auth";
	if (failure.code === "RATE_LIMIT" || failure.status === 429) return "soft_rate";
	if (failure.code === "QUOTA" || failure.status === 402) return "quota_exceeded";
	if (failure.code.startsWith("INVALID_") || failure.code.startsWith("UNSUPPORTED_") || failure.code === "ATTACHMENT") return "client";
	return "server";
}
/** Whether a Personal Access Token works against one region's endpoints. */
async function validateApiKey(pat, region, options = {}) {
	const trimmed = pat.trim();
	if (trimmed === "") return false;
	try {
		await createQoderTransport({
			region,
			resolvePat: async () => trimmed,
			...options.fetch === void 0 ? {} : { fetch: options.fetch },
			metadataTimeoutMs: options.timeoutMs ?? 15e3
		}).discoverModels(AbortSignal.timeout(options.timeoutMs ?? 15e3));
		return true;
	} catch {
		return false;
	}
}
/** A request the OpenAI layer itself could not accept; the shim answers 400. */
var UpstreamRequestError = class extends Error {};
/** One `data:` frame of a `chat.completion.chunk` SSE body. */
function sseFrame(payload) {
	return `data: ${JSON.stringify(payload)}\n\n`;
}
const SSE_DONE = "data: [DONE]\n\n";
/** The media types the attachment service normalizes; anything else is refused. */
const IMAGE_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
];
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value, what) {
	if (typeof value !== "string" || value.trim() === "") throw new UpstreamRequestError(`${what} must be a non-empty string`);
	return value;
}
/** Decode one `data:image/...;base64,` URL into typed bytes. */
function decodeDataImage(url) {
	const match = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;[a-z0-9;=+.-]*)?,(.*)$/iu.exec(url);
	if (match === null) throw new UpstreamRequestError("image_url data URL is malformed");
	const mediaType = match[1].toLowerCase();
	if (!IMAGE_MEDIA_TYPES.includes(mediaType)) throw new UpstreamRequestError(`image media type "${mediaType}" is not supported (png, jpeg, webp, gif)`);
	let data;
	try {
		data = new Uint8Array(Buffer.from(match[2] ?? "", "base64"));
	} catch {
		throw new UpstreamRequestError("image_url base64 payload could not be decoded");
	}
	if (data.byteLength === 0) throw new UpstreamRequestError("image_url payload is empty");
	return {
		mediaType,
		data
	};
}
/**
* Parse one OpenAI content value (string or parts array) into text.
*
* With `imagesAs`, image parts are offered for commit — and a request that
* carries them without any commit path fails as a client error, because the
* Qoder wire can only ever transport a durable attachment reference.
*/
async function openAiContentBlocks(content, role, imagesAs) {
	const blocks = [];
	const parts = typeof content === "string" || content === null || content === void 0 ? typeof content === "string" && content !== "" ? [{
		type: "text",
		text: content
	}] : [] : Array.isArray(content) ? content : (() => {
		throw new UpstreamRequestError(`${role} message content must be a string or a parts array`);
	})();
	for (const raw of parts) {
		if (!isRecord(raw) || typeof raw["type"] !== "string") throw new UpstreamRequestError(`${role} message content part is malformed`);
		switch (raw["type"]) {
			case "text":
				blocks.push({
					type: "text",
					text: typeof raw["text"] === "string" ? raw["text"] : ""
				});
				break;
			case "image_url": {
				if (role !== "user") throw new UpstreamRequestError("image parts are valid only in user messages");
				const imageUrl = raw["image_url"];
				const url = isRecord(imageUrl) && typeof imageUrl["url"] === "string" ? imageUrl["url"] : "";
				if (!url.toLowerCase().startsWith("data:")) throw new UpstreamRequestError("image_url must be an inline data: URL; remote image URLs are not fetched");
				if (imagesAs === void 0) throw new UpstreamRequestError("image input requires the DSH attachment service");
				const decoded = decodeDataImage(url);
				blocks.push(await imagesAs.commit(decoded));
				break;
			}
			default: throw new UpstreamRequestError(`unsupported content part type "${raw["type"]}"`);
		}
	}
	return blocks;
}
/**
* Translate one OpenAI chat-completions body into a `GenerateOptions` request.
*
* The layer is deliberately narrow: it accepts exactly what pi-ai's
* `openai-completions` API sends, and rejects anything else with an
* attributable 400 rather than silently dropping a caller's intent. System
* prompts ride `options.system` (the transport's own slot), not a leading
* message; tool results become dedicated user-role messages the Qoder
* serializer accepts.
*/
async function toGenerateOptions(bodyJson, context) {
	let parsed;
	try {
		parsed = JSON.parse(bodyJson);
	} catch {
		throw new UpstreamRequestError("request body is not valid JSON");
	}
	if (!isRecord(parsed)) throw new UpstreamRequestError("request body must be a JSON object");
	const model = requiredString(parsed["model"], "model");
	const rawMessages = parsed["messages"];
	if (!Array.isArray(rawMessages) || rawMessages.length === 0) throw new UpstreamRequestError("messages must be a non-empty array");
	const systemParts = [];
	const messages = [];
	for (const raw of rawMessages) {
		if (!isRecord(raw)) throw new UpstreamRequestError("each message must be an object");
		const role = raw["role"];
		switch (role) {
			case "system":
			case "developer":
				if (typeof raw["content"] !== "string") throw new UpstreamRequestError("system message content must be a string");
				if (raw["content"] !== "") systemParts.push(raw["content"]);
				break;
			case "user": {
				const content = await openAiContentBlocks(raw["content"], "user", context.attachments === void 0 ? void 0 : { commit: async (part) => ({
					type: "image",
					attachment: await context.attachments.saveImage({
						data: part.data,
						mediaType: part.mediaType
					})
				}) });
				messages.push(createUserMessage({
					content,
					source: { kind: "user" }
				}));
				break;
			}
			case "assistant": {
				const content = await openAiContentBlocks(raw["content"], "assistant", void 0);
				const rawCalls = raw["tool_calls"];
				if (Array.isArray(rawCalls)) for (const rawCall of rawCalls) {
					if (!isRecord(rawCall)) throw new UpstreamRequestError("each tool call must be an object");
					const fn = isRecord(rawCall["function"]) ? rawCall["function"] : rawCall;
					content.push({
						type: "tool-call",
						id: ToolCallId(requiredString(rawCall["id"], "tool call id")),
						name: requiredString(fn["name"], "tool call function name"),
						arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : ""
					});
				}
				if (content.length === 0) break;
				messages.push(createAssistantMessage({
					content,
					source: {
						provider: context.providerId,
						model
					}
				}));
				break;
			}
			case "tool": {
				const callId = requiredString(raw["tool_call_id"], "tool_call_id");
				const content = raw["content"];
				let text;
				if (typeof content === "string") text = content;
				else if (Array.isArray(content)) {
					text = content.filter((part) => isRecord(part) && part["type"] === "text").map((part) => typeof part["text"] === "string" ? part["text"] : "").join("");
					if (content.some((part) => isRecord(part) && part["type"] !== "text")) throw new UpstreamRequestError("tool result content is limited to text");
				} else throw new UpstreamRequestError("tool message content must be a string or a text-parts array");
				messages.push(createToolResultMessage({
					callId: ToolCallId(callId),
					content: [{
						type: "text",
						text
					}],
					isError: false
				}));
				break;
			}
			default: throw new UpstreamRequestError(`unsupported message role "${String(role)}"`);
		}
	}
	if (messages.length === 0) throw new UpstreamRequestError("the request carries no model-facing message");
	const tools = Array.isArray(parsed["tools"]) ? parsed["tools"].map((raw) => {
		if (!isRecord(raw)) throw new UpstreamRequestError("each tool must be an object");
		const fn = isRecord(raw["function"]) ? raw["function"] : raw;
		if (!isRecord(fn)) throw new UpstreamRequestError("each tool must carry a function object");
		return {
			name: requiredString(fn["name"], "tool name"),
			description: typeof fn["description"] === "string" ? fn["description"] : "",
			parameters: isRecord(fn["parameters"]) ? fn["parameters"] : {}
		};
	}) : void 0;
	const effort = parsed["reasoning_effort"];
	const stop = parsed["stop"];
	const temperature = parsed["temperature"];
	const maxTokens = parsed["max_tokens"];
	return {
		provider: context.providerId,
		model,
		messages,
		...systemParts.length > 0 ? { system: systemParts.join("\n") } : {},
		...tools === void 0 || tools.length === 0 ? {} : { tools },
		...typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {},
		...typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens: Math.floor(maxTokens) } : {},
		...typeof effort === "string" && effort.trim() !== "" ? { reasoningEffort: ReasoningEffortId(effort.trim()) } : {},
		...Array.isArray(stop) ? { stop: stop.filter((entry) => typeof entry === "string") } : typeof stop === "string" ? { stop: [stop] } : {},
		...context.signal === void 0 ? {} : { signal: context.signal }
	};
}
/**
* Re-serialize one `StreamChunk` sequence into OpenAI chunk frames.
*
* One assistant choice, deltas keyed by a per-block tool-call index that
* restarts at zero per block like OpenAI's own, reasoning streamed as
* `delta.reasoning_content` (the compatible extension other gateways use),
* usage as a choices-less frame before the terminal finish, and `data:
* [DONE]` last. A failed or aborted finish mid-stream becomes an error JSON
* frame and then `[DONE]`: the HTTP status is already sent and cannot carry
* the failure.
*/
var ChunkEncoder = class {
	id;
	created;
	model;
	started = false;
	terminal = false;
	toolIndexByBlock = /* @__PURE__ */ new Map();
	announcedTools = /* @__PURE__ */ new Set();
	nextToolIndex = 0;
	constructor(model) {
		this.id = `chatcmpl-${randomBytes(12).toString("hex")}`;
		this.created = Math.floor(Date.now() / 1e3);
		this.model = model;
	}
	frame(extra) {
		return sseFrame({
			id: this.id,
			object: "chat.completion.chunk",
			created: this.created,
			model: this.model,
			...extra
		});
	}
	/** The role frame opens every stream, once. */
	start() {
		if (this.started) return [];
		this.started = true;
		return [this.frame({ choices: [{
			index: 0,
			delta: { role: "assistant" },
			finish_reason: null
		}] })];
	}
	/** Translate one transport chunk into zero or more SSE frames. */
	frames(chunk) {
		switch (chunk.type) {
			case "block-start":
			case "block-end": return [];
			case "text-delta": return [this.frame({ choices: [{
				index: 0,
				delta: { content: chunk.text },
				finish_reason: null
			}] })];
			case "reasoning-delta": return [this.frame({ choices: [{
				index: 0,
				delta: { reasoning_content: chunk.text },
				finish_reason: null
			}] })];
			case "tool-call-delta": {
				let toolIndex = this.toolIndexByBlock.get(chunk.index);
				if (toolIndex === void 0) {
					toolIndex = this.nextToolIndex++;
					this.toolIndexByBlock.set(chunk.index, toolIndex);
				}
				const first = !this.announcedTools.has(chunk.index);
				if (first) this.announcedTools.add(chunk.index);
				const call = {
					index: toolIndex,
					...first ? {
						id: String(chunk.id),
						type: "function",
						function: {
							name: chunk.name ?? "",
							arguments: chunk.argumentsDelta
						}
					} : { function: { arguments: chunk.argumentsDelta } }
				};
				return [this.frame({ choices: [{
					index: 0,
					delta: { tool_calls: [call] },
					finish_reason: null
				}] })];
			}
			case "usage": {
				const cacheRead = chunk.usage.cacheReadTokens;
				const cacheWrite = chunk.usage.cacheWriteTokens;
				const prompt = chunk.usage.inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
				const completion = chunk.usage.outputTokens;
				const reasoning = chunk.usage.reasoningTokens;
				const details = cacheRead === void 0 && cacheWrite === void 0 ? void 0 : {
					...cacheRead === void 0 ? {} : { cached_tokens: cacheRead },
					...cacheWrite === void 0 ? {} : { cache_write_tokens: cacheWrite }
				};
				return [this.frame({
					choices: [],
					usage: {
						prompt_tokens: prompt,
						completion_tokens: completion,
						total_tokens: chunk.usage.totalTokens ?? prompt + completion,
						...details === void 0 ? {} : { prompt_tokens_details: details },
						...reasoning === void 0 ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } }
					}
				})];
			}
			case "finish": {
				this.terminal = true;
				const reason = chunk.reason;
				if (reason.kind === "error" || reason.kind === "aborted") return [sseFrame({ error: {
					message: reason.failure.message,
					type: "server_error",
					code: reason.failure.code
				} }), SSE_DONE];
				const finishReason = reason.kind === "max-tokens" ? "length" : reason.kind === "tool-calls" ? "tool_calls" : "stop";
				return [this.frame({ choices: [{
					index: 0,
					delta: {},
					finish_reason: finishReason
				}] }), SSE_DONE];
			}
		}
	}
	/** Fallback finish when the chunk source ended without a finish chunk. */
	finishFallback() {
		if (this.terminal) return [];
		this.terminal = true;
		return [this.frame({ choices: [{
			index: 0,
			delta: {},
			finish_reason: "stop"
		}] }), SSE_DONE];
	}
	/** A thrown mid-stream failure, phrased as one error frame and the end. */
	abortFrames(message, code) {
		this.terminal = true;
		return [sseFrame({ error: {
			message,
			type: "server_error",
			code
		} }), SSE_DONE];
	}
};
/** Turn any thrown failure into the shim's classified pre-stream result. */
function failureResult(error) {
	if (error instanceof UpstreamRequestError) return {
		ok: false,
		status: 400,
		kind: "client",
		message: error.message
	};
	if (error instanceof LlmError) {
		const kind = kindFromQoderFailure(error.failure);
		return {
			ok: false,
			status: typeof error.failure.status === "number" && error.failure.status >= 100 && error.failure.status <= 599 ? error.failure.status : KIND_STATUS[kind],
			kind,
			message: error.failure.message
		};
	}
	return {
		ok: false,
		status: 502,
		kind: "server",
		message: String(error)
	};
}
var QoderUpstreamClient = class {
	region;
	providerId;
	getPat;
	transport;
	attachments;
	externalCatalog;
	/** The raw discovery rows of the last successful `fetchModels`, by id. */
	discovered = /* @__PURE__ */ new Map();
	/** Provenance of the last successful catalog fetch, for the status card. */
	lastCatalog;
	constructor(options) {
		this.region = options.region;
		this.providerId = options.providerId;
		this.getPat = options.getPat;
		this.transport = options.transport;
		this.attachments = options.attachments;
		this.externalCatalog = options.catalogProvider;
	}
	/** The region this client's transport serves. */
	get clientRegion() {
		return this.region;
	}
	/**
	* The catalog row for one model id: this client's own discovery answers
	* first (it is the same data the upstream catalog call produced), and an
	* externally supplied provider — the plugin's fallback roster, say — fills
	* ids the discovery never listed.
	*/
	catalogModelFor(id) {
		return this.discovered.get(id) ?? this.externalCatalog?.(id);
	}
	/**
	* Discover this variant's models and translate them into plugin rows.
	*
	* The raw rows stay addressable via {@link catalogModelFor}: a chat request
	* for a discovered model must hand the transport its row, because effort
	* support, image capability, and the output cap are all validated against
	* it. The last successful fetch's provenance lands in {@link lastCatalog}
	* for the status card.
	*/
	async fetchModels(signal) {
		const models = await this.transport.discoverModels(signal);
		this.discovered.clear();
		for (const model of models) this.discovered.set(model.id, model);
		this.lastCatalog = {
			fetchedAtMs: Date.now(),
			source: `${this.providerId}:discovery`
		};
		return models.map(modelInfoOf);
	}
	/**
	* The subscriber's quota answer, mapped onto the card's credit shape.
	*
	* Qoder reports one personal quota and an optional organization resource
	* package; each becomes a package row the card already knows how to draw.
	* An unbounded personal allowance (`total === 0`, not exceeded) is the
	* account's "unlimited" state.
	*/
	async fetchCredits(signal) {
		const usage = (await this.transport.readAccount({
			force: true,
			...signal === void 0 ? {} : { signal }
		})).usage ?? {};
		const accounts = [];
		const personal = usage.userQuota;
		if (personal !== void 0) accounts.push({
			packageName: "套餐内 Credits",
			remain: personal.remaining,
			size: personal.total,
			...usage.expiresAt === void 0 ? {} : { packageEndTime: usage.expiresAt }
		});
		const addOn = usage.addOnQuota;
		if (addOn !== void 0) accounts.push({
			packageName: "资源包",
			remain: addOn.remaining,
			size: addOn.total,
			...usage.expiresAt === void 0 ? {} : { packageEndTime: usage.expiresAt }
		});
		const org = usage.orgResourcePackage;
		if (org !== void 0) accounts.push({
			packageName: "组织资源包",
			remain: org.remaining,
			size: org.total,
			...usage.expiresAt === void 0 ? {} : { packageEndTime: usage.expiresAt }
		});
		const unlimited = usage.isQuotaExceeded === false && personal !== void 0 && personal.total === 0 && (addOn === void 0 || addOn.total === 0) && (org === void 0 || org.total === 0);
		return {
			total: usage.totalUsagePercentage ?? personal?.percentage ?? 0,
			totalSize: accounts.reduce((sum, entry) => sum + entry.size, 0),
			accounts,
			...unlimited ? { unlimited: true } : {},
			...usage.expiresAt === void 0 ? {} : { cycleResetTime: usage.expiresAt }
		};
	}
	/**
	* Run daily benefit check-in for this client's variant.
	*/
	async checkIn(signal) {
		return this.transport.checkIn(signal);
	}
	/**
	* Stream one translated chat-completions request.
	*
	* The first transport chunk is pulled before the response is constructed:
	* everything the transport can reject without touching the network — a
	* missing or empty credential, an effort the model does not advertise, an
	* image on a text-only model — must still be able to answer as a real HTTP
	* status, not as a 200 whose first frame is an error. Once streaming has
	* begun, failures degrade to the error-frame-then-`[DONE]` form the
	* {@link ChunkEncoder} documents.
	*/
	async chatStream(bodyJson, signal) {
		let options;
		try {
			options = await toGenerateOptions(bodyJson, {
				providerId: this.providerId,
				attachments: this.attachments,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return failureResult(error);
		}
		try {
			await this.getPat();
		} catch {
			return {
				ok: false,
				status: KIND_STATUS.missing_credential,
				kind: "missing_credential",
				message: "no Qoder Personal Access Token is configured"
			};
		}
		const encoder = new ChunkEncoder(options.model);
		let iterator;
		try {
			iterator = this.transport.stream(options, this.catalogModelFor(options.model))[Symbol.asyncIterator]();
		} catch (error) {
			return failureResult(error);
		}
		try {
			const first = await iterator.next();
			if (!first.done) {
				const earlyFailure = first.value.type === "finish" && (first.value.reason.kind === "error" || first.value.reason.kind === "aborted") ? first.value.reason.failure : void 0;
				if (earlyFailure !== void 0) {
					await iterator.return?.();
					const kind = kindFromQoderFailure(earlyFailure);
					return {
						ok: false,
						status: earlyFailure.status ?? KIND_STATUS[kind],
						kind,
						message: earlyFailure.message
					};
				}
			}
			const stream = this.bodyStream(iterator, first, encoder);
			return {
				ok: true,
				response: new Response(stream, {
					status: 200,
					headers: {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache",
						"Connection": "keep-alive"
					}
				})
			};
		} catch (error) {
			await iterator.return?.();
			return failureResult(error);
		}
	}
	/** Drive the SSE body from an already-started chunk iterator. */
	bodyStream(iterator, first, encoder) {
		const encoderRef = encoder;
		const toBytes = (() => {
			const text = new TextEncoder();
			return (frame) => text.encode(frame);
		})();
		let queue = [];
		let pending = first;
		return new ReadableStream({
			pull: async (controller) => {
				try {
					while (queue.length === 0 && !encoderRef.terminal) {
						if (pending === void 0) pending = await iterator.next();
						const next = pending;
						pending = void 0;
						if (next.done) {
							queue.push(...encoderRef.finishFallback());
							break;
						}
						queue.push(...encoderRef.start(), ...encoderRef.frames(next.value));
					}
				} catch (error) {
					const message = error instanceof LlmError ? error.failure.message : String(error);
					const code = error instanceof LlmError ? error.failure.code : "TRANSPORT";
					queue = encoderRef.abortFrames(message, code);
				}
				if (queue.length > 0) {
					controller.enqueue(toBytes(queue.shift()));
					if (encoderRef.terminal && queue.length === 0) controller.close();
					return;
				}
				controller.close();
			},
			cancel: async () => {
				await iterator.return?.();
			}
		});
	}
	/**
	* One minimal reasoning-effort request, as the probe sweep needs it.
	*
	* The transport validates `reasoningEffort` against the model's advertised
	* efforts **locally** before any network call: a rejection therefore reads
	* as an attributable 400 with code `UNSUPPORTED_REASONING_EFFORT`, and an
	* accepted value costs exactly one streamed request, which this method ends
	* after the first chunk arrives. A probe on this upstream measures the
	* discovery catalog as much as the endpoint behind it — see the module docs
	* in `probe.ts`.
	*/
	async probeEffort(model, effort, signal) {
		try {
			await this.getPat();
		} catch {
			return {
				status: 401,
				streamed: false,
				errorCode: "MISSING_CREDENTIAL",
				detail: "no Personal Access Token configured"
			};
		}
		const options = {
			provider: this.providerId,
			model,
			messages: [createUserMessage({
				content: [{
					type: "text",
					text: PROBE_PROMPT
				}],
				source: { kind: "user" }
			})],
			maxTokens: 1,
			...effort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(effort) },
			signal
		};
		try {
			const iterator = this.transport.stream(options, this.catalogModelFor(model))[Symbol.asyncIterator]();
			try {
				const first = await iterator.next();
				return {
					status: first.done ? 502 : 200,
					streamed: !first.done
				};
			} finally {
				await iterator.return?.();
			}
		} catch (error) {
			if (error instanceof LlmError) return {
				status: error.failure.status ?? defaultStatusForProbe(error.failure.code),
				streamed: false,
				errorCode: error.failure.code,
				detail: error.failure.message.slice(0, 300)
			};
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		}
	}
};
/** Statuses {@link probeEffort} reports for failures the transport raised pre-network. */
function defaultStatusForProbe(code) {
	switch (code) {
		case "UNSUPPORTED_REASONING_EFFORT":
		case "UNSUPPORTED_CONTENT":
		case "INVALID_REQUEST": return 400;
		case "MISSING_CREDENTIAL":
		case "AUTH": return 401;
		case "RATE_LIMIT": return 429;
		case "QUOTA": return 402;
		default: return 502;
	}
}
/**
* Translate one Qoder catalog row into the plugin's model-info shape.
*
* The Qoder vocabulary carries less than the WorkBuddy one did — no badges,
* no promotions, no free/credits strings — so the billing section reports the
* price factor only, spelled `x<n>`, and says so honestly when the upstream
* reported nothing (`rateUnknown`). Context capacity comes from the effective
* window, with the declared options kept for the card and the maximum-window
* preference; a row with no capacity at all takes the transport's own default.
*/
function modelInfoOf(model) {
	const options = Object.values(model.contextOptions ?? {}).map((option) => option.tokenCount).filter((count) => typeof count === "number" && Number.isFinite(count) && count > 0);
	const supportedContextWindows = [...new Set(options)].sort((left, right) => left - right);
	const defaultOptions = Object.values(model.contextOptions ?? {}).filter((option) => option.isDefault === true);
	const contextWindow = model.contextWindow ?? (defaultOptions.length === 1 ? defaultOptions[0]?.tokenCount : void 0) ?? DEFAULT_CONTEXT_WINDOW;
	const reasoning = model.isReasoning === true || model.supportsEffort === true ? {
		supports: true,
		...model.reasoningEfforts === void 0 || model.reasoningEfforts.length === 0 ? {} : { supportedEfforts: model.reasoningEfforts.map((effort) => effort.id) },
		...model.defaultReasoningEffort === void 0 ? {} : { defaultEffort: model.defaultReasoningEffort },
		canDisableThinking: false
	} : void 0;
	const billing = model.priceFactor === void 0 ? {
		free: false,
		rateUnknown: true
	} : model.priceFactor === 0 ? {
		credits: "x0",
		free: true
	} : {
		credits: `x${model.priceFactor}`,
		free: false
	};
	return {
		id: model.id,
		name: model.name === "" ? model.id : model.name,
		contextWindow,
		...defaultOptions.length === 1 && defaultOptions[0]?.tokenCount !== void 0 ? { defaultContextWindow: defaultOptions[0].tokenCount } : {},
		...supportedContextWindows.length > 1 ? { supportedContextWindows } : {},
		maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
		supportsImages: model.supportsImages === true,
		...reasoning === void 0 ? {} : { reasoning },
		billing,
		...model.source === void 0 ? {} : { source: model.source }
	};
}
/** The transport's own output cap for rows that declare none. */
const DEFAULT_MAX_TOKENS = 32768;
/** A conservative input budget for rows that declare none. */
const DEFAULT_CONTEXT_WINDOW = 18e4;
//#endregion
//#region src/version.ts
const QODER_CONNECT_VERSION = "0.1.5";
//#endregion
//#region src/host-heartbeat.ts
/**
* Host-side heartbeat: a small JSON file written into the plugin's data
* directory once the `qoder` providers are registered. The status CLI reads it
* to report whether the host bundle is alive, independent of the browser card.
*
* The browser (client) bundle cannot write files; its health is reported
* only through `console.error` on failure (see `src/client/index.tsx`).
* This asymmetry is intentional: the host is the load-bearing half, and
* a missing heartbeat unambiguously means the host never started.
*
* @module dsh-qoder-connect/host-heartbeat
*/
/** Basename of the host heartbeat file inside the plugin's state directory. */
const QODER_HOST_HEARTBEAT_FILENAME = ".qoder-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1;
/** Absolute path of the host heartbeat file. */
function qoderHostHeartbeatPath() {
	return join(qoderStateDir(), QODER_HOST_HEARTBEAT_FILENAME);
}
/**
* Write (or overwrite) the heartbeat after the host bundle registered the
* provider. A failed write is non-fatal: the host is already running, and
* the status CLI will simply report "heartbeat missing" rather than failing.
*/
async function writeHostHeartbeat() {
	const document = {
		version: HEARTBEAT_FORMAT_VERSION,
		package: "dsh-qoder-connect",
		pluginVersion: QODER_CONNECT_VERSION,
		registeredAt: Date.now(),
		pid: process.pid
	};
	try {
		await mkdir(qoderStateDir(), { recursive: true });
		await writeFile(qoderHostHeartbeatPath(), JSON.stringify(document), "utf8");
	} catch {}
}
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
async function clearHostHeartbeat() {
	try {
		await rm(qoderHostHeartbeatPath(), { force: true });
	} catch {}
}
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
async function readHostHeartbeat() {
	let raw;
	try {
		raw = await readFile(qoderHostHeartbeatPath(), "utf8");
	} catch {
		return;
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed.version === HEARTBEAT_FORMAT_VERSION && parsed.package === "dsh-qoder-connect" && typeof parsed.registeredAt === "number" && typeof parsed.pid === "number") return {
			version: HEARTBEAT_FORMAT_VERSION,
			package: "dsh-qoder-connect",
			pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "unknown",
			registeredAt: parsed.registeredAt,
			pid: parsed.pid
		};
	} catch {}
}
/**
* Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
* when it cannot be determined (no such PID, platform lacks a readable source).
*
* - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
*   `Date.parse` resolves it against the local clock, which matches how
*   `registeredAt` (a `Date.now()` absolute value) is expressed.
* - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
*   `Date.UTC`, again comparable to `registeredAt`.
*
* Failures return `undefined` so callers can fall back to plain PID liveness
* rather than mis-report a running host as dead.
*/
function processStartTimeMs(pid) {
	try {
		if (process.platform === "win32") {
			const m = execFileSync("wmic", [
				"process",
				"where",
				`processid=${pid}`,
				"get",
				"CreationDate"
			], {
				encoding: "utf8",
				windowsHide: true
			}).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/);
			if (m === null) return void 0;
			const [, y, mo, d, h, mi, s] = m;
			const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
			return Number.isFinite(ms) ? ms : void 0;
		}
		const out = execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C",
				LANG: "C"
			}
		}).trim();
		if (out === "") return void 0;
		const ms = Date.parse(out);
		return Number.isFinite(ms) ? ms : void 0;
	} catch {
		return;
	}
}
/**
* Whether the heartbeat's PID is still alive *and* still the same process that
* registered it. A stale heartbeat (host crashed without clearing the file)
* is distinguished from a live host by two checks:
*
* 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
* 2. The process holding that PID started at or before `registeredAt`. A host
*    that registered the heartbeat must have been started before writing it,
*    so `start <= registeredAt`; a recycled PID belongs to an unrelated process
*    started after the host died, so `start > registeredAt` correctly reads dead.
*
* PID-only detection is not enough: after a crash the OS may hand the same PID
* to an unrelated process, and the un-cleared stale heartbeat would otherwise
* produce a false "Host running". When the process start time cannot be read
* (e.g. unsupported platform) the check degrades to plain PID liveness.
*/
function isHeartbeatProcessAlive(heartbeat) {
	try {
		process.kill(heartbeat.pid, 0);
	} catch {
		return false;
	}
	const startAtMs = processStartTimeMs(heartbeat.pid);
	if (startAtMs === void 0) return true;
	return startAtMs <= heartbeat.registeredAt;
}
//#endregion
//#region src/variants.ts
/**
* The two Qoder products this one plugin serves.
*
* Both are the same upstream in different regions, and they differ by route
* (endpoints per `src/qoder/transport/endpoints.ts`), file identity, and display
* identity. Everything that varies between them is collected here as one
* descriptor, so no module has to carry its own `if (international)` branch and
* a third variant would be a data change rather than a refactor.
*
* Each variant holds its own Personal Access Token: a token minted on
* qoder.com does not work against the China deployment and vice versa, and the
* two files, routes, and catalogs never cross.
*
* This module is host-side (it names files and routes). The browser half takes
* the same ids and routes from the Node-free `status-paths.ts`, which stays the
* single source shared by both halves.
*
* @module dsh-qoder-connect/variants
*/
/** China Qoder first: the no-suffix arm keeps the plugin's primary routes. */
const QODER_VARIANTS = [{
	id: "qoder",
	displayName: "Qoder",
	appName: "Qoder",
	region: "china",
	ownFilename: ".qoder-auth.json",
	probeFilename: ".qoder-probe.json",
	catalogFilename: ".qoder-catalog.json",
	statusPath: QODER_STATUS_PATH,
	probePath: QODER_PROBE_PATH,
	authPath: QODER_AUTH_PATH
}, {
	id: "qoder-global",
	displayName: "Qoder Global",
	appName: "Qoder Global",
	region: "global",
	ownFilename: ".qoder-global-auth.json",
	probeFilename: ".qoder-global-probe.json",
	catalogFilename: ".qoder-global-catalog.json",
	statusPath: QODER_GLOBAL_STATUS_PATH,
	probePath: QODER_GLOBAL_PROBE_PATH,
	authPath: QODER_GLOBAL_AUTH_PATH
}];
/** The China variant; the plugin's default and compatibility anchor. */
const CHINA_VARIANT = QODER_VARIANTS[0];
/** The international variant. */
const GLOBAL_VARIANT = QODER_VARIANTS[1];
/** Look up a variant by provider id. */
function variantFor(id) {
	return QODER_VARIANTS.find((variant) => variant.id === id);
}
//#endregion
export { QODER_GLOBAL_AUTH_PATH as A, qoderCredentialIdentity as B, probeModel as C, FALLBACK_QODER_MODELS as D, qoderCatalogPath as E, QODER_AUTH_FILENAME as F, qoderPluginDataDir as G, QODER_DATA_DIR_ENV as H, QODER_PAT_ENV_CN as I, qoderStateDir as K, QODER_PAT_ENV_GLOBAL as L, QODER_GLOBAL_STATUS_PATH as M, QODER_PROBE_PATH as N, QoderCatalog as O, QODER_STATUS_PATH as P, QoderCredentialStore as R, PROBE_EFFORT_CANDIDATES as S, QoderCatalogStore as T, QODER_DATA_DIR_NAME as U, qoderOwnAuthPath as V, qoderMachineIdPath as W, modelInfoOf as _, QODER_HOST_HEARTBEAT_FILENAME as a, createQoderTransport as b, processStartTimeMs as c, writeHostHeartbeat as d, QODER_CONNECT_VERSION as f, kindFromQoderFailure as g, classifyUpstreamError as h, variantFor as i, QODER_GLOBAL_PROBE_PATH as j, QODER_AUTH_PATH as k, qoderHostHeartbeatPath as l, QoderUpstreamClient as m, GLOBAL_VARIANT as n, clearHostHeartbeat as o, KIND_STATUS as p, QODER_VARIANTS as r, isHeartbeatProcessAlive as s, CHINA_VARIANT as t, readHostHeartbeat as u, normalizeCredits as v, randomSentinel as w, getMachineId as x, validateApiKey as y, patTail as z };
