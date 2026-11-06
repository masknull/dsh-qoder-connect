/** Request attribution carried only across the authenticated loopback shim. */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { parseTurnIdentity, type QoderTurnIdentity } from './qoder/transport/wire/turn-identity.ts'

export const QODER_SESSION_HEADER = 'x-dsh-qoder-session-id'
export const QODER_PURPOSE_HEADER = 'x-dsh-qoder-request-purpose'
/** The agent run every step of one turn reports, resolved where messages are. */
export const QODER_TURN_HEADER = 'x-dsh-qoder-turn'

/** Per-call attribution kept alive until its HTTP headers are built. */
interface CallAttribution {
  purpose: GenerateOptions['purpose']
  turn: QoderTurnIdentity | undefined
}

// PiAiAdapter forwards sessionId but omits purpose from its provider options, and
// pi-ai's own `Context` drops every message id and producer kind. Keep both in
// this call's async context until its HTTP headers are built.
const callAttribution = new AsyncLocalStorage<CallAttribution>()

/** Bind each iterator operation, including lazy dispatch and cancellation. */
export async function* withQoderRequestPurpose<T>(
  purpose: GenerateOptions['purpose'],
  stream: AsyncIterable<T>,
  turn?: QoderTurnIdentity,
): AsyncGenerator<T> {
  const store: CallAttribution = { purpose, turn }
  const iterator = stream[Symbol.asyncIterator]()
  let exhausted = false
  try {
    for (;;) {
      const next = await callAttribution.run(store, () => iterator.next())
      if (next.done) {
        exhausted = true
        return
      }
      yield next.value
    }
  } finally {
    if (!exhausted) await callAttribution.run(store, () => iterator.return?.())
  }
}

/**
 * Copy request headers without retaining another call's attribution.
 *
 * @param sessionId - the DSH conversation serving this call.
 * @param headers - the caller's own headers.
 * @returns headers carrying exactly this call's attribution.
 */
export function qoderSessionHeaders(
  sessionId: string | undefined,
  headers?: Readonly<Record<string, string | null>>,
): Record<string, string | null> {
  const attribution = callAttribution.getStore()
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => {
      const lower = name.toLowerCase()
      return lower !== QODER_SESSION_HEADER && lower !== QODER_PURPOSE_HEADER && lower !== QODER_TURN_HEADER
    })),
    [QODER_SESSION_HEADER]: sessionId === undefined ? null : encodeURIComponent(sessionId),
    [QODER_PURPOSE_HEADER]: attribution?.purpose ?? null,
    [QODER_TURN_HEADER]: attribution?.turn === undefined
      ? null
      : encodeURIComponent(JSON.stringify(attribution.turn)),
  }
}

/** Missing or malformed attribution never falls back to another conversation. */
export function readQoderSessionHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const sessionId = decodeURIComponent(value)
    return sessionId.length === 0 ? undefined : sessionId
  } catch {
    return undefined
  }
}

/** Only host-declared auxiliary purposes may influence the hint's visibility. */
export function readQoderPurposeHeader(value: string | string[] | undefined): GenerateOptions['purpose'] {
  return value === 'session-title' || value === 'compaction' ? value : undefined
}

/** The agent-run identity the adapter resolved for this call, when intact. */
export function readQoderTurnHeader(value: string | string[] | undefined): QoderTurnIdentity | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    return parseTurnIdentity(JSON.parse(decodeURIComponent(value)))
  } catch {
    return undefined
  }
}
