/**
 * Qoder upstream client — the loopback shim's OpenAI-shaped surface, carried over
 * to the Qoder transport.
 *
 * The card, the CLI, and DSH's pi-ai adapter all reach Qoder through this module:
 * it translates the narrow OpenAI chat-completions request into dsh-llm's
 * `GenerateOptions`, re-serializes `StreamChunk` back into `chat.completion.chunk`
 * SSE frames so the adapter needs nothing Qoder-specific, and maps catalog
 * discovery and the account read onto the plugin's rows. Failures follow the
 * transport's error taxonomy (`QoderLlmError.failure.code` plus its HTTP status).
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
  type ContentBlock,
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
import { qoderQueueSignal, QoderLlmError } from './qoder/errors.ts'
import { qoderResultCode } from './qoder/codes.ts'
import { createQoderTransport, type QoderCheckInResult, type QoderTransport } from './qoder/transport/index.ts'
import type { QoderModelBilling, QoderModelInfo, QoderModelReasoning } from './catalog.ts'

/**
 * The reasoning-effort vocabulary the probe sweeps and the effort map speak.
 * `minimal` and `off` are deliberately absent: `off` is a separate capability the
 * upstream must declare, never something probing may infer.
 */
export type QoderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** How the shim should present an upstream failure to its OpenAI client. */
export type UpstreamErrorKind =
  | 'missing_credential'
  | 'auth'
  | 'soft_rate'
  | 'quota_exceeded'
  | 'timeout'
  | 'server'
  | 'client'

/**
 * HTTP status the shim answers each failure kind with.
 *
 * `timeout` is 408, deliberately not 504: the harness's pi-ai classifier tests
 * `/\b5\d\d\b/` before its `timeout` test, so a 5xx would read as SERVER.
 */
export const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  missing_credential: 401,
  auth: 401,
  soft_rate: 429,
  quota_exceeded: 402,
  timeout: 408,
  server: 502,
  client: 400,
}

/** The chat-completions answer: a streaming `Response`, or a classified failure. */
export type QoderChatResult =
  | { ok: true; response: Response }
  | {
    ok: false
    status: number
    kind: UpstreamErrorKind
    message: string
    /**
     * The upstream's own "try again in N ms" answer (Qoder's queue body carries
     * `retryAfterSeconds`, and a plain 429 may carry `Retry-After`).
     *
     * It must survive this layer: the shim turns it into the `Retry-After` header
     * and the `[retry-after=<n>s]` tag, which the adapter reads back into
     * `failure.providerRetryAfterMs` — the only field the harness retry policy
     * honors. Dropped here, the host can only fall back to its own backoff.
     */
    retryAfterMs?: number
  }

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
  /**
   * Expiry of this package, verbatim from the upstream (ISO string).
   *
   * Absent when the upstream reported no expiry — including the year-9999 "never"
   * sentinel, which the transport drops rather than forwarding.
   */
  packageEndTime?: string
  /**
   * The package's own localized titles, when the upstream sent a real display name.
   * The renderer picks the active language; `packageName` stays the single-language
   * fallback.
   */
  packageNameI18n?: { zh?: string | undefined; en?: string | undefined }
  /** Opaque upstream code for the same grant (`act-<date>-<n>`), when known. */
  packageCode?: string
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
 * Qoder reports a `priceFactor` number; the host spells it `x<n>`. The card wants
 * one shape: a trimmed multiplier without the trailing "credits".
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined
  const trimmed = credits.trim().replace(/\s+credits?$/iu, '')
  return trimmed === '' ? undefined : trimmed
}

/**
 * Classify a raw HTTP upstream failure from status and a body excerpt.
 *
 * A documented result code outranks the status: Qoder answers a saturated queue
 * or a spent daily window with 401/403, and reading either as a dead credential
 * would park a healthy account. Status comes next, then body phrases.
 */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  const lower = body.toLowerCase()
  // Qoder announces a saturated queue (or an unavailable region service) with a
  // 401/403 carrying the queue markers. That is a throttle: the host retries
  // soft_rate and honors retryAfterSeconds, while 'auth' would park the account.
  if (qoderQueueSignal(body) !== undefined) return 'soft_rate'
  // A documented quota code outranks the status arms: a spent daily window arrives
  // as 403 `{"code":"110","message":"Billing daily count exceeded"}`, which status
  // alone reads as a dead credential. The prose caution below still holds for every
  // body that names no code.
  const documented = qoderResultCode(body)
  if (documented?.family === 'quota') return 'quota_exceeded'
  // A documented request/policy code is the same shape: Qoder can name 406/80411
  // while answering 401/403, which the status arm would read as a dead credential.
  if (documented?.family === 'request') return 'client'
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
  if (status === 408) return 'timeout'
  // A status of 0 means the request never received a response at all, so there is
  // no server verdict to report: the network dropped it. Reading that as 'server'
  // makes a local outage look like an upstream 5xx.
  if (status === 0) return 'timeout'
  if (status >= 500) return 'server'
  return 'client'
}

/**
 * Map one structured transport failure onto the shim's error kind.
 *
 * Code families are tested before the status arm because the upstream keeps its
 * 401/403 for throttles, spent windows, and refused requests alike: letting the
 * status claim them would report a dead credential the host never retries.
 * `status === 402` is tested before the request arm because the transport codes a
 * 402 as `INVALID_REQUEST`.
 */
export function kindFromQoderFailure(failure: { code: string; status?: number | undefined }): UpstreamErrorKind {
  if (failure.code === 'MISSING_CREDENTIAL') return 'missing_credential'
  if (failure.code === 'RATE_LIMIT') return 'soft_rate'
  // A quota code outranks the status arms: the transport codes a spent daily window
  // QUOTA while keeping the upstream's 403, which status-first would read as an
  // authorization rejection. `ACCOUNT_QUOTA` is the kernel's name for an
  // account-level balance, accepted as an alias so the two cannot route differently.
  if (failure.code === 'QUOTA' || failure.code === 'ACCOUNT_QUOTA') return 'quota_exceeded'
  // 402 before the request arm, so a 402 coded INVALID_REQUEST still reads as quota.
  if (failure.status === 402) return 'quota_exceeded'
  // The request/policy arm precedes auth: the transport keeps the upstream's 401/403
  // when a documented request code was named, and status-first would call a content
  // refusal a credential rejection.
  if (failure.code.startsWith('INVALID_') || failure.code.startsWith('UNSUPPORTED_') || failure.code === 'ATTACHMENT') {
    return 'client'
  }
  if (failure.code === 'AUTH' || failure.status === 401 || failure.status === 403) return 'auth'
  if (failure.status === 429) return 'soft_rate'
  // A timeout keeps its own kind so the shim can answer 408: pi-ai reads a 5xx
  // number as SERVER before it ever tests for a timeout.
  if (failure.code === 'TIMEOUT') return 'timeout'
  // TRANSPORT means the request never got a response: a dropped connection, a
  // stalled TLS handshake, a DNS failure. The upstream never answered, so the shim
  // must not claim it did. 408 keeps the host retrying, and keeps the card from
  // reading a local outage as a server fault.
  if (failure.code === 'TRANSPORT') return 'timeout'
  // SERVER, EMPTY_RESPONSE, MALFORMED_RESPONSE, PROVIDER_ERROR, and anything
  // unrecognized: a server-side condition.
  return 'server'
}

/** How many times a save validates before it reports the endpoint as unreachable. */
const validateAttempts = 3

/** Base backoff between validation attempts; each retry waits one more step. */
const validateRetryDelayMs = 400

/**
 * Whether a validation failure carried no verdict from the upstream, which makes it
 * a network condition rather than a rejection of the credential.
 *
 * A documented refusal — a 401/403, an auth code, a policy code — answers the
 * question the card asked, so it stays a `false`. Everything that never reached the
 * server (TRANSPORT), or reached it and got no usable answer (TIMEOUT, 5xx), is
 * retried and finally reported as an error. Errors outside the transport's own
 * taxonomy keep the old answer: the token could not be saved.
 */
function isUnreachableFailure(error: unknown): boolean {
  if (!(error instanceof QoderLlmError)) return false
  const { code, status } = error.failure
  if (code === 'TRANSPORT' || code === 'TIMEOUT') return true
  return typeof status === 'number' && status >= 500
}

/** Whether a Personal Access Token works against one region's endpoints. */
export async function validateApiKey(
  pat: string,
  region: QoderRegion,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<boolean> {
  const trimmed = pat.trim()
  if (trimmed === '') return false
  const timeoutMs = options.timeoutMs ?? 15_000
  let lastTransportError: unknown
  // A refused token and an unreachable endpoint are different answers, and the card
  // asks both of them here. Retry the ones that carry no verdict from the upstream,
  // and let them leave as an error instead of a refusal: a dropped connection says
  // nothing about the credential, and reporting it as one sends the user to
  // regenerate a token that was never the problem.
  for (let attempt = 0; attempt < validateAttempts; attempt++) {
    try {
      const transport = createQoderTransport({
        region,
        resolvePat: async () => trimmed,
        ...options.fetch === undefined ? {} : { fetch: options.fetch },
        metadataTimeoutMs: timeoutMs,
      })
      await transport.discoverModels(AbortSignal.timeout(timeoutMs))
      return true
    } catch (error) {
      if (!isUnreachableFailure(error)) return false
      lastTransportError = error
      if (attempt + 1 < validateAttempts) {
        await new Promise((resolve) => setTimeout(resolve, validateRetryDelayMs * (attempt + 1)))
      }
    }
  }
  throw new QoderLlmError(
    `The ${region} endpoint could not be reached; the token was never refused.`,
    'TRANSPORT',
    { cause: lastTransportError },
  )
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
 * With `imagesAs`, image parts are committed; a request carrying images without a
 * commit path fails as a client error, since the Qoder wire only transports a
 * durable attachment reference.
 */
async function openAiContentBlocks(
  content: unknown,
  role: 'user' | 'assistant',
  imagesAs: { commit(part: { mediaType: ImageMediaType; data: Uint8Array }): Promise<ContentBlock> } | undefined,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []
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
 * Deliberately narrow: it accepts exactly what pi-ai's `openai-completions` API
 * sends and rejects anything else with an attributable 400 rather than silently
 * dropping a caller's intent. System prompts ride `options.system`; tool results
 * become dedicated user-role messages the Qoder serializer accepts.
 */
async function toGenerateOptions(
  bodyJson: string,
  context: {
    providerId: string
    attachments: Pick<AttachmentStore, 'saveImage'> | undefined
    signal?: AbortSignal | undefined
    sessionId?: string | undefined
    purpose?: GenerateOptions['purpose']
  },
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
    ...context.sessionId === undefined ? {} : { sessionId: context.sessionId as NonNullable<GenerateOptions['sessionId']> },
    ...context.purpose === undefined ? {} : { purpose: context.purpose },
  }
}

/**
 * Re-serialize one `StreamChunk` sequence into OpenAI chunk frames.
 *
 * One assistant choice, deltas keyed by a per-block tool-call index, reasoning
 * streamed as `delta.reasoning_content`, usage as a choices-less frame before the
 * terminal finish, and `data: [DONE]` last. A failed finish mid-stream becomes an
 * error JSON frame then `[DONE]`: the HTTP status is already sent.
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
        // The token counts are DISJOINT by contract (`inputTokens` excludes cached
        // input), so `prompt_tokens` is the sum.
        //
        // `prompt_tokens_details` MUST ride back out: the harness reads the cache-hit
        // share off `prompt_tokens_details.cached_tokens`, so a frame carrying only
        // the aggregate counters reports every cached token as a miss. Emit it only
        // when the transport reported a cache counter.
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

/**
 * Normalize a provider retry hint for {@link QoderChatResult}.
 *
 * Only a positive finite number is a hint: the truncation keeps the shim's
 * `Retry-After` an integer number of seconds, and `undefined` keeps the optional
 * field off the result entirely.
 */
export function retryHintOf(value: unknown): { retryAfterMs?: number } {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { retryAfterMs: Math.floor(value) }
    : {}
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
    return { ok: false, status, kind, message: error.failure.message, ...retryHintOf(error.failure.providerRetryAfterMs) }
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
   * The catalog row for one model id: this client's own discovery answers first,
   * and an externally supplied provider fills ids the discovery never listed.
   */
  catalogModelFor(id: string): QoderCatalogModel | undefined {
    return this.discovered.get(id) ?? this.externalCatalog?.(id)
  }

  /**
   * Discover this variant's models and translate them into plugin rows.
   *
   * The raw rows stay addressable via {@link catalogModelFor}: a chat request must
   * hand the transport its row, because effort support, image capability, and the
   * output cap are validated against it.
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
   * One personal quota, an optional organization package, bonus credits, and — on
   * the international edition — campaign grants, each becoming a package row. An
   * unbounded personal allowance (`total === 0`, not exceeded) is the "unlimited"
   * state. A campaign grant carries its own expiry and localized title, never
   * borrowed from the account.
   */
  async fetchCredits(signal?: AbortSignal): Promise<QoderCredits> {
    const account: QoderAccountInfo = await this.transport.readAccount({ force: true, ...signal === undefined ? {} : { signal } })
    const usage: QoderQuotaUsage = account.usage ?? {}
    const accounts: QoderCreditAccount[] = []
    const personal = usage.userQuota
    if (personal !== undefined) {
      accounts.push({
        packageName: '个人额度',
        remain: personal.remaining,
        size: personal.total,
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
    // Bonus credits sit beside the plan upstream (the daily campaign's grant lands
    // here); dropping the bucket makes the card list fewer packages than the
    // account holds.
    const addOn = usage.addOnQuota
    if (addOn !== undefined) {
      accounts.push({
        packageName: '赠送额度',
        remain: addOn.remaining,
        size: addOn.total,
        ...usage.expiresAt === undefined ? {} : { packageEndTime: usage.expiresAt },
      })
    }
    // Campaign grants are stacked in an array rather than a single named bucket, so
    // each one needs its own row; its own expiry travels with it, never the
    // account's.
    for (const pack of usage.dedicatedResourcePackages ?? []) {
      const titles = pack.title
      const fallbackName = titles?.zh ?? titles?.en ?? pack.name ?? '专属资源包'
      accounts.push({
        packageName: fallbackName,
        ...titles === undefined ? {} : { packageNameI18n: titles },
        ...pack.name === undefined ? {} : { packageCode: pack.name },
        remain: pack.remaining,
        size: pack.total,
        ...pack.expiresAt === undefined ? {} : { packageEndTime: pack.expiresAt },
      })
    }
    const unlimited = usage.isQuotaExceeded === false && personal !== undefined && personal.total === 0
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
   * everything rejectable without the network — a missing credential, an
   * unadvertised effort, an image on a text-only model — must still answer as a
   * real HTTP status, not a 200 whose first frame is an error. Once streaming has
   * begun, failures degrade to the error-frame-then-`[DONE]` form.
   */
  async chatStream(bodyJson: string, signal?: AbortSignal, sessionId?: string, purpose?: GenerateOptions['purpose']): Promise<QoderChatResult> {
    let options: GenerateOptions
    try {
      options = await toGenerateOptions(bodyJson, {
        providerId: this.providerId,
        attachments: this.attachments,
        sessionId,
        purpose,
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
          return {
            ok: false,
            status: earlyFailure.status ?? KIND_STATUS[kind],
            kind,
            message: earlyFailure.message,
            ...retryHintOf(earlyFailure.providerRetryAfterMs),
          }
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
   * A row that declares efforts is checked locally, so an unlisted value costs no
   * request; a row that declares none sends the value to the upstream, the only
   * authority on spellings the catalog never lists. Either refusal is an
   * attributable 400 with code `UNSUPPORTED_REASONING_EFFORT`, and the stream is
   * ended after the first chunk arrives.
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
        // A refusal the endpoint issued must reach the sweep under the same code as
        // one refused locally, or the sweep reads it as an unattributable failure.
        // Classify from the full message, before `detail` is capped, since both
        // markers sit past the cap.
        const code = status === 400 && blamesReasoningEffort(error.failure.message)
          ? 'UNSUPPORTED_REASONING_EFFORT'
          : error.failure.code
        return { status, streamed: false, errorCode: code, detail: error.failure.message.slice(0, 300) }
      }
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    }
  }
}

/**
 * Whether an upstream 400 blames the `reasoning_effort` value it was sent.
 *
 * Both markers are required: a 400 naming only one is some other parameter
 * problem, and the sweep must not record it as a rejected level.
 */
function blamesReasoningEffort(message: string): boolean {
  return message.includes('invalid_parameter_error') && message.includes('reasoning_effort')
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
 * The billing section reports the price factor only, spelled `x<n>`, and says so
 * honestly when the upstream reported nothing (`rateUnknown`). Context capacity
 * comes from the effective window, with the declared options kept for the card; a
 * row with no capacity takes the transport's default.
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
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.maxTokensDeclared === true ? { maxTokensDeclared: true } : {},
    supportsImages: model.supportsImages === true,
    ...reasoning === undefined ? {} : { reasoning },
    billing,
    ...model.source === undefined ? {} : { source: model.source },
  }
}

/** A conservative input budget for rows that declare none. */
const DEFAULT_CONTEXT_WINDOW = 180_000
