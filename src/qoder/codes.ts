/**
 * Qoder's documented result error codes, and the reader that finds one in a
 * rejection body.
 *
 * @module dsh-qoder-connect/qoder/codes
 */

/**
 * What a documented code means for routing.
 *
 * `quota` is the only family this module changes routing for: every other
 * family is already read correctly from the HTTP status (see
 * `qoderHttpError`), and guessing beyond the documented table is worse than
 * leaving the existing status-based fallback in place.
 */
export type QoderResultCodeFamily = 'auth' | 'quota' | 'request' | 'runtime'

/** One documented Qoder result code. */
export interface QoderResultCode {
  /** The numeric code as the upstream reports it in a body's `code` field. */
  readonly code: string
  /** The upstream's own one-line meaning, verbatim from the reference. */
  readonly name: string
  /** Which family decides routing. */
  readonly family: QoderResultCodeFamily
}

const table = (family: QoderResultCodeFamily, rows: readonly (readonly [string, string])[]): QoderResultCode[] =>
  rows.map(([code, name]) => ({ code, name, family }))

/**
 * The documented code table.
 *
 * Source: Qoder's *Errors and error codes* reference
 * (https://docs.qoder.com/cli/sdk/errors), "Result error codes" — the same
 * reference also states the rule this module exists to serve: "Authentication,
 * quota, policy, input, and configuration errors require a change before
 * retrying."
 *
 * Scope note on evidence. That page documents the Agent SDK / qodercli surface,
 * not the loopback HTTP endpoint this plugin talks to. Two of its codes are
 * confirmed on our own path, with matching semantics:
 *
 * - `10605` — observed verbatim: `{"code":"10605","message":"{\"isQueued\":true,
 *   ...\"retryAfterSeconds\":30}"}` (see `qoderQueueSignal`).
 * - `110` — reported in dsh-qoder-connect#10 and reproduced by injecting the
 *   reported body through this transport: `{"code":"110","message":"Billing
 *   daily count exceeded"}`.
 *
 * The rest are carried as the upstream's documented vocabulary. They are read
 * only to identify the family; an undocumented code is never guessed at, so a
 * body this table does not recognize keeps whatever routing the HTTP status
 * already gives it.
 */
export const QODER_RESULT_CODES: readonly QoderResultCode[] = Object.freeze([
  ...table('auth', [
    ['105', 'Login or access token expired'],
  ]),
  ...table('quota', [
    ['110', 'Daily usage limit reached'],
    ['113', 'Usage quota exhausted'],
    ['114', 'Free-trial account limit reached'],
    ['115', 'Free-user quota reached'],
    ['116', 'Team administrator Credits exhausted'],
    ['117', 'Team member Credits exhausted'],
    ['118', 'Personal Credits exhausted'],
    ['119', 'Free usage limit for the selected model reached'],
    ['122', 'Billing-group Credits limit reached'],
  ]),
  ...table('request', [
    ['406', 'Request blocked because of sensitive content or model refusal'],
    ['416', 'Requested range or request shape is not satisfiable'],
    ['430', 'Requested capability is not supported'],
    ['47902', 'Maximum Agent turns reached'],
    ['48716', 'A Hook blocked Agent execution'],
    ['80411', 'Input content is too long'],
    ['80412', 'Too many images or documents'],
  ]),
  ...table('runtime', [
    ['500', 'Request or network failure'],
    ['10408', 'Request timed out'],
    ['10500', 'Model service internal error'],
    ['10605', 'Model request is queued'],
  ]),
])

const byCode = new Map(QODER_RESULT_CODES.map(entry => [entry.code, entry]))

/**
 * The documented result code a rejection body names, if it names one.
 *
 * Qoder nests: a queue answer arrives as `{"code":"10605","message":"{\"isQueued\":
 * true,...}"}`, so the inner payload is escaped JSON and a marker can sit at any
 * depth. Dropping the ASCII backslashes keeps every layer readable at once — the
 * same trick `qoderQueueSignal` uses, and for the same reason; no marker this
 * module looks for depends on a backslash.
 *
 * Only a *quoted* `code` key counts. Qoder also mirrors raw HTTP statuses into a
 * `code` field (`"code":"429"`, `"code":403`), and a message that merely mentions
 * a code in prose must not be read as one; both stay unrecognized because neither
 * names a documented result code.
 *
 * @param body - the upstream error body, or the formatted message when the body
 *   was only embedded in it.
 * @returns the matching table entry, or `undefined` when the body names no
 *   documented code — never a guess.
 */
export function qoderResultCode(body: string | undefined): QoderResultCode | undefined {
  if (body === undefined || body === '') return undefined
  const text = body.replace(/\\/gu, '')
  for (const match of text.matchAll(/"(?:error_)?code"\s*:\s*"?(\d+)"?/gu)) {
    const entry = byCode.get(match[1] as string)
    if (entry !== undefined) return entry
  }
  return undefined
}
