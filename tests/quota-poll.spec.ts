import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireLiveCard,
  acquireLiveSurface,
  noteQuotaStatus,
  quotaPollMs,
  quotaReadFailure,
  quotaStatus,
  quotaStatusFetchedAt,
  refreshQuotaStatus,
  resetQuotaStatusForTesting,
  setQuotaPollMs,
} from '../src/client/quota-settings-store.ts'
import { QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from '../src/status-paths.ts'
import type { QoderWebStatus } from '../src/status-paths.ts'

/**
 * The shared status poller: ONE ticker, one read per live variant, published
 * once for every surface.
 *
 * The poller is the meeting point of three surfaces — the expanded settings
 * cards, the enabled sidebar cards, and the open quota panel. Each acquires
 * its variant; the store keeps the holder counts, reads each live variant at
 * the tightest cadence its holders ask for, and publishes through a sequence
 * guard so a late answer can never roll a newer one back. These tests drive
 * the real store with a captured ticker and a stubbed fetch, so the behaviour
 * under test is the registry's, not a re-implementation.
 */

/** A signed-in document whose credits identify which read produced it. */
function doc(total: number, variant: 'qoder' | 'qoder-global' = 'qoder'): QoderWebStatus {
  return {
    status: 'signed-in',
    region: variant === 'qoder' ? 'china' : 'global',
    pat: { source: 'card', savedAtMs: 1_700_000_000_000, patTail: 'abcd' },
    authKey: `${variant}-auth-key`,
    credits: { total, totalSize: 100, accounts: [] },
    models: [],
  }
}

function signedOut(variant: 'qoder' | 'qoder-global' = 'qoder'): QoderWebStatus {
  return { status: 'signed-out', authKey: `${variant}-auth-key` }
}

describe('shared quota poller', () => {
  /** Every status GET, in call order. */
  const gets: string[] = []
  /** Resolvers for held reads, so "in flight" is observable, not a race. */
  const held = new Map<number, (body: unknown) => void>()
  /** Whether the next read hangs until its index is released. */
  let holdNextRead = false
  /** The body every read answers with, unless the plan overrides it. */
  let reply: (url: string, index: number) => unknown = url => (url === QODER_GLOBAL_STATUS_PATH ? signedOut('qoder-global') : doc(40))
  /** The ticker handlers the store armed, keyed by handle. */
  const tickers = new Map<number, () => void>()
  const cleared: number[] = []
  let nextHandle = 1

  /** Fire every armed ticker and let the reads it started settle. */
  async function tick(): Promise<void> {
    for (const handler of [...tickers.values()]) handler()
    await vi.waitFor(() => {})
  }

  let clock = Date.parse('2024-05-01T00:00:00.000Z')

  beforeEach(() => {
    gets.length = 0
    held.clear()
    holdNextRead = false
    tickers.clear()
    cleared.length = 0
    nextHandle = 1
    clock += 10 * 60_000
    vi.useFakeTimers()
    vi.setSystemTime(clock)
    setQuotaPollMs(300_000)
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const index = gets.length
      gets.push(String(input))
      if (holdNextRead) {
        holdNextRead = false
        return await new Promise<Response>(resolve => {
          held.set(index, body => { resolve({ ok: true, status: 200, json: async () => body } as unknown as Response) })
        })
      }
      return { ok: true, status: 200, json: async () => reply(String(input), index) }
    }))
    vi.stubGlobal('window', {
      setInterval: (handler: () => void) => {
        const handle = nextHandle++
        tickers.set(handle, handler)
        return handle
      },
      clearInterval: (handle: number) => {
        cleared.push(handle)
        tickers.delete(handle)
      },
    })
  })

  afterEach(() => {
    resetQuotaStatusForTesting()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads each live variant once per tick, whatever the number of holders', async () => {
    const releaseA = acquireLiveCard('qoder')
    await vi.waitFor(() => { expect(quotaStatus('qoder')).toBeDefined() })
    expect(gets).toHaveLength(1)

    // A second card opens beside the live one: no second read.
    const releaseB = acquireLiveCard('qoder')
    await vi.waitFor(() => {})
    expect(gets).toHaveLength(1)

    await tick()
    // One tick, one read — not one per holder.
    expect(gets).toHaveLength(2)

    releaseA()
    releaseB()
  })

  it('arms no ticker and reads nothing while nothing holds a variant', async () => {
    expect(tickers.size).toBe(0)
    await tick()
    expect(gets).toHaveLength(0)
  })

  it('stops the ticker when the last holder releases', async () => {
    const release = acquireLiveCard('qoder')
    await vi.waitFor(() => { expect(quotaStatus('qoder')).toBeDefined() })
    expect(tickers.size).toBe(1)

    release()
    expect(cleared).toHaveLength(1)
    await tick()
    expect(gets).toHaveLength(1) // the mount read only; no tick followed
  })

  it('a second holder within the minute shows the shared document instead of re-reading', async () => {
    const releaseCard = acquireLiveCard('qoder')
    await vi.waitFor(() => { expect(quotaStatus('qoder')).toBeDefined() })
    expect(gets).toHaveLength(1)

    // A second surface (the quota panel) opens beside the live card: its
    // acquire reads nothing, because the document is within its cadence.
    const releasePanel = acquireLiveSurface('qoder')
    await vi.waitFor(() => {})
    expect(gets).toHaveLength(1)

    releaseCard()
    releasePanel()
  })

  it('parks a signed-out variant for card holders and keeps reading it for a surface holder', async () => {
    reply = () => signedOut()
    const release = acquireLiveCard('qoder')
    await vi.waitFor(() => { expect(quotaStatus('qoder')).toBeDefined() })
    const readsAfterMount = gets.length

    // Nothing changes without a PAT, so the cards' poll parks.
    await tick()
    expect(gets).toHaveLength(readsAfterMount)

    // A surface holder (an enabled sidebar card) keeps the settings interval
    // whatever the sign-in state — the user's design for that card.
    const releaseSidebar = acquireLiveSurface('qoder')
    clock += 5 * 60_000
    vi.setSystemTime(clock)
    await tick()
    expect(gets.length).toBeGreaterThan(readsAfterMount)

    release()
    releaseSidebar()
  })

  it('reads a surface holder at the settings interval, not at the card minute', async () => {
    setQuotaPollMs(300_000)
    const release = acquireLiveSurface('qoder')
    await vi.waitFor(() => { expect(quotaStatus('qoder')).toBeDefined() })
    const readsAfterMount = gets.length

    // One minute on: not due yet at the 5-minute interval.
    clock += 60_000
    vi.setSystemTime(clock)
    await tick()
    expect(gets).toHaveLength(readsAfterMount)

    // Past the interval: the tick reads.
    clock += 5 * 60_000
    vi.setSystemTime(clock)
    await tick()
    expect(gets.length).toBeGreaterThan(readsAfterMount)
    expect(quotaPollMs()).toBe(300_000)

    release()
  })

  it('reads each variant independently: one held variant does not read the other', async () => {
    reply = url => doc(url === QODER_GLOBAL_STATUS_PATH ? 20 : 40, url === QODER_GLOBAL_STATUS_PATH ? 'qoder-global' : 'qoder')
    const releaseCn = acquireLiveCard('qoder')
    const releaseGlobal = acquireLiveCard('qoder-global')
    await vi.waitFor(() => { expect(quotaStatus('qoder-global')).toBeDefined() })
    expect(gets).toHaveLength(2) // one mount read per variant

    await tick()
    expect(gets.filter(url => url === QODER_STATUS_PATH)).toHaveLength(2)
    expect(gets.filter(url => url === QODER_GLOBAL_STATUS_PATH)).toHaveLength(2)

    releaseCn()
    releaseGlobal()
  })

  it('publishes one document for every surface: the store holds the latest read', async () => {
    reply = (_url, index) => doc(index === 0 ? 40 : 7)
    const release = acquireLiveCard('qoder')
    await vi.waitFor(() => { expect(quotaStatus('qoder')?.status).toBe('signed-in') })

    await tick()
    await vi.waitFor(() => {
      expect((quotaStatus('qoder') as { credits?: { total: number } }).credits?.total).toBe(7)
    })

    release()
  })

  it('keeps the document whose read started last when an older read settles first', async () => {
    reply = (_url, index) => doc(index === 2 ? 7 : 77)
    const release = acquireLiveCard('qoder') // read #0
    await vi.waitFor(() => { expect(quotaStatus('qoder')).toBeDefined() })

    holdNextRead = true
    const manual = refreshQuotaStatus('qoder') // read #1, held
    await tick() // read #2 settles first
    await vi.waitFor(() => {
      expect((quotaStatus('qoder') as { credits?: { total: number } }).credits?.total).toBe(7)
    })

    // The held read answers with the OLDER body: the sequence guard drops it.
    await vi.waitFor(() => { expect(held.size).toBe(1) })
    held.get(1)!(doc(77))
    await manual
    await vi.waitFor(() => {})
    expect((quotaStatus('qoder') as { credits?: { total: number } }).credits?.total).toBe(7)

    release()
  })

  it('publishes a read failure to every surface and clears it on the next success', async () => {
    const release = acquireLiveCard('qoder')
    await vi.waitFor(() => { expect(quotaStatus('qoder')).toBeDefined() })

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket died') }))
    await tick()
    await vi.waitFor(() => { expect(quotaReadFailure('qoder')).toEqual({ kind: 'transport', message: 'socket died' }) })
    // The document stays on screen beside the failure.
    expect(quotaStatus('qoder')?.status).toBe('signed-in')

    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      gets.push(String(input))
      return { ok: true, status: 200, json: async () => doc(11) }
    }))
    await tick()
    await vi.waitFor(() => { expect(quotaReadFailure('qoder')).toBeUndefined() })
    expect((quotaStatus('qoder') as { credits?: { total: number } }).credits?.total).toBe(11)

    release()
  })

  it('a 200 that is not a status document is an invalid read, not a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => null })))
    const release = acquireLiveCard('qoder')
    await vi.waitFor(() => { expect(quotaReadFailure('qoder')).toEqual({ kind: 'invalid' }) })
    expect(quotaStatus('qoder')).toBeUndefined()
    release()
  })

  it("a write's published outcome supersedes a read that started before it", async () => {
    const release = acquireLiveCard('qoder') // read #0 settles
    await vi.waitFor(() => { expect(quotaStatus('qoder')).toBeDefined() })

    // A read starts, then the host answers a write: the write's fact is
    // authoritative, so the older read's answer must not roll it back.
    holdNextRead = true
    const stale = refreshQuotaStatus('qoder')
    await vi.waitFor(() => { expect(held.size).toBe(1) })
    noteQuotaStatus('qoder', signedOut())
    held.get(1)!(doc(99))
    await stale
    await vi.waitFor(() => {})
    expect(quotaStatus('qoder')?.status).toBe('signed-out')

    release()
  })

  it('records the fetch time the surfaces print as the update time', async () => {
    const release = acquireLiveCard('qoder')
    await vi.waitFor(() => { expect(quotaStatusFetchedAt('qoder')).toBeDefined() })
    const first = quotaStatusFetchedAt('qoder')

    clock += 10 * 60_000
    vi.setSystemTime(clock)
    await tick()
    await vi.waitFor(() => { expect(quotaStatusFetchedAt('qoder')).not.toBe(first) })
    // The published fetch time is the read's own settle time, at or after the
    // clock the tick fired on.
    expect(quotaStatusFetchedAt('qoder')!).toBeGreaterThanOrEqual(clock)

    release()
  })
})
