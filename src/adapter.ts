/**
 * The Qoder pi-ai provider: one loopback-backed adapter per variant route,
 * assembled from public `dsh-llm-pi-ai` extension points.
 *
 * @module dsh-qoder-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import type { QoderCredentialStore } from './auth.ts'
import type { QoderCatalog, QoderModelInfo } from './catalog.ts'
import type { QoderProbeRecord } from './probe-store.ts'
import { retryAfterFromMessage, type QoderShim } from './shim.ts'
import { normalizeCredits } from './upstream.ts'
import { qoderSessionHeaders, withQoderRequestPurpose } from './request-session.ts'
import { QoderTurnTracker } from './qoder/transport/wire/turn-identity.ts'
import type { QoderTurnIdentity } from './qoder/transport/wire/turn-identity.ts'

/** Default provider route owned by this bundle (the China variant). */
export const QODER_PROVIDER = 'qoder'

/**
 * Provider idle ceiling while one stream read is outstanding.
 *
 * It has to cover a queue wait, which the settings bound (up to an hour, the
 * official client's own limit) plus room for the replay: a shorter ceiling
 * would abort exactly the wait the user asked for.
 */
export const QODER_STREAM_IDLE_TIMEOUT_MS = 3_660_000

/**
 * Backoff ceiling for this plugin's routes: a hint above `maxDelayMs` makes the
 * host drop the retry instead of waiting, and Qoder asks for up to 30s.
 */
export const QODER_RETRY_MAX_DELAY_MS = 60_000

/**
 * Image-request budgets (dsh-llm-pi-ai defaults). They bound requests to models
 * whose catalog entry declares `supportsImages`; text-only models get none.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. Qoder routes authenticate only through the shim shared
 * secret, so pi-ai's own credential lifecycle must never manufacture one.
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-qoder-connect: Qoder routes have no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * The suffix appended to a model's display name so its billing rate is visible.
 *
 * The separator is a middle dot because model names commonly contain hyphens.
 */
const RATE_SEPARATOR = ' · '

/**
 * What the model seat shows in place of a rate the plugin cannot stand behind.
 *
 * A literal, not a locale lookup: the adapter is a host seam. Words beat an empty
 * slot because every other model in the seat shows a rate.
 */
const RATE_UNAVAILABLE = '价格暂不可用'

/**
 * Append the billing rate to one model's display name.
 *
 * Display-only: routing is built from `model.id`, and nothing in the host
 * resolves a model by name. The rate rides the name because the composer's model
 * seat renders `model.name` alone.
 */

/** The catalog display suffix: the normalized billing rate, when the row has one. */
function displaySuffix(info: QoderModelInfo): string | undefined {
  if (info.billing?.rateUnknown === true) return RATE_UNAVAILABLE
  const rate = normalizeCredits(info.billing?.credits)
  return rate === undefined || rate === '' ? undefined : rate
}

/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name: string, info: QoderModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${RATE_SEPARATOR}${suffix}`
}

/** Constructor dependencies. */
export interface QoderAdapterOptions {
  providerId?: string
  displayName?: string
  shim: QoderShim
  store: QoderCredentialStore
  catalog: QoderCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Look up a local probe observation for a model. Consulted only for rows the
   * upstream left undeclared; absent means declared-set-only behavior.
   */
  observe?: (modelId: string) => QoderProbeRecord | undefined
  /** Configured queue-wait budget in ms, read per call to size the idle window. */
  queueBudgetMs?: () => number
}

/** What {@link createQoderAdapter} hands back. */
export interface QoderAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/**
 * Resolve a Qoder model's reasoning capability into pi-ai's `thinkingLevelMap`
 * (every level pinned to its wire spelling, or `null` when unsupported).
 *
 * Two ordered sources: a declared `supportedEfforts` set always wins and is never
 * widened or narrowed by an observation; otherwise a *validating* local probe may
 * supply the verified spellings. A `non-validating` observation yields no control
 * — an upstream accepting impossible values would make every acceptance a false
 * positive. `off` is offered only when `canDisableThinking` is declared, never
 * probed. Internally the set means "verified accepted", not "verified effective".
 */
export function reasoningFields(
  info: QoderModelInfo,
  observed?: QoderProbeRecord,
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) {
    // Not a reasoning model: pi-ai reads a falsy `reasoning` as "off only".
    return { reasoning: false }
  }
  const declared = reasoning.supportedEfforts
  const efforts = declared !== undefined && declared.length > 0
    ? declared
    // Only a validating observation may supply a set, and only for rows the
    // upstream left undeclared.
    : observed?.validation === 'validating' && observed.efforts.length > 0
      ? observed.efforts
      : undefined
  if (efforts === undefined) {
    // Undeclared and unobserved (or observed as non-validating): no thinking
    // control, and no `reasoning_effort` on the wire.
    return { reasoning: false }
  }
  const map: Record<ModelThinkingLevel, string | null> = {
    // Probing never grants `off`; only an explicit declaration does.
    off: reasoning.canDisableThinking === true && declared !== undefined && declared.length > 0 ? 'off' : null,
    // `minimal` is not in the upstream effort vocabulary (EFFORT_VALUES), so
    // no declared set — and no probe candidate — can ever contain it.
    minimal: null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/**
 * Normalize `reasoning` on one resolved model so `normalizeModelInfo` never sees
 * a partial object. `dsh-llm` reads `reasoning.efforts.length` unconditionally,
 * so an adapter-side reasoning that has no array must be dropped entirely; a
 * valid one is passed through untouched.
 */
function normalizeReasoning<T extends { reasoning?: unknown }>(resolved: T): T {
  const reasoning = resolved.reasoning
  if (reasoning === undefined || reasoning === null) return resolved
  if (typeof reasoning !== 'object') return { ...resolved, reasoning: undefined }
  const efforts = (reasoning as { efforts?: unknown }).efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return { ...resolved, reasoning: undefined }
  return resolved
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: QoderModelInfo, baseUrl: string, observed?: QoderProbeRecord, providerId = QODER_PROVIDER): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info, observed),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    // Reporting a reserve makes the harness inject it as every request's maxTokens, so
    // only a provider-declared cap may be advertised.
    ...info.maxTokensDeclared === true && info.maxTokens !== undefined ? { maxTokens: info.maxTokens } : {},
    // pi-ai cannot infer the shim's field spelling from a random loopback
    // URL, so name the upstream-required field explicitly.
    compat: { maxTokensField: 'max_tokens' },
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. `getModels` reads the live catalog and each `baseUrl` is
 * re-resolved per read, so the shim's ephemeral port applies immediately.
 *
 * The profile is hand-built because dsh-llm-pi-ai's `resolveProfiles()` is not
 * public, so every newly required profile field must be adopted here explicitly.
 */
export function createQoderAdapter(options: QoderAdapterOptions): QoderAdapter {
  const { shim, store, catalog, resolveAttachments, observe } = options
  const providerId = options.providerId ?? QODER_PROVIDER
  const displayName = options.displayName ?? 'Qoder'

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, observe?.(info.id), providerId))
  }

  const api = openAICompletionsApi()
  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'Qoder shim shared secret',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: displayName }
        },
      },
    },
    models: buildModels(),
    // pi-ai receives the host session per call, but OpenAI's body omits it.
    // Carry it explicitly to our loopback shim for both dispatch entry points.
    api: {
      ...api,
      stream: (model, context, request) => api.stream(model, context, {
        ...request,
        headers: qoderSessionHeaders(request?.sessionId, request?.headers),
      }),
      streamSimple: (model, context, request) => api.streamSimple(model, context, {
        ...request,
        headers: qoderSessionHeaders(request?.sessionId, request?.headers),
      }),
    },
  })

  // `getModels` is delegated to a live read (the reuse-catalog pattern from
  // dsh-llm-pi-ai): stream dispatch still runs through the constructed
  // provider, while the catalog answer tracks the upstream refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    // Read per call: the queue budget is a setting, and the idle window has to
    // stay longer than it, or the wait the user asked for is cut short.
    get streamIdleTimeoutMs() {
      const budget = options.queueBudgetMs?.() ?? 0
      return Math.max(QODER_STREAM_IDLE_TIMEOUT_MS, budget + 60_000)
    },
    // A hint above `maxDelayMs` makes the host skip the retry instead of
    // waiting, so the ceiling must cover Qoder's own 30s.
    retryPolicy: resolveRetryPolicy({
      mode: 'normal',
      backoff: { maxDelayMs: QODER_RETRY_MAX_DELAY_MS },
    }, `dsh-qoder-connect:${providerId} retryPolicy`),
    configuredMaxTokens: new Map(),
    // Required profile field; the live catalog only exposes models that probed
    // successfully, so there is never a per-model failure to report.
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new QoderPiAiAdapter(catalog, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real Qoder credential
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}

/**
 * Keep a damaged tool call from executing with truncated arguments.
 *
 * pi-ai parses unparsable arguments as `{}` (the real text survives only in
 * `argumentsError`, which this layer never receives), so a tool with optional fields
 * would happily execute an empty or truncated payload. The raw bytes survive on the
 * `tool-call-delta` stream, and `dsh-llm`'s `BlockAssembler` prefers the `block-end`
 * block, so re-emitting the damaged text here makes the harness reject the call as
 * invalid arguments and the model re-emits it. Complete calls are untouched.
 *
 * @internal Exported for tests; the adapter wrappers are the only callers.
 */
export async function* rejectDamagedToolArguments(inner: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
  const accumulated = new Map<number, string>()
  for await (const chunk of inner) {
    if (chunk.type === 'tool-call-delta') {
      accumulated.set(chunk.index, (accumulated.get(chunk.index) ?? '') + chunk.argumentsDelta)
      yield chunk
      continue
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      const raw = accumulated.get(chunk.index)
      if (raw !== undefined && !isJsonObjectText(raw)) {
        yield { ...chunk, block: { ...chunk.block, arguments: raw } }
        continue
      }
    }
    yield chunk
  }
}

/** Whether the text parses as a JSON object, the only shape a tool call may carry. */
function isJsonObjectText(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

/**
 * The Qoder variant route's adapter: `PiAiAdapter` with the billing rate folded
 * into the catalog answers it returns to the DSH model pickers.
 *
 * The pi-ai descriptors carry no billing fact, so the rate is layered on from the
 * live catalog; both overrides delegate to `super` and rewrite display fields
 * only. A model missing from the catalog keeps its name rather than being
 * dropped: catalog membership is advisory.
 */
class QoderPiAiAdapter extends PiAiAdapter {
  /**
   * The agent run every step of one turn reports.
   *
   * One DSH turn is many model requests, and Qoder's Credits panel aggregates a
   * usage record per `business.id`. Resolving the run here — where the request's
   * durable messages still carry their ids and producer kinds — is what keeps a
   * whole turn on one record; pi-ai's own `Context` has already dropped both by
   * the time a provider sees it.
   */
  private readonly turns = new QoderTurnTracker()

  constructor(
    private readonly catalog: QoderCatalog,
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
  }

  /** Run identity for one request, resolved from its messages and its purpose. */
  private turnFor(options: GenerateOptions): QoderTurnIdentity {
    return this.turns.resolve(
      options.sessionId === undefined ? undefined : String(options.sessionId),
      options.messages,
      options.purpose === undefined ? 'conversation' : 'auxiliary',
    )
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  private infoFor(model: string): QoderModelInfo | undefined {
    return this.catalog.current().find(entry => entry.id === model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    return models.map(model => {
      const info = this.infoFor(model.id)
      if (info === undefined) return model
      return { ...model, name: withCatalogDisplay(model.name, info) }
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    return { ...resolved, name: withCatalogDisplay(resolved.name, info) }
  }

  /**
   * Restore `failure.providerRetryAfterMs`, which `dsh-llm-pi-ai` flattens away;
   * the shim's `[retry-after=<n>s]` tag is the carrier.
   *
   * Both entry points are wrapped because the harness uses `prepareCall().stream`,
   * which never calls `this.stream`. Only the field is rewritten, never the message.
   */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield* withQoderRequestPurpose(options.purpose,
      rejectDamagedToolArguments(this.withRetryHint(super.stream(options))),
      this.turnFor(options))
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await super.prepareCall(provider, model, signal)
    return {
      ...prepared,
      model: normalizeReasoning(prepared.model),
      stream: (options: GenerateOptions) => withQoderRequestPurpose(options.purpose,
        rejectDamagedToolArguments(this.withRetryHint(prepared.stream(options))),
        this.turnFor(options)),
    }
  }

  /** Re-stamp `failure.providerRetryAfterMs` on every terminal failure chunk. */
  private async *withRetryHint(inner: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    for await (const chunk of inner) {
      if (chunk.type === 'finish') {
        const { reason } = chunk
        if ((reason.kind === 'error' || reason.kind === 'aborted')
          && reason.failure.providerRetryAfterMs === undefined) {
          const retryAfterMs = retryAfterFromMessage(reason.failure.message)
          if (retryAfterMs !== undefined) {
            yield {
              ...chunk,
              reason: { ...reason, failure: { ...reason.failure, providerRetryAfterMs: retryAfterMs } },
            }
            continue
          }
        }
      }
      yield chunk
    }
  }

  /**
   * Resolve the request-image projection target for one route.
   *
   * `dsh-llm` calls `imageRequestTarget()` unconditionally but resolved this
   * plugin's peer `PiAiAdapter` may predate the method, so an inherited
   * implementation is derived from the profile budgets instead. When the base
   * implementation does exist, prefer it so this override never drifts.
   */
  imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef): ImageRequestTarget {
    const inherited = (Object.getPrototypeOf(QoderPiAiAdapter.prototype) as {
      imageRequestTarget?: (provider: string, model: string, image: ImageAttachmentRef) => ImageRequestTarget
    }).imageRequestTarget
    if (typeof inherited === 'function') return inherited.call(this, provider, model, image)
    const { width, height } = requestImageDimensions(
      image.width,
      image.height,
      REQUEST_IMAGE_BUDGETS.requestImagePixelBudget,
    )
    return { width, height, maxBytes: REQUEST_IMAGE_BUDGETS.requestImageMaxBytes }
  }
}
