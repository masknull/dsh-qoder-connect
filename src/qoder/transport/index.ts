/** The only external seam for communication with Qoder. */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderAccountInfo } from '../account.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import type { QoderRegion } from '../region.ts'
import type { QoderCheckInResult } from './checkin.ts'
import type { QoderQueueWait } from './chat.ts'
import type { QoderSseNotice } from './wire/sse.ts'
import type { QoderTurnIdentity } from './wire/turn-identity.ts'
import { DefaultQoderTransport, defaultStreamIdleTimeoutMs } from './default-transport.ts'
import { defaultResponseHeaderTimeoutMs } from './request.ts'
import type { QoderLogger } from './logging.ts'

export { defaultResponseHeaderTimeoutMs, defaultStreamIdleTimeoutMs }
export type { QoderCheckInResult }

export interface QoderTransport {
  /**
   * Stream one model call.
   *
   * @param options - the assembled request.
   * @param model - the catalog row the request addresses.
   * @param turn - agent run this call belongs to. Every step of one DSH turn
   *   passes the same identity so the upstream bills the turn as one usage
   *   record; omitting it makes the call its own record.
   */
  stream(options: GenerateOptions, model?: QoderCatalogModel, turn?: QoderTurnIdentity): AsyncIterable<StreamChunk>
  discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]>
  readAccount(options?: { force?: boolean | undefined; signal?: AbortSignal | undefined }): Promise<QoderAccountInfo>
  /**
   * Claim the daily benefit.
   *
   * @param signal - cancellation for this call.
   * @param pat - claim for this token instead of the active one; the daily sweep
   *   walks every saved credential, since each has its own window.
   */
  checkIn(signal?: AbortSignal, pat?: string): Promise<QoderCheckInResult>
}

export interface QoderTransportOptions {
  region: QoderRegion
  resolvePat: () => Promise<string>
  fetch?: typeof fetch
  logger?: QoderLogger
  streamIdleTimeoutMs?: number
  responseHeaderTimeoutMs?: number
  metadataTimeoutMs?: number
  resolveMachineId?: () => string
  attachments?: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'>
  /** Deadline for one center image publication attempt. */
  imageUploadTimeoutMs?: number
  /** Lifetime of a remembered center image URL. */
  imageUrlCacheTtlMs?: number
  /** Whether prior assistant reasoning content is preserved across turns. */
  preserveThinking?: boolean
  /**
   * Called once per successful re-auth refresh, after a fresh job token was
   * exchanged and accepted following a 401 rejection.
   */
  onJobTokenRefreshed?: (info: { region: QoderRegion; at: number; sessionId?: string | undefined }) => void
  /**
   * Called once per unresolved self-heal failure (refreshed token rejected too),
   * and at most once per outage, reset when a later chat is accepted.
   */
  onJobTokenRefreshFailed?: (info: { region: QoderRegion; at: number; status?: number; sessionId?: string | undefined }) => void
  /** Called once per queue poll round, so the conversation can show progress. */
  onQueueWait?: (info: QoderQueueWait) => void
  /** Create an observer owned by one stream, including its internal replays. */
  createQueueWaitHandler?: (options: GenerateOptions) => (info: QoderQueueWait) => void
  /**
   * Create the per-stream notice sink. A filtered or unrecognised ending is reported as a
   * normal stop, so this is the only channel that can tell the user the answer may be
   * incomplete.
   */
  createNoticeHandler?: (options: GenerateOptions) => ((notice: QoderSseNotice) => void)
  /** Called when one stream raises a notice; the per-stream handler wins. */
  onNotice?: (notice: QoderSseNotice) => void
  /** Budget for one chat call's queue wait; read per call so settings apply live. */
  queueWaitBudgetMs?: () => number
  /** One-line diagnostic sink (chat vs queue decisions). */
  onDiag?: (message: string) => void
  /** Whether to poll out a queue answer; false hands the failure to the host with its hint. */
  queueWait?: () => boolean
}

export function createQoderTransport(options: QoderTransportOptions): QoderTransport {
  return new DefaultQoderTransport(options)
}
