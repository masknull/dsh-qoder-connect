/**
 * Sidebar quota merging: collapse same-named packages sharing an expiry.
 *
 * The upstream reports one entry per purchased package. A single account can
 * hold several entries of the SAME package name (repeated purchases stack), so
 * the sidebar card groups them into one bar per (packageName, packageEndTime)
 * pair instead of listing near-duplicates. This module is the whole merge —
 * a pure function over the status document's credit accounts, driven by Node
 * tests, with no React and no fetch.
 */

import type { QoderWebCreditAccount } from '../status-paths.ts'

/** Languages the plugin can label a package in (the upstream sends `zh`/`en`). */
export type QuotaTitleLanguage = 'zh' | 'en'

/**
 * The active UI language, kept here because the sidebar card and the dashboard
 * label the SAME package and must not pick different words for it.
 *
 * The client entry mirrors `ctx.locale` into this one setter; a build or a test
 * that never calls it leaves `zh` as the answer, which is the language the
 * plugin's own copy and its Chinese-first users read.
 */
let activeLanguage: QuotaTitleLanguage = 'zh'

/** Record the host's active locale; anything but `en` selects the Chinese title. */
export function setActiveLanguage(localeId: string | undefined): void {
  activeLanguage = typeof localeId === 'string' && localeId.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** The language currently labelling packages. */
export function currentLanguage(): QuotaTitleLanguage {
  return activeLanguage
}

/**
 * The label one credit account renders with.
 *
 * `packageName` is the host's single-language best guess (the upstream sends a
 * localized title only for campaign grants). Where a title map exists, the
 * active language wins and the other language backstops it, so an English UI
 * says "SOTA Exclusive Credits" and a Chinese one says "SOTA 专属积分" about one
 * package — never the campaign code the upstream `name` field carries.
 */
export function accountDisplayName(
  account: { packageName: string; packageNameI18n?: { zh?: string | undefined; en?: string | undefined } },
  language: QuotaTitleLanguage = activeLanguage,
): string {
  const titles = account.packageNameI18n
  if (titles === undefined) return account.packageName
  const other: QuotaTitleLanguage = language === 'en' ? 'zh' : 'en'
  return titles[language] ?? titles[other] ?? account.packageName
}

/**
 * Format an upstream expiry instant the way every quota surface prints dates.
 *
 * The card once printed the raw ISO string ("2026-10-19T02:00:00.000Z") in a
 * date column: unreadable, and in UTC at that — the day a user's grant ends is
 * the day on their clock, so the render is localized rather than verbatim. An
 * unparseable value stays verbatim rather than becoming a made-up date.
 */
export function formatExpiryText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Intl.DateTimeFormat(hostLocale(), { dateStyle: 'medium' }).format(new Date(parsed))
}

/**
 * Format an instant with its time of day, in the language the cards are
 * already using. The PAT's authorization line needs the clock time as well as
 * the day; a package's expiry line needs only the day.
 */
export function formatStampText(atMs: number): string {
  return new Intl.DateTimeFormat(hostLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(atMs))
}

/** The BCP-47 tag the active language formats dates with. */
function hostLocale(): string {
  return activeLanguage === 'en' ? 'en-US' : 'zh-CN'
}

/**
 * The site a detail link points at, for labelling that link.
 *
 * The upstream sends the URL per bucket, and it already carries the region:
 * `qoder.com` on the international edition, `qoder.com.cn` on the Chinese one.
 * Printing that host is therefore correct for both variants with no
 * variant-specific constant anywhere in the plugin — and the user can see
 * which site they are about to open.
 */
export function detailUrlHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/** One merged sidebar row: a package group and its summed figures. */
export interface QuotaGroup {
  /** Package display name, verbatim from the upstream. */
  packageName: string
  /** Localized titles of the first member, so the row can re-label itself. */
  packageNameI18n?: { zh?: string | undefined; en?: string | undefined }
  /**
   * The group's expiry, verbatim, or undefined when no member reported one.
   * Grouping treats "no expiry" as its own bucket, so a dated and an undated
   * package with the same name never merge.
   */
  packageEndTime: string | undefined
  /** Summed remaining credit across the group's members. */
  remain: number
  /** Summed total across the group's members. */
  size: number
  /** Any member is unlimited — the group renders as unlimited, not as sums. */
  unlimited: boolean
  /**
   * The upstream's itemized page, carried from the first member that linked
   * one. The card shows it where a date would otherwise be claimed: the summed
   * bonus-credit bucket has no expiry in the API, but the account page lists
   * the grants behind it with per-grant expiries.
   */
  detailUrl: string | undefined
}

/**
 * Group credit accounts by (packageName, packageEndTime) and sum each group.
 *
 * A missing figure counts as 0 (the user's ruling): a package whose total the
 * upstream did not report contributes nothing to the group's `size` rather
 * than poisoning the bar into "unknown". A group whose summed `size` is still
 * 0 keeps an honest "unknown total" rendering in the card — the merge never
 * invents a denominator. `unlimited` is sticky: one unlimited member makes the
 * whole group unlimited, and its sums are not displayed as a quota.
 *
 * MERGE KEY IS THE NAME ALONE (the user's correction): same-named packages
 * whose expiries differ by seconds (stacked purchase batches) must still be
 * one overview row — keying on the expiry exploded 28 same-named packages
 * back into 28 separate bars the moment the host started reporting real
 * dates. The expiry travels on the group (earliest of the members) for the
 * sort/visibility rules; the itemised per-expiry breakdown lives in the
 * dashboard's table.
 *
 * @param accounts - the status document's per-package credit entries.
 * @returns one group per distinct package NAME, in first-seen order.
 */
export function mergeCreditAccounts(accounts: readonly QoderWebCreditAccount[]): QuotaGroup[] {
  const groups = new Map<string, QuotaGroup>()
  for (const account of accounts) {
    const key = account.packageName
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        packageName: account.packageName,
        ...account.packageNameI18n === undefined ? {} : { packageNameI18n: account.packageNameI18n },
        packageEndTime: account.packageEndTime,
        remain: account.remain,
        size: account.size,
        unlimited: account.unlimited === true,
        detailUrl: account.detailUrl,
      })
      continue
    }
    // A member figure the upstream did not report (undefined → 0 here) drags
    // the sum down, never up: the bar may understate one obscure field, but it
    // cannot fabricate quota the upstream never granted.
    existing.remain += account.remain
    existing.size += account.size
    existing.unlimited = existing.unlimited || account.unlimited === true
    // Keep the EARLIEST expiry across the stack: the soonest deadline is the
    // operationally meaningful one for the overview row.
    if (existing.packageEndTime !== undefined && account.packageEndTime !== undefined) {
      const a = Date.parse(existing.packageEndTime)
      const b = Date.parse(account.packageEndTime)
      if (!Number.isNaN(a) && !Number.isNaN(b) && b < a) existing.packageEndTime = account.packageEndTime
    } else {
      existing.packageEndTime = existing.packageEndTime ?? account.packageEndTime
    }
    // First link wins: every member of a same-named group points at the same
    // itemized page, so the group needs one, not a merge.
    existing.detailUrl = existing.detailUrl ?? account.detailUrl
  }
  return [...groups.values()]
}

/** Clamp helper shared by the card's percent math. */
export function clampPercent(remain: number, size: number): number | undefined {
  if (!(size > 0)) return undefined
  const percent = (remain / size) * 100
  if (!Number.isFinite(percent)) return undefined
  return Math.min(100, Math.max(0, percent))
}

/**
 * The percent format every surface prints a RATIO with: at most two decimals,
 * with a whole value left whole — "100", never "100.00".
 *
 * Both cards show the SAME package, so they must print the SAME number: while
 * the sidebar rounded to whole percent and the settings card kept one decimal,
 * 2,291 / 2,300 read "100%" in one place and "99.6%" in the other, and the two
 * surfaces contradicted each other about one figure.
 *
 * Two decimals, not a fixed two: the padding would buy no accuracy, and the
 * sidebar's percent column is 38px wide, where "99.61%" measures 36px while
 * "100.00%" measures 42px.
 *
 * @param percent - an already-clamped percentage value.
 * @returns the percent as text, without the trailing sign.
 */
export function formatPercentText(percent: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(percent)
}

/**
 * The same ratio read the other way round: the cycle's USED percentage as a
 * bare number string ("3"), ready for the `quotaPackageUsed` copy.
 *
 * Both surfaces that print it call this ONE function — the sidebar card's label
 * suffix and the settings card's credit bar — because they must never disagree
 * about the same package.
 *
 * Unlike {@link formatPercentText}, this one stays whole percent on purpose:
 * the suffix rides inside the package label, and at two decimals the sidebar's
 * label measures 105px against the 93px its row can spare, which would ellipsize
 * the very suffix it exists to show.
 *
 * Derived from remain/size rather than read from the upstream's per-package
 * `used`: the transport normalizes `remaining` from `used`, so the value is the
 * same, while a package the upstream reports without `used` normalizes to a
 * literal 0 — adopting that field would print "已使用0%" under a half-empty bar.
 *
 * @param remain - the package's remaining credit.
 * @param size - the package's granted total; a non-positive size has no ratio.
 * @returns the used percentage as a bare number string, or undefined when there is no ratio to state.
 */
export function usedPercentText(remain: number, size: number): string | undefined {
  const percent = clampPercent(remain, size)
  return percent === undefined ? undefined : String(Math.round(100 - percent))
}

/** Parse an upstream expiry string ("YYYY-MM-DD HH:mm:ss") into a timestamp; undefined when unparseable. */
function parseExpiry(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Whether a group is spent (remain 0) and NOT unlimited. */
function isSpent(group: QuotaGroup): boolean {
  return !group.unlimited && group.remain <= 0
}

/** Whether a spent group's expiry date has already passed (undated → false: no proof of expiry). */
function isExpired(group: QuotaGroup, now: number): boolean {
  if (!isSpent(group)) return false
  const expiry = parseExpiry(group.packageEndTime)
  return expiry !== undefined && expiry < now
}

/**
 * SIDEBAR overview rule (the user's spec, restored after it was wrongly
 * applied to the panel):
 *
 * - A group with credit LEFT (remain > 0, or unlimited) renders.
 * - A SPENT group (remain 0) renders ONLY when EVERY group is spent AND it
 *   is not expired — the account's standing quota whose emptiness is itself
 *   the news. When anything still has credit, spent rows are noise.
 * - An EXPIRED group (spent and its expiry date has passed) renders
 *   NOWHERE, whatever the rest of the account looks like.
 *
 * Applied AFTER the merge so the sums are settled before the test.
 * "Now" is injectable for tests.
 *
 * @param groups - merged groups, in first-seen order.
 * @param now - current timestamp (defaults to Date.now()).
 * @returns the groups to display, in first-seen order.
 */
export function visibleQuotaGroups(groups: readonly QuotaGroup[], now: number = Date.now()): QuotaGroup[] {
  const hasCredit = groups.some(group => group.unlimited || group.remain > 0)
  return groups.filter(group => {
    if (group.unlimited || group.remain > 0) return true
    // Spent: visible only when the WHOLE account is spent and this group has
    // not lapsed.
    return !hasCredit && !isExpired(group, now)
  })
}

/**
 * PANEL detail-table ordering (the user's spec): every row renders — the
 * panel is the itemised ledger — but spent-yet-still-active rows sink to the
 * BOTTOM (lowest priority), and expired rows are dropped entirely. Rows keep
 * their first-seen order within each band.
 *
 * @param rows - per-package rows, unmerged, in first-seen order.
 * @param now - current timestamp (defaults to Date.now()).
 */
export function sortPackageRows<T extends { remain: number; unlimited?: true; packageEndTime?: string }>(rows: readonly T[], now: number = Date.now()): T[] {
  const live: T[] = []
  const spent: T[] = []
  for (const row of rows) {
    const unlimited = row.unlimited === true
    const expiry = parseExpiry(row.packageEndTime)
    const expired = !unlimited && row.remain <= 0 && expiry !== undefined && expiry < now
    if (expired) continue
    if (unlimited || row.remain > 0) live.push(row)
    else spent.push(row)
  }
  return [...live, ...spent]
}
