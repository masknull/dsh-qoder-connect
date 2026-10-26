/**
 * Same-origin status route for the Qoder plugin cards: credential state,
 * quota, catalog provenance, and probe observations, fetched by the browser
 * half. The route answers loopback browser requests only and never carries
 * token material — the PAT summary is redacted at the store, not here.
 *
 * @module dsh-qoder-connect/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { QoderCredentialStore } from './auth.ts'
import type { QoderUpstreamClient } from './upstream.ts'
import { normalizeCredits } from './upstream.ts'
import type { QoderModelInfo } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { QODER_STATUS_PATH } from './status-paths.ts'
import type { QoderCatalogModelSnapshot, QoderWebCatalog, QoderWebProbeSection, QoderWebStatus } from './status-paths.ts'

export { QODER_STATUS_PATH } from './status-paths.ts'
export type { QoderWebStatus } from './status-paths.ts'

/** Constructor dependencies. */
export interface QoderStatusRouteOptions {
  store: QoderCredentialStore
  client: Pick<QoderUpstreamClient, 'fetchCredits'>
  /** Resolve the current model catalog for rate, effort, and capacity display. */
  models: () => readonly QoderModelInfo[]
  /**
   * Compact probe state for the card. Optional so the status route keeps
   * working on its own in tests and headless profiles.
   */
  probe?: () => QoderWebProbeSection
  /**
   * Origin of the currently served model list. Optional so the status route
   * keeps working without one in tests and headless profiles.
   */
  catalog?: () => QoderWebCatalog | undefined
  /** In-process key authorizing probe control writes. */
  probeKey?: string
  /**
   * In-process key authorizing PAT writes, including clearing. Minted separately
   * from {@link QoderStatusRouteOptions.probeKey}: the two authorize different
   * powers, and a signed-out card needs only this one.
   */
  authKey?: string
  /** Card preference selecting larger declared context windows. */
  useMaximumContextWindow?: () => boolean
  /** Disabled models query for this variant. */
  disabledModels?: () => readonly string[]
  /**
   * When the self-heal last auto-refreshed the job token, epoch ms; absent when it
   * has not happened in this process.
   */
  jobTokenRefreshedAt?: () => number | undefined
  /** Check-in record query for this variant. */
  checkIn?: () => {
    lastDate: string
    lastAt: number
    status: 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error'
    amount?: number | undefined
    message?: string | undefined
    nextRunAt?: number | undefined
    logs?: readonly {
      id: string
      date: string
      timestamp: number
      status: 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error'
      amount?: number | undefined
      campaignKey?: string | undefined
      message?: string | undefined
    }[] | undefined
  } | undefined
  /**
   * Route path to mount. Defaults to the China variant's path; the global variant
   * passes its own.
   */
  path?: string
  /**
   * Why the load-time peer check was skipped, when it was. Rides the document so
   * the card declares the blind spot; absent when the check ran.
   */
  peerCheckSkipped?: () => string | undefined
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * The request must be addressed to the loopback interface, and a browser-attached
 * Origin must be loopback too. The Host check drops DNS-rebinding pages; the card's
 * same-origin fetches carry no Origin and pass on Host alone.
 */
function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/** The `x<n>` rate label back into the number the snapshot carries, when honest. */
function priceFactorOf(info: QoderModelInfo): number | undefined {
  if (info.billing.rateUnknown === true) return undefined
  const rate = normalizeCredits(info.billing.credits)
  if (rate === undefined) return undefined
  const match = /^x([0-9]+(?:\.[0-9]+)?)$/u.exec(rate)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/** One catalog row as the status document snapshots it. */
function modelSnapshot(model: QoderModelInfo): QoderCatalogModelSnapshot {
  const supported = model.supportedContextWindows ?? []
  const maxContextWindow = supported.length > 0 ? Math.max(...supported) : undefined
  const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow
  const priceFactor = priceFactorOf(model)
  return {
    id: model.id,
    name: model.name,
    ...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
    ...defaultContextWindow > 0 && defaultContextWindow < model.contextWindow ? { defaultContextWindow } : {},
    ...maxContextWindow === undefined || maxContextWindow <= defaultContextWindow
      ? {}
      : { supportedContextWindows: supported },
    ...model.reasoning?.supports === true ? { isReasoning: true as const } : {},
    ...model.reasoning?.supportedEfforts !== undefined && model.reasoning.supportedEfforts.length > 0
      ? { reasoningEfforts: model.reasoning.supportedEfforts }
      : {},
    ...model.reasoning?.defaultEffort === undefined ? {} : { defaultReasoningEffort: model.reasoning.defaultEffort },
    ...priceFactor === undefined ? {} : { priceFactor },
    supportsImages: model.supportsImages,
    ...model.source === undefined ? {} : { source: model.source },
  }
}

/**
 * Assemble the card's status document. Credit is a live billing answer whose
 * failure degrades to `creditsError` rather than failing the whole document.
 */
export async function qoderWebStatus(deps: QoderStatusRouteOptions): Promise<QoderWebStatus> {
  const authStatus = await deps.store.status()
  // Read once: both arms declare it, and the card shows it above everything else.
  const peerSkipped = deps.peerCheckSkipped?.()
  if (authStatus.state !== 'configured') {
    // A diagnosable sign-out keeps its explanation: the generic hint would tell the
    // user to sign in when the real fix is to replace a file. The PAT key rides
    // along so this card can offer the action that resolves the state.
    return {
      status: 'signed-out',
      ...authStatus.reason === undefined ? {} : { reason: authStatus.reason },
      ...deps.authKey === undefined ? {} : { authKey: deps.authKey },
      ...peerSkipped === undefined ? {} : { peerCheckSkipped: peerSkipped },
    }
  }
  const status: QoderWebStatus = {
    status: 'signed-in',
    ...authStatus.region === undefined ? {} : { region: authStatus.region },
    ...authStatus.pat === undefined ? {} : { pat: authStatus.pat },
    // The saved-token list rides the same document: the card's account select is
    // built from it, and it is redacted at the store. An environment-only sign-in
    // has no list.
    ...authStatus.profiles === undefined ? {} : { patProfiles: authStatus.profiles },
    ...authStatus.activeId === undefined ? {} : { activePatId: authStatus.activeId },
    // Both arms carry the key: a signed-in card needs it to clear the token.
    ...deps.authKey === undefined ? {} : { authKey: deps.authKey },
    ...peerSkipped === undefined ? {} : { peerCheckSkipped: peerSkipped },
  }
  // Model facts ride the signed-in document so the card can show rates, efforts,
  // and context capacity without touching the Models picker. They are normalized
  // here so both halves agree on one display form. Every model is sent, since
  // context capacity matters before picking one.
  const models = deps.models()
  const modelsField: readonly QoderCatalogModelSnapshot[] = models.map(modelSnapshot)
  // Catalog provenance rides the document even when the model list is empty: "no
  // models" is precisely the case a user needs explained.
  const catalog = deps.catalog?.()
  const withCatalog: QoderWebStatus = catalog === undefined ? status : { ...status, catalog }
  const statusWithModels: QoderWebStatus = modelsField.length > 0
    ? { ...withCatalog, models: modelsField }
    : withCatalog
  // Probe state rides the signed-in document so the card renders consent and results
  // without a second request. The control key authorizes probe control only, never
  // credentials or completions.
  const probed: QoderWebStatus = deps.probe === undefined
    ? statusWithModels
    : {
      ...statusWithModels,
      probe: deps.probe(),
      ...deps.probeKey === undefined ? {} : { probeKey: deps.probeKey },
      ...deps.useMaximumContextWindow === undefined ? {} : { useMaximumContextWindow: deps.useMaximumContextWindow() },
      ...deps.disabledModels === undefined ? {} : { disabledModels: deps.disabledModels() },
    }
  const refreshedAt = deps.jobTokenRefreshedAt?.()
  const withRefreshNotice: QoderWebStatus = refreshedAt === undefined
    ? probed
    : { ...probed, jobTokenRefreshedAt: refreshedAt }
  const checkInRecord = deps.checkIn?.()
  const withCheckIn: QoderWebStatus = checkInRecord === undefined
    ? withRefreshNotice
    : { ...withRefreshNotice, checkIn: checkInRecord }
  try {
    const credits = await deps.client.fetchCredits()
    // `unlimited` and `cycleResetTime` ride along as-is: "no cap" is its own state,
    // and the fetch only sets them when the upstream reported them.
    return { ...withCheckIn, credits }
  } catch (error: unknown) {
    return { ...withCheckIn, creditsError: safeMessage(error) }
  }
}

/** The status route's request handler, extracted so tests can mount it on a bare server. */
export function qoderStatusHandler(
  deps: QoderStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await qoderWebStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** Mount the GET status route on an optional webServer context. */
export function registerQoderStatusRoute(ctx: Context, deps: QoderStatusRouteOptions): void {
  const path = deps.path ?? QODER_STATUS_PATH
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: qoderStatusHandler(deps),
    })
    return () => {
      dispose()
    }
  }, 'dsh-qoder-connect: Web status route')
}

/**
 * Mount the status route of a plugin that refused to load.
 *
 * Every other route this plugin would register belongs to machinery that never
 * started, so the card must not offer those controls. This one route exists so
 * the refusal itself — the load-time message, verbatim — reaches the browser and
 * can be copied out; the alternative is a card whose every action answers 404.
 *
 * @param ctx - context that exposes the web server.
 * @param path - exact status path for one variant.
 * @param message - the load-time failure text, already human-readable.
 */
export function registerInactiveStatusRoute(ctx: Context, path: string, message: string): () => void {
  // Registered directly rather than through `ctx.effect`: this runs from an
  // injection callback, after `apply` returned, and an effect opened there is
  // dropped with the applying scope — the route would exist only on paper.
  return ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!loopbackRequest(req)) {
        json(res, 403, { error: 'request-not-trusted' })
        return
      }
      json(res, 200, { status: 'error', message, inactive: true } satisfies QoderWebStatus)
    },
  })
}
