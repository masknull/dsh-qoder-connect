/**
 * Qoder models for DeepSeek Harness, driven by Personal Access Tokens.
 * Registers one provider per product variant — `qoder` for the China region
 * and `qoder-global` for the international one — while streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 *
 * The two variants are assembled by the same factory and differ only in their
 * {@link QoderVariant} descriptor: each gets its own credential store,
 * transport, catalog, upstream client, shim, adapter, probe state, and routes.
 * Neither variant's startup, catalog fetch, or credential state can stop the
 * other from registering — a user with only one token sees only that group.
 *
 * @module dsh-qoder-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { QoderCredentialStore, qoderCredentialIdentity } from './auth.ts'
import { createAuthKey, registerQoderAuthRoute } from './auth-route.ts'
import { FALLBACK_QODER_MODELS, QoderCatalog } from './catalog.ts'
import { qoderCatalogPath, QoderCatalogStore } from './catalog-store.ts'
import { createQoderAdapter } from './adapter.ts'
import { createQoderShim } from './shim.ts'
import { QoderProbeService } from './probe-service.ts'
import { newestFirst, QoderProbeStore, qoderProbePath } from './probe-store.ts'
import { QoderUpstreamClient, validateApiKey } from './upstream.ts'
import { createQoderTransport, type QoderCheckInResult, type QoderTransport } from './qoder/transport/index.ts'
import { getMachineId } from './qoder/transport/machine-id.ts'
import { qoderMachineIdPath } from './paths.ts'
import { registerQoderStatusRoute } from './web-status.ts'
import { createProbeKey, registerQoderProbeRoute } from './probe-route.ts'
import { CheckInScheduler, DEFAULT_CHECK_IN_MINUTE, JsonFileCheckInStore, normalizeCheckInMinute } from './checkin-scheduler.ts'
import type { QoderModelInfo } from './catalog.ts'
import type { QoderWebCatalog, QoderWebProbeSection } from './status-paths.ts'
import { QODER_SETTINGS_FACE_PATH } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { emitJobTokenHint, emitJobTokenRefreshFailedHint, installJobTokenHint } from './job-token-hint.ts'
import { SettingsStore, readLegacySections } from './settings-store.ts'
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
  processStartTimeMs,
  readHostHeartbeat,
  qoderHostHeartbeatPath,
  type QoderHostHeartbeat,
} from './host-heartbeat.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-qoder'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Settings namespace owning the China card's section.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call. The brand is compile-time only, so this
 * stays the plain string it always was — every comparison, descriptor lookup,
 * and `dsh` config file still sees `'qoder'`. It is cast once here so the
 * public constant carries the seam's type without pulling the brand helper
 * into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
 * their namespaces as plain string literals).
 */
export const QODER_SETTINGS_NS = 'qoder' as SettingsNamespace

/**
 * Settings namespace owning the global card's section.
 *
 * One namespace per card, not one shared: the settings Plugins tab dispatches a
 * card by rendering `settings.plugin.item` with `entryKey = ns` for each
 * namespace the Host serves, and skips an entry whose key names no served
 * namespace. With a single installed section, the global card registers
 * into the slot but is never rendered — the card list is built from the Host's
 * sections, not from the slot's entries. Each card therefore needs its own
 * installed section whose namespace equals the card's slot key.
 */
export const QODER_GLOBAL_SETTINGS_NS = 'qoder-global' as SettingsNamespace

/**
 * Settings namespace owning the shared quota-card section.
 *
 * One card above the two variant cards configures both sidebar quota widgets
 * (China and global) from a single place, so its toggles cannot live in
 * either variant's section — they are per-variant fields on a cross-variant
 * card. The Plugins tab dispatches by namespace, so this section is what makes
 * that card render (see {@link QODER_GLOBAL_SETTINGS_NS} for the mechanism).
 */
export const QODER_QUOTA_SETTINGS_NS = 'qoder-quota' as SettingsNamespace

/**
 * How often the credential files are re-checked, in milliseconds.
 *
 * A startup-only catalog fetch cannot notice a token saved while DSH is
 * already running, so the model group would not appear until a restart. This
 * poll is a cheap existence/parse read of at most a few local files: it never
 * contacts the network and never runs a reasoning probe.
 *
 * `DSH_QODER_POLL_MS` overrides it. That exists so the sweep can be
 * exercised end to end in tests and shortened while diagnosing a slow
 * sign-in on a real machine; it is not a product setting and no UI exposes it.
 * The value is clamped to a sane range so a mistaken override cannot turn the
 * poll into a busy loop.
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
 * How long to wait before retrying a catalog fetch that failed.
 *
 * The credential sweep deliberately does not re-fetch a catalog it already has
 * (the same token carries no new model information). But a *failed* fetch must
 * not be treated the same way: without a retry, one transient network blip at
 * startup would leave the group on the built-in fallback roster until the user
 * noticed and pressed refresh. This bound keeps that recovery automatic while
 * still honoring the "not every round" rule — at most one attempt per
 * interval, and none at all once a live catalog lands.
 *
 * Expressed as a multiple of the sweep rather than a fixed duration so the two
 * stay in proportion under the `DSH_QODER_POLL_MS` override.
 */
const CATALOG_RETRY_SWEEPS = 10

/** Plugin configuration. */
export interface Config {
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent?: boolean
  /** Use the largest context window the global catalog explicitly offers. */
  useMaximumContextWindow?: boolean
  /** The China variant's own maximum-window preference, persisted in its section. */
  useMaximumContextWindowCN?: boolean
  /**
   * Per-model context-window overrides for the global variant (model id →
   * tokens). Kept for schema compatibility; the card no longer writes
   * per-model overrides because the upstream honours only the default and
   * the maximum, nothing between.
   */
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
  /**
   * Sidebar quota refresh interval in milliseconds. One shared value (both
   * cards poll on it) because the two widgets hit the same rate-limited
   * billing family; the floor guards against a typo hammering the quota
   * endpoint, which serves no cache.
   */
  quotaPollMs?: number
}

/**
 * Mark one configuration field as a live projected setting, when the host has
 * that concept at all.
 *
 * DSH 0.1.7 projects a `.volatile()` field into the profile's settings form and
 * hands the plugin a STABLE REFERENCE instead of the value; a field without the
 * mark never reaches the form — `dsh-settings`' `describe()` skips an entry
 * whose schema has no volatile field (`lib/index.js:411-421`), which is exactly
 * what makes the browser-side `configForms` namespace exist. DSH 0.1.5's
 * schemastery has no `volatile` at all, so calling it there is a `TypeError`
 * that would take the whole plugin down with it. The method is therefore
 * probed, never assumed.
 *
 * Only TOP-LEVEL fields are marked: a volatile field may not sit inside another
 * volatile field, and schemastery rejects a volatile node reached through a
 * collection (`validateVolatileSchema`), while the 0.1.7 client writes a single
 * path segment (`ConfigFormController.set` → `path: [field]`). Every field this
 * plugin exposes is already a top-level member of {@link Config}, so marking
 * the field itself is both legal and the only granularity the write path can
 * address.
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
 * Read one configuration field through the volatile indirection.
 *
 * On DSH 0.1.7 a `.volatile()` field arrives as a reference object whose value
 * is read with `.get()` (`@deepseek-ai/dsh-agent-default-model`,
 * `lib/index.js:38-41`); on DSH 0.1.5 the plain value arrives directly. Every
 * read of a projected field goes through here, so both hosts yield the value
 * itself.
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
 * Read one declared field with its declared type.
 *
 * The typed face of {@link readField}, for the few call sites that want a
 * single field rather than a whole {@link readConfig}.
 *
 * @param config - the raw plugin configuration, in either host's shape.
 * @param field - field name inside the configuration object.
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
/**
 * Per-model window overrides (model id → tokens). The card writes one entry
 * per selector change; the field is optional so an absent map means "no
 * overrides" rather than a default object the host must keep in sync.
 */
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
 * When a variant checks in, as minutes past midnight in UTC+8.
 *
 * Stored as a plain minute count rather than a "HH:mm" string so the schema
 * itself rejects an impossible time: a browser time input yields 0–1439, and
 * anything outside that range fails Host validation instead of silently
 * scheduling a request at a moment that never arrives.
 */
const CHECK_IN_MINUTE_FIELD = volatileField(z.number()
  .default(DEFAULT_CHECK_IN_MINUTE)
  .min(0)
  .max(1439)
  .description('每日自动签到的时刻（自 UTC+8 午夜起的分钟数，600 = 10:00）'))
/**
 * Quota poll interval: default 5 minutes, floor 1 minute. The status route
 * performs a live upstream billing call per request with no cache, so an
 * aggressively small interval translates directly into upstream load; the
 * floor is the smallest value the UI offers rather than a silent clamp —
 * smaller staged values fail Host validation and refuse to save.
 */
export const QUOTA_POLL_DEFAULT_MS = 300_000
export const QUOTA_POLL_MIN_MS = 60_000
const QUOTA_POLL_FIELD = volatileField(z.number()
  .default(QUOTA_POLL_DEFAULT_MS)
  .min(QUOTA_POLL_MIN_MS)
  .description('Sidebar quota card refresh interval in milliseconds (default 300000, minimum 60000)'))

export const Config: z<Config> = z.object({
  probeConsent: PROBE_CONSENT_FIELD,
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
  useMaximumContextWindowCN: MAXIMUM_CONTEXT_WINDOW_CN_FIELD,
  modelContextWindows: MODEL_CONTEXT_WINDOWS_FIELD,
  modelContextWindowsCN: MODEL_CONTEXT_WINDOWS_FIELD,
  // The disabled-model lists live at the TOP level, and they must: DSH 0.1.7
  // projects an entry's settings form from this schema (its `describe()` reads
  // `entry.fiber.runtime.Config`), so a field that is not declared here reaches
  // neither the settings document nor the Models page's provider directory —
  // which is exactly how "设置-模型 里看不到模型开关" happened. They used to
  // live only in the 0.1.5 per-card sections (CHINA_SECTION/GLOBAL_SECTION),
  // which 0.1.7 has no concept of.
  disabledModels: DISABLED_MODELS_FIELD,
  disabledModelsCN: DISABLED_MODELS_FIELD,
  sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
  sidebarQuotaGlobal: QUOTA_TOGGLE_FIELD,
  autoCheckInCN: AUTO_CHECK_IN_FIELD,
  autoCheckInGlobal: AUTO_CHECK_IN_FIELD,
  checkInMinuteCN: CHECK_IN_MINUTE_FIELD,
  checkInMinuteGlobal: CHECK_IN_MINUTE_FIELD,
  quotaPollMs: QUOTA_POLL_FIELD,
})

/**
 * The China card's settings section: only the fields that card edits.
 *
 * A section is what makes its namespace "served", which is what the Plugins
 * tab dispatches a card by — so the schema and the card must stay split the
 * same way. `probeConsent` lives here because it predates the second variant;
 * it gates no current code path (only manual, per-click-confirmed probes run),
 * so it is left where existing users set it rather than moved and re-asked.
 */
const CHINA_SECTION: z<Config> = z.object({
  probeConsent: PROBE_CONSENT_FIELD,
  useMaximumContextWindowCN: MAXIMUM_CONTEXT_WINDOW_CN_FIELD,
  modelContextWindowsCN: MODEL_CONTEXT_WINDOWS_FIELD,
  disabledModelsCN: DISABLED_MODELS_FIELD,
})

/** The global card's settings section and its context-window preferences. */
const GLOBAL_SECTION: z<Config> = z.object({
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
  modelContextWindows: MODEL_CONTEXT_WINDOWS_FIELD,
  disabledModels: DISABLED_MODELS_FIELD,
})

/**
 * The shared quota card's section: both sidebar toggles and the poll interval.
 *
 * Only these fields — the card edits nothing else, and the Plugins tab pairs a
 * card with the section whose namespace it names, so a stray field here would
 * render as a control no other surface reads.
 */
const QUOTA_SECTION: z<Config> = z.object({
  sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
  sidebarQuotaGlobal: QUOTA_TOGGLE_FIELD,
  autoCheckInCN: AUTO_CHECK_IN_FIELD,
  autoCheckInGlobal: AUTO_CHECK_IN_FIELD,
  checkInMinuteCN: CHECK_IN_MINUTE_FIELD,
  checkInMinuteGlobal: CHECK_IN_MINUTE_FIELD,
  quotaPollMs: QUOTA_POLL_FIELD,
})

/**
 * Every field each settings section owns, and therefore every field the live
 * configuration has to carry through.
 *
 * One list per section, shared by the merge and by the test that pins it to
 * the schema. Writing the merge out by hand is what broke auto check-in: the
 * `qoder-quota` section grew four fields (`autoCheckInCN`, `autoCheckInGlobal`,
 * `checkInMinuteCN`, `checkInMinuteGlobal`) while the merge kept copying only
 * the three that predated them, so `current().autoCheckInCN` read `undefined`
 * forever and the scheduler saw the toggle as permanently off. The card saved
 * it, the file held it, and nothing ever acted on it.
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
    // Through `readField`: on 0.1.7 the source's projected fields are
    // references, and a reference must never be copied into the merged
    // configuration the rest of the plugin compares against.
    const field = readField(value, key)
    if (field !== undefined) (picked as Record<string, unknown>)[key] = field
  }
  return picked
}

/**
 * Unwrap a whole configuration object into plain values.
 *
 * The merged configuration is read through {@link pickFields}/{@link readField}
 * everywhere else, but the plugin also reads its initial config directly while
 * it assembles its runtimes — before any settings section has handed over a
 * source. On 0.1.7 those direct reads would otherwise compare a reference
 * object against `true`/`undefined` and silently see "not set" for every field.
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
   * The last catalogs that loaded, keyed by account.
   *
   * Sits between the live fetch and the built-in roster in the degradation
   * order: a restart, or a fetch that fails while offline, serves what this
   * token was last actually shown instead of the one-off snapshot compiled
   * into the plugin.
   */
  savedCatalogs: QoderCatalogStore
  /** The static roster this variant falls back to. */
  fallback: readonly QoderModelInfo[]
  /**
   * Where the served models came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch) →
   * `fallback` (the roster compiled into the plugin).
   */
  catalogSource: 'live' | 'saved' | 'fallback'
  /** When the served catalog was fetched, for `live` and `saved`. */
  catalogFetchedAtMs: number | undefined
  /** Why the last catalog attempt failed, when it did. */
  catalogError: string | undefined
  /** When the last catalog attempt started, for the retry backoff. */
  lastFetchAtMs: number
  /**
   * Bumped whenever this variant's catalog generation changes — a token
   * switch, a sign-out, or a new fetch superseding an older one. A request
   * carries the generation it started under and refuses to write back if the
   * generation has moved on, so a slow answer can never resurrect data the
   * plugin has since decided to drop (spec §5: late responses are discarded).
   */
  catalogGeneration: number
  /**
   * The in-flight catalog fetch, scoped to the identity and generation it began
   * under. A caller may only join the same scope; a token change cancels the
   * old request and immediately starts one for the newly adopted account.
   */
  inflightFetch: CatalogFetch | undefined
  /** Notify the model directory that this variant's answers changed. */
  invalidate: () => void
  /** Whether the provider registered successfully. */
  registered: boolean
  /**
   * When the self-heal last auto-refreshed this variant's job token, epoch ms.
   * Recorded by the transport's `onJobTokenRefreshed` callback and surfaced on
   * the card's status document, so the otherwise invisible recovery shows.
   */
  jobTokenRefreshedAt: () => number | undefined
  /**
   * Claim today's daily benefit for this variant's account.
   *
   * A capability the check-in scheduler and the card's manual button both
   * need, surfaced as a named field rather than read out of the transport with
   * an `as unknown as` cast: such a cast fails silently (a renamed private
   * field turns every check-in into a no-op) instead of failing to compile.
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

/** The settings namespace a variant's card and provider directory entry use. */
function settingsNamespaceFor(variant: QoderVariant): SettingsNamespace {
  return variant.id === CHINA_VARIANT.id ? QODER_SETTINGS_NS : QODER_GLOBAL_SETTINGS_NS
}

/**
 * The static catalog a variant serves before its first successful fetch.
 *
 * Both regions share one roster transcribed from the transport's built-in
 * model defaults: unlike the WorkBuddy-era endpoints, the Qoder pools are
 * region-specific only in what discovery lists, and inventing a second roster
 * from nothing would misdescribe whichever variant it was not captured from.
 */
function fallbackFor(_variant: QoderVariant): readonly QoderModelInfo[] {
  return FALLBACK_QODER_MODELS
}

/**
 * The hint row's summary line: what happened, and when.
 *
 * Named here rather than in the hint module because the text is this plugin's
 * user-facing wording, and the transport callback that produces it runs before
 * the plugin's own scope exists.
 */
function jobTokenHintText(at: number): string {
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  return `jobToken 已自动刷新（${time}）— 旧令牌被上游拒绝，已自动重换并恢复`
}

/**
 * The failed-heal row's summary line.
 *
 * Deliberately does not name a cause: the upstream rejection that survived a
 * fresh token is not necessarily an authorization problem at all, and the real
 * reason travels in the failure message itself (see the SSE envelope body).
 * Claiming "quota" or "revoked" here would be a guess presented as a finding.
 *
 * It also must not point the reader at "the error above": the failed heal does
 * not always belong to a chat whose failure renders a card in this
 * conversation. A heal inside the session-title request — same transport,
 * same shared notice state — fails silently there, so the row used to send
 * users looking for an error card that does not exist. The row states only
 * what is known: the retry ran, it did not recover, the request failed.
 */
function jobTokenRefreshFailedHintText(at: number): string {
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  return `jobToken 已重换但仍被上游拒绝（${time}）— 自愈未恢复，该请求已失败`
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
  // The self-heal's auto-refresh record, surfaced on the card. Per variant:
  // each region's transport reports its own refreshes.
  let jobTokenRefreshedAt: number | undefined
  // The attachment service may not exist when the client and transport are
  // constructed (and a headless profile never has one), so both get a stable
  // facade that resolves the real store per request.
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
  const transport = createQoderTransport({
    region: variant.region,
    resolvePat: () => store.patPromise(),
    // Keep the machine-id seed inside the plugin's own data directory
    // (state/) instead of letting the transport write it near $HOME.
    resolveMachineId: () => getMachineId([qoderMachineIdPath()]),
    attachments,
    onJobTokenRefreshed: info => {
      jobTokenRefreshedAt = info.at
      ctx.logger.warn(
        `dsh-qoder-connect: ${variant.displayName} job token was auto-refreshed after an upstream rejection`,
      )
      // The visible channel: one line in the conversation that triggered the
      // refresh (the request this heal happened inside).
      emitJobTokenHint(info.at, jobTokenHintText(info.at))
    },
    onJobTokenRefreshFailed: info => {
      // The heal ran and lost. Announced at most once per outage by the
      // transport, so a long rejection storm prints one row, not one per retry.
      ctx.logger.warn(
        `dsh-qoder-connect: ${variant.displayName} job token refresh did not recover the chat (upstream status ${info.status ?? 'unknown'})`,
      )
      emitJobTokenRefreshFailedHint(info.at, jobTokenRefreshFailedHintText(info.at))
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
  // Read the initial preferences through the caller's LIVE configuration view
  // (`current()`), never the bare entry config: the plugin-owned settings file
  // is the live source, and reading the entry here made every restart forget
  // the disabled-model list — the entry is empty by then (its row was cleaned
  // up), so the catalog came back "all models enabled" and the picker offered
  // models the user had switched off. `readField` unwraps the volatile
  // references on 0.1.7.
  const initial = current()
  if (variant.id !== CHINA_VARIANT.id) {
    catalog.setUseMaximumContextWindow(initial.useMaximumContextWindow === true)
    if (initial.disabledModels !== undefined) catalog.setDisabledModels(initial.disabledModels)
  } else {
    catalog.setUseMaximumContextWindow(initial.useMaximumContextWindowCN === true)
    if (initial.modelContextWindowsCN !== undefined) catalog.setModelContextWindows(initial.modelContextWindowsCN)
    if (initial.disabledModelsCN !== undefined) catalog.setDisabledModels(initial.disabledModelsCN)
  }
  // Start hidden: a variant must serve no models until a token has actually
  // been adopted, so a signed-out variant is empty rather than showing a roster
  // whose models could only fail. `adoptIdentity` is what reveals it, and it
  // treats "never seen, still signed out" as no change — which is only correct
  // if the pre-adoption state is already hidden.
  catalog.setVisible(false)
  const probeStore = new QoderProbeStore({
    pluginVersion: QODER_CONNECT_VERSION,
    path: qoderProbePath(variant.probeFilename),
  })
  // One file per variant, for the same reason the probe records are split: the
  // two regions can disagree about rates and windows for shared model ids, so
  // a saved China roster must never be served as a global one.
  const savedCatalogs = new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) })
  const probeService = new QoderProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent: () => current().probeConsent === true,
    // Observations are per account: the service reads and writes its records
    // against this identity, so one token's detected levels never answer for
    // another's, and an in-flight sweep cannot store under a new token.
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
    checkIn: (signal?: AbortSignal) => transport.checkIn(signal),
  }
}

/** The catalog provenance the card displays. */
function catalogSection(runtime: VariantRuntime): QoderWebCatalog {
  return {
    // The source is what the models on screen actually came from, so the card
    // can distinguish a fresh fetch from a saved one from the built-in roster —
    // "stale" and "offline" are different problems for the user.
    source: runtime.catalogSource,
    // The served catalog's own fetch time, which for a saved list is when it
    // was fetched, not when the process started.
    ...runtime.catalogFetchedAtMs === undefined ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
    ...runtime.catalogError === undefined ? {} : { error: runtime.catalogError },
  }
}

/**
 * Whether a model can be probed by hand: it reasons and the upstream declares
 * no effort set for it.
 *
 * Deliberately *not* filtered by whether a result already exists. Dropping a
 * model once it has been detected made the list shrink with use, so
 * re-detecting one model — after an upstream change, say — meant clearing every
 * other result first. The list stays stable and the card marks which entries
 * already have an answer.
 */
function isProbeCandidate(info: QoderModelInfo): boolean {
  if (info.reasoning?.supports !== true) return false
  return (info.reasoning.supportedEfforts?.length ?? 0) === 0
}

/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime: VariantRuntime, consent: boolean): QoderWebProbeSection {
  const models = runtime.catalog.current()
  // Read results through the *same* judgement the adapter uses, rather than
  // straight from the store. A raw record can be stale in ways the adapter
  // already discounts — its catalog row changed, it aged past the TTL, or the
  // upstream has since declared an effort set (which always wins) — and showing
  // one would have the card promise levels the model picker does not offer. A
  // model the upstream dropped leaves the catalog entirely, so it drops out
  // here too.
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
    // Newest first: a detection the user just ran belongs at the top, not
    // appended below every earlier one.
    results: newestFirst(results),
  }
}

/**
 * Run a detached promise without letting its failure kill the host.
 *
 * Node terminates the whole process on an unhandled rejection (exit code 1),
 * which the desktop shell reports as the backend having "exited unexpectedly"
 * — so a failing heartbeat write, loopback close, or background sweep in this
 * plugin would take the entire Harness down with it. Every fire-and-forget
 * call therefore carries a handler; a failure is a diagnostic, never a reason
 * for the host to die.
 */
function detach(ctx: Context, work: Promise<unknown>, what: string): void {
  void work.catch((error: unknown) => {
    ctx.logger.warn(`dsh-qoder-connect: ${what} failed`, error)
  })
}

/**
 * Start one variant: its loopback endpoint, provider registration, and
 * configuration-card wiring.
 *
 * Registration waits for the shim to hold a port, because the provider's
 * models read the shim origin at construction time. A failure here is
 * contained to this variant: the caller logs it and the other keeps working.
 *
 * @param seedCatalog - adopt the current credential into this runtime's
 *   catalog immediately; supplied by `apply` (it owns `adoptIdentity`).
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
  })
  try {
    await shim.ready
  } catch (error: unknown) {
    ctx.logger.error(`dsh-qoder-connect: ${variant.displayName} loopback endpoint failed to start`, error)
    return false
  }

  try {
    // Constructed only once the listener holds a port: the provider's models
    // read the shim origin at construction time.
    const qoder = createQoderAdapter({
      providerId: variant.id,
      displayName: variant.displayName,
      shim,
      store,
      catalog,
      resolveAttachments: () => ctx.get('attachments'),
      observe: modelId => probeService.recordFor(modelId),
    })
    runtime.invalidate = () => {
      qoder.invalidate()
      ctx.emit('llm/adapters-updated')
    }

    let releaseAdapter: (() => void) | undefined
    let releaseDirectory: (() => void) | undefined
    try {
      releaseAdapter = ctx.llm.registerAdapter([variant.id], qoder.adapter)
      // The settings namespace the Models page resolves this directory row
      // against differs by host line, and the difference is not cosmetic:
      //
      //  - 0.1.7 serves one settings form per profile ENTRY, keyed by
      //    `entry.options.id` (dsh-settings `describe()`), so the row must name
      //    that id — naming the 0.1.5 namespace (`qoder` / `qoder-global`) makes
      //    the page resolve a name the Host never served, and the row renders
      //    with no configuration at all.
      //  - 0.1.5 serves the namespaces this plugin installs, which is what
      //    `settingsNamespaceFor` returns.
      //
      // `configEditor` exists only on 0.1.7, which is the same probe the write
      // path and the migration use.
      const host017 = ((): boolean => {
        try {
          const probe = ctx as unknown as { get?: (name: string) => unknown }
          return probe.get?.('configEditor') !== undefined
        } catch {
          return false
        }
      })()
      const entryId = (ctx as unknown as { fiber?: { entry?: { options?: { id?: string } } } }).fiber?.entry?.options?.id
      const settingsNs = host017 && entryId !== undefined ? (entryId as SettingsNamespace) : settingsNamespaceFor(variant)
      releaseDirectory = ctx.llm.registerConfigurableProviders([{
        provider: variant.id,
        displayName: variant.displayName,
        // Each variant's directory entry joins its own settings form; the
        // Models settings page resolves `settingsNs` against the served forms,
        // so the name must be the one THIS host serves (see above).
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
      // The plugin was disposed during registration; release immediately — the
      // plugin-level disposer already closed every shim.
      releaseAdapter?.()
      releaseDirectory?.()
      detach(ctx, shim.close(), 'loopback endpoint close')
    }
    runtime.registered = true
    // Seed the catalog BEFORE returning, not in the later sweep.
    //
    // A 0.1.7 settings write hot-reloads this fiber; the fresh runtime's
    // catalog starts hidden, and until the sweep runs `adoptIdentity` the
    // status route answers with zero models — the card's post-write refresh
    // lands exactly in that window and shows "暂无可配置的模型" until the user
    // presses refresh. Seeding here closes the window: by the time the routes
    // are live the catalog already holds the saved/fallback roster.
    detach(ctx, seedCatalog(), `${variant.id} catalog seed`)
    return true
  } catch (error: unknown) {
    ctx.logger.error(`dsh-qoder-connect: ${variant.displayName} provider registration failed`, error)
    detach(ctx, shim.close(), 'loopback endpoint close')
    return false
  }
}

/**
 * State that MUST survive a fiber reload, module-level on purpose.
 *
 * DSH 0.1.7's configuration write (`configEditor.edit`) reconciles the profile
 * tree, which hot-reloads the entry's fiber — `apply()` runs again with a fresh
 * closure. Anything re-minted per apply is therefore invalidated by every
 * settings write: the browser cards hold the keys the status document handed
 * them, so a per-apply key turns each write into a wave of 403s ("刷新失败"),
 * and a per-apply identity map makes the sweep re-fetch the catalog from
 * upstream on every write (the burst of requests and most of the latency).
 *
 * Keys and identity/fetch bookkeeping are per-PROCESS secrets and caches, not
 * per-instance state, so they live here once. A reload keeps the same keys (no
 * 403 storm) and a same-account, freshly-fetched sweep (no refetch burst).
 */
/** The in-process control keys, minted once per process. */
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
 * The schema defaults, READ off each field's own `meta.default`.
 *
 * Two ways this was got wrong before, both silent and both destructive: a
 * hand-written table drifted from the schema (so the schema's own defaults
 * were classified as real overrides and the legacy settings document could
 * never win), and `validate({})` was then tried instead — which on this
 * schemastery answers with hollow `{}` per field instead of applying the
 * defaults, which is worse than nothing because it looks like it worked.
 * Walking `Config.dict` for `meta.default` is the only honest source: it is
 * the value schemastery itself substituted during validation.
 */
const DEFAULT_FOR_FIELD: Partial<Record<keyof Config, unknown>> = (() => {
  const out: Partial<Record<keyof Config, unknown>> = {}
  try {
    for (const [key, field] of Object.entries(Config.dict ?? {})) {
      const fallback = (field as { meta?: { default?: unknown } } | undefined)?.meta?.default
      if (fallback !== undefined) (out as Record<string, unknown>)[key] = fallback
    }
  } catch {
    // An unreadable schema leaves the map partial: every field then reads as
    // "no default", which keeps the entry authoritative — the pre-migration
    // behaviour — rather than guessing.
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
 * Register the settings face (GET/POST) the browser cards read and write
 * through, answering the whole entry configuration as three layers.
 *
 * `value` carries every declared field, so a card rendering the quota section
 * sees the same merged view the host itself reads; `user` is the settings file
 * exactly as stored (presence marks an override), which is what the staged-edit
 * form's "written/reset" display needs. A POST validates the fields it is
 * allowed to touch, writes the file, applies the new view in memory, and
 * re-arms the check-in scheduler (the old 0.1.5 section `onChange` behaviour).
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
        // A card write: the file holds live user edits from here on (see the
        // seed rule on `apply`), so a stale profile row can never regress it.
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
function readFaceBody(req: { on: (event: string, handler: (chunk?: unknown) => void) => void }): Promise<string | undefined> {
  return new Promise(resolve => {
    let body = ''
    req.on('data', (chunk: unknown) => {
      body += String(chunk)
      if (body.length > 1e6) { resolve(undefined) }
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(undefined))
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
        if (typeof value !== 'boolean') return `${field} must be a boolean`
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
 * When the profile tree last recomposed, module-level so every apply sees it.
 *
 * The legacy settings.yaml import writes the profile patch one section at a
 * time for seconds after the Loader settles, emitting this event on every
 * write. Cleaning up our row in that window is futile — the import's next
 * section simply writes it back — so the cleanup waits for the tree to fall
 * quiet first.
 */
let lastConfigReloadAt = Date.now()

/** Wait until the profile tree has been quiet (the legacy import finished). */
async function waitForProfileQuiet(): Promise<void> {
  const deadline = Date.now() + 120_000
  for (;;) {
    if (Date.now() - lastConfigReloadAt >= 5_000) return
    if (Date.now() >= deadline) return
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
}

/**
 * Delete this plugin's own fields from the profile entry config, leaving every
 * other key of the row untouched.
 *
 * One-time, right after the settings file has been seeded: the entry returns to
 * its shipped state, so no second source of truth remains. Both write APIs are
 * probed — `configEditor` (0.1.7) first, then the settings service's namespace
 * `replace` (0.1.5), which rebuilds each of this plugin's three sections from
 * the foreign keys alone.
 *
 * @param ctx - plugin context.
 * @param ownKeys - this plugin's declared config fields.
 * @param namespaces - the 0.1.5 section namespaces this plugin owns.
 */
async function cleanupEntryConfig(ctx: Parameters<typeof apply>[0], ownKeys: readonly string[], namespaces: readonly string[]): Promise<void> {
  // RETRIES, deliberately: `configEditor.edit` writes under the profile's
  // package.json lock, and every plugin migrating on the same boot contends for
  // that ONE lock — four sibling plugins seeding at once measured exactly one
  // winner and three "timed out waiting for the writer lock" failures. The
  // write is idempotent, so backing off (with jitter) makes the rest land.
  const attempts = 10
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // The legacy settings.yaml import writes this same profile patch, one
      // section at a time, for seconds after the Loader settles — and it holds
      // the very lock this cleanup needs, and rewrites our row while we watch.
      // Wait for that write storm to end before the first attempt, then back
      // off between retries.
      if (attempt === 0) await waitForProfileQuiet()
      else await new Promise(resolve => setTimeout(resolve, 2_000 + Math.random() * 1_000))
      const probe = ctx as unknown as {
        get?: (name: string) => unknown
        fiber?: { entry?: unknown }
      }
      // configEditor 双路探测：本 ctx 直取（0.1.7 官方写法），失败再从 settings
      // 服务的 ownerContext（宿主根 ctx，configEditor 挂在那里）取。
      const own: unknown = typeof probe.get === 'function'
        ? (() => { try { return probe.get.call(ctx, 'configEditor') } catch { return undefined } })()
        : undefined
      const editor = (own ?? await new Promise<unknown>(resolve => {
        ctx.inject(['settings'], settingsCtx => {
          const owner = (settingsCtx.settings as { ownerContext?: { get?: (name: string) => unknown } } | undefined)?.ownerContext
          const viaOwner = typeof owner?.get === 'function'
            ? (() => { try { return owner.get.call(owner, 'configEditor') } catch { return undefined } })()
            : undefined
          resolve(viaOwner)
        })
      })) as { edit(entry: unknown, change: (raw: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void> } | undefined
      const entry = probe.fiber?.entry
      if (editor !== undefined && entry !== undefined) {
        // The change callback returns INHERITED plus the row's foreign keys, not
        // "the row minus our keys": the profile's composition check
        // (`isDeepStrictEqual(next, inherited)`) is what lets the editor drop the
        // row's user layer entirely, and a hand-built `{}` fails that check
        // whenever a bundle layer still carries a config for this entry.
        // Any other plugin's (or the user's own) keys on the row stay.
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
      // 0.1.5: rebuild each namespace's user layer empty. Every one of this
      // plugin's three sections is declared by this plugin alone (its schema IS
      // the field list), so an empty section is exactly "our keys, nothing else".
      await new Promise(resolve => {
        ctx.inject(['settings'], settingsCtx => {
          const settings = settingsCtx.settings as unknown as {
            installSection?: unknown
            replace?: (ns: string, section: Record<string, unknown>) => Promise<unknown>
          }
          if (typeof settings?.replace !== 'function' || typeof settings.installSection !== 'function') {
            resolve(undefined)
            return
          }
          Promise.all(namespaces.map(ns => Promise.resolve(settings.replace!(ns, {})).catch(() => undefined)))
            .then(() => resolve(undefined))
        })
      })
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
 * When a variant's catalog was last fetched LIVE from upstream, per identity.
 *
 * A reload reseeds the catalog from the saved file; without this record the
 * sweep's retry rule (`stale && due`) sees `lastFetchAtMs = 0` and re-fetches
 * immediately — one upstream round trip per variant per settings write.
 */
const lastLiveFetchAt = new Map<string, number>()

/**
 * Start both variants: their loopback endpoints, the `qoder` and
 * `qoder-global` providers, their configuration cards, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a token saved after startup working
 * without re-registering the provider.
 */
export function apply(ctx: Context, config: Config): void {
  // Live configuration source: the composition entry (the profile row, read
  // through the volatile indirection — on 0.1.7 every projected field is a
  // reference object whose value comes from `.get()`) with the plugin-owned
  // settings file layered on top. `current()` — the one reader the whole
  // plugin consults — hands out plain values on both hosts.
  //
  // The entry stays as the fallback layer so a hand-edited profile row still
  // seeds a fresh install; the file is where every write lands (see the
  // `settings-store` module for why: a profile-patch write costs a full tree
  // reconcile and a fiber reload on every switch).
  const store = new SettingsStore()
  let current = (): Config => ({ ...readConfig(config), ...store.values() }) as Config

  /**
   * One-time migration: per field — the file never held it → take the entry;
   * the card HAS written this file → keep the file; the entry carries a
   * NON-DEFAULT value → take the entry (the legacy settings.yaml import lands
   * only after the Loader settles, i.e. after this plugin's first apply, and a
   * seed taken inside that window can hold a stale or mis-encoded value); the
   * entry only carries the schema default → keep the file.
   *
   * That last clause is load-bearing: a bundle layer's insert config does NOT
   * reach the composition (verified with `dsh --dump-config`), so once the
   * one-time cleanup has emptied the entry row the entry answers pure defaults —
   * treating those as authoritative would erase the user's values on the next
   * boot. Re-checked on every apply, which is also what closes the legacy
   * import's timing window.
   *
   * When the entry is authoritative, its own fields are then deleted from the
   * profile row, so no second source of truth remains.
   */
  const migrateOwnSettings = (): void => {
    const legacy = readLegacySections([QODER_SETTINGS_NS, QODER_GLOBAL_SETTINGS_NS, QODER_QUOTA_SETTINGS_NS])
    const seeded: Record<string, unknown> = {}
    for (const key of CONFIG_KEYS) {
      const entryValue = readField(config, key)
      const legacyValue = legacy === undefined ? undefined : legacy[key]
      const holds = Object.hasOwn(store.user, key)
      if (!holds) {
        // First seed — the first NON-DEFAULT candidate, entry before legacy, and
        // only then an explicit default so the stored layer stays complete. A
        // schema default (an empty array, `true` for a toggle that defaults on)
        // is NOT a value to seed on: seeding it here is what starved the legacy
        // layer, whose document is the only surviving copy of this plugin's
        // 0.1.5 settings.
        if (entryValue !== undefined && JSON.stringify(entryValue) !== JSON.stringify(DEFAULT_FOR_FIELD[key])) seeded[key] = entryValue
        else if (legacyValue !== undefined && JSON.stringify(legacyValue) !== JSON.stringify(DEFAULT_FOR_FIELD[key])) seeded[key] = legacyValue
        else if (entryValue !== undefined) seeded[key] = entryValue
        else if (legacyValue !== undefined) seeded[key] = legacyValue
        continue
      }
      if (store.edited) continue
      if (entryValue !== undefined && JSON.stringify(entryValue) !== JSON.stringify(DEFAULT_FOR_FIELD[key])) {
        seeded[key] = entryValue
        continue
      }
      if (legacyValue !== undefined && JSON.stringify(legacyValue) !== JSON.stringify(DEFAULT_FOR_FIELD[key])) {
        seeded[key] = legacyValue
      }
    }
    if (Object.keys(seeded).length === 0) return
    store.patch(seeded)
    void cleanupEntryConfig(ctx, CONFIG_KEYS, [QODER_SETTINGS_NS, QODER_GLOBAL_SETTINGS_NS, QODER_QUOTA_SETTINGS_NS])
  }
  migrateOwnSettings()

  // A volatile-only configuration change — which is what the legacy
  // settings.yaml import performs, because every field of this Config is
  // `.volatile()` — commits through the loader's volatile fast path: the
  // references are updated IN PLACE and `apply()` is NOT run again. Seeding
  // only inside `apply` would never observe values arriving that way. This
  // event fires on exactly that commit (the same mechanism the built-in
  // `dsh-llm-pi-ai` uses), so the seed rule re-evaluates.
  // Both events are Host-internal channels the 0.1.5 typings do not declare, so
  // they reach `on` through the string-keyed escape hatch rather than the typed
  // event map — exactly how the host's own `installSection`/probe wiring reads
  // service shapes this bundle's typings predate.
  const eventSink = ctx as unknown as { on: (event: string, listener: () => void) => void }
  eventSink.on('loader/volatile-update', () => { migrateOwnSettings() })
  // Every profile recomposition — including each section the legacy import
  // writes — refreshes this stamp, which is what waitForProfileQuiet reads
  // before cleaning our row up.
  eventSink.on('app-boot/config-reload', () => { lastConfigReloadAt = Date.now() })

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
        // unscheduled, so it falls back to the documented default rather than
        // to "now" or to an instant that never comes.
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
   * The startup catch-up, run once more from the settings source callback.
   *
   * `start()` above runs while the plugin is still assembling: the section
   * that stores these toggles has not handed over its values yet, so that
   * sweep reads the raw plugin config, sees no toggle, and skips the day. The
   * retry is what makes "boot after 10:00" actually claim.
   */
  let startupCatchUpDone = false
  const runStartupCatchUpOnce = (): void => {
    if (startupCatchUpDone) return
    startupCatchUpDone = true
    checkInScheduler.catchUp()
  }

  // The session-visible hint row for a self-heal: appends the harness's own
  // log-only `command/run` + `command/done` pair to the running conversation,
  // so the recovery shows as one line and registers nothing globally.
  installJobTokenHint(ctx)

  // Same-origin routes backing each Plugin-configuration card; the webServer
  // service is optional (a headless profile serves no browser).
  // Keys are per-process (see {@link controlKeys}): a 0.1.7 settings write
  // reloads this fiber, and per-apply keys would invalidate every card's key.
  const { probe: probeKey, auth: authKey } = controlKeys()
  let setMaximumContextWindow: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  let setMaximumContextWindowCN: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  let setModelsEnabled: ((options: { models: readonly string[]; enabled: boolean }) => Promise<{ state: string; reason?: string }>) | undefined
  let setModelsEnabledCN: ((options: { models: readonly string[]; enabled: boolean }) => Promise<{ state: string; reason?: string }>) | undefined
  /**
   * Point a variant at an account identity, invalidating whatever the previous
   * one left behind.
   *
   * One helper for all four transitions (sweep sign-in, sweep sign-out, manual
   * refresh, card save) because each of them used to do its own partial
   * version, and the manual path forgot pieces the sweep did. Every transition
   * bumps {@link VariantRuntime.catalogGeneration}, which is what makes an
   * in-flight request from before the change refuse to write back.
   *
   * Probe observations are dropped whenever the account actually changes —
   * including sign-out, and including the "signed out, then in as someone else"
   * sequence that used to look like a first sighting and let the new account
   * inherit the old one's detected levels. They are deliberately NOT cleared on
   * a first sign-in: no previous account's data could leak there, and clearing
   * would delete records this very account owns (written before a restart, or
   * seeded while all of this is running).
   *
   * @param identity - the account now in effect, or `undefined` when signed out.
   */
  const adoptIdentity = (runtime: VariantRuntime, identity: string | undefined): void => {
    const id = runtime.variant.id
    const known = lastIdentities.get(id)
    // "Same identity" may only short-circuit when THIS runtime has already
    // adopted: a fresh catalog starts hidden (`createVariantRuntime` sets
    // `visible=false`), and DSH 0.1.7's configuration write hot-reloads the
    // fiber, so every settings write produces exactly such a fresh runtime.
    // Short-circuiting on identity alone there skips the seeding AND the
    // `setVisible(true)`, the provider registers with zero models, and the
    // card's model list and context-window section go empty — and stay empty,
    // because `all()` answers nothing while hidden even after a later fetch
    // succeeds, and the refresh button routes through this same function.
    if (known === identity && runtime.catalog.isVisible()) return
    const hadCredential = known !== undefined
    if (identity === undefined) lastIdentities.delete(id)
    else lastIdentities.set(id, identity)
    // Any change of identity invalidates in-flight work and recorded answers.
    runtime.catalogGeneration += 1
    runtime.inflightFetch?.controller.abort()
    runtime.inflightFetch = undefined
    if (hadCredential && known !== identity) {
      runtime.probeStore.clear()
      runtime.invalidate()
    }
    if (identity === undefined) {
      // Signed out: hide the group, and drop the models so they are not left
      // registered-but-invisible if visibility ever flips back. The signed-out
      // account's saved catalog is forgotten as well — it is that account's
      // data, and it is keyed by identity so nothing else can serve it, but
      // keeping it would only be useful if that same account returned, and the
      // file is not a place to accumulate departed accounts' catalogs.
      if (known !== undefined) runtime.savedCatalogs.delete(known)
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
      runtime.catalogError = undefined
      if (runtime.catalog.setVisible(false)) runtime.invalidate()
      return
    }
    // Serve this account's best-known catalog until a fetch lands. The saved
    // catalog is preferred over the built-in roster: the roster is a snapshot
    // taken once, while the saved one is what this account (from this source)
    // was actually served. This covers both a switch and a restart — on a
    // restart `hadCredential` is false, and the saved catalog is exactly what
    // stops the group from falling back to the compiled-in list.
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
   * Apply catalog preferences from a configuration view, in memory.
   *
   * Shared by the probe-route setters and the settings face's POST: both write
   * the plugin-owned settings file and then land the new view here, which is
   * what the cards see on their next status read.
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
        checkIn: () => {
          const record = checkInStore.read(runtime.variant.id)
          if (record === undefined) return undefined
          const nextRunAt = checkInScheduler.nextRunAt(runtime.variant.id)
          return {
            ...record,
            // Rides the record so the card can show the pending moment: a day
            // already claimed stays silent by design, and without this the
            // user cannot tell a waiting timer from a missing one.
            ...nextRunAt === undefined ? {} : { nextRunAt },
          }
        },
      })
      registerQoderAuthRoute(webCtx, {
        path: runtime.variant.authPath,
        save: async pat => {
          // Validate against the region this variant owns *before* anything is
          // written: a token that cannot answer discovery is refused with a
          // stable code, and the file never holds a credential the plugin has
          // not seen work.
          if (!await validateApiKey(pat, runtime.variant.region)) {
            return { ok: false, error: 'qoder_invalid_pat' as const }
          }
          const credential = await runtime.store.save(pat)
          // Saving a token is the one transition the sweep would otherwise only
          // notice on its next tick; adopt it here so the model group appears
          // at once.
          const identity = credentialIdentity(credential)
          adoptIdentity(runtime, identity)
          // AWAIT the fetch: the card re-reads the status the moment this answer
          // lands, so returning first left it rendering the built-in roster
          // until the next poll or a manual refresh. `fetchCatalog` contains
          // its own failures (they surface as `catalog.error`), so a slow or
          // failing upstream can never turn a valid save into an error.
          await fetchCatalog(runtime, identity)
          return { ok: true, status: await runtime.store.status() }
        },
        clear: async () => {
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
          // Re-read the credential first: the user pressed this because the list
          // looks wrong, and a token saved since the last sweep is the common
          // cause. Re-registering is unnecessary — visibility is what changes,
          // and the sweep owns that.
          let credential
          try {
            credential = await runtime.store.current()
          } catch (error: unknown) {
            // A refused credential (wrong region, unreadable file) is a report,
            // not a crash out of the route.
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
          // Same transition the sweep performs: a switch reached through the
          // manual path must drop the previous account's data *now*, not when
          // the fetch lands, or a failed fetch leaves those models pickable.
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

    // The settings face the browser cards read and write through. It answers
    // the whole entry's configuration as three layers (value = effective,
    // base = schema defaults, user = the settings file), which is exactly the
    // shape the 0.1.7 configForm used to mirror — the client-side cards keep
    // their staged-edit form untouched.
    //
    // The key is minted per plugin lifetime and rides the GET response (that
    // response already passed the loopback guard, like the probe routes); the
    // POST authorizes with it. Both guards are re-checked here: these routes
    // spend nothing upstream but they do rewrite the user's configuration.
    registerQoderSettingsFace(webCtx, {
      store, config, current,
      apply: applyCatalogSettings,
      rearm: () => { runStartupCatchUpOnce(); checkInScheduler.rearm() },
    })
  })

  // Each settings section is what makes its namespace "served" — which is how
  // both the Plugins tab (card dispatch) and the Models settings page (provider
  // directory join) find this plugin's halves. One section per card, because the
  // tab renders a card by `entryKey = ns` and never interprets one: a section
  // that is not installed leaves its card registered but undispatched, and a
  // provider whose `settingsNs` names no section joins nothing.
  //
  // 两条宿主线共用一个写入口：插件自有文件（见 settings-store.ts）。
  //
  // 曾经这里按宿主形态分岔——0.1.5 用 `installSection` + `settings.update`
  // （watch 回调原地生效、毫秒级），0.1.7 用 `configEditor.edit`（每次写入都
  // reconcile 整棵 loader 树 + fiber 热重载，约 1~1.5 秒，并刷新所有客户端
  // 镜像）。现在两侧都不再向宿主编程配置：写落自有 JSON 文件，随后原地
  // apply（catalog 偏好、签到定时器重排、invalidate），0.1.5/0.1.7 行为一致。
  //
  // `configure({auto:false})` 保留：它只关掉宿主为这个 entry 自动生成的表单页
  // （本插件自带卡片），与持久化通路无关。
  ctx.inject(['settings'], settingsCtx => {
    /**
     * `auto: false` turns OFF the host's generated form page for this entry —
     * the plugin ships its own card, which is now the only editor. It must be
     * called as a METHOD: on 0.1.7 `configure` is a SettingsForms class method
     * (it reads `this.presentations`), and extracting it as a free function
     * throws a TypeError that used to kill the whole settings callback.
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
     * The four setters, now one implementation on both hosts: write the
     * plugin-owned settings file, then apply the new view in memory. No
     * profile-patch write means no tree reconcile, no fiber reload, and no
     * client-mirror storm per toggle.
     */
    const write = (patch: Record<string, unknown>): void => {
      // A card-originated write (every caller here is a user action on the
      // settings card), so the file becomes authoritative from this point on.
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
   * Fetch one variant's catalog for the current credential.
   *
   * Shared by the credential sweep and the card's manual refresh, and written
   * so that concurrent callers cost one request and cannot interleave badly:
   *
   * - **One request at a time.** A second caller joins the in-flight fetch
   *   instead of starting its own (spec §5: one catalog request per variant at
   *   a time).
   * - **Generation-checked write-back.** The request records the generation it
   *   started under and writes nothing if the generation moved on — which is
   *   what a slow answer from a superseded account must not do. Checking only
   *   the *identity* was not enough: two refreshes for the same account can
   *   still finish out of order, and the older one would win.
   * - **`resolve()`, not `current()`.** A catalog fetch demands a usable token;
   *   the difference from `current()` is that its absence surfaces as the same
   *   classified `MISSING_CREDENTIAL` failure every other request path reports,
   *   rather than as a silent "no credential" that would hide a bad file on
   *   disk behind an env override.
   */
  const fetchCatalog = async (runtime: VariantRuntime, identity: string): Promise<void> => {
    const inflight = runtime.inflightFetch
    const generation = runtime.catalogGeneration
    if (inflight !== undefined && inflight.identity === identity && inflight.generation === generation) {
      return inflight.promise
    }
    // A caller should normally reach this only after `adoptIdentity()` has
    // already cancelled a previous generation. Keep this guard local as well:
    // no stale request may prevent the current account from fetching now.
    inflight?.controller.abort()
    const controller = new AbortController()
    let run: Promise<void>
    run = (async (): Promise<void> => {
      let models: readonly QoderModelInfo[]
      try {
        // Establish the identity that owns this fetch from the file-backed
        // credential; discovery itself reads the token through the same store.
        const credential = await runtime.store.resolve()
        const resolvedIdentity = credentialIdentity(credential)
        if (resolvedIdentity !== identity) {
          adoptIdentity(runtime, resolvedIdentity)
          await fetchCatalog(runtime, resolvedIdentity)
          return
        }
        models = await runtime.client.fetchModels(controller.signal)
        // The token can also change while the upstream request is in flight.
        // Re-read before publishing so the just-finished roster still belongs
        // to the credential that is currently in effect.
        const latest = await runtime.store.current()
        const latestIdentity = latest === undefined ? undefined : credentialIdentity(latest)
        if (latestIdentity !== identity) {
          adoptIdentity(runtime, latestIdentity)
          if (latestIdentity !== undefined) await fetchCatalog(runtime, latestIdentity)
          return
        }
      } catch (error: unknown) {
        // Report only if this attempt is still the current one; a failure from
        // a superseded attempt must not overwrite the newer state's error.
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
      // Shared across fiber reloads: a 0.1.7 settings write re-applies this
      // plugin, and the new instance must not re-fetch what was just fetched.
      lastLiveFetchAt.set(identity, runtime.lastFetchAtMs)
      runtime.catalog.set([...models])
      runtime.catalogSource = 'live'
      runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now()
      runtime.catalogError = undefined
      // Remember it for this account, so a restart — or a later fetch that
      // fails — can serve what this account was actually shown rather than the
      // snapshot compiled into the plugin. A failure to persist is reported and
      // swallowed: the live catalog is already serving, and `fetchCatalog`
      // promises its callers that it never rejects (an escaped rejection from a
      // background sweep would terminate the host).
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
   * Reconcile one variant with its credentials.
   *
   * Four transitions matter, and each is a different action:
   *
   * - **none → some** (first sighting): reveal the group and fetch a catalog.
   * - **none → some, identity changed**: additionally drop the previous
   *   account's observations, so another token's probe answers cannot be read
   *   as the new one's.
   * - **some → none**: hide the group and stop serving its models.
   * - **same identity**: nothing to do — a PAT neither rotates nor expires, so
   *   re-fetching on every sweep would hit the catalog endpoint for no new
   *   information.
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
      // Same account, already showing something. One case still needs a fetch:
      // an earlier attempt failed, so the group is on the fallback roster and
      // nothing else will ever replace it. Retry on a slow backoff rather than
      // every sweep, so a persistent outage does not become a request loop.
      // Any non-live source is stale: both the saved catalog and the built-in
      // roster are worth replacing with a fresh fetch on the same backoff.
      //
      // The freshness read is per-IDENTITY and survives a fiber reload: a 0.1.7
      // settings write reloads this plugin, and the new instance's
      // `lastFetchAtMs` starts at 0 — without the shared record every write
      // would immediately re-fetch both variants from upstream.
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
   * Start both variants, then begin the credential sweep.
   *
   * The chain carries its own failure handler: without one, a rejection here
   * would be an unhandled rejection — which Node turns into process
   * termination, taking the whole Harness down over one plugin's startup.
   */
  detach(ctx, Promise.all(runtimes.map(async runtime => startVariant(ctx, runtime, async () => {
    // The immediate seed: adopt whatever credential is in effect right now, so
    // a reloaded fiber never serves an empty catalog while the sweep catches up.
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
    // The host bundle is live: write a heartbeat so the status CLI can report
    // host health without a browser. Cleared on disposal; a stale heartbeat
    // after a crash is detected by PID in the reader. Written when at least one
    // variant registered, since that is what "the host bundle serves models"
    // means for this plugin.
    if (runtimes.some(runtime => runtime.registered)) detach(ctx, writeHostHeartbeat(), 'host heartbeat write')

    detach(ctx, syncAll(), 'credential sweep')
    const timer = setInterval(() => { detach(ctx, syncAll(), 'credential sweep') }, credentialPollMs())
    timer.unref?.()
    timers.push(timer)
  }), 'variant startup')
}
