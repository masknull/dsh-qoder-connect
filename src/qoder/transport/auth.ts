/** PAT exchange and in-memory Qoder job-token lifecycle. */

import type { CosyCredentials } from './wire/cosy.ts'
import { getQoderExchangeUrl, getQoderUserInfoUrl, type QoderRegion } from './endpoints.ts'
import { QoderLlmError } from '../errors.ts'
import type { QoderLogger } from './logging.ts'
import { getMachineId } from './machine-id.ts'
import {
  opaqueCredentialKey,
  openApiJsonRequest,
  retryMetadataRead,
} from './request.ts'

const expiryBufferMs = 5 * 60 * 1000
const defaultExpiryMs = 24 * 60 * 60 * 1000
const defaultAuthTimeoutMs = 15_000

interface CachedEntry {
  creds: CosyCredentials
  expiresAt: number
}

interface InFlightEntry {
  promise: Promise<CosyCredentials>
  controller: AbortController
  waiters: number
  settled: boolean
  timeout: ReturnType<typeof setTimeout>
}

interface HealFlightEntry {
  promise: Promise<CosyCredentials>
  settled: boolean
}

export interface QoderAuthServiceOptions {
  fetch?: typeof fetch | undefined
  timeoutMs?: number | undefined
  resolveMachineId?: (() => string) | undefined
  region?: QoderRegion | undefined
  logger?: QoderLogger | undefined
}

function abortedError(): QoderLlmError {
  return new QoderLlmError('Qoder authentication was aborted.', 'ABORTED')
}

async function waitForFlight(
  promise: Promise<CosyCredentials>,
  signal?: AbortSignal,
): Promise<CosyCredentials> {
  if (signal === undefined) return promise
  if (signal.aborted) throw abortedError()

  return new Promise<CosyCredentials>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export class QoderAuthService {
  private readonly cache = new Map<string, CachedEntry>()
  private readonly inFlight = new Map<string, InFlightEntry>()
  /**
   * Self-heal exchanges in flight, keyed like the cache. Deliberately separate
   * from {@link inFlight}: that flight may be aborted by a departing
   * concurrent waiter (a quota poll, a catalog sweep) whose abort has nothing
   * to do with the heal, so healers must not share its controller. Concurrent
   * heals instead share this flight — see {@link exchangeFresh}.
   */
  private readonly healFlights = new Map<string, HealFlightEntry>()
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly resolveMachineId: () => string
  private readonly region: QoderRegion
  private readonly logger: QoderLogger | undefined
  constructor(options: QoderAuthServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? defaultAuthTimeoutMs
    this.resolveMachineId = options.resolveMachineId ?? getMachineId
    this.region = options.region ?? 'global'
    this.logger = options.logger
  }

  clear(pat?: string): void {
    if (pat) {
      this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`)
    } else {
      this.cache.clear()
    }
  }

  /**
   * Exchange a fresh job token OUTSIDE the single-flight, for the self-heal
   * retry. The shared flight can be aborted by a departing concurrent waiter
   * (the quota poll, the catalog sweep), and a retry that joins it would then
   * be cancelled by a path that has nothing to do with the chat. The result
   * replaces the cache entry.
   *
   * Two heals for the same credential that overlap share one exchange instead
   * of racing: each racer's `clear` deleted what the previous one had just
   * cached, and its own `cache.set` overwrote the other's — so the cache could
   * end up naming a token the losing request was no longer using, and with an
   * upstream that retires the previous job token on a new exchange the racers
   * also invalidated each other's credentials (one chat recovering while a
   * concurrent one failed, exactly the 2026-09-26 22:36 observation). The
   * shared exchange runs on its own timeout signal, so one healer's abort —
   * its chat request went away — cannot cancel an exchange other healers, and
   * the future `getCredentials` callers about to read the refreshed cache, are
   * waiting on.
   */
  async exchangeFresh(pat: string, signal?: AbortSignal): Promise<CosyCredentials> {
    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`
    const existing = this.healFlights.get(cacheKey)
    if (existing !== undefined && !existing.settled) {
      return waitForFlight(existing.promise, signal)
    }
    this.clear(pat)
    const created = { settled: false } as HealFlightEntry
    created.promise = this.exchangeAndResolve(pat, AbortSignal.timeout(this.timeoutMs)).finally(() => {
      created.settled = true
      if (this.healFlights.get(cacheKey) === created) this.healFlights.delete(cacheKey)
    })
    this.healFlights.set(cacheKey, created)
    return waitForFlight(created.promise, signal)
  }

  async getCredentials(
    pat: string,
    signal?: AbortSignal,
  ): Promise<CosyCredentials> {
    if (!pat || typeof pat !== 'string') {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing or invalid. Configure Qoder in the Qoder settings page.',
        'MISSING_CREDENTIAL',
      )
    }
    if (signal?.aborted) throw abortedError()

    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`

    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() + expiryBufferMs) return cached.creds

    let entry = this.inFlight.get(cacheKey)
    if (entry === undefined || entry.controller.signal.aborted) {
      const controller = new AbortController()
      const created = {} as InFlightEntry
      created.controller = controller
      created.waiters = 0
      created.settled = false
      created.timeout = setTimeout(() => controller.abort('authentication timeout'), this.timeoutMs)
      created.promise = this.exchangeAndResolve(pat, controller.signal).finally(() => {
        created.settled = true
        clearTimeout(created.timeout)
        if (this.inFlight.get(cacheKey) === created) this.inFlight.delete(cacheKey)
      })
      entry = created
      this.inFlight.set(cacheKey, entry)
    }

    entry.waiters++
    try {
      return await waitForFlight(entry.promise, signal)
    } finally {
      entry.waiters--
      if (entry.waiters === 0 && !entry.settled) {
        if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey)
        entry.controller.abort('all callers aborted')
      }
    }
  }

  private async exchangeAndResolve(
    pat: string,
    signal: AbortSignal,
  ): Promise<CosyCredentials> {
    let jobToken: string
    let expiresAt = Date.now() + defaultExpiryMs

    const data = await openApiJsonRequest<{ token?: string; expires_at?: string; expires_in?: number }>(
      this.fetchImpl,
      {
        url: getQoderExchangeUrl(this.region),
        body: { personal_token: pat },
        signal,
        timeoutMs: this.timeoutMs,
        logger: this.logger,
        operation: 'Auth',
        logCategory: 'auth.exchange',
      },
    )
    if (!data.token) {
      throw new QoderLlmError('Qoder PAT exchange returned no job token.', 'AUTH')
    }
    jobToken = data.token
    if (data.expires_at) {
      const parsed = Date.parse(data.expires_at)
      if (!Number.isNaN(parsed)) expiresAt = parsed
    } else if (typeof data.expires_in === 'number' && data.expires_in > 0) {
      expiresAt = Date.now() + data.expires_in
    }

    const userInfo = await retryMetadataRead(signal, () => this.fetchUserInfo(jobToken, signal))
    const creds: CosyCredentials = {
      userID: userInfo.userID,
      authToken: jobToken,
      name: userInfo.name || 'Qoder User',
      email: userInfo.email,
      machineID: this.resolveMachineId(),
    }
    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`
    this.cache.set(cacheKey, { creds, expiresAt })
    return creds
  }

  private async fetchUserInfo(
    jobToken: string,
    signal: AbortSignal,
  ): Promise<{ userID: string; email: string; name: string }> {
    const info = await openApiJsonRequest<{
      id?: string
      email?: string
      name?: string
      username?: string
    }>(this.fetchImpl, {
      url: getQoderUserInfoUrl(this.region),
      token: jobToken,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'UserInfo',
      logCategory: 'auth.user-info',
    })
    if (!info.id) {
      throw new QoderLlmError('Qoder identity lookup returned no user id.', 'AUTH')
    }
    return {
      userID: info.id,
      email: info.email ?? '',
      name: info.name ?? info.username ?? '',
    }
  }
}
