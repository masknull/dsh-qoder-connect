import { $ as configurePluginPaths, A as probeModel, B as QODER_PROBE_PATH, C as validateApiKey, D as utc8WallClock, E as formatUtc8Date, F as QoderCatalog, G as QODER_PAT_ENV_GLOBAL, H as QODER_STATUS_PATH, I as QODER_AUTH_PATH, J as qoderCredentialId, K as QoderCredentialStore, L as QODER_GLOBAL_AUTH_PATH, M as QoderCatalogStore, N as qoderCatalogPath, O as getMachineId, P as FALLBACK_QODER_MODELS, Q as QODER_DATA_DIR_NAME, R as QODER_GLOBAL_PROBE_PATH, S as normalizeCredits, T as defaultStreamIdleTimeoutMs, U as QODER_AUTH_FILENAME, V as QODER_SETTINGS_FACE_PATH, W as QODER_PAT_ENV_CN, X as qoderOwnAuthPath, Y as qoderCredentialIdentity, Z as QODER_DATA_DIR_ENV, _ as KIND_STATUS, a as QODER_HOST_HEARTBEAT_FILENAME, b as kindFromQoderFailure, c as qoderHostHeartbeatPath, d as QODER_CONNECT_VERSION, et as qoderMachineIdPath, f as QODER_PROBE_FILENAME, g as qoderProbePath, h as newestFirst, i as variantFor, j as randomSentinel, k as PROBE_EFFORT_CANDIDATES, l as readHostHeartbeat, m as fingerprintModel, n as GLOBAL_VARIANT, o as clearHostHeartbeat, p as QoderProbeStore, q as patTail, r as QODER_VARIANTS, s as isHeartbeatProcessAlive, t as CHINA_VARIANT, tt as qoderPluginDataDir, u as writeHostHeartbeat, v as QoderUpstreamClient, w as createQoderTransport, x as modelInfoOf, y as classifyUpstreamError, z as QODER_GLOBAL_STATUS_PATH } from "./variants-TeoUrhvG.js";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { requestImageDimensions } from "@deepseek-ai/dsh-attachment";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
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
* The request's Host header must name the loopback interface; this rejects
* DNS-rebinding pages (attacker domain re-resolved to 127.0.0.1).
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
* PAT route: saves (validate-then-persist), switches, removes, or clears the tokens
* of one variant.
*
* The guard is loopback Host + Origin plus the in-process key the card receives
* with its status document, because loopback alone is not authentication and this
* route writes a credential to disk.
*
* The region is never taken from the request: it is fixed by the route the browser
* called, so one product's card can never steer a token into the other's upstream.
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
		const label = wrapped["label"];
		if (label !== void 0 && (typeof label !== "string" || label.length > 200)) return void 0;
		return {
			action,
			pat,
			...label === void 0 ? {} : { label }
		};
	}
	if (action === "activate" || action === "remove") {
		const id = wrapped["id"];
		if (typeof id !== "string" || id.trim() === "") return void 0;
		return {
			action,
			id: id.trim()
		};
	}
}
/**
* Strip token-like content from a message before it reaches the browser.
*
* A validation error body is the one input here that is not the plugin's own
* prose, so this keeps a credential from crossing into the card.
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
* The PAT route's handler, extracted so tests can mount it on a bare server with a
* known key.
*
* @param deps - the save/activate/remove/clear operations for one variant.
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
			if (request.action === "activate") {
				json$2(res, 200, await deps.activate(request.id));
				return;
			}
			if (request.action === "remove") {
				json$2(res, 200, await deps.remove(request.id));
				return;
			}
			json$2(res, 200, await deps.save(request.pat, request.label));
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
//#region src/request-session.ts
/** Request attribution carried only across the authenticated loopback shim. */
const QODER_SESSION_HEADER = "x-dsh-qoder-session-id";
const QODER_PURPOSE_HEADER = "x-dsh-qoder-request-purpose";
const requestPurpose = new AsyncLocalStorage();
/** Bind each iterator operation, including lazy dispatch and cancellation. */
async function* withQoderRequestPurpose(purpose, stream) {
	const iterator = stream[Symbol.asyncIterator]();
	let exhausted = false;
	try {
		for (;;) {
			const next = await requestPurpose.run(purpose, () => iterator.next());
			if (next.done) {
				exhausted = true;
				return;
			}
			yield next.value;
		}
	} finally {
		if (!exhausted) await requestPurpose.run(purpose, () => iterator.return?.());
	}
}
/** Copy request headers without retaining another call's attribution. */
function qoderSessionHeaders(sessionId, headers) {
	return {
		...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "x-dsh-qoder-session-id" && name.toLowerCase() !== "x-dsh-qoder-request-purpose")),
		[QODER_SESSION_HEADER]: sessionId === void 0 ? null : encodeURIComponent(sessionId),
		[QODER_PURPOSE_HEADER]: requestPurpose.getStore() ?? null
	};
}
/** Missing or malformed attribution never falls back to another conversation. */
function readQoderSessionHeader(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	try {
		const sessionId = decodeURIComponent(value);
		return sessionId.length === 0 ? void 0 : sessionId;
	} catch {
		return;
	}
}
/** Only host-declared auxiliary purposes may influence the hint's visibility. */
function readQoderPurposeHeader(value) {
	return value === "session-title" || value === "compaction" ? value : void 0;
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the shim
* guards the local boundary and hands the raw JSON body to the upstream client,
* which translates it onto the Qoder transport. Binds 127.0.0.1 only.
*
* The loopback bind alone is not a trust boundary (any local process or a
* DNS-rebinding page can reach 127.0.0.1), so every request must carry a loopback
* Host header, browser-sent Origins must be loopback, chat POSTs must be
* application/json, and the Authorization header must carry the shim's per-process
* shared secret.
*
* @module dsh-qoder-connect/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		...headers
	});
	res.end(payload);
}
/**
* The prefix the shim stamps onto a failure message carrying an upstream retry
* hint.
*
* The hint must cross two text-only boundaries to reach the harness retry policy,
* so the marker is written in front of the 400-byte excerpt (never inside it,
* where truncation could cut it off) and read back by {@link retryAfterFromMessage}.
*/
const RETRY_AFTER_TAG = /\[retry-after=(\d+)s\]/u;
/**
* The upstream's retry hint, in milliseconds, recovered from a shim failure
* message.
*
* The tagged form is the contract this plugin writes itself; the untagged
* `retryAfterSeconds` form is the fallback for a message composed elsewhere.
*/
function retryAfterFromMessage(message) {
	const tagged = RETRY_AFTER_TAG.exec(message);
	if (tagged !== null) {
		const seconds = Number(tagged[1]);
		return Number.isFinite(seconds) && seconds > 0 ? seconds * 1e3 : void 0;
	}
	const body = /"retryAfterSeconds"\s*:\s*(\d+)/u.exec(message);
	if (body !== null) {
		const seconds = Number(body[1]);
		return Number.isFinite(seconds) && seconds > 0 ? seconds * 1e3 : void 0;
	}
}
/**
* Seconds an OpenAI `Retry-After` header carries: the ceiling of the hint, so a
* client that honors it never returns before the upstream's window closed.
*/
function retryAfterSeconds(retryAfterMs) {
	return Math.max(1, Math.ceil(retryAfterMs / 1e3));
}
function writeOpenAIError(res, status, kind, message, retryAfterMs) {
	const hint = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.floor(retryAfterMs) : void 0;
	if (hint === void 0) {
		writeJson(res, status, { error: {
			message,
			type: kind,
			code: kind
		} });
		return;
	}
	const seconds = retryAfterSeconds(hint);
	writeJson(res, status, { error: {
		message: `[retry-after=${seconds}s] ${message}`,
		type: kind,
		code: kind
	} }, {
		"Retry-After": String(seconds),
		"retry-after-ms": String(hint)
	});
}
/**
* Interval of the SSE comment written while an upstream answer is pending.
*
* The client reads the body through undici, whose `bodyTimeout` defaults to 300 s
* of silence; the interval must stay far below it so a multi-minute queue wait is
* never mistaken for a dead connection.
*/
const STREAM_KEEPALIVE_MS = 15e3;
/**
* How long an answer may stay silent before the stream head is committed anyway.
*
* Committing the head early is what makes a multi-minute queue wait survivable —
* the client's header clock stops applying once the head is in. But it also
* erases the status line: every failure after that point can only travel in-band,
* and the harness then classifies it from the message text alone. A fast failure
* (a rejected credential, an exhausted quota, a malformed request) should keep its
* real status, so the head waits out this window first. The window stays far
* below the 300 s a client allows for a response head, so a wait that really is
* long still enters the streamed envelope with minutes to spare.
*/
const STREAM_GRACE_MS = 5e3;
/**
* How long a closing shim waits for an in-flight answer before dropping it.
*
* A queue wait can last minutes; disposal must not. This only has to cover an
* answer that is nearly finished, which is the only one worth saving.
*/
const CLOSE_GRACE_MS = 1500;
/**
* Head of a streamed answer; sent once the answer turns slow.
*
* `Connection: close` is deliberate: this hop carries one answer per turn over
* loopback, and a socket the server half-closed is exactly what a client reports
* as a terminated connection. Closing after each answer costs one TCP connect and
* removes that class outright.
*/
const STREAM_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	"Connection": "close",
	"X-Accel-Buffering": "no"
};
/**
* Send the streaming head, exactly once.
*
* @param res - the response to commit.
*/
function writeStreamHead(res) {
	if (res.headersSent || res.writableEnded || res.destroyed) return;
	res.writeHead(200, STREAM_HEADERS);
	res.flushHeaders();
}
/**
* Keep the response body from ever going silent while the answer is pending.
*
* The client reads through undici, whose `bodyTimeout` defaults to 300 s between
* body bytes; the interval must stay far below it. A queue wait can last minutes
* and so can the wait for a model's first token, so the comments run until real
* bytes arrive rather than until the upstream answers.
*
* @param res - a response whose head is already committed.
* @param keepAliveMs - the comment interval; see {@link STREAM_KEEPALIVE_MS}.
* @returns the interval stop, safe to call more than once.
*/
function beginKeepAlive(res, keepAliveMs) {
	const timer = setInterval(() => {
		if (res.writableEnded || res.destroyed) return;
		try {
			res.write(": keep-alive\n\n");
		} catch {}
	}, keepAliveMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
/**
* Deliver one failure as an SSE `error` frame.
*
* The OpenAI SDK turns `data: {"error": ...}` into an `APIError` whose `message`
* is this payload's `message`, and the harness classifies a failure by matching
* that text — so the message keeps quoting the shim's OUTBOUND status exactly as
* the HTTP-status path did, and the retry hint keeps its tag for
* {@link retryAfterFromMessage}.
*
* @param res - a response whose head is already committed.
* @param kind - the failure kind, also carried as `type`/`code`.
* @param message - the client-visible message.
* @param retryAfterMs - the upstream's retry hint, when it reported one.
*/
function writeStreamError(res, kind, message, retryAfterMs) {
	if (res.writableEnded || res.destroyed) return;
	const hint = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.floor(retryAfterMs) : void 0;
	const text = hint === void 0 ? message : `[retry-after=${retryAfterSeconds(hint)}s] ${message}`;
	res.write(`data: ${JSON.stringify({ error: {
		message: text,
		type: kind,
		code: kind
	} })}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
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
* Start the loopback endpoint. The upstream credential comes from the store alone;
* the bearer checked is the per-process shared secret.
*/
function createQoderShim(options) {
	const { store, client, catalog } = options;
	const logger = options.logger;
	const providerId = options.providerId;
	const keepAliveMs = options.keepAliveMs ?? STREAM_KEEPALIVE_MS;
	const graceMs = options.graceMs ?? STREAM_GRACE_MS;
	const diag = (message) => {
		try {
			options.onDiag?.(message);
		} catch {}
	};
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
				else writeStreamError(res, "internal", "loopback request failed");
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
			if (!res.headersSent) {
				writeOpenAIError(res, 500, "internal", String(error));
				return;
			}
			logger?.warn("dsh-qoder-connect: loopback request failed after the stream head", error);
			writeStreamError(res, "internal", "loopback request failed");
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
		const startedAt = performance.now();
		res.on("close", () => {
			if (res.writableEnded) return;
			const elapsedMs = Math.round(performance.now() - startedAt);
			diag(`chat: client closed the answer after ${elapsedMs}ms (headCommitted=${res.headersSent})`);
			controller.abort("client closed the response");
		});
		const sessionId = readQoderSessionHeader(req.headers[QODER_SESSION_HEADER]);
		const purpose = readQoderPurposeHeader(req.headers[QODER_PURPOSE_HEADER]);
		/**
		* Commit the streaming head — once, and only if the answer turns slow.
		*
		* A fast failure keeps its status line (and its standard retry headers); a
		* slow one gets a committed 200 and keep-alive comments so a queue wait never
		* looks like a dead connection. See {@link STREAM_GRACE_MS}.
		*/
		let stopKeepAlive;
		const keepAlive = () => {
			if (res.writableEnded || res.destroyed) return;
			stopKeepAlive ??= beginKeepAlive(res, keepAliveMs);
		};
		const stopHead = () => {
			stopKeepAlive?.();
			stopKeepAlive = void 0;
		};
		const grace = setTimeout(() => {
			if (res.headersSent) return;
			writeStreamHead(res);
			keepAlive();
			diag(`chat: head committed after ${graceMs}ms without an upstream answer`);
		}, graceMs);
		grace.unref?.();
		let result;
		try {
			result = await client.chatStream(raw, controller.signal, sessionId, purpose);
		} finally {
			clearTimeout(grace);
		}
		if (!result.ok) {
			stopHead();
			const message = `${providerId} upstream ${result.kind} (http ${KIND_STATUS[result.kind]}): ${result.message.slice(0, 400)}`;
			if (!res.headersSent) {
				writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, message, result.retryAfterMs);
				return;
			}
			writeStreamError(res, result.kind, message, result.retryAfterMs);
			return;
		}
		writeStreamHead(res);
		keepAlive();
		let sawDone = false;
		let forwardedChunks = 0;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			forwardedChunks += 1;
			if (forwardedChunks === 1) stopHead();
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("end", stopHead);
		body.on("close", stopHead);
		body.on("error", (error) => {
			stopHead();
			logger?.warn("dsh-qoder-connect: upstream stream failed mid-flight", error);
			if (sawDone || !res.writable) return;
			if (forwardedChunks === 0) {
				writeStreamError(res, "transport", `${providerId} upstream stream ended without any data (${String(error?.message ?? error)})`);
				return;
			}
			res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.once("error", reject);
			const hardStop = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
			hardStop.unref?.();
			server.close(() => {
				clearTimeout(hardStop);
				resolve();
			});
		})
	};
}
//#endregion
//#region src/adapter.ts
/**
* The Qoder pi-ai provider: one loopback-backed adapter per variant route,
* assembled from public `dsh-llm-pi-ai` extension points.
*
* @module dsh-qoder-connect/adapter
*/
/** Default provider route owned by this bundle (the China variant). */
const QODER_PROVIDER = "qoder";
/**
* Provider idle ceiling while one stream read is outstanding.
*
* It has to cover a queue wait, which the settings bound (up to an hour, the
* official client's own limit) plus room for the replay: a shorter ceiling
* would abort exactly the wait the user asked for.
*/
const QODER_STREAM_IDLE_TIMEOUT_MS = 366e4;
/**
* Backoff ceiling for this plugin's routes: a hint above `maxDelayMs` makes the
* host drop the retry instead of waiting, and Qoder asks for up to 30s.
*/
const QODER_RETRY_MAX_DELAY_MS = 6e4;
/**
* Image-request budgets (dsh-llm-pi-ai defaults). They bound requests to models
* whose catalog entry declares `supportsImages`; text-only models get none.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. Qoder routes authenticate only through the shim shared
* secret, so pi-ai's own credential lifecycle must never manufacture one.
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
* The suffix appended to a model's display name so its billing rate is visible.
*
* The separator is a middle dot because model names commonly contain hyphens.
*/
const RATE_SEPARATOR = " · ";
/**
* What the model seat shows in place of a rate the plugin cannot stand behind.
*
* A literal, not a locale lookup: the adapter is a host seam. Words beat an empty
* slot because every other model in the seat shows a rate.
*/
const RATE_UNAVAILABLE = "价格暂不可用";
/**
* Append the billing rate to one model's display name.
*
* Display-only: routing is built from `model.id`, and nothing in the host
* resolves a model by name. The rate rides the name because the composer's model
* seat renders `model.name` alone.
*/
/** The catalog display suffix: the normalized billing rate, when the row has one. */
function displaySuffix(info) {
	if (info.billing?.rateUnknown === true) return RATE_UNAVAILABLE;
	const rate = normalizeCredits(info.billing?.credits);
	return rate === void 0 || rate === "" ? void 0 : rate;
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve a Qoder model's reasoning capability into pi-ai's `thinkingLevelMap`
* (every level pinned to its wire spelling, or `null` when unsupported).
*
* Two ordered sources: a declared `supportedEfforts` set always wins and is never
* widened or narrowed by an observation; otherwise a *validating* local probe may
* supply the verified spellings. A `non-validating` observation yields no control
* — an upstream accepting impossible values would make every acceptance a false
* positive. `off` is offered only when `canDisableThinking` is declared, never
* probed. Internally the set means "verified accepted", not "verified effective".
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
/**
* Normalize `reasoning` on one resolved model so `normalizeModelInfo` never sees
* a partial object. `dsh-llm` reads `reasoning.efforts.length` unconditionally,
* so an adapter-side reasoning that has no array must be dropped entirely; a
* valid one is passed through untouched.
*/
function normalizeReasoning(resolved) {
	const reasoning = resolved.reasoning;
	if (reasoning === void 0 || reasoning === null) return resolved;
	if (typeof reasoning !== "object") return {
		...resolved,
		reasoning: void 0
	};
	const efforts = reasoning.efforts;
	if (!Array.isArray(efforts) || efforts.length === 0) return {
		...resolved,
		reasoning: void 0
	};
	return resolved;
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
		...info.maxTokensDeclared === true && info.maxTokens !== void 0 ? { maxTokens: info.maxTokens } : {},
		compat: { maxTokensField: "max_tokens" }
	};
}
/**
* Assemble the adapter. `getModels` reads the live catalog and each `baseUrl` is
* re-resolved per read, so the shim's ephemeral port applies immediately.
*
* The profile is hand-built because dsh-llm-pi-ai's `resolveProfiles()` is not
* public, so every newly required profile field must be adopted here explicitly.
*/
function createQoderAdapter(options) {
	const { shim, store, catalog, resolveAttachments, observe } = options;
	const providerId = options.providerId ?? "qoder";
	const displayName = options.displayName ?? "Qoder";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, observe?.(info.id), providerId));
	};
	const api = openAICompletionsApi();
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
			api: {
				...api,
				stream: (model, context, request) => api.stream(model, context, {
					...request,
					headers: qoderSessionHeaders(request?.sessionId, request?.headers)
				}),
				streamSimple: (model, context, request) => api.streamSimple(model, context, {
					...request,
					headers: qoderSessionHeaders(request?.sessionId, request?.headers)
				})
			}
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		get streamIdleTimeoutMs() {
			const budget = options.queueBudgetMs?.() ?? 0;
			return Math.max(QODER_STREAM_IDLE_TIMEOUT_MS, budget + 6e4);
		},
		retryPolicy: resolveRetryPolicy({
			mode: "normal",
			backoff: { maxDelayMs: QODER_RETRY_MAX_DELAY_MS }
		}, `dsh-qoder-connect:${providerId} retryPolicy`),
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
* Keep a damaged tool call from executing with truncated arguments.
*
* pi-ai parses unparsable arguments as `{}` (the real text survives only in
* `argumentsError`, which this layer never receives), so a tool with optional fields
* would happily execute an empty or truncated payload. The raw bytes survive on the
* `tool-call-delta` stream, and `dsh-llm`'s `BlockAssembler` prefers the `block-end`
* block, so re-emitting the damaged text here makes the harness reject the call as
* invalid arguments and the model re-emits it. Complete calls are untouched.
*
* @internal Exported for tests; the adapter wrappers are the only callers.
*/
async function* rejectDamagedToolArguments(inner) {
	const accumulated = /* @__PURE__ */ new Map();
	for await (const chunk of inner) {
		if (chunk.type === "tool-call-delta") {
			accumulated.set(chunk.index, (accumulated.get(chunk.index) ?? "") + chunk.argumentsDelta);
			yield chunk;
			continue;
		}
		if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
			const raw = accumulated.get(chunk.index);
			if (raw !== void 0 && !isJsonObjectText(raw)) {
				yield {
					...chunk,
					block: {
						...chunk.block,
						arguments: raw
					}
				};
				continue;
			}
		}
		yield chunk;
	}
}
/** Whether the text parses as a JSON object, the only shape a tool call may carry. */
function isJsonObjectText(text) {
	try {
		const value = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value);
	} catch {
		return false;
	}
}
/**
* The Qoder variant route's adapter: `PiAiAdapter` with the billing rate folded
* into the catalog answers it returns to the DSH model pickers.
*
* The pi-ai descriptors carry no billing fact, so the rate is layered on from the
* live catalog; both overrides delegate to `super` and rewrite display fields
* only. A model missing from the catalog keeps its name rather than being
* dropped: catalog membership is advisory.
*/
var QoderPiAiAdapter = class QoderPiAiAdapter extends PiAiAdapter {
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
	/**
	* Restore `failure.providerRetryAfterMs`, which `dsh-llm-pi-ai` flattens away;
	* the shim's `[retry-after=<n>s]` tag is the carrier.
	*
	* Both entry points are wrapped because the harness uses `prepareCall().stream`,
	* which never calls `this.stream`. Only the field is rewritten, never the message.
	*/
	async *stream(options) {
		yield* withQoderRequestPurpose(options.purpose, rejectDamagedToolArguments(this.withRetryHint(super.stream(options))));
	}
	async prepareCall(provider, model, signal) {
		const prepared = await super.prepareCall(provider, model, signal);
		return {
			...prepared,
			model: normalizeReasoning(prepared.model),
			stream: (options) => withQoderRequestPurpose(options.purpose, rejectDamagedToolArguments(this.withRetryHint(prepared.stream(options))))
		};
	}
	/** Re-stamp `failure.providerRetryAfterMs` on every terminal failure chunk. */
	async *withRetryHint(inner) {
		for await (const chunk of inner) {
			if (chunk.type === "finish") {
				const { reason } = chunk;
				if ((reason.kind === "error" || reason.kind === "aborted") && reason.failure.providerRetryAfterMs === void 0) {
					const retryAfterMs = retryAfterFromMessage(reason.failure.message);
					if (retryAfterMs !== void 0) {
						yield {
							...chunk,
							reason: {
								...reason,
								failure: {
									...reason.failure,
									providerRetryAfterMs: retryAfterMs
								}
							}
						};
						continue;
					}
				}
			}
			yield chunk;
		}
	}
	/**
	* Resolve the request-image projection target for one route.
	*
	* `dsh-llm` calls `imageRequestTarget()` unconditionally but resolved this
	* plugin's peer `PiAiAdapter` may predate the method, so an inherited
	* implementation is derived from the profile budgets instead. When the base
	* implementation does exist, prefer it so this override never drifts.
	*/
	imageRequestTarget(provider, model, image) {
		const inherited = Object.getPrototypeOf(QoderPiAiAdapter.prototype).imageRequestTarget;
		if (typeof inherited === "function") return inherited.call(this, provider, model, image);
		const { width, height } = requestImageDimensions(image.width, image.height, REQUEST_IMAGE_BUDGETS.requestImagePixelBudget);
		return {
			width,
			height,
			maxBytes: REQUEST_IMAGE_BUDGETS.requestImageMaxBytes
		};
	}
};
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
	* A declared set always wins, so a model declaring `supportedEfforts` is never
	* answered from an observation.
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
	* confirmation; other callers must pass the configured consent gate. Explicit
	* requests bypass historical results but share an ongoing run.
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
//#region src/copy.ts
/** Best-effort locale for host-generated session rows. */
function hostLocale() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en";
	} catch {
		return "en";
	}
}
/**
* The wait wording: the estimate is the upstream's own answer, not this client's
* promise, so the row must never read as "about to be granted". A zero estimate
* means "no capacity", not "instant".
*/
function zhWait(waitSeconds) {
	if (waitSeconds === void 0) return "";
	if (waitSeconds <= 0) return "，等待上游释放容量";
	return `，上游返回预计等待 ${waitSeconds} 秒`;
}
/** The wait wording: a zero estimate means "no capacity", not "instant". */
function enWait(waitSeconds) {
	if (waitSeconds === void 0) return "";
	if (waitSeconds <= 0) return ", waiting for capacity";
	return `, upstream estimate ~${waitSeconds}s`;
}
const zhQueue = {
	hint: ({ display, attempt, waitSeconds }) => `${display} · 模型排队中（第 ${attempt} 次轮询${zhWait(waitSeconds)}）`,
	reason: ({ display, waitSeconds }) => `${display} 模型排队中${zhWait(waitSeconds)}`
};
const enQueue = {
	hint: ({ display, attempt, waitSeconds }) => `${display} · queued (poll ${attempt}${enWait(waitSeconds)})`,
	reason: ({ display, waitSeconds }) => `${display} model queued${enWait(waitSeconds)}`
};
/** The wording for one locale. */
function queueCopy(locale = hostLocale()) {
	return locale === "zh" ? zhQueue : enQueue;
}
//#endregion
//#region src/job-token-hint.ts
/**
* Conversation rows printed into one named session.
*
* A row is the log-only `command/run` + `command/done` pair: one line, no turn,
* no model call. The destination is never guessed — a request that cannot name
* its session prints nothing, the same rule the queue hint follows.
*
* @module dsh-qoder-connect/job-token-hint
*/
/** The name recorded on the hint row (and therefore its displayed title). */
const JOB_TOKEN_HINT_NAME = "qoder";
/** Monotonic suffix keeping appended ids unique within this process. */
let hintSeq = 0;
/**
* Print the refresh row into the session whose request triggered it.
*
* @param text - The row's summary line.
* @param session - The session to append into; never inferred.
*/
function emitJobTokenHint(text, session) {
	appendHintRow(session, "success", text);
}
/**
* Print the failed-heal row into the same session; the mirror of
* {@link emitJobTokenHint}. Rate limited by the transport, so this stays a printer.
*
* @param text - The row's summary line.
* @param session - The session to append into; never inferred.
*/
function emitJobTokenRefreshFailedHint(text, session) {
	appendHintRow(session, "error", text);
}
/**
* Dispatch a heal row to the one session that may receive it.
*
* Fails closed: no `sessionId`, or one that no longer resolves, prints nothing.
*/
function dispatchJobTokenNotice(options) {
	const { text, kind, sessionId, resolveSession } = options;
	if (sessionId === void 0) return;
	const session = resolveSession(sessionId);
	if (session === void 0) return;
	if (kind === "success") emitJobTokenHint(text, session);
	else emitJobTokenRefreshFailedHint(text, session);
}
/**
* Append one one-off notice row into a specific session.
*
* A notice reports something the user needs to see but that neither fails the turn
* nor belongs to a row lifecycle: today that is the upstream filtering a reply. It
* reuses the `qoder` row name, so it reads exactly like the heal rows.
*
* @param session - the session to append into.
* @param kind - how the row renders; `error` marks an incomplete answer.
* @param text - the row's summary line.
*/
function emitNoticeRow(session, kind, text) {
	appendHintRow(session, kind, text);
}
/** Append one log-only command pair carrying `text` as its outcome. */
function appendHintRow(session, kind, text) {
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
/**
* Open a queue-wait row and return its id.
*
* The row title is the ASCII name; the display name belongs in `text`, since the
* card renders `{name} · {text}` and would otherwise repeat it.
*/
function openQueueHint(session, text) {
	const commandId = `cmd-qoder-queue-${Date.now().toString(36)}-${++hintSeq}`;
	try {
		session.append("command/run", {
			commandId,
			name: JOB_TOKEN_HINT_NAME,
			source: { kind: "user" }
		});
		session.append("command/done", {
			commandId,
			kind: "success",
			text
		});
		return commandId;
	} catch {
		return;
	}
}
/**
* Rewrite an open queue-wait row.
*
* The chat view folds a `command/done` into the row its `commandId` opened and
* keeps the original seq, so the row stays in place and only its text changes.
*/
function updateQueueHint(session, commandId, text) {
	try {
		session.append("command/done", {
			commandId,
			kind: "success",
			text
		});
	} catch {}
}
//#endregion
//#region src/queue-hint.ts
/**
* Capture the request's destination and keep its row private to this observer.
* No registry survives the request, so cancellation and failures leave no state
* that another request can inherit. Replays within this request reuse its row.
*/
function createQueueHint(options) {
	const { sessionId, purpose, displayName, resolveSession, onDiag } = options;
	let row;
	return (info) => {
		if (info.cleared === true) return;
		if (purpose === "session-title") {
			onDiag?.(`hint skipped: purpose=session-title session=${sessionId ?? "none"} attempt=${info.attempt}`);
			return;
		}
		const session = row?.session ?? (sessionId === void 0 ? void 0 : resolveSession(sessionId));
		if (session === void 0) {
			onDiag?.(`hint skipped: no session (sessionId=${sessionId ?? "none"})`);
			return;
		}
		const text = queueCopy().hint({
			display: displayName,
			attempt: info.attempt,
			...info.waitTimeMs === void 0 ? {} : { waitSeconds: Math.ceil(info.waitTimeMs / 1e3) }
		});
		if (row === void 0) {
			const commandId = openQueueHint(session, text);
			if (commandId !== void 0) row = {
				session,
				commandId
			};
			onDiag?.(`hint open session=${sessionId} attempt=${info.attempt} id=${commandId ?? "none"}`);
			return;
		}
		updateQueueHint(row.session, row.commandId, text);
		onDiag?.(`hint update session=${sessionId} attempt=${info.attempt} id=${row.commandId}`);
	};
}
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
* The request must be addressed to the loopback interface, and a browser-attached
* Origin must be loopback too. The Host check drops DNS-rebinding pages; the card's
* same-origin fetches carry no Origin and pass on Host alone.
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
* Assemble the card's status document. Credit is a live billing answer whose
* failure degrades to `creditsError` rather than failing the whole document.
*/
async function qoderWebStatus(deps) {
	const authStatus = await deps.store.status();
	const peerSkipped = deps.peerCheckSkipped?.();
	if (authStatus.state !== "configured") return {
		status: "signed-out",
		...authStatus.reason === void 0 ? {} : { reason: authStatus.reason },
		...deps.authKey === void 0 ? {} : { authKey: deps.authKey },
		...peerSkipped === void 0 ? {} : { peerCheckSkipped: peerSkipped }
	};
	const status = {
		status: "signed-in",
		...authStatus.region === void 0 ? {} : { region: authStatus.region },
		...authStatus.pat === void 0 ? {} : { pat: authStatus.pat },
		...authStatus.profiles === void 0 ? {} : { patProfiles: authStatus.profiles },
		...authStatus.activeId === void 0 ? {} : { activePatId: authStatus.activeId },
		...deps.authKey === void 0 ? {} : { authKey: deps.authKey },
		...peerSkipped === void 0 ? {} : { peerCheckSkipped: peerSkipped }
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
		...deps.useMaximumContextWindow === void 0 ? {} : { useMaximumContextWindow: deps.useMaximumContextWindow() },
		...deps.disabledModels === void 0 ? {} : { disabledModels: deps.disabledModels() }
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
/**
* Mount the status route of a plugin that refused to load.
*
* Every other route this plugin would register belongs to machinery that never
* started, so the card must not offer those controls. This one route exists so
* the refusal itself — the load-time message, verbatim — reaches the browser and
* can be copied out; the alternative is a card whose every action answers 404.
*
* @param ctx - context that exposes the web server.
* @param path - exact status path for one variant.
* @param message - the load-time failure text, already human-readable.
*/
function registerInactiveStatusRoute(ctx, path, message) {
	return ctx.webServer.register({
		kind: "exact",
		path,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				json$1(res, 405, { error: "method not allowed" });
				return;
			}
			if (!loopbackRequest(req)) {
				json$1(res, 403, { error: "request-not-trusted" });
				return;
			}
			json$1(res, 200, {
				status: "error",
				message,
				inactive: true
			});
		}
	});
}
//#endregion
//#region src/probe-route.ts
/**
* Probe control route: the only state-changing endpoint the plugin exposes.
*
* Two guards, because they stop different things: loopback Host + Origin, which
* drops DNS-rebinding pages, and an in-process random key handed only to the
* same-origin card. Loopback alone is not authentication (any local process can
* send `Host: 127.0.0.1`), so a route that spends the user's credit must prove
* the caller was told the key. The route never accepts a prompt, a model id
* outside the live catalog, or a browser sentinel: the request is assembled
* host-side.
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
	if (action === "set-models-enabled") {
		if (typeof wrapped["enabled"] !== "boolean") return void 0;
		const rawModels = wrapped["models"];
		const rawModel = wrapped["model"];
		let models = [];
		if (Array.isArray(rawModels)) models = rawModels.filter((m) => typeof m === "string" && m.trim() !== "").map((m) => m.trim());
		else if (typeof rawModel === "string" && rawModel.trim() !== "") models = [rawModel.trim()];
		if (models.length === 0) return void 0;
		return {
			action: "set-models-enabled",
			models,
			enabled: wrapped["enabled"]
		};
	}
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
			if (action.action === "set-models-enabled") {
				if (deps.setModelsEnabled === void 0) {
					json(res, 404, { error: "models-enabled-setting-not-supported" });
					return;
				}
				json(res, 200, await deps.setModelsEnabled({
					models: action.models ?? (action.model ? [action.model] : []),
					enabled: action.enabled === true
				}));
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
/** Clamp any stored/typed value onto a minute the plugin can actually honour. */
function normalizeCheckInMinute(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return 600;
	const whole = Math.trunc(value);
	if (whole < 0 || whole > 1439) return 600;
	return Math.max(600, whole);
}
/**
* Calculates milliseconds until the next occurrence of `minuteOfDay` (UTC+8).
*
* Five seconds past the configured minute are used so the request lands after
* the upstream has flipped the day over rather than on the boundary itself.
*/
function msUntilNextCheckIn(minuteOfDay, nowMs = Date.now()) {
	const minute = normalizeCheckInMinute(minuteOfDay);
	const utc8Time = utc8WallClock(nowMs);
	const targetUtc8 = new Date(utc8Time.getTime());
	targetUtc8.setHours(Math.floor(minute / 60), minute % 60, 5, 0);
	let diff = targetUtc8.getTime() - utc8Time.getTime();
	if (diff <= 0) {
		targetUtc8.setDate(targetUtc8.getDate() + 1);
		diff = targetUtc8.getTime() - utc8Time.getTime();
	}
	return diff;
}
/**
* Whether today's configured check-in moment (UTC+8) has already passed.
*/
function isPastCheckInTime(minuteOfDay, nowMs = Date.now()) {
	const minute = normalizeCheckInMinute(minuteOfDay);
	const utc8 = utc8WallClock(nowMs);
	return utc8.getHours() * 60 + utc8.getMinutes() >= minute;
}
var CheckInScheduler = class {
	targets;
	isEnabled;
	store;
	onResult;
	now;
	/**
	* One timer per enabled variant, keyed by variant id.
	*
	* Per-variant because the two products may check in at different moments.
	*/
	timers = /* @__PURE__ */ new Map();
	/**
	* Variants with a sweep in progress, so concurrent callers cannot double-claim.
	*/
	inFlight = /* @__PURE__ */ new Set();
	/** When each variant's timer is next due, epoch ms, for the card to show. */
	nextRuns = /* @__PURE__ */ new Map();
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
		this.rearm();
	}
	/**
	* Re-run the startup catch-up once the toggles are actually readable.
	*
	* `start()` runs before the settings section hands over its stored values, so
	* the first sweep may skip the day. The sweep is idempotent, so a day already
	* handled costs nothing.
	*/
	catchUp() {
		if (this.disposed) return;
		this.sweepAll(true);
	}
	dispose() {
		this.disposed = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}
	/**
	* Re-place every variant's timer.
	*
	* Called after each fire and whenever configuration lands, so a retimed card
	* takes effect without a restart. A timer is placed for every target, including
	* disabled variants: `start()` runs before the stored toggles are readable, and
	* gating placement on `isEnabled` left the variant with no timer and nothing to
	* re-arm it. Whether work is due is decided in the sweep; the timer only decides
	* when to look.
	*/
	rearm() {
		if (this.disposed) return;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.nextRuns.clear();
		const nowMs = this.now();
		for (const target of this.targets) {
			const delay = msUntilNextCheckIn(target.minuteOfDay(), nowMs);
			this.nextRuns.set(target.variantId, nowMs + delay);
			const timer = setTimeout(() => {
				this.timers.delete(target.variantId);
				this.sweepAll(false, target.variantId).finally(() => {
					this.rearm();
				});
			}, delay);
			timer.unref?.();
			this.timers.set(target.variantId, timer);
		}
	}
	/** When this variant's timer is next due, epoch ms; absent before first arm. */
	nextRunAt(variantId) {
		return this.nextRuns.get(variantId);
	}
	async sweepAll(isCatchUp, only) {
		if (this.disposed) return;
		const nowMs = this.now();
		const today = formatUtc8Date(nowMs);
		for (const target of this.targets) {
			if (only !== void 0 && target.variantId !== only) continue;
			if (!this.isEnabled(target.variantId)) continue;
			if (this.inFlight.has(target.variantId)) continue;
			this.inFlight.add(target.variantId);
			try {
				await this.sweepOne(target, isCatchUp, nowMs, today);
			} finally {
				this.inFlight.delete(target.variantId);
			}
		}
	}
	async sweepOne(target, isCatchUp, nowMs, today) {
		const record = this.store.read(target.variantId);
		if (record?.lastDate === today && (record.status === "claimed" || record.status === "already-claimed")) {
			if (!isCatchUp) this.store.write(target.variantId, {
				lastDate: today,
				lastAt: nowMs,
				status: "already-claimed",
				...record.amount === void 0 ? {} : { amount: record.amount },
				message: "Scheduled check-in ran; today was already claimed"
			});
			return;
		}
		if (isCatchUp && !isPastCheckInTime(target.minuteOfDay(), nowMs)) return;
		let result;
		try {
			result = await target.checkIn();
		} catch {
			return;
		}
		try {
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
};
//#endregion
//#region src/settings-store.ts
/**
* Plugin-owned settings store — the single source of truth for this plugin's user
* configuration on every host line.
*
* A profile patch write reconciles the whole loader tree and hot-reloads the
* plugin's fiber on every write, so the plugin's settings live beside its other
* files in `<plugin data dir>/settings.json`: a write is a small atomic file write
* with an in-memory apply, no reload. The path comes from `qoderPluginDataDir()`,
* the plugin's one discovery implementation.
*
* Migration (one time): an absent file is seeded from the entry config's fields,
* then only this plugin's fields are deleted from the entry config.
*
* @module dsh-qoder-connect/settings-store
*/
/** Settings file name inside the plugin data directory. */
const SETTINGS_FILE_NAME = "settings.json";
/** This plugin's data directory (shared with the credential and caches). */
function dataDir() {
	return qoderPluginDataDir();
}
/** Absolute path of the settings file. */
function settingsFilePath() {
	return join(dataDir(), SETTINGS_FILE_NAME);
}
/** Read + parse the settings file; `undefined` when absent or unreadable. */
function readFile() {
	const path = settingsFilePath();
	if (!existsSync(path)) return void 0;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/** Write the settings file atomically (tmp + rename), creating the directory. */
function writeSettings(values) {
	const path = settingsFilePath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}
/**
* Reserved bookkeeping key: how many writes the settings card has made through
* this store. It separates "the file holds the startup seed" from "the file holds
* the user's live edits". Field readers address their fields by name and never
* collide with it.
*/
const WRITE_MARK = "__writes";
/**
* One store instance: the plugin's own settings file, with the entry config as
* the fallback layer the caller overlays it on.
*/
var SettingsStore = class {
	/** The user layer exactly as stored (presence marks an override). */
	user;
	constructor() {
		this.user = readFile() ?? {};
	}
	/** Whether the store file exists. */
	exists() {
		return existsSync(settingsFilePath());
	}
	/**
	* Whether the settings card has ever written through this store.
	*
	* Until it has, the entry config stays the fallback layer; once the card writes,
	* the file is authoritative — a runtime edit must never be regressed by a stale
	* profile row.
	*/
	get edited() {
		return typeof this.user[WRITE_MARK] === "number" && this.user[WRITE_MARK] > 0;
	}
	/**
	* Apply one patch in memory and persist it.
	* @param patch - field → value; a `null` value clears the field.
	* @param fromCard - true when the settings card made this write; marks the
	*   file as holding live user edits from then on.
	* @returns the new user layer.
	*/
	patch(patch, fromCard = false) {
		const next = { ...this.user };
		for (const [field, value] of Object.entries(patch)) if (value === null) delete next[field];
		else next[field] = value;
		if (fromCard) next[WRITE_MARK] = (typeof next[WRITE_MARK] === "number" ? next[WRITE_MARK] : 0) + 1;
		writeSettings(next);
		for (const key of Object.keys(this.user)) delete this.user[key];
		Object.assign(this.user, next);
		return this.user;
	}
	/** The current user layer. */
	values() {
		return this.user;
	}
};
//#endregion
//#region src/index.ts
/**
* Qoder models for DeepSeek Harness, driven by Personal Access Tokens.
*
* One provider per variant — `qoder` (China) and `qoder-global` — built by the
* same factory and differing only in their {@link QoderVariant} descriptor.
* Streaming, tool calls, compaction, and permissions stay Harness-owned.
*
* @module dsh-qoder-connect
*/
/** Stable Cordis plugin name. */
const name = "llm-qoder";
/** The model registry the provider needs before it can register. */
const inject = ["llm"];
/**
* Settings namespace for the China card's section.
*
* A namespace is a nominal string checked at compile time only; the cast keeps
* the public constant typed without pulling the branding helper into this package.
*/
const QODER_SETTINGS_NS = "qoder";
/**
* Settings namespace for the global card's section.
*
* One namespace per card: the Plugins tab dispatches a card per served
* namespace, so a single section would leave the other card registered but
* never rendered.
*/
const QODER_GLOBAL_SETTINGS_NS = "qoder-global";
/**
* Settings namespace for the shared quota card, whose per-variant fields
* configure both sidebar widgets from one place.
*/
const QODER_QUOTA_SETTINGS_NS = "qoder-quota";
/**
* How often the credential files are re-checked, in milliseconds. A local
* existence/parse read only — never the network, never a reasoning probe.
*
* `DSH_QODER_POLL_MS` overrides it for tests and diagnosis: clamped, not a
* product setting, and no UI exposes it.
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
* How many credential sweeps to wait before retrying a failed catalog fetch.
*
* A live catalog is never re-fetched on a sweep (the same token carries no new
* model information), but a *failed* one must recover on its own — one startup
* blip must not pin the group to the fallback roster until a manual refresh.
* A multiple of the sweep so the `DSH_QODER_POLL_MS` override scales both.
*/
const CATALOG_RETRY_SWEEPS = 10;
/**
* Mark one configuration field as a projected (volatile) setting, when the host
* has that concept: a projected field reaches the settings form and arrives as a
* stable reference instead of a value. The method is probed, never assumed — an
* older host has none and would throw. Only top-level fields may be marked.
*
* @param field - the field's schema.
* @returns the projected schema on a host that supports projection, else the field itself.
*/
function volatileField(field) {
	const probe = field;
	if (typeof probe.volatile === "function") return probe.volatile();
	if (typeof probe.extra === "function") return probe.extra("volatile", true);
	if (probe && typeof probe === "object") {
		probe.meta = {
			...probe.meta,
			volatile: true
		};
		return probe;
	}
	return field;
}
/**
* Read one configuration field through the volatile indirection: a projected
* field is a reference read with `.get()`, a plain field arrives as its value.
*
* @param config - the raw plugin configuration, in either host's shape.
* @param field - field name inside the configuration object.
* @returns the field's value, or undefined when the field is absent.
*/
function readField(config, field) {
	const value = config?.[field];
	return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}
/**
* Typed face of {@link readField} for a single declared field.
*
* @returns the field's plain value, or undefined when it is absent.
*/
function readConfigField(config, field) {
	return readField(config, field);
}
/** Probe authorization (shared by the plugin schema and the China section). */
const PROBE_CONSENT_FIELD = volatileField(z.boolean().default(false).description("Authorize reasoning-effort probes (each probe sends real requests that may consume credit)"));
const MAXIMUM_CONTEXT_WINDOW_FIELD = volatileField(z.boolean().default(true).description("Use the largest context window declared by Qoder Global when alternatives are available (on by default)"));
/** The China variant's own maximum-window preference. */
const MAXIMUM_CONTEXT_WINDOW_CN_FIELD = volatileField(z.boolean().default(true).description("Use the largest context window declared by Qoder (China) when alternatives are available (on by default)"));
/** Per-model window overrides (model id → tokens); absent means "no overrides". */
const MODEL_CONTEXT_WINDOWS_FIELD = volatileField(z.dict(z.number().min(1), z.string()).description("Per-model context-window overrides for Qoder Global (model id → tokens)"));
/** Disabled models list (blacklist) */
const DISABLED_MODELS_FIELD = volatileField(z.array(z.string()).default([]).description("Models hidden from the provider catalog and picker"));
/** Sidebar quota toggle (one per variant; both live on the shared quota card). */
const QUOTA_TOGGLE_FIELD = volatileField(z.boolean().default(false).description("Show this variant’s remaining-credit card in the sidebar footer (off by default)"));
/** Automatic check-in toggle. */
const AUTO_CHECK_IN_FIELD = volatileField(z.boolean().default(false).description("每天自动签到领取算力额度（默认关闭）"));
/**
* When a variant checks in, as minutes past UTC+8 midnight (0–1439), so the
* schema itself rejects an impossible time. The floor is the upstream window's
* 10:00 opening: an earlier run could only settle the previous day.
*/
const CHECK_IN_MINUTE_FIELD = volatileField(z.number().default(600).min(600).max(1439).description("每日自动签到的时刻（自 UTC+8 午夜起的分钟数，600 = 10:00；最早 10:00，即活动窗口开启时刻）"));
/**
* Quota poll interval: default 5 minutes, floor 1 minute. The status route makes
* a live, uncached upstream billing call per request, so the floor is the
* smallest value the UI offers rather than a silent clamp.
*/
const QUOTA_POLL_DEFAULT_MS = 3e5;
const QUOTA_POLL_MIN_MS = 6e4;
const QUOTA_POLL_FIELD = volatileField(z.number().default(QUOTA_POLL_DEFAULT_MS).min(QUOTA_POLL_MIN_MS).description("Sidebar quota card refresh interval in milliseconds (default 300000, minimum 60000)"));
/**
* Queue wait: when on, a 10605 answer is polled inside the plugin and replayed.
* When off, the failure keeps its retry hint and goes to the host unchanged.
*/
const QUEUE_WAIT_FIELD = volatileField(z.boolean().default(true).description("Retry inside the plugin: polls the model queue, then replays. Off hands the request result to the host unchanged"));
/**
* How long one call may wait in the model queue, in seconds.
*
* Only a floor is enforced: the wait is a budget the user owns, and the loop
* divides it by whatever pace the upstream reports, so a value larger than the
* upstream's own countdown simply spans more rounds.
*/
const QUEUE_WAIT_SECONDS_DEFAULT = 540;
const QUEUE_WAIT_SECONDS_MIN = 1;
const QUEUE_WAIT_SECONDS_FIELD = volatileField(z.number().default(540).min(1).description("How long the plugin may wait in the model queue, in seconds; each poll still waits the pace Qoder reports"));
const Config = z.object({
	probeConsent: PROBE_CONSENT_FIELD,
	useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
	useMaximumContextWindowCN: MAXIMUM_CONTEXT_WINDOW_CN_FIELD,
	modelContextWindows: MODEL_CONTEXT_WINDOWS_FIELD,
	modelContextWindowsCN: MODEL_CONTEXT_WINDOWS_FIELD,
	disabledModels: DISABLED_MODELS_FIELD,
	disabledModelsCN: DISABLED_MODELS_FIELD,
	sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
	sidebarQuotaGlobal: QUOTA_TOGGLE_FIELD,
	autoCheckInCN: AUTO_CHECK_IN_FIELD,
	autoCheckInGlobal: AUTO_CHECK_IN_FIELD,
	checkInMinuteCN: CHECK_IN_MINUTE_FIELD,
	checkInMinuteGlobal: CHECK_IN_MINUTE_FIELD,
	quotaPollMs: QUOTA_POLL_FIELD,
	queueWait: QUEUE_WAIT_FIELD,
	queueWaitSeconds: QUEUE_WAIT_SECONDS_FIELD
});
/**
* The field groups the configuration is merged from, one list per card: a field
* added to {@link Config} but missing here is never read.
*/
const CN_SECTION_KEYS = [
	"probeConsent",
	"useMaximumContextWindowCN",
	"modelContextWindowsCN",
	"disabledModelsCN"
];
const GLOBAL_SECTION_KEYS = [
	"useMaximumContextWindow",
	"modelContextWindows",
	"disabledModels"
];
const QUOTA_SECTION_KEYS = [
	"sidebarQuotaCN",
	"sidebarQuotaGlobal",
	"autoCheckInCN",
	"autoCheckInGlobal",
	"checkInMinuteCN",
	"checkInMinuteGlobal",
	"quotaPollMs",
	"queueWait",
	"queueWaitSeconds"
];
/** Every declared configuration field, in the order the sections are merged. */
const CONFIG_KEYS = [
	...CN_SECTION_KEYS,
	...GLOBAL_SECTION_KEYS,
	...QUOTA_SECTION_KEYS
];
/** Copy the declared fields off one section's source, skipping absent ones. */
function pickFields(source, keys) {
	const value = source();
	const picked = {};
	for (const key of keys) {
		const field = readField(value, key);
		if (field !== void 0) picked[key] = field;
	}
	return picked;
}
/**
* Unwrap a whole configuration object into plain values, for the direct reads
* made before any settings section supplies a source.
*
* @param config - the raw plugin configuration, in either host's shape.
* @returns the same configuration with every declared field read out.
*/
function readConfig(config) {
	return pickFields(() => config, CONFIG_KEYS);
}
/** Stable identity key used by credentials, probe records, and catalog entries. */
const credentialIdentity = qoderCredentialIdentity;
/**
* The static catalog a variant serves before its first successful fetch: one
* roster for both regions, transcribed from the transport's model defaults.
*/
function fallbackFor(_variant) {
	return FALLBACK_QODER_MODELS;
}
/** The hint row's summary line: what happened, and when. */
function jobTokenHintText(at) {
	return `jobToken 已自动刷新（${new Date(at).toLocaleTimeString("zh-CN", { hour12: false })}）— 旧令牌被上游拒绝，已自动重换并恢复`;
}
/**
* The failed-heal row's summary line. Deliberately names no cause — the real
* reason travels in the failure message — and must not point at "the error
* above", since the heal may belong to a request that renders no card.
*/
function jobTokenRefreshFailedHintText(at) {
	return `jobToken 已重换但仍被上游拒绝（${new Date(at).toLocaleTimeString("zh-CN", { hour12: false })}）— 自愈未恢复，该请求已失败`;
}
/**
* The filtered-reply row's summary line.
*
* The upstream cut the answer by policy; the turn still ends normally, so without this
* row the user would read a truncated reply as a complete one.
*/
function contentFilterHintText(reason) {
	return `回复被上游内容安全策略过滤（${reason}），内容可能不完整`;
}
/** The compaction-specific wording: the summary, not the conversation reply, was cut short. */
function compactionFilteredHintText(reason) {
	return `压缩摘要被上游内容安全策略过滤（${reason}），压缩结果可能不完整`;
}
/** Build one variant's stores, transport, and probe state. */
function createVariantRuntime(ctx, config, variant, current, identityOf) {
	const store = new QoderCredentialStore({
		variant,
		logger: ctx.logger
	});
	let jobTokenRefreshedAt;
	const resolveAttachmentService = () => {
		const service = ctx.get("attachments");
		if (service === void 0) throw new Error("dsh-qoder-connect: no attachment service is available");
		return service;
	};
	const attachments = {
		get imageLimits() {
			return resolveAttachmentService().imageLimits;
		},
		readImageRequest: async (attachment, policy, signal) => await resolveAttachmentService().readImageRequest(attachment, policy, signal),
		saveImage: async (request) => await resolveAttachmentService().saveImage(request)
	};
	const queueDiagPath = join(qoderPluginDataDir(), "log", "queue.log");
	rotateQueueLog(queueDiagPath);
	const writeQueueDiag = (line) => {
		try {
			mkdirSync(dirname(queueDiagPath), { recursive: true });
			appendFileSync(queueDiagPath, `${(/* @__PURE__ */ new Date()).toISOString()} ${variant.id} ${line}\n`);
		} catch {}
	};
	const configuredQueueWaitMs = () => Math.max(1e3, (current().queueWaitSeconds ?? 540) * 1e3);
	const sessionOf = (id) => id === void 0 ? void 0 : ctx.get("sessions")?.get(id);
	const emitNotice = (sessionId, kind, text) => {
		dispatchJobTokenNotice({
			text,
			kind,
			sessionId,
			resolveSession: (id) => sessionOf(id)
		});
	};
	const transport = createQoderTransport({
		region: variant.region,
		resolvePat: () => store.patPromise(),
		queueWait: () => current().queueWait !== false,
		queueWaitBudgetMs: configuredQueueWaitMs,
		streamIdleTimeoutMs: Math.max(defaultStreamIdleTimeoutMs, configuredQueueWaitMs() + 6e4),
		resolveMachineId: () => getMachineId([qoderMachineIdPath()]),
		attachments,
		onDiag: writeQueueDiag,
		onJobTokenRefreshed: (info) => {
			jobTokenRefreshedAt = info.at;
			ctx.logger.warn(`dsh-qoder-connect: ${variant.displayName} job token was auto-refreshed after an upstream rejection`);
			emitNotice(info.sessionId, "success", jobTokenHintText(info.at));
		},
		onJobTokenRefreshFailed: (info) => {
			ctx.logger.warn(`dsh-qoder-connect: ${variant.displayName} job token refresh did not recover the chat (upstream status ${info.status ?? "unknown"})`);
			emitNotice(info.sessionId, "error", jobTokenRefreshFailedHintText(info.at));
		},
		createQueueWaitHandler: (options) => createQueueHint({
			sessionId: options.sessionId === void 0 ? void 0 : String(options.sessionId),
			purpose: options.purpose,
			displayName: variant.displayName,
			resolveSession: (id) => sessionOf(id),
			onDiag: writeQueueDiag
		}),
		createNoticeHandler: (options) => {
			const sessionId = options.sessionId === void 0 ? void 0 : String(options.sessionId);
			const purpose = options.purpose;
			return (notice) => {
				writeQueueDiag(`notice: ${notice.kind} (${notice.reason}) purpose=${purpose ?? "none"} sessionId=${sessionId ?? "none"}`);
				if (purpose === "session-title") return;
				const session = sessionOf(sessionId);
				if (session === void 0) return;
				emitNoticeRow(session, "error", purpose === "compaction" ? compactionFilteredHintText(notice.reason) : contentFilterHintText(notice.reason));
			};
		}
	});
	const client = new QoderUpstreamClient({
		region: variant.region,
		providerId: variant.id,
		getPat: () => store.patPromise(),
		transport,
		attachments
	});
	const fallback = fallbackFor(variant);
	const catalog = new QoderCatalog(fallback);
	const initial = current();
	if (variant.id !== CHINA_VARIANT.id) {
		catalog.setUseMaximumContextWindow(initial.useMaximumContextWindow === true);
		if (initial.disabledModels !== void 0) catalog.setDisabledModels(initial.disabledModels);
	} else {
		catalog.setUseMaximumContextWindow(initial.useMaximumContextWindowCN === true);
		if (initial.modelContextWindowsCN !== void 0) catalog.setModelContextWindows(initial.modelContextWindowsCN);
		if (initial.disabledModelsCN !== void 0) catalog.setDisabledModels(initial.disabledModelsCN);
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
		jobTokenRefreshedAt: () => jobTokenRefreshedAt,
		queueBudgetMs: configuredQueueWaitMs,
		diag: writeQueueDiag,
		checkIn: (signal) => transport.checkIn(signal)
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
* Whether a model can be probed by hand: it reasons and the upstream declares no
* effort set for it. Deliberately not filtered by whether a result already
* exists, so the list stays stable as use grows.
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
/** Timestamp format of a rotated queue log: `queue.20261021020410.log`. */
const QUEUE_LOG_ROTATED = /^queue\.\d{14}\.log$/u;
/**
* Archive the previous run's queue log and prune old archives.
*
* Runs once per process, not per plugin reload: the two variants share the file,
* and rolling on every reload would shred one run into several archives.
*/
function rotateQueueLog(logPath) {
	const marker = globalThis;
	if (marker.__qoderQueueLogRolled === true) return;
	marker.__qoderQueueLogRolled = true;
	try {
		const dir = dirname(logPath);
		mkdirSync(dir, { recursive: true });
		if (existsSync(logPath) && statSync(logPath).size > 0) {
			const now = /* @__PURE__ */ new Date();
			const stamp = [
				now.getFullYear(),
				String(now.getMonth() + 1).padStart(2, "0"),
				String(now.getDate()).padStart(2, "0"),
				String(now.getHours()).padStart(2, "0"),
				String(now.getMinutes()).padStart(2, "0"),
				String(now.getSeconds()).padStart(2, "0")
			].join("");
			copyFileSync(logPath, join(dir, `queue.${stamp}.log`));
			writeFileSync(logPath, "");
		}
		const cutoff = Date.now() - 6048e5;
		for (const name of readdirSync(dir)) {
			if (!QUEUE_LOG_ROTATED.test(name)) continue;
			const path = join(dir, name);
			if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
		}
	} catch {}
}
/**
* Run a detached promise without letting its failure kill the host: Node turns an
* unhandled rejection into process termination, so every fire-and-forget call
* carries a handler and a failure stays a diagnostic.
*/
function detach(ctx, work, what) {
	work.catch((error) => {
		ctx.logger.warn(`dsh-qoder-connect: ${what} failed`, error);
	});
}
/**
* Start one variant: its loopback endpoint, provider registration, and card
* wiring. Registration waits for the shim to hold a port, because the models read
* the shim origin at construction time; a failure stays contained to this variant.
*
* @param seedCatalog - adopt the current credential immediately (supplied by `apply`).
* @returns whether the provider registered.
*/
async function startVariant(ctx, runtime, seedCatalog) {
	const { variant, store, client, catalog, probeService } = runtime;
	const shim = createQoderShim({
		store,
		client,
		catalog,
		providerId: variant.id,
		logger: ctx.logger,
		onDiag: runtime.diag
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
			observe: (modelId) => probeService.recordFor(modelId),
			queueBudgetMs: runtime.queueBudgetMs
		});
		runtime.invalidate = () => {
			qoder.invalidate();
			ctx.emit("llm/adapters-updated");
		};
		let releaseAdapter;
		let releaseDirectory;
		try {
			releaseAdapter = ctx.llm.registerAdapter([variant.id], qoder.adapter);
			const settingsNs = ctx.fiber?.entry?.options?.id ?? variant.id;
			releaseDirectory = ctx.llm.registerConfigurableProviders([{
				provider: variant.id,
				displayName: variant.displayName,
				settingsNs,
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
		detach(ctx, seedCatalog(), `${variant.id} catalog seed`);
		return true;
	} catch (error) {
		ctx.logger.error(`dsh-qoder-connect: ${variant.displayName} provider registration failed`, error);
		detach(ctx, shim.close(), "loopback endpoint close");
		return false;
	}
}
/**
* State that MUST survive a fiber reload: the in-process control keys, minted once
* per process. A settings write re-runs `apply()` with a fresh closure, so a
* per-apply key would 403 every card and a per-apply identity map would re-fetch
* the catalog on every write.
*/
let processKeys;
function controlKeys() {
	processKeys ??= {
		probe: createProbeKey(),
		auth: createAuthKey()
	};
	return processKeys;
}
/** The loopback guard the probe and status routes use, restated for settings. */
function trustedSettingsRequest(req) {
	const host = req.headers.host ?? "";
	const origin = req.headers.origin;
	if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(host))) return false;
	return origin === void 0 || /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin));
}
/**
* The schema defaults, read off each field's own `meta.default` — the value
* schemastery itself substituted during validation. A hand-written table drifts,
* and `validate({})` answers hollow per-field values instead of the defaults.
*/
const DEFAULT_FOR_FIELD = (() => {
	const out = {};
	try {
		for (const [key, field] of Object.entries(Config.dict ?? {})) {
			const fallback = field?.meta?.default;
			if (fallback !== void 0) out[key] = fallback;
		}
	} catch {}
	if (Object.keys(out).length === 0) return {
		probeConsent: false,
		useMaximumContextWindow: true,
		useMaximumContextWindowCN: true,
		modelContextWindows: {},
		modelContextWindowsCN: {},
		disabledModels: [],
		disabledModelsCN: [],
		sidebarQuotaCN: false,
		sidebarQuotaGlobal: false,
		autoCheckInCN: false,
		autoCheckInGlobal: false,
		checkInMinuteCN: 600,
		checkInMinuteGlobal: 600,
		quotaPollMs: 3e5,
		queueWait: true,
		queueWaitSeconds: 540
	};
	return out;
})();
/**
* Register the settings face (GET/POST) the browser cards read and write through:
* `value` (the merged view the host reads), `user` (the settings file as stored,
* where presence marks an override), and `base`. A POST validates, writes,
* applies in memory, and re-arms the check-in scheduler.
*/
function registerQoderSettingsFace(ctx, deps) {
	const { store, config, current, apply, rearm } = deps;
	const key = controlKeys().probe;
	/** The document both routes answer with. */
	const view = () => {
		const merged = current();
		const value = {};
		const base = {};
		for (const field of CONFIG_KEYS) {
			if (merged[field] !== void 0) value[field] = merged[field];
			base[field] = readConfig(config)[field] ?? DEFAULT_FOR_FIELD[field];
		}
		return {
			key,
			value,
			base,
			user: store.values()
		};
	};
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: QODER_SETTINGS_FACE_PATH,
			handler: async (req, res) => {
				if (!trustedSettingsRequest(req)) {
					jsonFace(res, 403, { error: "request-not-trusted" });
					return;
				}
				if (req.method === "GET") {
					jsonFace(res, 200, view());
					return;
				}
				if (req.method !== "POST") {
					jsonFace(res, 405, { error: "method not allowed" });
					return;
				}
				if (req.headers["x-qoder-settings-key"] !== key) {
					jsonFace(res, 403, { error: "invalid-key" });
					return;
				}
				const body = await readFaceBody(req);
				if (body === void 0) {
					jsonFace(res, 413, { error: "body too large" });
					return;
				}
				let patch;
				try {
					patch = JSON.parse(body || "{}");
				} catch {
					jsonFace(res, 400, { error: "invalid json" });
					return;
				}
				if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
					jsonFace(res, 400, { error: "invalid patch" });
					return;
				}
				const invalid = validateSettingsPatch(patch);
				if (invalid !== void 0) {
					jsonFace(res, 400, { error: invalid });
					return;
				}
				store.patch(patch, true);
				apply(current());
				rearm();
				jsonFace(res, 200, view());
			}
		});
		return () => {
			dispose();
		};
	}, "dsh-qoder-connect: settings face");
}
/** JSON response helper for the settings face. */
function jsonFace(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(payload);
}
/** Read the request body, or undefined when absent or oversized. */
function readFaceBody(req) {
	return new Promise((resolve) => {
		let settled = false;
		let body = "";
		req.on("data", (chunk) => {
			if (settled) return;
			body += String(chunk);
			if (body.length > 1e6) {
				settled = true;
				body = "";
				req.destroy?.();
				resolve(void 0);
			}
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			resolve(body);
		});
		req.on("error", () => {
			if (settled) return;
			settled = true;
			resolve(void 0);
		});
	});
}
/** Schema-level validation of one settings patch; the reason, or undefined. */
function validateSettingsPatch(patch) {
	for (const [field, value] of Object.entries(patch)) {
		if (!CONFIG_KEYS.includes(field)) return `unknown field ${field}`;
		if (value === null) continue;
		switch (field) {
			case "probeConsent":
			case "useMaximumContextWindow":
			case "useMaximumContextWindowCN":
			case "sidebarQuotaCN":
			case "sidebarQuotaGlobal":
			case "autoCheckInCN":
			case "autoCheckInGlobal":
			case "queueWait":
				if (typeof value !== "boolean") return `${field} must be a boolean`;
				break;
			case "queueWaitSeconds":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return `${field} must be an integer of at least 1 second`;
				break;
			case "disabledModels":
			case "disabledModelsCN":
				if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return `${field} must be an array of strings`;
				break;
			case "checkInMinuteCN":
			case "checkInMinuteGlobal":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1439) return `${field} must be an integer minute 0..1439`;
				break;
			case "quotaPollMs":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 6e4) return `${field} must be an integer of at least 60000 ms`;
				break;
			case "modelContextWindows":
			case "modelContextWindowsCN": if (typeof value !== "object" || value === null || Array.isArray(value)) return `${field} must be an object`;
		}
	}
}
/**
* Delete this plugin's own fields from the profile entry config, leaving every
* other key untouched — one-time, right after the settings file is seeded, so no
* second source of truth remains. The write rides `configEditor`, probed on the
* plugin context first and on the settings service's owner context second.
*
* @param ownKeys - this plugin's declared config fields.
*/
async function cleanupEntryConfig(ctx, ownKeys) {
	const attempts = 10;
	for (let attempt = 0; attempt < attempts; attempt++) try {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2e3 + Math.random() * 1e3));
		const probe = ctx;
		const editor = (typeof probe.get === "function" ? (() => {
			try {
				return probe.get.call(ctx, "configEditor");
			} catch {
				return;
			}
		})() : void 0) ?? await new Promise((resolve) => {
			ctx.inject(["settings"], (settingsCtx) => {
				const owner = settingsCtx.settings?.ownerContext;
				resolve(typeof owner?.get === "function" ? (() => {
					try {
						return owner.get.call(owner, "configEditor");
					} catch {
						return;
					}
				})() : void 0);
			});
		});
		const entry = probe.fiber?.entry;
		if (editor !== void 0 && entry !== void 0) {
			await editor.edit(entry, (raw, inherited) => {
				const next = { ...inherited ?? {} };
				for (const [key, value] of Object.entries(raw ?? {})) {
					if (ownKeys.includes(key)) continue;
					if (!Object.hasOwn(next, key)) next[key] = value;
				}
				return next;
			});
			return;
		}
		return;
	} catch (error) {
		if (attempt === 9) {
			ctx.logger?.warn?.("dsh-qoder-connect: entry config cleanup failed", error);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1) + Math.random() * 500));
	}
}
/** The account identity each variant last published a catalog for, across reloads. */
const lastIdentities = /* @__PURE__ */ new Map();
/**
* When a variant's catalog was last fetched LIVE, per identity. Shared across
* reloads so the retry rule (`stale && due`) does not re-fetch on every settings
* write.
*/
const lastLiveFetchAt = /* @__PURE__ */ new Map();
/**
* Peers whose resolved copy decides whether this build can run.
*
* These three are the ones whose shapes this build's request path walks into:
* the provider seam, the adapter base, and the event stream the harness reads
* back. The other declared peers (`dsh-attachment`, `dsh-atomic-write`,
* `dsh-home-paths`, `schemastery`) are also imported, but they ride the host's
* version line and a mismatch there surfaces as a plain missing export at import
* time — a case this check cannot reach anyway, because ESM links before
* `apply()` runs. Listing them here would only produce false alarms for builds
* this plugin has no opinion about.
*
* The RANGES are read from this package's own `package.json`, so a version bump
* is one edit and the check can never disagree with what the manifest advertises.
*/
const CHECKED_PEERS = [
	"@deepseek-ai/dsh-llm",
	"@deepseek-ai/dsh-llm-pi-ai",
	"@earendil-works/pi-ai"
];
/**
* Read the checked peers' ranges from the manifest beside this build.
*
* @returns one expectation per peer that declares a string range; an unreadable
* manifest yields none, which simply skips the check rather than blocking a load
* on a fact it cannot establish.
* @internal Exported for tests.
*/
function peerExpectations() {
	let peers;
	try {
		peers = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).peerDependencies ?? {};
	} catch {
		return [];
	}
	return CHECKED_PEERS.flatMap((spec) => {
		const range = peers[spec];
		return typeof range === "string" ? [{
			spec,
			range
		}] : [];
	});
}
/** Parse a semver string into comparable parts; non-conforming input is null. */
function parseSemver(version) {
	if (typeof version !== "string") return null;
	const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		pre: m[4] !== void 0 ? m[4].split(".").map((id) => /^\d+$/.test(id) ? Number(id) : id) : null
	};
}
/** Full semver ordering: numeric fields, then pre-release tag rules. */
function compareSemver(a, b) {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	if (a.pre === null && b.pre === null) return 0;
	if (a.pre === null) return 1;
	if (b.pre === null) return -1;
	const len = Math.max(a.pre.length, b.pre.length);
	for (let i = 0; i < len; i++) {
		const x = a.pre[i];
		const y = b.pre[i];
		if (x === void 0) return -1;
		if (y === void 0) return 1;
		if (x === y) continue;
		const xNum = typeof x === "number";
		const yNum = typeof y === "number";
		if (xNum && yNum) return x - y;
		if (xNum) return -1;
		if (yNum) return 1;
		return x < y ? -1 : 1;
	}
	return 0;
}
/**
* Compare a resolved version to a declared bound.
*
* For a bound carrying no pre-release (`>=0.2.1`), compare only the three
* numeric fields: a `0.2.1-rc.x` resolved package counts as at-or-above the
* `0.2.1` floor — rc builds of this ecosystem carry the same API as the
* matching base release, so the build tag must not hide it.
* For a bound with a tag (`>=0.2.1-rc.1`), run the full semver comparison so
* `-alpha < -beta < -rc.1` orders correctly.
*/
function compareToBound(v, bound) {
	if (bound.pre === null) return compareCore(v, bound);
	return compareSemver(v, bound);
}
/** Numeric fields only, ignoring any pre-release tag on either side. */
function compareCore(a, b) {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}
/**
* Whether this checker can decide a range at all.
*
* Form alone is not enough: `~1`, `^1.2` and `>=abc` share the shape of a range
* this checker claims to enforce, yet its bound does not parse, so the
* comparison would pass everything without ever saying so. Callers use this to
* report the limit instead of enforcing nothing quietly.
*
* @internal Exported for tests.
*/
function supportsRange(range) {
	if (typeof range !== "string") return false;
	const m = range.trim().match(/^(?:>=|\^|~)\s*(\S+)$/);
	return m !== null && parseSemver(m[1]) !== null;
}
/**
* Compare a resolved package version against a semver range. `^x.y.z`, `~x.y.z`
* and `>=x.y.z` are enforced; every other form returns true, because a
* declaration this checker cannot express must not block a working install —
* callers report those forms rather than treating the pass as a verdict.
*
* @internal Exported for tests; the load-time check is the only caller.
*/
function satisfiesRange(version, range) {
	if (typeof range !== "string") return true;
	const trimmed = range.trim();
	const v = parseSemver(version);
	if (v === null) return true;
	let m = trimmed.match(/^>=\s*(\S+)$/);
	if (m) {
		const bound = parseSemver(m[1]);
		if (bound === null) return true;
		return compareToBound(v, bound) >= 0;
	}
	m = trimmed.match(/^~\s*(\S+)$/);
	if (m) {
		const bound = parseSemver(m[1]);
		if (bound === null) return true;
		if (compareToBound(v, bound) < 0) return false;
		return compareCore(v, {
			major: bound.major,
			minor: bound.minor + 1,
			patch: 0,
			pre: null
		}) < 0;
	}
	m = trimmed.match(/^\^\s*(\S+)$/);
	if (m) {
		const bound = parseSemver(m[1]);
		if (bound === null) return true;
		if (compareToBound(v, bound) < 0) return false;
		let upper;
		if (bound.major > 0) upper = {
			major: bound.major + 1,
			minor: 0,
			patch: 0,
			pre: null
		};
		else if (bound.minor > 0) upper = {
			major: 0,
			minor: bound.minor + 1,
			patch: 0,
			pre: null
		};
		else upper = {
			major: 0,
			minor: bound.minor,
			patch: bound.patch + 1,
			pre: null
		};
		return compareCore(v, upper) < 0;
	}
	return true;
}
/**
* The resolved peer's version, read through the resolver this module's own
* imports use.
*
* The resolver's parent is this module, which is exactly the parent its static
* imports carry — so the entry found here is the copy Node loads, whatever the
* install shape (a plain `node_modules`, a pnpm store, an `app.asar` the
* Electron fs patch opens). Reading the filesystem instead would answer a
* different question: which copy happens to sit on disk.
*
* @param spec - the peer specifier as declared in `peerDependencies`.
* @param resolveEntry - injectable resolver for tests.
* @returns the version, or undefined when the copy cannot be named — that
*   absence is no verdict, only missing evidence.
*/
function readResolvedVersion(spec, resolveEntry = (specifier) => import.meta.resolve(specifier)) {
	let entry;
	try {
		entry = fileURLToPath(resolveEntry(spec));
	} catch {
		return;
	}
	for (let dir = dirname(entry);; dir = dirname(dir)) {
		const pj = join(dir, "package.json");
		if (existsSync(pj)) try {
			const parsed = JSON.parse(readFileSync(pj, "utf8"));
			if (parsed.name === spec) return typeof parsed.version === "string" ? parsed.version : void 0;
		} catch {}
		if (basename(dir) === "node_modules" || dir === dirname(dir)) return void 0;
	}
}
/**
* Report the first peer the host loads below its declared floor.
*
* Only a proven mismatch refuses the load. A peer whose copy cannot be resolved
* or read is reported as unverified instead: the static imports already linked,
* so the host supplied a working copy and failing here would refuse every clean
* install. Unverified peers still have to reach the card, or a check that quietly
* stopped enforcing would look like one that passed.
*
* @param expectations - peers to check, in report order.
* @param warn - sink for a range it cannot interpret.
* @param resolveEntry - injectable resolver for tests.
* @internal Exported for tests.
*/
function peerVersionFailure(expectations = peerExpectations(), warn, resolveEntry) {
	const unverified = [];
	for (const { spec, range } of expectations) {
		const version = readResolvedVersion(spec, resolveEntry);
		if (version === void 0) {
			unverified.push(spec);
			continue;
		}
		if (!supportsRange(range)) {
			warn?.(`dsh-qoder-connect: cannot interpret the range "${range}" declared for ${spec}; that peer is not enforced`);
			continue;
		}
		if (!satisfiesRange(version, range)) return {
			failure: `${spec}@${range} is required, but the copy this host loads resolves to ${version}; rebuild the profile dependency tree or update that package`,
			unverified
		};
	}
	return { unverified };
}
function apply(ctx, config) {
	const profileContext = ctx.get("profileContext");
	configurePluginPaths({
		profileDir: profileContext?.dir,
		diagnostics: ctx.logger
	});
	const peerCheck = peerVersionFailure(peerExpectations(), (message) => {
		ctx.logger.warn(message);
	});
	if (peerCheck.failure !== void 0) {
		const message = `dsh-qoder-connect: ${peerCheck.failure}`;
		ctx.logger.warn(message);
		ctx.inject(["webServer"], (webCtx) => {
			for (const variant of QODER_VARIANTS) registerInactiveStatusRoute(webCtx, variant.statusPath, message);
		});
		return;
	}
	const peerCheckSkipped = peerCheck.unverified.length === 0 ? void 0 : `could not determine the version of ${peerCheck.unverified.join(", ")}`;
	if (peerCheckSkipped !== void 0) ctx.logger.warn(`dsh-qoder-connect: ${peerCheckSkipped}`);
	const store = new SettingsStore();
	let current = () => ({
		...readConfig(config),
		...store.values()
	});
	/**
	* One-time seed, per field: the file never held it — take the entry; the entry
	* carries a NON-DEFAULT value — take the entry; otherwise keep the file. The
	* default-skipping clause is load-bearing — once cleanup has emptied the entry
	* row, treating its pure defaults as authoritative would erase the user's
	* values. Re-checked on every apply, which also closes the volatile commit
	* timing window; when the entry wins, its own fields are deleted from the row.
	*/
	const migrateOwnSettings = () => {
		const seeded = {};
		for (const key of CONFIG_KEYS) {
			const entryValue = readField(config, key);
			if (!Object.hasOwn(store.user, key)) {
				if (entryValue !== void 0 && JSON.stringify(entryValue) !== JSON.stringify(DEFAULT_FOR_FIELD[key])) seeded[key] = entryValue;
				else if (entryValue !== void 0) seeded[key] = entryValue;
				continue;
			}
			if (store.edited) continue;
			if (entryValue !== void 0 && JSON.stringify(entryValue) !== JSON.stringify(DEFAULT_FOR_FIELD[key])) seeded[key] = entryValue;
		}
		if (Object.keys(seeded).length === 0) return;
		store.patch(seeded);
		cleanupEntryConfig(ctx, CONFIG_KEYS);
	};
	migrateOwnSettings();
	ctx.on("loader/volatile-update", () => {
		migrateOwnSettings();
	});
	/** Timers and in-flight work belonging to this plugin instance. */
	let stopped = false;
	const timers = [];
	const runtimes = QODER_VARIANTS.map((variant) => createVariantRuntime(ctx, config, variant, () => current(), (id) => lastIdentities.get(id)));
	const checkInStore = new JsonFileCheckInStore();
	const checkInScheduler = new CheckInScheduler({
		targets: runtimes.map((runtime) => ({
			variantId: runtime.variant.id,
			checkIn: (signal) => runtime.checkIn(signal),
			minuteOfDay: () => {
				const cfg = current();
				return normalizeCheckInMinute((runtime.variant.id === CHINA_VARIANT.id ? cfg.checkInMinuteCN : cfg.checkInMinuteGlobal) ?? 600);
			},
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
	/**
	* The startup catch-up, re-run once from the settings source callback:
	* `start()` above runs while the plugin is still assembling, before the section
	* holding these toggles hands over its values, so that sweep skips the day.
	*/
	let startupCatchUpDone = false;
	const runStartupCatchUpOnce = () => {
		if (startupCatchUpDone) return;
		startupCatchUpDone = true;
		checkInScheduler.catchUp();
	};
	const { probe: probeKey, auth: authKey } = controlKeys();
	let setMaximumContextWindow;
	let setMaximumContextWindowCN;
	let setModelsEnabled;
	let setModelsEnabledCN;
	/**
	* Point a variant at an account identity, invalidating whatever the previous
	* one left behind. One helper for every transition (sweep, manual refresh, card
	* save), so none can forget a step; each bumps
	* {@link VariantRuntime.catalogGeneration}, which makes an in-flight request from
	* before the change refuse to write back. Probe observations are dropped
	* whenever the account actually changes, but never on a first sign-in.
	*
	* @param identity - the account now in effect, or `undefined` when signed out.
	*/
	const adoptIdentity = (runtime, identity) => {
		const id = runtime.variant.id;
		const known = lastIdentities.get(id);
		if (known === identity && runtime.catalog.isVisible()) return;
		const hadCredential = known !== void 0;
		if (identity === void 0) lastIdentities.delete(id);
		else lastIdentities.set(id, identity);
		runtime.catalogGeneration += 1;
		runtime.inflightFetch?.controller.abort();
		runtime.inflightFetch = void 0;
		if (hadCredential && known !== identity) runtime.invalidate();
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
	/**
	* Apply catalog preferences from a configuration view, in memory. Shared by the
	* probe-route setters and the settings face's POST.
	*/
	const applyCatalogSettings = (next) => {
		let changed = false;
		for (const runtime of runtimes) {
			const isChina = runtime.variant.id === CHINA_VARIANT.id;
			const preference = isChina ? next.useMaximumContextWindowCN : next.useMaximumContextWindow;
			if (runtime.catalog.setUseMaximumContextWindow(preference === true)) changed = true;
			const overrides = isChina ? next.modelContextWindowsCN : next.modelContextWindows;
			if (overrides !== void 0 && runtime.catalog.setModelContextWindows(overrides)) changed = true;
			const disabled = isChina ? next.disabledModelsCN : next.disabledModels;
			if (runtime.catalog.setDisabledModels(disabled ?? [])) changed = true;
		}
		if (changed) for (const runtime of runtimes) runtime.invalidate();
	};
	ctx.inject(["webServer"], (webCtx) => {
		for (const runtime of runtimes) {
			registerQoderStatusRoute(webCtx, {
				path: runtime.variant.statusPath,
				store: runtime.store,
				client: runtime.client,
				models: () => runtime.catalog.all(),
				catalog: () => catalogSection(runtime),
				probe: () => probeSection(runtime, current().probeConsent === true),
				probeKey,
				authKey,
				...runtime.variant.id === CHINA_VARIANT.id ? {
					useMaximumContextWindow: () => current().useMaximumContextWindowCN === true,
					disabledModels: () => current().disabledModelsCN ?? []
				} : {
					useMaximumContextWindow: () => current().useMaximumContextWindow === true,
					disabledModels: () => current().disabledModels ?? []
				},
				jobTokenRefreshedAt: runtime.jobTokenRefreshedAt,
				...peerCheckSkipped === void 0 ? {} : { peerCheckSkipped: () => peerCheckSkipped },
				checkIn: () => {
					const record = checkInStore.read(runtime.variant.id);
					if (record === void 0) return void 0;
					const nextRunAt = checkInScheduler.nextRunAt(runtime.variant.id);
					return {
						...record,
						...nextRunAt === void 0 ? {} : { nextRunAt }
					};
				}
			});
			registerQoderAuthRoute(webCtx, {
				path: runtime.variant.authPath,
				save: async (pat, label) => {
					if (!await validateApiKey(pat, runtime.variant.region)) return {
						ok: false,
						error: "qoder_invalid_pat"
					};
					const entry = await runtime.store.add(pat, label);
					const identity = credentialIdentity(entry);
					adoptIdentity(runtime, identity);
					await fetchCatalog(runtime, identity);
					return {
						ok: true,
						status: await runtime.store.status()
					};
				},
				activate: async (id) => {
					const entry = await runtime.store.activate(id);
					if (entry === void 0) return {
						ok: false,
						error: "qoder_unknown_pat"
					};
					const identity = credentialIdentity(entry);
					adoptIdentity(runtime, identity);
					detach(ctx, fetchCatalog(runtime, identity), `${runtime.variant.id} catalog refresh after switch`);
					return {
						ok: true,
						status: await runtime.store.status()
					};
				},
				remove: async (id) => {
					const removed = await runtime.store.remove(id);
					if (removed === void 0) return {
						ok: false,
						error: "qoder_unknown_pat"
					};
					const finished = credentialIdentity(removed);
					runtime.probeStore.clearFor(finished);
					runtime.savedCatalogs.delete(finished);
					const active = await runtime.store.current().catch(() => void 0);
					const identity = active === void 0 ? void 0 : credentialIdentity(active);
					adoptIdentity(runtime, identity);
					if (identity !== void 0) detach(ctx, fetchCatalog(runtime, identity), `${runtime.variant.id} catalog refresh after removal`);
					return {
						ok: true,
						status: await runtime.store.status()
					};
				},
				clear: async () => {
					const saved = await runtime.store.entries().catch(() => []);
					for (const entry of saved) {
						const identity = credentialIdentity(entry);
						runtime.probeStore.clearFor(identity);
						runtime.savedCatalogs.delete(identity);
					}
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
					const result = await runtime.checkIn();
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
				...runtime.variant.id === CHINA_VARIANT.id ? {
					setMaximumContextWindow: async (enabled) => {
						if (setMaximumContextWindowCN === void 0) return {
							state: "failed",
							reason: "settings are unavailable"
						};
						return setMaximumContextWindowCN(enabled);
					},
					setModelsEnabled: async (opts) => {
						if (setModelsEnabledCN === void 0) return {
							state: "failed",
							reason: "settings are unavailable"
						};
						return setModelsEnabledCN(opts);
					}
				} : {
					setMaximumContextWindow: async (enabled) => {
						if (setMaximumContextWindow === void 0) return {
							state: "failed",
							reason: "settings are unavailable"
						};
						return setMaximumContextWindow(enabled);
					},
					setModelsEnabled: async (opts) => {
						if (setModelsEnabled === void 0) return {
							state: "failed",
							reason: "settings are unavailable"
						};
						return setModelsEnabled(opts);
					}
				}
			}, probeKey);
		}
		registerQoderSettingsFace(webCtx, {
			store,
			config,
			current,
			apply: applyCatalogSettings,
			rearm: () => {
				runStartupCatchUpOnce();
				checkInScheduler.rearm();
			}
		});
	});
	ctx.inject(["settings"], (settingsCtx) => {
		/**
		* `auto: false` turns OFF the host's generated form page for this entry (the
		* plugin ships its own card). It must be called as a METHOD: `configure` reads
		* `this`, so extracting it as a free function throws.
		*/
		const settingsService = settingsCtx.settings;
		if (typeof settingsService.configure === "function") try {
			settingsCtx.effect(() => {
				const dispose = settingsService.configure({ auto: false }, ctx.fiber);
				return typeof dispose === "function" ? dispose : () => {};
			});
		} catch (error) {
			console.error("[dsh-qoder-connect] settings.configure failed (own settings file still serves):", error);
		}
		/**
		* One implementation on both hosts: write the plugin-owned settings file, then
		* apply the new view in memory — no profile patch, no fiber reload.
		*/
		const write = (patch) => {
			store.patch(patch, true);
			applyCatalogSettings(current());
			checkInScheduler.rearm();
		};
		setMaximumContextWindow = async (enabled) => {
			write({ useMaximumContextWindow: enabled });
			return { state: "updated" };
		};
		setMaximumContextWindowCN = async (enabled) => {
			write({ useMaximumContextWindowCN: enabled });
			return { state: "updated" };
		};
		setModelsEnabled = async ({ models, enabled }) => {
			const currentDisabled = new Set(readConfigField(current(), "disabledModels") ?? []);
			for (const m of models) if (enabled) currentDisabled.delete(m);
			else currentDisabled.add(m);
			write({ disabledModels: Array.from(currentDisabled) });
			return { state: "updated" };
		};
		setModelsEnabledCN = async ({ models, enabled }) => {
			const currentDisabled = new Set(readConfigField(current(), "disabledModelsCN") ?? []);
			for (const m of models) if (enabled) currentDisabled.delete(m);
			else currentDisabled.add(m);
			write({ disabledModelsCN: Array.from(currentDisabled) });
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
	* Fetch one variant's catalog for the current credential, shared by the sweep and
	* the card's manual refresh. One request at a time (a second caller joins the
	* in-flight fetch); the write is generation-checked, so a late answer from a
	* superseded account changes nothing; and it calls `resolve()` rather than
	* `current()` so a missing token surfaces as `MISSING_CREDENTIAL`.
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
			lastLiveFetchAt.set(identity, runtime.lastFetchAtMs);
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
	* Reconcile one variant with its credentials: reveal the group and fetch a
	* catalog on a first sighting, hide it when signed out, and do nothing when the
	* identity is unchanged (a PAT neither rotates nor expires).
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
			const fetchedAt = lastLiveFetchAt.get(identity) ?? 0;
			const due = Date.now() - fetchedAt >= credentialPollMs() * CATALOG_RETRY_SWEEPS;
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
	* Start both variants, then begin the credential sweep. The chain carries its own
	* failure handler: an unhandled rejection here would terminate the host.
	*/
	detach(ctx, Promise.all(runtimes.map(async (runtime) => startVariant(ctx, runtime, async () => {
		if (stopped) return;
		let credential;
		try {
			credential = await runtime.store.current();
		} catch {
			return;
		}
		if (credential === void 0) return;
		const identity = credentialIdentity(credential);
		if (lastIdentities.get(runtime.variant.id) !== identity || !runtime.catalog.isVisible()) adoptIdentity(runtime, identity);
	}))).then(() => {
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
export { CHINA_VARIANT, CN_SECTION_KEYS, Config, FALLBACK_QODER_MODELS, GLOBAL_SECTION_KEYS, GLOBAL_VARIANT, KIND_STATUS, PROBE_EFFORT_CANDIDATES, QODER_AUTH_FILENAME, QODER_AUTH_PATH, QODER_DATA_DIR_ENV, QODER_DATA_DIR_NAME, QODER_GLOBAL_AUTH_PATH, QODER_GLOBAL_PROBE_PATH, QODER_GLOBAL_SETTINGS_NS, QODER_GLOBAL_STATUS_PATH, QODER_HOST_HEARTBEAT_FILENAME, QODER_PAT_ENV_CN, QODER_PAT_ENV_GLOBAL, QODER_PROBE_FILENAME, QODER_PROBE_PATH, QODER_PROVIDER, QODER_QUOTA_SETTINGS_NS, QODER_SETTINGS_NS, QODER_STATUS_PATH, QODER_STREAM_IDLE_TIMEOUT_MS, QODER_VARIANTS, QUEUE_WAIT_SECONDS_DEFAULT, QUEUE_WAIT_SECONDS_MIN, QUOTA_POLL_DEFAULT_MS, QUOTA_POLL_MIN_MS, QUOTA_SECTION_KEYS, QoderCatalog, QoderCatalogStore, QoderCredentialStore, QoderProbeService, QoderProbeStore, QoderUpstreamClient, apply, classifyUpstreamError, clearHostHeartbeat, createAuthKey, createQoderAdapter, createQoderShim, fingerprintModel, inject, isHeartbeatProcessAlive, kindFromQoderFailure, modelInfoOf, name, normalizeCredits, patTail, peerExpectations, peerVersionFailure, probeModel, qoderAuthHandler, qoderCatalogPath, qoderCredentialId, qoderCredentialIdentity, qoderHostHeartbeatPath, qoderOwnAuthPath, qoderPluginDataDir, qoderProbePath, randomSentinel, readHostHeartbeat, registerQoderAuthRoute, satisfiesRange, supportsRange, variantFor };
