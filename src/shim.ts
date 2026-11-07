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

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { QoderCredentialStore } from './auth.ts'
import type { QoderCatalog } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { KIND_STATUS, type QoderChatResult, type QoderUpstreamClient } from './upstream.ts'
import { QODER_PURPOSE_HEADER, QODER_SESSION_HEADER, QODER_TURN_HEADER, readQoderPurposeHeader, readQoderSessionHeader, readQoderTurnHeader } from './request-session.ts'

/** Minimal logger surface the plugin context already provides. */
export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface QoderShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the shim resolves the
   * real credential itself via the store.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface QoderShimOptions {
  store: QoderCredentialStore
  client: Pick<QoderUpstreamClient, 'chatStream'>
  catalog: QoderCatalog
  /** Provider id reported as each model's `owned_by`; one per variant. */
  providerId: string
  logger?: ShimLogger
  /**
   * Override of the pending-answer keep-alive interval. Only tests shorten it;
   * production always keeps the default, which is what the client's body clock
   * leaves room for.
   */
  keepAliveMs?: number
  /**
   * How long a failure may still arrive as its real HTTP status before the stream
   * head is committed. Only tests shorten it; see {@link STREAM_GRACE_MS}.
   */
  graceMs?: number
  /**
   * One-line diagnostic sink. The queue log the user can hand back is the only
   * place that records when a head was committed or an answer abandoned, which is
   * what separates a client-side clock from an upstream stall.
   */
  onDiag?: (message: string) => void
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}

/**
 * The prefix the shim stamps onto a failure message carrying an upstream retry
 * hint.
 *
 * The hint must cross two text-only boundaries to reach the harness retry policy,
 * so the marker is written in front of the 400-byte excerpt (never inside it,
 * where truncation could cut it off) and read back by {@link retryAfterFromMessage}.
 */
export const RETRY_AFTER_TAG = /\[retry-after=(\d+)s\]/u

/**
 * The upstream's retry hint, in milliseconds, recovered from a shim failure
 * message.
 *
 * The tagged form is the contract this plugin writes itself; the untagged
 * `retryAfterSeconds` form is the fallback for a message composed elsewhere.
 */
export function retryAfterFromMessage(message: string): number | undefined {
  const tagged = RETRY_AFTER_TAG.exec(message)
  if (tagged !== null) {
    const seconds = Number(tagged[1])
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
  }
  const body = /"retryAfterSeconds"\s*:\s*(\d+)/u.exec(message)
  if (body !== null) {
    const seconds = Number(body[1])
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
  }
  return undefined
}

/**
 * Seconds an OpenAI `Retry-After` header carries: the ceiling of the hint, so a
 * client that honors it never returns before the upstream's window closed.
 */
function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000))
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string, retryAfterMs?: number): void {
  const hint = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.floor(retryAfterMs)
    : undefined
  if (hint === undefined) {
    writeJson(res, status, { error: { message, type: kind, code: kind } })
    return
  }
  const seconds = retryAfterSeconds(hint)
  writeJson(
    res,
    status,
    { error: { message: `[retry-after=${seconds}s] ${message}`, type: kind, code: kind } },
    // `Retry-After` is the standard (RFC 9110, whole seconds); `retry-after-ms` is
    // what the OpenAI SDKs read first. The harness adapter reads the tag above,
    // but any other client of this endpoint gets the standard answer.
    { 'Retry-After': String(seconds), 'retry-after-ms': String(hint) },
  )
}

/**
 * Interval of the SSE comment written while an upstream answer is pending.
 *
 * The client reads the body through undici, whose `bodyTimeout` defaults to 300 s
 * of silence; the interval must stay far below it so a multi-minute queue wait is
 * never mistaken for a dead connection.
 */
const STREAM_KEEPALIVE_MS = 15_000

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
const STREAM_GRACE_MS = 5_000

/**
 * How long a closing shim waits for an in-flight answer before dropping it.
 *
 * A queue wait can last minutes; disposal must not. This only has to cover an
 * answer that is nearly finished, which is the only one worth saving.
 */
const CLOSE_GRACE_MS = 1_500

/**
 * Head of a streamed answer; sent once the answer turns slow.
 *
 * `Connection: close` is deliberate: this hop carries one answer per turn over
 * loopback, and a socket the server half-closed is exactly what a client reports
 * as a terminated connection. Closing after each answer costs one TCP connect and
 * removes that class outright.
 */
const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'close',
  'X-Accel-Buffering': 'no',
} as const

/**
 * Send the streaming head, exactly once.
 *
 * @param res - the response to commit.
 */
function writeStreamHead(res: ServerResponse): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  res.writeHead(200, STREAM_HEADERS)
  // Without an explicit flush the head waits for the first body write, which is
  // exactly the silence this exists to remove.
  res.flushHeaders()
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
function beginKeepAlive(res: ServerResponse, keepAliveMs: number): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return
    try {
      res.write(': keep-alive\n\n')
    } catch {
      // A client that went away is reported by `close`, not here.
    }
  }, keepAliveMs)
  // A pending keep-alive must never hold the process open.
  timer.unref?.()
  return () => clearInterval(timer)
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
function writeStreamError(res: ServerResponse, kind: string, message: string, retryAfterMs?: number): void {
  if (res.writableEnded || res.destroyed) return
  const hint = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.floor(retryAfterMs)
    : undefined
  const text = hint === undefined
    ? message
    : `[retry-after=${retryAfterSeconds(hint)}s] ${message}`
  res.write(`data: ${JSON.stringify({ error: { message: text, type: kind, code: kind } })}\n\n`)
  // The SDK throws on the frame above; the sentinel covers any client that does not.
  res.write('data: [DONE]\n\n')
  res.end()
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Start the loopback endpoint. The upstream credential comes from the store alone;
 * the bearer checked is the per-process shared secret.
 */
export function createQoderShim(options: QoderShimOptions): QoderShim {
  const { store, client, catalog } = options
  const logger = options.logger
  const providerId = options.providerId
  const keepAliveMs = options.keepAliveMs ?? STREAM_KEEPALIVE_MS
  const graceMs = options.graceMs ?? STREAM_GRACE_MS
  const diag = (message: string): void => {
    try {
      options.onDiag?.(message)
    } catch {
      // Diagnostics only; never affect the chat.
    }
  }

  // Per-process shared secret. Lives only in memory; the adapter resolves it as
  // the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`. It is
  // never forwarded upstream — the real credential comes from the store.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const expected = SHARED_SECRET
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    // `handle` contains its own failures, but the attempt is wrapped once more: an
    // escaped rejection is an unhandled rejection, which Node turns into process
    // termination.
    void handle(req, res).catch((error: unknown) => {
      logger?.warn('dsh-qoder-connect: loopback request failed', error)
      try {
        // Last resort: `handle` already reports its own failures in-band, so only a
        // throw from that path (or from the reporting itself) lands here.
        if (!res.headersSent) writeOpenAIError(res, 500, 'internal', 'loopback request failed')
        else writeStreamError(res, 'internal', 'loopback request failed')
      } catch {
        // The socket is already gone; nothing left to report to.
      }
    })
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error(`${providerId} shim has no listening address`)
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Inbound hardening: every request must name the loopback host, and
      // browser-sent origins must be loopback too.
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: providerId,
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
        return
      }
      // The head is often committed before the upstream answer exists, so this is
      // the ONLY place an escaped failure can still reach the client. Ending the
      // body here instead would read as a truncated answer, which the harness
      // reports as a transport error far from the cause.
      logger?.warn('dsh-qoder-connect: loopback request failed after the stream head', error)
      writeStreamError(res, 'internal', 'loopback request failed')
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    // Fail before reading a body the upstream can never accept: no stored or
    // environmental token means nothing here can answer.
    try {
      await store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, KIND_STATUS.missing_credential, 'not_signed_in', String(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')

    const controller = new AbortController()
    const startedAt = performance.now()
    // The response closing before it ends is the client going away — a stopped
    // turn. Listening on the request instead would fire as soon as its body was
    // read, which is not a cancellation.
    res.on('close', () => {
      if (res.writableEnded) return
      // A stopped turn is routine, so this stays in the hand-back log rather than
      // the host's warning stream: the elapsed time and head state are what tell a
      // client-side stop apart from this side's clock, and they are only ever read
      // while diagnosing a wait that ended early.
      const elapsedMs = Math.round(performance.now() - startedAt)
      diag(`chat: client closed the answer after ${elapsedMs}ms (headCommitted=${res.headersSent})`)
      controller.abort('client closed the response')
    })
    const sessionId = readQoderSessionHeader(req.headers[QODER_SESSION_HEADER])
    const purpose = readQoderPurposeHeader(req.headers[QODER_PURPOSE_HEADER])
    // The agent run the adapter resolved from this request's durable messages;
    // this hop only ever sees OpenAI-shaped JSON, which no longer carries them.
    const turn = readQoderTurnHeader(req.headers[QODER_TURN_HEADER])

    /**
     * Commit the streaming head — once, and only if the answer turns slow.
     *
     * A fast failure keeps its status line (and its standard retry headers); a
     * slow one gets a committed 200 and keep-alive comments so a queue wait never
     * looks like a dead connection. See {@link STREAM_GRACE_MS}.
     */
    let stopKeepAlive: (() => void) | undefined
    const keepAlive = (): void => {
      if (res.writableEnded || res.destroyed) return
      stopKeepAlive ??= beginKeepAlive(res, keepAliveMs)
    }
    const stopHead = (): void => {
      stopKeepAlive?.()
      stopKeepAlive = undefined
    }
    const grace = setTimeout(() => {
      if (res.headersSent) return
      writeStreamHead(res)
      keepAlive()
      diag(`chat: head committed after ${graceMs}ms without an upstream answer`)
    }, graceMs)
    // A pending grace must never hold the process open.
    grace.unref?.()

    let result: QoderChatResult
    try {
      result = await client.chatStream(raw, controller.signal, sessionId, purpose, turn)
    } finally {
      clearTimeout(grace)
    }

    if (!result.ok) {
      stopHead()
      // The message quotes the shim's OUTBOUND status, never the upstream's
      // internal one: the harness's pi-ai error classifier matches 401/403/429 in
      // the message text, so quoting an upstream 403 here would report a queue
      // answer as a credential failure. The real status travels in the status line
      // (fast failures) or in the structured `code` (once the head is committed).
      const message = `${providerId} upstream ${result.kind} (http ${KIND_STATUS[result.kind]}): ${result.message.slice(0, 400)}`
      if (!res.headersSent) {
        writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, message, result.retryAfterMs)
        return
      }
      writeStreamError(res, result.kind, message, result.retryAfterMs)
      return
    }

    // The head may already be out (the answer turned slow); otherwise this is the
    // ordinary streaming path. Either way the comments keep running until the
    // upstream's first byte arrives.
    writeStreamHead(res)
    keepAlive()

    let sawDone = false
    let forwardedChunks = 0
    const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      forwardedChunks += 1
      // Real bytes are flowing: the keep-alive comments are no longer needed, and
      // from here on the body itself keeps the client's clock alive. Until the
      // first one arrives they stay, so a model that thinks for minutes before its
      // first token does not look like a dead connection.
      if (forwardedChunks === 1) stopHead()
      if (chunk.includes('[DONE]')) sawDone = true
    })
    body.on('end', stopHead)
    body.on('close', stopHead)
    body.on('error', (error: unknown) => {
      stopHead()
      logger?.warn('dsh-qoder-connect: upstream stream failed mid-flight', error)
      if (sawDone || !res.writable) return
      if (forwardedChunks === 0) {
        // Nothing reached the client, so this is not a truncated answer but a
        // failure that never started. Ending quietly would leave the harness to
        // explain it as EMPTY_RESPONSE; the in-band frame names the cause, and its
        // "ended without" wording keeps the classified code at TRANSPORT.
        writeStreamError(res, 'transport', `${providerId} upstream stream ended without any data (${String((error as Error)?.message ?? error)})`)
        return
      }
      // Part of the answer is already out: completing the envelope keeps that text
      // rather than replacing it with a failure. The interruption is logged, never
      // claimed to be a clean end.
      res.end('data: [DONE]\n\n')
    })
    body.pipe(res)
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // Graceful first: a settings write hot-reloads the plugin, and destroying an
      // in-flight answer makes the harness report a terminated connection far from
      // the cause. `close` stops accepting and drops idle sockets on its own; the
      // timer is the hard bound so disposal can never hang on a queue wait.
      const hardStop = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS)
      hardStop.unref?.()
      server.close(() => {
        clearTimeout(hardStop)
        resolve()
      })
    }),
  }
}
