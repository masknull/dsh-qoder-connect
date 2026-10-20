import { describe, expect, it, vi } from 'vitest'
import { QoderUpstreamClient } from '../src/upstream.ts'
import type { QoderAccountInfo } from '../src/qoder/account.ts'
import type { QoderTransport } from '../src/qoder/transport/index.ts'

/**
 * The credit parse in all its shapes: how `fetchCredits` maps one
 * `readAccount` answer onto the card's `QoderCredits`, and what the expiry
 * fields do. The passthrough rule changed with the upstream: Qoder reports one
 * cycle-level `expiresAt` (not a per-package `PackageEndTime`), and it rides
 * to the card verbatim — this plugin never parses or recomputes it, leaving
 * "remaining days" to whatever locale formatting the renderer applies.
 */

function clientFor(account: QoderAccountInfo | undefined, readAccount?: QoderTransport['readAccount']) {
  const reader = readAccount ?? (vi.fn(async () => {
    if (account === undefined) throw new Error('account scripted absent')
    return account
  }) as never)
  const transport = {
    stream: () => { throw new Error('not used') },
    discoverModels: async () => [],
    readAccount: reader,
  } as unknown as QoderTransport
  return new QoderUpstreamClient({
    region: 'china',
    providerId: 'qoder',
    getPat: async () => 'pt-test',
    transport,
  })
}

function account(usage: QoderAccountInfo['usage']): QoderAccountInfo {
  return {
    profile: { id: 'u1', name: 'Qoder User', email: 'u@example.com' },
    ...(usage === undefined ? {} : { usage }),
    updatedAt: '2026-09-18T00:00:00Z',
  }
}

describe('fetchCredits shapes', () => {
  it('answers an account with no usage as zero credits and no packages', async () => {
    await expect(clientFor(account(undefined)).fetchCredits()).resolves.toEqual({
      total: 0, totalSize: 0, accounts: [],
    })
  })

  it('renders a personal quota as one package row without expiry fields', async () => {
    const credits = await clientFor(account({
      userQuota: { total: 100, used: 25, remaining: 75, percentage: 25, unit: 'credits' },
    })).fetchCredits()
    expect(credits).toEqual({
      total: 25,
      totalSize: 100,
      accounts: [{ packageName: '个人额度', remain: 75, size: 100 }],
    })
  })

  it('appends the organization package and carries the cycle fields verbatim', async () => {
    const credits = await clientFor(account({
      userQuota: { total: 100, used: 30, remaining: 70, percentage: 30, unit: 'credits' },
      orgResourcePackage: { total: 500, used: 100, remaining: 400, percentage: 20, unit: 'credits' },
      totalUsagePercentage: 33,
      isQuotaExceeded: true,
      expiresAt: '2026-10-01T00:00:00Z',
    })).fetchCredits()
    expect(credits.accounts).toEqual([
      { packageName: '个人额度', remain: 70, size: 100, packageEndTime: '2026-10-01T00:00:00Z' },
      { packageName: '组织资源包', remain: 400, size: 500, packageEndTime: '2026-10-01T00:00:00Z' },
    ])
    expect(credits.total).toBe(33)
    expect(credits.totalSize).toBe(600)
    expect(credits.cycleResetTime).toBe('2026-10-01T00:00:00Z')
    expect('unlimited' in credits).toBe(false)
  })

  it('reads an uncapped personal allowance as unlimited', async () => {
    const credits = await clientFor(account({
      userQuota: { total: 0, used: 5, remaining: 0, percentage: 0, unit: 'credits' },
      isQuotaExceeded: false,
    })).fetchCredits()
    expect(credits.unlimited).toBe(true)
  })

  it('passes every string through, even an empty one — verbatim is verbatim', async () => {
    // The WorkBuddy parser dropped empty PackageEndTime strings; the Qoder
    // answer has one expiresAt field checked for presence only. Locking the
    // difference so a "cleanup" here is a visible decision, not a silent one.
    const credits = await clientFor(account({
      userQuota: { total: 10, used: 1, remaining: 9, percentage: 10, unit: 'credits' },
      expiresAt: '',
    })).fetchCredits()
    expect(credits.accounts[0]).toEqual({ packageName: '个人额度', remain: 9, size: 10, packageEndTime: '' })
    expect(credits.cycleResetTime).toBe('')
  })

  it('lists bonus credits as their own package beside the plan', async () => {
    // Observed live: the account holds userQuota (300) and addOnQuota (100, the
    // daily campaign's credits). Mapping only the first made the card list one
    // package where the web listed two.
    const credits = await clientFor(account({
      userQuota: { total: 300, used: 0, remaining: 300, percentage: 0.01, unit: 'credits' },
      addOnQuota: { total: 100, used: 0, remaining: 100, percentage: 0, unit: 'credits' },
    })).fetchCredits()
    expect(credits.accounts.map(entry => entry.packageName)).toEqual(['个人额度', '赠送额度'])
    expect(credits.accounts[1]).toMatchObject({ remain: 100, size: 100 })
    // The cycle total now counts every bucket the account holds.
    expect(credits.totalSize).toBe(400)
  })

  it('carries the upstream itemized link for the summed bonus bucket', async () => {
    // The account page breaks 赠送额度 into several grants, each with its own
    // expiry, while this endpoint answers ONE summed number and no date. The
    // link is therefore the only honest answer to "when does this expire", and
    // it is region-correct for free: qoder.com international, qoder.com.cn
    // domestic — the upstream sends the right one per variant.
    const credits = await clientFor(account({
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
      addOnQuota: {
        total: 400,
        used: 90,
        remaining: 310,
        percentage: 23,
        unit: 'credits',
        detailUrl: 'https://qoder.com/account/usage',
      },
    })).fetchCredits()
    const addOn = credits.accounts.find(entry => entry.packageName === '赠送额度')
    expect(addOn).toEqual({
      packageName: '赠送额度',
      remain: 310,
      size: 400,
      detailUrl: 'https://qoder.com/account/usage',
    })
  })

  it('states no link for a bucket the upstream did not link', async () => {
    const credits = await clientFor(account({
      addOnQuota: { total: 100, used: 0, remaining: 100, percentage: 0, unit: 'credits' },
    })).fetchCredits()
    expect('detailUrl' in (credits.accounts[0] ?? {})).toBe(false)
  })

  it('omits the bonus package entirely when the upstream does not report one', async () => {
    const credits = await clientFor(account({
      userQuota: { total: 300, used: 0, remaining: 300, percentage: 0.01, unit: 'credits' },
    })).fetchCredits()
    expect(credits.accounts.map(entry => entry.packageName)).toEqual(['个人额度'])
  })

  it('lists a dedicated campaign package with its OWN title and expiry', async () => {
    // Observed live on Qoder Global: a 2,000-credit SOTA grant arrives in
    // `dedicatedResourcePackages`, unmapped by the first version of this
    // reader — the credit was real and invisible on every surface. Its own
    // expiry and localized title are the only honest ones: the account's
    // `expiresAt` is the year-9999 "never" sentinel and the package `name` is
    // an opaque campaign code.
    const credits = await clientFor(account({
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
      addOnQuota: { total: 100, used: 5, remaining: 95, percentage: 0.06, unit: 'credits' },
      isQuotaExceeded: false,
      dedicatedResourcePackages: [{
        id: '01a1426f-fe90-7201-b11e-18d563f31f8d',
        name: 'act-20261014-129',
        total: 2000,
        used: 0,
        remaining: 2000,
        percentage: 0,
        unit: 'credits',
        expiresAt: '2026-10-19T02:00:00.000Z',
        title: { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' },
        available: true,
        status: 'QUOTA_DETAIL_STATUS_ACTIVE',
      }],
    })).fetchCredits()
    expect(credits.accounts.map(entry => entry.packageName)).toEqual(['个人额度', '赠送额度', 'SOTA 专属积分'])
    expect(credits.accounts[2]).toEqual({
      packageName: 'SOTA 专属积分',
      packageNameI18n: { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' },
      packageCode: 'act-20261014-129',
      remain: 2000,
      size: 2000,
      packageEndTime: '2026-10-19T02:00:00.000Z',
    })
    // The grant's total joins the account denominator the dashboard divides by.
    expect(credits.totalSize).toBe(2100)
    // The sentinel already dropped at the transport means there is no
    // account-wide date to claim; nothing here invents one.
    expect('cycleResetTime' in credits).toBe(false)
  })

  it('labels a dedicated package with its code when the upstream sent no title', async () => {
    // A grant without `displayLabels` still shows its amount: an opaque name
    // beats a hidden package, and the row stays honest about what it is.
    const credits = await clientFor(account({
      dedicatedResourcePackages: [{ total: 50, used: 0, remaining: 50, percentage: 0, unit: 'credits', name: 'act-x' }],
    })).fetchCredits()
    expect(credits.accounts[0]).toEqual({
      packageName: 'act-x',
      packageCode: 'act-x',
      remain: 50,
      size: 50,
    })
    expect('packageEndTime' in (credits.accounts[0] ?? {})).toBe(false)
  })

  it('falls back to 专属资源包 when a grant carries neither a title nor a name', async () => {
    const credits = await clientFor(account({
      dedicatedResourcePackages: [{ total: 10, used: 0, remaining: 10, percentage: 0, unit: 'credits' }],
    })).fetchCredits()
    expect(credits.accounts[0]?.packageName).toBe('专属资源包')
  })

  it('carries one title per grant when the account stacks several', async () => {
    const credits = await clientFor(account({
      dedicatedResourcePackages: [
        { total: 2000, used: 0, remaining: 2000, percentage: 0, unit: 'credits', title: { zh: 'SOTA 专属积分' }, expiresAt: '2026-10-19T02:00:00.000Z' },
        { total: 300, used: 0, remaining: 300, percentage: 0, unit: 'credits', title: { zh: '体验包' }, expiresAt: '2026-11-01T02:00:00.000Z' },
      ],
    })).fetchCredits()
    // Distinct names stay distinct rows (the merge keys on the name); each
    // keeps its own deadline rather than sharing one account date.
    expect(credits.accounts.map(entry => [entry.packageName, entry.packageEndTime])).toEqual([
      ['SOTA 专属积分', '2026-10-19T02:00:00.000Z'],
      ['体验包', '2026-11-01T02:00:00.000Z'],
    ])
    expect(credits.totalSize).toBe(2300)
  })

  it('always asks the transport for a fresh read', async () => {
    const readAccount = vi.fn(async () => account(undefined))
    await clientFor(undefined, readAccount as never).fetchCredits()
    expect(readAccount).toHaveBeenCalledWith({ force: true })
  })

  it('propagates an upstream failure for the status route to classify', async () => {
    const reader = vi.fn(async () => { throw new Error('AUTH 401') })
    await expect(clientFor(undefined, reader as never).fetchCredits()).rejects.toThrow('AUTH 401')
  })
})
