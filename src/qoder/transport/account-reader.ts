/** Qoder subscriber profile and quota usage querying. */

import type { QoderAuthService } from './auth.ts'
import {
  getQoderUsageUrl,
  getQoderUserPlanUrl,
  getQoderUserStatusUrl,
  type QoderRegion,
} from './endpoints.ts'
import type {
  QoderAccountInfo,
  QoderDedicatedResourcePackage,
  QoderQuota,
  QoderQuotaUsage,
  QoderSubscriberFeatureAllowed,
  QoderSubscriberOrganization,
  QoderSubscriberPlan,
  QoderSubscriberProfile,
  QoderSubscriberStatus,
} from '../account.ts'
import { QoderLlmError, isQoderAuthRejection } from '../errors.ts'
import type { QoderLogger } from './logging.ts'
import {
  opaqueCredentialKey,
  openApiJsonRequest,
  retryMetadataRead,
  SingleFlight,
} from './request.ts'

const defaultUsageTtlMs = 60_000
const defaultUsageTimeoutMs = 15_000

export interface QoderUsageReaderOptions {
  authService: QoderAuthService
  fetch?: typeof fetch | undefined
  ttlMs?: number | undefined
  timeoutMs?: number | undefined
  region?: QoderRegion | undefined
  logger?: QoderLogger | undefined
}


interface RawQuota {
  total?: number
  cap?: number
  used?: number
  remaining?: number
  percentage?: number
  unit?: string
  available?: boolean
  /** The upstream's own link to the itemized usage page for this bucket. */
  detailUrl?: string
}

interface RawUsageInfo {
  userQuota?: RawQuota
  orgResourcePackage?: RawQuota
  /** Bonus credits granted beside the plan (the daily campaign's 100). */
  addOnQuota?: RawQuota
  /**
   * Campaign grants that carry their own total, expiry, and localized title
   * (the international edition's SOTA exclusive credits arrive here).
   */
  dedicatedResourcePackages?: RawDedicatedPackage[]
  totalUsagePercentage?: number
  isQuotaExceeded?: boolean
  expiresAt?: number | string
  userType?: string
  upgradeUrl?: string
}

/** One `dedicatedResourcePackages` entry as the upstream spells it. */
interface RawDedicatedPackage extends RawQuota {
  id?: string
  name?: string
  description?: string
  expiresAt?: number | string
  status?: string
  displayLabels?: { dimension?: string; value?: string; valueI18n?: Record<string, string> }[]
}

function normalizeQuota(raw?: RawQuota): QoderQuota | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const total = typeof raw.total === 'number' && Number.isFinite(raw.total)
    ? raw.total
    : (typeof raw.cap === 'number' && Number.isFinite(raw.cap)
      ? raw.cap
      : (typeof raw.remaining === 'number' && typeof raw.used === 'number'
        ? raw.used + raw.remaining
        : 0))
  const used = typeof raw.used === 'number' && Number.isFinite(raw.used) ? raw.used : 0
  const remaining = typeof raw.remaining === 'number' && Number.isFinite(raw.remaining)
    ? raw.remaining
    : Math.max(0, total - used)

  let percentage: number
  if (typeof raw.percentage === 'number' && Number.isFinite(raw.percentage)) {
    percentage = raw.percentage <= 1 && total > 1 ? raw.percentage * 100 : raw.percentage
  } else {
    percentage = total > 0 ? (used / total) * 100 : 0
  }

  const unit = typeof raw.unit === 'string' && raw.unit.length > 0 ? raw.unit : 'credits'
  // The itemized page the upstream links for this bucket. Carried through
  // because it is the only honest answer to "when does this expire": the web
  // page breaks the bonus credits into several grants with per-grant expiries,
  // while this endpoint sums them into one number and reports no date at all.
  const detailUrl = asString(raw.detailUrl)

  return {
    total,
    used,
    remaining,
    percentage,
    unit,
    ...detailUrl === undefined ? {} : { detailUrl },
  }
}


function normalizeExpiresAt(rawExpires?: number | string): string | undefined {
  if (rawExpires === undefined || rawExpires === null) return undefined
  if (typeof rawExpires === 'number' && rawExpires > 0) {
    return toExpiryIso(rawExpires)
  }
  if (typeof rawExpires === 'string' && rawExpires.length > 0) {
    const parsed = Date.parse(rawExpires)
    if (!Number.isNaN(parsed) && parsed > 0) return toExpiryIso(parsed)
  }
  return undefined
}

/**
 * The year at which Qoder stops meaning a date and starts meaning "never".
 *
 * The upstream encodes an uncapped allowance as the year-9999 sentinel
 * `253402214400000`, which is a valid timestamp and a real date to any parser.
 * Rendering it as the account's expiry told the user the quota resets in the
 * year 10000, so the sentinel must be read as the absence of an expiry.
 */
const NEVER_EXPIRY_YEAR = 9999

/** ISO instant for a parsed expiry, or undefined for the "never" sentinel. */
function toExpiryIso(atMs: number): string | undefined {
  return new Date(atMs).getUTCFullYear() >= NEVER_EXPIRY_YEAR ? undefined : new Date(atMs).toISOString()
}

/** Localized `displayLabels` values, keyed by bare language (`zh` / `en`). */
function labelI18n(raw: Record<string, string> | undefined): { zh?: string; en?: string } {
  const out: { zh?: string; en?: string } = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    const text = asString(value)
    if (text === undefined) continue
    const language = key.slice(0, 2).toLowerCase()
    if (language === 'zh') out.zh = text
    else if (language === 'en') out.en = text
  }
  return out
}

/**
 * One campaign grant, including the title the upstream localized for it.
 *
 * `name` is an opaque code (`act-20261014-129`) — the human copy lives in
 * `displayLabels` under `dimension: 'title'`, so that is what the row is
 * labelled with and the code is kept only as provenance.
 */
function normalizeDedicatedPackage(raw: RawDedicatedPackage): QoderDedicatedResourcePackage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const quota = normalizeQuota(raw)
  if (quota === undefined) return undefined
  const labels = Array.isArray(raw.displayLabels) ? raw.displayLabels : []
  const title = labels.find(label => label?.dimension === 'title')
  const id = asString(raw.id)
  const name = asString(raw.name)
  const status = asString(raw.status)
  const expiresAt = normalizeExpiresAt(raw.expiresAt)
  return {
    ...quota,
    ...id === undefined ? {} : { id },
    ...name === undefined ? {} : { name },
    ...title === undefined ? {} : (() => {
      const parsed = labelI18n(title.valueI18n)
      // A label whose i18n map is empty still has the plain `value` the
      // upstream sent; fall back to it rather than losing the name entirely.
      const fallback = asString(title.value)
      if (parsed.zh === undefined && parsed.en === undefined && fallback === undefined) return {}
      return {
        title: {
          ...parsed.zh !== undefined ? { zh: parsed.zh } : (fallback !== undefined ? { zh: fallback } : {}),
          ...parsed.en !== undefined ? { en: parsed.en } : (fallback !== undefined ? { en: fallback } : {}),
        },
      }
    })(),
    ...expiresAt === undefined ? {} : { expiresAt },
    ...typeof raw.available === 'boolean' ? { available: raw.available } : {},
    ...status === undefined ? {} : { status },
  }
}

function normalizeDedicatedPackages(raw: RawDedicatedPackage[] | undefined): QoderDedicatedResourcePackage[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const packages = raw
    .map(entry => normalizeDedicatedPackage(entry))
    .filter((entry): entry is QoderDedicatedResourcePackage => entry !== undefined)
  return packages.length > 0 ? packages : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number(value)
    if (Number.isFinite(num)) return num
  }
  return undefined
}

function normalizeOrganization(raw: unknown): QoderSubscriberOrganization | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const orgId = asString(obj.org_id) ?? asString(obj.orgId) ?? asString(obj.id)
  const orgName = asString(obj.org_name) ?? asString(obj.orgName) ?? asString(obj.name)
  if (!orgId || !orgName) return undefined
  return {
    orgId,
    orgName,
    ...asString(obj.role_name) ?? asString(obj.roleName) !== undefined
      ? { roleName: asString(obj.role_name) ?? asString(obj.roleName) }
      : {},
    isSuspended: asBoolean(obj.is_suspended) ?? asBoolean(obj.isSuspended) ?? false,
    canManageSubscriptions: asBoolean(obj.can_manage_subscriptions) ?? asBoolean(obj.canManageSubscriptions) ?? false,
    resourcePackageFeatureEnabled: asBoolean(obj.resource_package_feature_enabled) ?? asBoolean(obj.resourcePackageFeatureEnabled) ?? false,
  }
}

function normalizeFeatureAllowed(raw: unknown): QoderSubscriberFeatureAllowed | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  return {
    quest: asBoolean(obj.quest) ?? false,
    wiki: asBoolean(obj.wiki) ?? false,
    codeReview: asBoolean(obj.code_review) ?? asBoolean(obj.codeReview) ?? false,
  }
}

function normalizePlan(raw: unknown): QoderSubscriberPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const userType = asString(obj.user_type) ?? asString(obj.userType)
  const planTierName = asString(obj.plan_tier_name) ?? asString(obj.planTierName) ?? asString(obj.plan_name) ?? asString(obj.planName)
  if (!userType || !planTierName) return undefined

  const organization = normalizeOrganization(obj.organization)
  const isPersonalVersion = asBoolean(obj.is_personal_version) ?? asBoolean(obj.isPersonalVersion) ?? (organization === undefined)
  const startDate = normalizeExpiresAt(obj.start_date as number | string ?? obj.startDate as number | string)
  const endDate = normalizeExpiresAt(obj.end_date as number | string ?? obj.endDate as number | string)
  const planTier = asString(obj.plan_tier) ?? asString(obj.planTier)
  const isHighestTier = asBoolean(obj.is_highest_tier) ?? asBoolean(obj.isHighestTier)
  const isRenewed = asBoolean(obj.is_renewed) ?? asBoolean(obj.isRenewed)
  const featureAllowed = normalizeFeatureAllowed(obj.feature_allowed ?? obj.featureAllowed)

  return {
    userType,
    planTierName,
    ...planTier !== undefined ? { planTier } : {},
    isPersonalVersion,
    ...isHighestTier !== undefined ? { isHighestTier } : {},
    ...isRenewed !== undefined ? { isRenewed } : {},
    ...startDate !== undefined ? { startDate } : {},
    ...endDate !== undefined ? { endDate } : {},
    ...organization !== undefined ? { organization } : {},
    ...featureAllowed !== undefined ? { featureAllowed } : {},
    raw,
  }
}

function normalizeStatus(raw: unknown): QoderSubscriberStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const featureSwitches = (obj.featureSwitches ?? obj.feature_switches) as Record<string, unknown> | undefined
  const teamSwitches = (obj.teamSwitches ?? obj.team_switches) as Record<string, unknown> | undefined
  const allowByok = asNumber(featureSwitches?.allow_byok ?? featureSwitches?.allowByok) ?? 0
  const teamAllowByok = asNumber(teamSwitches?.allow_byok ?? teamSwitches?.allowByok)
  const isPrivacyPolicyModifiable = asBoolean(obj.isPrivacyPolicyModifiable ?? obj.is_data_policy_modifiable)

  return {
    allowByok,
    ...teamAllowByok !== undefined ? { teamAllowByok } : {},
    ...isPrivacyPolicyModifiable !== undefined ? { isPrivacyPolicyModifiable } : {},
    raw,
  }
}

export class QoderUsageReader {
  private readonly authService: QoderAuthService
  private readonly fetchImpl: typeof fetch
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly region: QoderRegion
  private readonly logger: QoderLogger | undefined
  private readonly cache = new Map<string, { info: QoderAccountInfo; expiresAt: number }>()
  private readonly flights = new SingleFlight<QoderAccountInfo>()

  constructor(options: QoderUsageReaderOptions) {
    this.authService = options.authService
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.ttlMs = options.ttlMs ?? defaultUsageTtlMs
    this.timeoutMs = options.timeoutMs ?? defaultUsageTimeoutMs
    this.region = options.region ?? 'global'
    this.logger = options.logger
  }

  async readAccount(
    pat: string,
    options?: { force?: boolean | undefined; signal?: AbortSignal | undefined },
  ): Promise<QoderAccountInfo> {
    if (!pat || typeof pat !== 'string') {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing or invalid.',
        'MISSING_CREDENTIAL',
      )
    }

    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`

    if (!options?.force) {
      const cached = this.cache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) {
        return cached.info
      }
    }

    return this.flights.run(
      cacheKey,
      options?.signal,
      sharedSignal => this.loadAccount(pat, sharedSignal, cacheKey),
      () => new QoderLlmError('Qoder account request was aborted.', 'ABORTED'),
    )
  }

  private async loadAccount(
    pat: string,
    signal: AbortSignal,
    cacheKey: string,
  ): Promise<QoderAccountInfo> {
    try {
      return await this.loadAccountWith(pat, signal, cacheKey)
    } catch (error) {
      // The cached job token can outlive the upstream's acceptance of it; one
      // fresh exchange self-heals that window instead of surfacing the card's
      // quota read as an auth failure until the next credential save.
      if (!isQoderAuthRejection(error) || signal.aborted) throw error
      this.logger?.warn?.('[Qoder Account] Usage read rejected as unauthorized; exchanging a fresh job token and retrying once')
    }
    this.authService.clear(pat)
    return this.loadAccountWith(pat, signal, cacheKey)
  }

  private async loadAccountWith(
    pat: string,
    signal: AbortSignal,
    cacheKey: string,
  ): Promise<QoderAccountInfo> {
    const creds = await this.authService.getCredentials(pat, signal)
    const profile: QoderSubscriberProfile = {
      id: creds.userID,
      name: creds.name || 'Qoder User',
      email: creds.email || '',
    }

    const [usage, plan, status] = await Promise.all([
      retryMetadataRead(signal, () => this.fetchUsage(creds.authToken, signal)),
      this.safeFetchPlan(creds.authToken, signal),
      this.safeFetchStatus(creds.authToken, creds.machineID, signal),
    ])

    const accountInfo: QoderAccountInfo = {
      profile,
      usage,
      ...plan !== undefined ? { plan } : {},
      ...status !== undefined ? { status } : {},
      updatedAt: new Date().toISOString(),
    }

    this.cache.set(cacheKey, {
      info: accountInfo,
      expiresAt: Date.now() + this.ttlMs,
    })

    return accountInfo
  }

  clear(pat?: string): void {
    if (pat) {
      this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`)
    } else {
      this.cache.clear()
    }
  }

  private async fetchUsage(jobToken: string, signal?: AbortSignal): Promise<QoderQuotaUsage> {
    const data = await openApiJsonRequest<RawUsageInfo>(this.fetchImpl, {
      url: getQoderUsageUrl(this.region),
      token: jobToken,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Usage',
      logCategory: 'account.usage',
    })

    return {
      userQuota: normalizeQuota(data.userQuota),
      orgResourcePackage: normalizeQuota(data.orgResourcePackage),
      addOnQuota: normalizeQuota(data.addOnQuota),
      ...(() => {
        const packages = normalizeDedicatedPackages(data.dedicatedResourcePackages)
        return packages === undefined ? {} : { dedicatedResourcePackages: packages }
      })(),
      totalUsagePercentage: typeof data.totalUsagePercentage === 'number' ? data.totalUsagePercentage : undefined,
      isQuotaExceeded: typeof data.isQuotaExceeded === 'boolean' ? data.isQuotaExceeded : false,
      expiresAt: normalizeExpiresAt(data.expiresAt),
      raw: data,
    }
  }

  private async fetchPlan(jobToken: string, signal?: AbortSignal): Promise<QoderSubscriberPlan | undefined> {
    const data = await openApiJsonRequest<unknown>(this.fetchImpl, {
      url: getQoderUserPlanUrl(this.region),
      token: jobToken,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Plan',
      logCategory: 'account.plan',
    })
    return normalizePlan(data)
  }

  private async safeFetchPlan(jobToken: string, signal: AbortSignal): Promise<QoderSubscriberPlan | undefined> {
    try {
      return await this.fetchPlan(jobToken, signal)
    } catch (error) {
      if (signal.aborted) throw error
      this.logger?.warn?.('[Qoder Plan] Failed to load user plan (degraded)', error instanceof Error ? error.message : error)
      return undefined
    }
  }

  private async fetchStatus(
    jobToken: string,
    machineId?: string,
    signal?: AbortSignal,
  ): Promise<QoderSubscriberStatus | undefined> {
    const data = await openApiJsonRequest<unknown>(this.fetchImpl, {
      url: getQoderUserStatusUrl(this.region),
      token: jobToken,
      machineId,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Status',
      logCategory: 'account.status',
    })
    return normalizeStatus(data)
  }

  private async safeFetchStatus(
    jobToken: string,
    machineId?: string,
    signal?: AbortSignal,
  ): Promise<QoderSubscriberStatus | undefined> {
    try {
      return await this.fetchStatus(jobToken, machineId, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      this.logger?.warn?.('[Qoder Status] Failed to load user status (degraded)', error instanceof Error ? error.message : error)
      return undefined
    }
  }
}
