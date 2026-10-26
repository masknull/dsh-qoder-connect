/**
 * Qoder models for DeepSeek Harness, driven by Personal Access Tokens.
 *
 * One provider per variant — `qoder` (China) and `qoder-global` — built by the
 * same factory and differing only in their {@link QoderVariant} descriptor.
 * Streaming, tool calls, compaction, and permissions stay Harness-owned.
 *
 * @module dsh-qoder-connect
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { QoderCredentialStore, qoderCredentialIdentity } from './auth.ts'
import { createAuthKey, registerQoderAuthRoute } from './auth-route.ts'
import { FALLBACK_QODER_MODELS, QoderCatalog } from './catalog.ts'
import { qoderCatalogPath, QoderCatalogStore } from './catalog-store.ts'
import { createQoderAdapter } from './adapter.ts'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createQoderShim } from './shim.ts'
import { QoderProbeService } from './probe-service.ts'
import { newestFirst, QoderProbeStore, qoderProbePath } from './probe-store.ts'
import { QoderUpstreamClient, validateApiKey } from './upstream.ts'
import { createQoderTransport, defaultStreamIdleTimeoutMs, type QoderCheckInResult, type QoderTransport } from './qoder/transport/index.ts'
import { getMachineId } from './qoder/transport/machine-id.ts'
import { configurePluginPaths, qoderMachineIdPath, qoderPluginDataDir, qoderStateDir } from './paths.ts'
import { createQueueHint, type QueueHintSession } from './queue-hint.ts'
import { registerInactiveStatusRoute, registerQoderStatusRoute } from './web-status.ts'
import { createProbeKey, registerQoderProbeRoute } from './probe-route.ts'
import { CheckInScheduler, DEFAULT_CHECK_IN_MINUTE, EARLIEST_CHECK_IN_MINUTE, JsonFileCheckInStore, normalizeCheckInMinute } from './checkin-scheduler.ts'
import type { QoderModelInfo } from './catalog.ts'
import type { QoderWebCatalog, QoderWebProbeSection } from './status-paths.ts'
import { QODER_SETTINGS_FACE_PATH } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { dispatchJobTokenNotice, emitNoticeRow } from './job-token-hint.ts'
import { SettingsStore } from './settings-store.ts'
import { QODER_CONNECT_VERSION } from './version.ts'
import { CHINA_VARIANT, GLOBAL_VARIANT, QODER_VARIANTS, type QoderVariant } from './variants.ts'

export { QODER_PROVIDER, QODER_STREAM_IDLE_TIMEOUT_MS, createQoderAdapter, type QoderAdapter } from './adapter.ts'
export { createQoderShim, type QoderShim, type ShimLogger } from './shim.ts'
export {
  FALLBACK_QODER_MODELS,
  QoderCatalog,
  type QoderModelBilling,
  type QoderModelInfo,
  type QoderModelReasoning,
} from './catalog.ts'
export { qoderCatalogPath, QoderCatalogStore, type QoderCatalogStoreOptions } from './catalog-store.ts'
export {
  fingerprintModel,
  QoderProbeStore,
  qoderProbePath,
  QODER_PROBE_FILENAME,
  type QoderProbeRecord,
  type QoderProbeValidation,
} from './probe-store.ts'
export {
  PROBE_EFFORT_CANDIDATES,
  randomSentinel,
  probeModel,
  type ProbeAttempt,
  type ProbeOutcome,
  type ProbeSender,
} from './probe.ts'
export { QoderProbeService, type QoderProbeStatus } from './probe-service.ts'
export {
  CHINA_VARIANT,
  GLOBAL_VARIANT,
  QODER_VARIANTS,
  variantFor,
  type QoderVariant,
  type QoderVariantId,
} from './variants.ts'
export {
  patTail,
  qoderCredentialId,
  qoderCredentialIdentity,
  QoderCredentialStore,
  qoderOwnAuthPath,
  qoderPluginDataDir,
  QODER_AUTH_FILENAME,
  QODER_DATA_DIR_ENV,
  QODER_DATA_DIR_NAME,
  QODER_PAT_ENV_CN,
  QODER_PAT_ENV_GLOBAL,
  type QoderAuthStatus,
  type QoderCredential,
  type QoderCredentialEntry,
} from './auth.ts'
export {
  createAuthKey,
  qoderAuthHandler,
  registerQoderAuthRoute,
  type QoderAuthRouteOptions,
  type QoderAuthSaveResult,
} from './auth-route.ts'
export {
  QODER_AUTH_PATH,
  QODER_GLOBAL_AUTH_PATH,
  QODER_GLOBAL_PROBE_PATH,
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
  type QoderAuthRequest,
  type QoderCatalogModelSnapshot,
  type QoderPatProfile,
  type QoderPatSummary,
  type QoderProbeAction,
  type QoderWebCatalog,
  type QoderWebCredits,
  type QoderWebCreditAccount,
  type QoderWebProbeModel,
  type QoderWebProbeSection,
  type QoderWebStatus,
} from './status-paths.ts'
export {
  classifyUpstreamError,
  kindFromQoderFailure,
  KIND_STATUS,
  modelInfoOf,
  normalizeCredits,
  QoderUpstreamClient,
  type QoderCatalogFetch,
  type QoderChatResult,
  type QoderCredits,
  type QoderCreditAccount,
  type QoderEffort,
  type UpstreamErrorKind,
} from './upstream.ts'
export {
  QODER_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  readHostHeartbeat,
  qoderHostHeartbeatPath,
  type QoderHostHeartbeat,
} from './host-heartbeat.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-qoder'

/** The model registry the provider needs before it can register. */
export const inject = ['llm']

/**
 * Settings namespace for the China card's section.
 *
 * A namespace is a nominal string checked at compile time only; the cast keeps
 * the public constant typed without pulling the branding helper into this package.
 */
export const QODER_SETTINGS_NS = 'qoder' as SettingsNamespace

/**
 * Settings namespace for the global card's section.
 *
 * One namespace per card: the Plugins tab dispatches a card per served
 * namespace, so a single section would leave the other card registered but
 * never rendered.
 */
export const QODER_GLOBAL_SETTINGS_NS = 'qoder-global' as SettingsNamespace

/**
 * Settings namespace for the shared quota card, whose per-variant fields
 * configure both sidebar widgets from one place.
 */
export const QODER_QUOTA_SETTINGS_NS = 'qoder-quota' as SettingsNamespace

/**
 * How often the credential files are re-checked, in milliseconds. A local
 * existence/parse read only — never the network, never a reasoning probe.
 *
 * `DSH_QODER_POLL_MS` overrides it for tests and diagnosis: clamped, not a
 * product setting, and no UI exposes it.
 */
const CREDENTIAL_POLL_MS = 30_000

/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100
const MAX_POLL_MS = 24 * 60 * 60 * 1000

/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs(): number {
  const override = Number(process.env['DSH_QODER_POLL_MS'])
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * How many credential sweeps to wait before retrying a failed catalog fetch.
 *
 * A live catalog is never re-fetched on a sweep (the same token carries no new
 * model information), but a *failed* one must recover on its own — one startup
 * blip must not pin the group to the fallback roster until a manual refresh.
 * A multiple of the sweep so the `DSH_QODER_POLL_MS` override scales both.
 */
const CATALOG_RETRY_SWEEPS = 10

/** Plugin configuration. */
export interface Config {
  /** Whether the user authorized reasoning-effort probes (each one spends real credit). */
  probeConsent?: boolean
  /** Use the largest context window the global catalog explicitly offers. */
  useMaximumContextWindow?: boolean
  /** The China variant's own maximum-window preference. */
  useMaximumContextWindowCN?: boolean
  /** Per-model context-window overrides, global (model id → tokens); kept for schema compatibility. */
  modelContextWindows?: Record<string, number>
  /** The China variant's per-model overrides; see {@link Config.modelContextWindows}. */
  modelContextWindowsCN?: Record<string, number>
  /** Models disabled for the global variant (blacklist). */
  disabledModels?: string[]
  /** Models disabled for the China variant (blacklist). */
  disabledModelsCN?: string[]
  /** Show the China variant's sidebar quota card. */
  sidebarQuotaCN?: boolean
  /** Show the global variant's sidebar quota card. */
  sidebarQuotaGlobal?: boolean
  /** Automatically check in daily at 10:00 (UTC+8) to claim credits for China variant. */
  autoCheckInCN?: boolean
  /** Automatically check in daily at 10:00 (UTC+8) to claim credits for Global variant. */
  autoCheckInGlobal?: boolean
  /** When the China variant checks in, as minutes past midnight in UTC+8 (600 = 10:00). */
  checkInMinuteCN?: number
  /** When the Global variant checks in, as minutes past midnight in UTC+8 (600 = 10:00). */
  checkInMinuteGlobal?: number
  /** Sidebar quota refresh interval in ms, shared by both cards (same rate-limited upstream). */
  quotaPollMs?: number
  /**
   * Wait out Qoder's model queue inside the plugin (default on). When off, a
   * queue answer keeps its retry hint and is handed to the host instead.
   */
  queueWait?: boolean
  /** Upper bound of that wait, in seconds (10–3600). */
  queueWaitSeconds?: number
}

/**
 * Mark one configuration field as a projected (volatile) setting, when the host
 * has that concept: a projected field reaches the settings form and arrives as a
 * stable reference instead of a value. The method is probed, never assumed — an
 * older host has none and would throw. Only top-level fields may be marked.
 *
 * @param field - the field's schema.
 * @returns the projected schema on a host that supports projection, else the field itself.
 */
function volatileField<T extends object>(field: T): T {
  const probe = field as unknown as { volatile?: () => T; extra?: (key: string, value: unknown) => T; meta?: Record<string, unknown> }
  if (typeof probe.volatile === 'function') return probe.volatile()
  if (typeof probe.extra === 'function') return probe.extra('volatile', true)
  if (probe && typeof probe === 'object') {
    probe.meta = { ...probe.meta, volatile: true }
    return probe as T
  }
  return field
}

/**
 * Read one configuration field through the volatile indirection: a projected
 * field is a reference read with `.get()`, a plain field arrives as its value.
 *
 * @param config - the raw plugin configuration, in either host's shape.
 * @param field - field name inside the configuration object.
 * @returns the field's value, or undefined when the field is absent.
 */
function readField(config: Config | undefined, field: keyof Config): unknown {
  const value = (config as Record<string, unknown> | undefined)?.[field]
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get: () => unknown }).get()
    : value
}

/**
 * Typed face of {@link readField} for a single declared field.
 *
 * @returns the field's plain value, or undefined when it is absent.
 */
function readConfigField<K extends keyof Config>(config: Config | undefined, field: K): Config[K] {
  return readField(config, field) as Config[K]
}

/** Probe authorization (shared by the plugin schema and the China section). */
const PROBE_CONSENT_FIELD = volatileField(z.boolean().default(false)
  .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)'))
const MAXIMUM_CONTEXT_WINDOW_FIELD = volatileField(z.boolean().default(true)
  .description('Use the largest context window declared by Qoder Global when alternatives are available (on by default)'))
/** The China variant's own maximum-window preference. */
const MAXIMUM_CONTEXT_WINDOW_CN_FIELD = volatileField(z.boolean().default(true)
  .description('Use the largest context window declared by Qoder (China) when alternatives are available (on by default)'))
/** Per-model window overrides (model id → tokens); absent means "no overrides". */
const MODEL_CONTEXT_WINDOWS_FIELD = volatileField(z.dict(z.number().min(1), z.string())
  .description('Per-model context-window overrides for Qoder Global (model id → tokens)'))
/** Disabled models list (blacklist) */
const DISABLED_MODELS_FIELD = volatileField(z.array(z.string()).default([])
  .description('Models hidden from the provider catalog and picker'))
/** Sidebar quota toggle (one per variant; both live on the shared quota card). */
const QUOTA_TOGGLE_FIELD = volatileField(z.boolean().default(false)
  .description('Show this variant’s remaining-credit card in the sidebar footer (off by default)'))
/** Automatic check-in toggle. */
const AUTO_CHECK_IN_FIELD = volatileField(z.boolean().default(false)
  .description('每天自动签到领取算力额度（默认关闭）'))
/**
 * When a variant checks in, as minutes past UTC+8 midnight (0–1439), so the
 * schema itself rejects an impossible time. The floor is the upstream window's
 * 10:00 opening: an earlier run could only settle the previous day.
 */
const CHECK_IN_MINUTE_FIELD = volatileField(z.number()
  .default(DEFAULT_CHECK_IN_MINUTE)
  .min(EARLIEST_CHECK_IN_MINUTE)
  .max(1439)
  .description('每日自动签到的时刻（自 UTC+8 午夜起的分钟数，600 = 10:00；最早 10:00，即活动窗口开启时刻）'))
/**
 * Quota poll interval: default 5 minutes, floor 1 minute. The status route makes
 * a live, uncached upstream billing call per request, so the floor is the
 * smallest value the UI offers rather than a silent clamp.
 */
export const QUOTA_POLL_DEFAULT_MS = 300_000
export const QUOTA_POLL_MIN_MS = 60_000
const QUOTA_POLL_FIELD = volatileField(z.number()
  .default(QUOTA_POLL_DEFAULT_MS)
  .min(QUOTA_POLL_MIN_MS)
  .description('Sidebar quota card refresh interval in milliseconds (default 300000, minimum 60000)'))
/**
 * Queue wait: when on, a 10605 answer is polled inside the plugin and replayed.
 * When off, the failure keeps its retry hint and goes to the host unchanged.
 */
const QUEUE_WAIT_FIELD = volatileField(z.boolean().default(true)
  .description('Retry inside the plugin: polls the model queue, then replays. Off hands the request result to the host unchanged'))
/**
 * How long one call may wait in the model queue, in seconds.
 *
 * Only a floor is enforced: the wait is a budget the user owns, and the loop
 * divides it by whatever pace the upstream reports, so a value larger than the
 * upstream's own countdown simply spans more rounds.
 */
export const QUEUE_WAIT_SECONDS_DEFAULT = 540
export const QUEUE_WAIT_SECONDS_MIN = 1
const QUEUE_WAIT_SECONDS_FIELD = volatileField(z.number()
  .default(QUEUE_WAIT_SECONDS_DEFAULT)
  .min(QUEUE_WAIT_SECONDS_MIN)
  .description('How long the plugin may wait in the model queue, in seconds; each poll still waits the pace Qoder reports'))

export const Config: z<Config> = z.object({
  probeConsent: PROBE_CONSENT_FIELD,
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
  useMaximumContextWindowCN: MAXIMUM_CONTEXT_WINDOW_CN_FIELD,
  modelContextWindows: MODEL_CONTEXT_WINDOWS_FIELD,
  modelContextWindowsCN: MODEL_CONTEXT_WINDOWS_FIELD,
  // Must be declared at the TOP level: the host projects an entry's settings
  // form from this schema, so an undeclared field reaches neither the settings
  // document nor the Models page.
  disabledModels: DISABLED_MODELS_FIELD,
  disabledModelsCN: DISABLED_MODELS_FIELD,
  sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
  sidebarQuotaGlobal: QUOTA_TOGGLE_FIELD,
  autoCheckInCN: AUTO_CHECK_IN_FIELD,
  autoCheckInGlobal: AUTO_CHECK_IN_FIELD,
  checkInMinuteCN: CHECK_IN_MINUTE_FIELD,
  checkInMinuteGlobal: CHECK_IN_MINUTE_FIELD,
  quotaPollMs: QUOTA_POLL_FIELD,
  queueWait: QUEUE_WAIT_FIELD,
  queueWaitSeconds: QUEUE_WAIT_SECONDS_FIELD,
})

/**
 * The field groups the configuration is merged from, one list per card: a field
 * added to {@link Config} but missing here is never read.
 */
export const CN_SECTION_KEYS = [
  'probeConsent',
  'useMaximumContextWindowCN',
  'modelContextWindowsCN',
  'disabledModelsCN',
] as const satisfies readonly (keyof Config)[]

export const GLOBAL_SECTION_KEYS = [
  'useMaximumContextWindow',
  'modelContextWindows',
  'disabledModels',
] as const satisfies readonly (keyof Config)[]

export const QUOTA_SECTION_KEYS = [
  'sidebarQuotaCN',
  'sidebarQuotaGlobal',
  'autoCheckInCN',
  'autoCheckInGlobal',
  'checkInMinuteCN',
  'checkInMinuteGlobal',
  'quotaPollMs',
  'queueWait',
  'queueWaitSeconds',
] as const satisfies readonly (keyof Config)[]

/** Every declared configuration field, in the order the sections are merged. */
const CONFIG_KEYS = [
  ...CN_SECTION_KEYS,
  ...GLOBAL_SECTION_KEYS,
  ...QUOTA_SECTION_KEYS,
] as const satisfies readonly (keyof Config)[]

/** Copy the declared fields off one section's source, skipping absent ones. */
function pickFields<K extends keyof Config>(
  source: () => Config | undefined,
  keys: readonly K[],
): Partial<Config> {
  const value = source()
  const picked: Partial<Config> = {}
  for (const key of keys) {
    // Through `readField`: a projected field is a reference and must never be
    // copied into the merged configuration.
    const field = readField(value, key)
    if (field !== undefined) (picked as Record<string, unknown>)[key] = field
  }
  return picked
}

/**
 * Unwrap a whole configuration object into plain values, for the direct reads
 * made before any settings section supplies a source.
 *
 * @param config - the raw plugin configuration, in either host's shape.
 * @returns the same configuration with every declared field read out.
 */
function readConfig(config: Config | undefined): Config {
  return pickFields(() => config, CONFIG_KEYS)
}

/** One variant's live runtime, assembled by {@link createVariantRuntime}. */
interface VariantRuntime {
  variant: QoderVariant
  store: QoderCredentialStore
  client: QoderUpstreamClient
  transport: QoderTransport
  catalog: QoderCatalog
  probeStore: QoderProbeStore
  probeService: QoderProbeService
  /**
   * The last catalogs that loaded, keyed by account: serves what this token was
   * last actually shown, ahead of the compiled-in roster, after a restart or a
   * fetch that fails while offline.
   */
  savedCatalogs: QoderCatalogStore
  /** The static roster this variant falls back to. */
  fallback: readonly QoderModelInfo[]
  /**
   * Where the served models came from, in degradation order:
   * `live` → `saved` (this account's last fetch) → `fallback` (built-in roster).
   */
  catalogSource: 'live' | 'saved' | 'fallback'
  /** When the served catalog was fetched, for `live` and `saved`. */
  catalogFetchedAtMs: number | undefined
  /** Why the last catalog attempt failed, when it did. */
  catalogError: string | undefined
  /** When the last catalog attempt started, for the retry backoff. */
  lastFetchAtMs: number
  /**
   * Bumped on a token switch, a sign-out, or a newer fetch. A request carries
   * the generation it started under and refuses to write back once it moved, so
   * a slow answer cannot resurrect data the plugin has since dropped.
   */
  catalogGeneration: number
  /**
   * The in-flight catalog fetch, scoped to the identity and generation it began
   * under; a token change aborts it and starts one for the new account.
   */
  inflightFetch: CatalogFetch | undefined
  /** Notify the model directory that this variant's answers changed. */
  invalidate: () => void
  /** Configured queue-wait budget in ms, read per call. */
  queueBudgetMs: () => number
  /**
   * One-line diagnostic sink for the hand-back log. The loopback hop records its
   * lifecycle here too, so a wait that died early can be told apart from one that
   * never started.
   */
  diag: (message: string) => void
  /** Whether the provider registered successfully. */
  registered: boolean
  /**
   * When the self-heal last auto-refreshed this variant's job token, epoch ms;
   * surfaced on the card so the recovery shows.
   */
  jobTokenRefreshedAt: () => number | undefined
  /**
   * Claim today's daily benefit for this variant's account, used by both the
   * check-in scheduler and the card's manual button. A named field rather than a
   * cast out of the transport, which would fail silently instead of compiling.
   */
  checkIn: (signal?: AbortSignal) => Promise<QoderCheckInResult>
}

/** One catalog request plus the identity state it is allowed to update. */
interface CatalogFetch {
  identity: string
  generation: number
  controller: AbortController
  promise: Promise<void>
}

/** Stable identity key used by credentials, probe records, and catalog entries. */
const credentialIdentity = qoderCredentialIdentity

/**
 * The static catalog a variant serves before its first successful fetch: one
 * roster for both regions, transcribed from the transport's model defaults.
 */
function fallbackFor(_variant: QoderVariant): readonly QoderModelInfo[] {
  return FALLBACK_QODER_MODELS
}

/** The hint row's summary line: what happened, and when. */
function jobTokenHintText(at: number): string {
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  return `jobToken 已自动刷新（${time}）— 旧令牌被上游拒绝，已自动重换并恢复`
}

/**
 * The failed-heal row's summary line. Deliberately names no cause — the real
 * reason travels in the failure message — and must not point at "the error
 * above", since the heal may belong to a request that renders no card.
 */
function jobTokenRefreshFailedHintText(at: number): string {
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  return `jobToken 已重换但仍被上游拒绝（${time}）— 自愈未恢复，该请求已失败`
}

/**
 * The filtered-reply row's summary line.
 *
 * The upstream cut the answer by policy; the turn still ends normally, so without this
 * row the user would read a truncated reply as a complete one.
 */
function contentFilterHintText(reason: string): string {
  return `回复被上游内容安全策略过滤（${reason}），内容可能不完整`
}

/** The compaction-specific wording: the summary, not the conversation reply, was cut short. */
function compactionFilteredHintText(reason: string): string {
  return `压缩摘要被上游内容安全策略过滤（${reason}），压缩结果可能不完整`
}

/** Build one variant's stores, transport, and probe state. */
function createVariantRuntime(
  ctx: Context,
  config: Config,
  variant: QoderVariant,
  current: () => Config,
  identityOf: (variantId: string) => string | undefined,
): VariantRuntime {
  const store = new QoderCredentialStore({ variant, logger: ctx.logger })
  // The self-heal's auto-refresh record, surfaced on the card (per variant).
  let jobTokenRefreshedAt: number | undefined
  // The attachment service may be absent at construction (a headless profile
  // never has one), so both get a facade that resolves the real store per request.
  const resolveAttachmentService = (): AttachmentStore => {
    const service = ctx.get('attachments')
    if (service === undefined) {
      throw new Error('dsh-qoder-connect: no attachment service is available')
    }
    return service
  }
  const attachments: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest' | 'saveImage'> = {
    get imageLimits() {
      return resolveAttachmentService().imageLimits
    },
    readImageRequest: async (attachment, policy, signal) =>
      await resolveAttachmentService().readImageRequest(attachment, policy, signal),
    saveImage: async request => await resolveAttachmentService().saveImage(request),
  }
  // Queue decisions go to a file the user can hand back verbatim.
  const queueDiagPath = join(qoderPluginDataDir(), 'log', 'queue.log')
  rotateQueueLog(queueDiagPath)
  const writeQueueDiag = (line: string): void => {
    try {
      mkdirSync(dirname(queueDiagPath), { recursive: true })
      appendFileSync(queueDiagPath, `${new Date().toISOString()} ${variant.id} ${line}\n`)
    } catch {
      // Diagnostics only; never affect the chat.
    }
  }
  const configuredQueueWaitMs = (): number => Math.max(
    QUEUE_WAIT_SECONDS_MIN * 1_000,
    (current().queueWaitSeconds ?? QUEUE_WAIT_SECONDS_DEFAULT) * 1_000,
  )
  const sessionOf = (id: string | undefined): QueueHintSession | undefined =>
    id === undefined ? undefined : (ctx.get('sessions') as { get(id: string): QueueHintSession | undefined } | undefined)?.get(id)
  // A heal row goes only into the request's own session; unattributed prints nothing.
  const emitNotice = (sessionId: string | undefined, kind: 'success' | 'error', text: string): void => {
    dispatchJobTokenNotice({ text, kind, sessionId, resolveSession: id => sessionOf(id) })
  }
  const transport = createQoderTransport({
    region: variant.region,
    resolvePat: () => store.patPromise(),
    // A settings toggle must reach the next call, not the next restart.
    queueWait: () => current().queueWait !== false,
    // The configured wait is the only cap: each poll still waits the upstream's
    // own retryAfterSeconds, and a shorter budget simply ends the wait sooner.
    queueWaitBudgetMs: configuredQueueWaitMs,
    // The idle window must not become a second, shorter cap on that wait: a
    // stream-idle window is about a stalled socket, and the configured budget is
    // what bounds a deliberate wait. Every poll round also restarts this clock,
    // so raising it here only removes a cliff a long setting would hit.
    streamIdleTimeoutMs: Math.max(
      defaultStreamIdleTimeoutMs,
      configuredQueueWaitMs() + 60_000,
    ),
    // Keep the machine-id seed inside the plugin's own data directory
    // (state/) instead of letting the transport write it near $HOME.
    resolveMachineId: () => getMachineId([qoderMachineIdPath()]),
    attachments,
    onDiag: writeQueueDiag,
    onJobTokenRefreshed: info => {
      jobTokenRefreshedAt = info.at
      ctx.logger.warn(
        `dsh-qoder-connect: ${variant.displayName} job token was auto-refreshed after an upstream rejection`,
      )
      emitNotice(info.sessionId, 'success', jobTokenHintText(info.at))
    },
    onJobTokenRefreshFailed: info => {
      // The heal ran and lost; announced at most once per outage.
      ctx.logger.warn(
        `dsh-qoder-connect: ${variant.displayName} job token refresh did not recover the chat (upstream status ${info.status ?? 'unknown'})`,
      )
      emitNotice(info.sessionId, 'error', jobTokenRefreshFailedHintText(info.at))
    },
    createQueueWaitHandler: options => createQueueHint({
      sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
      purpose: options.purpose,
      displayName: variant.displayName,
      resolveSession: id => sessionOf(id),
      onDiag: writeQueueDiag,
    }),
    // A filtered ending is reported as a normal stop (the official client calls it a refusal,
    // which this host cannot express), so the row is the only trace. A title request gets the
    // diagnostic only: its filter must not claim the conversation's reply was cut short. A
    // compaction request DOES get a row, worded for the summary it was producing.
    createNoticeHandler: options => {
      const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
      const purpose = options.purpose
      return notice => {
        writeQueueDiag(`notice: ${notice.kind} (${notice.reason}) purpose=${purpose ?? 'none'} sessionId=${sessionId ?? 'none'}`)
        if (purpose === 'session-title') return
        const session = sessionOf(sessionId)
        if (session === undefined) return
        emitNoticeRow(session, 'error', purpose === 'compaction'
          ? compactionFilteredHintText(notice.reason)
          : contentFilterHintText(notice.reason))
      }
    },
  })
  const client = new QoderUpstreamClient({
    region: variant.region,
    providerId: variant.id,
    getPat: () => store.patPromise(),
    transport,
    attachments,
  })
  const fallback = fallbackFor(variant)
  const catalog = new QoderCatalog(fallback)
  // Read initial preferences through the LIVE `current()` view, never the bare
  // entry config: the plugin-owned settings file is the live source, and the
  // entry is empty once its row has been cleaned.
  const initial = current()
  if (variant.id !== CHINA_VARIANT.id) {
    catalog.setUseMaximumContextWindow(initial.useMaximumContextWindow === true)
    if (initial.disabledModels !== undefined) catalog.setDisabledModels(initial.disabledModels)
  } else {
    catalog.setUseMaximumContextWindow(initial.useMaximumContextWindowCN === true)
    if (initial.modelContextWindowsCN !== undefined) catalog.setModelContextWindows(initial.modelContextWindowsCN)
    if (initial.disabledModelsCN !== undefined) catalog.setDisabledModels(initial.disabledModelsCN)
  }
  // Start hidden: a variant must serve no models until a token has actually been
  // adopted, so a signed-out variant is empty rather than showing a roster that
  // could only fail. `adoptIdentity` is what reveals it.
  catalog.setVisible(false)
  const probeStore = new QoderProbeStore({
    pluginVersion: QODER_CONNECT_VERSION,
    path: qoderProbePath(variant.probeFilename),
  })
  // One file per variant: the two regions can disagree about rates and windows
  // for shared model ids, so a saved China roster must never serve as a global one.
  const savedCatalogs = new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) })
  const probeService = new QoderProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent: () => current().probeConsent === true,
    // Per account: one token's detected levels never answer for another's.
    account: () => identityOf(variant.id),
  })
  return {
    variant,
    store,
    client,
    transport,
    catalog,
    probeStore,
    probeService,
    savedCatalogs,
    fallback,
    catalogSource: 'fallback',
    catalogFetchedAtMs: undefined,
    catalogError: undefined,
    lastFetchAtMs: 0,
    catalogGeneration: 0,
    inflightFetch: undefined,
    invalidate: () => {},
    registered: false,
    jobTokenRefreshedAt: () => jobTokenRefreshedAt,
    queueBudgetMs: configuredQueueWaitMs,
    diag: writeQueueDiag,
    checkIn: (signal?: AbortSignal) => transport.checkIn(signal),
  }
}

/** The catalog provenance the card displays. */
function catalogSection(runtime: VariantRuntime): QoderWebCatalog {
  return {
    // What the models on screen actually came from: "stale" and "offline" are
    // different problems for the user.
    source: runtime.catalogSource,
    // The served catalog's own fetch time, not when the process started.
    ...runtime.catalogFetchedAtMs === undefined ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
    ...runtime.catalogError === undefined ? {} : { error: runtime.catalogError },
  }
}

/**
 * Whether a model can be probed by hand: it reasons and the upstream declares no
 * effort set for it. Deliberately not filtered by whether a result already
 * exists, so the list stays stable as use grows.
 */
function isProbeCandidate(info: QoderModelInfo): boolean {
  if (info.reasoning?.supports !== true) return false
  return (info.reasoning.supportedEfforts?.length ?? 0) === 0
}

/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime: VariantRuntime, consent: boolean): QoderWebProbeSection {
  const models = runtime.catalog.current()
  // Read results through the same judgement the adapter uses, not straight from
  // the store: a raw record can be stale in ways the adapter already discounts.
  const results = models.flatMap(info => {
    const record = runtime.probeService.recordFor(info.id)
    if (record === undefined) return []
    return [{
      id: info.id,
      name: info.name,
      validation: record.validation,
      efforts: record.efforts,
      probedAt: record.probedAtMs,
    }]
  })
  return {
    consent,
    running: runtime.probeService.isRunning(),
    candidates: models.filter(isProbeCandidate).map(info => info.id),
    // Newest first: a detection just run belongs at the top.
    results: newestFirst(results),
  }
}

/** How many days a rotated queue log is kept. */
const QUEUE_LOG_KEEP_DAYS = 7
/** Timestamp format of a rotated queue log: `queue.20261021020410.log`. */
const QUEUE_LOG_ROTATED = /^queue\.\d{14}\.log$/u

/**
 * Archive the previous run's queue log and prune old archives.
 *
 * Runs once per process, not per plugin reload: the two variants share the file,
 * and rolling on every reload would shred one run into several archives.
 */
function rotateQueueLog(logPath: string): void {
  const marker = globalThis as { __qoderQueueLogRolled?: boolean }
  if (marker.__qoderQueueLogRolled === true) return
  marker.__qoderQueueLogRolled = true
  try {
    const dir = dirname(logPath)
    mkdirSync(dir, { recursive: true })
    if (existsSync(logPath) && statSync(logPath).size > 0) {
      const now = new Date()
      const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join('')
      copyFileSync(logPath, join(dir, `queue.${stamp}.log`))
      writeFileSync(logPath, '')
    }
    const cutoff = Date.now() - QUEUE_LOG_KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const name of readdirSync(dir)) {
      if (!QUEUE_LOG_ROTATED.test(name)) continue
      const path = join(dir, name)
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
    }
  } catch {
    // Diagnostics only; never affect startup.
  }
}

/**
 * Run a detached promise without letting its failure kill the host: Node turns an
 * unhandled rejection into process termination, so every fire-and-forget call
 * carries a handler and a failure stays a diagnostic.
 */
function detach(ctx: Context, work: Promise<unknown>, what: string): void {
  void work.catch((error: unknown) => {
    ctx.logger.warn(`dsh-qoder-connect: ${what} failed`, error)
  })
}

/**
 * Start one variant: its loopback endpoint, provider registration, and card
 * wiring. Registration waits for the shim to hold a port, because the models read
 * the shim origin at construction time; a failure stays contained to this variant.
 *
 * @param seedCatalog - adopt the current credential immediately (supplied by `apply`).
 * @returns whether the provider registered.
 */
async function startVariant(ctx: Context, runtime: VariantRuntime, seedCatalog: () => Promise<void>): Promise<boolean> {
  const { variant, store, client, catalog, probeService } = runtime
  const shim = createQoderShim({
    store,
    client,
    catalog,
    providerId: variant.id,
    logger: ctx.logger,
    // Same hand-back log as the queue decisions: the loopback hop's lifecycle is
    // what tells a client-side clock apart from an upstream stall.
    onDiag: runtime.diag,
  })
  try {
    await shim.ready
  } catch (error: unknown) {
    ctx.logger.error(`dsh-qoder-connect: ${variant.displayName} loopback endpoint failed to start`, error)
    return false
  }

  try {
    const qoder = createQoderAdapter({
      providerId: variant.id,
      displayName: variant.displayName,
      shim,
      store,
      catalog,
      resolveAttachments: () => ctx.get('attachments'),
      observe: modelId => probeService.recordFor(modelId),
      queueBudgetMs: runtime.queueBudgetMs,
    })
    runtime.invalidate = () => {
      qoder.invalidate()
      ctx.emit('llm/adapters-updated')
    }

    let releaseAdapter: (() => void) | undefined
    let releaseDirectory: (() => void) | undefined
    try {
      releaseAdapter = ctx.llm.registerAdapter([variant.id], qoder.adapter)
      // The row must name the settings form THIS host serves: the host keys one form
      // per profile entry (`entry.options.id`), so a missing id falls back to
      // `variant.id` rather than to the unserved package name.
      const entryId = (ctx as unknown as { fiber?: { entry?: { options?: { id?: string } } } }).fiber?.entry?.options?.id
      const settingsNs = (entryId ?? variant.id) as SettingsNamespace
      releaseDirectory = ctx.llm.registerConfigurableProviders([{
        provider: variant.id,
        displayName: variant.displayName,
        // Each variant's entry joins its own form; the Models page resolves
        // `settingsNs` against the forms THIS host serves.
        settingsNs,
        settingsPath: [],
        declared: false,
      }])
    } finally {
      if (releaseAdapter === undefined || releaseDirectory === undefined) {
        // Registration threw; release whichever half landed.
        releaseAdapter?.()
        releaseDirectory?.()
      }
    }
    try {
      ctx.effect(() => () => {
        releaseAdapter?.()
        releaseDirectory?.()
        detach(ctx, shim.close(), 'loopback endpoint close')
      })
    } catch {
      // Disposed during registration: release immediately — the plugin-level
      // disposer already closed every shim.
      releaseAdapter?.()
      releaseDirectory?.()
      detach(ctx, shim.close(), 'loopback endpoint close')
    }
    runtime.registered = true
    // Seed the catalog BEFORE returning, not in the later sweep: a settings write
    // hot-reloads this fiber, the fresh catalog starts hidden, and the card's
    // post-write refresh would otherwise land on an empty model list.
    detach(ctx, seedCatalog(), `${variant.id} catalog seed`)
    return true
  } catch (error: unknown) {
    ctx.logger.error(`dsh-qoder-connect: ${variant.displayName} provider registration failed`, error)
    detach(ctx, shim.close(), 'loopback endpoint close')
    return false
  }
}

/**
 * State that MUST survive a fiber reload: the in-process control keys, minted once
 * per process. A settings write re-runs `apply()` with a fresh closure, so a
 * per-apply key would 403 every card and a per-apply identity map would re-fetch
 * the catalog on every write.
 */
let processKeys: { probe: string; auth: string } | undefined
function controlKeys(): { probe: string; auth: string } {
  processKeys ??= { probe: createProbeKey(), auth: createAuthKey() }
  return processKeys
}

/** The loopback guard the probe and status routes use, restated for settings. */
function trustedSettingsRequest(req: { method?: string | undefined; headers: Record<string, string | string[] | undefined> }): boolean {
  const host = req.headers.host ?? ''
  const origin = req.headers.origin
  if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(host))) return false
  return origin === undefined || /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))
}

/**
 * The schema defaults, read off each field's own `meta.default` — the value
 * schemastery itself substituted during validation. A hand-written table drifts,
 * and `validate({})` answers hollow per-field values instead of the defaults.
 */
const DEFAULT_FOR_FIELD: Partial<Record<keyof Config, unknown>> = (() => {
  const out: Partial<Record<keyof Config, unknown>> = {}
  try {
    for (const [key, field] of Object.entries(Config.dict ?? {})) {
      const fallback = (field as { meta?: { default?: unknown } } | undefined)?.meta?.default
      if (fallback !== undefined) (out as Record<string, unknown>)[key] = fallback
    }
  } catch {
    // An unreadable schema leaves the map partial, which keeps the entry
    // authoritative rather than guessing.
  }
  if (Object.keys(out).length === 0) {
    // A schema that cannot be walked keeps the literal table below.
    return {
      probeConsent: false,
      useMaximumContextWindow: true,
      useMaximumContextWindowCN: true,
      modelContextWindows: {},
      modelContextWindowsCN: {},
      disabledModels: [],
      disabledModelsCN: [],
      sidebarQuotaCN: false,
      sidebarQuotaGlobal: false,
      autoCheckInCN: false,
      autoCheckInGlobal: false,
      checkInMinuteCN: 600,
      checkInMinuteGlobal: 600,
      quotaPollMs: 300_000,
      queueWait: true,
      queueWaitSeconds: QUEUE_WAIT_SECONDS_DEFAULT,
    }
  }
  return out
})()

/** One settings-face write: type-checked, then persisted and applied. */
interface QoderSettingsWriteTarget {
  store: SettingsStore
  config: Config
  current: () => Config
  apply: (next: Config) => void
  rearm: () => void
}

/**
 * Register the settings face (GET/POST) the browser cards read and write through:
 * `value` (the merged view the host reads), `user` (the settings file as stored,
 * where presence marks an override), and `base`. A POST validates, writes,
 * applies in memory, and re-arms the check-in scheduler.
 */
function registerQoderSettingsFace(
  ctx: Context,
  deps: QoderSettingsWriteTarget,
): void {
  const { store, config, current, apply, rearm } = deps
  const key = controlKeys().probe
  /** The document both routes answer with. */
  const view = () => {
    const merged = current()
    const value: Record<string, unknown> = {}
    const base: Record<string, unknown> = {}
    for (const field of CONFIG_KEYS) {
      if (merged[field] !== undefined) value[field] = merged[field]
      base[field] = readConfig(config)[field] ?? DEFAULT_FOR_FIELD[field]
    }
    return { key, value, base, user: store.values() }
  }
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: QODER_SETTINGS_FACE_PATH,
      handler: async (req, res) => {
        if (!trustedSettingsRequest(req)) { jsonFace(res, 403, { error: 'request-not-trusted' }); return }
        if (req.method === 'GET') { jsonFace(res, 200, view()); return }
        if (req.method !== 'POST') { jsonFace(res, 405, { error: 'method not allowed' }); return }
        if (req.headers['x-qoder-settings-key'] !== key) { jsonFace(res, 403, { error: 'invalid-key' }); return }
        const body = await readFaceBody(req)
        if (body === undefined) { jsonFace(res, 413, { error: 'body too large' }); return }
        let patch: unknown
        try { patch = JSON.parse(body || '{}') } catch { jsonFace(res, 400, { error: 'invalid json' }); return }
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          jsonFace(res, 400, { error: 'invalid patch' }); return
        }
        const invalid = validateSettingsPatch(patch as Record<string, unknown>)
        if (invalid !== undefined) { jsonFace(res, 400, { error: invalid }); return }
        // A card write: the file holds live user edits from here on.
        store.patch(patch as Record<string, unknown>, true)
        apply(current())
        rearm()
        jsonFace(res, 200, view())
      },
    })
    return () => { dispose() }
  }, 'dsh-qoder-connect: settings face')
}

/** JSON response helper for the settings face. */
function jsonFace(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

/** Read the request body, or undefined when absent or oversized. */
function readFaceBody(req: {
  on: (event: string, handler: (chunk?: unknown) => void) => void
  destroy?: () => void
}): Promise<string | undefined> {
  return new Promise(resolve => {
    let settled = false
    let body = ''
    req.on('data', (chunk: unknown) => {
      if (settled) return
      body += String(chunk)
      if (body.length > 1e6) {
        settled = true
        body = ''
        req.destroy?.()
        resolve(undefined)
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(body)
    })
    req.on('error', () => {
      if (settled) return
      settled = true
      resolve(undefined)
    })
  })
}

/** Schema-level validation of one settings patch; the reason, or undefined. */
function validateSettingsPatch(patch: Record<string, unknown>): string | undefined {
  for (const [field, value] of Object.entries(patch)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(field)) return `unknown field ${field}`
    if (value === null) continue
    switch (field) {
      case 'probeConsent':
      case 'useMaximumContextWindow':
      case 'useMaximumContextWindowCN':
      case 'sidebarQuotaCN':
      case 'sidebarQuotaGlobal':
      case 'autoCheckInCN':
      case 'autoCheckInGlobal':
      case 'queueWait':
        if (typeof value !== 'boolean') return `${field} must be a boolean`
        break
      case 'queueWaitSeconds':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < QUEUE_WAIT_SECONDS_MIN) {
          return `${field} must be an integer of at least ${QUEUE_WAIT_SECONDS_MIN} second`
        }
        break
      case 'disabledModels':
      case 'disabledModelsCN':
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return `${field} must be an array of strings`
        break
      case 'checkInMinuteCN':
      case 'checkInMinuteGlobal':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1439) return `${field} must be an integer minute 0..1439`
        break
      case 'quotaPollMs':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 60_000) return `${field} must be an integer of at least 60000 ms`
        break
      case 'modelContextWindows':
      case 'modelContextWindowsCN':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${field} must be an object`
        break
    }
  }
  return undefined
}

/**
 * Delete this plugin's own fields from the profile entry config, leaving every
 * other key untouched — one-time, right after the settings file is seeded, so no
 * second source of truth remains. The write rides `configEditor`, probed on the
 * plugin context first and on the settings service's owner context second.
 *
 * @param ownKeys - this plugin's declared config fields.
 */
async function cleanupEntryConfig(ctx: Parameters<typeof apply>[0], ownKeys: readonly string[]): Promise<void> {
  // Retries, deliberately: `configEditor.edit` writes under the profile's lock and
  // sibling plugins migrating on the same boot contend for that ONE lock. The
  // write is idempotent, so backing off with jitter makes the rest land.
  const attempts = 10
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 2_000 + Math.random() * 1_000))
      const probe = ctx as unknown as {
        get?: (name: string) => unknown
        fiber?: { entry?: unknown }
      }
      // configEditor 双路探测：先取本 ctx，再在 settings 服务的 ownerContext 取一次
      const own: unknown = typeof probe.get === 'function'
        ? (() => { try { return probe.get.call(ctx, 'configEditor') } catch { return undefined } })()
        : undefined
      const editor = (own ?? await new Promise<unknown>(resolve => {
        ctx.inject(['settings'], settingsCtx => {
          // `ownerContext` is private, so it is reached through a double cast.
          const owner = (settingsCtx.settings as unknown as { ownerContext?: { get?: (name: string) => unknown } } | undefined)?.ownerContext
          const viaOwner = typeof owner?.get === 'function'
            ? (() => { try { return owner.get.call(owner, 'configEditor') } catch { return undefined } })()
            : undefined
          resolve(viaOwner)
        })
      })) as { edit(entry: unknown, change: (raw: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void> } | undefined
      const entry = probe.fiber?.entry
      if (editor !== undefined && entry !== undefined) {
        // Return INHERITED plus the row's foreign keys, not "the row minus our
        // keys": the editor's composition check is what lets it drop the user
        // layer, and any other plugin's (or the user's own) keys stay.
        await editor.edit(entry, (raw, inherited) => {
          const next: Record<string, unknown> = { ...(inherited ?? {}) }
          for (const [key, value] of Object.entries(raw ?? {})) {
            if ((ownKeys as readonly string[]).includes(key)) continue
            if (!Object.hasOwn(next, key)) next[key] = value
          }
          return next
        })
        return
      }
      // No editor and no entry: nothing to clean; a later apply retries.
      return
    } catch (error: unknown) {
      if (attempt === attempts - 1) {
        ctx.logger?.warn?.('dsh-qoder-connect: entry config cleanup failed', error)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1) + Math.random() * 500))
    }
  }
}

/** The account identity each variant last published a catalog for, across reloads. */
const lastIdentities = new Map<string, string>()

/**
 * When a variant's catalog was last fetched LIVE, per identity. Shared across
 * reloads so the retry rule (`stale && due`) does not re-fetch on every settings
 * write.
 */
const lastLiveFetchAt = new Map<string, number>()

/**
 * Start both variants: loopback endpoints, the `qoder` and `qoder-global`
 * providers, their cards, and their credential-driven catalog lifecycles. Each
 * variant registers unconditionally; an empty catalog is how DSH hides a group,
 * which keeps a token saved after startup working without re-registering.
 */
/** One peer this plugin cannot run without: the spec and its declared range. */
interface PeerExpectation {
  readonly spec: string
  readonly range: string
}

/**
 * Peers whose resolved copy decides whether this build can run.
 *
 * These three are the ones whose shapes this build's request path walks into:
 * the provider seam, the adapter base, and the event stream the harness reads
 * back. The other declared peers (`dsh-attachment`, `dsh-atomic-write`,
 * `dsh-home-paths`, `schemastery`) are also imported, but they ride the host's
 * version line and a mismatch there surfaces as a plain missing export at import
 * time — a case this check cannot reach anyway, because ESM links before
 * `apply()` runs. Listing them here would only produce false alarms for builds
 * this plugin has no opinion about.
 *
 * The RANGES are read from this package's own `package.json`, so a version bump
 * is one edit and the check can never disagree with what the manifest advertises.
 */
const CHECKED_PEERS: readonly string[] = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@earendil-works/pi-ai',
]

/**
 * Read the checked peers' ranges from the manifest beside this build.
 *
 * @returns one expectation per peer that declares a string range; an unreadable
 * manifest yields none, which simply skips the check rather than blocking a load
 * on a fact it cannot establish.
 * @internal Exported for tests.
 */
export function peerExpectations(): readonly PeerExpectation[] {
  let peers: Record<string, unknown>
  try {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { peerDependencies?: Record<string, unknown> }
    peers = manifest.peerDependencies ?? {}
  } catch {
    return []
  }
  return CHECKED_PEERS.flatMap(spec => {
    const range = peers[spec]
    return typeof range === 'string' ? [{ spec, range }] : []
  })
}

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  pre: ReadonlyArray<string | number> | null
}

/** Parse a semver string into comparable parts; non-conforming input is null. */
function parseSemver(version: unknown): ParsedSemver | null {
  if (typeof version !== 'string') return null
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] !== undefined
      ? m[4].split('.').map((id): string | number => (/^\d+$/.test(id) ? Number(id) : id))
      : null,
  }
}

/** Full semver ordering: numeric fields, then pre-release tag rules. */
function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  const len = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < len; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNum = typeof x === 'number'
    const yNum = typeof y === 'number'
    if (xNum && yNum) return x - y
    if (xNum) return -1
    if (yNum) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * Compare a resolved version to a declared bound.
 *
 * For a bound carrying no pre-release (`>=0.2.1`), compare only the three
 * numeric fields: a `0.2.1-rc.x` resolved package counts as at-or-above the
 * `0.2.1` floor — rc builds of this ecosystem carry the same API as the
 * matching base release, so the build tag must not hide it.
 * For a bound with a tag (`>=0.2.1-rc.1`), run the full semver comparison so
 * `-alpha < -beta < -rc.1` orders correctly.
 */
function compareToBound(v: ParsedSemver, bound: ParsedSemver): number {
  if (bound.pre === null) return compareCore(v, bound)
  return compareSemver(v, bound)
}

/** Numeric fields only, ignoring any pre-release tag on either side. */
function compareCore(a: ParsedSemver, b: ParsedSemver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/**
 * Whether this checker can decide a range at all.
 *
 * Form alone is not enough: `~1`, `^1.2` and `>=abc` share the shape of a range
 * this checker claims to enforce, yet its bound does not parse, so the
 * comparison would pass everything without ever saying so. Callers use this to
 * report the limit instead of enforcing nothing quietly.
 *
 * @internal Exported for tests.
 */
export function supportsRange(range: unknown): boolean {
  if (typeof range !== 'string') return false
  const m = range.trim().match(/^(?:>=|\^|~)\s*(\S+)$/)
  return m !== null && parseSemver(m[1]) !== null
}

/**
 * Compare a resolved package version against a semver range. `^x.y.z`, `~x.y.z`
 * and `>=x.y.z` are enforced; every other form returns true, because a
 * declaration this checker cannot express must not block a working install —
 * callers report those forms rather than treating the pass as a verdict.
 *
 * @internal Exported for tests; the load-time check is the only caller.
 */
export function satisfiesRange(version: string, range: string): boolean {
  if (typeof range !== 'string') return true
  const trimmed = range.trim()
  const v = parseSemver(version)
  if (v === null) return true

  let m = trimmed.match(/^>=\s*(\S+)$/)
  if (m) {
    const bound = parseSemver(m[1])
    if (bound === null) return true
    return compareToBound(v, bound) >= 0
  }

  // ~x.y.z allows patch upgrades only: >=x.y.z <x.(y+1).0.
  m = trimmed.match(/^~\s*(\S+)$/)
  if (m) {
    const bound = parseSemver(m[1])
    if (bound === null) return true
    if (compareToBound(v, bound) < 0) return false
    const upper: ParsedSemver = { major: bound.major, minor: bound.minor + 1, patch: 0, pre: null }
    return compareCore(v, upper) < 0
  }

  m = trimmed.match(/^\^\s*(\S+)$/)
  if (m) {
    const bound = parseSemver(m[1])
    if (bound === null) return true
    if (compareToBound(v, bound) < 0) return false
    // ^x.y.z: first non-zero component locks the bound above it.
    // ^1.2.3 → <2.0.0; ^0.2.1 → <0.3.0; ^0.0.5 → <0.0.6; ^0.0.0 → <0.0.1.
    let upper: ParsedSemver
    if (bound.major > 0) {
      upper = { major: bound.major + 1, minor: 0, patch: 0, pre: null }
    } else if (bound.minor > 0) {
      upper = { major: 0, minor: bound.minor + 1, patch: 0, pre: null }
    } else {
      upper = { major: 0, minor: bound.minor, patch: bound.patch + 1, pre: null }
    }
    // Compare cores only: `2.0.0-rc.1` sits below `2.0.0` in semver order, so a
    // full comparison would let the next major's preview through a caret that
    // must stop at 2.0.0.
    return compareCore(v, upper) < 0
  }

  return true
}

/**
 * The resolved peer's version, read through the resolver this module's own
 * imports use.
 *
 * The resolver's parent is this module, which is exactly the parent its static
 * imports carry — so the entry found here is the copy Node loads, whatever the
 * install shape (a plain `node_modules`, a pnpm store, an `app.asar` the
 * Electron fs patch opens). Reading the filesystem instead would answer a
 * different question: which copy happens to sit on disk.
 *
 * @param spec - the peer specifier as declared in `peerDependencies`.
 * @param resolveEntry - injectable resolver for tests.
 * @returns the version, or undefined when the copy cannot be named — that
 *   absence is no verdict, only missing evidence.
 */
function readResolvedVersion(
  spec: string,
  resolveEntry: (specifier: string) => string = specifier => import.meta.resolve(specifier),
): string | undefined {
  let entry: string
  try {
    entry = fileURLToPath(resolveEntry(spec))
  } catch {
    return undefined
  }
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const pj = join(dir, 'package.json')
    if (existsSync(pj)) {
      try {
        const parsed = JSON.parse(readFileSync(pj, 'utf8')) as { name?: unknown; version?: unknown }
        // Only a manifest carrying the requested name is this package's own. Any
        // other directory in between (a nested `type: module` stub, a staged
        // sub-package) is passed through instead of ending the walk early.
        if (parsed.name === spec) {
          return typeof parsed.version === 'string' ? parsed.version : undefined
        }
      } catch {
        // An unreadable manifest proves nothing about this package: keep walking.
      }
    }
    if (basename(dir) === 'node_modules' || dir === dirname(dir)) return undefined
  }
}

/** What the load-time peer check concluded. */
export interface PeerCheckOutcome {
  /** A peer the host loads below its declared floor; the load must be refused. */
  failure?: string
  /** Peers whose copy could not be named, so they went unenforced. */
  unverified: readonly string[]
}

/**
 * Report the first peer the host loads below its declared floor.
 *
 * Only a proven mismatch refuses the load. A peer whose copy cannot be resolved
 * or read is reported as unverified instead: the static imports already linked,
 * so the host supplied a working copy and failing here would refuse every clean
 * install. Unverified peers still have to reach the card, or a check that quietly
 * stopped enforcing would look like one that passed.
 *
 * @param expectations - peers to check, in report order.
 * @param warn - sink for a range it cannot interpret.
 * @param resolveEntry - injectable resolver for tests.
 * @internal Exported for tests.
 */
export function peerVersionFailure(
  expectations: readonly PeerExpectation[] = peerExpectations(),
  warn?: (message: string) => void,
  resolveEntry?: (specifier: string) => string,
): PeerCheckOutcome {
  const unverified: string[] = []
  for (const { spec, range } of expectations) {
    const version = readResolvedVersion(spec, resolveEntry)
    if (version === undefined) {
      unverified.push(spec)
      continue
    }
    if (!supportsRange(range)) {
      warn?.(`dsh-qoder-connect: cannot interpret the range "${range}" declared for ${spec}; `
        + `that peer is not enforced`)
      continue
    }
    if (!satisfiesRange(version, range)) {
      return {
        failure: `${spec}@${range} is required, but the copy this host loads resolves to ${version}; `
          + `rebuild the profile dependency tree or update that package`,
        unverified,
      }
    }
  }
  return { unverified }
}

export function apply(ctx: Context, config: Config): void {
  // A refused load still has to explain itself, and the browser half is loaded
  // from the manifest regardless of whether this half started. Registering one
  // status route that carries the refusal lets the card show the real message
  // and stop offering controls whose machinery never exists; throwing instead
  // would leave that card rendering actions that can only answer 404.
  // Before anything reads a path: every store built below freezes what it gets.
  // `ctx.get` rather than `inject` — a profile context is absent in compositions
  // booted without a profile, and this plugin still has to load there.
  const profileContext = ctx.get('profileContext') as { dir?: string } | undefined
  configurePluginPaths({
    profileDir: profileContext?.dir,
    diagnostics: ctx.logger,
  })
  const peerCheck = peerVersionFailure(
    peerExpectations(),
    message => { ctx.logger.warn(message) },
  )
  if (peerCheck.failure !== undefined) {
    const message = `dsh-qoder-connect: ${peerCheck.failure}`
    ctx.logger.warn(message)
    ctx.inject(['webServer'], webCtx => {
      for (const variant of QODER_VARIANTS) registerInactiveStatusRoute(webCtx, variant.statusPath, message)
    })
    return
  }
  // Unverified peers are a blind spot, not a pass: say so on the card.
  const peerCheckSkipped = peerCheck.unverified.length === 0
    ? undefined
    : `could not determine the version of ${peerCheck.unverified.join(', ')}`
  if (peerCheckSkipped !== undefined) ctx.logger.warn(`dsh-qoder-connect: ${peerCheckSkipped}`)

  // Live configuration source: the composition entry (read through the volatile
  // indirection) with the plugin-owned settings file layered on top. The entry
  // stays as the fallback layer so a hand-edited profile row still seeds a fresh
  // install; every write lands in the file (a profile patch would cost a full tree
  // reconcile and a fiber reload per switch).
  const store = new SettingsStore()
  let current = (): Config => ({ ...readConfig(config), ...store.values() }) as Config

  /**
   * One-time seed, per field: the file never held it — take the entry; the entry
   * carries a NON-DEFAULT value — take the entry; otherwise keep the file. The
   * default-skipping clause is load-bearing — once cleanup has emptied the entry
   * row, treating its pure defaults as authoritative would erase the user's
   * values. Re-checked on every apply, which also closes the volatile commit
   * timing window; when the entry wins, its own fields are deleted from the row.
   */
  const migrateOwnSettings = (): void => {
    const seeded: Record<string, unknown> = {}
    for (const key of CONFIG_KEYS) {
      const entryValue = readField(config, key)
      const holds = Object.hasOwn(store.user, key)
      if (!holds) {
        // First seed: prefer the first NON-DEFAULT candidate — a schema default
        // (an empty array, a toggle's `true`) is not a value to seed on.
        if (entryValue !== undefined && JSON.stringify(entryValue) !== JSON.stringify(DEFAULT_FOR_FIELD[key])) seeded[key] = entryValue
        else if (entryValue !== undefined) seeded[key] = entryValue
        continue
      }
      if (store.edited) continue
      if (entryValue !== undefined && JSON.stringify(entryValue) !== JSON.stringify(DEFAULT_FOR_FIELD[key])) {
        seeded[key] = entryValue
      }
    }
    if (Object.keys(seeded).length === 0) return
    store.patch(seeded)
    void cleanupEntryConfig(ctx, CONFIG_KEYS)
  }
  migrateOwnSettings()

  // A volatile-only configuration change — every field of this Config is
  // `.volatile()` — commits through the loader's volatile fast path and does NOT
  // re-run `apply()`. This event fires on exactly that commit, so the seed rule
  // re-evaluates. The event is a Host-internal channel the typings do not
  // declare, hence the string-keyed escape hatch.
  const eventSink = ctx as unknown as { on: (event: string, listener: () => void) => void }
  eventSink.on('loader/volatile-update', () => { migrateOwnSettings() })

  /** Timers and in-flight work belonging to this plugin instance. */
  let stopped = false
  const timers: NodeJS.Timeout[] = []

  const runtimes = QODER_VARIANTS.map(variant => createVariantRuntime(
    ctx,
    config,
    variant,
    () => current(),
    id => lastIdentities.get(id),
  ))

  const checkInStore = new JsonFileCheckInStore()
  const checkInScheduler = new CheckInScheduler({
    targets: runtimes.map(runtime => ({
      variantId: runtime.variant.id,
      checkIn: (signal?: AbortSignal) => runtime.checkIn(signal),
      minuteOfDay: () => {
        const cfg = current()
        const stored = runtime.variant.id === CHINA_VARIANT.id
          ? cfg.checkInMinuteCN
          : cfg.checkInMinuteGlobal
        // A missing or out-of-range stored value must never leave a variant
        // unscheduled: fall back to the documented default.
        return normalizeCheckInMinute(stored ?? DEFAULT_CHECK_IN_MINUTE)
      },
      onClaimed: () => {
        void runtime.client.fetchCredits().catch(() => undefined)
      },
    })),
    isEnabled: variantId => {
      const cfg = current()
      if (variantId === CHINA_VARIANT.id) return cfg.autoCheckInCN === true
      return cfg.autoCheckInGlobal === true
    },
    store: checkInStore,
  })
  checkInScheduler.start()
  /**
   * The startup catch-up, re-run once from the settings source callback:
   * `start()` above runs while the plugin is still assembling, before the section
   * holding these toggles hands over its values, so that sweep skips the day.
   */
  let startupCatchUpDone = false
  const runStartupCatchUpOnce = (): void => {
    if (startupCatchUpDone) return
    startupCatchUpDone = true
    checkInScheduler.catchUp()
  }

  // Same-origin routes backing each card; the webServer service is optional.
  // Keys are per-process (see {@link controlKeys}), since a settings write
  // reloads this fiber.
  const { probe: probeKey, auth: authKey } = controlKeys()
  let setMaximumContextWindow: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  let setMaximumContextWindowCN: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  let setModelsEnabled: ((options: { models: readonly string[]; enabled: boolean }) => Promise<{ state: string; reason?: string }>) | undefined
  let setModelsEnabledCN: ((options: { models: readonly string[]; enabled: boolean }) => Promise<{ state: string; reason?: string }>) | undefined
  /**
   * Point a variant at an account identity, invalidating whatever the previous
   * one left behind. One helper for every transition (sweep, manual refresh, card
   * save), so none can forget a step; each bumps
   * {@link VariantRuntime.catalogGeneration}, which makes an in-flight request from
   * before the change refuse to write back. Probe observations are dropped
   * whenever the account actually changes, but never on a first sign-in.
   *
   * @param identity - the account now in effect, or `undefined` when signed out.
   */
  const adoptIdentity = (runtime: VariantRuntime, identity: string | undefined): void => {
    const id = runtime.variant.id
    const known = lastIdentities.get(id)
    // "Same identity" may only short-circuit when THIS runtime has already
    // adopted: a fresh catalog starts hidden, and every settings write
    // hot-reloads into exactly such a runtime — skipping the seeding and
    // `setVisible(true)` would leave the card's model list empty for good.
    if (known === identity && runtime.catalog.isVisible()) return
    const hadCredential = known !== undefined
    if (identity === undefined) lastIdentities.delete(id)
    else lastIdentities.set(id, identity)
    // Any change of identity invalidates in-flight work and the rendered catalog.
    // Probe records stay: they are keyed by account and filtered on read.
    runtime.catalogGeneration += 1
    runtime.inflightFetch?.controller.abort()
    runtime.inflightFetch = undefined
    if (hadCredential && known !== identity) {
      runtime.invalidate()
    }
    if (identity === undefined) {
      // Signed out: hide the group and drop the models, and forget this account's
      // saved catalog — it is that account's data, keyed by identity.
      if (known !== undefined) runtime.savedCatalogs.delete(known)
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
      runtime.catalogError = undefined
      if (runtime.catalog.setVisible(false)) runtime.invalidate()
      return
    }
    // Serve this account's best-known catalog until a fetch lands: the saved one is
    // what this account was actually served, the roster only a one-off snapshot.
    // Covers a switch and a restart alike.
    const saved = runtime.savedCatalogs.get(identity)
    if (saved !== undefined) {
      runtime.catalog.set([...saved.models])
      runtime.catalogSource = 'saved'
      runtime.catalogFetchedAtMs = saved.fetchedAtMs
    } else {
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
    }
    runtime.catalogError = undefined
    runtime.catalog.setVisible(true)
    runtime.invalidate()
  }

  /**
   * Apply catalog preferences from a configuration view, in memory. Shared by the
   * probe-route setters and the settings face's POST.
   */
  const applyCatalogSettings = (next: Config): void => {
    let changed = false
    for (const runtime of runtimes) {
      const isChina = runtime.variant.id === CHINA_VARIANT.id
      const preference = isChina ? next.useMaximumContextWindowCN : next.useMaximumContextWindow
      if (runtime.catalog.setUseMaximumContextWindow(preference === true)) changed = true
      const overrides = isChina ? next.modelContextWindowsCN : next.modelContextWindows
      if (overrides !== undefined && runtime.catalog.setModelContextWindows(overrides)) changed = true
      const disabled = isChina ? next.disabledModelsCN : next.disabledModels
      if (runtime.catalog.setDisabledModels(disabled ?? [])) changed = true
    }
    if (changed) {
      for (const runtime of runtimes) runtime.invalidate()
    }
  }

  ctx.inject(['webServer'], webCtx => {
    for (const runtime of runtimes) {
      registerQoderStatusRoute(webCtx, {
        path: runtime.variant.statusPath,
        store: runtime.store,
        client: runtime.client,
        models: () => runtime.catalog.all(),
        catalog: () => catalogSection(runtime),
        probe: () => probeSection(runtime, current().probeConsent === true),
        probeKey,
        authKey,
        ...(runtime.variant.id === CHINA_VARIANT.id
          ? {
            useMaximumContextWindow: () => current().useMaximumContextWindowCN === true,
            disabledModels: () => current().disabledModelsCN ?? [],
          }
          : {
            useMaximumContextWindow: () => current().useMaximumContextWindow === true,
            disabledModels: () => current().disabledModels ?? [],
          }),
        jobTokenRefreshedAt: runtime.jobTokenRefreshedAt,
        ...peerCheckSkipped === undefined ? {} : { peerCheckSkipped: () => peerCheckSkipped },
        checkIn: () => {
          const record = checkInStore.read(runtime.variant.id)
          if (record === undefined) return undefined
          const nextRunAt = checkInScheduler.nextRunAt(runtime.variant.id)
          return {
            ...record,
            // Rides the record so the card can show the pending moment; a day
            // already claimed stays silent by design.
            ...nextRunAt === undefined ? {} : { nextRunAt },
          }
        },
      })
      registerQoderAuthRoute(webCtx, {
        path: runtime.variant.authPath,
        save: async (pat, label) => {
          // Validate against this variant's region before anything is written: the
          // file never holds a credential the plugin has not seen work.
          if (!await validateApiKey(pat, runtime.variant.region)) {
            return { ok: false, error: 'qoder_invalid_pat' as const }
          }
          const entry = await runtime.store.add(pat, label)
          // Adopt at once so the model group appears without waiting for the sweep.
          const identity = credentialIdentity(entry)
          adoptIdentity(runtime, identity)
          // AWAIT the fetch: the card re-reads status the moment this answer lands.
          // `fetchCatalog` contains its own failures, so a bad upstream cannot fail
          // a valid save.
          await fetchCatalog(runtime, identity)
          return { ok: true, status: await runtime.store.status() }
        },
        activate: async id => {
          const entry = await runtime.store.activate(id)
          if (entry === undefined) return { ok: false, error: 'qoder_unknown_pat' as const }
          const identity = credentialIdentity(entry)
          // Seed from this account's saved catalog at once, then refresh in the
          // background; `fetchCatalog` is identity-scoped, so a slow answer cannot
          // overwrite a later switch's state.
          adoptIdentity(runtime, identity)
          detach(ctx, fetchCatalog(runtime, identity), `${runtime.variant.id} catalog refresh after switch`)
          return { ok: true, status: await runtime.store.status() }
        },
        remove: async id => {
          const removed = await runtime.store.remove(id)
          if (removed === undefined) return { ok: false, error: 'qoder_unknown_pat' as const }
          // The departing account's detected levels and saved roster are its data:
          // drop them, leave every other account alone.
          const finished = credentialIdentity(removed)
          runtime.probeStore.clearFor(finished)
          runtime.savedCatalogs.delete(finished)
          // `remove` already moved the active pointer; adopt whatever is in effect
          // now (or hide the group when the list is empty).
          const active = await runtime.store.current().catch(() => undefined)
          const identity = active === undefined ? undefined : credentialIdentity(active)
          adoptIdentity(runtime, identity)
          if (identity !== undefined) {
            detach(ctx, fetchCatalog(runtime, identity), `${runtime.variant.id} catalog refresh after removal`)
          }
          return { ok: true, status: await runtime.store.status() }
        },
        clear: async () => {
          // Drop every saved account's scoped data before the file goes: otherwise
          // the catalogs and probe records would be orphaned.
          const saved = await runtime.store.entries().catch(() => [])
          for (const entry of saved) {
            const identity = credentialIdentity(entry)
            runtime.probeStore.clearFor(identity)
            runtime.savedCatalogs.delete(identity)
          }
          await runtime.store.clear()
          adoptIdentity(runtime, undefined)
        },
      }, authKey)
      registerQoderProbeRoute(webCtx, {
        path: runtime.variant.probePath,
        probe: async modelId => {
          // The authenticated manual endpoint is called only after per-model confirmation.
          const result = await runtime.probeService.probe(modelId, true)
          if (result.state === 'ok') runtime.invalidate()
          return result
        },
        clear: () => { runtime.probeStore.clear(); runtime.invalidate() },
        refresh: async () => {
          if (stopped) return { state: 'failed', reason: 'plugin is stopping' }
          // Re-read the credential first: a token saved since the last sweep is the
          // common cause. Re-registering is unnecessary — the sweep owns visibility.
          let credential
          try {
            credential = await runtime.store.current()
          } catch (error: unknown) {
            // A refused credential (wrong region, unreadable file) is a report, not
            // a crash out of the route.
            return {
              state: 'failed',
              reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
            }
          }
          if (credential === undefined) {
            adoptIdentity(runtime, undefined)
            return { state: 'signed-out' }
          }
          const identity = credentialIdentity(credential)
          // Same transition the sweep performs: drop the previous account's data
          // now, not when the fetch lands, or a failed fetch leaves its models pickable.
          adoptIdentity(runtime, identity)
          await fetchCatalog(runtime, identity)
          return runtime.catalogError === undefined
            ? { state: 'refreshed', reason: `${runtime.catalog.current().length} models` }
            : { state: 'failed', reason: runtime.catalogError }
        },
        clearCheckInLogs: () => {
          checkInStore.clearLogs(runtime.variant.id)
        },
        checkIn: async () => {
          const result = await runtime.checkIn()
          if (result.status !== 'error') {
            checkInStore.write(runtime.variant.id, {
              lastDate: result.date,
              lastAt: result.timestamp,
              status: result.status,
              ...result.amount === undefined ? {} : { amount: result.amount },
              ...result.message === undefined ? {} : { message: result.message },
            })
            if (result.status === 'claimed') {
              void runtime.client.fetchCredits().catch(() => undefined)
            }
          }
          return {
            state: result.status,
            ...result.amount === undefined ? {} : { amount: result.amount },
            ...result.message === undefined ? {} : { reason: result.message },
          }
        },
        ...runtime.variant.id === CHINA_VARIANT.id
          ? {
              setMaximumContextWindow: async enabled => {
                if (setMaximumContextWindowCN === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setMaximumContextWindowCN(enabled)
              },
              setModelsEnabled: async opts => {
                if (setModelsEnabledCN === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setModelsEnabledCN(opts)
              },
            }
          : {
              setMaximumContextWindow: async enabled => {
                if (setMaximumContextWindow === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setMaximumContextWindow(enabled)
              },
              setModelsEnabled: async opts => {
                if (setModelsEnabled === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setModelsEnabled(opts)
              },
            },
      }, probeKey)
    }

    // The settings face the browser cards read and write through: three layers —
    // value = effective, base = schema defaults, user = the settings file. The key
    // rides the GET; the POST authorizes with it. Both guards are loopback-checked.
    registerQoderSettingsFace(webCtx, {
      store, config, current,
      apply: applyCatalogSettings,
      rearm: () => { runStartupCatchUpOnce(); checkInScheduler.rearm() },
    })
  })

  // Each settings section is what makes its namespace "served", which is how the
  // Plugins tab (card dispatch) and the Models page (provider directory) find this
  // plugin. One section per card, because a card renders by `entryKey = ns`.
  //
  // 两条宿主线共用一个写入口：写落插件自有 JSON 文件（见 settings-store.ts），
  // 随后原地 apply（catalog 偏好、签到定时器重排、invalidate），行为一致；
  // `configure({auto:false})` 只关掉宿主自动生成的表单页，与持久化无关。
  ctx.inject(['settings'], settingsCtx => {
    /**
     * `auto: false` turns OFF the host's generated form page for this entry (the
     * plugin ships its own card). It must be called as a METHOD: `configure` reads
     * `this`, so extracting it as a free function throws.
     */
    const settingsService = settingsCtx.settings as unknown as {
      configure?: (presentation: { auto: boolean }, owner?: unknown) => unknown
    }
    if (typeof settingsService.configure === 'function') {
      try {
        settingsCtx.effect((): (() => void) => {
          const dispose = settingsService.configure!({ auto: false }, ctx.fiber)
          return typeof dispose === 'function' ? (dispose as () => void) : () => {}
        })
      } catch (error: unknown) {
        console.error('[dsh-qoder-connect] settings.configure failed (own settings file still serves):', error)
      }
    }

    /**
     * One implementation on both hosts: write the plugin-owned settings file, then
     * apply the new view in memory — no profile patch, no fiber reload.
     */
    const write = (patch: Record<string, unknown>): void => {
      // A card-originated write, so the file becomes authoritative from here on.
      store.patch(patch, true)
      applyCatalogSettings(current())
      checkInScheduler.rearm()
    }
    setMaximumContextWindow = async enabled => {
      write({ useMaximumContextWindow: enabled })
      return { state: 'updated' }
    }
    setMaximumContextWindowCN = async enabled => {
      write({ useMaximumContextWindowCN: enabled })
      return { state: 'updated' }
    }
    setModelsEnabled = async ({ models, enabled }) => {
      const currentDisabled = new Set((readConfigField(current(), 'disabledModels') as readonly string[] | undefined) ?? [])
      for (const m of models) {
        if (enabled) currentDisabled.delete(m)
        else currentDisabled.add(m)
      }
      write({ disabledModels: Array.from(currentDisabled) })
      return { state: 'updated' }
    }
    setModelsEnabledCN = async ({ models, enabled }) => {
      const currentDisabled = new Set((readConfigField(current(), 'disabledModelsCN') as readonly string[] | undefined) ?? [])
      for (const m of models) {
        if (enabled) currentDisabled.delete(m)
        else currentDisabled.add(m)
      }
      write({ disabledModelsCN: Array.from(currentDisabled) })
      return { state: 'updated' }
    }
  })

  ctx.effect(() => () => {
    stopped = true
    checkInScheduler.dispose()
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    detach(ctx, clearHostHeartbeat(), 'host heartbeat cleanup')
  })

  /**
   * Fetch one variant's catalog for the current credential, shared by the sweep and
   * the card's manual refresh. One request at a time (a second caller joins the
   * in-flight fetch); the write is generation-checked, so a late answer from a
   * superseded account changes nothing; and it calls `resolve()` rather than
   * `current()` so a missing token surfaces as `MISSING_CREDENTIAL`.
   */
  const fetchCatalog = async (runtime: VariantRuntime, identity: string): Promise<void> => {
    const inflight = runtime.inflightFetch
    const generation = runtime.catalogGeneration
    if (inflight !== undefined && inflight.identity === identity && inflight.generation === generation) {
      return inflight.promise
    }
    // Kept local too: no stale request may prevent the current account from fetching.
    inflight?.controller.abort()
    const controller = new AbortController()
    let run: Promise<void>
    run = (async (): Promise<void> => {
      let models: readonly QoderModelInfo[]
      try {
        // The file-backed credential owns this fetch; discovery reads the token
        // through the same store.
        const credential = await runtime.store.resolve()
        const resolvedIdentity = credentialIdentity(credential)
        if (resolvedIdentity !== identity) {
          adoptIdentity(runtime, resolvedIdentity)
          await fetchCatalog(runtime, resolvedIdentity)
          return
        }
        models = await runtime.client.fetchModels(controller.signal)
        // The token can also change mid-flight; re-read before publishing so the
        // roster still belongs to the credential in effect.
        const latest = await runtime.store.current()
        const latestIdentity = latest === undefined ? undefined : credentialIdentity(latest)
        if (latestIdentity !== identity) {
          adoptIdentity(runtime, latestIdentity)
          if (latestIdentity !== undefined) await fetchCatalog(runtime, latestIdentity)
          return
        }
      } catch (error: unknown) {
        // Report only if this attempt is still the current one: a superseded
        // attempt's failure must not overwrite the newer state.
        if (stopped || runtime.catalogGeneration !== generation) return
        runtime.lastFetchAtMs = Date.now()
        runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error)
        ctx.logger.warn(
          `dsh-qoder-connect: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`,
          error,
        )
        runtime.invalidate()
        return
      }
      if (stopped || runtime.catalogGeneration !== generation) return
      runtime.lastFetchAtMs = Date.now()
      // Shared across fiber reloads so a re-applied plugin does not re-fetch.
      lastLiveFetchAt.set(identity, runtime.lastFetchAtMs)
      runtime.catalog.set([...models])
      runtime.catalogSource = 'live'
      runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now()
      runtime.catalogError = undefined
      // Remember it for this account, so a restart or a later failing fetch serves
      // it instead of the compiled-in snapshot. A persist failure is logged and
      // swallowed: `fetchCatalog` promises its callers that it never rejects.
      if (lastIdentities.get(runtime.variant.id) === identity) {
        try {
          runtime.savedCatalogs.set(identity, {
            source: runtime.client.lastCatalog?.source ?? 'unknown',
            fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
            models: [...models],
          })
        } catch (error: unknown) {
          ctx.logger.warn(
            `dsh-qoder-connect: ${runtime.variant.displayName} catalog could not be saved for this account`,
            error,
          )
        }
      }
      runtime.invalidate()
    })().finally(() => {
      if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = undefined
    })
    runtime.inflightFetch = { identity, generation, controller, promise: run }
    return run
  }

  /**
   * Reconcile one variant with its credentials: reveal the group and fetch a
   * catalog on a first sighting, hide it when signed out, and do nothing when the
   * identity is unchanged (a PAT neither rotates nor expires).
   */
  const syncVariant = async (runtime: VariantRuntime): Promise<void> => {
    if (stopped || !runtime.registered) return
    const credential = await runtime.store.current().catch((error: unknown) => {
      // A region mismatch or an unreadable file is reported, not swallowed as
      // "signed out": the user needs to know which file to fix.
      ctx.logger.warn(`dsh-qoder-connect: ${runtime.variant.displayName} credential read failed`, error)
      return undefined
    })
    if (stopped) return

    if (credential === undefined) {
      adoptIdentity(runtime, undefined)
      return
    }

    const identity = credentialIdentity(credential)
    const known = lastIdentities.get(runtime.variant.id)
    if (known === identity && runtime.catalog.isVisible()) {
      // Same account, already showing something. Still fetch when the group is not
      // live: an earlier failure left it on the fallback or saved roster and nothing
      // else would replace it — on a slow backoff, so an outage is not a request
      // loop. Freshness is per-identity and survives a fiber reload.
      const stale = runtime.catalogSource !== 'live'
      const fetchedAt = lastLiveFetchAt.get(identity) ?? 0
      const due = Date.now() - fetchedAt >= credentialPollMs() * CATALOG_RETRY_SWEEPS
      if (stale && due) await fetchCatalog(runtime, identity)
      return
    }

    adoptIdentity(runtime, identity)
    await fetchCatalog(runtime, identity)
  }

  /** Run one reconcile sweep across both variants. */
  const syncAll = async (): Promise<void> => {
    for (const runtime of runtimes) await syncVariant(runtime)
  }

  /**
   * Start both variants, then begin the credential sweep. The chain carries its own
   * failure handler: an unhandled rejection here would terminate the host.
   */
  detach(ctx, Promise.all(runtimes.map(async runtime => startVariant(ctx, runtime, async () => {
    // The immediate seed, so a reloaded fiber never serves an empty catalog while
    // the sweep catches up.
    if (stopped) return
    let credential
    try {
      credential = await runtime.store.current()
    } catch {
      return
    }
    if (credential === undefined) return
    const identity = credentialIdentity(credential)
    if (lastIdentities.get(runtime.variant.id) !== identity || !runtime.catalog.isVisible()) {
      adoptIdentity(runtime, identity)
    }
  }))).then(() => {
    if (stopped) return
    // The host bundle is live: write a heartbeat so the status CLI can report host
    // health without a browser (cleared on disposal; a stale one is detected by PID).
    if (runtimes.some(runtime => runtime.registered)) detach(ctx, writeHostHeartbeat(), 'host heartbeat write')

    detach(ctx, syncAll(), 'credential sweep')
    const timer = setInterval(() => { detach(ctx, syncAll(), 'credential sweep') }, credentialPollMs())
    timer.unref?.()
    timers.push(timer)
  }), 'variant startup')
}
