/** Browser-safe Qoder subscriber account and quota types. */

export interface QoderSubscriberProfile {
  id: string
  name: string
  email: string
}

export interface QoderQuota {
  total: number
  used: number
  remaining: number
  percentage: number
  unit: string
  /**
   * Where the upstream itself itemizes this bucket — the account's usage page.
   *
   * `addOnQuota` carries one (`https://qoder.com/account/usage` on the
   * international edition, `…/…com.cn/…` on the Chinese one), and it is the
   * ONLY place the per-package breakdown lives: the web page lists the bonus
   * credits as several grants, each with its own expiry, while this endpoint
   * answers a single summed bucket. So the URL is the honest answer to "when
   * does this expire" — the card cannot compute what the API never reports,
   * and the breakdown needs the browser's session cookie, which a PAT cannot
   * authorize.
   */
  detailUrl?: string | undefined
}

/**
 * A named grant of credits that expires on its own schedule.
 *
 * The international upstream reports these in `dedicatedResourcePackages`: one
 * entry per campaign package (the SOTA exclusive credits, for one). Every
 * bucket the reader already knows (`userQuota`, `orgResourcePackage`,
 * `addOnQuota`) shares the single cycle-level `expiresAt`, whereas a dedicated
 * package carries its OWN `expiresAt` and its own localized title — so it is
 * its own shape, not just another `QoderQuota`.
 */
export interface QoderDedicatedResourcePackage extends QoderQuota {
  /** Upstream package id (`01a1426f-…`), when reported. */
  id?: string | undefined
  /** Raw upstream name — usually an opaque campaign code, not display copy. */
  name?: string | undefined
  /** Localized display title from `displayLabels`, when the upstream sends one. */
  title?: { zh?: string | undefined; en?: string | undefined } | undefined
  /**
   * This package's own expiry, ISO. Deliberately NOT the account's cycle-level
   * `expiresAt`: a campaign grant ends when the grant ends, and reporting the
   * account's (sentinel `9999`) date against it is what made the card's dates
   * wrong.
   */
  expiresAt?: string | undefined
  /** Whether the upstream says the package is currently usable. */
  available?: boolean | undefined
  /** Upstream lifecycle marker (`QUOTA_DETAIL_STATUS_ACTIVE`). */
  status?: string | undefined
}

export interface QoderQuotaUsage {
  userQuota?: QoderQuota | undefined
  orgResourcePackage?: QoderQuota | undefined
  /**
   * Credits granted on top of the plan — the daily campaign's 100, for one.
   *
   * A separate bucket upstream reports beside `userQuota`; it carries its own
   * total and remaining, so leaving it out made the card show fewer packages
   * than the account actually holds (two on the web, one here).
   */
  addOnQuota?: QoderQuota | undefined
  /**
   * Campaign grants with their own expiry and display title (the international
   * edition's SOTA exclusive credits land here).
   *
   * Dropping this array hid a whole 2,000-credit package from the card: the
   * reader mapped only the three named buckets above, so the credit was real
   * and simply never rendered.
   */
  dedicatedResourcePackages?: readonly QoderDedicatedResourcePackage[] | undefined
  totalUsagePercentage?: number | undefined
  isQuotaExceeded?: boolean | undefined
  expiresAt?: string | undefined
  raw?: unknown
}

export interface QoderSubscriberOrganization {
  orgId: string
  orgName: string
  roleName?: string | undefined
  isSuspended?: boolean
  canManageSubscriptions?: boolean
  resourcePackageFeatureEnabled?: boolean
}

export interface QoderSubscriberFeatureAllowed {
  quest?: boolean
  wiki?: boolean
  codeReview?: boolean
}

export interface QoderSubscriberPlan {
  userType: string
  planTierName: string
  planTier?: string
  isPersonalVersion: boolean
  isHighestTier?: boolean
  isRenewed?: boolean
  startDate?: string
  endDate?: string
  organization?: QoderSubscriberOrganization
  featureAllowed?: QoderSubscriberFeatureAllowed
  raw?: unknown
}

export interface QoderSubscriberStatus {
  allowByok: number
  teamAllowByok?: number
  isPrivacyPolicyModifiable?: boolean
  raw?: unknown
}

export interface QoderAccountInfo {
  profile: QoderSubscriberProfile
  usage?: QoderQuotaUsage
  plan?: QoderSubscriberPlan
  status?: QoderSubscriberStatus
  updatedAt: string
}
