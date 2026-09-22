import { A as QODER_GLOBAL_AUTH_PATH, B as qoderCredentialIdentity, C as probeModel, D as FALLBACK_QODER_MODELS, E as qoderCatalogPath, F as QODER_AUTH_FILENAME, G as qoderPluginDataDir, H as QODER_DATA_DIR_ENV, I as QODER_PAT_ENV_CN, K as qoderStateDir, L as QODER_PAT_ENV_GLOBAL, M as QODER_GLOBAL_STATUS_PATH, N as QODER_PROBE_PATH, O as QoderCatalog, P as QODER_STATUS_PATH, R as QoderCredentialStore, S as PROBE_EFFORT_CANDIDATES, T as QoderCatalogStore, U as QODER_DATA_DIR_NAME, V as qoderOwnAuthPath, W as qoderMachineIdPath, _ as modelInfoOf, a as QODER_HOST_HEARTBEAT_FILENAME, b as createQoderTransport, c as processStartTimeMs, d as writeHostHeartbeat, f as QODER_CONNECT_VERSION, g as kindFromQoderFailure, h as classifyUpstreamError, i as variantFor, j as QODER_GLOBAL_PROBE_PATH, k as QODER_AUTH_PATH, l as qoderHostHeartbeatPath, m as QoderUpstreamClient, n as GLOBAL_VARIANT, o as clearHostHeartbeat, p as KIND_STATUS, r as QODER_VARIANTS, s as isHeartbeatProcessAlive, t as CHINA_VARIANT, u as readHostHeartbeat, v as normalizeCredits, w as randomSentinel, x as getMachineId, y as validateApiKey, z as patTail } from "./variants-q5dsYSE8.js";
import z from "@deepseek-ai/schemastery";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/loopback.ts
/**
* Shared loopback gates for the plugin's local HTTP surfaces: the loopback
* shim and the same-origin web-status route. Both are only ever meant to be
* addressed through the machine's loopback interface.
*
* @module dsh-qoder-connect/loopback
*/
/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
//#endregion
//#region src/auth-route.ts
/**
* PAT route: saves (validate-then-persist) or clears one variant's token.
*
* The state-changing endpoints the plugin exposes share one guard shape — a
* loopback Host and Origin, plus the in-process key the card receives with its
* status document — because loopback alone is *not* authentication: any local
* process can address `127.0.0.1`, and this route writes a credential to disk.
*
* The region is never taken from the request. It is fixed by the route the
* browser called (one route per variant), so a card for one product can never
* steer a token into the other's upstream — a token pasted into the Qoder
* Global card is validated against, and stored for, Qoder Global only.
*
* @module dsh-qoder-connect/auth-route
*/
/** Largest control body accepted; a Personal Access Token is a short string. */
const MAX_BODY_BYTES$1 = 16384;
function json$2(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody$2(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES$1) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check a PAT request; unknown fields are ignored, not trusted. */
function parseRequest(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "clear") return { action };
	if (action === "save-pat") {
		const pat = wrapped["pat"];
		if (typeof pat !== "string" || pat.trim() === "") return void 0;
		return {
			action,
			pat
		};
	}
}
/**
* Strip token-like content from a message before it reaches the browser.
*
* The route reports failures to a same-origin card, and a validation error
* body is the one input here that is not the plugin's own prose.
* Belt-and-braces: everything this route produces is already a summary, and
* this keeps a future one from carrying a credential across.
*/
function safeMessage$1(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
/** Mint the per-process PAT control key. */
function createAuthKey() {
	return randomBytes(24).toString("hex");
}
/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches$1(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
/**
* The PAT route's handler, extracted so tests can mount it on a bare server
* with a known key.
*
* @param deps - the save/clear operations for one variant.
* @param key - the in-process control key this route requires.
* @returns the Node request handler.
*/
function qoderAuthHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json$2(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
			json$2(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches$1(key, req.headers["x-qoder-auth-key"])) {
			json$2(res, 403, { error: "invalid-auth-key" });
			return;
		}
		const body = await readBody$2(req);
		if (body === void 0) {
			json$2(res, 413, { error: "body too large" });
			return;
		}
		const request = parseRequest(body);
		if (request === void 0) {
			json$2(res, 400, { error: "invalid action" });
			return;
		}
		try {
			if (request.action === "clear") {
				await deps.clear();
				json$2(res, 200, { ok: true });
				return;
			}
			json$2(res, 200, await deps.save(request.pat));
		} catch (error) {
			json$2(res, 200, {
				ok: false,
				error: safeMessage$1(error)
			});
		}
	};
}
/** Mount the POST PAT route on an optional webServer context. */
function registerQoderAuthRoute(ctx, deps, key) {
	const path = deps.path ?? "/plugins/dsh-qoder-connect/auth";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: qoderAuthHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-qoder-connect: PAT route");
}
//#endregion
//#region src/adapter.ts
/**
* The Qoder pi-ai provider: one loopback-backed adapter per variant route,
* registered into the Harness LLM seam, assembled from public
* `dsh-llm-pi-ai` extension points the way `dsh-codex-connect` assembles its
* Codex route.
*
* @module dsh-qoder-connect/adapter
*/
/** Default provider route owned by this bundle (the China variant). */
const QODER_PROVIDER = "qoder";
/** Provider idle ceiling while one stream read is outstanding. */
const QODER_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2. They bound requests to models whose catalog
* entry declares `supportsImages`; text-only models never receive images.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The Qoder routes authenticate only through the
* shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
* credential lifecycle and ambient discovery must never manufacture a
* credential for them. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
* every ambient question here answers "nothing stored, nothing set".
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-qoder-connect: Qoder routes have no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* The suffix appended to a model's display name so its billing rate is visible
* wherever the name is shown.
*
* The separator is a middle dot rather than a hyphen or colon: model names
* commonly contain hyphens, so a hyphen separator would be ambiguous about
* where the name ends and the rate begins.
*/
const RATE_SEPARATOR = " · ";
/**
* Append the billing rate to one model's display name.
*
* The rate rides the *name* alone: since DSH 0.1.2 the composer's model seat
* (`ModelSelect`) renders `model.name` only — `description` is no longer read
* there at all. The `/model` popup renders the name too, so a separate
* `description` copy would duplicate the rate depending on client generation.
*
* This is display-only and cannot affect routing: the wire request is built
* from `model.id` (pi-ai's completions API sets `model: model.id`), the
* selection a picker submits is `{provider, model: id, reasoningEffort}`, and
* `dsh-llm` validates `name` as a non-empty string without comparing its
* contents. Nothing in the host resolves a model *by* name.
*/
/** The catalog display suffix: the normalized billing rate, when the row has one. */
function displaySuffix(info) {
	const rate = normalizeCredits(info.billing?.credits);
	return rate === void 0 || rate === "" ? void 0 : rate;
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve a Qoder model's reasoning capability into pi-ai's
* `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
* unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
*
* Two sources, strictly ordered (`docs/reasoning-effort-probe-plan.md` §5):
*
* 1. **The declared set.** When the upstream declares a non-empty
*    `supportedEfforts`, exactly those values are offered and nothing else.
*    This always wins: an observation never widens or narrows a declared set.
* 2. **A local observation.** Rows the upstream left undeclared normally get
*    no control at all — their selectable set is client-side knowledge the
*    catalog does not carry. If the user authorized a probe and it established
*    that the upstream *validates* the parameter, the verified spellings are
*    offered.
*
* A `non-validating` observation deliberately yields no control: an upstream
* that accepts values that cannot exist would make every per-level acceptance
* a false positive.
*
* `off` is offered only when the upstream declares `canDisableThinking: true`.
* It is never probed — disabling thinking is a separate capability, and the
* per-model acceptance of `off` cannot be inferred from the row's shape.
*
* The offered set is described internally as "verified accepted", never as
* "verified effective": acceptance proves the upstream did not reject the
* spelling, not that it changes what the model does.
*/
function reasoningFields(info, observed) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const declared = reasoning.supportedEfforts;
	const efforts = declared !== void 0 && declared.length > 0 ? declared : observed?.validation === "validating" && observed.efforts.length > 0 ? observed.efforts : void 0;
	if (efforts === void 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: reasoning.canDisableThinking === true && declared !== void 0 && declared.length > 0 ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, observed, providerId = QODER_PROVIDER) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info, observed),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		compat: { maxTokensField: "max_tokens" }
	};
}
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog,
* and every model's `baseUrl` is re-resolved per read so the shim's
* ephemeral port applies from the first snapshot after startup.
*
* The profile is constructed by hand rather than through dsh-llm-pi-ai's
* internal `resolveProfiles()`: that helper is not part of the package's
* public export surface (root entry, `lib/` deep imports blocked by the
* exports map, `src/` not shipped), so hand-assembly is the only supported
* path and every newly required field must be adopted here explicitly —
* `modelErrors` since 0.1.5-alpha.2 (#12).
*/
function createQoderAdapter(options) {
	const { shim, store, catalog, resolveAttachments, observe } = options;
	const providerId = options.providerId ?? "qoder";
	const displayName = options.displayName ?? "Qoder";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, observe?.(info.id), providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "Qoder shim shared secret",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: displayName
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, `dsh-qoder-connect:${providerId} retryPolicy`),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new QoderPiAiAdapter(catalog, {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
/**
* The Qoder variant route's adapter: `PiAiAdapter` with the billing rate folded
* into the catalog answers it returns to the DSH model pickers.
*
* `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
* from the pi-ai descriptors, which carry no billing fact, so the rate is
* layered on here by looking the model up in the live catalog. Both overrides
* delegate to `super` and then rewrite only the display fields, so streaming,
* capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
* implements them.
*
* A model missing from the catalog (an id the shim would serve but the last
* upstream refresh did not list) falls through with its name untouched rather
* than being dropped: catalog membership is advisory, and the seam tolerates
* serving an unlisted id.
*/
var QoderPiAiAdapter = class extends PiAiAdapter {
	catalog;
	constructor(catalog, options) {
		super(options);
		this.catalog = catalog;
	}
	/** Catalog entry for one model id, or undefined when the catalog omits it. */
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		return (await super.listModels(provider)).map((model) => {
			const info = this.infoFor(model.id);
			if (info === void 0) return model;
			return {
				...model,
				name: withCatalogDisplay(model.name, info)
			};
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: withCatalogDisplay(resolved.name, info)
		};
	}
};
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
* shim guards the local boundary and hands the raw JSON body to the upstream
* client, which translates it onto the Qoder transport. It binds 127.0.0.1
* only and never serves another interface.
*
* Inbound hardening: the loopback bind alone is not a trust boundary (any
* local process or a DNS-rebinding page can reach 127.0.0.1), so every
* request must carry a loopback Host header, browser-sent Origins must be
* loopback, chat POSTs must be application/json, and the Authorization
* header must carry the shim's per-process shared secret. The plugin's
* own client satisfies all four by construction; local attackers cannot
* read the secret out of the plugin process's memory.
*
* @module dsh-qoder-connect/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody$1(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests carry any bearer; the loopback bind
* is the boundary, and the upstream credential comes from the store alone.
*/
function createQoderShim(options) {
	const { store, client, catalog } = options;
	const logger = options.logger;
	const providerId = options.providerId;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const expected = SHARED_SECRET;
		const a = Buffer.from(presented);
		const b = Buffer.from(expected);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			logger?.warn("dsh-qoder-connect: loopback request failed", error);
			try {
				if (!res.headersSent) writeOpenAIError(res, 500, "internal", "loopback request failed");
				else res.end();
			} catch {}
		});
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error(`${providerId} shim has no listening address`);
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: providerId
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		try {
			await store.resolve();
		} catch (error) {
			writeOpenAIError(res, KIND_STATUS.missing_credential, "not_signed_in", String(error));
			return;
		}
		const raw = (await readBody$1(req)).toString("utf8");
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await client.chatStream(raw, controller.signal);
		if (!result.ok) {
			writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, `${providerId} upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("error", (error) => {
			logger?.warn("dsh-qoder-connect: upstream stream failed mid-flight", error);
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/probe-store.ts
/**
* Local record of reasoning-effort probes.
*
* What this stores is an *observation*, never a claim about the upstream: a
* model's row is only consulted when the catalog carries no explicit
* `supportedEfforts` set, and it always loses to a declared set. The plan this
* implements (`docs/reasoning-effort-probe-plan.md` §5) requires that a result
* is invalidated whenever the model's catalog row changes, so every record
* carries a fingerprint of the fields the probe depended on.
*
* The file lives in the plugin's own state directory, never beside the
* product's files, and carries no token, prompt, or response body — only
* model ids, effort spellings, and timestamps.
*
* @module dsh-qoder-connect/probe-store
*/
/** Basename of the China variant's probe record inside the plugin's state dir. */
const QODER_PROBE_FILENAME = ".qoder-probe.json";
/** On-disk format this reader accepts; other versions are discarded. */
const PROBE_FORMAT_VERSION = 1;
/**
* How long an observation stays usable. Conservative on purpose: the plan's
* whole argument is that upstream metadata moves fast, so a result that has
* outlived its fingerprint's usefulness should not quietly keep granting a
* picker entry.
*/
const DEFAULT_TTL_MS = 12096e5;
/**
* Plugin-owned probe record path inside the plugin's state directory.
*
* One file per variant. The two regions serve overlapping model ids with
* different entitlements, and {@link fingerprintModel} covers only
* `id`/`reasoning`/`supportsImages` — never the provider — so a single shared
* file would let one variant's observation answer for the other. The paths
* differ; the format does not.
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
* Order observations newest-first for display.
*
* The store keeps insertion order so the file reads chronologically, but the
* card wants the most recent detection at the top: a sweep the user just ran
* should not appear below every earlier one, which is what appending to an
* insertion-ordered list does.
*/
function newestFirst(records) {
	return [...records].sort((a, b) => b.probedAt - a.probedAt);
}
//#endregion
//#region src/probe-service.ts
/**
* Serial probe runner. One instance is shared by the manual API and any
* future automatic trigger, so the two can never overlap.
*/
var QoderProbeService = class {
	options;
	queue = Promise.resolve();
	pending = /* @__PURE__ */ new Map();
	running = false;
	constructor(options) {
		this.options = options;
	}
	/** Whether a sweep is in flight right now. */
	isRunning() {
		return this.running;
	}
	/**
	* The record the adapter may use for this model, or `undefined`.
	*
	* Applies the plan's precedence (§5): a declared set always wins, so a model
	* that declares `supportedEfforts` is never answered from an observation.
	*/
	recordFor(modelId) {
		const info = this.options.catalog.current().find((model) => model.id === modelId);
		if (info === void 0) return void 0;
		if (info.reasoning?.supportedEfforts !== void 0 && info.reasoning.supportedEfforts.length > 0) return;
		const account = this.options.account();
		if (account === void 0) return void 0;
		return this.options.store.get(modelId, fingerprintModel(info), account);
	}
	/**
	* Probe one model, serially.
	*
	* The authenticated manual route supplies one-request consent after UI
	* confirmation. Other callers must pass the configured consent gate.
	* Manual consent never changes the automatic-probing configuration.
	* Explicit requests bypass historical results, but share an ongoing run.
	*/
	async probe(modelId, manualConsent = false) {
		if (!manualConsent && !this.options.consent()) return {
			state: "unavailable",
			reason: "probing is not authorized"
		};
		if (this.options.catalog.current().find((model) => model.id === modelId) === void 0) return {
			state: "unavailable",
			reason: `unknown model: ${modelId}`
		};
		const account = this.options.account();
		if (account === void 0) return {
			state: "unavailable",
			reason: "no Qoder credential"
		};
		const pendingKey = JSON.stringify([account, modelId]);
		const pending = this.pending.get(pendingKey);
		if (pending !== void 0) return pending;
		const run = this.queue.then(async () => {
			const current = this.options.catalog.current().find((model) => model.id === modelId);
			if (current === void 0) return {
				state: "unavailable",
				reason: `unknown model: ${modelId}`
			};
			if (!manualConsent && !this.options.consent()) return {
				state: "unavailable",
				reason: "probing is not authorized"
			};
			if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) return {
				state: "unavailable",
				reason: "model does not need detection"
			};
			const cached = this.recordFor(modelId);
			if (!manualConsent && cached !== void 0 && cached.validation !== "unknown") return {
				state: "ok",
				validation: cached.validation,
				efforts: cached.efforts,
				requests: 0
			};
			if (this.options.account() !== account) return {
				state: "unavailable",
				reason: "account changed before detection"
			};
			if (await this.options.credentials.current() === void 0) return {
				state: "unavailable",
				reason: "no Qoder credential"
			};
			const send = this.options.send === void 0 ? (effort, signal) => this.options.client.probeEffort(modelId, effort, signal) : this.options.send(modelId);
			this.running = true;
			try {
				const outcome = await probeModel({
					send,
					...this.options.sentinel === void 0 ? {} : { sentinel: this.options.sentinel }
				});
				if (this.options.account() !== account) return {
					state: "unavailable",
					reason: "account changed during detection"
				};
				const record = this.options.store.record(fingerprintModel(current), outcome.validation, outcome.efforts, account);
				this.options.store.set(modelId, record);
				if (outcome.validation === "unknown") return {
					state: "unavailable",
					reason: outcome.reason
				};
				return {
					state: "ok",
					validation: outcome.validation,
					efforts: record.efforts,
					requests: outcome.requests
				};
			} finally {
				this.running = false;
			}
		});
		this.queue = run.catch(() => void 0);
		this.pending.set(pendingKey, run);
		try {
			return await run;
		} finally {
			this.pending.delete(pendingKey);
		}
	}
};
//#endregion
//#region src/web-status.ts
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* The request must be addressed to the loopback interface, and a
* browser-attached Origin must be loopback too. The Host check drops
* DNS-rebinding pages (their Host is the attacker's domain, not loopback);
* the card's same-origin fetches carry no Origin and pass on Host alone.
*/
function loopbackRequest(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/** The `x<n>` rate label back into the number the snapshot carries, when honest. */
function priceFactorOf(info) {
	if (info.billing.rateUnknown === true) return void 0;
	const rate = normalizeCredits(info.billing.credits);
	if (rate === void 0) return void 0;
	const match = /^x([0-9]+(?:\.[0-9]+)?)$/u.exec(rate);
	if (match === null) return void 0;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : void 0;
}
/** One catalog row as the status document snapshots it. */
function modelSnapshot(model) {
	const supported = model.supportedContextWindows ?? [];
	const maxContextWindow = supported.length > 0 ? Math.max(...supported) : void 0;
	const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow;
	const priceFactor = priceFactorOf(model);
	return {
		id: model.id,
		name: model.name,
		...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
		...defaultContextWindow > 0 && defaultContextWindow < model.contextWindow ? { defaultContextWindow } : {},
		...maxContextWindow === void 0 || maxContextWindow <= defaultContextWindow ? {} : { supportedContextWindows: supported },
		...model.reasoning?.supports === true ? { isReasoning: true } : {},
		...model.reasoning?.supportedEfforts !== void 0 && model.reasoning.supportedEfforts.length > 0 ? { reasoningEfforts: model.reasoning.supportedEfforts } : {},
		...model.reasoning?.defaultEffort === void 0 ? {} : { defaultReasoningEffort: model.reasoning.defaultEffort },
		...priceFactor === void 0 ? {} : { priceFactor },
		supportsImages: model.supportsImages,
		...model.source === void 0 ? {} : { source: model.source }
	};
}
/**
* Assemble the card's status document. Credential state is read-only; credit
* is a live billing answer whose failure degrades to `creditsError` rather
* than failing the whole document.
*/
async function qoderWebStatus(deps) {
	const authStatus = await deps.store.status();
	if (authStatus.state !== "configured") return {
		status: "signed-out",
		...authStatus.reason === void 0 ? {} : { reason: authStatus.reason },
		...deps.authKey === void 0 ? {} : { authKey: deps.authKey }
	};
	const status = {
		status: "signed-in",
		...authStatus.region === void 0 ? {} : { region: authStatus.region },
		...authStatus.pat === void 0 ? {} : { pat: authStatus.pat },
		...deps.authKey === void 0 ? {} : { authKey: deps.authKey }
	};
	const modelsField = deps.models().map(modelSnapshot);
	const catalog = deps.catalog?.();
	const withCatalog = catalog === void 0 ? status : {
		...status,
		catalog
	};
	const statusWithModels = modelsField.length > 0 ? {
		...withCatalog,
		models: modelsField
	} : withCatalog;
	const probed = deps.probe === void 0 ? statusWithModels : {
		...statusWithModels,
		probe: deps.probe(),
		...deps.probeKey === void 0 ? {} : { probeKey: deps.probeKey },
		...deps.useMaximumContextWindow === void 0 ? {} : { useMaximumContextWindow: deps.useMaximumContextWindow() }
	};
	const refreshedAt = deps.jobTokenRefreshedAt?.();
	const withRefreshNotice = refreshedAt === void 0 ? probed : {
		...probed,
		jobTokenRefreshedAt: refreshedAt
	};
	const checkInRecord = deps.checkIn?.();
	const withCheckIn = checkInRecord === void 0 ? withRefreshNotice : {
		...withRefreshNotice,
		checkIn: checkInRecord
	};
	try {
		const credits = await deps.client.fetchCredits();
		return {
			...withCheckIn,
			credits
		};
	} catch (error) {
		return {
			...withCheckIn,
			creditsError: safeMessage(error)
		};
	}
}
/** The status route's request handler, extracted so tests can mount it on a bare server. */
function qoderStatusHandler(deps) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json$1(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			json$1(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json$1(res, 200, await qoderWebStatus(deps));
		} catch (error) {
			json$1(res, 500, { error: safeMessage(error) });
		}
	};
}
/** Mount the GET status route on an optional webServer context. */
function registerQoderStatusRoute(ctx, deps) {
	const path = deps.path ?? "/plugins/dsh-qoder-connect/status";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: qoderStatusHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-qoder-connect: Web status route");
}
//#endregion
//#region src/probe-route.ts
/**
* Probe control route: the only state-changing endpoint the plugin exposes.
*
* Two guards, because they stop different things (see `docs/reasoning-effort-probe-plan.md`
* §6.4 and the v0.3.1 note in AGENTS.md about their exact scope):
*
* 1. **Loopback Host + Origin**, shared with the status route. This drops
*    DNS-rebinding pages, whose requests arrive addressed to the attacker's
*    domain.
* 2. **An in-process random key**, minted per process and handed only to the
*    same-origin card. Loopback alone is *not* authentication — any local
*    process can write `Host: 127.0.0.1` — so a route that spends the user's
*    credit must prove the caller was told the key.
*
* The route never accepts a prompt, a model id outside the live catalog, or a
* sentinel from the browser: a probe request is assembled entirely host-side.
*
* @module dsh-qoder-connect/probe-route
*/
/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096;
/** Mint the per-process control key. */
function createProbeKey() {
	return randomBytes(24).toString("hex");
}
/**
* Constant-time key comparison; a length mismatch is a failure, not a crash.
*/
function keyMatches(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "clear") return { action: "clear" };
	if (action === "clear-checkin-logs") return { action: "clear-checkin-logs" };
	if (action === "checkin") return { action: "checkin" };
	if (action === "refresh") return { action: "refresh" };
	if (action === "set-maximum-context-window") return typeof wrapped["enabled"] === "boolean" ? {
		action: "set-maximum-context-window",
		enabled: wrapped["enabled"]
	} : void 0;
	if (action === "probe") {
		const model = wrapped["model"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		return {
			action: "probe",
			model: model.trim()
		};
	}
}
/**
* The control route's handler, extracted so tests can mount it on a bare
* server with a known key.
*/
function qoderProbeHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches(key, req.headers["x-qoder-probe-key"])) {
			json(res, 403, { error: "invalid-probe-key" });
			return;
		}
		const body = await readBody(req);
		if (body === void 0) {
			json(res, 413, { error: "body too large" });
			return;
		}
		const action = parseAction(body);
		if (action === void 0) {
			json(res, 400, { error: "invalid action" });
			return;
		}
		try {
			if (action.action === "clear-checkin-logs") {
				deps.clearCheckInLogs?.();
				json(res, 200, { state: "cleared" });
				return;
			}
			if (action.action === "checkin") {
				if (deps.checkIn === void 0) {
					json(res, 404, { error: "checkin-not-supported" });
					return;
				}
				json(res, 200, await deps.checkIn());
				return;
			}
			if (action.action === "clear") {
				deps.clear();
				json(res, 200, { state: "cleared" });
				return;
			}
			if (action.action === "refresh") {
				if (deps.refresh === void 0) {
					json(res, 404, { error: "refresh-not-supported" });
					return;
				}
				json(res, 200, await deps.refresh());
				return;
			}
			if (action.action === "set-maximum-context-window") {
				if (deps.setMaximumContextWindow === void 0) {
					json(res, 404, { error: "context-window-setting-not-supported" });
					return;
				}
				json(res, 200, await deps.setMaximumContextWindow(action.enabled === true));
				return;
			}
			json(res, 200, await deps.probe(action.model));
		} catch (error) {
			json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
/** Mount the POST probe-control route on an optional webServer context. */
function registerQoderProbeRoute(ctx, deps, key) {
	const path = deps.path ?? "/plugins/dsh-qoder-connect/probe";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: qoderProbeHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-qoder-connect: probe control route");
}
//#endregion
//#region src/checkin-scheduler.ts
/** Scheduling and catch-up orchestration for daily 10:00 (UTC+8) check-in. */
var JsonFileCheckInStore = class {
	filePath;
	constructor(filePath) {
		this.filePath = filePath ?? join(qoderPluginDataDir(), "checkin-status.json");
	}
	readAll() {
		try {
			if (!existsSync(this.filePath)) return {};
			const raw = readFileSync(this.filePath, "utf-8");
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}
	read(variantId) {
		return this.readAll()[variantId];
	}
	clearLogs(variantId) {
		try {
			const all = this.readAll();
			if (all[variantId]) {
				all[variantId] = {
					...all[variantId],
					logs: []
				};
				mkdirSync(dirname(this.filePath), { recursive: true });
				writeFileSync(this.filePath, JSON.stringify(all, null, 2), "utf-8");
			}
		} catch {}
	}
	write(variantId, record) {
		try {
			const all = this.readAll();
			const existingLogs = all[variantId]?.logs ?? [];
			const newLog = {
				id: `${record.lastDate}-${record.lastAt}`,
				date: record.lastDate,
				timestamp: record.lastAt,
				status: record.status,
				...record.amount === void 0 ? {} : { amount: record.amount },
				...record.message === void 0 ? {} : { message: record.message }
			};
			const updatedLogs = [newLog, ...existingLogs.filter((l) => l.id !== newLog.id)].slice(0, 30);
			all[variantId] = {
				...record,
				logs: updatedLogs
			};
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(all, null, 2), "utf-8");
		} catch {}
	}
};
/**
* Returns the current date in YYYY-MM-DD standardized on UTC+8 (Beijing Time).
*/
function getUtc8DateString(nowMs = Date.now()) {
	const d = new Date(nowMs);
	const utc8 = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 6e4);
	return `${utc8.getFullYear()}-${String(utc8.getMonth() + 1).padStart(2, "0")}-${String(utc8.getDate()).padStart(2, "0")}`;
}
/**
* Calculates milliseconds until the next 10:00:05 AM in UTC+8.
*/
function msUntilNext10amUtc8(nowMs = Date.now()) {
	const d = new Date(nowMs);
	const utc8Time = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 6e4);
	const targetUtc8 = new Date(utc8Time.getTime());
	targetUtc8.setHours(10, 0, 5, 0);
	let diff = targetUtc8.getTime() - utc8Time.getTime();
	if (diff <= 0) {
		targetUtc8.setDate(targetUtc8.getDate() + 1);
		diff = targetUtc8.getTime() - utc8Time.getTime();
	}
	return diff;
}
/**
* Checks whether catch-up is needed today:
* Current time is past today's 10:00:00 AM (UTC+8) and today has not yet settled a check-in.
*/
function shouldCatchUp(today, lastDate, nowMs = Date.now()) {
	if (lastDate === today) return false;
	const d = new Date(nowMs);
	return new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 6e4).getHours() >= 10;
}
var CheckInScheduler = class {
	targets;
	isEnabled;
	store;
	onResult;
	now;
	timer;
	disposed = false;
	constructor(options) {
		this.targets = options.targets;
		this.isEnabled = options.isEnabled;
		this.store = options.store ?? new JsonFileCheckInStore();
		this.onResult = options.onResult;
		this.now = options.now ?? Date.now;
	}
	start() {
		if (this.disposed) return;
		this.sweepAll(true);
		this.armNextTimer();
	}
	dispose() {
		this.disposed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
	}
	armNextTimer() {
		if (this.disposed) return;
		const delay = msUntilNext10amUtc8(this.now());
		this.timer = setTimeout(() => {
			this.sweepAll(false);
			this.armNextTimer();
		}, delay);
		this.timer.unref?.();
	}
	async sweepAll(isCatchUp) {
		if (this.disposed) return;
		const nowMs = this.now();
		const today = getUtc8DateString(nowMs);
		for (const target of this.targets) {
			if (!this.isEnabled(target.variantId)) continue;
			const record = this.store.read(target.variantId);
			if (isCatchUp && !shouldCatchUp(today, record?.lastDate, nowMs)) continue;
			if (!isCatchUp && record?.lastDate === today && (record.status === "claimed" || record.status === "already-claimed")) continue;
			let pat;
			try {
				pat = await target.getPat();
			} catch {
				continue;
			}
			if (!pat) continue;
			try {
				const result = await target.service.checkIn(pat);
				if (result.status !== "error") {
					this.store.write(target.variantId, {
						lastDate: result.date,
						lastAt: result.timestamp,
						status: result.status,
						amount: result.amount,
						message: result.message
					});
					if (result.status === "claimed") target.onClaimed?.();
				}
				this.onResult?.(result);
			} catch {}
		}
	}
};
//#endregion
//#region src/job-token-hint.ts
/** The name recorded on the hint row (and therefore its displayed title). */
const JOB_TOKEN_HINT_NAME = "qoder";
/** Refresh time per agent id, so a later read can name when it happened. */
const lastRefreshAt = /* @__PURE__ */ new Map();
/** The most recent agent observed entering a running turn. */
let lastRunningAgent;
/** Monotonic suffix keeping appended ids unique within this process. */
let hintSeq = 0;
/**
* Start tracking which agent is running.
*
* `agent/status` is a plain `emit` event: a listener that returns nothing
* cannot disturb the emitting path (unlike a waterfall event, where a listener
* owes the chain its `next()` call). The self-heal fires inside that agent's
* request, so the most recently running agent is the conversation to print
* into.
*/
function installJobTokenHint(ctx) {
	ctx.on("agent/status", ((payload) => {
		if (payload.status === "running" && payload.agent !== void 0) lastRunningAgent = payload.agent;
	}));
}
/**
* Print the refresh row into the conversation whose request triggered it.
*
* Best effort by design: a missing agent, an absent session, or a projection
* that rejects the append must never affect the chat that just recovered.
*
* @param at - When the job token was rotated.
* @param text - The row's summary line.
*/
function emitJobTokenHint(at, text) {
	const agent = lastRunningAgent;
	if (agent?.session === void 0) return;
	lastRefreshAt.set(String(agent.id), at);
	appendHintRow(agent, "success", text);
}
/**
* Print the failed-heal row into the conversation whose request triggered it.
*
* The mirror of {@link emitJobTokenHint}: the self-heal ran, exchanged a fresh
* job token, retried, and the upstream still refused. Without this row that
* outcome was silent — the user saw only the resulting authorization failure
* and could not tell that recovery had already been attempted and lost.
*
* Rate limited by the transport (once per unresolved outage), not here: this
* module stays a pure printer so the dedupe policy lives with the state that
* knows when an outage ends.
*
* @param at - When the failed heal was recorded.
* @param text - The row's summary line.
*/
function emitJobTokenRefreshFailedHint(at, text) {
	const agent = lastRunningAgent;
	if (agent?.session === void 0) return;
	appendHintRow(agent, "error", text);
}
/** Append one log-only command pair carrying `text` as its outcome. */
function appendHintRow(agent, kind, text) {
	const session = agent.session;
	if (session === void 0) return;
	const commandId = `cmd-qoder-hint-${Date.now().toString(36)}-${++hintSeq}`;
	try {
		session.append("command/run", {
			commandId,
			name: JOB_TOKEN_HINT_NAME,
			source: { kind: "user" }
		});
		session.append("command/done", {
			commandId,
			kind,
			text
		});
	} catch {}
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "llm-qoder";
/** The model registry required before the provider can register. */
const inject = ["llm"];
/**
* Settings namespace owning the China card's section.
*
* DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
* now a nominal string, validated by the type system where it is used rather
* than at runtime by a function call. The brand is compile-time only, so this
* stays the plain string it always was — every comparison, descriptor lookup,
* and `dsh` config file still sees `'qoder'`. It is cast once here so the
* public constant carries the seam's type without pulling the brand helper
* into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
* their namespaces as plain string literals).
*/
const QODER_SETTINGS_NS = "qoder";
/**
* Settings namespace owning the global card's section.
*
* One namespace per card, not one shared: the settings Plugins tab dispatches a
* card by rendering `settings.plugin.item` with `entryKey = ns` for each
* namespace the Host serves, and skips an entry whose key names no served
* namespace. With a single installed section, the global card registers
* into the slot but is never rendered — the card list is built from the Host's
* sections, not from the slot's entries. Each card therefore needs its own
* installed section whose namespace equals the card's slot key.
*/
const QODER_GLOBAL_SETTINGS_NS = "qoder-global";
/**
* Settings namespace owning the shared quota-card section.
*
* One card above the two variant cards configures both sidebar quota widgets
* (China and global) from a single place, so its toggles cannot live in
* either variant's section — they are per-variant fields on a cross-variant
* card. The Plugins tab dispatches by namespace, so this section is what makes
* that card render (see {@link QODER_GLOBAL_SETTINGS_NS} for the mechanism).
*/
const QODER_QUOTA_SETTINGS_NS = "qoder-quota";
/**
* How often the credential files are re-checked, in milliseconds.
*
* A startup-only catalog fetch cannot notice a token saved while DSH is
* already running, so the model group would not appear until a restart. This
* poll is a cheap existence/parse read of at most a few local files: it never
* contacts the network and never runs a reasoning probe.
*
* `DSH_QODER_POLL_MS` overrides it. That exists so the sweep can be
* exercised end to end in tests and shortened while diagnosing a slow
* sign-in on a real machine; it is not a product setting and no UI exposes it.
* The value is clamped to a sane range so a mistaken override cannot turn the
* poll into a busy loop.
*/
const CREDENTIAL_POLL_MS = 3e4;
/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 864e5;
/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs() {
	const override = Number(process.env["DSH_QODER_POLL_MS"]);
	if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS;
	return Math.min(override, MAX_POLL_MS);
}
/**
* How long to wait before retrying a catalog fetch that failed.
*
* The credential sweep deliberately does not re-fetch a catalog it already has
* (the same token carries no new model information). But a *failed* fetch must
* not be treated the same way: without a retry, one transient network blip at
* startup would leave the group on the built-in fallback roster until the user
* noticed and pressed refresh. This bound keeps that recovery automatic while
* still honoring the "not every round" rule — at most one attempt per
* interval, and none at all once a live catalog lands.
*
* Expressed as a multiple of the sweep rather than a fixed duration so the two
* stay in proportion under the `DSH_QODER_POLL_MS` override.
*/
const CATALOG_RETRY_SWEEPS = 10;
/** Probe authorization (shared by the plugin schema and the China section). */
const PROBE_CONSENT_FIELD = z.boolean().default(false).description("Authorize reasoning-effort probes (each probe sends real requests that may consume credit)");
const MAXIMUM_CONTEXT_WINDOW_FIELD = z.boolean().default(true).description("Use the largest context window declared by Qoder Global when alternatives are available (on by default)");
/** The China variant's own maximum-window preference. */
const MAXIMUM_CONTEXT_WINDOW_CN_FIELD = z.boolean().default(true).description("Use the largest context window declared by Qoder (China) when alternatives are available (on by default)");
/**
* Per-model window overrides (model id → tokens). The card writes one entry
* per selector change; the field is optional so an absent map means "no
* overrides" rather than a default object the host must keep in sync.
*/
const MODEL_CONTEXT_WINDOWS_FIELD = z.dict(z.number().min(1), z.string()).description("Per-model context-window overrides for Qoder Global (model id → tokens)");
/** Sidebar quota toggle (one per variant; both live on the shared quota card). */
const QUOTA_TOGGLE_FIELD = z.boolean().default(false).description("Show this variant’s remaining-credit card in the sidebar footer (off by default)");
/** Automatic check-in toggle. */
const AUTO_CHECK_IN_FIELD = z.boolean().default(false).description("每天 10:00 (UTC+8) 自动签到领取算力额度（默认关闭）");
/**
* Quota poll interval: default 5 minutes, floor 1 minute. The status route
* performs a live upstream billing call per request with no cache, so an
* aggressively small interval translates directly into upstream load; the
* floor is the smallest value the UI offers rather than a silent clamp —
* smaller staged values fail Host validation and refuse to save.
*/
const QUOTA_POLL_DEFAULT_MS = 3e5;
const QUOTA_POLL_MIN_MS = 6e4;
const QUOTA_POLL_FIELD = z.number().default(QUOTA_POLL_DEFAULT_MS).min(QUOTA_POLL_MIN_MS).description("Sidebar quota card refresh interval in milliseconds (default 300000, minimum 60000)");
const Config = z.object({
	probeConsent: PROBE_CONSENT_FIELD,
	useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
	useMaximumContextWindowCN: MAXIMUM_CONTEXT_WINDOW_CN_FIELD,
	modelContextWindows: MODEL_CONTEXT_WINDOWS_FIELD,
	modelContextWindowsCN: MODEL_CONTEXT_WINDOWS_FIELD,
	sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
	sidebarQuotaGlobal: QUOTA_TOGGLE_FIELD,
	autoCheckInCN: AUTO_CHECK_IN_FIELD,
	autoCheckInGlobal: AUTO_CHECK_IN_FIELD,
	quotaPollMs: QUOTA_POLL_FIELD
});
/**
* The China card's settings section: only the fields that card edits.
*
* A section is what makes its namespace "served", which is what the Plugins
* tab dispatches a card by — so the schema and the card must stay split the
* same way. `probeConsent` lives here because it predates the second variant;
* it gates no current code path (only manual, per-click-confirmed probes run),
* so it is left where existing users set it rather than moved and re-asked.
*/
const CHINA_SECTION = z.object({
	probeConsent: PROBE_CONSENT_FIELD,
	useMaximumContextWindowCN: MAXIMUM_CONTEXT_WINDOW_CN_FIELD,
	modelContextWindowsCN: MODEL_CONTEXT_WINDOWS_FIELD
});
/** The global card's settings section and its context-window preferences. */
const GLOBAL_SECTION = z.object({
	useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
	modelContextWindows: MODEL_CONTEXT_WINDOWS_FIELD
});
/**
* The shared quota card's section: both sidebar toggles and the poll interval.
*
* Only these fields — the card edits nothing else, and the Plugins tab pairs a
* card with the section whose namespace it names, so a stray field here would
* render as a control no other surface reads.
*/
const QUOTA_SECTION = z.object({
	sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
	sidebarQuotaGlobal: QUOTA_TOGGLE_FIELD,
	autoCheckInCN: AUTO_CHECK_IN_FIELD,
	autoCheckInGlobal: AUTO_CHECK_IN_FIELD,
	quotaPollMs: QUOTA_POLL_FIELD
});
/** Stable identity key used by credentials, probe records, and catalog entries. */
const credentialIdentity = qoderCredentialIdentity;
/** The settings namespace a variant's card and provider directory entry use. */
function settingsNamespaceFor(variant) {
	return variant.id === CHINA_VARIANT.id ? QODER_SETTINGS_NS : QODER_GLOBAL_SETTINGS_NS;
}
/**
* The static catalog a variant serves before its first successful fetch.
*
* Both regions share one roster transcribed from the transport's built-in
* model defaults: unlike the WorkBuddy-era endpoints, the Qoder pools are
* region-specific only in what discovery lists, and inventing a second roster
* from nothing would misdescribe whichever variant it was not captured from.
*/
function fallbackFor(_variant) {
	return FALLBACK_QODER_MODELS;
}
/**
* The hint row's summary line: what happened, and when.
*
* Named here rather than in the hint module because the text is this plugin's
* user-facing wording, and the transport callback that produces it runs before
* the plugin's own scope exists.
*/
function jobTokenHintText(at) {
	return `jobToken 已自动刷新（${new Date(at).toLocaleTimeString("zh-CN", { hour12: false })}）— 旧令牌被上游拒绝，已自动重换并恢复`;
}
/**
* The failed-heal row's summary line.
*
* Deliberately does not name a cause: the upstream rejection that survived a
* fresh token is not necessarily an authorization problem at all, and the real
* reason travels in the failure message itself (see the SSE envelope body).
* Claiming "quota" or "revoked" here would be a guess presented as a finding.
*/
function jobTokenRefreshFailedHintText(at) {
	return `jobToken 已重换但仍被上游拒绝（${new Date(at).toLocaleTimeString("zh-CN", { hour12: false })}）— 自愈未恢复，请查看上方错误详情`;
}
/** Build one variant's stores, transport, and probe state. */
function createVariantRuntime(ctx, config, variant, current, identityOf) {
	const store = new QoderCredentialStore({
		variant,
		logger: ctx.logger
	});
	let jobTokenRefreshedAt;
	const transport = createQoderTransport({
		region: variant.region,
		resolvePat: () => store.patPromise(),
		resolveMachineId: () => getMachineId([qoderMachineIdPath()]),
		onJobTokenRefreshed: (info) => {
			jobTokenRefreshedAt = info.at;
			ctx.logger.warn(`dsh-qoder-connect: ${variant.displayName} job token was auto-refreshed after an upstream rejection`);
			emitJobTokenHint(info.at, jobTokenHintText(info.at));
		},
		onJobTokenRefreshFailed: (info) => {
			ctx.logger.warn(`dsh-qoder-connect: ${variant.displayName} job token refresh did not recover the chat (upstream status ${info.status ?? "unknown"})`);
			emitJobTokenRefreshFailedHint(info.at, jobTokenRefreshFailedHintText(info.at));
		}
	});
	const client = new QoderUpstreamClient({
		region: variant.region,
		providerId: variant.id,
		getPat: () => store.patPromise(),
		transport,
		attachments: { saveImage: async (request) => {
			const service = ctx.get("attachments");
			if (service === void 0) throw new Error("dsh-qoder-connect: no attachment service is available to store images");
			return await service.saveImage(request);
		} }
	});
	const fallback = fallbackFor(variant);
	const catalog = new QoderCatalog(fallback);
	if (variant.id !== CHINA_VARIANT.id) catalog.setUseMaximumContextWindow(config.useMaximumContextWindow === true);
	else {
		catalog.setUseMaximumContextWindow(config.useMaximumContextWindowCN === true);
		if (config.modelContextWindowsCN !== void 0) catalog.setModelContextWindows(config.modelContextWindowsCN);
	}
	catalog.setVisible(false);
	const probeStore = new QoderProbeStore({
		pluginVersion: QODER_CONNECT_VERSION,
		path: qoderProbePath(variant.probeFilename)
	});
	const savedCatalogs = new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) });
	return {
		variant,
		store,
		client,
		transport,
		catalog,
		probeStore,
		probeService: new QoderProbeService({
			store: probeStore,
			catalog,
			credentials: store,
			client,
			consent: () => current().probeConsent === true,
			account: () => identityOf(variant.id)
		}),
		savedCatalogs,
		fallback,
		catalogSource: "fallback",
		catalogFetchedAtMs: void 0,
		catalogError: void 0,
		lastFetchAtMs: 0,
		catalogGeneration: 0,
		inflightFetch: void 0,
		invalidate: () => {},
		registered: false,
		jobTokenRefreshedAt: () => jobTokenRefreshedAt
	};
}
/** The catalog provenance the card displays. */
function catalogSection(runtime) {
	return {
		source: runtime.catalogSource,
		...runtime.catalogFetchedAtMs === void 0 ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
		...runtime.catalogError === void 0 ? {} : { error: runtime.catalogError }
	};
}
/**
* Whether a model can be probed by hand: it reasons and the upstream declares
* no effort set for it.
*
* Deliberately *not* filtered by whether a result already exists. Dropping a
* model once it has been detected made the list shrink with use, so
* re-detecting one model — after an upstream change, say — meant clearing every
* other result first. The list stays stable and the card marks which entries
* already have an answer.
*/
function isProbeCandidate(info) {
	if (info.reasoning?.supports !== true) return false;
	return (info.reasoning.supportedEfforts?.length ?? 0) === 0;
}
/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime, consent) {
	const models = runtime.catalog.current();
	const results = models.flatMap((info) => {
		const record = runtime.probeService.recordFor(info.id);
		if (record === void 0) return [];
		return [{
			id: info.id,
			name: info.name,
			validation: record.validation,
			efforts: record.efforts,
			probedAt: record.probedAtMs
		}];
	});
	return {
		consent,
		running: runtime.probeService.isRunning(),
		candidates: models.filter(isProbeCandidate).map((info) => info.id),
		results: newestFirst(results)
	};
}
/**
* Run a detached promise without letting its failure kill the host.
*
* Node terminates the whole process on an unhandled rejection (exit code 1),
* which the desktop shell reports as the backend having "exited unexpectedly"
* — so a failing heartbeat write, loopback close, or background sweep in this
* plugin would take the entire Harness down with it. Every fire-and-forget
* call therefore carries a handler; a failure is a diagnostic, never a reason
* for the host to die.
*/
function detach(ctx, work, what) {
	work.catch((error) => {
		ctx.logger.warn(`dsh-qoder-connect: ${what} failed`, error);
	});
}
/**
* Start one variant: its loopback endpoint, provider registration, and
* configuration-card wiring.
*
* Registration waits for the shim to hold a port, because the provider's
* models read the shim origin at construction time. A failure here is
* contained to this variant: the caller logs it and the other keeps working.
*
* @returns whether the provider registered.
*/
async function startVariant(ctx, runtime) {
	const { variant, store, client, catalog, probeService } = runtime;
	const shim = createQoderShim({
		store,
		client,
		catalog,
		providerId: variant.id,
		logger: ctx.logger
	});
	try {
		await shim.ready;
	} catch (error) {
		ctx.logger.error(`dsh-qoder-connect: ${variant.displayName} loopback endpoint failed to start`, error);
		return false;
	}
	try {
		const qoder = createQoderAdapter({
			providerId: variant.id,
			displayName: variant.displayName,
			shim,
			store,
			catalog,
			resolveAttachments: () => ctx.get("attachments"),
			observe: (modelId) => probeService.recordFor(modelId)
		});
		runtime.invalidate = () => {
			qoder.invalidate();
			ctx.emit("llm/adapters-updated");
		};
		let releaseAdapter;
		let releaseDirectory;
		try {
			releaseAdapter = ctx.llm.registerAdapter([variant.id], qoder.adapter);
			releaseDirectory = ctx.llm.registerConfigurableProviders([{
				provider: variant.id,
				displayName: variant.displayName,
				settingsNs: settingsNamespaceFor(variant),
				settingsPath: [],
				declared: false
			}]);
		} finally {
			if (releaseAdapter === void 0 || releaseDirectory === void 0) {
				releaseAdapter?.();
				releaseDirectory?.();
			}
		}
		try {
			ctx.effect(() => () => {
				releaseAdapter?.();
				releaseDirectory?.();
				detach(ctx, shim.close(), "loopback endpoint close");
			});
		} catch {
			releaseAdapter?.();
			releaseDirectory?.();
			detach(ctx, shim.close(), "loopback endpoint close");
		}
		runtime.registered = true;
		return true;
	} catch (error) {
		ctx.logger.error(`dsh-qoder-connect: ${variant.displayName} provider registration failed`, error);
		detach(ctx, shim.close(), "loopback endpoint close");
		return false;
	}
}
/**
* Start both variants: their loopback endpoints, the `qoder` and
* `qoder-global` providers, their configuration cards, and their
* credential-driven catalog lifecycles.
*
* Each variant registers unconditionally; what varies is whether its catalog is
* *visible*. An empty catalog is how DSH hides a model group (the host filters
* out groups with no models), which keeps a token saved after startup working
* without re-registering the provider.
*/
function apply(ctx, config) {
	let current = () => config;
	/** Timers and in-flight work belonging to this plugin instance. */
	let stopped = false;
	const timers = [];
	/**
	* The account identity each variant last published a catalog for. Keeps a
	* same-token sweep from re-fetching, and lets a late response from a
	* previous identity be discarded instead of overwriting a newer one.
	*/
	const lastIdentities = /* @__PURE__ */ new Map();
	const runtimes = QODER_VARIANTS.map((variant) => createVariantRuntime(ctx, config, variant, () => current(), (id) => lastIdentities.get(id)));
	const checkInStore = new JsonFileCheckInStore();
	const checkInScheduler = new CheckInScheduler({
		targets: runtimes.map((runtime) => ({
			variantId: runtime.variant.id,
			service: runtime.transport.checkInService,
			getPat: async () => runtime.store.patPromise(),
			onClaimed: () => {
				runtime.client.fetchCredits().catch(() => void 0);
			}
		})),
		isEnabled: (variantId) => {
			const cfg = current();
			if (variantId === CHINA_VARIANT.id) return cfg.autoCheckInCN === true;
			return cfg.autoCheckInGlobal === true;
		},
		store: checkInStore
	});
	checkInScheduler.start();
	installJobTokenHint(ctx);
	const probeKey = createProbeKey();
	/**
	* The in-process key authorizing PAT writes, minted separately from the
	* probe key.
	*
	* Separate keys rather than one shared secret because the two authorize
	* different powers: one spends credit on a probe, the other stores a
	* credential. A single key handed to both would let a defect in either card
	* reach the other's authority.
	*/
	const authKey = createAuthKey();
	let setMaximumContextWindow;
	let setMaximumContextWindowCN;
	/**
	* Point a variant at an account identity, invalidating whatever the previous
	* one left behind.
	*
	* One helper for all four transitions (sweep sign-in, sweep sign-out, manual
	* refresh, card save) because each of them used to do its own partial
	* version, and the manual path forgot pieces the sweep did. Every transition
	* bumps {@link VariantRuntime.catalogGeneration}, which is what makes an
	* in-flight request from before the change refuse to write back.
	*
	* Probe observations are dropped whenever the account actually changes —
	* including sign-out, and including the "signed out, then in as someone else"
	* sequence that used to look like a first sighting and let the new account
	* inherit the old one's detected levels. They are deliberately NOT cleared on
	* a first sign-in: no previous account's data could leak there, and clearing
	* would delete records this very account owns (written before a restart, or
	* seeded while all of this is running).
	*
	* @param identity - the account now in effect, or `undefined` when signed out.
	*/
	const adoptIdentity = (runtime, identity) => {
		const id = runtime.variant.id;
		const known = lastIdentities.get(id);
		if (known === identity) return;
		const hadCredential = known !== void 0;
		if (identity === void 0) lastIdentities.delete(id);
		else lastIdentities.set(id, identity);
		runtime.catalogGeneration += 1;
		runtime.inflightFetch?.controller.abort();
		runtime.inflightFetch = void 0;
		if (hadCredential && known !== identity) {
			runtime.probeStore.clear();
			runtime.invalidate();
		}
		if (identity === void 0) {
			if (known !== void 0) runtime.savedCatalogs.delete(known);
			runtime.catalog.set(runtime.fallback);
			runtime.catalogSource = "fallback";
			runtime.catalogFetchedAtMs = void 0;
			runtime.catalogError = void 0;
			if (runtime.catalog.setVisible(false)) runtime.invalidate();
			return;
		}
		const saved = runtime.savedCatalogs.get(identity);
		if (saved !== void 0) {
			runtime.catalog.set([...saved.models]);
			runtime.catalogSource = "saved";
			runtime.catalogFetchedAtMs = saved.fetchedAtMs;
		} else {
			runtime.catalog.set(runtime.fallback);
			runtime.catalogSource = "fallback";
			runtime.catalogFetchedAtMs = void 0;
		}
		runtime.catalogError = void 0;
		runtime.catalog.setVisible(true);
		runtime.invalidate();
	};
	ctx.inject(["webServer"], (webCtx) => {
		for (const runtime of runtimes) {
			registerQoderStatusRoute(webCtx, {
				path: runtime.variant.statusPath,
				store: runtime.store,
				client: runtime.client,
				models: () => runtime.catalog.current(),
				catalog: () => catalogSection(runtime),
				probe: () => probeSection(runtime, current().probeConsent === true),
				probeKey,
				authKey,
				...runtime.variant.id === CHINA_VARIANT.id ? { useMaximumContextWindow: () => current().useMaximumContextWindowCN === true } : { useMaximumContextWindow: () => current().useMaximumContextWindow === true },
				jobTokenRefreshedAt: runtime.jobTokenRefreshedAt,
				checkIn: () => checkInStore.read(runtime.variant.id)
			});
			registerQoderAuthRoute(webCtx, {
				path: runtime.variant.authPath,
				save: async (pat) => {
					if (!await validateApiKey(pat, runtime.variant.region)) return {
						ok: false,
						error: "qoder_invalid_pat"
					};
					const credential = await runtime.store.save(pat);
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity);
					await fetchCatalog(runtime, identity);
					return {
						ok: true,
						status: await runtime.store.status()
					};
				},
				clear: async () => {
					await runtime.store.clear();
					adoptIdentity(runtime, void 0);
				}
			}, authKey);
			registerQoderProbeRoute(webCtx, {
				path: runtime.variant.probePath,
				probe: async (modelId) => {
					const result = await runtime.probeService.probe(modelId, true);
					if (result.state === "ok") runtime.invalidate();
					return result;
				},
				clear: () => {
					runtime.probeStore.clear();
					runtime.invalidate();
				},
				refresh: async () => {
					if (stopped) return {
						state: "failed",
						reason: "plugin is stopping"
					};
					let credential;
					try {
						credential = await runtime.store.current();
					} catch (error) {
						return {
							state: "failed",
							reason: error instanceof Error ? error.message.slice(0, 300) : String(error)
						};
					}
					if (credential === void 0) {
						adoptIdentity(runtime, void 0);
						return { state: "signed-out" };
					}
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity);
					await fetchCatalog(runtime, identity);
					return runtime.catalogError === void 0 ? {
						state: "refreshed",
						reason: `${runtime.catalog.current().length} models`
					} : {
						state: "failed",
						reason: runtime.catalogError
					};
				},
				clearCheckInLogs: () => {
					checkInStore.clearLogs(runtime.variant.id);
				},
				checkIn: async () => {
					let pat;
					try {
						pat = await runtime.store.patPromise();
					} catch {
						return {
							state: "failed",
							reason: "No PAT available"
						};
					}
					const result = await runtime.transport.checkInService.checkIn(pat);
					if (result.status !== "error") {
						checkInStore.write(runtime.variant.id, {
							lastDate: result.date,
							lastAt: result.timestamp,
							status: result.status,
							...result.amount === void 0 ? {} : { amount: result.amount },
							...result.message === void 0 ? {} : { message: result.message }
						});
						if (result.status === "claimed") runtime.client.fetchCredits().catch(() => void 0);
					}
					return {
						state: result.status,
						...result.amount === void 0 ? {} : { amount: result.amount },
						...result.message === void 0 ? {} : { reason: result.message }
					};
				},
				...runtime.variant.id === CHINA_VARIANT.id ? { setMaximumContextWindow: async (enabled) => {
					if (setMaximumContextWindowCN === void 0) return {
						state: "failed",
						reason: "settings are unavailable"
					};
					return setMaximumContextWindowCN(enabled);
				} } : { setMaximumContextWindow: async (enabled) => {
					if (setMaximumContextWindow === void 0) return {
						state: "failed",
						reason: "settings are unavailable"
					};
					return setMaximumContextWindow(enabled);
				} }
			}, probeKey);
		}
	});
	ctx.inject(["settings"], (settingsCtx) => {
		/** Section sources; each falls back to its own slice when its side unloads. */
		const sources = {
			cn: () => config,
			global: () => config,
			quota: () => config
		};
		/** Merge all sections into the whole config the rest of the plugin reads. */
		const merged = () => ({
			...sources.cn().probeConsent === void 0 ? {} : { probeConsent: sources.cn().probeConsent },
			...sources.cn().useMaximumContextWindowCN === void 0 ? {} : { useMaximumContextWindowCN: sources.cn().useMaximumContextWindowCN },
			...sources.cn().modelContextWindowsCN === void 0 ? {} : { modelContextWindowsCN: sources.cn().modelContextWindowsCN },
			...sources.global().useMaximumContextWindow === void 0 ? {} : { useMaximumContextWindow: sources.global().useMaximumContextWindow },
			...sources.global().modelContextWindows === void 0 ? {} : { modelContextWindows: sources.global().modelContextWindows },
			...sources.quota().sidebarQuotaCN === void 0 ? {} : { sidebarQuotaCN: sources.quota().sidebarQuotaCN },
			...sources.quota().sidebarQuotaGlobal === void 0 ? {} : { sidebarQuotaGlobal: sources.quota().sidebarQuotaGlobal },
			...sources.quota().quotaPollMs === void 0 ? {} : { quotaPollMs: sources.quota().quotaPollMs }
		});
		const applyMaximumContextWindow = (next) => {
			let changed = false;
			for (const runtime of runtimes) {
				const isChina = runtime.variant.id === CHINA_VARIANT.id;
				const preference = isChina ? next.useMaximumContextWindowCN : next.useMaximumContextWindow;
				if (runtime.catalog.setUseMaximumContextWindow(preference === true)) changed = true;
				const overrides = isChina ? next.modelContextWindowsCN : next.modelContextWindows;
				if (overrides !== void 0 && runtime.catalog.setModelContextWindows(overrides)) changed = true;
			}
			if (changed) for (const runtime of runtimes) runtime.invalidate();
		};
		const repointStores = () => {
			applyMaximumContextWindow(merged());
		};
		settingsCtx.settings.installSection(ctx, QODER_SETTINGS_NS, CHINA_SECTION, config, {
			setSource(source) {
				sources.cn = source;
				current = merged;
			},
			onChange: repointStores
		});
		settingsCtx.settings.installSection(ctx, QODER_GLOBAL_SETTINGS_NS, GLOBAL_SECTION, config, {
			setSource(source) {
				sources.global = source;
				current = merged;
			},
			onChange: repointStores
		});
		settingsCtx.settings.installSection(ctx, QODER_QUOTA_SETTINGS_NS, QUOTA_SECTION, config, {
			setSource(source) {
				sources.quota = source;
				current = merged;
			},
			onChange: () => {}
		});
		setMaximumContextWindow = async (enabled) => {
			await settingsCtx.settings.update(QODER_GLOBAL_SETTINGS_NS, { useMaximumContextWindow: enabled });
			return { state: "updated" };
		};
		setMaximumContextWindowCN = async (enabled) => {
			await settingsCtx.settings.update(QODER_SETTINGS_NS, { useMaximumContextWindowCN: enabled });
			return { state: "updated" };
		};
	});
	ctx.effect(() => () => {
		stopped = true;
		checkInScheduler.dispose();
		for (const timer of timers) clearInterval(timer);
		timers.length = 0;
		detach(ctx, clearHostHeartbeat(), "host heartbeat cleanup");
	});
	/**
	* Fetch one variant's catalog for the current credential.
	*
	* Shared by the credential sweep and the card's manual refresh, and written
	* so that concurrent callers cost one request and cannot interleave badly:
	*
	* - **One request at a time.** A second caller joins the in-flight fetch
	*   instead of starting its own (spec §5: one catalog request per variant at
	*   a time).
	* - **Generation-checked write-back.** The request records the generation it
	*   started under and writes nothing if the generation moved on — which is
	*   what a slow answer from a superseded account must not do. Checking only
	*   the *identity* was not enough: two refreshes for the same account can
	*   still finish out of order, and the older one would win.
	* - **`resolve()`, not `current()`.** A catalog fetch demands a usable token;
	*   the difference from `current()` is that its absence surfaces as the same
	*   classified `MISSING_CREDENTIAL` failure every other request path reports,
	*   rather than as a silent "no credential" that would hide a bad file on
	*   disk behind an env override.
	*/
	const fetchCatalog = async (runtime, identity) => {
		const inflight = runtime.inflightFetch;
		const generation = runtime.catalogGeneration;
		if (inflight !== void 0 && inflight.identity === identity && inflight.generation === generation) return inflight.promise;
		inflight?.controller.abort();
		const controller = new AbortController();
		let run;
		run = (async () => {
			let models;
			try {
				const credential = await runtime.store.resolve();
				const resolvedIdentity = credentialIdentity(credential);
				if (resolvedIdentity !== identity) {
					adoptIdentity(runtime, resolvedIdentity);
					await fetchCatalog(runtime, resolvedIdentity);
					return;
				}
				models = await runtime.client.fetchModels(controller.signal);
				const latest = await runtime.store.current();
				const latestIdentity = latest === void 0 ? void 0 : credentialIdentity(latest);
				if (latestIdentity !== identity) {
					adoptIdentity(runtime, latestIdentity);
					if (latestIdentity !== void 0) await fetchCatalog(runtime, latestIdentity);
					return;
				}
			} catch (error) {
				if (stopped || runtime.catalogGeneration !== generation) return;
				runtime.lastFetchAtMs = Date.now();
				runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error);
				ctx.logger.warn(`dsh-qoder-connect: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`, error);
				runtime.invalidate();
				return;
			}
			if (stopped || runtime.catalogGeneration !== generation) return;
			runtime.lastFetchAtMs = Date.now();
			runtime.catalog.set([...models]);
			runtime.catalogSource = "live";
			runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now();
			runtime.catalogError = void 0;
			if (lastIdentities.get(runtime.variant.id) === identity) try {
				runtime.savedCatalogs.set(identity, {
					source: runtime.client.lastCatalog?.source ?? "unknown",
					fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
					models: [...models]
				});
			} catch (error) {
				ctx.logger.warn(`dsh-qoder-connect: ${runtime.variant.displayName} catalog could not be saved for this account`, error);
			}
			runtime.invalidate();
		})().finally(() => {
			if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = void 0;
		});
		runtime.inflightFetch = {
			identity,
			generation,
			controller,
			promise: run
		};
		return run;
	};
	/**
	* Reconcile one variant with its credentials.
	*
	* Four transitions matter, and each is a different action:
	*
	* - **none → some** (first sighting): reveal the group and fetch a catalog.
	* - **none → some, identity changed**: additionally drop the previous
	*   account's observations, so another token's probe answers cannot be read
	*   as the new one's.
	* - **some → none**: hide the group and stop serving its models.
	* - **same identity**: nothing to do — a PAT neither rotates nor expires, so
	*   re-fetching on every sweep would hit the catalog endpoint for no new
	*   information.
	*/
	const syncVariant = async (runtime) => {
		if (stopped || !runtime.registered) return;
		const credential = await runtime.store.current().catch((error) => {
			ctx.logger.warn(`dsh-qoder-connect: ${runtime.variant.displayName} credential read failed`, error);
		});
		if (stopped) return;
		if (credential === void 0) {
			adoptIdentity(runtime, void 0);
			return;
		}
		const identity = credentialIdentity(credential);
		if (lastIdentities.get(runtime.variant.id) === identity && runtime.catalog.isVisible()) {
			const stale = runtime.catalogSource !== "live";
			const due = Date.now() - runtime.lastFetchAtMs >= credentialPollMs() * CATALOG_RETRY_SWEEPS;
			if (stale && due) await fetchCatalog(runtime, identity);
			return;
		}
		adoptIdentity(runtime, identity);
		await fetchCatalog(runtime, identity);
	};
	/** Run one reconcile sweep across both variants. */
	const syncAll = async () => {
		for (const runtime of runtimes) await syncVariant(runtime);
	};
	/**
	* Start both variants, then begin the credential sweep.
	*
	* The chain carries its own failure handler: without one, a rejection here
	* would be an unhandled rejection — which Node turns into process
	* termination, taking the whole Harness down over one plugin's startup.
	*/
	detach(ctx, Promise.all(runtimes.map(async (runtime) => startVariant(ctx, runtime))).then(() => {
		if (stopped) return;
		if (runtimes.some((runtime) => runtime.registered)) detach(ctx, writeHostHeartbeat(), "host heartbeat write");
		detach(ctx, syncAll(), "credential sweep");
		const timer = setInterval(() => {
			detach(ctx, syncAll(), "credential sweep");
		}, credentialPollMs());
		timer.unref?.();
		timers.push(timer);
	}), "variant startup");
}
//#endregion
export { CHINA_VARIANT, Config, FALLBACK_QODER_MODELS, GLOBAL_VARIANT, KIND_STATUS, PROBE_EFFORT_CANDIDATES, QODER_AUTH_FILENAME, QODER_AUTH_PATH, QODER_DATA_DIR_ENV, QODER_DATA_DIR_NAME, QODER_GLOBAL_AUTH_PATH, QODER_GLOBAL_PROBE_PATH, QODER_GLOBAL_SETTINGS_NS, QODER_GLOBAL_STATUS_PATH, QODER_HOST_HEARTBEAT_FILENAME, QODER_PAT_ENV_CN, QODER_PAT_ENV_GLOBAL, QODER_PROBE_FILENAME, QODER_PROBE_PATH, QODER_PROVIDER, QODER_QUOTA_SETTINGS_NS, QODER_SETTINGS_NS, QODER_STATUS_PATH, QODER_STREAM_IDLE_TIMEOUT_MS, QODER_VARIANTS, QUOTA_POLL_DEFAULT_MS, QUOTA_POLL_MIN_MS, QoderCatalog, QoderCatalogStore, QoderCredentialStore, QoderProbeService, QoderProbeStore, QoderUpstreamClient, apply, classifyUpstreamError, clearHostHeartbeat, createAuthKey, createQoderAdapter, createQoderShim, fingerprintModel, inject, isHeartbeatProcessAlive, kindFromQoderFailure, modelInfoOf, name, normalizeCredits, patTail, probeModel, processStartTimeMs, qoderAuthHandler, qoderCatalogPath, qoderCredentialIdentity, qoderHostHeartbeatPath, qoderOwnAuthPath, qoderPluginDataDir, qoderProbePath, randomSentinel, readHostHeartbeat, registerQoderAuthRoute, variantFor };
