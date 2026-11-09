import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderCheckInService, type QoderCheckInResult } from '../src/qoder/transport/checkin.ts'
import type { QoderAuthService } from '../src/qoder/transport/auth.ts'
import {
  CheckInScheduler,
  DEFAULT_CHECK_IN_MINUTE,
  EARLIEST_CHECK_IN_MINUTE,
  JsonFileCheckInStore,
  isPastCheckInTime,
  msUntilNextCheckIn,
  normalizeCheckInMinute,
  type CheckInAccount,
  type CheckInStatusStore,
  type CheckInRecord,
} from '../src/checkin-scheduler.ts'
import { QoderLlmError } from '../src/qoder/errors.ts'

// Qoder's daily benefit window opens at 10:00 UTC+8 and closes at 09:59 the
// next morning; the fixtures pin startAt 1791684000 / endAt 1791770340.
const WINDOW_OPEN_MS = Date.parse('2026-10-11T02:00:00.000Z') // 2026-10-11 10:00 UTC+8
const WINDOW_CLOSE_MS = Date.parse('2026-10-12T01:59:00.000Z') // 2026-10-12 09:59 UTC+8
const PREVIOUS_OPEN_MS = WINDOW_OPEN_MS - 86_400_000 // 2026-10-10 10:00 UTC+8
const PREVIOUS_CLOSE_MS = WINDOW_CLOSE_MS - 86_400_000 // 2026-10-11 09:59 UTC+8
/** The moment the pre-window "already claimed" row was written. */
const PRE_WINDOW_MS = Date.parse('2026-10-11T01:58:10.000Z')
/**
 * Five seconds after the window opens — the instant the scheduled run fires.
 * Pinned wherever a test reaches the upstream, so the fixtures do not depend on
 * the day the suite happens to run.
 */
const POST_OPEN_MS = Date.parse('2026-10-11T02:00:05.000Z')

afterEach(() => {
  // The window tests pin `Date.now`; leaking that spy would silently move every
  // later test's clock.
  vi.restoreAllMocks()
})

function createMockAuth(token = 'mock-job-token'): QoderAuthService {
  return {
    getCredentials: vi.fn(async () => ({ authToken: token, userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
    exchangeFresh: vi.fn(async () => ({ authToken: token + '-fresh', userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
    clear: vi.fn(),
  } as unknown as QoderAuthService
}

/**
 * A fetch stub that serves one CLAIM_BENEFIT campaign and records claim POSTs,
 * so a test can assert both the outcome and whether the upstream was asked to
 * claim at all.
 */
function campaignFetch(
  campaign: Record<string, unknown>,
  claim: Record<string, unknown> = { status: 'CLAIMED' },
): { fetch: typeof fetch; posts: string[] } {
  const posts: string[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = { 'content-type': 'application/json' }
    if (init?.method === 'POST') {
      posts.push(String(url))
      return new Response(JSON.stringify({ benefit: { amount: 100, kind: 'CREDITS' }, ...claim }), { status: 200, headers })
    }
    return new Response(JSON.stringify({ claimable: true, campaigns: [campaign] }), { status: 200, headers })
  }
  return { fetch: vi.fn(impl) as unknown as typeof fetch, posts }
}

/** The campaign the upstream serves inside today's window. */
function todayCampaign(claimStatus: string): Record<string, unknown> {
  return {
    campaignId: 'camp-today',
    campaignKey: 'act-20261011-747',
    actionType: 'CLAIM_BENEFIT',
    claimStatus,
    startAt: WINDOW_OPEN_MS / 1000,
    endAt: WINDOW_CLOSE_MS / 1000,
    benefit: { amount: 100, kind: 'CREDITS' },
  }
}

/** The campaign the upstream is still serving before today's window opens. */
function previousCampaign(claimStatus: string): Record<string, unknown> {
  return {
    campaignId: 'camp-previous',
    campaignKey: 'act-20261010-747',
    actionType: 'CLAIM_BENEFIT',
    claimStatus,
    startAt: PREVIOUS_OPEN_MS / 1000,
    endAt: PREVIOUS_CLOSE_MS / 1000,
    benefit: { amount: 100, kind: 'CREDITS' },
  }
}

/**
 * A campaign whose window opens *tomorrow* — the upstream publishing the next
 * window early, carrying a status left over from the last cycle.
 */
function nextCampaign(claimStatus: string): Record<string, unknown> {
  return {
    campaignId: 'camp-next',
    campaignKey: 'act-20261012-747',
    actionType: 'CLAIM_BENEFIT',
    claimStatus,
    startAt: (WINDOW_OPEN_MS + 86_400_000) / 1000,
    endAt: (WINDOW_CLOSE_MS + 86_400_000) / 1000,
    benefit: { amount: 100, kind: 'CREDITS' },
  }
}

describe('QoderCheckInService', () => {

  it('rejects with error result when PAT is empty', async () => {
    const auth = createMockAuth()
    const service = new QoderCheckInService({ authService: auth, variantId: 'qoder', region: 'china' })
    const result = await service.checkIn('')
    expect(result.status).toBe('error')
    expect(result.message).toContain('No PAT')
  })

  it('successfully claims daily benefit when campaign is claimable', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(POST_OPEN_MS)
    const auth = createMockAuth('valid-token')
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes('/sash/api/v1/me/campaigns') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({
          claimable: true,
          campaigns: [
            {
              campaignId: 'camp-123',
              campaignKey: 'daily-100',
              actionType: 'CLAIM_BENEFIT',
              claimStatus: 'CLAIMABLE',
              benefit: { amount: 100, kind: 'CREDITS' },
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (urlStr.includes('/sash/api/v1/me/campaigns/camp-123/claim') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          status: 'CLAIMED',
          benefit: { amount: 100, kind: 'CREDITS' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('Not found', { status: 404 })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')
    expect(result.status).toBe('claimed')
    expect(result.amount).toBe(100)
    expect(result.campaignKey).toBe('daily-100')
  })

  it('returns already-claimed when campaign status is already CLAIMED', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(POST_OPEN_MS)
    const auth = createMockAuth()
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      return new Response(JSON.stringify({
        claimable: false,
        campaigns: [
          {
            campaignId: 'camp-123',
            campaignKey: 'daily-100',
            actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMED',
            benefit: { amount: 100 },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')
    expect(result.status).toBe('already-claimed')
    expect(result.message).toContain('Already claimed')
  })

  it('does not settle today from a CLAIMED that belongs to the previous window', async () => {
    // At 09:58 UTC+8 the upstream still serves yesterday's CLAIMED window; recording it against today skips the day.
    vi.spyOn(Date, 'now').mockReturnValue(PRE_WINDOW_MS)
    const { fetch: mockFetch, posts } = campaignFetch(previousCampaign('CLAIMED'))
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')

    // Retryable and dated today, so the run after the window opens still claims.
    expect(result.status).toBe('before-window')
    expect(result.date).toBe('2026-10-11')
    expect(result.message).toContain('2026-10-10')
    expect(posts).toHaveLength(0)
  })

  it('refuses a window that has not opened yet, however the upstream labels it', async () => {
    // Today's campaign served before the window opens, status left over: the window's own bounds refuse it — no clock rule.
    vi.spyOn(Date, 'now').mockReturnValue(PRE_WINDOW_MS)
    const { fetch: mockFetch, posts } = campaignFetch(todayCampaign('CLAIMED'))
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')

    expect(result.status).toBe('before-window')
    expect(result.date).toBe('2026-10-11')
    expect(result.message).toContain('has not opened yet')
    expect(posts).toHaveLength(0)
  })

  it("still refuses yesterday's window once the clock says today has opened", async () => {
    // A clock rule cannot see this: 10:00:05, yet the upstream still serves yesterday's window — only its bounds tell.
    vi.spyOn(Date, 'now').mockReturnValue(POST_OPEN_MS)
    const { fetch: mockFetch, posts } = campaignFetch(previousCampaign('CLAIMED'))
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')

    expect(result.status).toBe('before-window')
    expect(result.message).toContain('2026-10-10')
    expect(posts).toHaveLength(0)
  })

  it('refuses the next window when the upstream publishes it early', async () => {
    // Reachable after the window opens too: the upstream publishes the *next*
    // window ahead of time, carrying a status left over from the last cycle.
    vi.spyOn(Date, 'now').mockReturnValue(POST_OPEN_MS)
    const { fetch: mockFetch, posts } = campaignFetch(nextCampaign('CLAIMED'))
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')

    expect(result.status).toBe('before-window')
    expect(result.date).toBe('2026-10-11')
    expect(posts).toHaveLength(0)
  })

  it("settles today from a CLAIMED that belongs to today's open window", async () => {
    // The very same CLAIMED, read after the window opened: now it is today.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-11T07:57:34.000Z')) // 15:57:34 UTC+8
    const { fetch: mockFetch, posts } = campaignFetch(todayCampaign('CLAIMED'))
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')

    expect(result.status).toBe('already-claimed')
    expect(result.date).toBe('2026-10-11')
    expect(posts).toHaveLength(0)
  })

  it("attributes a claim made inside today's window to today", async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-11T02:00:05.000Z')) // 10:00:05 UTC+8
    const { fetch: mockFetch, posts } = campaignFetch(todayCampaign('CLAIMABLE'))
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')

    expect(result.status).toBe('claimed')
    expect(result.date).toBe('2026-10-11')
    expect(posts).toHaveLength(1)
  })

  it('keeps the calendar day when the upstream sends no window bounds', async () => {
    // No startAt/endAt: the calendar day is the only signal left, and that is a decision, not an accident.
    vi.spyOn(Date, 'now').mockReturnValue(POST_OPEN_MS)
    const { fetch: mockFetch } = campaignFetch({
      campaignId: 'camp-123',
      campaignKey: 'daily-100',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMED',
      benefit: { amount: 100 },
    })
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')

    expect(result.status).toBe('already-claimed')
    expect(result.date).toBe('2026-10-11')
  })

  it('does not attribute a multi-day campaign to its start day', async () => {
    // A campaign running for weeks is not a daily window: its start day would
    // mislabel every day of its run, so it falls back to the calendar day.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-11T07:57:34.000Z'))
    const { fetch: mockFetch } = campaignFetch({
      campaignId: 'camp-long',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMED',
      startAt: Date.parse('2026-10-01T02:00:00.000Z') / 1000,
      endAt: Date.parse('2026-10-31T01:59:00.000Z') / 1000,
      benefit: { amount: 100 },
    })
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')

    expect(result.status).toBe('already-claimed')
    expect(result.date).toBe('2026-10-11')
  })

  it('returns no-campaign when no CLAIM_BENEFIT campaign exists (like current Global)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(POST_OPEN_MS)
    const auth = createMockAuth()
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        claimable: true,
        campaigns: [
          {
            campaignId: 'camp-promo',
            actionType: 'VIEW_DETAILS',
            claimStatus: 'CLAIMABLE',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder-global',
      region: 'global',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')
    expect(result.status).toBe('no-campaign')
  })

  it('identifies as the desktop client, without which the upstream returns an empty campaign list', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(POST_OPEN_MS)
    const auth = createMockAuth()
    const seenHeaders: (Record<string, string> | undefined)[] = []
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify({ campaigns: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })
    await service.checkIn('pt-test')

    // `cosy-clienttype: 5` answers `campaigns: []`; only the desktop `10` returns the real list, so 5 disables check-in.
    expect(seenHeaders[0]?.['cosy-clienttype']).toBe('10')
  })

  it('self-heals with exchangeFresh when auth token is rejected with 401', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(POST_OPEN_MS)
    let callCount = 0
    const auth = {
      getCredentials: vi.fn(async () => ({ authToken: 'expired-token', userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
      exchangeFresh: vi.fn(async () => ({ authToken: 'fresh-token', userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
    } as unknown as QoderAuthService

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.authorization === 'Bearer expired-token') {
        return new Response(JSON.stringify({ code: 'TOKEN_EXPIRE', message: 'token expired' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        campaigns: [
          {
            campaignId: 'c1',
            actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMED',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const result = await service.checkIn('pt-test')
    expect(auth.exchangeFresh).toHaveBeenCalled()
    expect(result.status).toBe('already-claimed')
  })
})

describe('CheckInScheduler', () => {
  it('schedules the next occurrence of the configured moment in UTC+8', () => {
    // 08:00 UTC+8 (00:00 UTC) -> 10:00 is 2 hours away
    const morningUtc8 = new Date('2026-09-21T00:00:00.000Z').getTime()
    const diffMorning = msUntilNextCheckIn(DEFAULT_CHECK_IN_MINUTE, morningUtc8)
    expect(diffMorning).toBeGreaterThan(7_100_000)
    expect(diffMorning).toBeLessThan(7_300_000)

    // 12:00 UTC+8 (04:00 UTC) -> tomorrow's 10:00, roughly 22 hours away
    const afternoonUtc8 = new Date('2026-09-21T04:00:00.000Z').getTime()
    const diffAfternoon = msUntilNextCheckIn(DEFAULT_CHECK_IN_MINUTE, afternoonUtc8)
    expect(diffAfternoon).toBeGreaterThan(21 * 3600 * 1000)
    expect(diffAfternoon).toBeLessThan(23 * 3600 * 1000)
  })

  it('honours a custom moment instead of the 10:00 default', () => {
    // 08:00 UTC+8; a 14:30 (870) moment is 6.5 hours away, not 2.
    const morningUtc8 = new Date('2026-09-21T00:00:00.000Z').getTime()
    const diff = msUntilNextCheckIn(870, morningUtc8)
    expect(diff).toBeGreaterThan(6.4 * 3600 * 1000)
    expect(diff).toBeLessThan(6.6 * 3600 * 1000)
  })

  it('falls back to 10:00 for a stored value that is not a real minute', () => {
    expect(normalizeCheckInMinute(undefined)).toBe(DEFAULT_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(Number.NaN)).toBe(DEFAULT_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(-1)).toBe(DEFAULT_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(1440)).toBe(DEFAULT_CHECK_IN_MINUTE)
    // A real value at or after the window's opening passes through untouched.
    expect(normalizeCheckInMinute(870)).toBe(870)
    expect(normalizeCheckInMinute(DEFAULT_CHECK_IN_MINUTE)).toBe(DEFAULT_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(DEFAULT_CHECK_IN_MINUTE + 1)).toBe(DEFAULT_CHECK_IN_MINUTE + 1)
  })

  it('lifts a stored moment before the window opens to the opening itself', () => {
    // A moment before 10:00 cannot claim (it would read the previous window), so a stored value is lifted, not honoured.
    expect(normalizeCheckInMinute(0)).toBe(EARLIEST_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(1)).toBe(EARLIEST_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(599)).toBe(EARLIEST_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(600)).toBe(600)
    // ...and the day is still scheduled, at the earliest moment that works.
    expect(isPastCheckInTime(normalizeCheckInMinute(540), PRE_WINDOW_MS)).toBe(false)
    expect(isPastCheckInTime(normalizeCheckInMinute(540), WINDOW_OPEN_MS)).toBe(true)
  })

  it('reports the configured moment as passed only once it has actually passed', () => {
    // 09:00 UTC+8 (01:00 UTC)
    const before10 = new Date('2026-09-21T01:00:00.000Z').getTime()
    expect(isPastCheckInTime(DEFAULT_CHECK_IN_MINUTE, before10)).toBe(false)

    // 11:00 UTC+8 (03:00 UTC)
    const after10 = new Date('2026-09-21T03:00:00.000Z').getTime()
    expect(isPastCheckInTime(DEFAULT_CHECK_IN_MINUTE, after10)).toBe(true)

    // The same 11:00 wall clock has not reached a custom 14:30 (870) moment.
    expect(isPastCheckInTime(870, after10)).toBe(false)
    // The floor's own boundary: 09:59 UTC+8 (01:59 UTC) is one minute short of
    // the earliest allowed moment, 10:00 UTC+8 (02:00 UTC) has reached it.
    expect(isPastCheckInTime(EARLIEST_CHECK_IN_MINUTE, new Date('2026-09-21T01:59:00.000Z').getTime())).toBe(false)
    expect(isPastCheckInTime(EARLIEST_CHECK_IN_MINUTE, new Date('2026-09-21T02:00:00.000Z').getTime())).toBe(true)
  })

  it('arms a timer before the toggles are readable, and re-arms to a retimed moment', () => {
    const delays: number[] = []
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      _handler: () => void,
      delay?: number,
    ) => {
      delays.push(Number(delay))
      return 0 as unknown as NodeJS.Timeout
    }) as typeof setTimeout)

    let minute = 870 // 14:30
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => ({
          variantId: 'qoder',
          date: '2026-09-22',
          timestamp: 1,
          status: 'claimed' as const,
        }),
        minuteOfDay: () => minute,
      }],
      // The stored toggle is unreadable at assembly time; timer placement must not depend on it.
      isEnabled: () => false,
      now: () => new Date('2026-09-22T00:00:00.000Z').getTime(), // 08:00 UTC+8
    })

    scheduler.rearm()
    expect(delays).toHaveLength(1)
    // 08:00 -> 14:30 is 6.5 hours.
    expect(delays[0]).toBeGreaterThan(6.4 * 3600 * 1000)
    expect(delays[0]).toBeLessThan(6.6 * 3600 * 1000)

    minute = DEFAULT_CHECK_IN_MINUTE // retimed to 10:00
    scheduler.rearm()
    expect(delays).toHaveLength(2)
    // 08:00 -> 10:00 is 2 hours.
    expect(delays[1]).toBeGreaterThan(7_100_000)
    expect(delays[1]).toBeLessThan(7_300_000)

    scheduler.dispose()
    spy.mockRestore()
  })

  it('runs catchup and updates store when enabled', async () => {
    const storeRecords: Record<string, CheckInRecord> = {}
    const store: CheckInStatusStore = {
      read: (id) => storeRecords[id],
      write: (id, record) => { storeRecords[id] = record },
      clearLogs: (id) => { if (storeRecords[id]) storeRecords[id].logs = [] },
    }

    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-09-21',
      timestamp: Date.now(),
      status: 'claimed' as const,
      amount: 100,
    }))

    const onClaimed = vi.fn()
    const after10 = new Date('2026-09-21T04:00:00.000Z').getTime()

    const scheduler = new CheckInScheduler({
      targets: [
        {
          variantId: 'qoder',
          checkIn,
          minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
          onClaimed,
        },
      ],
      isEnabled: (id) => id === 'qoder',
      store,
      now: () => after10,
    })

    scheduler.start()
    // Wait microtasks
    await new Promise(r => setTimeout(r, 10))
    scheduler.dispose()

    expect(checkIn).toHaveBeenCalled()
    expect(onClaimed).toHaveBeenCalled()
    expect(storeRecords.qoder?.status).toBe('claimed')
    expect(storeRecords.qoder?.lastDate).toBe('2026-09-21')
  })

  it('retries later the same day when an earlier attempt claimed nothing', async () => {
    const records: Record<string, CheckInRecord> = {
      qoder: { lastDate: '2026-09-22', lastAt: 1, status: 'no-campaign' },
    }
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { records[id] = record },
      clearLogs: id => { if (records[id]) records[id].logs = [] },
    }
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-09-22',
      timestamp: 2,
      status: 'claimed' as const,
      amount: 100,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      now: () => new Date('2026-09-22T04:00:00.000Z').getTime(),
    })

    scheduler.start()
    await new Promise(r => setTimeout(r, 10))
    scheduler.dispose()

    // "Nothing to claim yet" is not a settled day: a later attempt the same
    // day must still be allowed to claim it.
    expect(checkIn).toHaveBeenCalled()
    expect(records.qoder?.status).toBe('claimed')
  })

  it('retries the day after a pre-window attempt refused to act', async () => {
    // A day attempted before the window (`before-window`) is not settled: the run after it opens must claim.
    const records: Record<string, CheckInRecord> = {
      qoder: { lastDate: '2026-09-22', lastAt: 1, status: 'before-window' },
    }
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { records[id] = record },
      clearLogs: id => { if (records[id]) records[id].logs = [] },
    }
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-09-22',
      timestamp: 2,
      status: 'claimed' as const,
      amount: 100,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      now: () => new Date('2026-09-22T04:00:00.000Z').getTime(),
    })

    await scheduler.sweepAll(false, 'qoder')
    scheduler.dispose()

    expect(checkIn).toHaveBeenCalled()
    expect(records.qoder?.status).toBe('claimed')
  })

  it('skips the rest of the day once the day was actually claimed', async () => {
    const records: Record<string, CheckInRecord> = {
      qoder: { lastDate: '2026-09-22', lastAt: 1, status: 'claimed', amount: 100 },
    }
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { records[id] = record },
      clearLogs: id => { if (records[id]) records[id].logs = [] },
    }
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-09-22',
      timestamp: 2,
      status: 'claimed' as const,
      amount: 100,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      now: () => new Date('2026-09-22T04:00:00.000Z').getTime(),
    })

    scheduler.start()
    await new Promise(r => setTimeout(r, 10))
    scheduler.dispose()

    expect(checkIn).not.toHaveBeenCalled()
  })

  it('never sweeps one variant twice at once', async () => {
    let settle: ((result: QoderCheckInResult) => void) | undefined
    const checkIn = vi.fn(() => new Promise<QoderCheckInResult>(resolve => { settle = resolve }))
    const writes: CheckInRecord[] = []
    const store: CheckInStatusStore = {
      read: () => undefined,
      write: (_id, record) => { writes.push(record) },
      clearLogs: () => {},
    }
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      now: () => new Date('2026-09-22T04:00:00.000Z').getTime(),
    })

    // `start()` and the settings catch-up overlap during assembly; only one may claim.
    const first = scheduler.sweepAll(true)
    const second = scheduler.sweepAll(true)
    await Promise.resolve()
    expect(checkIn).toHaveBeenCalledTimes(1)

    settle!({ variantId: 'qoder', date: '2026-09-22', timestamp: 1, status: 'claimed', amount: 100 })
    await Promise.all([first, second])
    expect(checkIn).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(1)
    scheduler.dispose()
  })

  it('publishes when the next automatic run is due', () => {
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => ({ variantId: 'qoder', date: '2026-09-22', timestamp: 1, status: 'claimed' as const }),
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store: { read: () => undefined, write: () => {}, clearLogs: () => {} },
      now: () => new Date('2026-09-22T00:00:00.000Z').getTime(), // 08:00 UTC+8
    })

    scheduler.rearm()
    const due = scheduler.nextRunAt('qoder')
    expect(due).toBeDefined()
    // 08:00 -> 10:00 is 2 hours.
    expect(due! - new Date('2026-09-22T00:00:00.000Z').getTime()).toBeGreaterThan(7_100_000)
    expect(due! - new Date('2026-09-22T00:00:00.000Z').getTime()).toBeLessThan(7_300_000)
    scheduler.dispose()
  })

  it('records a visible row when the timer fires on an already-claimed day', async () => {
    const records: Record<string, CheckInRecord> = {
      qoder: { lastDate: '2026-09-22', lastAt: 1, status: 'claimed', amount: 100 },
    }
    const writes: CheckInRecord[] = []
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { writes.push(record); records[id] = record },
      clearLogs: () => {},
    }
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-09-22',
      timestamp: 2,
      status: 'claimed' as const,
    }))
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      now: () => new Date('2026-09-22T04:00:00.000Z').getTime(),
    })

    // The timer's own pass: no second claim, but the run is observable.
    await scheduler.sweepAll(false, 'qoder')
    expect(checkIn).not.toHaveBeenCalled()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.status).toBe('already-claimed')

    // A catch-up stays silent, or every boot would pile on another row.
    writes.length = 0
    await scheduler.sweepAll(true, 'qoder')
    expect(writes).toHaveLength(0)
    scheduler.dispose()
  })

  it('accumulates and caps history logs up to 30 entries in JsonFileCheckInStore', () => {
    const records: Record<string, CheckInRecord> = {}
    const store: CheckInStatusStore = {
      read: (id) => records[id],
      clearLogs: (id) => { if (records[id]) records[id].logs = [] },
      write: (id, record) => {
        const existing = records[id]?.logs ?? []
        const newLog = {
          id: `${record.lastDate}-${record.lastAt}`,
          date: record.lastDate,
          timestamp: record.lastAt,
          status: record.status,
          ...record.amount === undefined ? {} : { amount: record.amount },
        }
        records[id] = {
          ...record,
          logs: [newLog, ...existing].slice(0, 30),
        }
      },
    }

    for (let i = 1; i <= 35; i++) {
      store.write('qoder', {
        lastDate: `2026-09-${String(i).padStart(2, '0')}`,
        lastAt: 1700000000000 + i * 1000,
        status: 'claimed',
        amount: 100,
      })
    }

    const saved = store.read('qoder')
    expect(saved?.logs).toHaveLength(30)
    // Most recent is first
    expect(saved?.logs?.[0]?.date).toBe('2026-09-35')
  })
})

describe('check-in across the 10:00 window boundary', () => {
  it('still claims the day after an attempt that ran before the window opened', async () => {
    // End to end: a 09:58 check-in reads the previous window's CLAIMED; the 10:00 run must still claim.
    const clock = { nowMs: PRE_WINDOW_MS }
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs)

    // The upstream serves the previous window until 10:00, then today's.
    const served = () => clock.nowMs < WINDOW_OPEN_MS
      ? previousCampaign('CLAIMED')
      : todayCampaign('CLAIMABLE')
    const posts: string[] = []
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = { 'content-type': 'application/json' }
      if (init?.method === 'POST') {
        posts.push(String(url))
        return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100, kind: 'CREDITS' } }), { status: 200, headers })
      }
      return new Response(JSON.stringify({ claimable: true, campaigns: [served()] }), { status: 200, headers })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
    })

    const records: Record<string, CheckInRecord> = {}
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { records[id] = record },
      clearLogs: id => { if (records[id]) records[id].logs = [] },
    }

    // The manual path in index.ts: run the check-in, persist what it reported.
    const early = await service.checkIn('pt-test')
    store.write('qoder', {
      lastDate: early.date,
      lastAt: early.timestamp,
      status: early.status,
      ...early.amount === undefined ? {} : { amount: early.amount },
      ...early.message === undefined ? {} : { message: early.message },
    })
    expect(early.date).toBe('2026-10-11')

    // 10:00 — the scheduled run, which must not treat the day as settled.
    clock.nowMs = Date.parse('2026-10-11T02:00:05.000Z')
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: signal => service.checkIn('pt-test', signal),
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      now: () => clock.nowMs,
    })
    await scheduler.sweepAll(false, 'qoder')
    scheduler.dispose()

    // The symptom: the scheduled run must reach the upstream and claim, not report the day as done.
    expect(posts).toHaveLength(1)
    expect(records.qoder?.status).toBe('claimed')
    expect(records.qoder?.lastDate).toBe('2026-10-11')
    // ...which is only possible because the pre-window attempt left the day
    // unsettled instead of recording the previous window's CLAIMED against it.
    expect(early.status).toBe('before-window')
  })
})

describe('CheckInScheduler across every saved account', () => {
  const DAY = '2026-09-22'
  const AFTER_10 = new Date('2026-09-22T04:00:00.000Z').getTime() // 12:00 UTC+8

  /** An in-memory store shaped exactly like the JSON one. */
  function memoryStore(seed?: Record<string, CheckInRecord>) {
    const records: Record<string, CheckInRecord> = { ...seed }
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => {
        const existingLogs = records[id]?.logs ?? []
        const newLog = {
          id: `${record.lastDate}-${record.lastAt}${record.account === undefined ? '' : `-${record.account.id}`}`,
          date: record.lastDate,
          timestamp: record.lastAt,
          status: record.status,
          ...record.amount === undefined ? {} : { amount: record.amount },
          ...record.message === undefined ? {} : { message: record.message },
          ...record.account === undefined ? {} : { account: record.account },
        }
        records[id] = {
          ...record,
          logs: [newLog, ...existingLogs.filter(l => l.id !== newLog.id)].slice(0, 30),
        }
      },
      clearLogs: id => { if (records[id]) records[id].logs = [] },
    }
    return { store, records }
  }

  function account(id: string): CheckInAccount {
    return { id, pat: `pt-${id}`, patTail: id.slice(-4) }
  }

  it('claims once per saved token instead of stopping at the active one', async () => {
    const { store, records } = memoryStore()
    const seen: string[] = []
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => { throw new Error('the sweep must not use the active-only path') },
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => [account('aaaa1111'), account('bbbb2222'), account('cccc3333')],
        checkInAs: async a => {
          seen.push(a.id)
          return { variantId: 'qoder', date: DAY, timestamp: 1, status: 'claimed' as const, amount: 100 }
        },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    await scheduler.sweepAll(false, 'qoder')
    scheduler.dispose()

    expect(seen).toEqual(['aaaa1111', 'bbbb2222', 'cccc3333'])
    // One row per token: the log would otherwise read as a single account's day.
    expect(records.qoder?.logs).toHaveLength(3)
    expect(Object.keys(records.qoder?.accounts ?? {})).toEqual(['aaaa1111', 'bbbb2222', 'cccc3333'])
  })

  it('does not re-claim a token that already claimed today, but claims its siblings', async () => {
    const { store, records } = memoryStore({
      qoder: {
        lastDate: DAY,
        lastAt: 1,
        status: 'claimed',
        amount: 100,
        accounts: { aaaa1111: { date: DAY, status: 'claimed', amount: 100 } },
      },
    })
    const seen: string[] = []
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => { throw new Error('unused') },
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => [account('aaaa1111'), account('bbbb2222')],
        checkInAs: async a => {
          seen.push(a.id)
          return { variantId: 'qoder', date: DAY, timestamp: 2, status: 'claimed' as const, amount: 100 }
        },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    await scheduler.sweepAll(false, 'qoder')
    scheduler.dispose()

    expect(seen).toEqual(['bbbb2222'])
    expect(records.qoder?.accounts?.bbbb2222?.status).toBe('claimed')
  })

  it('one unreachable token does not burn the day for the others', async () => {
    const { store, records } = memoryStore()
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => { throw new Error('unused') },
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => [account('aaaa1111'), account('bbbb2222')],
        checkInAs: async a => {
          if (a.id === 'aaaa1111') throw new Error('upstream unreachable')
          return { variantId: 'qoder', date: DAY, timestamp: 2, status: 'claimed' as const, amount: 100 }
        },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    await scheduler.sweepAll(false, 'qoder')
    scheduler.dispose()

    // The healthy token still got its benefit, and the broken one is left retryable.
    expect(records.qoder?.accounts?.bbbb2222?.status).toBe('claimed')
    expect(records.qoder?.accounts?.aaaa1111).toBeUndefined()
  })

  it('an error result is not a settled day for that token', async () => {
    const { store, records } = memoryStore()
    let calls = 0
    const build = () => new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => { throw new Error('unused') },
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => [account('aaaa1111')],
        checkInAs: async () => {
          calls += 1
          return calls === 1
            ? { variantId: 'qoder', date: DAY, timestamp: calls, status: 'error' as const, message: 'boom' }
            : { variantId: 'qoder', date: DAY, timestamp: calls, status: 'claimed' as const, amount: 100 }
        },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    const first = build()
    await first.sweepAll(false, 'qoder')
    first.dispose()
    expect(records.qoder?.accounts?.aaaa1111).toBeUndefined()

    const second = build()
    await second.sweepAll(false, 'qoder')
    second.dispose()
    expect(records.qoder?.accounts?.aaaa1111?.status).toBe('claimed')
  })

  it('honours a legacy single-account record instead of re-posting a settled day', async () => {
    // The file every version before per-account claiming writes: a header row,
    // no `accounts` map, and exactly one saved token.
    const { store } = memoryStore({
      qoder: { lastDate: DAY, lastAt: 1, status: 'claimed', amount: 100 },
    })
    const seen: string[] = []
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => { throw new Error('unused') },
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => [account('aaaa1111')],
        checkInAs: async a => {
          seen.push(a.id)
          return { variantId: 'qoder', date: DAY, timestamp: 2, status: 'claimed' as const }
        },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    await scheduler.sweepAll(false, 'qoder')
    scheduler.dispose()
    expect(seen).toEqual([])
  })

  it('never runs two claims upstream at once when a sweep and a manual run overlap', async () => {
    const { store } = memoryStore()
    const pending: ((r: QoderCheckInResult) => void)[] = []
    let inFlight = 0
    let peak = 0
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => { throw new Error('unused') },
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => [account('aaaa1111')],
        checkInAs: () => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          return new Promise<QoderCheckInResult>(resolve => {
            pending.push(r => { inFlight -= 1; resolve(r) })
          })
        },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    const sweeping = scheduler.sweepAll(false, 'qoder')
    // Let the sweep reach its claim before the manual run is asked for.
    await vi.waitFor(() => { expect(pending).toHaveLength(1) })
    const manual = scheduler.checkInNow('qoder')
    // The manual run waits on the sweep in flight; it must not open a second one.
    await Promise.resolve()
    expect(pending).toHaveLength(1)

    pending[0]!({ variantId: 'qoder', date: DAY, timestamp: 1, status: 'claimed' as const, amount: 100 })
    await sweeping
    // ...and only then does the manual run make its own attempt.
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    pending[1]!({ variantId: 'qoder', date: DAY, timestamp: 2, status: 'already-claimed' as const, amount: 100 })
    const run = await manual
    scheduler.dispose()

    // Serialised, never concurrent: that is what keeps a manual click from racing
    // the scheduled sweep toward a double claim.
    expect(peak).toBe(1)
    expect(run?.status).toBe('already-claimed')
  })

  it('reports the claim per account through the manual path', async () => {
    const { store, records } = memoryStore()
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => { throw new Error('unused') },
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => [account('aaaa1111'), account('bbbb2222')],
        checkInAs: async a => a.id === 'aaaa1111'
          ? { variantId: 'qoder', date: DAY, timestamp: 1, status: 'claimed' as const, amount: 100 }
          : { variantId: 'qoder', date: DAY, timestamp: 2, status: 'already-claimed' as const, amount: 100 },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    const run = await scheduler.checkInNow('qoder')
    scheduler.dispose()

    expect(run?.status).toBe('claimed')
    // 100 won, not 200: one account claimed, the other was already done.
    expect(run?.amount).toBe(100)
    expect(run?.outcomes.map(o => [o.account.id, o.status])).toEqual([
      ['aaaa1111', 'claimed'],
      ['bbbb2222', 'already-claimed'],
    ])
    expect(records.qoder?.logs).toHaveLength(2)
  })

  it('surfaces why a fully failed manual run failed', async () => {
    const { store } = memoryStore()
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => { throw new Error('unused') },
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => [account('aaaa1111'), account('bbbb2222')],
        checkInAs: async a => { throw new Error(`upstream unreachable for ${a.id}`) },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    const run = await scheduler.checkInNow('qoder')
    scheduler.dispose()

    // The card reads its error notice off this message; without it a failed run
    // looks like nothing happened.
    expect(run?.status).toBe('error')
    expect(run?.message).toContain('upstream unreachable for aaaa1111')
    expect(run?.message).toContain('upstream unreachable for bbbb2222')
  })

  it('carries the failure reason alongside a partially successful run', async () => {
    const { store } = memoryStore()
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => { throw new Error('unused') },
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => [account('aaaa1111'), account('bbbb2222')],
        checkInAs: async a => {
          if (a.id === 'aaaa1111') throw new Error('upstream unreachable')
          return { variantId: 'qoder', date: DAY, timestamp: 2, status: 'claimed' as const, amount: 100 }
        },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    const run = await scheduler.checkInNow('qoder')
    scheduler.dispose()

    expect(run?.status).toBe('claimed')
    expect(run?.amount).toBe(100)
    expect(run?.message).toBe('upstream unreachable')
  })

  it('falls back to the active credential when no accounts are saved', async () => {
    const { store } = memoryStore()
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder', date: DAY, timestamp: 1, status: 'claimed' as const, amount: 100,
    }))
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => [],
        checkInAs: async () => { throw new Error('must not be used') },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    await scheduler.sweepAll(false, 'qoder')
    scheduler.dispose()
    expect(checkIn).toHaveBeenCalledTimes(1)
  })

  it('keeps the active-only path when the credential list cannot be read', async () => {
    const { store } = memoryStore()
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder', date: DAY, timestamp: 1, status: 'claimed' as const, amount: 100,
    }))
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
        accounts: async () => { throw new Error('credential file unreadable') },
        checkInAs: async () => { throw new Error('must not be used') },
      }],
      isEnabled: () => true,
      store,
      now: () => AFTER_10,
    })

    await scheduler.sweepAll(false, 'qoder')
    scheduler.dispose()
    expect(checkIn).toHaveBeenCalledTimes(1)
  })

  it('persists per-account flags and rows through the JSON store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qoder-checkin-'))
    try {
      const file = join(dir, 'checkin-status.json')
      const store = new JsonFileCheckInStore(file)
      const scheduler = new CheckInScheduler({
        targets: [{
          variantId: 'qoder',
          checkIn: async () => { throw new Error('unused') },
          minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
          accounts: async () => [account('aaaa1111'), account('bbbb2222')],
          checkInAs: async a => ({
            variantId: 'qoder', date: DAY, timestamp: a.id === 'aaaa1111' ? 1 : 2,
            status: 'claimed' as const, amount: 100,
          }),
        }],
        isEnabled: () => true,
        store,
        now: () => AFTER_10,
      })

      await scheduler.sweepAll(false, 'qoder')
      scheduler.dispose()

      const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, CheckInRecord>
      const record = raw.qoder!
      // Both tokens recorded, both rows kept: a shared date+second key would have
      // let the second overwrite the first.
      expect(Object.keys(record.accounts ?? {})).toHaveLength(2)
      expect(record.logs).toHaveLength(2)
      expect(record.logs?.map(l => l.account?.id)).toEqual(['bbbb2222', 'aaaa1111'])
      // The token itself never reaches the status file.
      expect(JSON.stringify(raw)).not.toContain('pt-aaaa1111')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
