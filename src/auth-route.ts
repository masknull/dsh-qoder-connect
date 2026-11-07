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

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { QODER_AUTH_PATH } from './status-paths.ts'
import type { QoderAuthRequest } from './status-paths.ts'
import type { QoderAuthStatus } from './auth.ts'

/** Largest control body accepted; a Personal Access Token is a short string. */
const MAX_BODY_BYTES = 16 * 1024

/** Outcome of a save/activate/remove attempt: stored, or refused with a stable reason. */
export type QoderAuthSaveResult =
  | { ok: true; status: QoderAuthStatus; warning?: 'qoder_no_models' }
  | { ok: false; error: 'qoder_invalid_pat' | 'qoder_missing_pat' | 'qoder_unknown_pat' | 'qoder_unreachable' }

/** Constructor dependencies. */
export interface QoderAuthRouteOptions {
  /**
   * Validate one pasted token against this variant's region and, only on
   * success, persist it and make it active. The route never decides validity
   * itself.
   */
  save: (pat: string, label?: string) => Promise<QoderAuthSaveResult>
  /** Switch to one already-saved token. */
  activate: (id: string) => Promise<QoderAuthSaveResult>
  /** Remove one saved token; the host moves the active pointer. */
  remove: (id: string) => Promise<QoderAuthSaveResult>
  /** Remove every saved token (`logout`). */
  clear: () => Promise<void>
  /**
   * Route path to mount. Defaults to the China variant's path; the global variant
   * passes its own.
   */
  path?: string
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Read the request body with a hard ceiling. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse and shape-check a PAT request; unknown fields are ignored, not trusted. */
function parseRequest(text: string): QoderAuthRequest | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const wrapped = parsed as Record<string, unknown>
  const action = wrapped['action']
  if (action === 'clear') return { action }
  if (action === 'save-pat') {
    const pat = wrapped['pat']
    if (typeof pat !== 'string' || pat.trim() === '') return undefined
    const label = wrapped['label']
    // A label is display copy, never a credential: a short string or nothing.
    if (label !== undefined && (typeof label !== 'string' || label.length > 200)) return undefined
    return { action, pat, ...label === undefined ? {} : { label } }
  }
  if (action === 'activate' || action === 'remove') {
    const id = wrapped['id']
    if (typeof id !== 'string' || id.trim() === '') return undefined
    return { action, id: id.trim() }
  }
  return undefined
}

/**
 * Strip token-like content from a message before it reaches the browser.
 *
 * A validation error body is the one input here that is not the plugin's own
 * prose, so this keeps a credential from crossing into the card.
 */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

/** Mint the per-process PAT control key. */
export function createAuthKey(): string {
  return randomBytes(24).toString('hex')
}

/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The PAT route's handler, extracted so tests can mount it on a bare server with a
 * known key.
 *
 * @param deps - the save/activate/remove/clear operations for one variant.
 * @param key - the in-process control key this route requires.
 * @returns the Node request handler.
 */
export function qoderAuthHandler(
  deps: QoderAuthRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(key, req.headers['x-qoder-auth-key'] as string | undefined)) {
      json(res, 403, { error: 'invalid-auth-key' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      json(res, 413, { error: 'body too large' })
      return
    }
    const request = parseRequest(body)
    if (request === undefined) {
      json(res, 400, { error: 'invalid action' })
      return
    }
    try {
      if (request.action === 'clear') {
        await deps.clear()
        json(res, 200, { ok: true })
        return
      }
      // A refused token is an answer, not a transport failure: the card reads the
      // stable `qoder_invalid_pat` / `qoder_unknown_pat` code and re-prompts, so
      // both outcomes travel as 200 with `ok` carrying the verdict.
      if (request.action === 'activate') {
        json(res, 200, await deps.activate(request.id as string))
        return
      }
      if (request.action === 'remove') {
        json(res, 200, await deps.remove(request.id as string))
        return
      }
      json(res, 200, await deps.save(request.pat as string, request.label))
    } catch (error: unknown) {
      json(res, 200, { ok: false, error: safeMessage(error) })
    }
  }
}

/** Mount the POST PAT route on an optional webServer context. */
export function registerQoderAuthRoute(
  ctx: Context,
  deps: QoderAuthRouteOptions,
  key: string,
): void {
  const path = deps.path ?? QODER_AUTH_PATH
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: qoderAuthHandler(deps, key),
    })
    return () => {
      dispose()
    }
  }, 'dsh-qoder-connect: PAT route')
}
