/**
 * Qoder upstream client — the loopback shim's OpenAI-shaped surface, carried
 * over to the Qoder transport.
 *
 * The plugin's browser card, the CLI, and DSH's pi-ai adapter all reach Qoder
 * through this one module. The wire reality changed underneath the WorkBuddy
 * edition it replaces: there is no HTTP endpoint that accepts an OpenAI JSON
 * body any more. Instead this module
 *
 * - **translates** the narrow OpenAI chat-completions request the shim forwards
 *   (model, messages, tools, `max_tokens`, `temperature`, `stop`,
 *   `reasoning_effort`) into dsh-llm's `GenerateOptions`, and
 * - **re-serializes** the transport's `StreamChunk` vocabulary back into
 *   `chat.completion.chunk` SSE frames, so the adapter side needs nothing
 *   Qoder-specific, and
 * - maps catalog discovery (`transport.discoverModels`) into the plugin's
 *   model rows, and the account read (`transport.readAccount`) into the
 *   card's credit shape.
 *
 * Failure classification follows the transport's error taxonomy
 * (`QoderLlmError.failure.code` plus the HTTP status it carried); the
 * WorkBuddy-era session/credit marker lists are gone with the upstream they
 * described.
 *
 * @module dsh-qoder-connect/upstream
 */

import { randomBytes } from 'node:crypto'
import {
  createAssistantMessage,
  createUserMessage,
  createToolResultMessage,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { PROBE_MAX_TOKENS, PROBE_PROMPT, type ProbeAttempt } from './probe.ts'
import type { QoderCatalogModel } from './qoder/catalog.ts'
import type { QoderRegion } from './qoder/region.ts'
import type { QoderAccountInfo, QoderQuotaUsage } from './qoder/account.ts'
import { createQoderTransport, type QoderCheckInResult, type QoderTransport } from './qoder/transport/index.ts'
import type { QoderModelBilling, QoderModelInfo, QoderModelReasoning } from './catalog.ts'

/**
 * The reasoning-effort vocabulary the probe sweeps and the effort map speak.
 * Mirrors the canonical order of `src/qoder/catalog.ts` (`low` … `max`).
 * `minimal` and `off` are deliberately absent: `off` is a separate capability
 * the upstream must declare, never something probing may infer.
 */
export type QoderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** How the shim should present an upstream failure to its OpenAI client. */
export type UpstreamErrorKind =
  | 'missing_credential'
  | 'auth'
  | 'soft_rate'
  | 'quota_exceeded'
  | 'server'
  | 'client'

/** HTTP status the shim answers each failure kind with. */
export const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  missing_credential: 401,
  auth: 401,
  soft_rate: 429,
  quota_exceeded: 402,
  server: 502,
  client: 400,
}

/** The chat-completions answer: a streaming `Response`, or a classified failure. */
export type QoderChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

/** Provenance of the last successful catalog fetch. */
export interface QoderCatalogFetch {
  fetchedAtMs: number
  source: string
}

/** One quota package and its remaining credit, as the card renders it. */
export interface QoderCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
  /** Expiry of this package, verbatim from the upstream (ISO string). */
  packageEndTime?: string
}

/** The aggregated credit answer the card renders. */
export interface QoderCredits {
  /** Usage percentage of the personal quota (0..100). */
  total: number
  /** Summed per-package totals — the denominator of the dashboard's bar. */
  totalSize?: number
  accounts: readonly QoderCreditAccount[]
  /** The account's quota is uncapped; renderers test this flag first. */
  unlimited?: true
  /** When the current quota cycle ends, verbatim from the upstream. */
  cycleResetTime?: string
}

/**
 * Normalize a billing rate label for display.
 *
 * Qoder reports a `priceFactor` number; the host spells it `x<n>` (and the
 * WorkBuddy-era saved files sometimes carried a trailing " credits"). The card
 * wants one shape: a trimmed multiplier without the suffix.
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined
  const trimmed = credits.trim().replace(/\s+credits?$/iu, '')
  return trimmed === '' ? undefined : trimmed
}

/**
 * Classify a raw HTTP upstream failure from status and a body excerpt.
 *
 * Status first, then phrases: a throttling body often also says "quota
 * exceeded", and reading that as an exhausted balance parks a healthy account
 * until the next billing day instead of retrying shortly.
 */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  const lower = body.toLowerCase()
  if (status === 402) return 'quota_exceeded'
  if (status === 429) return 'soft_rate'
  if (status === 401 || status === 403) return 'auth'
  for (const marker of ['quota exceeded', 'insufficient quota', 'quota_exhausted', 'exhausted']) {
    if (lower.includes(marker)) return 'quota_exceeded'
  }
  for (const marker of ['rate limit', 'too many requests', 'throttl']) {
    if (lower.includes(marker)) return 'soft_rate'
  }
  for (const marker of ['invalid token', 'invalid pat', 'invalid job token', 'token expired', 'token has expired', 'unauthorized', 'forbidden', 'not authenticated']) {
    if (lower.includes(marker)) return 'auth'
  }
  if (status === 0 || status >= 500) return 'server'
  return 'client'
}

/**
 * Map one structured transport failure onto the shim's error kind.
 *
 * The transport's taxonomy (`src/qoder/errors.ts`) codes an HTTP 402 as
 * `INVALID_REQUEST`, so the status gets the last say for the quota and auth
 * families before the code-based defaults apply.
 */
export function kindFromQoderFailure(failure: { code: string; status?: number | undefined }): UpstreamErrorKind {
  if (failure.code === 'MISSING_CREDENTIAL') return 'missing_credential'
  if (failure.code === 'AUTH' || failure.status === 401 || failure.status === 403) return 'auth'
  if (failure.code === 'RATE_LIMIT' || failure.status === 429) return 'soft_rate'
  if (failure.code === 'QUOTA' || failure.status === 402) return 'quota_exceeded'
  if (failure.code.startsWith('INVALID_') || failure.code.startsWith('UNSUPPORTED_') || failure.code === 'ATTACHMENT') {
    return 'client'
  }
  // TIMEOUT, SERVER, EMPTY_RESPONSE, MALFORMED_RESPONSE, TRANSPORT,
  // PROVIDER_ERROR, and anything unrecognized: a server-side condition.
  return 'server'
}

/** Whether a Personal Access Token works against one region's endpoints. */
export async function validateApiKey(
  pat: string,
  region: QoderRegion,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<boolean> {
  const trimmed = pat.trim()
  if (trimmed === '') return false
  try {
    const transport = createQoderTransport({
      region,
      resolvePat: async () => trimmed,
      ...options.fetch === undefined ? {} : { fetch: options.fetch },
      metadataTimeoutMs: options.timeoutMs ?? 15_000,
    })
    await transport.discoverModels(AbortSignal.timeout(options.timeoutMs ?? 15_000))
    return true
  } catch {
    // Any failure — bad token, unreachable endpoint, timeout — answers the
    // card's one question the same way: this token cannot be saved.
    return false
  }
}

/** A request the OpenAI layer itself could not accept; the shim answers 400. */
class UpstreamRequestError extends Error {}

/** One `data:` frame of a `chat.completion.chunk` SSE body. */
function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const SSE_DONE = 'data: [DONE]\n\n'

/** The media types the attachment service normalizes; anything else is refused. */
const IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UpstreamRequestError(`${what} must be a non-empty string`)
  }
  return value
}

/** Decode one `data:image/...;base64,` URL into typed bytes. */
function decodeDataImage(url: string): { mediaType: ImageMediaType; data: Uint8Array } {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;[a-z0-9;=+.-]*)?,(.*)$/iu.exec(url)
  if (match === null) throw new UpstreamRequestError('image_url data URL is malformed')
  const mediaType = match[1]!.toLowerCase()
  if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
    throw new UpstreamRequestError(`image media type "${mediaType}" is not supported (png, jpeg, webp, gif)`)
  }
  let data: Uint8Array
  try {
    data = new Uint8Array(Buffer.from(match[2] ?? '', 'base64'))
  } catch {
    throw new UpstreamRequestError('image_url base64 payload could not be decoded')
  }
  if (data.byteLength === 0) throw new UpstreamRequestError('image_url payload is empty')
  return { mediaType: mediaType as ImageMediaType, data }
}

/**
 * Parse one OpenAI content value (string or parts array) into text.
 *
 * With `imagesAs`, image parts are offered for commit — and a request that
 * carries them without any commit path fails as a client error, because the
 * Qoder wire can only ever transport a durable attachment reference.
 */
async function openAiContentBlocks(
  content: unknown,
  role: 'user' | 'assistant',
  imagesAs: { commit(part: { mediaType: ImageMediaType; data: Uint8Array }): Promise<Message['content'][number]> } | undefined,
): Promise<Message['content']> {
  const blocks: Message['content'] = []
  const parts: readonly unknown[] = typeof content === 'string' || content === null || content === undefined
    ? (typeof content === 'string' && content !== '' ? [{ type: 'text', text: content }] : [])
    : Array.isArray(content)
      ? content
      : (() => { throw new UpstreamRequestError(`${role} message content must be a string or a parts array`) })()
  for (const raw of parts) {
    if (!isRecord(raw) || typeof raw['type'] !== 'string') {
      throw new UpstreamRequestError(`${role} message content part is malformed`)
    }
    switch (raw['type']) {
      case 'text':
        blocks.push({ type: 'text', text: typeof raw['text'] === 'string' ? raw['text'] : '' })
        break
      case 'image_url': {
        if (role !== 'user') throw new UpstreamRequestError('image parts are valid only in user messages')
        const imageUrl = raw['image_url']
        const url = isRecord(imageUrl) && typeof imageUrl['url'] === 'string' ? imageUrl['url'] : ''
        if (!url.toLowerCase().startsWith('data:')) {
          throw new UpstreamRequestError('image_url must be an inline data: URL; remote image URLs are not fetched')
        }
        if (imagesAs === undefined) {
          throw new UpstreamRequestError('image input requires the DSH attachment service')
        }
        const decoded = decodeDataImage(url)
        blocks.push(await imagesAs.commit(decoded))
        break
      }
      default:
        throw new UpstreamRequestError(`unsupported content part type "${raw['type']}"`)
    }
  }
  return blocks
}

/**
 * Translate one OpenAI chat-completions body into a `GenerateOptions` request.
 *
 * The layer is deliberately narrow: it accepts exactly what pi-ai's
 * `openai-completions` API sends, and rejects anything else with an
 * attributable 400 rather than silently dropping a caller's intent. System
 * prompts ride `options.system` (the transport's own slot), not a leading
 * message; tool results become dedicated user-role messages the Qoder
 * serializer accepts.
 */
async function toGenerateOptions(
  bodyJson: string,
  context: { providerId: string, attachments: Pick<AttachmentStore, 'saveImage'> | undefined, signal?: AbortSignal | undefined },
): Promise<GenerateOptions> {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    throw new UpstreamRequestError('request body is not valid JSON')
  }
  if (!isRecord(parsed)) throw new UpstreamRequestError('request body must be a JSON object')

  const model = requiredString(parsed['model'], 'model')
  const rawMessages = parsed['messages']
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new UpstreamRequestError('messages must be a non-empty array')
  }

  const systemParts: string[] = []
  const messages: Message[] = []
  for (const raw of rawMessages) {
    if (!isRecord(raw)) throw new UpstreamRequestError('each message must be an object')
    const role = raw['role']
    switch (role) {
      case 'system':
      case 'developer': {
        if (typeof raw['content'] !== 'string') throw new UpstreamRequestError('system message content must be a string')
        if (raw['content'] !== '') systemParts.push(raw['content'])
        break
      }
      case 'user': {
        const content = await openAiContentBlocks(raw['content'], 'user',
          context.attachments === undefined ? undefined : {
            commit: async part => ({
              type: 'image' as const,
              attachment: await context.attachments!.saveImage({ data: part.data, mediaType: part.mediaType }),
            }),
          })
        messages.push(createUserMessage({ content, source: { kind: 'user' } }))
        break
      }
      case 'assistant': {
        const content = await openAiContentBlocks(raw['content'], 'assistant', undefined)
        const rawCalls = raw['tool_calls']
        if (Array.isArray(rawCalls)) {
          for (const rawCall of rawCalls) {
            if (!isRecord(rawCall)) throw new UpstreamRequestError('each tool call must be an object')
            const fn = isRecord(rawCall['function']) ? rawCall['function'] : rawCall
            content.push({
              type: 'tool-call',
              id: ToolCallId(requiredString(rawCall['id'], 'tool call id')),
              name: requiredString(fn['name'], 'tool call function name'),
              arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : '',
            })
          }
        }
        if (content.length === 0) break // an empty assistant turn carries nothing the wire may show
        messages.push(createAssistantMessage({
          content,
          source: { provider: context.providerId, model },
        }))
        break
      }
      case 'tool': {
        const callId = requiredString(raw['tool_call_id'], 'tool_call_id')
        const content = raw['content']
        let text: string
        if (typeof content === 'string') {
          text = content
        } else if (Array.isArray(content)) {
          text = content
            .filter((part): part is Record<string, unknown> => isRecord(part) && part['type'] === 'text')
            .map(part => typeof part['text'] === 'string' ? part['text'] : '')
            .join('')
          if (content.some(part => isRecord(part) && part['type'] !== 'text')) {
            throw new UpstreamRequestError('tool result content is limited to text')
          }
        } else {
          throw new UpstreamRequestError('tool message content must be a string or a text-parts array')
        }
        messages.push(createToolResultMessage({
          callId: ToolCallId(callId),
          content: [{ type: 'text', text }],
          isError: false,
        }))
        break
      }
      default:
        throw new UpstreamRequestError(`unsupported message role "${String(role)}"`)
    }
  }
  if (messages.length === 0) throw new UpstreamRequestError('the request carries no model-facing message')

  const tools: ToolSchema[] | undefined = Array.isArray(parsed['tools'])
    ? parsed['tools'].map((raw): ToolSchema => {
      if (!isRecord(raw)) throw new UpstreamRequestError('each tool must be an object')
      const fn = isRecord(raw['function']) ? raw['function'] : raw
      if (!isRecord(fn)) throw new UpstreamRequestError('each tool must carry a function object')
      return {
        name: requiredString(fn['name'], 'tool name'),
        description: typeof fn['description'] === 'string' ? fn['description'] : '',
        parameters: isRecord(fn['parameters']) ? fn['parameters'] : {},
      }
    })
    : undefined

  const effort = parsed['reasoning_effort']
  const stop = parsed['stop']
  const temperature = parsed['temperature']
  const maxTokens = parsed['max_tokens']

  return {
    provider: context.providerId,
    model,
    messages,
    ...systemParts.length > 0 ? { system: systemParts.join('\n') } : {},
    ...tools === undefined || tools.length === 0 ? {} : { tools },
    ...typeof temperature === 'number' && Number.isFinite(temperature) ? { temperature } : {},
    ...typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens: Math.floor(maxTokens) } : {},
    ...typeof effort === 'string' && effort.trim() !== '' ? { reasoningEffort: ReasoningEffortId(effort.trim()) } : {},
    ...Array.isArray(stop)
      ? { stop: stop.filter((entry): entry is string => typeof entry === 'string') }
      : typeof stop === 'string' ? { stop: [stop] } : {},
    ...context.signal === undefined ? {} : { signal: context.signal },
  }
}

/**
 * Re-serialize one `StreamChunk` sequence into OpenAI chunk frames.
 *
 * One assistant choice, deltas keyed by a per-block tool-call index that
 * restarts at zero per block like OpenAI's own, reasoning streamed as
 * `delta.reasoning_content` (the compatible extension other gateways use),
 * usage as a choices-less frame before the terminal finish, and `data:
 * [DONE]` last. A failed or aborted finish mid-stream becomes an error JSON
 * frame and then `[DONE]`: the HTTP status is already sent and cannot carry
 * the failure.
 */
class ChunkEncoder {
  private readonly id: string
  private readonly created: number
  private readonly model: string
  private started = false
  terminal = false
  private readonly toolIndexByBlock = new Map<number, number>()
  private readonly announcedTools = new Set<number>()
  private nextToolIndex = 0

  constructor(model: string) {
    this.id = `chatcmpl-${randomBytes(12).toString('hex')}`
    this.created = Math.floor(Date.now() / 1000)
    this.model = model
  }

  private frame(extra: Record<string, unknown>): string {
    return sseFrame({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      ...extra,
    })
  }

  /** The role frame opens every stream, once. */
  start(): string[] {
    if (this.started) return []
    this.started = true
    return [this.frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })]
  }

  /** Translate one transport chunk into zero or more SSE frames. */
  frames(chunk: StreamChunk): string[] {
    switch (chunk.type) {
      case 'block-start':
      case 'block-end':
        return []
      case 'text-delta':
        return [this.frame({ choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] })]
      case 'reasoning-delta':
        return [this.frame({ choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }] })]
      case 'tool-call-delta': {
        let toolIndex = this.toolIndexByBlock.get(chunk.index)
        if (toolIndex === undefined) {
          toolIndex = this.nextToolIndex++
          this.toolIndexByBlock.set(chunk.index, toolIndex)
        }
        const first = !this.announcedTools.has(chunk.index)
        if (first) this.announcedTools.add(chunk.index)
        const call: Record<string, unknown> = {
          index: toolIndex,
          ...(first
            ? {
                id: String(chunk.id),
                type: 'function',
                function: { name: chunk.name ?? '', arguments: chunk.argumentsDelta },
              }
            : { function: { arguments: chunk.argumentsDelta } }),
        }
        return [this.frame({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })]
      }
      case 'usage': {
        const cacheRead = chunk.usage.cacheReadTokens
        const cacheWrite = chunk.usage.cacheWriteTokens
        const prompt = chunk.usage.inputTokens
          + (cacheRead ?? 0)
          + (cacheWrite ?? 0)
        const completion = chunk.usage.outputTokens
        const reasoning = chunk.usage.reasoningTokens
        // The token counts are DISJOINT by contract (`inputTokens` excludes
        // cached input), so the OpenAI `prompt_tokens` total is the sum.
        //
        // `prompt_tokens_details` MUST ride back out with it: the harness
        // reads the cache-hit share off `prompt_tokens_details.cached_tokens`,
        // so a usage frame that carries only the three aggregate counters
        // silently reports every cached token as a miss (cache hit pinned to
        // 0% however warm the upstream prefix cache actually was). Emit the
        // details object only when the transport reported at least one of the
        // two cache counters, so requests that never saw cache fields keep the
        // exact same frame shape as before.
        const details = cacheRead === undefined && cacheWrite === undefined
          ? undefined
          : {
              ...(cacheRead === undefined ? {} : { cached_tokens: cacheRead }),
              ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
            }
        return [this.frame({
          choices: [],
          usage: {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: chunk.usage.totalTokens ?? prompt + completion,
            ...(details === undefined ? {} : { prompt_tokens_details: details }),
            ...(reasoning === undefined ? {} : {
              completion_tokens_details: {
                reasoning_tokens: reasoning,
              },
            }),
          },
        })]
      }
      case 'finish': {
        this.terminal = true
        const reason = chunk.reason
        if (reason.kind === 'error' || reason.kind === 'aborted') {
          return [
            sseFrame({ error: { message: reason.failure.message, type: 'server_error', code: reason.failure.code } }),
            SSE_DONE,
          ]
        }
        const finishReason = reason.kind === 'max-tokens' ? 'length' : reason.kind === 'tool-calls' ? 'tool_calls' : 'stop'
        return [
          this.frame({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
          SSE_DONE,
        ]
      }
    }
  }

  /** Fallback finish when the chunk source ended without a finish chunk. */
  finishFallback(): string[] {
    if (this.terminal) return []
    this.terminal = true
    return [
      this.frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      SSE_DONE,
    ]
  }

  /** A thrown mid-stream failure, phrased as one error frame and the end. */
  abortFrames(message: string, code: string): string[] {
    this.terminal = true
    return [sseFrame({ error: { message, type: 'server_error', code } }), SSE_DONE]
  }
}

/** Turn any thrown failure into the shim's classified pre-stream result. */
function failureResult(error: unknown): QoderChatResult {
  if (error instanceof UpstreamRequestError) {
    return { ok: false, status: 400, kind: 'client', message: error.message }
  }
  if (error instanceof LlmError) {
    const kind = kindFromQoderFailure(error.failure)
    const status = typeof error.failure.status === 'number' && error.failure.status >= 100 && error.failure.status <= 599
      ? error.failure.status
      : KIND_STATUS[kind]
    return { ok: false, status, kind, message: error.failure.message }
  }
  return { ok: false, status: 502, kind: 'server', message: String(error) }
}

/** Constructor options for {@link QoderUpstreamClient}. */
export interface QoderUpstreamClientOptions {
  /** Which upstream region this client's transport talks to. */
  region: QoderRegion
  /** Provider id stamped into translated requests. */
  providerId: string
  /** Resolves the current Personal Access Token (rejects when none). */
  getPat: () => Promise<string>
  /** The transport this client drives. */
  transport: QoderTransport
  /**
   * The attachment service's image commit path. Without it, any request
   * carrying image parts fails as a client error — the Qoder wire only ever
   * transports durable references.
   */
  attachments?: Pick<AttachmentStore, 'saveImage'> | undefined
  /**
   * Extra catalog lookup used when a requested model is not one this client
   * fetched itself. The transport validates effort and image support against
   * the model row, so a stream must carry it whenever one is known.
   */
  catalogProvider?: ((id: string) => QoderCatalogModel | undefined) | undefined
}

export class QoderUpstreamClient {
  private readonly region: QoderRegion
  private readonly providerId: string
  private readonly getPat: () => Promise<string>
  private readonly transport: QoderTransport
  private readonly attachments: Pick<AttachmentStore, 'saveImage'> | undefined
  private readonly externalCatalog: ((id: string) => QoderCatalogModel | undefined) | undefined
  /** The raw discovery rows of the last successful `fetchModels`, by id. */
  private readonly discovered = new Map<string, QoderCatalogModel>()
  /** Provenance of the last successful catalog fetch, for the status card. */
  lastCatalog: QoderCatalogFetch | undefined

  constructor(options: QoderUpstreamClientOptions) {
    this.region = options.region
    this.providerId = options.providerId
    this.getPat = options.getPat
    this.transport = options.transport
    this.attachments = options.attachments
    this.externalCatalog = options.catalogProvider
  }

  /** The region this client's transport serves. */
  get clientRegion(): QoderRegion {
    return this.region
  }

  /**
   * The catalog row for one model id: this client's own discovery answers
   * first (it is the same data the upstream catalog call produced), and an
   * externally supplied provider — the plugin's fallback roster, say — fills
   * ids the discovery never listed.
   */
  catalogModelFor(id: string): QoderCatalogModel | undefined {
    return this.discovered.get(id) ?? this.externalCatalog?.(id)
  }

  /**
   * Discover this variant's models and translate them into plugin rows.
   *
   * The raw rows stay addressable via {@link catalogModelFor}: a chat request
   * for a discovered model must hand the transport its row, because effort
   * support, image capability, and the output cap are all validated against
   * it. The last successful fetch's provenance lands in {@link lastCatalog}
   * for the status card.
   */
  async fetchModels(signal?: AbortSignal): Promise<QoderModelInfo[]> {
    const models = await this.transport.discoverModels(signal)
    this.discovered.clear()
    for (const model of models) this.discovered.set(model.id, model)
    this.lastCatalog = { fetchedAtMs: Date.now(), source: `${this.providerId}:discovery` }
    return models.map(modelInfoOf)
  }

  /**
   * The subscriber's quota answer, mapped onto the card's credit shape.
   *
   * Qoder reports one personal quota and an optional organization resource
   * package; each becomes a package row the card already knows how to draw.
   * An unbounded personal allowance (`total === 0`, not exceeded) is the
   * account's "unlimited" state.
   */
  async fetchCredits(signal?: AbortSignal): Promise<QoderCredits> {
    const account: QoderAccountInfo = await this.transport.readAccount({ force: true, ...signal === undefined ? {} : { signal } })
    const usage: QoderQuotaUsage = account.usage ?? {}
    const accounts: QoderCreditAccount[] = []
    const personal = usage.userQuota
    if (personal !== undefined) {
      accounts.push({
        packageName: '套餐内 Credits',
        remain: personal.remaining,
        size: personal.total,
        ...usage.expiresAt === undefined ? {} : { packageEndTime: usage.expiresAt },
      })
    }
    const addOn = usage.addOnQuota
    if (addOn !== undefined) {
      accounts.push({
        packageName: '资源包',
        remain: addOn.remaining,
        size: addOn.total,
        ...usage.expiresAt === undefined ? {} : { packageEndTime: usage.expiresAt },
      })
    }
    const org = usage.orgResourcePackage
    if (org !== undefined) {
      accounts.push({
        packageName: '组织资源包',
        remain: org.remaining,
        size: org.total,
        ...usage.expiresAt === undefined ? {} : { packageEndTime: usage.expiresAt },
      })
    }
    const unlimited = usage.isQuotaExceeded === false
      && personal !== undefined
      && personal.total === 0
      && (addOn === undefined || addOn.total === 0)
      && (org === undefined || org.total === 0)
    return {
      total: usage.totalUsagePercentage ?? personal?.percentage ?? 0,
      totalSize: accounts.reduce((sum, entry) => sum + entry.size, 0),
      accounts,
      ...(unlimited ? { unlimited: true as const } : {}),
      ...usage.expiresAt === undefined ? {} : { cycleResetTime: usage.expiresAt },
    }
  }

  /**
   * Run daily benefit check-in for this client's variant.
   */
  async checkIn(signal?: AbortSignal): Promise<QoderCheckInResult> {
    return this.transport.checkIn(signal)
  }

  /**
   * Stream one translated chat-completions request.
   *
   * The first transport chunk is pulled before the response is constructed:
   * everything the transport can reject without touching the network — a
   * missing or empty credential, an effort the model does not advertise, an
   * image on a text-only model — must still be able to answer as a real HTTP
   * status, not as a 200 whose first frame is an error. Once streaming has
   * begun, failures degrade to the error-frame-then-`[DONE]` form the
   * {@link ChunkEncoder} documents.
   */
  async chatStream(bodyJson: string, signal?: AbortSignal): Promise<QoderChatResult> {
    let options: GenerateOptions
    try {
      options = await toGenerateOptions(bodyJson, {
        providerId: this.providerId,
        attachments: this.attachments,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      return failureResult(error)
    }

    // Fail fast, before the transport's own check can spend a request, when
    // no credential exists at all.
    try {
      await this.getPat()
    } catch {
      return { ok: false, status: KIND_STATUS.missing_credential, kind: 'missing_credential', message: 'no Qoder Personal Access Token is configured' }
    }

    const encoder = new ChunkEncoder(options.model)
    let iterator: AsyncIterator<StreamChunk>
    try {
      iterator = this.transport.stream(options, this.catalogModelFor(options.model))[Symbol.asyncIterator]()
    } catch (error) {
      return failureResult(error)
    }
    try {
      const first = await iterator.next()
      if (!first.done) {
        // A terminal first chunk (a failure finish raised as its first and only
        // delivery) still classifies into an HTTP status, because no byte of
        // the response has gone out yet.
        const earlyFailure = first.value.type === 'finish' && (first.value.reason.kind === 'error' || first.value.reason.kind === 'aborted')
          ? first.value.reason.failure
          : undefined
        if (earlyFailure !== undefined) {
          await iterator.return?.()
          const kind = kindFromQoderFailure(earlyFailure)
          return { ok: false, status: earlyFailure.status ?? KIND_STATUS[kind], kind, message: earlyFailure.message }
        }
      }
      const stream = this.bodyStream(iterator, first, encoder)
      return {
        ok: true,
        response: new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        }),
      }
    } catch (error) {
      await iterator.return?.()
      return failureResult(error)
    }
  }

  /** Drive the SSE body from an already-started chunk iterator. */
  private bodyStream(
    iterator: AsyncIterator<StreamChunk>,
    first: IteratorResult<StreamChunk>,
    encoder: ChunkEncoder,
  ): ReadableStream<Uint8Array> {
    const encoderRef = encoder
    const toBytes = (() => {
      const text = new TextEncoder()
      return (frame: string): Uint8Array => text.encode(frame)
    })()
    let queue: string[] = []
    let pending: IteratorResult<StreamChunk> | undefined = first
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          while (queue.length === 0 && !encoderRef.terminal) {
            if (pending === undefined) {
              pending = await iterator.next()
            }
            const next = pending
            pending = undefined
            if (next.done) {
              queue.push(...encoderRef.finishFallback())
              break
            }
            queue.push(...encoderRef.start(), ...encoderRef.frames(next.value))
          }
        } catch (error: unknown) {
          const message = error instanceof LlmError ? error.failure.message : String(error)
          const code = error instanceof LlmError ? error.failure.code : 'TRANSPORT'
          queue = encoderRef.abortFrames(message, code)
        }
        if (queue.length > 0) {
          controller.enqueue(toBytes(queue.shift()!))
          if (encoderRef.terminal && queue.length === 0) controller.close()
          return
        }
        controller.close()
      },
      cancel: async () => {
        await iterator.return?.()
      },
    })
  }

  /**
   * One minimal reasoning-effort request, as the probe sweep needs it.
   *
   * The transport validates `reasoningEffort` against the model's advertised
   * efforts **locally** before any network call: a rejection therefore reads
   * as an attributable 400 with code `UNSUPPORTED_REASONING_EFFORT`, and an
   * accepted value costs exactly one streamed request, which this method ends
   * after the first chunk arrives. A probe on this upstream measures the
   * discovery catalog as much as the endpoint behind it — see the module docs
   * in `probe.ts`.
   */
  async probeEffort(model: string, effort: string | undefined, signal: AbortSignal): Promise<ProbeAttempt> {
    try {
      await this.getPat()
    } catch {
      return { status: 401, streamed: false, errorCode: 'MISSING_CREDENTIAL', detail: 'no Personal Access Token configured' }
    }
    const options: GenerateOptions = {
      provider: this.providerId,
      model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: PROBE_PROMPT }],
        source: { kind: 'user' },
      })],
      maxTokens: PROBE_MAX_TOKENS,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
      signal,
    }
    try {
      const iterator = this.transport.stream(options, this.catalogModelFor(model))[Symbol.asyncIterator]()
      try {
        const first = await iterator.next()
        return { status: first.done ? 502 : 200, streamed: !first.done }
      } finally {
        await iterator.return?.()
      }
    } catch (error) {
      if (error instanceof LlmError) {
        const status = error.failure.status ?? defaultStatusForProbe(error.failure.code)
        return { status, streamed: false, errorCode: error.failure.code, detail: error.failure.message.slice(0, 300) }
      }
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    }
  }
}

/** Statuses {@link probeEffort} reports for failures the transport raised pre-network. */
function defaultStatusForProbe(code: string): number {
  switch (code) {
    case 'UNSUPPORTED_REASONING_EFFORT':
    case 'UNSUPPORTED_CONTENT':
    case 'INVALID_REQUEST':
      return 400
    case 'MISSING_CREDENTIAL':
    case 'AUTH':
      return 401
    case 'RATE_LIMIT':
      return 429
    case 'QUOTA':
      return 402
    default:
      return 502
  }
}

/**
 * Translate one Qoder catalog row into the plugin's model-info shape.
 *
 * The Qoder vocabulary carries less than the WorkBuddy one did — no badges,
 * no promotions, no free/credits strings — so the billing section reports the
 * price factor only, spelled `x<n>`, and says so honestly when the upstream
 * reported nothing (`rateUnknown`). Context capacity comes from the effective
 * window, with the declared options kept for the card and the maximum-window
 * preference; a row with no capacity at all takes the transport's own default.
 */
export function modelInfoOf(model: QoderCatalogModel): QoderModelInfo {
  const options = Object.values(model.contextOptions ?? {})
    .map(option => option.tokenCount)
    .filter((count): count is number => typeof count === 'number' && Number.isFinite(count) && count > 0)
  const supportedContextWindows = [...new Set(options)].sort((left, right) => left - right)
  const defaultOptions = Object.values(model.contextOptions ?? {}).filter(option => option.isDefault === true)
  const contextWindow = model.contextWindow
    ?? (defaultOptions.length === 1 ? defaultOptions[0]?.tokenCount : undefined)
    ?? DEFAULT_CONTEXT_WINDOW
  const reasoning: QoderModelReasoning | undefined = model.isReasoning === true || model.supportsEffort === true
    ? {
        supports: true,
        ...model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0
          ? {}
          : { supportedEfforts: model.reasoningEfforts.map(effort => effort.id) },
        ...model.defaultReasoningEffort === undefined ? {} : { defaultEffort: model.defaultReasoningEffort },
        canDisableThinking: false,
      }
    : undefined
  const billing: QoderModelBilling = model.priceFactor === undefined
    ? { free: false, rateUnknown: true }
    : model.priceFactor === 0
      ? { credits: 'x0', free: true }
      : { credits: `x${model.priceFactor}`, free: false }
  return {
    id: model.id,
    name: model.name === '' ? model.id : model.name,
    contextWindow,
    ...defaultOptions.length === 1 && defaultOptions[0]?.tokenCount !== undefined
      ? { defaultContextWindow: defaultOptions[0].tokenCount }
      : {},
    ...supportedContextWindows.length > 1 ? { supportedContextWindows } : {},
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    supportsImages: model.supportsImages === true,
    ...reasoning === undefined ? {} : { reasoning },
    billing,
    ...model.source === undefined ? {} : { source: model.source },
  }
}

/** The transport's own output cap for rows that declare none. */
const DEFAULT_MAX_TOKENS = 32_768

/** A conservative input budget for rows that declare none. */
const DEFAULT_CONTEXT_WINDOW = 180_000
