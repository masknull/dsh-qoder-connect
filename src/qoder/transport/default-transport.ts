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
import type { QoderTurnIdentity } from './wire/turn-identity.ts'

export const defaultStreamIdleTimeoutMs = 10 * 60 * 1000

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
  private readonly onQueueWait: QoderTransportOptions['onQueueWait']
  private readonly createQueueWaitHandler: QoderTransportOptions['createQueueWaitHandler']
  private readonly createNoticeHandler: QoderTransportOptions['createNoticeHandler']
  private readonly onNotice: QoderTransportOptions['onNotice']
  private readonly queueWaitBudgetMs: QoderTransportOptions['queueWaitBudgetMs']
  private readonly onDiag: QoderTransportOptions['onDiag']
  private readonly queueWait: QoderTransportOptions['queueWait']
  /** Whether the current unresolved heal failure has already been reported, once per outage. */
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
    this.onQueueWait = options.onQueueWait
    this.createQueueWaitHandler = options.createQueueWaitHandler
    this.createNoticeHandler = options.createNoticeHandler
    this.onNotice = options.onNotice
    this.queueWaitBudgetMs = options.queueWaitBudgetMs
    this.onDiag = options.onDiag
    this.queueWait = options.queueWait
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

  stream(options: GenerateOptions, model?: QoderCatalogModel, turn?: QoderTurnIdentity): AsyncIterable<StreamChunk> {
    const onQueueWait = this.createQueueWaitHandler?.(options) ?? this.onQueueWait
    const onNotice = this.createNoticeHandler?.(options) ?? this.onNotice
    return this.generate(options, model, onQueueWait, onNotice, turn)
  }

  /**
   * Report a self-heal notice into the configured sink.
   *
   * No age guard: the notice belongs to this request and is reported at its own
   * acceptance, so an age limit could only cut a row whose retry queued a while.
   */
  private emitRefreshedNotice(notice: { at: number; sessionId?: string }): void {
    this.logger?.warn?.('[Qoder Stream] Job token was auto-refreshed after an upstream rejection; the chat has recovered')
    this.onJobTokenRefreshed?.({
      region: this.region,
      at: notice.at,
      ...(notice.sessionId !== undefined ? { sessionId: notice.sessionId } : {}),
    })
  }

  /** Note that the upstream accepted a chat, ending any unresolved heal failure. */
  private onChatAccepted(): void {
    this.refreshFailureAnnounced = false
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

  /**
   * Claim the daily benefit.
   *
   * @param signal - cancellation for this call.
   * @param pat - the token to claim for. The daily sweep names each saved PAT in
   *   turn, because the benefit window belongs to the credential, not to the
   *   machine. Absent, the active token is used, as before.
   */
  async checkIn(signal?: AbortSignal, pat?: string): Promise<QoderCheckInResult> {
    const token = pat === undefined ? await this.requirePat(signal) : pat.trim()
    return this.checkInService.checkIn(token, signal)
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
   * Stream one chat, reporting acceptance as soon as the first chunk arrives
   * (the consumer may close the stream early, and nothing after the yield runs).
   *
   * @param onAccepted - Called once, before the first chunk is forwarded.
   */
  private async * streamChat(
    options: GenerateOptions,
    model: QoderCatalogModel | undefined,
    credentials: CosyCredentials,
    messages: QoderWireMessage[],
    onAccepted: () => void,
    onQueueWait: QoderTransportOptions['onQueueWait'],
    onNotice: QoderTransportOptions['onNotice'],
    turn: QoderTurnIdentity | undefined,
  ): AsyncGenerator<StreamChunk> {
    const stream = streamQoderChat(options, model, credentials, messages, {
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      responseHeaderTimeoutMs: this.responseHeaderTimeoutMs,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      ...onQueueWait === undefined ? {} : { onQueueWait },
      ...onNotice === undefined ? {} : { onNotice },
      ...this.queueWaitBudgetMs === undefined ? {} : { queueWaitBudgetMs: this.queueWaitBudgetMs() },
      ...this.onDiag === undefined ? {} : { onDiag: this.onDiag },
      ...this.queueWait === undefined ? {} : { queueWait: this.queueWait },
      ...turn === undefined ? {} : { turn },
    })
    const first = await stream.next()
    onAccepted()
    if (!first.done) yield first.value
    yield* stream
  }

  private async * generate(
    options: GenerateOptions,
    model: QoderCatalogModel | undefined,
    onQueueWait: QoderTransportOptions['onQueueWait'],
    onNotice: QoderTransportOptions['onNotice'],
    turn: QoderTurnIdentity | undefined,
  ): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) throw aborted('Request was aborted prior to generation.')

    // Validate before any provider I/O, so an unusable request never consumes a subscription.
    validateQoderRequestShape(options, model)
    // Credentials, which the center image exchange must be able to sign with.
    const pat = await this.requirePat(options.signal)
    const credentials = await this.auth.getCredentials(pat, options.signal)
    // Read attachments, publish images, and assemble wire messages.
    const messages = await translateQoderMessages(options, this.attachments, {
      uploader: this.imageUploader,
      credentials,
      preserveThinking: this.preserveThinking,
    })
    // Image publication may have refreshed a rejected job token, so re-read the
    // credential that actually signs the chat.
    const chatCredentials = await this.auth.getCredentials(pat, options.signal)
    // Track whether any chunk was yielded to the consumer across this request.
    // If output was already produced mid-stream before an error (e.g. 401 mid-flight),
    // replaying the whole request would emit duplicated content to the user.
    let produced = false
    try {
      for await (const chunk of this.streamChat(options, model, chatCredentials, messages, () => {
        this.onChatAccepted()
      }, onQueueWait, onNotice, turn)) {
        produced = true
        yield chunk
      }
      return
    } catch (error: unknown) {
      if (produced) throw error
      // A cached job token the upstream started rejecting reads as HTTP 401 before
      // any stream byte. One fresh exchange self-heals that window; a revoked PAT
      // fails the retry identically. RATE_LIMIT/QUOTA are never healed here.
      if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error
      this.logger?.warn?.(
        '[Qoder Stream] Chat rejected as unauthorized; exchanging a fresh job token and retrying once',
        { status: error.failure.status },
      )
    }
    // A gateway fault window outlives one immediate retry, so two paced rounds.
    // Each retry exchanges outside the shared single-flight, which a departing
    // waiter can abort.
    let lastRejection: unknown
    let requestNotice: { at: number; sessionId?: string } | undefined
    for (let round = 0; round < 2; round++) {
      const refreshed = await this.auth.exchangeFresh(pat, options.signal)
      // The notice is kept local to this request so concurrent rotations in other
      // sessions cannot crosstalk, overwrite each other, or drop notices.
      requestNotice = {
        at: Date.now(),
        ...(options.sessionId !== undefined ? { sessionId: String(options.sessionId) } : {}),
      }
      try {
        for await (const chunk of this.streamChat(options, model, refreshed, messages, () => {
          this.onChatAccepted()
          if (requestNotice !== undefined) {
            this.emitRefreshedNotice(requestNotice)
            requestNotice = undefined
          }
        }, onQueueWait, onNotice, turn)) {
          produced = true
          yield chunk
        }
        return
      } catch (error: unknown) {
        if (produced) throw error
        if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error
        lastRejection = error
        if (round + 1 < 2) {
          this.logger?.warn?.('[Qoder Stream] Fresh job token also rejected; waiting 2s and retrying once more', {
            status: error.failure.status,
            round: round + 1,
          })
          await new Promise<void>((resolve, reject) => {
            const signal = options.signal
            if (signal?.aborted) {
              reject(aborted('Request was aborted during the re-auth backoff.'))
              return
            }
            let timer: ReturnType<typeof setTimeout> | undefined
            const onAbort = () => {
              if (timer !== undefined) clearTimeout(timer)
              reject(aborted('Request was aborted during the re-auth backoff.'))
            }
            timer = setTimeout(() => {
              signal?.removeEventListener('abort', onAbort)
              resolve()
            }, 2_000)
            signal?.addEventListener('abort', onAbort, { once: true })
          })
        }
      }
    }
    // Report the failed heal once per outage, so the user learns recovery was attempted.
    if (!this.refreshFailureAnnounced) {
      this.refreshFailureAnnounced = true
      this.logger?.warn?.('[Qoder Stream] Job token refresh did not recover the chat; the upstream still rejects it', {
        status: lastRejection instanceof LlmError ? lastRejection.failure.status : undefined,
      })
      this.onJobTokenRefreshFailed?.({
        region: this.region,
        at: Date.now(),
        ...(options.sessionId !== undefined ? { sessionId: String(options.sessionId) } : {}),
        ...(lastRejection instanceof LlmError && lastRejection.failure.status !== undefined
          ? { status: lastRejection.failure.status }
          : {}),
      })
    }
    throw lastRejection
  }
}
