/**
 * Qoder's documented result error codes, and the reader that finds one in a
 * rejection body.
 *
 * @module dsh-qoder-connect/qoder/codes
 */

/** Which routing family a documented code belongs to. Only `quota` overrides the HTTP status. */
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
 * The documented code table, from Qoder's "Result error codes" reference
 * (https://docs.qoder.com/cli/sdk/errors). Codes are used only to identify a
 * family; anything undocumented keeps the routing its HTTP status gives it.
 */
export const QODER_RESULT_CODES: readonly QoderResultCode[] = Object.freeze([
  ...table('auth', [
    ['105', 'Login or access token expired'],
  ]),
  ...table('quota', [
    ['110', 'Daily usage limit reached'],
    ['112', 'Model unavailable on this plan'],
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
 * The documented result code a rejection body names, or `undefined`. Only a
 * quoted `code` key counts; mirrored HTTP statuses are not documented codes.
 *
 * @param body - the upstream error body, or the message that embeds it.
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
