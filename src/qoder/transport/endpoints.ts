/** Qoder transport endpoints for Global and China service regions. */

import type { QoderRegion } from '../region.ts'

export type { QoderRegion } from '../region.ts'

export interface QoderRegionEndpoints {
  baseUrl: string
  openApiUrl: string
  /** Center service that owns durable image objects for multimodal input. */
  centerUrl: string
}

export const qoderRegionEndpoints: Record<QoderRegion, QoderRegionEndpoints> = {
  global: {
    // The official client's primary prod-global inference domain; api3 is the
    // fallback host it resolves to when api2 is unreachable.
    baseUrl: 'https://api2.qoder.sh/',
    openApiUrl: 'https://openapi.qoder.sh',
    centerUrl: 'https://center.qoder.sh',
  },
  china: {
    baseUrl: 'https://gateway.qoder.com.cn/',
    openApiUrl: 'https://openapi.qoder.com.cn',
    centerUrl: 'https://gateway.qoder.com.cn',
  },
}

/** Signed path of the center image upload route; it never carries an `/algo` prefix. */
export const qoderImageUploadPath = '/api/v2/image/upload'

export const qoderGlobalBaseUrl = qoderRegionEndpoints.global.baseUrl
export const qoderGlobalOpenApiUrl = qoderRegionEndpoints.global.openApiUrl

export function resolveQoderEndpoints(region: QoderRegion = 'global'): QoderRegionEndpoints {
  return qoderRegionEndpoints[region] ?? qoderRegionEndpoints.global
}

export function getQoderChatUrl(region: QoderRegion = 'global'): string {
  const { baseUrl } = resolveQoderEndpoints(region)
  return `${baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
}

export function getQoderModelListUrl(region: QoderRegion = 'global'): string {
  const { baseUrl } = resolveQoderEndpoints(region)
  return `${baseUrl}algo/api/v2/model/list?Encode=1`
}

export function getQoderImageUploadUrl(region: QoderRegion = 'global', requestId?: string): string {
  const { centerUrl } = resolveQoderEndpoints(region)
  // qodercli's WASM prepareRequest adds /algo to the HTTP URL, but not the signature path.
  const base = `${centerUrl.replace(/\/+$/u, '')}/algo${qoderImageUploadPath}`
  return requestId === undefined ? base : `${base}?request_id=${encodeURIComponent(requestId)}`
}

export function getQoderExchangeUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v1/jobToken/exchange`
}

export function getQoderUserInfoUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v1/userinfo`
}

export function getQoderUsageUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v2/quota/usage`
}

export function getQoderUserPlanUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v2/user/plan`
}

export function getQoderUserStatusUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v3/user/status`
}

/** Pending model-queue entry for one request; not published API, so callers must fall back. */
export function getQoderQueueStatusUrl(
  region: QoderRegion = 'global',
  params: { requestSetId: string, modelKey: string, queueType?: string | undefined },
): string {
  const { baseUrl } = resolveQoderEndpoints(region)
  const query = new URLSearchParams({ requestSetId: params.requestSetId, modelKey: params.modelKey })
  if (params.queueType !== undefined) query.set('queueType', params.queueType)
  return `${baseUrl}algo/api/v2/service/ask/queue/status?${query.toString()}`
}

/** Path of the center web search route. */
export const qoderWebSearchPath = '/api/v1/webSearch/oneSearch'

export function getQoderWebSearchUrl(region: QoderRegion = 'global'): string {
  const { centerUrl } = resolveQoderEndpoints(region)
  return `${centerUrl.replace(/\/+$/u, '')}/algo${qoderWebSearchPath}?Encode=1`
}

export function getQoderCampaignsUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/sash/api/v1/me/campaigns`
}

export function getQoderClaimCampaignUrl(region: QoderRegion = 'global', campaignId: string): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`
}

