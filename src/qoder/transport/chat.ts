/** Qoder chat request encoding, timeout lifecycle, and SSE streaming. */

import {
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import type { QoderCatalogModel } from '../catalog.ts'
import { QoderLlmError, qoderHttpError, qoderQueueSignal, qoderRequestId } from '../errors.ts'
import type { QoderRegion } from '../region.ts'
import { getQoderChatUrl, getQoderQueueStatusUrl } from './endpoints.ts'
import { redactLogValue, type QoderLogger } from './logging.ts'
import { defaultMaxErrorBytes, readLimitedText } from './request.ts'
import { buildAuthHeaders, qoderUserAgent, type CosyCredentials } from './wire/cosy.ts'
import { qoderEncodeBody } from './wire/encoding.ts'
import { buildQoderRequestBody } from './wire/serialize.ts'
import type { QoderTurnIdentity } from './wire/turn-identity.ts'
import { parseQoderSse, type QoderSseNotice } from './wire/sse.ts'
import type { QoderWireMessage } from './wire/wire-types.ts'

export interface QoderChatDependencies {
  fetch: typeof fetch
  logger?: QoderLogger | undefined
  region: QoderRegion
  responseHeaderTimeoutMs: number
  streamIdleTimeoutMs: number
  /** Budget for one chat call's queue wait; defaults to 90% of the idle window. */
  queueWaitBudgetMs?: number
  /** Called once per queue poll round, before the next poll or replay. */
  onQueueWait?: (info: QoderQueueWait) => void
  /** One-line diagnostic sink (chat vs queue decisions). */
  onDiag?: (message: string) => void
  /**
   * Called when the upstream filtered the reply. The turn still ends as a normal stop, so
   * this is the only user-visible trace that the answer was cut short.
   */
  onNotice?: (notice: QoderSseNotice) => void
  /** Whether to poll out a queue answer; false hands the failure to the host with its hint. */
  queueWait?: () => boolean
  /**
   * Agent run this request belongs to. Every step of one DSH turn reports the same
   * one, so the upstream bills the whole turn as a single usage record; the
   * adapter resolves it where the durable messages still carry their ids.
   */
  turn?: QoderTurnIdentity | undefined
  /**
   * Floor for one poll interval. Production keeps
   * {@link queuePollMinIntervalMs}; tests shorten it so a paced wait can be
   * observed without spending the production interval.
   */
  queuePollFloorMs?: number
  /**
   * Ceiling for one poll interval. Production keeps
   * {@link queuePollMaxIntervalMs}; tests shorten it for the same reason as the
   * floor.
   */
  queuePollCeilingMs?: number
}

/** One queue round as the transport observed it. */
export interface QoderQueueWait {
  /** 1-based round number within this chat call. */
  attempt: number
  /** How long the caller waits from here on (the row's countdown). */
  waitMs: number
  /** The entry was granted and a replay follows after `waitMs`. */
  cleared?: boolean
  /** Poll rounds this wait allows at the current pacing; the row's denominator. */
  maxAttempts?: number
  /** Entries still ahead of this one, when the upstream reports them. */
  queueCount?: number
  /** Upstream's own estimate for this entry, when reported. */
  waitTimeMs?: number
  /** Host session this request belongs to, when the caller supplied one. */
  sessionId?: string
}

/** 90% of the host's stream-idle window: a longer silence would be killed anyway. */
function queueBudgetMs(dependencies: QoderChatDependencies): number {
  return Math.max(30_000, Math.floor(dependencies.streamIdleTimeoutMs * 0.9))
}
/** Floor for a poll interval: `retryAfterSeconds` can be 0/1 and polling must not spin. */
const queuePollMinIntervalMs = 2_000
/** Ceiling for one poll interval, so a stale countdown cannot outlive the budget. */
const queuePollMaxIntervalMs = 30_000
/** Consecutive unusable poll answers before the queue wait gives up. */
const maxPollFailures = 3
/** Consecutive "empty queue, no capacity" answers before giving up. */
const maxNoCapacityPolls = 3

function aborted(message: string): QoderLlmError {
  return new QoderLlmError(message, 'ABORTED')
}

/** Sleep that rejects with the abort reason instead of hanging. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted('Request was aborted during a queue wait.'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(aborted('Request was aborted during a queue wait.'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** One `ask/queue/status` answer, narrowed to the fields a replay decision needs. */
interface QoderQueueStatus {
  isQueued: boolean
  /** A model with no capacity can report `isQueued:false` and still reject. */
  serviceAvailable?: boolean
  queueCount?: number
  waitTimeMs?: number
  retryAfterMs?: number
}

/** Read the pending queue entry; `undefined` means the endpoint is unusable. */
async function readQueueStatus(
  dependencies: QoderChatDependencies,
  credentials: CosyCredentials,
  requestSetId: string,
  modelKey: string,
  queueType: string | undefined,
  requestId: string,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<QoderQueueStatus | undefined> {
  const url = getQoderQueueStatusUrl(dependencies.region, { requestSetId, modelKey, queueType })
  try {
    const response = await dependencies.fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        // The status endpoint compresses unless asked not to; one host's
        // encoding is not something this client can decode.
        'accept-encoding': 'identity',
        // Same identity as the chat call it polls for: one client, one UA.
        'user-agent': qoderUserAgent,
        ...buildAuthHeaders(null, url, credentials, { requestId, ...sessionId === undefined ? {} : { sessionId } }),
      },
      signal,
    })
    if (!response.ok) {
      dependencies.onDiag?.(`poll http=${response.status}`)
      return undefined
    }
    const body = await readLimitedText(response, defaultMaxErrorBytes, 'Qoder queue status')
    const parsed: unknown = JSON.parse(body)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const record = parsed as Record<string, unknown>
    return {
      isQueued: record['isQueued'] === true,
      ...typeof record['serviceAvailable'] === 'boolean' ? { serviceAvailable: record['serviceAvailable'] } : {},
      ...typeof record['queueCount'] === 'number' ? { queueCount: record['queueCount'] } : {},
      ...typeof record['waitTime'] === 'number' ? { waitTimeMs: record['waitTime'] * 1000 } : {},
      ...typeof record['retryAfterSeconds'] === 'number' ? { retryAfterMs: record['retryAfterSeconds'] * 1000 } : {},
    }
  } catch (error) {
    dependencies.onDiag?.(`poll threw: ${String((error as Error)?.message ?? error).slice(0, 120)}`)
    return undefined
  }
}

/** Poll until the entry clears, the budget runs out, or the endpoint stops answering. */
async function waitForQueue(
  dependencies: QoderChatDependencies,
  credentials: CosyCredentials,
  requestSetId: string,
  modelKey: string,
  requestId: string,
  sessionId: string | undefined,
  queue: { retryAfterMs?: number, queueType?: string },
  deadline: number,
  signal: AbortSignal,
  /**
   * Callback that keeps the caller's own idle clock alive. A queue wait is
   * silence on the wire, but it is not idleness: without this the stream-idle
   * window would end the wait long before the budget the user configured.
   */
  touch: () => void,
  attemptStart = 0,
  maxAttempts?: number,
): Promise<{ ready: boolean, attempts: number }> {
  const diag = (message: string): void => dependencies.onDiag?.(message)
  const floor = dependencies.queuePollFloorMs ?? queuePollMinIntervalMs
  const ceiling = dependencies.queuePollCeilingMs ?? queuePollMaxIntervalMs
  let retryAfterMs = queue.retryAfterMs ?? queuePollMinIntervalMs
  let attempt = attemptStart
  let waitedMs = 0
  let failures = 0
  let noCapacity = 0
  for (;;) {
    // Read before sleeping: the entry exists as soon as the rejection arrives,
    // and an already-clear one must not cost a full retryAfterSeconds.
    attempt += 1
    touch()
    const status = await readQueueStatus(dependencies, credentials, requestSetId, modelKey, queue.queueType, requestId, sessionId, signal)
    if (status === undefined) {
      failures += 1
      diag(`poll ${attempt}: unusable answer (${failures}/${maxPollFailures})`)
      if (failures >= maxPollFailures) return { ready: false, attempts: attempt }
      const retry = Math.min(floor * failures, ceiling)
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { ready: false, attempts: attempt }
      waitedMs = Math.min(retry, remaining)
      touch()
      await sleep(waitedMs, signal)
      continue
    }
    failures = 0
    diag(`poll ${attempt}: set=${requestSetId} req=${requestId} isQueued=${status.isQueued} serviceAvailable=${status.serviceAvailable ?? '-'} queueCount=${status.queueCount ?? '-'} waitTimeMs=${status.waitTimeMs ?? '-'} retryAfterMs=${status.retryAfterMs ?? '-'}`)
    // `isQueued:false` is the grant, even when the same answer says
    // `serviceAvailable:false`; only a still-queued entry keeps polling.
    const cleared = !status.isQueued
    // An empty queue with no capacity, while still queued, never comes back on
    // its own. A cleared entry is a grant and must not be counted here.
    if (!cleared && status.serviceAvailable === false && (status.queueCount ?? 0) === 0) {
      noCapacity += 1
      diag(`poll ${attempt}: no capacity (${noCapacity}/${maxNoCapacityPolls})`)
      if (noCapacity >= maxNoCapacityPolls) return { ready: false, attempts: attempt }
    } else {
      noCapacity = 0
    }
    retryAfterMs = status.retryAfterMs ?? retryAfterMs
    const remaining = deadline - Date.now()
    if (cleared) {
      // This round is the grant, not a wait: it must not consume a round number,
      // or the row would count 1 → 3. It still reports, so the caller can close
      // the row it opened; without that a later wait updates a stale row.
      const settle = Math.min(
        Math.max(retryAfterMs, floor),
        ceiling,
        Math.max(remaining, 0),
      )
      dependencies.onQueueWait?.({
        attempt: attempt - 1,
        waitMs: settle,
        cleared: true,
        ...sessionId === undefined ? {} : { sessionId },
      })
      diag(`poll ${attempt}: clear; settling ${settle}ms before replay`)
      touch()
      if (settle > 0) await sleep(settle, signal)
      return { ready: true, attempts: attempt - 1 }
    }
    // What the caller waits from here on: the next poll interval. The countdown
    // reads this value.
    const nextWait = Math.min(Math.max(retryAfterMs, floor), ceiling, Math.max(remaining, 0))
    dependencies.onQueueWait?.({
      attempt,
      waitMs: nextWait,
      ...maxAttempts === undefined ? {} : { maxAttempts },
      ...status.queueCount === undefined ? {} : { queueCount: status.queueCount },
      ...status.waitTimeMs === undefined ? {} : { waitTimeMs: status.waitTimeMs },
      ...sessionId === undefined ? {} : { sessionId },
    })
    if (remaining <= 0) {
      diag(`poll ${attempt}: budget exhausted`)
      return { ready: false, attempts: attempt }
    }
    waitedMs = nextWait
    touch()
    await sleep(waitedMs, signal)
  }
}

/** Ride out a busy queue for either 10605 entry point; `ready` false means the caller must fail. */
async function rideQueue(
  error: unknown,
  bodyHint: string | undefined,
  dependencies: QoderChatDependencies,
  credentials: CosyCredentials,
  requestSetId: string,
  modelKey: string,
  requestId: string,
  sessionId: string | undefined,
  deadline: number,
  signal: AbortSignal,
  touch: () => void,
  attemptStart: number,
  maxAttempts?: number,
): Promise<{ ready: boolean, attempts: number, maxAttempts?: number }> {
  const queue = qoderQueueSignal(bodyHint)
    ?? (error instanceof QoderLlmError ? qoderQueueSignal(error.failure.message) : undefined)
  if (dependencies.queueWait !== undefined && !dependencies.queueWait()) {
    dependencies.onDiag?.('queue: disabled by settings; handing the answer to the host')
    return { ready: false, attempts: attemptStart }
  }
  if (queue?.retryAfterMs === undefined || Date.now() >= deadline) {
    dependencies.onDiag?.(`queue: not actionable (hint=${queue?.retryAfterMs ?? 'none'}, budgetLeftMs=${deadline - Date.now()})`)
    return { ready: false, attempts: attemptStart }
  }
  dependencies.onDiag?.(`queue: detected retryAfterMs=${queue.retryAfterMs} queueType=${queue.queueType ?? '-'}`)
  // Rounds this budget can hold at the upstream's own pace; the row's
  // denominator, so it never reads smaller than the numerator.
  const pace = Math.max(queue.retryAfterMs, dependencies.queuePollFloorMs ?? queuePollMinIntervalMs)
  const allowed = maxAttempts ?? Math.max(1, Math.floor((deadline - Date.now()) / pace))
  const outcome = await waitForQueue(dependencies, credentials, requestSetId, modelKey, requestId, sessionId, queue, deadline, signal, touch, attemptStart, allowed)
  return { ...outcome, maxAttempts: allowed }
}

export async function* streamQoderChat(
  options: GenerateOptions,
  model: QoderCatalogModel | undefined,
  credentials: CosyCredentials,
  messages: QoderWireMessage[],
  dependencies: QoderChatDependencies,
): AsyncGenerator<StreamChunk> {
  const request = await buildQoderRequestBody(options, credentials.userID, messages, model, undefined, dependencies.region, dependencies.turn)
  // The queue entry is keyed by request_set_id, which stays for the whole call;
  // a replay rotates only request_id/chat_record_id, exactly as the official
  // client does before re-sending.
  const encode = (value: typeof request): Buffer =>
    Buffer.from(qoderEncodeBody(JSON.stringify(value)), 'utf8')
  let encodedBytes = encode(request)
  const chatUrl = getQoderChatUrl(dependencies.region)
  const requestSetId = request.request_set_id
  let requestId = request.request_id
  const modelKey = options.model || 'cmodel'
  const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
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
  const queueDeadline = Date.now() + (dependencies.queueWaitBudgetMs ?? queueBudgetMs(dependencies))
  let replays = 0
  // Poll rounds count across replays, so the notice keeps climbing instead of
  // restarting at 1 after every replay.
  let queueAttempts = 0
  // The row's denominator, fixed by the first wait so it never trails the
  // numerator. Display only: the deadline above is what ends a wait.
  let queueMaxAttempts: number | undefined
  let reqId: ReturnType<typeof qoderRequestId> | undefined

  /** Rotate the per-attempt ids and re-encode; the queue key is untouched. */
  const rotateAttempt = (): void => {
    const next = randomUUID()
    request.request_id = next
    request.chat_record_id = next
    requestId = next
    encodedBytes = encode(request)
  }

  for (;;) {
    // A fresh controller per attempt means an abort that landed between
    // attempts would otherwise never reach the next request.
    if (options.signal?.aborted) throw aborted('Request was aborted.')
    const requestController = new AbortController()
    let headerTimedOut = false
    let idleTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let chunkCount = 0
    const startedAt = performance.now()
    let lastActivityAt = startedAt
    const onCallerAbort = (): void => requestController.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })
    const headerTimer = setTimeout(() => {
      headerTimedOut = true
      requestController.abort('response header timeout')
    }, dependencies.responseHeaderTimeoutMs)
    const resetIdleTimer = (): void => {
      lastActivityAt = performance.now()
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        requestController.abort('stream idle timeout')
      }, dependencies.streamIdleTimeoutMs)
    }

    try {
      dependencies.onDiag?.(`chat ${replays + 1}: POST set=${requestSetId} req=${requestId}`)
      const response = await dependencies.fetch(chatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          'cache-control': 'no-cache',
          'accept-encoding': 'identity',
          'x-model-key': modelKey,
          'x-model-source': model?.source || 'system',
          // The upstream only ever sees the Qoder client identity: every
          // channel shares one UA so the traffic cannot be split into
          // different clients by host or by endpoint.
          'user-agent': qoderUserAgent,
          ...buildAuthHeaders(encodedBytes, chatUrl, credentials),
        },
        body: encodedBytes,
        signal: requestController.signal,
      })
      clearTimeout(headerTimer)
      reqId = qoderRequestId(response.headers)
      dependencies.onDiag?.(`chat ${replays + 1}: HTTP ${response.status}`)
      dependencies.logger?.debug?.('[Qoder Stream] Response headers received', {
        region: dependencies.region,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        ...reqId === undefined ? {} : { requestId: reqId },
        ...replays === 0 ? {} : { replays },
      })
      resetIdleTimer()
      if (!response.ok) {
        // Read the bounded error body before failing: only the body separates a
        // queue throttle from a real authorization rejection.
        let errorBody: string | undefined
        try {
          errorBody = await readLimitedText(response, defaultMaxErrorBytes, 'Qoder chat error response')
        } catch {
          // An unreadable body still fails the request, classified from status alone.
          errorBody = undefined
        }
        const failure = qoderHttpError(`Qoder upstream service returned HTTP ${response.status}.`, response, errorBody)
        // The budget is the cap: `rideQueue` refuses a spent deadline by itself,
        // and this check only spares the call. No replay count stands in for it.
        if (Date.now() < queueDeadline) {
          const outcome = await rideQueue(failure, errorBody, dependencies, credentials, requestSetId, modelKey, requestId, sessionId, queueDeadline, requestController.signal, resetIdleTimer, queueAttempts, queueMaxAttempts)
          queueAttempts = outcome.attempts
          queueMaxAttempts = outcome.maxAttempts ?? queueMaxAttempts
          if (outcome.ready) {
            replays += 1
            rotateAttempt()
            continue
          }
        }
        dependencies.onDiag?.('chat: handing the queue failure to the host')
        throw failure
      }
      if (!response.body) {
        throw new QoderLlmError('Qoder response contains no readable body stream.', 'EMPTY_RESPONSE')
      }

      let firstChunkDurationMs: number | undefined
      let tokenUsage: TokenUsage | undefined
      let finishReason: string | undefined
      const streamStartedAt = performance.now()

      // A 200 stream can carry the 10605 envelope; wait here too, but only
      // before any chunk was forwarded, or the replay would duplicate output.
      let replay = false
      try {
        for await (const chunk of parseQoderSse(response.body, {
          onActivity: resetIdleTimer,
          ...dependencies.onDiag === undefined ? {} : { onDiag: dependencies.onDiag },
          ...dependencies.onNotice === undefined ? {} : { onNotice: dependencies.onNotice },
        })) {
          chunkCount++
          if (firstChunkDurationMs === undefined) {
            firstChunkDurationMs = Math.round(performance.now() - startedAt)
            dependencies.logger?.debug?.('[Qoder Stream] First chunk received', {
              durationMs: firstChunkDurationMs,
              ...reqId === undefined ? {} : { requestId: reqId },
            })
          }
          if (chunk.type === 'usage') {
            tokenUsage = chunk.usage
          }
          if (chunk.type === 'finish') {
            finishReason = chunk.reason.kind
          }
          yield chunk
        }
      } catch (error: unknown) {
        // Same cap as above, and one more rule: a chunk already forwarded means a
        // replay would duplicate output, so only a silent failure may queue.
        const outcome = chunkCount !== 0 || Date.now() >= queueDeadline
          ? { ready: false, attempts: queueAttempts }
          : await rideQueue(error, undefined, dependencies, credentials, requestSetId, modelKey, requestId, sessionId, queueDeadline, requestController.signal, resetIdleTimer, queueAttempts, queueMaxAttempts)
        queueAttempts = outcome.attempts
        queueMaxAttempts = outcome.maxAttempts ?? queueMaxAttempts
        if (!outcome.ready) {
          dependencies.onDiag?.('chat: failure inside the SSE envelope handed to the host')
          throw error
        }
        replays += 1
        rotateAttempt()
        replay = true
      }
      if (replay) continue

      dependencies.logger?.debug?.('[Qoder Stream] Stream completed', {
        durationMs: Math.round(performance.now() - startedAt),
        streamDurationMs: Math.round(performance.now() - streamStartedAt),
        chunkCount,
        ...finishReason === undefined ? {} : { finishReason },
        ...tokenUsage === undefined ? {} : { usage: tokenUsage },
        ...reqId === undefined ? {} : { requestId: reqId },
      })
      return
    } catch (error: unknown) {
      if (options.signal?.aborted) throw aborted('Request was aborted.')
      const elapsedMs = Math.round(performance.now() - startedAt)
      if (headerTimedOut) {
        const failure = new QoderLlmError('Qoder model request exceeded its response header timeout.', 'TIMEOUT')
        dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
          phase: 'header',
          elapsedMs,
          timeoutMs: dependencies.responseHeaderTimeoutMs,
        })
        throw failure
      }
      if (idleTimedOut) {
        const failure = new QoderLlmError('Qoder model stream exceeded its idle timeout.', 'TIMEOUT')
        dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
          phase: 'stream-idle',
          chunkCount,
          idleDurationMs: Math.round(performance.now() - lastActivityAt),
          elapsedMs,
          ...reqId === undefined ? {} : { requestId: reqId },
        })
        throw failure
      }
      if (error instanceof QoderLlmError) {
        dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(error), {
          chunkCount,
          elapsedMs,
          ...reqId === undefined ? {} : { requestId: reqId },
        })
        throw error
      }
      const failure = new QoderLlmError('Qoder transport request failed.', 'TRANSPORT', { cause: error })
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
        chunkCount,
        elapsedMs,
        ...reqId === undefined ? {} : { requestId: reqId },
        cause: redactLogValue(error),
      })
      throw failure
    } finally {
      clearTimeout(headerTimer)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      options.signal?.removeEventListener('abort', onCallerAbort)
      requestController.abort('request complete')
    }
  }
}
