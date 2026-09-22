/** Qoder campaign inquiry and daily benefit check-in service. */

import type { QoderAuthService } from './auth.ts'
import {
  getQoderCampaignsUrl,
  getQoderClaimCampaignUrl,
  resolveQoderEndpoints,
  type QoderRegion,
} from './endpoints.ts'
import { isQoderAuthRejection, QoderLlmError } from '../errors.ts'
import type { QoderLogger } from './logging.ts'
import { openApiJsonRequest } from './request.ts'
import {
  qoderDesktopClientType,
  qoderDesktopUserAgent,
  qoderDesktopVersion,
} from './wire/cosy.ts'

export interface QoderCampaignBenefit {
  kind?: string
  amount?: number
  validity?: {
    mode?: string
    days?: number
  }
}

export interface QoderCampaign {
  campaignId: string
  campaignKey?: string
  actionType: string
  claimStatus: string
  startAt?: number
  endAt?: number
  benefit?: QoderCampaignBenefit
}

export interface QoderCampaignsResponse {
  uid?: string
  claimable?: boolean
  campaigns?: QoderCampaign[]
}

export interface QoderClaimResponse {
  status?: string
  replayed?: boolean
  benefit?: {
    kind?: string
    amount?: number
  }
  expiresAt?: string
}

export interface QoderCheckInResult {
  variantId: string
  date: string
  timestamp: number
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
  amount?: number | undefined
  campaignKey?: string | undefined
  message?: string | undefined
}

export interface QoderCheckInServiceOptions {
  authService: QoderAuthService
  fetch?: typeof fetch | undefined
  region?: QoderRegion | undefined
  variantId?: string | undefined
  logger?: QoderLogger | undefined
  timeoutMs?: number | undefined
}

const defaultCheckInTimeoutMs = 15_000

export class QoderCheckInService {
  private readonly authService: QoderAuthService
  private readonly fetchImpl: typeof fetch
  private readonly region: QoderRegion
  private readonly variantId: string
  private readonly logger: QoderLogger | undefined
  private readonly timeoutMs: number

  constructor(options: QoderCheckInServiceOptions) {
    this.authService = options.authService
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.region = options.region ?? 'china'
    this.variantId = options.variantId ?? 'qoder'
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? defaultCheckInTimeoutMs
  }

  async fetchCampaigns(token: string, signal?: AbortSignal): Promise<QoderCampaign[]> {
    const url = getQoderCampaignsUrl(this.region)
    const { openApiUrl } = resolveQoderEndpoints(this.region)
    const data = await openApiJsonRequest<QoderCampaignsResponse>(this.fetchImpl, {
      url,
      token,
      headers: {
        'cosy-clienttype': qoderDesktopClientType,
        'cosy-version': qoderDesktopVersion,
        'user-agent': qoderDesktopUserAgent,
        origin: openApiUrl,
      },
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Campaigns',
      logCategory: 'campaigns.list',
    })
    return Array.isArray(data?.campaigns) ? data.campaigns : []
  }

  async claimCampaign(token: string, campaignId: string, signal?: AbortSignal): Promise<QoderClaimResponse> {
    const url = getQoderClaimCampaignUrl(this.region, campaignId)
    const { openApiUrl } = resolveQoderEndpoints(this.region)
    return openApiJsonRequest<QoderClaimResponse>(this.fetchImpl, {
      url,
      method: 'POST',
      token,
      headers: {
        'cosy-clienttype': qoderDesktopClientType,
        'cosy-version': qoderDesktopVersion,
        'user-agent': qoderDesktopUserAgent,
        origin: openApiUrl,
      },
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'ClaimCampaign',
      logCategory: 'campaigns.claim',
    })
  }

  private getTodayDateString(): string {
    // Standardize date on UTC+8 (Beijing Time), which matches Qoder's 10:00 reset cycle
    const now = new Date()
    const utc8Time = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60_000)
    const y = utc8Time.getFullYear()
    const m = String(utc8Time.getMonth() + 1).padStart(2, '0')
    const d = String(utc8Time.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  async checkIn(pat: string, signal?: AbortSignal): Promise<QoderCheckInResult> {
    const today = this.getTodayDateString()
    const nowMs = Date.now()

    if (!pat || typeof pat !== 'string' || pat.trim() === '') {
      return {
        variantId: this.variantId,
        date: today,
        timestamp: nowMs,
        status: 'error',
        message: 'No PAT available',
      }
    }

    const executeWithToken = async (authToken: string): Promise<QoderCheckInResult> => {
      const campaigns = await this.fetchCampaigns(authToken, signal)
      // Look for daily benefit campaign (actionType === 'CLAIM_BENEFIT')
      const benefitCampaign = campaigns.find(c => c.actionType === 'CLAIM_BENEFIT')
      if (!benefitCampaign) {
        return {
          variantId: this.variantId,
          date: today,
          timestamp: nowMs,
          status: 'no-campaign',
          message: 'No claimable benefit campaign found for this region',
        }
      }

      if (benefitCampaign.claimStatus === 'CLAIMED') {
        return {
          variantId: this.variantId,
          date: today,
          timestamp: nowMs,
          status: 'already-claimed',
          campaignKey: benefitCampaign.campaignKey,
          amount: benefitCampaign.benefit?.amount ?? 100,
          message: 'Already claimed today',
        }
      }

      // Claim it
      const claimResult = await this.claimCampaign(authToken, benefitCampaign.campaignId, signal)
      const isClaimed = claimResult.status === 'CLAIMED'
      const replayed = Boolean(claimResult.replayed)
      const amount = claimResult.benefit?.amount ?? benefitCampaign.benefit?.amount ?? 100

      if (isClaimed) {
        return {
          variantId: this.variantId,
          date: today,
          timestamp: nowMs,
          status: replayed ? 'already-claimed' : 'claimed',
          amount,
          campaignKey: benefitCampaign.campaignKey,
          message: replayed ? 'Already claimed today' : `Successfully claimed ${amount} credits`,
        }
      }

      return {
        variantId: this.variantId,
        date: today,
        timestamp: nowMs,
        status: 'error',
        campaignKey: benefitCampaign.campaignKey,
        message: `Claim returned status ${claimResult.status ?? 'unknown'}`,
      }
    }

    try {
      const creds = await this.authService.getCredentials(pat, signal)
      try {
        return await executeWithToken(creds.authToken)
      } catch (innerError) {
        // If 401 token rejection, attempt one fresh token rotation and retry
        if (isQoderAuthRejection(innerError)) {
          this.logger?.warn?.(`[Qoder CheckIn] Auth token rejected, retrying with fresh exchange`)
          const freshCreds = await this.authService.exchangeFresh(pat, signal)
          return await executeWithToken(freshCreds.authToken)
        }
        throw innerError
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.error?.(`[Qoder CheckIn] Check-in failed: ${message}`)
      return {
        variantId: this.variantId,
        date: today,
        timestamp: nowMs,
        status: 'error',
        message,
      }
    }
  }
}
