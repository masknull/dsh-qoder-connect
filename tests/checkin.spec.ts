import { describe, expect, it, vi } from 'vitest'
import { QoderCheckInService } from '../src/qoder/transport/checkin.ts'
import type { QoderAuthService } from '../src/qoder/transport/auth.ts'
import {
  CheckInScheduler,
  type CheckInStatusStore,
  type CheckInRecord,
  getUtc8DateString,
  msUntilNext10amUtc8,
  shouldCatchUp,
} from '../src/checkin-scheduler.ts'
import { QoderLlmError } from '../src/qoder/errors.ts'

describe('QoderCheckInService', () => {
  function createMockAuth(token = 'mock-job-token'): QoderAuthService {
    return {
      getCredentials: vi.fn(async () => ({ authToken: token, userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
      exchangeFresh: vi.fn(async () => ({ authToken: token + '-fresh', userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
      clear: vi.fn(),
    } as unknown as QoderAuthService
  }

  it('rejects with error result when PAT is empty', async () => {
    const auth = createMockAuth()
    const service = new QoderCheckInService({ authService: auth, variantId: 'qoder', region: 'china' })
    const result = await service.checkIn('')
    expect(result.status).toBe('error')
    expect(result.message).toContain('No PAT')
  })

  it('successfully claims daily benefit when campaign is claimable', async () => {
    const auth = createMockAuth('valid-token')
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (urlStr.includes('/sash/api/v1/me/campaigns') && (!init?.method || init.method === 'GET')) {
        expect(headers['cosy-clienttype']).toBe('10')
        expect(headers['cosy-version']).toBe('0.3.4')
        expect(headers['user-agent']).toBe('Qoder')
        expect(headers['origin']).toBe('https://openapi.qoder.com.cn')
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
        expect(headers['cosy-clienttype']).toBe('10')
        expect(headers['cosy-version']).toBe('0.3.4')
        expect(headers['user-agent']).toBe('Qoder')
        expect(headers['origin']).toBe('https://openapi.qoder.com.cn')
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

  it('returns no-campaign when no CLAIM_BENEFIT campaign exists (like current Global)', async () => {
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

  it('self-heals with exchangeFresh when auth token is rejected with 401', async () => {
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
  it('calculates msUntilNext10amUtc8 correctly before and after 10:00', () => {
    // 08:00 UTC+8 (00:00 UTC) -> 2 hours left
    const morningUtc8 = new Date('2026-09-21T00:00:00.000Z').getTime()
    const diffMorning = msUntilNext10amUtc8(morningUtc8)
    // Roughly 2 hours (7205000 ms +/- precision)
    expect(diffMorning).toBeGreaterThan(7_100_000)
    expect(diffMorning).toBeLessThan(7_300_000)

    // 12:00 UTC+8 (04:00 UTC) -> next day 10:00:05 (roughly 22 hours left)
    const afternoonUtc8 = new Date('2026-09-21T04:00:00.000Z').getTime()
    const diffAfternoon = msUntilNext10amUtc8(afternoonUtc8)
    expect(diffAfternoon).toBeGreaterThan(21 * 3600 * 1000)
    expect(diffAfternoon).toBeLessThan(23 * 3600 * 1000)
  })

  it('evaluates shouldCatchUp: true only when past 10:00 and not checked in today', () => {
    const today = '2026-09-21'
    // Before 10:00 UTC+8 (01:00 UTC = 09:00 UTC+8)
    const before10 = new Date('2026-09-21T01:00:00.000Z').getTime()
    expect(shouldCatchUp(today, undefined, before10)).toBe(false)

    // After 10:00 UTC+8 (03:00 UTC = 11:00 UTC+8), no prior checkin
    const after10 = new Date('2026-09-21T03:00:00.000Z').getTime()
    expect(shouldCatchUp(today, undefined, after10)).toBe(true)

    // After 10:00, but already checked in today
    expect(shouldCatchUp(today, today, after10)).toBe(false)
  })

  it('runs catchup and updates store when enabled', async () => {
    const storeRecords: Record<string, CheckInRecord> = {}
    const store: CheckInStatusStore = {
      read: (id) => storeRecords[id],
      write: (id, record) => { storeRecords[id] = record },
      clearLogs: (id) => { if (storeRecords[id]) storeRecords[id].logs = [] },
    }

    const mockService = {
      checkIn: vi.fn(async () => ({
        variantId: 'qoder',
        date: '2026-09-21',
        timestamp: Date.now(),
        status: 'claimed' as const,
        amount: 100,
      })),
    } as unknown as QoderCheckInService

    const onClaimed = vi.fn()
    const after10 = new Date('2026-09-21T04:00:00.000Z').getTime()

    const scheduler = new CheckInScheduler({
      targets: [
        {
          variantId: 'qoder',
          service: mockService,
          getPat: async () => 'pat-ok',
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

    expect(mockService.checkIn).toHaveBeenCalledWith('pat-ok')
    expect(onClaimed).toHaveBeenCalled()
    expect(storeRecords.qoder?.status).toBe('claimed')
    expect(storeRecords.qoder?.lastDate).toBe('2026-09-21')
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
