/**
 * The sidebar footer quota card + the center-column dashboard it opens.
 *
 * The structure is a direct port of commandcode's plans & quota panel
 * (src/client/panel-view.tsx + panel.ts), which the user held up as the
 * reference: the card IS the button (the shell supplies no chrome), it renders
 * one block per merged package group — the group's remain/total, its
 * percentage and its bar — carries the last-updated time in the card's top
 * row, and opens a dashboard in the layout's keyed `main` slot on click. In
 * the 56px rail it collapses to a 36px icon button carrying the ring.
 *
 * Data comes from the shared status store: the card acquires its variant and
 * the store's ONE ticker reads each live variant once for every surface
 * (this card, the settings cards, the dashboard), paused while the page is
 * hidden; strings come from the `panel.qoder-quota` locale namespace; classes
 * come from `./quota-styles.ts` (`qdp-` prefix).
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { QoderWebStatus } from '../status-paths.ts'
import type { QoderSettingsKey } from './locales.ts'
import { clampPercent, mergeCreditAccounts, sortPackageRows, visibleQuotaGroups } from './quota-merge.ts'
import { acquireLiveSurface, onQuotaSettingsChange, quotaReadFailure, quotaSettingsRevision, quotaStatus, quotaStatusFetchedAt, quotaToggles, variantOfStatusPath } from './quota-settings-store.ts'
/** Everything the registration binds into the card. */
export interface SidebarQuotaCardInjected {
  /** Translator bound to the quota namespace. */
  t: (key: QuotaCopyKey, params?: Record<string, unknown>) => string
  /** Which variant's status route this card polls. */
  statusPath: string
  /** Select the dashboard panel in the center column (layout seam). */
  open: () => void
}

/**
 * The card's own copy keys — the subset of the shared settings key set the
 * quota surfaces render.
 */
export type QuotaCopyKey =
  | 'quotaCardCN'
  | 'quotaCardGlobal'
  | 'quotaUnknownTotal'
  | 'quotaUnlimited'
  | 'quotaExpires'
  | 'quotaNoExpiry'
  | 'quotaError'
  | 'quotaNotSignedIn'
  | 'quotaUpdated'
  | 'quotaDashboardTitle'
  | 'quotaDashboardSubtitle'
  | 'quotaRefresh'
  | 'quotaRefreshing'
  | 'quotaClose'
  | 'quotaByPackage'
  | 'quotaTotal'
  | 'quotaTotalRemain'
  | 'quotaTotalShare'
  | 'quotaColPackage'
  | 'quotaColRemain'
  | 'quotaColExpiry'
  /** PAT identity line for the dashboard card head. */
  | 'patTail'
  | 'signedIn'
  /** Usage-percentage line under the totals. */
  | 'quotaCycleUsed'

/** Compile-time assertion: every quota key must exist in the shared key set. */
const _assertQuotaKeys: Record<QuotaCopyKey, QoderSettingsKey> = {
  quotaCardCN: 'quotaCardCN',
  quotaCardGlobal: 'quotaCardGlobal',
  quotaUnknownTotal: 'quotaUnknownTotal',
  quotaUnlimited: 'quotaUnlimited',
  quotaExpires: 'quotaExpires',
  quotaNoExpiry: 'quotaNoExpiry',
  quotaError: 'quotaError',
  quotaNotSignedIn: 'quotaNotSignedIn',
  quotaUpdated: 'quotaUpdated',
  quotaDashboardTitle: 'quotaDashboardTitle',
  quotaDashboardSubtitle: 'quotaDashboardSubtitle',
  quotaRefresh: 'quotaRefresh',
  quotaRefreshing: 'quotaRefreshing',
  quotaClose: 'quotaClose',
  quotaByPackage: 'quotaByPackage',
  quotaTotal: 'quotaTotal',
  quotaTotalRemain: 'quotaTotalRemain',
  quotaTotalShare: 'quotaTotalShare',
  quotaColPackage: 'quotaColPackage',
  quotaColRemain: 'quotaColRemain',
  quotaColExpiry: 'quotaColExpiry',
  patTail: 'patTail',
  signedIn: 'signedIn',
  quotaCycleUsed: 'quotaCycleUsed',
}
void _assertQuotaKeys

export type SidebarQuotaCardProps =
  PropsRuntime<'sidebar.footer.action'>
  & Partial<SidebarQuotaCardInjected>

/** Fallback translator: renders keys bare rather than throwing unbound. */
const fallbackT = (key: QuotaCopyKey): string => key

/**
 * Identity line under the dashboard card title: the redacted PAT tail when a
 * token is on file, plain signed-in copy if the summary is missing, and the
 * save-a-PAT hint otherwise. There is no nickname on a PAT document.
 */
function ownerText(status: QoderWebStatus | undefined, t: (key: QuotaCopyKey, params?: Record<string, unknown>) => string): string {
  if (status === undefined || status.status !== 'signed-in') return t('quotaNotSignedIn')
  const tail = status.pat?.patTail
  return tail === undefined ? t('signedIn') : t('patTail', { tail: `****${tail}` })
}

/** One bar in the footer card / dashboard: a merged group's figures. */
interface QuotaBarView {
  /** Package display name. */
  label: string
  /** `remain / size`, or the unlimited glyph, or the unknown-total copy. */
  detail: string
  /** Printed right-hand percentage; undefined when there is no ratio. */
  percent: string | undefined
  /** Fill width, clamped to [0, 100]. */
  barPercent: number
  /** Render in the error colour (nearly exhausted). */
  warn: boolean
  /** Group expiry, verbatim; undefined when none was reported. */
  packageEndTime: string | undefined
}

/** Project the credit accounts into the card's bar list. */
function buildBars(accounts: readonly { packageName: string; remain: number; size: number; unlimited?: true; packageEndTime?: string }[]): QuotaBarView[] {
  // Merge first, THEN the sidebar's visibility+ordering rule: live groups
  // render first (first-seen order), spent-but-not-expired groups sink to
  // the bottom (lowest priority), expired groups drop out entirely.
  const groups = visibleQuotaGroups(mergeCreditAccounts(accounts))
  const bars: QuotaBarView[] = []
  for (const group of groups) {
    const percent = group.unlimited ? undefined : clampPercent(group.remain, group.size)
    const detail = group.unlimited
      ? '∞'
      : percent === undefined
        ? `${group.remain.toLocaleString()} · ?`
        : `${group.remain.toLocaleString()} / ${group.size.toLocaleString()}`
    bars.push({
      label: group.packageName,
      detail,
      percent: percent === undefined ? undefined : `${Math.round(percent)}%`,
      barPercent: percent === undefined ? 0 : Math.max(2, percent),
      warn: !group.unlimited && percent !== undefined && percent < 20,
      packageEndTime: group.packageEndTime,
    })
  }
  return bars
}

/**
 * The quota ring — commandcode's glyph ported verbatim (`qdp-` classes): a
 * faint track plus an arc whose sweep is the consumption, drawn from 12
 * o'clock. Circumference 2πr = 45.55 at r = 7.25.
 */
function Ring({ percent, warn, size }: { percent: number; warn: boolean; size: number }): React.ReactNode {
  const clamped = Math.min(100, Math.max(0, percent))
  const circumference = 45.55
  const dashoffset = Math.round(circumference * (1 - clamped / 100) * 1000) / 1000
  return (
    <span className="qdp-glyph" aria-hidden="true">
      <svg viewBox="0 0 20 20" width={size} height={size} focusable="false">
        <circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
        <circle
          cx="10"
          cy="10"
          r="7.25"
          fill="none"
          stroke={warn ? 'var(--dsw-alias-state-error-primary)' : 'currentColor'}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={String(circumference)}
          strokeDashoffset={String(dashoffset)}
          transform="rotate(-90 10 10)"
        />
      </svg>
    </span>
  )
}

/** One per-package row in the dashboard's detail table (NOT merged). */
interface PackageRow {
  name: string
  remain: number
  size: number
  percent: number | undefined
  warn: boolean
  packageEndTime: string | undefined
}

/**
 * The dashboard's detail rows: EVERY package as the upstream reported it —
 * no merging, exhausted ones included. The sidebar card shows the merged
 * overview; this panel is the itemised ledger, so collapsing here would
 * destroy the only place a per-package figure is visible.
 */
function buildPackageRows(accounts: readonly { packageName: string; remain: number; size: number; unlimited?: true; packageEndTime?: string }[]): PackageRow[] {
  // Every package renders unmerged (the itemised ledger), but the ordering
  // rule applies: live rows first, spent-yet-active rows sunk to the bottom,
  // expired rows dropped entirely.
  const ordered = sortPackageRows(accounts)
  return ordered.map(account => {
    const percent = account.unlimited === true ? undefined : clampPercent(account.remain, account.size)
    return {
      name: account.packageName,
      remain: account.remain,
      size: account.size,
      percent,
      warn: account.unlimited !== true && percent !== undefined && percent < 20,
      packageEndTime: account.packageEndTime,
    }
  })
}

/** Time-of-day formatter for the updated stamp. */
function timeText(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** One variant's sidebar quota card. */
export function SidebarQuotaCard(props: SidebarQuotaCardProps): React.ReactNode {
  const { t = fallbackT, statusPath, open } = props
  const variantId = statusPath !== undefined ? variantOfStatusPath(statusPath) : 'qoder'
  const nameKey: QuotaCopyKey = variantId === 'qoder-global' ? 'quotaCardGlobal' : 'quotaCardCN'
  const wide = props.wide !== false
  // The last read failure is shared state too: whichever surface's read
  // failed, this card's ring shows it (a failed read empties the ring rather
  // than inventing numbers).
  useSyncExternalStore(onQuotaSettingsChange, quotaSettingsRevision)
  const enabled = variantId === 'qoder' ? quotaToggles().cn : quotaToggles().global
  const failed = quotaReadFailure(variantId) !== undefined
  const status = quotaStatus(variantId)
  const signedIn = status?.status === 'signed-in'

  // Poll on the configured interval for as long as the card is enabled —
  // the user's design: the SIDEBAR card keeps itself current on the setting's
  // cadence. The poll itself is shared now: the card acquires its variant and
  // the store's ONE ticker reads each live variant once for every surface, so
  // an enabled sidebar card beside an expanded settings card costs ONE
  // request a minute between them. The saved toggle gates the card live; the
  // shared store's revision is the subscription, so a landed save re-renders
  // (and re-gates) instantly — and the SAME subscription delivers documents
  // fetched by ANY surface (the dashboard's refresh, the settings card's
  // poll, this card's own mount read), so every surface always shows the
  // same latest numbers.
  useEffect(() => {
    if (statusPath === undefined || !enabled) return undefined
    return acquireLiveSurface(variantId)
  }, [statusPath, enabled, variantId])

  // The gate is a render decision, not a registration decision (commandcode's
  // rule): the entry stays in the slot ledger while an off setting renders
  // nothing at all. It sits after every hook so the rules of hooks hold.
  if (enabled === false) return null

  const credits = status !== undefined && 'credits' in status ? status.credits : undefined
  const bars = credits === undefined ? [] : buildBars(credits.accounts ?? [])
  const lowest = bars.reduce<number | undefined>((acc, bar) => {
    if (bar.percent === undefined) return acc
    const value = Number.parseFloat(bar.percent)
    if (!Number.isFinite(value)) return acc
    return acc === undefined ? value : Math.min(acc, value)
  }, undefined)
  const ringPercent = failed || status === undefined ? 0 : credits?.unlimited === true ? 100 : lowest ?? 0
  const ringWarn = failed || (lowest !== undefined && lowest < 20)
  const fetchedAt = quotaStatusFetchedAt(variantId)
  const title = [
    t(nameKey),
    ...bars.map(bar => `${bar.label} ${bar.detail}${bar.percent === undefined ? '' : ` (${bar.percent})`}`),
    fetchedAt !== undefined ? `${t('quotaUpdated')} ${timeText(fetchedAt)}` : '',
  ].filter(part => part !== '').join(' · ')

  if (!wide) {
    return (
      <button
        type="button"
        className="qdp-railButton"
        aria-label={title}
        title={title}
        disabled={!signedIn}
        onClick={() => {
          if (!signedIn) return
          open?.()
        }}
      >
        <Ring percent={ringPercent} warn={ringWarn} size={18} />
      </button>
    )
  }

  return (
    <button
      type="button"
      className="qdp-foot"
      aria-label={title}
      title={title}
      disabled={!signedIn}
      onClick={() => {
        if (!signedIn) return
        open?.()
      }}
    >
      <span className="qdp-footTop">
        <Ring percent={ringPercent} warn={ringWarn} size={16} />
        <span className="qdp-footName">{t(nameKey)}</span>
        <span style={{ flex: 1 }} />
        {fetchedAt !== undefined ? <span className="qdp-updated">{t('quotaUpdated')} {timeText(fetchedAt)}</span> : null}
      </span>

      {failed ? (
        <span className="qdp-footRow">
          <span className="qdp-footLabel">{t('quotaError')}</span>
        </span>
      ) : bars.length === 0 ? (
        <span className="qdp-footRow">
          <span className="qdp-footLabel">
            {status === undefined
              ? '…'
              : !('credits' in status)
                ? t('quotaNotSignedIn')
                // Signed in but the balance fetch failed: say THAT, not
                // "sign in" — the two mean opposite actions.
                : (status.creditsError ?? t('quotaError'))}
          </span>
        </span>
      ) : (
        bars.map((bar, index) => (
          <span className="qdp-footRow" key={`${index}\u0000${bar.label}\u0000${bar.packageEndTime ?? ''}`}>
            <span className="qdp-footHead">
              <span className="qdp-footLabel" title={bar.packageEndTime !== undefined ? `${t('quotaExpires')} ${bar.packageEndTime}` : t('quotaNoExpiry')}>
                {bar.label}
              </span>
              <span className="qdp-footAmount">{bar.detail}</span>
              <span className="qdp-footPct">{bar.percent ?? ''}</span>
            </span>
            <span className="qdp-footBar">
              <span
                className={bar.warn ? 'qdp-footFill qdp-footFillWarn' : 'qdp-footFill'}
                style={{ width: `${bar.barPercent}%` }}
              />
            </span>
          </span>
        ))
      )}
    </button>
  )
}

/* ------------------------------------------------------------------ dashboard */

/**
 * The registration's inject face: the hooks compartment rides the renderer's
 * hooks→useX binding (the face itself is cached once per entry and spread, so
 * every value that moves MUST ride the hooks channel — a face getter would be
 * frozen at bind time).
 */
export interface QuotaDashboardInjected {
  hooks: {
    quotaDashboard: { getSnapshot: () => QuotaDashboardState; subscribe: (listener: () => void) => () => void }
  }
  t: (key: QuotaCopyKey, params?: Record<string, unknown>) => string
  statusPaths: readonly string[]
  refresh: () => void
  close: () => void
  /** Fetch the variant the user just picked (see {@link QuotaDashboardProps.onVariantPicked}). */
  onVariantPicked: (path: string) => void
}

/** Props the dashboard panel receives through its inject face. */
export interface QuotaDashboardState {
  /** Whether the shared fetch is in flight. */
  loading: boolean
  /** The variant the last card click asked for (drives the followed tab). */
  activePath: string
}

/** Props the dashboard panel receives through its inject face. */
export interface QuotaDashboardProps {
  t: (key: QuotaCopyKey, params?: Record<string, unknown>) => string
  /** Both variants' status routes, in the same order as the state's documents. */
  statusPaths: readonly string[]
  refresh: () => void
  close: () => void
  /**
   * The user picked a different variant's tab: the panel must fetch THAT
   * variant when the shared store holds nothing (or something stale) for it.
   * Its sidebar card may be off, so no other surface ever fetched it — without
   * this the tab showed "sign in" until the user toggled a setting.
   */
  onVariantPicked: (path: string) => void
  /**
   * The dashboard's live state, delivered as a selector hook over an
   * observable source — the commandcode `hooks` mechanism. The renderer
   * CACHES an inject face once per entry and SPREADS it into props, so a
   * getter on the face is read exactly once and frozen; any value that moves
   * must ride the hooks channel, whose `useQuotaDashboard(selector)` reads
   * the CURRENT source value on every render and resubscribes on change.
   */
  useQuotaDashboard: <T>(selector: (state: QuotaDashboardState) => T) => T
}

/**
 * The center-column dashboard, registered into the layout's keyed `main` slot
 * under the id the footer cards select, so card → panel is one navigation
 * entry. One variant at a time, switched by tabs (commandcode's account-tab
 * pattern): CN and international are separate accounts with separate package
 * lists, so mixing them into one column would misattribute every number.
 *
 * The panel holds its shown variant live through the shared store — it reads
 * at once on open (unless the shared document is still within the settings
 * interval, which a click then shows as cached numbers) and the shared ticker
 * keeps it current from then on, so a user opening the panel never waits for
 * a poll and never meets a stale "sign in" because nothing had read yet.
 */
export function QuotaDashboard(props: QuotaDashboardProps): React.ReactNode {
  const { t = fallbackT, statusPaths, refresh, close, useQuotaDashboard, onVariantPicked } = props
  // The dashboard rides the SAME shared store as the sidebar cards: the
  // hooks-channel snapshot carries only the followed tab; documents come from
  // the shared revision subscription, so a refresh updates both surfaces at
  // once and the card never disagrees with the panel.
  useSyncExternalStore(onQuotaSettingsChange, quotaSettingsRevision)
  const state = useQuotaDashboard(s => s)
  const followedPath = state.activePath
  const [userPicked, setUserPicked] = useState<string | undefined>(undefined)
  const activePathResolved = userPicked ?? followedPath
  const activeVariant = variantOfStatusPath(activePathResolved)
  const status = quotaStatus(activeVariant)
  const loading = state.loading
  // The panel's "updated at" is the SHARED document's fetch time — the same
  // fact the sidebar card prints — so the two never disagree, whichever
  // surface refreshed last.
  const fetchedAt = quotaStatusFetchedAt(activeVariant)
  const credits = status !== undefined && 'credits' in status ? status.credits : undefined
  // The detail table: EVERY package, unmerged, exhausted included — the
  // sidebar card is the merged overview, this panel is the itemised ledger.
  const rows = credits === undefined ? [] : buildPackageRows(credits.accounts ?? [])
  const nameKey: QuotaCopyKey = activeVariant === 'qoder-global' ? 'quotaCardGlobal' : 'quotaCardCN'
  const signedIn = status?.status === 'signed-in'
  // Overall bar: remaining over granted, summed from the packages. Qoder's
  // `credits.total` is a USAGE percentage, not a remainder — it feeds the
  // "used this cycle" line below, never the total row. The host applies the
  // upstream totalSize floor; without it the per-package sum stands, and 0
  // renders the bar as indeterminate rather than asserting a false full usage.
  const totalRemain = credits === undefined ? 0 : credits.accounts.reduce((sum, account) => sum + account.remain, 0)
  const totalSize = credits?.totalSize ?? credits?.accounts.reduce((sum, account) => sum + account.size, 0) ?? 0
  const totalPercent = clampPercent(totalRemain, totalSize)
  return (
    <div className="qdp-main" role="region" aria-label={t('quotaDashboardTitle')}>
      <div className="qdp-mainInner">
        <header className="qdp-header">
          <div className="qdp-headerText">
            <h2 className="qdp-title">{t('quotaDashboardTitle')}</h2>
            <p className="qdp-subtitle">{t('quotaDashboardSubtitle')}</p>
          </div>
          <span className="qdp-spacer" />
          {fetchedAt !== undefined ? <span className="qdp-meta">{t('quotaUpdated')} {timeText(fetchedAt)}</span> : null}
          <button type="button" className="qdp-refresh" disabled={loading} onClick={() => refresh()}>
            {loading ? t('quotaRefreshing') : t('quotaRefresh')}
          </button>
          <button type="button" className="qdp-close" aria-label={t('quotaClose')} title={t('quotaClose')} onClick={() => close()}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {statusPaths.length > 1 ? (
          <div className="qdp-tabs" role="tablist" aria-label={t('quotaDashboardTitle')}>
            {statusPaths.map(path => {
              const variant = variantOfStatusPath(path)
              const key: QuotaCopyKey = variant === 'qoder-global' ? 'quotaCardGlobal' : 'quotaCardCN'
              return (
                <button
                  key={path}
                  type="button"
                  role="tab"
                  aria-selected={path === activePathResolved}
                  className={path === activePathResolved ? 'qdp-tab qdp-tabActive' : 'qdp-tab'}
                  onClick={() => {
                    setUserPicked(path)
                    // Fetch the newly shown variant when the shared store has
                    // nothing (or something stale) for it — its sidebar card
                    // being off means no other surface ever fetched it.
                    onVariantPicked(path)
                  }}
                >
                  {t(key)}
                </button>
              )
            })}
          </div>
        ) : null}

        <section className="qdp-card">
          <div className="qdp-cardHead">
            <span className="qdp-avatar">{activeVariant === 'qoder-global' ? 'GL' : 'CN'}</span>
            <span className="qdp-cardIdentity">
              <span className="qdp-cardTitle">{t(nameKey)}</span>
              <span className="qdp-cardOwner">{ownerText(status, t)}</span>
            </span>
            {credits?.unlimited === true ? <span className="qdp-badge">{t('quotaUnlimited')}</span> : null}
          </div>
          {!signedIn ? (
            <div className="qdp-notice">
              <p className="qdp-noticeTitle">{t('quotaNotSignedIn')}</p>
            </div>
          ) : credits === undefined ? (
            <div className="qdp-notice qdp-noticeError">
              <p className="qdp-noticeTitle">{t('quotaError')}</p>
            </div>
          ) : (
            <>
              {/* Overall: 额度（剩余 / 总量）, its share of the granted total,
                  the upstream's usage percentage, and the account-wide bar.
                  totalSize 0 (nothing granted or an old host) renders
                  indeterminate — never a false 100%. */}
              <p className="qdp-totalLine">
                {t('quotaTotalRemain')} <strong className="qdp-totalValue">{totalRemain.toLocaleString()}</strong>
                {' / '}
                {totalSize > 0 ? totalSize.toLocaleString() : t('quotaUnknownTotal')}
              </p>
              <p className="qdp-totalSub">
                {t('quotaTotalShare', {
                  percent: totalPercent === undefined ? t('quotaUnknownTotal') : `${totalPercent.toFixed(2)}%`,
                  remain: totalRemain.toLocaleString(),
                  size: totalSize.toLocaleString(),
                })}
              </p>
              {Number.isFinite(credits.total) ? (
                <p className="qdp-totalSub">{t('quotaCycleUsed', { percent: String(credits.total) })}</p>
              ) : null}
              <div
                className="qdp-bar"
                role="progressbar"
                aria-label={t('quotaTotal')}
                {...totalPercent === undefined
                  ? { 'aria-valuetext': t('quotaUnknownTotal') }
                  : { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(totalPercent) }}
              >
                <div
                  className={totalPercent !== undefined && totalPercent < 20 ? 'qdp-barFill qdp-barFillWarn' : 'qdp-barFill'}
                  style={{ width: totalPercent === undefined ? '100%' : `${Math.max(2, totalPercent)}%`, opacity: totalPercent === undefined ? 0.25 : 1 }}
                />
              </div>

              <h3 className="qdp-blockTitle">{t('quotaByPackage')}</h3>
              <table className="qdp-table">
                <thead>
                  <tr>
                    <th>{t('quotaColPackage')}</th>
                    <th>{t('quotaColRemain')}</th>
                    <th>{t('quotaColExpiry')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${index}\u0000${row.name}\u0000${row.packageEndTime ?? ''}`}>
                      <td>{row.name}</td>
                      <td className="qdp-num">
                        <span className="qdp-numText">{row.remain.toLocaleString()} / {row.size.toLocaleString()}</span>
                        <span className="qdp-miniBar">
                          <span
                            className={row.warn ? 'qdp-footFill qdp-footFillWarn' : 'qdp-footFill'}
                            style={{
                              display: 'block',
                              height: '100%',
                              borderRadius: 999,
                              width: row.percent === undefined ? '100%' : `${Math.max(2, row.percent)}%`,
                              opacity: row.percent === undefined ? 0.25 : 1,
                            }}
                          />
                        </span>
                      </td>
                      <td className="qdp-expiry">{row.packageEndTime ?? t('quotaNoExpiry')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {credits.cycleResetTime !== undefined ? (
                <p className="qdp-windowReset">{t('quotaExpires')} {credits.cycleResetTime}</p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
