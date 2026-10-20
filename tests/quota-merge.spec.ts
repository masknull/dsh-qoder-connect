import { describe, expect, it } from 'vitest'
import { accountDisplayName, clampPercent, currentLanguage, detailUrlHost, formatExpiryText, formatPercentText, mergeCreditAccounts, setActiveLanguage, sortPackageRows, usedPercentText, visibleQuotaGroups } from '../src/client/quota-merge.ts'
import type { QuotaGroup } from '../src/client/quota-merge.ts'
import type { QoderWebCreditAccount } from '../src/status-paths.ts'

/**
 * The sidebar card's merge layer over the Qoder credit answer. The upstream
 * reports one entry per purchased package (and Qoder stacks repeated purchases
 * of the same package name), so the overview row groups by NAME alone while
 * the itemised table keeps every row and only re-orders it. These cases pin the
 * rules the user ruled on: missing figures count as 0, unlimited is sticky, the
 * earliest expiry travels with the group, and first-seen package order is never
 * reshuffled by the merge.
 *
 * Quota semantics this layer is written against (from `QoderWebCredits` in
 * `src/status-paths.ts`): `total` is the percentage of the cycle ALREADY USED
 * (`userQuota.percentage`), the card's headline — it is not a denominator, so
 * nothing here touches it; `totalSize` is the summed per-package total the
 * dashboard divides by; a single bar's share comes only from its own
 * `remain / size` through {@link clampPercent}. `cycleResetTime` is the cycle
 * deadline printed beside these rows, carried verbatim; a group's own expiry is
 * the earliest member `packageEndTime`, never a recomputed date.
 */
const acct = (
  packageName: string,
  remain: number,
  size: number,
  extra: Partial<QoderWebCreditAccount> = {},
): QoderWebCreditAccount => ({ packageName, remain, size, ...extra })

describe('mergeCreditAccounts', () => {
  it('keeps distinct packages apart', () => {
    const groups = mergeCreditAccounts([acct('A包', 100, 200), acct('B包', 50, 100)])
    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.packageName).sort()).toEqual(['A包', 'B包'])
  })

  it('sums same name + same expiry, keeping the expiry', () => {
    const groups = mergeCreditAccounts([
      acct('Pro Pack', 300, 500, { packageEndTime: '2026-03-01 00:00:00' }),
      acct('Pro Pack', 200, 500, { packageEndTime: '2026-03-01 00:00:00' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.remain).toBe(500)
    expect(groups[0]?.size).toBe(1000)
    expect(groups[0]?.packageEndTime).toBe('2026-03-01 00:00:00')
  })

  it('merges same name with different expiry (name is the key)', () => {
    // The user's correction: stacked purchase batches of one package whose
    // cycle deadlines differ by seconds must still be ONE overview row.
    const groups = mergeCreditAccounts([
      acct('Pro Pack', 300, 500, { packageEndTime: '2026-04-01 00:00:00' }),
      acct('Pro Pack', 200, 500, { packageEndTime: '2026-03-01 00:00:00' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.remain).toBe(500)
    expect(groups[0]?.size).toBe(1000)
    // The EARLIEST deadline travels with the group (operationally meaningful).
    expect(groups[0]?.packageEndTime).toBe('2026-03-01 00:00:00')
  })

  it('merges dated with undated packages of one name, keeping the date', () => {
    const groups = mergeCreditAccounts([
      acct('Pro Pack', 300, 500, { packageEndTime: '2026-03-01 00:00:00' }),
      acct('Pro Pack', 200, 500),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.packageEndTime).toBe('2026-03-01 00:00:00')
  })

  it('keeps the first-seen row order, whatever the sums come out as', () => {
    // The card renders these bars in upstream order; a merge that sorted or
    // regrouped them would move rows the user reads as a fixed list.
    const groups = mergeCreditAccounts([
      acct('Org Resource', 1, 2),
      acct('Pro Pack', 3, 4),
      acct('Org Resource', 5, 6),
      acct('Plan', 7, 8),
    ])
    expect(groups.map(g => g.packageName)).toEqual(['Org Resource', 'Pro Pack', 'Plan'])
  })

  it('counts missing figures as 0 in the sum', () => {
    const groups = mergeCreditAccounts([
      acct('Pro Pack', 300, 500, { packageEndTime: '2026-03-01 00:00:00' }),
      acct('Pro Pack', 100, 0, { packageEndTime: '2026-03-01 00:00:00' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.remain).toBe(400)
    expect(groups[0]?.size).toBe(500)
  })

  it('makes the whole group unlimited when any member is', () => {
    const groups = mergeCreditAccounts([
      acct('Org Resource', 0, 0, { unlimited: true, packageEndTime: '2026-03-01 00:00:00' }),
      acct('Org Resource', 100, 200, { packageEndTime: '2026-03-01 00:00:00' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.unlimited).toBe(true)
  })

  it('preserves first-seen order', () => {
    const groups = mergeCreditAccounts([acct('B包', 1, 2), acct('A包', 3, 4), acct('B包', 5, 6)])
    expect(groups.map(g => g.packageName)).toEqual(['B包', 'A包'])
  })

  it('yields empty groups for empty input', () => {
    expect(mergeCreditAccounts([])).toEqual([])
  })
})

describe('visibleQuotaGroups', () => {
  const group = (over: Partial<QuotaGroup>): QuotaGroup => ({
    packageName: 'P',
    packageEndTime: undefined,
    remain: 100,
    size: 200,
    unlimited: false,
    detailUrl: undefined,
    ...over,
  })

  it('hides an exhausted group when others have credit', () => {
    const groups = [group({ packageName: '用完', remain: 0, size: 100 }), group({ packageName: '有量', remain: 50, size: 100 })]
    expect(visibleQuotaGroups(groups).map(g => g.packageName)).toEqual(['有量'])
  })

  it('hides an exhausted DATED group even when everything is exhausted', () => {
    const groups = [
      group({ packageName: '过期', remain: 0, size: 100, packageEndTime: '2026-01-01 00:00:00' }),
      group({ packageName: '过期2', remain: 0, size: 100, packageEndTime: '2026-02-01 00:00:00' }),
    ]
    expect(visibleQuotaGroups(groups)).toEqual([])
  })

  it('shows an exhausted UNDATED group when everything is exhausted', () => {
    const groups = [
      group({ packageName: '过期', remain: 0, size: 100, packageEndTime: '2026-01-01 00:00:00' }),
      group({ packageName: '常驻', remain: 0, size: 100 }),
    ]
    expect(visibleQuotaGroups(groups).map(g => g.packageName)).toEqual(['常驻'])
  })

  it('always renders unlimited groups', () => {
    const groups = [group({ packageName: '企业', remain: 0, size: 0, unlimited: true })]
    expect(visibleQuotaGroups(groups)).toHaveLength(1)
  })

  it('renders everything when nothing is exhausted', () => {
    const groups = [group({ packageName: 'A' }), group({ packageName: 'B', packageEndTime: '2026-05-01 00:00:00' })]
    expect(visibleQuotaGroups(groups)).toHaveLength(2)
  })
})

describe('sortPackageRows', () => {
  // The panel's itemised table: every live row renders, spent-but-not-lapsed
  // rows sink to the bottom, lapsed rows are dropped. "now" is injectable.
  const NOW = Date.parse('2026-06-01T00:00:00')

  it('drops the expired rows and sinks the spent ones, keeping first-seen order', () => {
    const rows = [
      acct('spent', 0, 100, { packageEndTime: '2026-01-01 00:00:00' }),
      acct('live-b', 10, 100),
      acct('empty', 0, 100),
      acct('live-a', 20, 100),
      acct('lapsed', 0, 100, { packageEndTime: '2026-01-01 00:00:00' }),
    ]
    expect(sortPackageRows(rows, NOW).map(row => row.packageName)).toEqual(['live-b', 'live-a', 'empty'])
  })

  it('keeps an unlimited row live even with nothing left', () => {
    const rows = [acct('Org Resource', 0, 0, { unlimited: true })]
    expect(sortPackageRows(rows, NOW)).toEqual(rows)
  })

  it('never invents an expiry: an unparseable date keeps the row alive', () => {
    const rows = [acct('Plan', 0, 100, { packageEndTime: 'not a date' })]
    expect(sortPackageRows(rows, NOW).map(row => row.packageName)).toEqual(['Plan'])
  })

  it('returns an empty table for empty input', () => {
    expect(sortPackageRows([], NOW)).toEqual([])
  })
})

describe('clampPercent', () => {
  it('refuses a non-positive denominator', () => {
    expect(clampPercent(50, 0)).toBeUndefined()
  })
  it('refuses a non-finite result instead of claiming a full bar', () => {
    expect(clampPercent(Number.POSITIVE_INFINITY, 1)).toBeUndefined()
  })
  it('clamps into [0, 100]', () => {
    expect(clampPercent(0, 100)).toBe(0)
    expect(clampPercent(150, 100)).toBe(100)
    expect(clampPercent(-10, 100)).toBe(0)
    expect(clampPercent(50, 100)).toBe(50)
  })
})

describe('usedPercentText', () => {
  it('reads the same ratio as usage, matching Qoder desktop', () => {
    // The desktop's own panel: "0 / 2,000 (已使用 0%)" and "60 / 2,400 (已使用 3%)".
    expect(usedPercentText(2000, 2000)).toBe('0')
    expect(usedPercentText(2340, 2400)).toBe('3')
  })
  it('states nothing when there is no ratio to state', () => {
    expect(usedPercentText(50, 0)).toBeUndefined()
    expect(usedPercentText(Number.POSITIVE_INFINITY, 1)).toBeUndefined()
  })
  it('never states a negative or over-100 usage', () => {
    expect(usedPercentText(150, 100)).toBe('0')
    expect(usedPercentText(-10, 100)).toBe('100')
  })
  it('stays whole percent even though the ratio column carries decimals', () => {
    // The suffix rides inside the package label, where two decimals would push
    // the sidebar's label past the room its row has and ellipsize it.
    expect(usedPercentText(2291, 2300)).toBe('0')
  })
})

describe('formatPercentText', () => {
  it('keeps two decimals — the figure the two surfaces disagreed on', () => {
    // The sidebar said "100%" while the settings card said "99.6%".
    expect(formatPercentText(99.6087)).toBe('99.61')
  })
  it('leaves a whole value whole instead of padding it with zeros', () => {
    expect(formatPercentText(100)).toBe('100')
    expect(formatPercentText(0)).toBe('0')
  })
})

describe('accountDisplayName', () => {
  // A campaign grant arrives with a localized title (`SOTA 专属积分` /
  // `SOTA Exclusive Credits`); the two surfaces that print it — the sidebar
  // card and the itemised table — must print the SAME one for the SAME
  // package, which is why the choice lives here rather than in either card.
  const grant = acct('SOTA 专属积分', 2000, 2000, {
    packageNameI18n: { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' },
    packageCode: 'act-20261014-129',
  })

  it('uses the requested language when the upstream sent a title map', () => {
    expect(accountDisplayName(grant, 'zh')).toBe('SOTA 专属积分')
    expect(accountDisplayName(grant, 'en')).toBe('SOTA Exclusive Credits')
  })

  it('falls back to the other language when the active one is missing', () => {
    expect(accountDisplayName(acct('包', 1, 1, { packageNameI18n: { zh: '包' } }), 'en')).toBe('包')
    expect(accountDisplayName(acct('Pack', 1, 1, { packageNameI18n: { en: 'Pack' } }), 'zh')).toBe('Pack')
  })

  it('keeps the plain name for a package with no title map', () => {
    expect(accountDisplayName(acct('个人额度', 0, 0), 'en')).toBe('个人额度')
  })

  it('reads the active language when none is passed', () => {
    const previous = currentLanguage()
    try {
      setActiveLanguage('en')
      expect(currentLanguage()).toBe('en')
      expect(accountDisplayName(grant)).toBe('SOTA Exclusive Credits')
      setActiveLanguage('zh-CN')
      expect(accountDisplayName(grant)).toBe('SOTA 专属积分')
      // Anything not English selects Chinese: the plugin's own copy is
      // Chinese-first, so a third language must not leave the row unnamed.
      setActiveLanguage('fr')
      expect(accountDisplayName(grant)).toBe('SOTA 专属积分')
    } finally {
      setActiveLanguage(previous)
    }
  })
})

describe('formatExpiryText', () => {
  it('localizes an ISO instant instead of printing it verbatim', () => {
    // The panel once put "2026-10-19T02:00:00.000Z" in a date column: not
    // readable, and in UTC while the user's own clock said 10:00 of that day.
    const text = formatExpiryText('2026-10-19T02:00:00.000Z')!
    expect(text).toContain('2026')
    expect(text).not.toContain('T02:00:00.000Z')
  })

  it('leaves an unparseable value verbatim rather than inventing a date', () => {
    expect(formatExpiryText('not a date')).toBe('not a date')
  })

  it('states nothing about a package with no expiry', () => {
    expect(formatExpiryText(undefined)).toBeUndefined()
  })
})

describe('detailUrlHost', () => {
  // The link label is how the card stays region-correct without a single
  // variant-specific constant: the upstream sends qoder.com for the
  // international edition and qoder.com.cn for the Chinese one, and the card
  // prints whichever host the bucket actually points at.
  it('names the site the link points at', () => {
    expect(detailUrlHost('https://qoder.com/account/usage')).toBe('qoder.com')
    expect(detailUrlHost('https://qoder.com.cn/account/usage')).toBe('qoder.com.cn')
  })

  it('keeps a port rather than truncating the host', () => {
    expect(detailUrlHost('https://qoder.com:8443/account/usage')).toBe('qoder.com:8443')
  })

  it('states nothing for a missing or malformed link instead of labelling a dead anchor', () => {
    expect(detailUrlHost(undefined)).toBeUndefined()
    expect(detailUrlHost('not a url')).toBeUndefined()
  })
})

describe('mergeCreditAccounts with titles', () => {
  it('carries the first member title map onto the group', () => {
    const groups = mergeCreditAccounts([
      acct('SOTA 专属积分', 2000, 2000, { packageNameI18n: { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' } }),
      acct('SOTA 专属积分', 500, 500, { packageNameI18n: { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' } }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.remain).toBe(2500)
    expect(accountDisplayName(groups[0]!, 'en')).toBe('SOTA Exclusive Credits')
  })
})

describe('mergeCreditAccounts with detail links', () => {
  it('carries the member link onto the group so the row can offer the page', () => {
    const groups = mergeCreditAccounts([
      acct('赠送额度', 310, 400, { detailUrl: 'https://qoder.com/account/usage' }),
    ])
    expect(groups[0]?.detailUrl).toBe('https://qoder.com/account/usage')
  })

  it('keeps a link from a later member when the first had none', () => {
    const groups = mergeCreditAccounts([
      acct('赠送额度', 100, 100),
      acct('赠送额度', 210, 300, { detailUrl: 'https://qoder.com.cn/account/usage' }),
    ])
    expect(groups[0]?.remain).toBe(310)
    expect(groups[0]?.detailUrl).toBe('https://qoder.com.cn/account/usage')
  })

  it('leaves the group link undefined when no member reported one', () => {
    const groups = mergeCreditAccounts([acct('个人额度', 0, 0)])
    expect(groups[0]?.detailUrl).toBeUndefined()
  })
})
