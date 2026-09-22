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
}

export interface QoderQuotaUsage {
  userQuota?: QoderQuota | undefined
  addOnQuota?: QoderQuota | undefined
  orgResourcePackage?: QoderQuota | undefined
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
