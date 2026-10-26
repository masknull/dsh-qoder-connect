import { fileURLToPath } from "node:url";
import crypto, { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { EMPTY_RESPONSE_CODE, LlmError, ProviderRequestId, ReasoningEffortId, ToolCallId, contentHasImage, createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { requestImageDimensions } from "@deepseek-ai/dsh-attachment";
import { homedir } from "node:os";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
//#region src/paths.ts
/**
* The plugin's data directory — the one place every file the plugin owns lives:
* `<profile>/.dsh-qoder-connect/state/` (PATs, catalogs, probe records,
* heartbeat, machine-id seed), so a profile never collects loose files.
*
* Resolution order: `DSH_QODER_DATA_DIR` → host-reported profile → discovered
* profile → Harness home. The host's report outranks discovery because it is the
* running profile, not an inference.
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
/** Host-reported facts about the running profile; see {@link configurePluginPaths}. */
let hostProfileDir;
let diagnostics;
/**
* Adopt the host's answer for which profile is running, before any path is
* resolved. Overwrites both fields, so a reload without a profile context clears
* the previous answer.
*
* @param host - the host's report.
* @param host.profileDir - `profileContext.dir`, when the host has one.
* @param host.diagnostics - where an ambiguous discovery fallback is reported.
*/
function configurePluginPaths(host) {
	const reported = host.profileDir;
	hostProfileDir = typeof reported === "string" && reported.trim() !== "" ? reported : void 0;
	diagnostics = host.diagnostics;
}
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
* Read from the profile's manifest rather than inferred from this module's path:
* DSH installs a plugin into a profile by *link*, and the real path lies outside
* `$DSH_HOME`, so walking up from the module would miss the profile.
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
* Whether a profile's OWN `node_modules` is a link rather than a directory.
*
* A whole-tree link is the shape of a residual profile, never a real install, so
* it must not claim the running package. An absent `node_modules` is not this
* shape: a profile resolving from the shared `profiles/node_modules` has none.
*/
function profileNodeModulesIsLinked(profileDir) {
	try {
		return lstatSync(join(profileDir, "node_modules")).isSymbolicLink();
	} catch {
		return false;
	}
}
/**
* Whether a profile's installed copy of this plugin resolves to this package,
* so the data directory follows the profile actually running.
*
* A whole-tree link is rejected first (see {@link profileNodeModulesIsLinked}):
* the realpath comparison cannot tell that shape apart from a real install.
*/
function profileLinksToThisPackage(profileDir) {
	const own = pluginPackageRoot();
	if (own === void 0) return false;
	if (profileNodeModulesIsLinked(profileDir)) return false;
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
* A single declaring profile is accepted without the link test (it may resolve
* from the shared `profiles/node_modules`), but a whole-tree link is refused
* either way. With several declaring profiles, only those resolving here are
* eligible; a tie is broken by `readdirSync` order, which is undefined — so ties
* and "nothing eligible" both warn. Warnings name the rejection only: each caller
* owns its own consequence.
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
	if (candidates.length === 1) {
		const only = candidates[0];
		if (profileNodeModulesIsLinked(only)) {
			diagnostics?.warn(`qoder: the only profile declaring this plugin, ${only}, links its entire node_modules elsewhere and so cannot be the running copy.`);
			return;
		}
		return only;
	}
	const eligible = candidates.filter((candidate) => profileLinksToThisPackage(candidate));
	if (eligible.length === 0) {
		diagnostics?.warn(`qoder: ${candidates.length} profiles declare this plugin, none holds the running copy, and the host reported no running profile. Candidates: ${candidates.join(", ")}`);
		return;
	}
	if (eligible.length > 1) diagnostics?.warn(`qoder: ${eligible.length} profiles hold a copy resolving to this package and the host reported no running profile; following ${eligible[0]} on nothing but directory order. Candidates: ${eligible.join(", ")}`);
	return eligible[0];
}
/**
* The plugin's data directory: `<profile>/.dsh-qoder-connect`.
*
* Falls back to profile discovery, then to the Harness home, so the plugin
* always has somewhere to write; `DSH_QODER_DATA_DIR` overrides either way.
*/
function qoderPluginDataDir() {
	const override = process.env[QODER_DATA_DIR_ENV];
	if (override !== void 0 && override.trim() !== "") return override;
	const base = hostProfileDir ?? discoverProfileDir() ?? resolveDshHome();
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
* The transport reads trusted locations and writes its UUID into the last one;
* this keeps the identifier inside the plugin's own folder.
*/
function qoderMachineIdPath() {
	return join(qoderStateDir(), ".qoder-machine-id");
}
//#endregion
//#region src/auth.ts
/**
* Qoder credential storage — a list of Personal Access Tokens per variant, one of
* which is active.
*
* Every credential is a PAT the human pasted into the variant's card (or saved by
* the CLI, or exported into the environment). There is no device flow, no refresh,
* and no expiry: a PAT is valid until revoked, so this store only reads, writes,
* and deletes a small JSON document.
*
* Only the *credential* is per-account. Every setting the cards expose lives in
* the plugin's own settings file and is shared by every saved PAT, so switching
* accounts only changes which token signs the next request.
*
* One file per variant inside the plugin's data directory, with schema
* `{version: 3, activeId, credentials: [{id, pat, region, savedAt, label?}]}`.
* `id` is a one-way hash prefix of the token, so re-pasting a token updates its own
* entry and the id can be shown without leaking the secret. A version-2 document
* is read as a one-entry list and rewritten as v3 on the next mutation; a
* WorkBuddy-era document (`accessToken`, no `pat`) is reported, never migrated.
*
* @module dsh-qoder-connect/auth
*/
/** The on-disk document version this writer produces. */
const AUTH_SCHEMA_VERSION = 3;
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
* Stable local id for one token.
*
* A one-way hash prefix rather than a suffix: surfaces showing the id leak nothing
* usable, while two saves of the same token still resolve to the same entry.
*/
function qoderCredentialId(pat) {
	return createHash("sha256").update(pat).digest("hex").slice(0, 12);
}
/**
* Stable identity key for a credential, used by probe records and saved catalogs.
*
* Wider than the local id: these keys address stored data, not UI, and 16 hex
* characters keep two tokens from sharing a bucket.
*/
function qoderCredentialIdentity(credential) {
	return `pat:${createHash("sha256").update(credential.pat).digest("hex").slice(0, 16)}`;
}
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRegion(value) {
	return value === "global" || value === "china";
}
/** Trim a label and cap it at a length a card row can render. */
function normalizeLabel(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed.slice(0, 48);
}
/** Parse one stored entry, dropping anything this store cannot use. */
function normalizeEntry(value) {
	if (!isRecord$2(value)) return void 0;
	const pat = typeof value["pat"] === "string" ? value["pat"].trim() : "";
	if (pat === "") return void 0;
	const region = value["region"];
	if (!isRegion(region)) return void 0;
	const rawId = typeof value["id"] === "string" ? value["id"].trim() : "";
	const label = normalizeLabel(value["label"]);
	const savedAt = typeof value["savedAt"] === "number" && Number.isFinite(value["savedAt"]) ? value["savedAt"] : void 0;
	return {
		id: rawId === "" ? qoderCredentialId(pat) : rawId,
		pat,
		region,
		...savedAt === void 0 ? {} : { savedAtMs: savedAt },
		...label === void 0 ? {} : { label }
	};
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
	* Resolution order: the active saved entry (or the first when the pointer is
	* stale), then the arm's environment variable (only when no saved entry
	* exists). No refresh and no expiry check.
	*/
	async current() {
		const stored = await this.readOwn();
		if (stored !== void 0 && stored.entries.length > 0) {
			const entry = stored.entries.find((candidate) => candidate.id === stored.activeId) ?? stored.entries[0];
			return {
				id: entry.id,
				pat: entry.pat,
				region: entry.region,
				...entry.savedAtMs === void 0 ? {} : { savedAtMs: entry.savedAtMs },
				...entry.label === void 0 ? {} : { label: entry.label },
				source: "card"
			};
		}
		return this.fromEnvironment();
	}
	/**
	* The credential, or a thrown `MISSING_CREDENTIAL` error.
	*
	* Serving callers use this so an absent token surfaces as the classified failure
	* the transport itself raises.
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
	/** Every saved entry (tokens included; host-side callers only). */
	async entries() {
		return (await this.readOwn())?.entries ?? [];
	}
	/**
	* Add a token and make it active.
	*
	* Re-saving an existing token updates that entry instead of appending a
	* duplicate — the id is derived from the token. The caller must have validated
	* the token against the region first.
	*
	* @param pat - the token to store.
	* @param label - optional display label for the select row.
	* @returns the stored entry.
	*/
	async add(pat, label) {
		const trimmed = pat.trim();
		if (trimmed === "") throw new Error("qoder: cannot save an empty Personal Access Token");
		const entries = (await this.readOwn())?.entries ?? [];
		const id = qoderCredentialId(trimmed);
		const index = entries.findIndex((entry) => entry.id === id);
		const existing = index === -1 ? void 0 : entries[index];
		const nextLabel = normalizeLabel(label) ?? existing?.label;
		const next = {
			id,
			pat: trimmed,
			region: this.variant.region,
			savedAtMs: Date.now(),
			...nextLabel === void 0 ? {} : { label: nextLabel }
		};
		if (index === -1) entries.push(next);
		else entries[index] = next;
		await this.writeDocument(entries, id);
		return next;
	}
	/**
	* Make one saved entry active.
	*
	* @param id - the entry id.
	* @returns the activated entry, or `undefined` when no entry has that id.
	*/
	async activate(id) {
		const stored = await this.readOwn();
		if (stored === void 0) return void 0;
		const entry = stored.entries.find((candidate) => candidate.id === id);
		if (entry === void 0) return void 0;
		await this.writeDocument(stored.entries, id);
		return entry;
	}
	/**
	* Remove one saved entry.
	*
	* The active pointer moves to the first remaining entry; removing the last entry
	* deletes the file, exactly like {@link clear}.
	*
	* @param id - the entry id.
	* @returns the removed entry, or `undefined` when no entry has that id.
	*/
	async remove(id) {
		const stored = await this.readOwn();
		if (stored === void 0) return void 0;
		const index = stored.entries.findIndex((entry) => entry.id === id);
		if (index === -1) return void 0;
		const [removed] = stored.entries.splice(index, 1);
		const activeId = stored.activeId === id ? stored.entries[0]?.id : stored.activeId;
		await this.writeDocument(stored.entries, activeId);
		return removed;
	}
	/**
	* Persist a token for this variant and make it active; {@link add} behind the
	* runtime-credential shape older call sites expect.
	*/
	async save(pat, source = "card") {
		const entry = await this.add(pat);
		return {
			id: entry.id,
			pat: entry.pat,
			region: entry.region,
			...entry.savedAtMs === void 0 ? {} : { savedAtMs: entry.savedAtMs },
			source
		};
	}
	/** Remove every stored credential. A missing file is not an error. */
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
		const stored = await this.readOwn();
		const entries = stored?.entries ?? [];
		if (entries.length > 0) {
			const active = entries.find((entry) => entry.id === stored?.activeId) ?? entries[0];
			const tail = patTail(active.pat);
			const profiles = [...entries].sort(newestFirst$1).map((entry) => {
				const entryTail = patTail(entry.pat);
				return {
					id: entry.id,
					...entry.label === void 0 ? {} : { label: entry.label },
					...entryTail === void 0 ? {} : { patTail: entryTail },
					...entry.savedAtMs === void 0 ? {} : { savedAtMs: entry.savedAtMs }
				};
			});
			return {
				state: "configured",
				...base,
				pat: {
					id: active.id,
					...active.label === void 0 ? {} : { label: active.label },
					source: "card",
					...active.savedAtMs === void 0 ? {} : { savedAtMs: active.savedAtMs },
					...tail === void 0 ? {} : { patTail: tail }
				},
				activeId: active.id,
				profiles
			};
		}
		const credential = await this.fromEnvironment();
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
		} catch {
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
		if (!isRecord$2(parsed)) {
			this.pendingLegacyReason = void 0;
			return;
		}
		if (typeof parsed["accessToken"] === "string" && parsed["pat"] === void 0 && parsed["credentials"] === void 0) {
			this.pendingLegacyReason = "stale WorkBuddy credential file; save a Qoder Personal Access Token instead";
			if (!this.legacyWarned) {
				this.legacyWarned = true;
				this.logger?.warn?.(`qoder: ${this.variant.displayName}: ${this.ownPath} holds a WorkBuddy-era credential; it is ignored. Save a Qoder Personal Access Token to replace it.`);
			}
			return;
		}
		this.pendingLegacyReason = void 0;
		if (Array.isArray(parsed["credentials"])) {
			const byId = /* @__PURE__ */ new Map();
			for (const raw of parsed["credentials"]) {
				const entry = normalizeEntry(raw);
				if (entry !== void 0) byId.set(entry.id, entry);
			}
			const entries = [...byId.values()];
			const requested = typeof parsed["activeId"] === "string" ? parsed["activeId"] : void 0;
			return {
				entries,
				activeId: requested !== void 0 && entries.some((entry) => entry.id === requested) ? requested : entries[0]?.id
			};
		}
		const pat = typeof parsed["pat"] === "string" ? parsed["pat"].trim() : "";
		if (pat === "") return void 0;
		const region = isRegion(parsed["region"]) ? parsed["region"] : this.variant.region;
		const savedAt = typeof parsed["savedAt"] === "number" && Number.isFinite(parsed["savedAt"]) ? parsed["savedAt"] : void 0;
		const entry = {
			id: qoderCredentialId(pat),
			pat,
			region,
			...savedAt === void 0 ? {} : { savedAtMs: savedAt }
		};
		return {
			entries: [entry],
			activeId: entry.id
		};
	}
	async writeDocument(entries, activeId) {
		if (entries.length === 0) {
			await this.clear();
			return;
		}
		const document = {
			version: AUTH_SCHEMA_VERSION,
			activeId: activeId !== void 0 && entries.some((entry) => entry.id === activeId) ? activeId : entries[0].id,
			credentials: entries.map((entry) => ({
				id: entry.id,
				pat: entry.pat,
				region: entry.region,
				savedAt: entry.savedAtMs ?? Date.now(),
				...entry.label === void 0 ? {} : { label: entry.label }
			}))
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
/** Newest first, with a stable tie-break so the select order never jitters. */
function newestFirst$1(a, b) {
	return (b.savedAtMs ?? 0) - (a.savedAtMs ?? 0) || a.id.localeCompare(b.id);
}
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
* Plugin-owned settings endpoint consumed by its browser half.
*
* GET answers the whole entry configuration as three layers (value/base/user) plus
* the write key; POST applies one patch.
*/
const QODER_SETTINGS_FACE_PATH = "/plugins/dsh-qoder-connect/settings";
/**
* Plugin-owned probe control endpoint.
*
* Separate from the status route because it accepts writes: the status route's
* loopback guard protects against a rebinding *page*, which is not the same as
* authorizing an action. This route also requires the in-process key.
*/
const QODER_PROBE_PATH = "/plugins/dsh-qoder-connect/probe";
/**
* Plugin-owned PAT endpoint, one per variant.
*
* A POST here saves (validates and persists) a Personal Access Token, or clears
* the stored one. A write, so it also requires the in-process key.
*/
const QODER_AUTH_PATH = "/plugins/dsh-qoder-connect/auth";
/**
* The international (Qoder Global) variant's own triple of routes.
*
* Separate constants rather than a computed suffix so both halves reference
* literal strings: the bundles are built independently, and a shared expression is
* one build-config drift away from asking a route the host never mounted.
*/
const QODER_GLOBAL_STATUS_PATH = "/plugins/dsh-qoder-connect/global/status";
const QODER_GLOBAL_PROBE_PATH = "/plugins/dsh-qoder-connect/global/probe";
const QODER_GLOBAL_AUTH_PATH = "/plugins/dsh-qoder-connect/global/auth";
//#endregion
//#region src/catalog.ts
/**
* The built-in roster, mirrored from the transport's own `defaultModels`: the
* model keys both regions start from before the first discovery.
*
* It lets the provider register while the first fetch is in flight or the
* endpoint is unreachable; the discovery answer replaces it at startup. Reasoning
* and rate metadata are absent because the defaults declare none.
*/
const FALLBACK_QODER_MODELS = [
	{
		id: "cmodel",
		name: "Cantus (Qoder)",
		contextWindow: 1e6,
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
* Visibility is separate from content: a variant with no usable credential must
* expose no models rather than a fallback roster, since the model picker drops an
* empty group — and serving models that can only fail is worse than nothing.
* The flag defaults to visible; the plugin runtime applies the credential gate.
*/
var QoderCatalog = class {
	models;
	visible = true;
	useMaximumContextWindow = false;
	/** Per-model window overrides (model id → tokens); an override wins over the preference. */
	modelContextWindows = {};
	/** Disabled model IDs (blacklist); disabled models are filtered out from current(). */
	disabledModels = /* @__PURE__ */ new Set();
	constructor(initial = FALLBACK_QODER_MODELS) {
		this.models = initial;
	}
	/** Current entries; empty while the variant has no usable credential, excluding disabled models. */
	current() {
		if (!this.visible) return [];
		return this.all().filter((model) => !this.disabledModels.has(model.id));
	}
	/** All configured entries including disabled ones; empty while the variant has no usable credential. */
	all() {
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
	* Replace the disabled model IDs wholesale. Returns whether the set
	* changed, so the caller can skip an invalidation over an identical write.
	*/
	setDisabledModels(disabledModels) {
		const next = new Set(disabledModels);
		if (next.size === this.disabledModels.size && [...next].every((id) => this.disabledModels.has(id))) return false;
		this.disabledModels = next;
		return true;
	}
	/** Current disabled model IDs. */
	getDisabledModels() {
		return Array.from(this.disabledModels);
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
* Not a cache with a freshness policy: it never prevents a fetch, it only answers
* when a fetch cannot. Never shared across accounts or variants, and never holds a
* token — the account key is a one-way hash of the credential.
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
	return typeof row["id"] === "string" && row["id"] !== "" && typeof row["name"] === "string" && typeof row["contextWindow"] === "number" && Number.isFinite(row["contextWindow"]) && (row["maxTokens"] === void 0 || typeof row["maxTokens"] === "number" && Number.isFinite(row["maxTokens"])) && typeof row["supportsImages"] === "boolean";
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
* Malformed content reads as "nothing saved" rather than throwing: a corrupt file
* must never stop the plugin from serving models.
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
	* A failed write is swallowed: the models have already been served.
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
* The stage order is load-bearing, not an optimization: baseline (no effort) proves
* the request path works; a random sentinel asks the one question a per-level sweep
* cannot — does the upstream validate the field at all; levels are tested only after
* the sentinel was refused. The result is an observation, never a capability claim.
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
* The code a refused effort arrives under, wherever it was refused (the
* transport's serializer for a declared row, `probeEffort` for an endpoint
* refusal).
*
* Only a declared row can be refused locally; an undeclared one sends every
* candidate to the wire so the sentinel measures the endpoint, not the catalog.
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
//#region src/qoder/codes.ts
const table = (family, rows) => rows.map(([code, name]) => ({
	code,
	name,
	family
}));
/**
* The documented code table, from Qoder's "Result error codes" reference
* (https://docs.qoder.com/cli/sdk/errors). Codes are used only to identify a
* family; anything undocumented keeps the routing its HTTP status gives it.
*/
const QODER_RESULT_CODES = Object.freeze([
	...table("auth", [["105", "Login or access token expired"]]),
	...table("quota", [
		["110", "Daily usage limit reached"],
		["113", "Usage quota exhausted"],
		["114", "Free-trial account limit reached"],
		["115", "Free-user quota reached"],
		["116", "Team administrator Credits exhausted"],
		["117", "Team member Credits exhausted"],
		["118", "Personal Credits exhausted"],
		["119", "Free usage limit for the selected model reached"],
		["122", "Billing-group Credits limit reached"]
	]),
	...table("request", [
		["406", "Request blocked because of sensitive content or model refusal"],
		["416", "Requested range or request shape is not satisfiable"],
		["430", "Requested capability is not supported"],
		["47902", "Maximum Agent turns reached"],
		["48716", "A Hook blocked Agent execution"],
		["80411", "Input content is too long"],
		["80412", "Too many images or documents"]
	]),
	...table("runtime", [
		["500", "Request or network failure"],
		["10408", "Request timed out"],
		["10500", "Model service internal error"],
		["10605", "Model request is queued"]
	])
]);
const byCode = new Map(QODER_RESULT_CODES.map((entry) => [entry.code, entry]));
/**
* The documented result code a rejection body names, or `undefined`. Only a
* quoted `code` key counts; mirrored HTTP statuses are not documented codes.
*
* @param body - the upstream error body, or the message that embeds it.
*/
function qoderResultCode(body) {
	if (body === void 0 || body === "") return void 0;
	const text = body.replace(/\\/gu, "");
	for (const match of text.matchAll(/"(?:error_)?code"\s*:\s*"?(\d+)"?/gu)) {
		const entry = byCode.get(match[1]);
		if (entry !== void 0) return entry;
	}
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
/** Queue/limit markers Qoder puts in a rejection body. */
const QUEUE_BODY_MARKERS = [
	/"code"\s*:\s*"?10605"?/u,
	/"isQueued"\s*:\s*true/u,
	/"queueCount"/u,
	/"serviceAvailable"\s*:\s*false/u
];
/**
* Returns the queue signal when a rejection body is Qoder's queue answer rather
* than an authorization failure, otherwise `undefined`.
*/
function qoderQueueSignal(body) {
	if (body === void 0 || body === "") return void 0;
	const text = body.replace(/\\/gu, "");
	if (!QUEUE_BODY_MARKERS.some((marker) => marker.test(text))) return void 0;
	const match = /"retryAfterSeconds"\s*:\s*(\d+)/u.exec(text);
	const queueType = /"queueType"\s*:\s*"([^"]+)"/u.exec(text);
	return {
		...match === null ? {} : { retryAfterMs: Number(match[1]) * 1e3 },
		...queueType === null ? {} : { queueType: queueType[1] }
	};
}
/**
* Replaces status digits with a neutral word so a throttle or quota answer is
* not read as a dead credential (`401`/`403` in text outrank structured codes).
*
* @param message - the message to neutralize.
* @param replacement - the neutral word substituted for the digits.
*/
function deauthorizeDigits(message, replacement = "throttled") {
	return message.replace(/\b(?:401|403)\b/gu, replacement);
}
/** Maps an HTTP response and optional body to a `QoderLlmError`, preferring body signals over status. */
function qoderHttpError(message, response, body) {
	const { status } = response;
	const headerRetryAfterMs = retryAfterMs(response.headers?.get("retry-after") ?? null);
	const requestId = qoderRequestId(response.headers);
	const queue = status === 401 || status === 403 || status === 429 ? qoderQueueSignal(body ?? message) : void 0;
	if (queue !== void 0) {
		const retryAfterMs = queue.retryAfterMs ?? headerRetryAfterMs;
		return new QoderLlmError(deauthorizeDigits(message), "RATE_LIMIT", {
			status,
			...retryAfterMs === void 0 ? {} : { providerRetryAfterMs: retryAfterMs },
			...requestId === void 0 ? {} : { requestId }
		});
	}
	const documented = qoderResultCode(body ?? message);
	if (documented?.family === "quota") return new QoderLlmError(deauthorizeDigits(message, "limited"), "QUOTA", {
		status,
		...requestId === void 0 ? {} : { requestId }
	});
	if (documented?.family === "request" && (status === 401 || status === 403)) return new QoderLlmError(deauthorizeDigits(message, "rejected"), "INVALID_REQUEST", {
		status,
		...requestId === void 0 ? {} : { requestId }
	});
	return new QoderLlmError(message, status === 401 || status === 403 ? "AUTH" : status === 408 ? "TIMEOUT" : status === 429 ? "RATE_LIMIT" : status >= 500 && status <= 599 ? "SERVER" : status >= 400 && status <= 499 ? "INVALID_REQUEST" : "PROVIDER_ERROR", {
		status,
		...headerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs: headerRetryAfterMs },
		...requestId === void 0 ? {} : { requestId }
	});
}
/** Reads a request id from the upstream headers, or `undefined` when absent. */
function qoderRequestId(headers) {
	const normalized = (headers?.get("x-request-id") ?? headers?.get("request-id") ?? headers?.get("x-amzn-requestid"))?.trim();
	return normalized ? ProviderRequestId(normalized) : void 0;
}
/**
* Codes that keep an upstream 401/403 status without being credential
* rejections: the queue answer and a spent usage window, neither fixable by a
* fresh job token, so healing them would waste the exchange and the retry.
*/
const NON_AUTH_STATUS_CODES = [
	"RATE_LIMIT",
	"QUOTA",
	"ACCOUNT_QUOTA"
];
/**
* Whether this failure is an upstream authorization rejection worth one re-auth
* retry. A code in {@link NON_AUTH_STATUS_CODES} is never a candidate, even
* when its status is 401/403.
*/
function isQoderAuthRejection(error) {
	if (!(error instanceof LlmError)) return false;
	if (NON_AUTH_STATUS_CODES.includes(error.code)) return false;
	return error.code === "AUTH" || error.failure.status === 401 || error.failure.status === 403;
}
/** Seconds or an HTTP date to a positive delay in ms; `undefined` when unusable. */
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
/** Pending model-queue entry for one request; not published API, so callers must fall back. */
function getQoderQueueStatusUrl(region = "global", params) {
	const { baseUrl } = resolveQoderEndpoints(region);
	const query = new URLSearchParams({
		requestSetId: params.requestSetId,
		modelKey: params.modelKey
	});
	if (params.queueType !== void 0) query.set("queueType", params.queueType);
	return `${baseUrl}algo/api/v2/service/ask/queue/status?${query.toString()}`;
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
//#region src/qoder/transport/machine-id.ts
/**
* The machine id Qoder's own CLI keeps at `$HOME/.qoder/.auth/machine_id`, read
* only: the transport reuses it and never writes into that tree.
*/
function officialMachineIdPath() {
	return join(homedir(), ".qoder", ".auth", "machine_id");
}
/**
* Read chain when the caller nominates none: the official CLI's id first, this
* plugin's seed last — the only location a new id is ever saved to.
*/
function defaultMachineIdPaths() {
	return [officialMachineIdPath(), qoderMachineIdPath()];
}
/**
* Read Qoder's machine id, or create this plugin's seed at the chain's end.
* `paths` is the read chain; its last entry doubles as the create point, and an
* empty array keeps the id process-local.
*/
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
	if (savePath === void 0) return machineId;
	try {
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
const qoderIdeVersion = "1.1.77";
const qoderUserAgent = `qoder/${qoderIdeVersion}`;
const qoderDataPolicy = "disagree";
const qoderLoginVersion = "v2";
const qoderMachineOs = `${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}_${process.platform}`;
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
function buildAuthHeaders(body, requestURL, creds, correlation) {
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
		"X-Request-Id": correlation?.requestId ?? crypto.randomUUID(),
		...correlation?.sessionId === void 0 ? {} : { "X-Session-Id": correlation.sessionId }
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
	const chunks = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new QoderLlmError(`${label} exceeded its response size limit.`, "MALFORMED_RESPONSE");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
	let payload = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
	const encoding = (response.headers.get("content-encoding") ?? "").toLowerCase();
	const looksGzipped = payload.length >= 2 && payload[0] === 31 && payload[1] === 139;
	if (encoding !== "" || looksGzipped) {
		try {
			if (encoding.includes("gzip") || encoding === "" && looksGzipped) payload = gunzipSync(payload, { maxOutputLength: maxBytes });
			else if (encoding.includes("br")) payload = brotliDecompressSync(payload, { maxOutputLength: maxBytes });
			else if (encoding.includes("deflate")) payload = inflateSync(payload, { maxOutputLength: maxBytes });
		} catch {
			throw new QoderLlmError(`${label} arrived compressed but could not be decompressed.`, "MALFORMED_RESPONSE");
		}
		if (payload.byteLength > maxBytes) throw new QoderLlmError(`${label} exceeded its response size limit.`, "MALFORMED_RESPONSE");
	}
	return new TextDecoder().decode(payload);
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
			"accept-encoding": "identity",
			"user-agent": options.userAgent ?? qoderUserAgent,
			"cosy-clienttype": "5",
			...Object.fromEntries(Object.entries(options.headers ?? {}).filter(([name]) => {
				const lower = name.toLowerCase();
				return lower !== "cosy-version" && lower !== "user-agent";
			})),
			"Cosy-Version": qoderIdeVersion
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
			throw qoderHttpError(`Failed to execute Qoder ${options.operation} with status ${response.status}.`, response, text);
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
	/** Self-heal exchanges, kept apart from `inFlight` so a departing waiter cannot abort them. */
	healFlights = /* @__PURE__ */ new Map();
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
	* Exchange a fresh job token outside the single-flight, for the self-heal
	* retry; overlapping heals for one credential share a single exchange, which
	* runs on its own timeout signal. The result replaces the cache entry.
	*/
	async exchangeFresh(pat, signal) {
		const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`;
		const existing = this.healFlights.get(cacheKey);
		if (existing !== void 0 && !existing.settled) return waitForFlight(existing.promise, signal);
		this.clear(pat);
		const created = { settled: false };
		created.promise = this.exchangeAndResolve(pat, AbortSignal.timeout(this.timeoutMs)).finally(() => {
			created.settled = true;
			if (this.healFlights.get(cacheKey) === created) this.healFlights.delete(cacheKey);
		});
		this.healFlights.set(cacheKey, created);
		return waitForFlight(created.promise, signal);
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
		const declaredMaxTokens = positiveNumber(raw.max_output_tokens);
		models.push({
			id,
			name: typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name.trim() : id,
			contextWindow,
			maxContextWindow,
			...declaredMaxTokens === void 0 ? {} : { maxTokens: declaredMaxTokens },
			...declaredMaxTokens === void 0 ? {} : { maxTokensDeclared: true },
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
				"accept-encoding": "identity",
				"user-agent": qoderUserAgent,
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
/** Flatten one tool-result message's content to wire text, skipping images. */
function toolResultText(content) {
	let text = "";
	for (const nested of content) {
		if (nested.type === "image") continue;
		if (nested.type !== "text") throw unsupported(`Qoder tool results support text only; received nested ${String(nested.type)} content.`);
		text += nested.text;
	}
	return text;
}
/**
* Check message shapes without performing any provider I/O, so an invalid
* request never consumes a Qoder subscription. Only `role` and `content` are read.
*/
function validateMessageShapes(messages) {
	for (const message of messages) {
		if (message.role === "tool") {
			for (const block of message.content) {
				if (block.type === "text" || block.type === "image") continue;
				throw unsupported(`Qoder tool results support text and image content only; received ${String(block.type)}.`);
			}
			continue;
		}
		if (message.role === "developer") throw unsupported("Qoder transport does not support developer messages (dynamic tool addition/removal).");
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
		const { width: sourceWidth, height: sourceHeight } = block.attachment;
		const projected = requestImageDimensions(sourceWidth, sourceHeight, attachments.imageLimits.maxImagePixels);
		image = await attachments.readImageRequest(block.attachment, {
			width: projected.width,
			height: projected.height,
			maxBytes: attachments.imageLimits.maxImageBytes
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
		if (message.role === "tool") {
			output.push({
				role: "tool",
				tool_call_id: String(message.toolCallId),
				content: toolResultText(message.content)
			});
			const images = message.content.filter((block) => block.type === "image");
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
			throw unsupported(`Qoder transport encountered unsupported block type: ${String(block.type)}`);
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
		if (message.role === "developer") continue;
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
/**
* Reject an unusable request before any credential resolution or provider I/O,
* so a request the provider cannot serve never reaches the network.
*/
function validateQoderRequestShape(options, model) {
	if (options.reasoningEffort !== void 0) {
		const effort = String(options.reasoningEffort);
		const declared = model?.reasoningEfforts;
		if (declared !== void 0 && declared.length > 0 && !declared.some((candidate) => candidate.id === effort)) throw new QoderLlmError(`Qoder model "${options.model}" does not advertise reasoning effort "${effort}".`, "UNSUPPORTED_REASONING_EFFORT");
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
async function buildQoderRequestBody(options, userId, translatedMessages, model, attachments, region) {
	if (!userId) throw new QoderLlmError("Qoder request identity is missing.", "AUTH");
	const modelKey = options.model || "cmodel";
	const messages = translatedMessages ?? await validateQoderRequest(options, model, attachments);
	const declaredMaxTokens = model?.maxTokensDeclared === true ? model.maxTokens : void 0;
	const maxTokens = declaredMaxTokens === void 0 ? options.maxTokens : Math.min(options.maxTokens ?? declaredMaxTokens, declaredMaxTokens);
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
	const requestId = crypto.randomUUID();
	const requestSetId = crypto.randomUUID();
	return {
		request_id: requestId,
		request_set_id: requestSetId,
		chat_record_id: requestId,
		session_id: sessionId,
		stream: true,
		chat_task: "FREE_INPUT",
		is_reply: true,
		is_retry: false,
		source: 1,
		version: "3",
		session_type: region === "china" ? "qoderclicn" : "qodercli",
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
			...maxTokens === void 0 ? {} : { max_tokens: maxTokens },
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
			...maxTokens === void 0 ? {} : { max_output_tokens: maxTokens },
			source: model?.source || "system",
			...contextConfig === void 0 ? {} : { context_config: contextConfig }
		},
		business: {
			product: "cli",
			version: "1.0.0",
			type: "agent",
			stage: "start",
			id: requestSetId,
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
/** Extract the first absolute object URL from a center upload response, or `undefined`. */
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
* Publishes request images to the Qoder center service. Publication never fails
* a model request: problems degrade to an inline data URL.
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
	* Resolve the wire URL for one request image: a center object URL, or an inline
	* data URL when publication fails.
	*
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
	* Deduplication identity for one image: `variantId` covers the exact bytes, and
	* region plus subscriber are included because objects are never shared across them.
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
					"user-agent": qoderUserAgent,
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
	if (typeof rawExpires === "number" && rawExpires > 0) return toExpiryIso(rawExpires);
	if (typeof rawExpires === "string" && rawExpires.length > 0) {
		const parsed = Date.parse(rawExpires);
		if (!Number.isNaN(parsed) && parsed > 0) return toExpiryIso(parsed);
	}
}
/**
* The year at which Qoder stops naming a date and means "never": the year-9999
* sentinel is a valid timestamp, so it must be read as no expiry at all.
*/
const NEVER_EXPIRY_YEAR = 9999;
/** ISO instant for a parsed expiry, or undefined for the "never" sentinel. */
function toExpiryIso(atMs) {
	return new Date(atMs).getUTCFullYear() >= NEVER_EXPIRY_YEAR ? void 0 : new Date(atMs).toISOString();
}
/** Localized `displayLabels` values, keyed by bare language (`zh` / `en`). */
function labelI18n(raw) {
	const out = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [key, value] of Object.entries(raw)) {
		const text = asString(value);
		if (text === void 0) continue;
		const language = key.slice(0, 2).toLowerCase();
		if (language === "zh") out.zh = text;
		else if (language === "en") out.en = text;
	}
	return out;
}
/**
* One campaign grant. `name` is an opaque code; the human copy lives in
* `displayLabels` under `dimension: 'title'`, which labels the row.
*/
function normalizeDedicatedPackage(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const quota = normalizeQuota(raw);
	if (quota === void 0) return void 0;
	const title = (Array.isArray(raw.displayLabels) ? raw.displayLabels : []).find((label) => label?.dimension === "title");
	const id = asString(raw.id);
	const name = asString(raw.name);
	const status = asString(raw.status);
	const expiresAt = normalizeExpiresAt(raw.expiresAt);
	return {
		...quota,
		...id === void 0 ? {} : { id },
		...name === void 0 ? {} : { name },
		...title === void 0 ? {} : (() => {
			const parsed = labelI18n(title.valueI18n);
			const fallback = asString(title.value);
			if (parsed.zh === void 0 && parsed.en === void 0 && fallback === void 0) return {};
			return { title: {
				...parsed.zh !== void 0 ? { zh: parsed.zh } : fallback !== void 0 ? { zh: fallback } : {},
				...parsed.en !== void 0 ? { en: parsed.en } : fallback !== void 0 ? { en: fallback } : {}
			} };
		})(),
		...expiresAt === void 0 ? {} : { expiresAt },
		...typeof raw.available === "boolean" ? { available: raw.available } : {},
		...status === void 0 ? {} : { status }
	};
}
function normalizeDedicatedPackages(raw) {
	if (!Array.isArray(raw)) return void 0;
	const packages = raw.map((entry) => normalizeDedicatedPackage(entry)).filter((entry) => entry !== void 0);
	return packages.length > 0 ? packages : void 0;
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
			orgResourcePackage: normalizeQuota(data.orgResourcePackage),
			addOnQuota: normalizeQuota(data.addOnQuota),
			...(() => {
				const packages = normalizeDedicatedPackages(data.dedicatedResourcePackages);
				return packages === void 0 ? {} : { dedicatedResourcePackages: packages };
			})(),
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
/**
* The UTC+8 wall clock of an instant, as a Date whose *local* fields hold it.
* Read it with the local getters (`getHours`, `getFullYear`, …), not the UTC ones.
*/
function utc8WallClock(atMs) {
	const d = new Date(atMs);
	return new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 6e4);
}
/**
* Format an epoch-ms instant as its UTC+8 calendar date, `YYYY-MM-DD`.
*/
function formatUtc8Date(atMs) {
	const utc8 = utc8WallClock(atMs);
	return `${utc8.getFullYear()}-${String(utc8.getMonth() + 1).padStart(2, "0")}-${String(utc8.getDate()).padStart(2, "0")}`;
}
//#endregion
//#region src/qoder/transport/checkin.ts
/** Qoder campaign inquiry and daily benefit check-in service. */
const defaultCheckInTimeoutMs = 15e3;
/**
* The longest span still recognised as one daily benefit window; a longer
* campaign is not a daily window and falls back to the calendar day.
*/
const DAILY_WINDOW_MAX_MS = 864e5;
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
		const data = await openApiJsonRequest(this.fetchImpl, {
			url,
			token,
			headers: { "cosy-clienttype": "10" },
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
				origin: openApiUrl,
				"cosy-clienttype": "10"
			},
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "ClaimCampaign",
			logCategory: "campaigns.claim"
		});
	}
	/**
	* Attribute the served campaign to a day, or say why it cannot be today's.
	* The daily window runs 10:00 UTC+8 to 09:59 the next morning, so a calendar
	* date matches the window's date for only part of the day.
	*/
	classifyCampaignWindow(campaign, nowMs, today) {
		const startAt = campaign.startAt;
		if (typeof startAt !== "number" || !Number.isFinite(startAt) || startAt <= 0) return { kind: "unknown" };
		const endAt = campaign.endAt;
		if (typeof endAt === "number" && Number.isFinite(endAt)) {
			const spanMs = (endAt - startAt) * 1e3;
			if (spanMs <= 0 || spanMs > DAILY_WINDOW_MAX_MS) return { kind: "unknown" };
		}
		const startMs = startAt * 1e3;
		if (startMs > nowMs) return { kind: "not-open" };
		const date = formatUtc8Date(startMs);
		return date === today ? {
			kind: "open",
			date
		} : {
			kind: "earlier",
			date
		};
	}
	async checkIn(pat, signal) {
		const nowMs = Date.now();
		const today = formatUtc8Date(nowMs);
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
			const campaignWindow = this.classifyCampaignWindow(benefitCampaign, nowMs, today);
			if (campaignWindow.kind === "not-open" || campaignWindow.kind === "earlier") return {
				variantId: this.variantId,
				date: today,
				timestamp: nowMs,
				status: "before-window",
				campaignKey: benefitCampaign.campaignKey,
				message: campaignWindow.kind === "not-open" ? "Today's benefit window has not opened yet" : `Upstream is still serving the benefit window of ${campaignWindow.date}`
			};
			const windowDate = campaignWindow.kind === "open" ? campaignWindow.date : today;
			if (benefitCampaign.claimStatus === "CLAIMED") return {
				variantId: this.variantId,
				date: windowDate,
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
				date: windowDate,
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
* Qoder WAF body encoding: rearranges standard Base64 chunks and translates
* characters through a custom alphabet. A byte table replaces the slower
* per-character loop; the output is byte-for-byte identical.
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
/**
* Describe a completed call's arguments for the diagnostic log, never for control flow.
*
* The official client does not judge argument text at the transport layer: it concatenates
* the deltas, tries `JSON.parse` once at block end, and on failure hands the caller an empty
* input plus the raw string. The tool layer then answers `Error: Invalid parameters provided`
* as a tool result, so the model re-emits the call and the turn survives. Every "damaged
* shape" this file used to classify was a case of the transport deciding to die where the
* client upstream of it would not, so the judgment is gone; what remains is a log line.
*/
function argumentsIssue(text) {
	if (!text.trim()) return void 0;
	try {
		JSON.parse(text);
		return;
	} catch {
		return `${text.length} chars, not valid JSON`;
	}
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
		throw qoderHttpError(envelope.body ? `Qoder service returned upstream error status ${status}: ${envelope.body}` : `Qoder service returned upstream error status ${status}.`, { status }, envelope.body);
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
/**
* The finish reasons the official client treats as a filtered reply.
*
* `qodercli` classifies `content_filter`, `refusal` and `sensitive` as a refusal stop
* reason (`Ffo` in its bundle). The harness has no refusal kind, so the caller reports a
* normal stop plus a visible notice; what it must NOT do is let a filtered response carry
* executable tool calls, which is why {@link parseQoderSse} withholds them.
*/
const filteredFinishReasons = /* @__PURE__ */ new Set([
	"content_filter",
	"refusal",
	"sensitive"
]);
/**
* Map one upstream finish reason onto the harness vocabulary.
*
* A filtered reply becomes `stop`: the official client would call it `refusal`, which the
* harness cannot express, and the caller adds a visible notice instead. An unrecognised
* reason fails the stream as non-retryable, exactly as the official chat client does
* (`UnsupportedFinishReasonError`, `retryable = false`); guessing a normal stop there would
* hide a vocabulary drift as a complete answer.
*/
function finishKind(value, onDiag) {
	if (value === void 0 || value === null || value === "") return void 0;
	if (value === "stop") return "stop";
	if (value === "length") return "max-tokens";
	if (value === "tool_calls" || value === "toolUse" || value === "function_call") return "tool-calls";
	if (filteredFinishReasons.has(value)) {
		onDiag?.(`upstream filtered the response (${value}); reporting a normal stop`);
		return "stop";
	}
	throw new QoderLlmError(`Qoder returned unsupported finish reason "${value}".`, "UNSUPPORTED_FINISH_REASON");
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
	let filteredReason;
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
					if (typeof choice.finish_reason === "string" && filteredFinishReasons.has(choice.finish_reason) && filteredReason === void 0) {
						filteredReason = choice.finish_reason;
						options.onNotice?.({
							kind: "filtered",
							reason: choice.finish_reason
						});
					}
					terminalKind = finishKind(choice.finish_reason, options.onDiag) ?? terminalKind;
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
							if (rawCall.function?.name !== void 0) {
								const name = rawCall.function.name;
								if (name === "" || name === null) {} else if (typeof name !== "string") throw malformed("Qoder tool call has an invalid name.");
								else {
									if (state.name && state.name !== name) throw malformed("Qoder changed a streamed tool-call name.");
									state.name = name;
								}
							}
							if (rawCall.function?.arguments !== void 0) {
								if (typeof rawCall.function.arguments !== "string") throw malformed("Qoder tool-call arguments delta is not a string.");
								state.arguments += rawCall.function.arguments;
							}
						}
					}
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
	if (!sawDone) throw new QoderLlmError("Qoder SSE stream ended without [DONE].", "TRANSPORT");
	for (const segment of thinkingParser.finish()) for (const chunk of appendSegment(segment)) yield chunk;
	for (const chunk of closeTextual()) yield chunk;
	const truncated = terminalKind === "max-tokens";
	let emittedCalls = 0;
	if (filteredReason !== void 0 && toolCalls.size > 0) options.onDiag?.(`withheld ${toolCalls.size} tool call(s): the reply was filtered (${filteredReason})`);
	for (const [, state] of filteredReason === void 0 ? [...toolCalls.entries()].sort(([left], [right]) => left - right) : []) {
		const normalizedArguments = state.arguments.trim() ? state.arguments : "{}";
		if (!state.id || !state.name) {
			if (truncated) continue;
			throw malformed("Qoder completed an unidentifiable tool call.");
		}
		const issue = argumentsIssue(normalizedArguments);
		if (issue !== void 0) options.onDiag?.(`tool call "${state.name}" carried unparsable arguments (${issue})`);
		for (const chunk of openToolCall(state)) yield chunk;
		if (state.blockIndex === void 0) throw malformed("Qoder failed to open a completed tool call.");
		if (state.emittedArguments === 0 && normalizedArguments === "{}") yield {
			type: "tool-call-delta",
			index: state.blockIndex,
			id: ToolCallId(state.id),
			name: state.name,
			argumentsDelta: "{}"
		};
		emittedCalls += 1;
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
	if (!sawContent && !truncated) {
		yield {
			type: "finish",
			reason: {
				kind: "error",
				failure: {
					message: filteredReason === void 0 ? "Model returned a completed response with no content." : `Qoder filtered the reply (${filteredReason}) before returning any content.`,
					code: EMPTY_RESPONSE_CODE
				}
			}
		};
		return;
	}
	yield {
		type: "finish",
		reason: { kind: emittedCalls > 0 ? "tool-calls" : terminalKind }
	};
}
//#endregion
//#region src/qoder/transport/chat.ts
/** 90% of the host's stream-idle window: a longer silence would be killed anyway. */
function queueBudgetMs(dependencies) {
	return Math.max(3e4, Math.floor(dependencies.streamIdleTimeoutMs * .9));
}
/** Floor for a poll interval: `retryAfterSeconds` can be 0/1 and polling must not spin. */
const queuePollMinIntervalMs = 2e3;
/** Ceiling for one poll interval, so a stale countdown cannot outlive the budget. */
const queuePollMaxIntervalMs = 3e4;
/** Consecutive unusable poll answers before the queue wait gives up. */
const maxPollFailures = 3;
/** Consecutive "empty queue, no capacity" answers before giving up. */
const maxNoCapacityPolls = 3;
function aborted$1(message) {
	return new QoderLlmError(message, "ABORTED");
}
/** Sleep that rejects with the abort reason instead of hanging. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(aborted$1("Request was aborted during a queue wait."));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(aborted$1("Request was aborted during a queue wait."));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/** Read the pending queue entry; `undefined` means the endpoint is unusable. */
async function readQueueStatus(dependencies, credentials, requestSetId, modelKey, queueType, requestId, sessionId, signal) {
	const url = getQoderQueueStatusUrl(dependencies.region, {
		requestSetId,
		modelKey,
		queueType
	});
	try {
		const response = await dependencies.fetch(url, {
			method: "GET",
			headers: {
				accept: "application/json",
				"accept-encoding": "identity",
				"user-agent": qoderUserAgent,
				...buildAuthHeaders(null, url, credentials, {
					requestId,
					...sessionId === void 0 ? {} : { sessionId }
				})
			},
			signal
		});
		if (!response.ok) {
			dependencies.onDiag?.(`poll http=${response.status}`);
			return;
		}
		const body = await readLimitedText(response, defaultMaxErrorBytes, "Qoder queue status");
		const parsed = JSON.parse(body);
		if (parsed === null || typeof parsed !== "object") return void 0;
		const record = parsed;
		return {
			isQueued: record["isQueued"] === true,
			...typeof record["serviceAvailable"] === "boolean" ? { serviceAvailable: record["serviceAvailable"] } : {},
			...typeof record["queueCount"] === "number" ? { queueCount: record["queueCount"] } : {},
			...typeof record["waitTime"] === "number" ? { waitTimeMs: record["waitTime"] * 1e3 } : {},
			...typeof record["retryAfterSeconds"] === "number" ? { retryAfterMs: record["retryAfterSeconds"] * 1e3 } : {}
		};
	} catch (error) {
		dependencies.onDiag?.(`poll threw: ${String(error?.message ?? error).slice(0, 120)}`);
		return;
	}
}
/** Poll until the entry clears, the budget runs out, or the endpoint stops answering. */
async function waitForQueue(dependencies, credentials, requestSetId, modelKey, requestId, sessionId, queue, deadline, signal, touch, attemptStart = 0, maxAttempts) {
	const diag = (message) => dependencies.onDiag?.(message);
	const floor = dependencies.queuePollFloorMs ?? queuePollMinIntervalMs;
	const ceiling = dependencies.queuePollCeilingMs ?? queuePollMaxIntervalMs;
	let retryAfterMs = queue.retryAfterMs ?? queuePollMinIntervalMs;
	let attempt = attemptStart;
	let waitedMs = 0;
	let failures = 0;
	let noCapacity = 0;
	for (;;) {
		attempt += 1;
		touch();
		const status = await readQueueStatus(dependencies, credentials, requestSetId, modelKey, queue.queueType, requestId, sessionId, signal);
		if (status === void 0) {
			failures += 1;
			diag(`poll ${attempt}: unusable answer (${failures}/${maxPollFailures})`);
			if (failures >= maxPollFailures) return {
				ready: false,
				attempts: attempt
			};
			const retry = Math.min(floor * failures, ceiling);
			const remaining = deadline - Date.now();
			if (remaining <= 0) return {
				ready: false,
				attempts: attempt
			};
			waitedMs = Math.min(retry, remaining);
			touch();
			await sleep(waitedMs, signal);
			continue;
		}
		failures = 0;
		diag(`poll ${attempt}: set=${requestSetId} req=${requestId} isQueued=${status.isQueued} serviceAvailable=${status.serviceAvailable ?? "-"} queueCount=${status.queueCount ?? "-"} waitTimeMs=${status.waitTimeMs ?? "-"} retryAfterMs=${status.retryAfterMs ?? "-"}`);
		const cleared = !status.isQueued;
		if (!cleared && status.serviceAvailable === false && (status.queueCount ?? 0) === 0) {
			noCapacity += 1;
			diag(`poll ${attempt}: no capacity (${noCapacity}/${maxNoCapacityPolls})`);
			if (noCapacity >= maxNoCapacityPolls) return {
				ready: false,
				attempts: attempt
			};
		} else noCapacity = 0;
		retryAfterMs = status.retryAfterMs ?? retryAfterMs;
		const remaining = deadline - Date.now();
		if (cleared) {
			const settle = Math.min(Math.max(retryAfterMs, floor), ceiling, Math.max(remaining, 0));
			dependencies.onQueueWait?.({
				attempt: attempt - 1,
				waitMs: settle,
				cleared: true,
				...sessionId === void 0 ? {} : { sessionId }
			});
			diag(`poll ${attempt}: clear; settling ${settle}ms before replay`);
			touch();
			if (settle > 0) await sleep(settle, signal);
			return {
				ready: true,
				attempts: attempt - 1
			};
		}
		const nextWait = Math.min(Math.max(retryAfterMs, floor), ceiling, Math.max(remaining, 0));
		dependencies.onQueueWait?.({
			attempt,
			waitMs: nextWait,
			...maxAttempts === void 0 ? {} : { maxAttempts },
			...status.queueCount === void 0 ? {} : { queueCount: status.queueCount },
			...status.waitTimeMs === void 0 ? {} : { waitTimeMs: status.waitTimeMs },
			...sessionId === void 0 ? {} : { sessionId }
		});
		if (remaining <= 0) {
			diag(`poll ${attempt}: budget exhausted`);
			return {
				ready: false,
				attempts: attempt
			};
		}
		waitedMs = nextWait;
		touch();
		await sleep(waitedMs, signal);
	}
}
/** Ride out a busy queue for either 10605 entry point; `ready` false means the caller must fail. */
async function rideQueue(error, bodyHint, dependencies, credentials, requestSetId, modelKey, requestId, sessionId, deadline, signal, touch, attemptStart, maxAttempts) {
	const queue = qoderQueueSignal(bodyHint) ?? (error instanceof QoderLlmError ? qoderQueueSignal(error.failure.message) : void 0);
	if (dependencies.queueWait !== void 0 && !dependencies.queueWait()) {
		dependencies.onDiag?.("queue: disabled by settings; handing the answer to the host");
		return {
			ready: false,
			attempts: attemptStart
		};
	}
	if (queue?.retryAfterMs === void 0 || Date.now() >= deadline) {
		dependencies.onDiag?.(`queue: not actionable (hint=${queue?.retryAfterMs ?? "none"}, budgetLeftMs=${deadline - Date.now()})`);
		return {
			ready: false,
			attempts: attemptStart
		};
	}
	dependencies.onDiag?.(`queue: detected retryAfterMs=${queue.retryAfterMs} queueType=${queue.queueType ?? "-"}`);
	const pace = Math.max(queue.retryAfterMs, dependencies.queuePollFloorMs ?? queuePollMinIntervalMs);
	const allowed = maxAttempts ?? Math.max(1, Math.floor((deadline - Date.now()) / pace));
	return {
		...await waitForQueue(dependencies, credentials, requestSetId, modelKey, requestId, sessionId, queue, deadline, signal, touch, attemptStart, allowed),
		maxAttempts: allowed
	};
}
async function* streamQoderChat(options, model, credentials, messages, dependencies) {
	const request = await buildQoderRequestBody(options, credentials.userID, messages, model, void 0, dependencies.region);
	const encode = (value) => Buffer.from(qoderEncodeBody(JSON.stringify(value)), "utf8");
	let encodedBytes = encode(request);
	const chatUrl = getQoderChatUrl(dependencies.region);
	const requestSetId = request.request_set_id;
	let requestId = request.request_id;
	const modelKey = options.model || "cmodel";
	const sessionId = options.sessionId === void 0 ? void 0 : String(options.sessionId);
	/**
	* The one cap on a queue wait, shared by every replay of this call.
	*
	* The configured budget is the only thing that may end a wait early. A hidden
	* ceiling — a fixed replay count, a per-round maximum — would make a longer
	* setting meaningless, which is exactly what the setting exists to avoid. The
	* request volume stays bounded regardless: every round sleeps at least
	* {@link queuePollMinIntervalMs}, so the budget can hold no more requests than
	* it has intervals.
	*
	* The transport's own stream-idle window is not a second cap: every poll round
	* restarts it (see {@link waitForQueue}), because a queue wait is deliberate
	* silence rather than a stalled stream.
	*/
	const queueDeadline = Date.now() + (dependencies.queueWaitBudgetMs ?? queueBudgetMs(dependencies));
	let replays = 0;
	let queueAttempts = 0;
	let queueMaxAttempts;
	let reqId;
	/** Rotate the per-attempt ids and re-encode; the queue key is untouched. */
	const rotateAttempt = () => {
		const next = randomUUID();
		request.request_id = next;
		request.chat_record_id = next;
		requestId = next;
		encodedBytes = encode(request);
	};
	for (;;) {
		if (options.signal?.aborted) throw aborted$1("Request was aborted.");
		const requestController = new AbortController();
		let headerTimedOut = false;
		let idleTimedOut = false;
		let idleTimer;
		let chunkCount = 0;
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
			dependencies.onDiag?.(`chat ${replays + 1}: POST set=${requestSetId} req=${requestId}`);
			const response = await dependencies.fetch(chatUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"accept": "text/event-stream",
					"cache-control": "no-cache",
					"accept-encoding": "identity",
					"x-model-key": modelKey,
					"x-model-source": model?.source || "system",
					"user-agent": qoderUserAgent,
					...buildAuthHeaders(encodedBytes, chatUrl, credentials)
				},
				body: encodedBytes,
				signal: requestController.signal
			});
			clearTimeout(headerTimer);
			reqId = qoderRequestId(response.headers);
			dependencies.onDiag?.(`chat ${replays + 1}: HTTP ${response.status}`);
			dependencies.logger?.debug?.("[Qoder Stream] Response headers received", {
				region: dependencies.region,
				status: response.status,
				durationMs: Math.round(performance.now() - startedAt),
				...reqId === void 0 ? {} : { requestId: reqId },
				...replays === 0 ? {} : { replays }
			});
			resetIdleTimer();
			if (!response.ok) {
				let errorBody;
				try {
					errorBody = await readLimitedText(response, defaultMaxErrorBytes, "Qoder chat error response");
				} catch {
					errorBody = void 0;
				}
				const failure = qoderHttpError(`Qoder upstream service returned HTTP ${response.status}.`, response, errorBody);
				if (Date.now() < queueDeadline) {
					const outcome = await rideQueue(failure, errorBody, dependencies, credentials, requestSetId, modelKey, requestId, sessionId, queueDeadline, requestController.signal, resetIdleTimer, queueAttempts, queueMaxAttempts);
					queueAttempts = outcome.attempts;
					queueMaxAttempts = outcome.maxAttempts ?? queueMaxAttempts;
					if (outcome.ready) {
						replays += 1;
						rotateAttempt();
						continue;
					}
				}
				dependencies.onDiag?.("chat: handing the queue failure to the host");
				throw failure;
			}
			if (!response.body) throw new QoderLlmError("Qoder response contains no readable body stream.", "EMPTY_RESPONSE");
			let firstChunkDurationMs;
			let tokenUsage;
			let finishReason;
			const streamStartedAt = performance.now();
			let replay = false;
			try {
				for await (const chunk of parseQoderSse(response.body, {
					onActivity: resetIdleTimer,
					...dependencies.onDiag === void 0 ? {} : { onDiag: dependencies.onDiag },
					...dependencies.onNotice === void 0 ? {} : { onNotice: dependencies.onNotice }
				})) {
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
			} catch (error) {
				const outcome = chunkCount !== 0 || Date.now() >= queueDeadline ? {
					ready: false,
					attempts: queueAttempts
				} : await rideQueue(error, void 0, dependencies, credentials, requestSetId, modelKey, requestId, sessionId, queueDeadline, requestController.signal, resetIdleTimer, queueAttempts, queueMaxAttempts);
				queueAttempts = outcome.attempts;
				queueMaxAttempts = outcome.maxAttempts ?? queueMaxAttempts;
				if (!outcome.ready) {
					dependencies.onDiag?.("chat: failure inside the SSE envelope handed to the host");
					throw error;
				}
				replays += 1;
				rotateAttempt();
				replay = true;
			}
			if (replay) continue;
			dependencies.logger?.debug?.("[Qoder Stream] Stream completed", {
				durationMs: Math.round(performance.now() - startedAt),
				streamDurationMs: Math.round(performance.now() - streamStartedAt),
				chunkCount,
				...finishReason === void 0 ? {} : { finishReason },
				...tokenUsage === void 0 ? {} : { usage: tokenUsage },
				...reqId === void 0 ? {} : { requestId: reqId }
			});
			return;
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
}
//#endregion
//#region src/qoder/transport/default-transport.ts
/** Deep module owning all communication with Qoder. */
const defaultStreamIdleTimeoutMs = 6e5;
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
	onQueueWait;
	createQueueWaitHandler;
	createNoticeHandler;
	onNotice;
	queueWaitBudgetMs;
	onDiag;
	queueWait;
	/** Whether the current unresolved heal failure has already been reported, once per outage. */
	refreshFailureAnnounced = false;
	constructor(options) {
		this.region = options.region;
		this.resolvePat = options.resolvePat;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.logger = options.logger;
		this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 6e5;
		this.responseHeaderTimeoutMs = options.responseHeaderTimeoutMs ?? 6e4;
		this.metadataTimeoutMs = options.metadataTimeoutMs;
		this.attachments = options.attachments;
		this.preserveThinking = options.preserveThinking;
		this.onJobTokenRefreshed = options.onJobTokenRefreshed;
		this.onJobTokenRefreshFailed = options.onJobTokenRefreshFailed;
		this.onQueueWait = options.onQueueWait;
		this.createQueueWaitHandler = options.createQueueWaitHandler;
		this.createNoticeHandler = options.createNoticeHandler;
		this.onNotice = options.onNotice;
		this.queueWaitBudgetMs = options.queueWaitBudgetMs;
		this.onDiag = options.onDiag;
		this.queueWait = options.queueWait;
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
		const onQueueWait = this.createQueueWaitHandler?.(options) ?? this.onQueueWait;
		const onNotice = this.createNoticeHandler?.(options) ?? this.onNotice;
		return this.generate(options, model, onQueueWait, onNotice);
	}
	/**
	* Report a self-heal notice into the configured sink.
	*
	* No age guard: the notice belongs to this request and is reported at its own
	* acceptance, so an age limit could only cut a row whose retry queued a while.
	*/
	emitRefreshedNotice(notice) {
		this.logger?.warn?.("[Qoder Stream] Job token was auto-refreshed after an upstream rejection; the chat has recovered");
		this.onJobTokenRefreshed?.({
			region: this.region,
			at: notice.at,
			...notice.sessionId !== void 0 ? { sessionId: notice.sessionId } : {}
		});
	}
	/** Note that the upstream accepted a chat, ending any unresolved heal failure. */
	onChatAccepted() {
		this.refreshFailureAnnounced = false;
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
	* Stream one chat, reporting acceptance as soon as the first chunk arrives
	* (the consumer may close the stream early, and nothing after the yield runs).
	*
	* @param onAccepted - Called once, before the first chunk is forwarded.
	*/
	async *streamChat(options, model, credentials, messages, onAccepted, onQueueWait, onNotice) {
		const stream = streamQoderChat(options, model, credentials, messages, {
			fetch: this.fetchImpl,
			logger: this.logger,
			region: this.region,
			responseHeaderTimeoutMs: this.responseHeaderTimeoutMs,
			streamIdleTimeoutMs: this.streamIdleTimeoutMs,
			...onQueueWait === void 0 ? {} : { onQueueWait },
			...onNotice === void 0 ? {} : { onNotice },
			...this.queueWaitBudgetMs === void 0 ? {} : { queueWaitBudgetMs: this.queueWaitBudgetMs() },
			...this.onDiag === void 0 ? {} : { onDiag: this.onDiag },
			...this.queueWait === void 0 ? {} : { queueWait: this.queueWait }
		});
		const first = await stream.next();
		onAccepted();
		if (!first.done) yield first.value;
		yield* stream;
	}
	async *generate(options, model, onQueueWait, onNotice) {
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
		let produced = false;
		try {
			for await (const chunk of this.streamChat(options, model, chatCredentials, messages, () => {
				this.onChatAccepted();
			}, onQueueWait, onNotice)) {
				produced = true;
				yield chunk;
			}
			return;
		} catch (error) {
			if (produced) throw error;
			if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error;
			this.logger?.warn?.("[Qoder Stream] Chat rejected as unauthorized; exchanging a fresh job token and retrying once", { status: error.failure.status });
		}
		let lastRejection;
		let requestNotice;
		for (let round = 0; round < 2; round++) {
			const refreshed = await this.auth.exchangeFresh(pat, options.signal);
			requestNotice = {
				at: Date.now(),
				...options.sessionId !== void 0 ? { sessionId: String(options.sessionId) } : {}
			};
			try {
				for await (const chunk of this.streamChat(options, model, refreshed, messages, () => {
					this.onChatAccepted();
					if (requestNotice !== void 0) {
						this.emitRefreshedNotice(requestNotice);
						requestNotice = void 0;
					}
				}, onQueueWait, onNotice)) {
					produced = true;
					yield chunk;
				}
				return;
			} catch (error) {
				if (produced) throw error;
				if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error;
				lastRejection = error;
				if (round + 1 < 2) {
					this.logger?.warn?.("[Qoder Stream] Fresh job token also rejected; waiting 2s and retrying once more", {
						status: error.failure.status,
						round: round + 1
					});
					await new Promise((resolve, reject) => {
						const signal = options.signal;
						if (signal?.aborted) {
							reject(aborted("Request was aborted during the re-auth backoff."));
							return;
						}
						let timer;
						const onAbort = () => {
							if (timer !== void 0) clearTimeout(timer);
							reject(aborted("Request was aborted during the re-auth backoff."));
						};
						timer = setTimeout(() => {
							signal?.removeEventListener("abort", onAbort);
							resolve();
						}, 2e3);
						signal?.addEventListener("abort", onAbort, { once: true });
					});
				}
			}
		}
		if (!this.refreshFailureAnnounced) {
			this.refreshFailureAnnounced = true;
			this.logger?.warn?.("[Qoder Stream] Job token refresh did not recover the chat; the upstream still rejects it", { status: lastRejection instanceof LlmError ? lastRejection.failure.status : void 0 });
			this.onJobTokenRefreshFailed?.({
				region: this.region,
				at: Date.now(),
				...options.sessionId !== void 0 ? { sessionId: String(options.sessionId) } : {},
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
* Qoder upstream client — the loopback shim's OpenAI-shaped surface, carried over
* to the Qoder transport.
*
* The card, the CLI, and DSH's pi-ai adapter all reach Qoder through this module:
* it translates the narrow OpenAI chat-completions request into dsh-llm's
* `GenerateOptions`, re-serializes `StreamChunk` back into `chat.completion.chunk`
* SSE frames so the adapter needs nothing Qoder-specific, and maps catalog
* discovery and the account read onto the plugin's rows. Failures follow the
* transport's error taxonomy (`QoderLlmError.failure.code` plus its HTTP status).
*
* @module dsh-qoder-connect/upstream
*/
/**
* HTTP status the shim answers each failure kind with.
*
* `timeout` is 408, deliberately not 504: the harness's pi-ai classifier tests
* `/\b5\d\d\b/` before its `timeout` test, so a 5xx would read as SERVER.
*/
const KIND_STATUS = {
	missing_credential: 401,
	auth: 401,
	soft_rate: 429,
	quota_exceeded: 402,
	timeout: 408,
	server: 502,
	client: 400
};
/**
* Normalize a billing rate label for display.
*
* Qoder reports a `priceFactor` number; the host spells it `x<n>`. The card wants
* one shape: a trimmed multiplier without the trailing "credits".
*/
function normalizeCredits(credits) {
	if (credits === void 0) return void 0;
	const trimmed = credits.trim().replace(/\s+credits?$/iu, "");
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Classify a raw HTTP upstream failure from status and a body excerpt.
*
* A documented result code outranks the status: Qoder answers a saturated queue
* or a spent daily window with 401/403, and reading either as a dead credential
* would park a healthy account. Status comes next, then body phrases.
*/
function classifyUpstreamError(status, body) {
	const lower = body.toLowerCase();
	if (qoderQueueSignal(body) !== void 0) return "soft_rate";
	const documented = qoderResultCode(body);
	if (documented?.family === "quota") return "quota_exceeded";
	if (documented?.family === "request") return "client";
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
	if (status === 408) return "timeout";
	if (status === 0 || status >= 500) return "server";
	return "client";
}
/**
* Map one structured transport failure onto the shim's error kind.
*
* Code families are tested before the status arm because the upstream keeps its
* 401/403 for throttles, spent windows, and refused requests alike: letting the
* status claim them would report a dead credential the host never retries.
* `status === 402` is tested before the request arm because the transport codes a
* 402 as `INVALID_REQUEST`.
*/
function kindFromQoderFailure(failure) {
	if (failure.code === "MISSING_CREDENTIAL") return "missing_credential";
	if (failure.code === "RATE_LIMIT") return "soft_rate";
	if (failure.code === "QUOTA" || failure.code === "ACCOUNT_QUOTA") return "quota_exceeded";
	if (failure.status === 402) return "quota_exceeded";
	if (failure.code.startsWith("INVALID_") || failure.code.startsWith("UNSUPPORTED_") || failure.code === "ATTACHMENT") return "client";
	if (failure.code === "AUTH" || failure.status === 401 || failure.status === 403) return "auth";
	if (failure.status === 429) return "soft_rate";
	if (failure.code === "TIMEOUT") return "timeout";
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
function isRecord$1(value) {
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
* With `imagesAs`, image parts are committed; a request carrying images without a
* commit path fails as a client error, since the Qoder wire only transports a
* durable attachment reference.
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
		if (!isRecord$1(raw) || typeof raw["type"] !== "string") throw new UpstreamRequestError(`${role} message content part is malformed`);
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
				const url = isRecord$1(imageUrl) && typeof imageUrl["url"] === "string" ? imageUrl["url"] : "";
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
* Deliberately narrow: it accepts exactly what pi-ai's `openai-completions` API
* sends and rejects anything else with an attributable 400 rather than silently
* dropping a caller's intent. System prompts ride `options.system`; tool results
* become dedicated user-role messages the Qoder serializer accepts.
*/
async function toGenerateOptions(bodyJson, context) {
	let parsed;
	try {
		parsed = JSON.parse(bodyJson);
	} catch {
		throw new UpstreamRequestError("request body is not valid JSON");
	}
	if (!isRecord$1(parsed)) throw new UpstreamRequestError("request body must be a JSON object");
	const model = requiredString(parsed["model"], "model");
	const rawMessages = parsed["messages"];
	if (!Array.isArray(rawMessages) || rawMessages.length === 0) throw new UpstreamRequestError("messages must be a non-empty array");
	const systemParts = [];
	const messages = [];
	for (const raw of rawMessages) {
		if (!isRecord$1(raw)) throw new UpstreamRequestError("each message must be an object");
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
					if (!isRecord$1(rawCall)) throw new UpstreamRequestError("each tool call must be an object");
					const fn = isRecord$1(rawCall["function"]) ? rawCall["function"] : rawCall;
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
					text = content.filter((part) => isRecord$1(part) && part["type"] === "text").map((part) => typeof part["text"] === "string" ? part["text"] : "").join("");
					if (content.some((part) => isRecord$1(part) && part["type"] !== "text")) throw new UpstreamRequestError("tool result content is limited to text");
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
		if (!isRecord$1(raw)) throw new UpstreamRequestError("each tool must be an object");
		const fn = isRecord$1(raw["function"]) ? raw["function"] : raw;
		if (!isRecord$1(fn)) throw new UpstreamRequestError("each tool must carry a function object");
		return {
			name: requiredString(fn["name"], "tool name"),
			description: typeof fn["description"] === "string" ? fn["description"] : "",
			parameters: isRecord$1(fn["parameters"]) ? fn["parameters"] : {}
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
		...context.signal === void 0 ? {} : { signal: context.signal },
		...context.sessionId === void 0 ? {} : { sessionId: context.sessionId },
		...context.purpose === void 0 ? {} : { purpose: context.purpose }
	};
}
/**
* Re-serialize one `StreamChunk` sequence into OpenAI chunk frames.
*
* One assistant choice, deltas keyed by a per-block tool-call index, reasoning
* streamed as `delta.reasoning_content`, usage as a choices-less frame before the
* terminal finish, and `data: [DONE]` last. A failed finish mid-stream becomes an
* error JSON frame then `[DONE]`: the HTTP status is already sent.
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
/**
* Normalize a provider retry hint for {@link QoderChatResult}.
*
* Only a positive finite number is a hint: the truncation keeps the shim's
* `Retry-After` an integer number of seconds, and `undefined` keeps the optional
* field off the result entirely.
*/
function retryHintOf(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? { retryAfterMs: Math.floor(value) } : {};
}
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
			message: error.failure.message,
			...retryHintOf(error.failure.providerRetryAfterMs)
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
	* The catalog row for one model id: this client's own discovery answers first,
	* and an externally supplied provider fills ids the discovery never listed.
	*/
	catalogModelFor(id) {
		return this.discovered.get(id) ?? this.externalCatalog?.(id);
	}
	/**
	* Discover this variant's models and translate them into plugin rows.
	*
	* The raw rows stay addressable via {@link catalogModelFor}: a chat request must
	* hand the transport its row, because effort support, image capability, and the
	* output cap are validated against it.
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
	* One personal quota, an optional organization package, bonus credits, and — on
	* the international edition — campaign grants, each becoming a package row. An
	* unbounded personal allowance (`total === 0`, not exceeded) is the "unlimited"
	* state. A campaign grant carries its own expiry and localized title, never
	* borrowed from the account.
	*/
	async fetchCredits(signal) {
		const usage = (await this.transport.readAccount({
			force: true,
			...signal === void 0 ? {} : { signal }
		})).usage ?? {};
		const accounts = [];
		const personal = usage.userQuota;
		if (personal !== void 0) accounts.push({
			packageName: "个人额度",
			remain: personal.remaining,
			size: personal.total,
			...usage.expiresAt === void 0 ? {} : { packageEndTime: usage.expiresAt }
		});
		const org = usage.orgResourcePackage;
		if (org !== void 0) accounts.push({
			packageName: "组织资源包",
			remain: org.remaining,
			size: org.total,
			...usage.expiresAt === void 0 ? {} : { packageEndTime: usage.expiresAt }
		});
		const addOn = usage.addOnQuota;
		if (addOn !== void 0) accounts.push({
			packageName: "赠送额度",
			remain: addOn.remaining,
			size: addOn.total,
			...usage.expiresAt === void 0 ? {} : { packageEndTime: usage.expiresAt }
		});
		for (const pack of usage.dedicatedResourcePackages ?? []) {
			const titles = pack.title;
			const fallbackName = titles?.zh ?? titles?.en ?? pack.name ?? "专属资源包";
			accounts.push({
				packageName: fallbackName,
				...titles === void 0 ? {} : { packageNameI18n: titles },
				...pack.name === void 0 ? {} : { packageCode: pack.name },
				remain: pack.remaining,
				size: pack.total,
				...pack.expiresAt === void 0 ? {} : { packageEndTime: pack.expiresAt }
			});
		}
		const unlimited = usage.isQuotaExceeded === false && personal !== void 0 && personal.total === 0;
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
	* everything rejectable without the network — a missing credential, an
	* unadvertised effort, an image on a text-only model — must still answer as a
	* real HTTP status, not a 200 whose first frame is an error. Once streaming has
	* begun, failures degrade to the error-frame-then-`[DONE]` form.
	*/
	async chatStream(bodyJson, signal, sessionId, purpose) {
		let options;
		try {
			options = await toGenerateOptions(bodyJson, {
				providerId: this.providerId,
				attachments: this.attachments,
				sessionId,
				purpose,
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
						message: earlyFailure.message,
						...retryHintOf(earlyFailure.providerRetryAfterMs)
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
	* A row that declares efforts is checked locally, so an unlisted value costs no
	* request; a row that declares none sends the value to the upstream, the only
	* authority on spellings the catalog never lists. Either refusal is an
	* attributable 400 with code `UNSUPPORTED_REASONING_EFFORT`, and the stream is
	* ended after the first chunk arrives.
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
			if (error instanceof LlmError) {
				const status = error.failure.status ?? defaultStatusForProbe(error.failure.code);
				return {
					status,
					streamed: false,
					errorCode: status === 400 && blamesReasoningEffort(error.failure.message) ? "UNSUPPORTED_REASONING_EFFORT" : error.failure.code,
					detail: error.failure.message.slice(0, 300)
				};
			}
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		}
	}
};
/**
* Whether an upstream 400 blames the `reasoning_effort` value it was sent.
*
* Both markers are required: a 400 naming only one is some other parameter
* problem, and the sweep must not record it as a rejected level.
*/
function blamesReasoningEffort(message) {
	return message.includes("invalid_parameter_error") && message.includes("reasoning_effort");
}
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
* The billing section reports the price factor only, spelled `x<n>`, and says so
* honestly when the upstream reported nothing (`rateUnknown`). Context capacity
* comes from the effective window, with the declared options kept for the card; a
* row with no capacity takes the transport's default.
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
		...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
		...model.maxTokensDeclared === true ? { maxTokensDeclared: true } : {},
		supportsImages: model.supportsImages === true,
		...reasoning === void 0 ? {} : { reasoning },
		billing,
		...model.source === void 0 ? {} : { source: model.source }
	};
}
/** A conservative input budget for rows that declare none. */
const DEFAULT_CONTEXT_WINDOW = 18e4;
//#endregion
//#region src/probe-store.ts
/**
* Local record of reasoning-effort probes.
*
* What this stores is an *observation*, never a claim about the upstream: it is
* only consulted when the catalog carries no explicit `supportedEfforts` set, and
* it always loses to a declared set. A result is invalidated whenever the model's
* catalog row changes, so every record carries a fingerprint of the fields the
* probe depended on. The file lives in the plugin's state directory and carries
* no token, prompt, or response body.
*
* @module dsh-qoder-connect/probe-store
*/
/** Basename of the China variant's probe record inside the plugin's state dir. */
const QODER_PROBE_FILENAME = ".qoder-probe.json";
/** On-disk format this reader accepts; other versions are discarded. */
const PROBE_FORMAT_VERSION = 1;
/**
* How long an observation stays usable. Conservative on purpose: upstream
* metadata moves fast, so a stale result must not keep granting a picker entry.
*/
const DEFAULT_TTL_MS = 12096e5;
/**
* Plugin-owned probe record path inside the plugin's state directory.
*
* One file per variant: the regions serve overlapping ids with different
* entitlements, and {@link fingerprintModel} never covers the provider, so a
* shared file would let one variant's observation answer for the other.
*/
function qoderProbePath(filename = QODER_PROBE_FILENAME) {
	return join(qoderStateDir(), filename);
}
/**
* Fingerprint the catalog fields a probe depends on.
*
* Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
* so a rename or a rate relabel does not throw away a valid observation, and
* deliberately includes the whole reasoning object so any change to the
* declared shape re-probes.
*/
function fingerprintModel(info) {
	const basis = JSON.stringify({
		id: info.id,
		reasoning: info.reasoning ?? null,
		supportsImages: info.supportsImages ?? null
	});
	return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
/** Read-and-validate the documents on disk; anything malformed reads as empty. */
function readDocument(path) {
	if (!existsSync(path)) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	if (wrapped["version"] !== PROBE_FORMAT_VERSION) return void 0;
	const records = wrapped["records"];
	if (typeof records !== "object" || records === null || Array.isArray(records)) return void 0;
	return parsed;
}
/** One record's shape check; a bad row is dropped rather than trusted. */
function isRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapped = value;
	const validation = wrapped["validation"];
	if (validation !== "validating" && validation !== "non-validating" && validation !== "unknown") return false;
	if (typeof wrapped["fingerprint"] !== "string") return false;
	if (typeof wrapped["probedAtMs"] !== "number" || !Number.isFinite(wrapped["probedAtMs"])) return false;
	if (typeof wrapped["pluginVersion"] !== "string") return false;
	const efforts = wrapped["efforts"];
	if (!Array.isArray(efforts) || efforts.some((effort) => typeof effort !== "string")) return false;
	return true;
}
/**
* The plugin's probe records: read once, written atomically, never trusted
* across a fingerprint change or past the TTL.
*/
var QoderProbeStore = class {
	path;
	ttlMs;
	pluginVersion;
	now;
	records;
	constructor(options) {
		const opts = typeof options === "string" ? {
			path: options,
			pluginVersion: "0.0.0"
		} : options;
		this.path = opts.path ?? qoderProbePath();
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.pluginVersion = opts.pluginVersion;
		this.now = opts.now ?? (() => Date.now());
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.records === void 0) {
			const document = readDocument(this.path);
			const records = {};
			for (const [id, record] of Object.entries(document?.records ?? {})) if (isRecord(record)) records[id] = record;
			this.records = records;
		}
		return this.records;
	}
	/**
	* The usable record for a model, or `undefined` when there is none, it is
	* expired, it was taken against a different catalog row, or it belongs to a
	* different account.
	*
	* @param account - the account in effect, as `uid:enterpriseId`. Records are
	*   only returned for the account that produced them.
	*/
	get(modelId, fingerprint, account) {
		const record = this.load()[modelId];
		if (record === void 0) return void 0;
		if (record.fingerprint !== fingerprint) return void 0;
		if (record.account !== account) return void 0;
		if (this.now() - record.probedAtMs > this.ttlMs) return void 0;
		return record;
	}
	/**
	* Store one observation. Only a decisive answer (`validating` /
	* `non-validating`) replaces an existing decisive record: a transient
	* `unknown` must not erase knowledge the user already paid for.
	*/
	set(modelId, record) {
		const records = this.load();
		const existing = records[modelId];
		if (record.validation === "unknown" && existing !== void 0 && existing.fingerprint === record.fingerprint && existing.validation !== "unknown") return;
		records[modelId] = record;
		this.persist();
	}
	/** Drop every record; used by the card's explicit "clear" action. */
	clear() {
		this.records = {};
		this.persist();
	}
	/**
	* Drop every record that belongs to one account, leaving other accounts'
	* observations intact.
	*
	* A saved token's detected effort levels are that account's data; a plain
	* {@link clear} would erase the observations of every account still saved.
	*/
	clearFor(account) {
		const records = this.load();
		let removed = false;
		for (const [modelId, record] of Object.entries(records)) {
			if (record.account !== account) continue;
			delete records[modelId];
			removed = true;
		}
		if (removed) this.persist();
	}
	/** Every record currently held, for status display. */
	all() {
		return { ...this.load() };
	}
	/** Build a record stamped with this store's clock, version, and account. */
	record(fingerprint, validation, efforts, account) {
		return {
			fingerprint,
			validation,
			efforts: validation === "validating" ? [...efforts] : [],
			probedAtMs: this.now(),
			pluginVersion: this.pluginVersion,
			account
		};
	}
	/**
	* Write through a temporary file and rename, so a crash mid-write cannot
	* leave a half-parsed document that reads as "no records" and silently drops
	* every observation.
	*/
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: PROBE_FORMAT_VERSION,
				records: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {}
	}
};
/**
* Order observations newest-first for display: the card wants the most recent
* detection at the top, while the file keeps insertion order.
*/
function newestFirst(records) {
	return [...records].sort((a, b) => b.probedAt - a.probedAt);
}
//#endregion
//#region src/version.ts
const QODER_CONNECT_VERSION = "0.2.11";
//#endregion
//#region src/host-heartbeat.ts
/**
* Host-side heartbeat: a small JSON file written into the plugin's data directory
* once the `qoder` providers are registered. The status CLI reads it to report
* whether the host bundle is alive, independent of the browser card (the browser
* bundle cannot write files, and the host is the load-bearing half).
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
* Write (or overwrite) the heartbeat after the host registered the provider.
* A failed write is non-fatal: the CLI then reports "heartbeat missing".
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
async function clearHostHeartbeat(expectedPid = process.pid) {
	try {
		const current = await readHostHeartbeat();
		if (current !== void 0 && current.pid !== expectedPid) return;
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
* Whether the heartbeat's PID is still alive.
*
* Uses Node's native `process.kill(pid, 0)` cross-platform signal probe:
* - Returns true on success or EPERM (process exists and is alive);
* - Returns false on ESRCH (process does not exist in the operating system);
* - Rejects non-positive or non-integer PIDs to prevent matching process groups.
*
* Known limitation: after a host crash, if the OS recycles and reassigns the same PID
* to another process before cleanup, it reads as alive until that PID exits. This trade-off
* is accepted because wmic was removed in Windows 11 24H2+, PowerShell child processes are
* fragile under restrictive sandboxes, and the status check serves only as an informational
* hint in the doctor CLI rather than a critical operational invariant.
*/
function isHeartbeatProcessAlive(heartbeat) {
	if (!Number.isInteger(heartbeat.pid) || heartbeat.pid <= 0) return false;
	try {
		process.kill(heartbeat.pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
//#endregion
//#region src/variants.ts
/**
* The two Qoder products this one plugin serves.
*
* Same upstream in different regions; everything that varies (routes, file and
* display identity) is one descriptor, so a third variant stays a data change.
* Each variant holds its own PAT: tokens and files never cross between regions.
* The browser half reads the same ids and routes from `status-paths.ts`.
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
export { configurePluginPaths as $, probeModel as A, QODER_PROBE_PATH as B, validateApiKey as C, utc8WallClock as D, formatUtc8Date as E, QoderCatalog as F, QODER_PAT_ENV_GLOBAL as G, QODER_STATUS_PATH as H, QODER_AUTH_PATH as I, qoderCredentialId as J, QoderCredentialStore as K, QODER_GLOBAL_AUTH_PATH as L, QoderCatalogStore as M, qoderCatalogPath as N, getMachineId as O, FALLBACK_QODER_MODELS as P, QODER_DATA_DIR_NAME as Q, QODER_GLOBAL_PROBE_PATH as R, normalizeCredits as S, defaultStreamIdleTimeoutMs as T, QODER_AUTH_FILENAME as U, QODER_SETTINGS_FACE_PATH as V, QODER_PAT_ENV_CN as W, qoderOwnAuthPath as X, qoderCredentialIdentity as Y, QODER_DATA_DIR_ENV as Z, KIND_STATUS as _, QODER_HOST_HEARTBEAT_FILENAME as a, kindFromQoderFailure as b, qoderHostHeartbeatPath as c, QODER_CONNECT_VERSION as d, qoderMachineIdPath as et, QODER_PROBE_FILENAME as f, qoderProbePath as g, newestFirst as h, variantFor as i, randomSentinel as j, PROBE_EFFORT_CANDIDATES as k, readHostHeartbeat as l, fingerprintModel as m, GLOBAL_VARIANT as n, clearHostHeartbeat as o, QoderProbeStore as p, patTail as q, QODER_VARIANTS as r, isHeartbeatProcessAlive as s, CHINA_VARIANT as t, qoderPluginDataDir as tt, writeHostHeartbeat as u, QoderUpstreamClient as v, createQoderTransport as w, modelInfoOf as x, classifyUpstreamError as y, QODER_GLOBAL_STATUS_PATH as z };
