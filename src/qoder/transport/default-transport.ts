/** Deep module owning all communication with Qoder. */

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { QoderAuthService } from './auth.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import type { QoderRegion } from './endpoints.ts'
import { QoderLlmError, isQoderAuthRejection } from '../errors.ts'
import type { QoderLogger } from './logging.ts'
import { fetchQoderModels } from './catalog-reader.ts'
import {
  defaultResponseHeaderTimeoutMs,
  opaqueCredentialKey,
  retryMetadataRead,
  SingleFlight,
} from './request.ts'
import { translateQoderMessages, validateQoderRequestShape } from './wire/serialize.ts'
import { QoderImageUploader } from './image-upload.ts'
import { QoderUsageReader } from './account-reader.ts'
import { QoderCheckInService, type QoderCheckInResult } from './checkin.ts'
import type { QoderAccountInfo } from '../account.ts'
import type { QoderTransport, QoderTransportOptions } from './index.ts'
import { streamQoderChat } from './chat.ts'
import type { CosyCredentials } from './wire/cosy.ts'
import type { QoderWireMessage } from './wire/wire-types.ts'

export const defaultStreamIdleTimeoutMs = 5 * 60 * 1000

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
const jobTokenNoticeMaxAgeMs = 5 * 60 * 1000

function aborted(message: string): QoderLlmError {
  return new QoderLlmError(message, 'ABORTED')
}

export class DefaultQoderTransport implements QoderTransport {
  private readonly region: QoderRegion
  private readonly resolvePat: () => Promise<string>
  private readonly fetchImpl: typeof fetch
  private readonly logger: QoderLogger | undefined
  private readonly streamIdleTimeoutMs: number
  private readonly responseHeaderTimeoutMs: number
  private readonly metadataTimeoutMs: number | undefined
  private readonly auth: QoderAuthService
  private readonly usage: QoderUsageReader
  private readonly checkInService: QoderCheckInService
  private readonly modelFlights = new SingleFlight<readonly QoderCatalogModel[]>()
  private readonly attachments: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'> | undefined
  private readonly imageUploader: QoderImageUploader
  private readonly preserveThinking: boolean | undefined
  private readonly onJobTokenRefreshed: QoderTransportOptions['onJobTokenRefreshed']
  private readonly onJobTokenRefreshFailed: QoderTransportOptions['onJobTokenRefreshFailed']
  /**
   * Set when the self-heal exchanged a fresh job token, cleared when a chat
   * afterwards succeeds. The notice reports "the token was rotated because the
   * old one was rejected", which is true from that exchange on — so it must
   * not be tied to the heal's OWN retry, which can still lose a race with a
   * transient upstream timeout and be rescued by a later attempt.
   */
  private pendingRefreshAt: number | undefined
  /**
   * Whether the current unresolved heal failure has already been reported.
   *
   * One upstream rejection can outlive many host-level retries (an observed
   * storm ran 59 of them across 75 steps), and the transport re-heals inside
   * every one of them. Without this latch the failure notice would print once
   * per retry; with it, the user is told once per outage. Cleared as soon as
   * any chat is accepted, so the next outage announces itself again.
   */
  private refreshFailureAnnounced = false

  constructor(options: QoderTransportOptions) {
    this.region = options.region
    this.resolvePat = options.resolvePat
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.logger = options.logger
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs
    this.responseHeaderTimeoutMs = options.responseHeaderTimeoutMs ?? defaultResponseHeaderTimeoutMs
    this.metadataTimeoutMs = options.metadataTimeoutMs
    this.attachments = options.attachments
    this.preserveThinking = options.preserveThinking
    this.onJobTokenRefreshed = options.onJobTokenRefreshed
    this.onJobTokenRefreshFailed = options.onJobTokenRefreshFailed
    this.auth = new QoderAuthService({
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      resolveMachineId: options.resolveMachineId,
    })
    this.imageUploader = new QoderImageUploader({
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      ...options.imageUploadTimeoutMs === undefined ? {} : { timeoutMs: options.imageUploadTimeoutMs },
      ...options.imageUrlCacheTtlMs === undefined ? {} : { cacheTtlMs: options.imageUrlCacheTtlMs },
      refreshCredentials: async (signal) => {
        const pat = await this.requirePat(signal)
        this.auth.clear(pat)
        return this.auth.getCredentials(pat, signal)
      },
    })
    this.usage = new QoderUsageReader({
      authService: this.auth,
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      timeoutMs: this.metadataTimeoutMs,
    })
    this.checkInService = new QoderCheckInService({
      authService: this.auth,
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      timeoutMs: this.metadataTimeoutMs,
    })
  }

  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk> {
    return this.generate(options, model)
  }

  /**
   * Report the pending self-heal once a chat is accepted, then clear it.
   *
   * The notice means "the stale token was rejected, so it was rotated, and the
   * chat works again" — all three are true by the time a chat is accepted
   * after the refresh, no matter which attempt delivered it.
   */
  private flushPendingRefreshNotice(): void {
    if (this.pendingRefreshAt === undefined) return
    const at = this.pendingRefreshAt
    this.pendingRefreshAt = undefined
    // A rotation whose acceptance took this long is no longer news. Printing
    // it would drop a row into the conversation long after the fact, and its
    // timestamp would name a moment the user has no reason to connect to now —
    // which reads exactly like a clock bug (observed: a 16:56 rotation
    // reported at 17:47). Dropping it keeps the notice meaningful.
    if (Date.now() - at > jobTokenNoticeMaxAgeMs) return
    this.logger?.warn?.('[Qoder Stream] Job token was auto-refreshed after an upstream rejection; the chat has recovered')
    this.onJobTokenRefreshed?.({ region: this.region, at })
  }

  /**
   * Drop a pending rotation notice whose heal did not rescue anything.
   *
   * The heal's own retry was rejected too, so "the rotation fixed it" is not
   * what happened. Leaving the notice pending made a LATER, unrelated chat
   * acceptance flush it — printing a success row that contradicts the failure
   * row already shown, stamped with the old rotation time.
   */
  private discardPendingRefreshNotice(): void {
    this.pendingRefreshAt = undefined
  }

  /**
   * Note that the upstream accepted a chat, ending any unresolved heal failure.
   *
   * `streamChat` calls this the moment its first chunk arrives — the only point
   * at which "the credential was accepted" is actually known. A rejected chat
   * throws before that, so this never fires on a failing attempt.
   */
  private onChatAccepted(): void {
    this.refreshFailureAnnounced = false
    this.flushPendingRefreshNotice()
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]> {
    const pat = await this.requirePat(signal)
    const key = opaqueCredentialKey(pat)
    return this.modelFlights.run(
      key,
      signal,
      async (sharedSignal) => {
        const credentials = await this.auth.getCredentials(pat, sharedSignal)
        return retryMetadataRead(sharedSignal, () => fetchQoderModels(credentials, {
          fetch: this.fetchImpl,
          signal: sharedSignal,
          logger: this.logger,
          region: this.region,
          timeoutMs: this.metadataTimeoutMs,
        }))
      },
      () => aborted('Qoder model discovery was aborted.'),
    )
  }

  async readAccount(options?: { force?: boolean | undefined; signal?: AbortSignal | undefined }): Promise<QoderAccountInfo> {
    const pat = await this.requirePat(options?.signal)
    return this.usage.readAccount(pat, {
      force: options?.force,
      signal: options?.signal,
    })
  }

  async checkIn(signal?: AbortSignal): Promise<QoderCheckInResult> {
    const pat = await this.requirePat(signal)
    return this.checkInService.checkIn(pat, signal)
  }

  private async requirePat(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw aborted('Qoder request was aborted.')
    const pat = (await this.resolvePat()).trim()
    if (!pat) {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing. Configure Qoder in the Qoder settings page.',
        'MISSING_CREDENTIAL',
      )
    }
    if (signal?.aborted) throw aborted('Qoder request was aborted.')
    return pat
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
  private async * streamChat(
    options: GenerateOptions,
    model: QoderCatalogModel | undefined,
    credentials: CosyCredentials,
    messages: QoderWireMessage[],
    onAccepted: () => void,
  ): AsyncGenerator<StreamChunk> {
    const stream = streamQoderChat(options, model, credentials, messages, {
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      responseHeaderTimeoutMs: this.responseHeaderTimeoutMs,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
    })
    const first = await stream.next()
    onAccepted()
    if (!first.done) yield first.value
    yield* stream
  }

  private async * generate(
    options: GenerateOptions,
    model?: QoderCatalogModel,
  ): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) throw aborted('Request was aborted prior to generation.')

    // Phase 1: static validation finishes before credential resolution or any
    // provider I/O, so an unusable request never consumes a subscription.
    validateQoderRequestShape(options, model)
    // Phase 2: credentials, which the center image exchange must be able to sign with.
    const pat = await this.requirePat(options.signal)
    const credentials = await this.auth.getCredentials(pat, options.signal)
    // Phase 3: read attachments, publish images, and assemble wire messages.
    const messages = await translateQoderMessages(options, this.attachments, {
      uploader: this.imageUploader,
      credentials,
      preserveThinking: this.preserveThinking,
    })
    // Image publication may have refreshed a rejected job token, so the chat
    // credential is read once more: it must be the token that actually signs.
    const chatCredentials = await this.auth.getCredentials(pat, options.signal)
    try {
      // A pending notice from an earlier heal is reported as soon as this
      // request is accepted (see `streamChat`).
      yield* this.streamChat(options, model, chatCredentials, messages, () => {
        this.onChatAccepted()
      })
      return
    } catch (error: unknown) {
      // A cached job token the upstream has started rejecting (a gateway-side
      // invalidation or its own rotation) reads as HTTP 401 before any stream
      // byte is produced. One fresh exchange self-heals that window; a
      // genuinely revoked PAT fails the retry identically, and the retry
      // trades one extra exchange call against turning a transient gateway
      // state into a false "sign in again" report for the user.
      //
      // Note what is NOT healed: a 401/403 the upstream used to announce a
      // saturated queue (body carries code 10605 / isQueued / retryAfterSeconds)
      // now classifies as RATE_LIMIT, not AUTH — see qoderQueueSignal. A fresh
      // token cannot jump a queue, so those rejections surface immediately and
      // let the host's retry policy (which retries RATE_LIMIT, never AUTH)
      // ride out the window instead.
      if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error
      this.logger?.warn?.(
        '[Qoder Stream] Chat rejected as unauthorized; exchanging a fresh job token and retrying once',
        { status: error.failure.status },
      )
    }
    // A gateway fault window outlives one immediate retry (observed 2026-09-20:
    // ~09:49-11:27 local, 401s lasting minutes). Two paced rounds cover a
    // short window; a revoked PAT still terminates honestly at the first
    // round's failure, just two exchanges later. Each retry exchanges OUTSIDE
    // the shared single-flight (exchangeFresh): the flight can be aborted by a
    // departing concurrent waiter (quota poll, catalog sweep), and a retry
    // joined to it would be cancelled by a path unrelated to the chat.
    let lastRejection: unknown
    // The rotation this request armed for its own heal. The pending notice is
    // instance state shared by every in-flight request on this transport, so
    // discarding on failure must clear only what this request armed — a
    // concurrent request may have armed its own (successful) notice after ours
    // and deserves it.
    let noticeAt: number | undefined
    for (let round = 0; round < 2; round++) {
      const refreshed = await this.auth.exchangeFresh(pat, options.signal)
      // The rotation has happened; the first chat accepted afterwards — this
      // round's retry or any subsequent one — is what makes it reportable.
      this.pendingRefreshAt = Date.now()
      noticeAt = this.pendingRefreshAt
      try {
        yield* this.streamChat(options, model, refreshed, messages, () => {
          this.onChatAccepted()
        })
        return
      } catch (error: unknown) {
        if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error
        lastRejection = error
        if (round + 1 < 2) {
          this.logger?.warn?.('[Qoder Stream] Fresh job token also rejected; waiting 2s and retrying once more', {
            status: error.failure.status,
            round: round + 1,
          })
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 2_000)
            options.signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(aborted('Request was aborted during the re-auth backoff.'))
            }, { once: true })
          })
        }
      }
    }
    // Both paced rounds exhausted on authorization rejections: the honest
    // answer is the last rejection, not a silently empty stream.
    //
    // The rotation did NOT rescue this chat, so the deferred success notice it
    // would otherwise have qualified for is void. Dropping it here is what
    // stops a later, unrelated chat acceptance from printing "已自动重换并恢复"
    // with a stale rotation time — the row that made the notice look broken.
    // Only this request's own notice is void, though: a concurrent heal that
    // armed the pending slot after ours must keep it.
    if (this.pendingRefreshAt === noticeAt) this.discardPendingRefreshNotice()
    // Report the failed heal once per outage. The success notice covers "the
    // rotation rescued the chat"; without this, a rejection the rotation could
    // NOT rescue was announced nowhere at all, and the user was left reading a
    // bare authorization failure with no hint that recovery had been attempted.
    if (!this.refreshFailureAnnounced) {
      this.refreshFailureAnnounced = true
      this.logger?.warn?.('[Qoder Stream] Job token refresh did not recover the chat; the upstream still rejects it', {
        status: lastRejection instanceof LlmError ? lastRejection.failure.status : undefined,
      })
      this.onJobTokenRefreshFailed?.({
        region: this.region,
        at: Date.now(),
        ...(lastRejection instanceof LlmError && lastRejection.failure.status !== undefined
          ? { status: lastRejection.failure.status }
          : {}),
      })
    }
    throw lastRejection
  }
}
