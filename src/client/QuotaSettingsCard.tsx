/**
 * The shared quota-settings card: one card above the two variant cards that
 * configures both sidebar quota widgets.
 *
 * Like the built-in plugin cards, it registers into the Plugins tab's card
 * list — `settings.plugin.item` on DSH 0.1.5, the shared 《插件设置》 block on
 * 0.1.7, where that list is gone — and writes through the settings face's
 * revision-fenced `set` — the same durable-write path every preference row
 * uses. A toggle commits on click: each click is one explicit user choice,
 * and the scope's ordering makes the last one win, so no staged-draft form is
 * needed for two booleans and a number.
 *
 * The two toggles gate the CN and international sidebar cards respectively;
 * the interval is one shared poll period. Toggles are disabled while their
 * variant is signed out: a quota card for an account nobody is signed into
 * would render an error forever, so the setting waits for a session.
 */

import { useSyncExternalStore, useState, useEffect, useCallback } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { QoderSettingsKey } from './locales.ts'
import { isQoderWebStatus } from './status-document.ts'
import { noteQuotaSignIn, onQuotaSettingsChange, quotaSignInState, quotaStatus, variantOfStatusPath } from './quota-settings-store.ts'
import { QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from '../status-paths.ts'

/**
 * The settings-controller face this bundle consumes, restated locally.
 *
 * DSH 0.1.5 hands a `SettingsScope<T>` (`SettingsScopeController`) to a plugin
 * that binds a namespace it registered on the Host; DSH 0.1.7 hands a
 * `ConfigFormController<T>` to a plugin that asks for its profile entry's form.
 * The two are field-for-field identical — `getSnapshot` / `subscribe` / `set` /
 * `unset` / `mutate`, over the same
 * `status`/`value`/`base`/`user`/`revision`/`writable`/`mode` snapshot — which
 * is what lets every caller below stay branch-free.
 *
 * The type is restated rather than imported: naming either host type would tie
 * this bundle's compilation to one version's settings package graph, and 0.1.7
 * does not declare the 0.1.5 name at all. A type-only import would still be a
 * cross-version dependency; a structural restatement is not (client bundle
 * purity: cross-plugin collaboration goes through services, never imports).
 */
export interface QuotaSettingsScope<T> {
  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot: () => QuotaSettingsSnapshot<T>
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe: (listener: () => void) => () => void
  /**
   * Queue one field write.
   * @param field - scalar field inside the section.
   * @param value - JSON-shaped value selected by the user.
   * @returns the host-specific settlement, which this card does not read.
   */
  set: (field: string, value: unknown) => Promise<unknown>
  /**
   * Queue one field clear, so the field re-inherits the composition layer.
   * @param field - scalar field inside the section.
   * @returns the host-specific settlement, which this card does not read.
   */
  unset: (field: string) => Promise<unknown>
}

/** One settings form's sync state, identical in both hosts. */
export interface QuotaSettingsSnapshot<T> {
  /** `loading` until the first accepted section, `ready` while one stands, `unavailable` when no such form is served. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted section; undefined before the first acceptance. */
  value: T | undefined
  /** Whether the host document accepts writes. */
  writable: boolean
}

/** Everything the registration binds into the card. */
export interface QuotaSettingsCardInjected {
  /** Translator bound to the settings namespace. */
  t: (key: QoderSettingsKey, params?: Record<string, unknown>) => string
  /** Sign-in state per variant; a toggle is disabled when its variant is out. */
  signedIn?: (() => { cn: boolean; global: boolean }) | undefined
  /** The bound quota settings face, when the host serves one. */
  scope?: QuotaSettingsScope<QuotaSection> | undefined
}

/** The fields this card edits (mirrors the host-side QUOTA_SECTION_KEYS). */
export interface QuotaSection {
  sidebarQuotaCN?: boolean
  sidebarQuotaGlobal?: boolean
  autoCheckInCN?: boolean
  autoCheckInGlobal?: boolean
  checkInMinuteCN?: number
  checkInMinuteGlobal?: number
  quotaPollMs?: number
}

export type QuotaSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & Partial<QuotaSettingsCardInjected>

/** The settings fields this card edits, in display order. */
const FIELDS = [
  'sidebarQuotaCN',
  'sidebarQuotaGlobal',
  'autoCheckInCN',
  'checkInMinuteCN',
  'autoCheckInGlobal',
  'checkInMinuteGlobal',
  'quotaPollMs',
] as const
type Field = (typeof FIELDS)[number]

/** The default poll interval shown before a value is stored. */
const POLL_DEFAULT_MS = 300_000
/** Floor the schema also enforces; mirrored here for immediate UI feedback. */
const POLL_MIN_MS = 60_000
/** 10:00 UTC+8, the moment the upstream resets the daily campaign. */
const CHECK_IN_MINUTE_DEFAULT = 600

/** Minutes past midnight (UTC+8), split for the two number fields. */
function splitMinutes(minutes: number): { hours: number; minutes: number } {
  const safe = Number.isFinite(minutes) ? Math.trunc(minutes) : CHECK_IN_MINUTE_DEFAULT
  const clamped = safe < 0 || safe > 1439 ? CHECK_IN_MINUTE_DEFAULT : safe
  return { hours: Math.floor(clamped / 60), minutes: clamped % 60 }
}

/** Projection the card component reads. */
interface QuotaSettingsProjection {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  values: {
    sidebarQuotaCN: boolean
    sidebarQuotaGlobal: boolean
    autoCheckInCN: boolean
    autoCheckInGlobal: boolean
    checkInMinuteCN: number
    checkInMinuteGlobal: number
    quotaPollMs: number
  }
}

/** Read the section values out of a scope snapshot (defaults when absent). */
function project(scope: QuotaSettingsScope<QuotaSection> | undefined): QuotaSettingsProjection {
  if (scope === undefined) {
    return {
      status: 'unavailable',
      writable: false,
      values: {
        sidebarQuotaCN: false,
        sidebarQuotaGlobal: false,
        autoCheckInCN: false,
        autoCheckInGlobal: false,
        checkInMinuteCN: CHECK_IN_MINUTE_DEFAULT,
        checkInMinuteGlobal: CHECK_IN_MINUTE_DEFAULT,
        quotaPollMs: POLL_DEFAULT_MS,
      },
    }
  }
  const snapshot = scope.getSnapshot()
  const value = snapshot.value ?? {}
  return {
    status: snapshot.status,
    writable: snapshot.writable,
    values: {
      sidebarQuotaCN: value.sidebarQuotaCN === true,
      sidebarQuotaGlobal: value.sidebarQuotaGlobal === true,
      autoCheckInCN: value.autoCheckInCN === true,
      autoCheckInGlobal: value.autoCheckInGlobal === true,
      checkInMinuteCN: typeof value.checkInMinuteCN === 'number' ? value.checkInMinuteCN : CHECK_IN_MINUTE_DEFAULT,
      checkInMinuteGlobal: typeof value.checkInMinuteGlobal === 'number' ? value.checkInMinuteGlobal : CHECK_IN_MINUTE_DEFAULT,
      quotaPollMs: typeof value.quotaPollMs === 'number' ? value.quotaPollMs : POLL_DEFAULT_MS,
    },
  }
}

/**
 * Stable-reference projection cache.
 *
 * React's useSyncExternalStore requires getSnapshot() to return THE SAME
 * reference between renders unless the store actually changed. project()
 * builds a fresh object every call, which re-renders forever and crashes the
 * card with React error #185 ("maximum update depth exceeded") — exactly the
 * crash the slot ledger reported. The cache below returns the last built
 * projection until the underlying scope snapshot (or scope identity) changes,
 * which is the only thing the projection actually derives from.
 */
let cachedScope: QuotaSettingsScope<QuotaSection> | undefined
let cachedSource: unknown
let cachedProjection: QuotaSettingsProjection | undefined
const UNAVAILABLE: QuotaSettingsProjection = {
  status: 'unavailable',
  writable: false,
  values: {
    sidebarQuotaCN: false,
    sidebarQuotaGlobal: false,
    autoCheckInCN: false,
    autoCheckInGlobal: false,
    checkInMinuteCN: CHECK_IN_MINUTE_DEFAULT,
    checkInMinuteGlobal: CHECK_IN_MINUTE_DEFAULT,
    quotaPollMs: POLL_DEFAULT_MS,
  },
}

function stableProject(scope: QuotaSettingsScope<QuotaSection> | undefined): QuotaSettingsProjection {
  if (scope === undefined) return UNAVAILABLE
  const next = project(scope)
  if (
    cachedProjection === undefined ||
    cachedScope !== scope ||
    cachedProjection.status !== next.status ||
    cachedProjection.writable !== next.writable ||
    cachedProjection.values.sidebarQuotaCN !== next.values.sidebarQuotaCN ||
    cachedProjection.values.sidebarQuotaGlobal !== next.values.sidebarQuotaGlobal ||
    cachedProjection.values.autoCheckInCN !== next.values.autoCheckInCN ||
    cachedProjection.values.autoCheckInGlobal !== next.values.autoCheckInGlobal ||
    cachedProjection.values.checkInMinuteCN !== next.values.checkInMinuteCN ||
    cachedProjection.values.checkInMinuteGlobal !== next.values.checkInMinuteGlobal ||
    cachedProjection.values.quotaPollMs !== next.values.quotaPollMs
  ) {
    cachedScope = scope
    cachedProjection = next
  }
  return cachedProjection
}

/** One toggle row: label, hint, and a switch drawn to the shell's proportions. */
function ToggleRow({ label, hint, checked, disabled, disabledHint, onToggle }: {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  disabledHint?: string
  onToggle: (next: boolean) => void
}): React.ReactNode {
  return (
    <div style={rowStyle}>
      <div style={rowTextStyle}>
        <span style={labelStyle}>{label}</span>
        <span style={hintStyle}>{disabled === true && disabledHint !== undefined ? disabledHint : hint}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        aria-label={label}
        onClick={() => {
          if (disabled) return
          onToggle(!checked)
        }}
        style={{
          ...switchStyle,
          background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.2))',
          justifyContent: checked ? 'flex-end' : 'flex-start',
          opacity: disabled === true ? 0.45 : 1,
          cursor: disabled === true ? 'not-allowed' : 'pointer',
        }}
      >
        <span style={knobStyle} />
      </button>
    </div>
  )
}

/**
 * One time row: the moment a variant checks in, as two typeable number fields.
 *
 * Deliberately NOT `<input type="time">`: that control's segments are spinners,
 * and with an IME active (every Chinese/Japanese keyboard) the segments refuse
 * typed digits, leaving only the tiny stepper arrows — unusable for the one
 * thing this row exists to do. Two plain number fields accept typing under any
 * input method; the value is committed on blur or Enter, so a half-typed
 * field never writes a wrong moment to the host.
 */
function TimeRow({ label, hint, value, disabled, onPick }: {
  label: string
  hint: string
  value: number
  disabled?: boolean
  onPick: (minutes: number) => void
}): React.ReactNode {
  const split = splitMinutes(value)
  const [hourDraft, setHourDraft] = useState(String(split.hours))
  const [minuteDraft, setMinuteDraft] = useState(String(split.minutes).padStart(2, '0'))

  // Re-seed the fields whenever the stored value changes underneath us (a
  // save landing, another surface editing it). Editing itself does not write
  // until commit, so this cannot fight the typist.
  useEffect(() => {
    const next = splitMinutes(value)
    setHourDraft(String(next.hours))
    setMinuteDraft(String(next.minutes).padStart(2, '0'))
  }, [value])

  const commit = (): void => {
    const parsedHours = Number.parseInt(hourDraft, 10)
    const parsedMinutes = Number.parseInt(minuteDraft, 10)
    const hours = Number.isFinite(parsedHours) ? Math.min(23, Math.max(0, parsedHours)) : split.hours
    const minutes = Number.isFinite(parsedMinutes) ? Math.min(59, Math.max(0, parsedMinutes)) : split.minutes
    const next = hours * 60 + minutes
    if (next === value) {
      // Nothing to write, but normalize what is on screen ("9" -> "09").
      setHourDraft(String(hours))
      setMinuteDraft(String(minutes).padStart(2, '0'))
      return
    }
    onPick(next)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    }
  }

  return (
    <div style={rowStyle}>
      <div style={rowTextStyle}>
        <span style={labelStyle}>{label}</span>
        <span style={hintStyle}>{hint}</span>
      </div>
      <span style={pollFieldStyle}>
        <input
          type="number"
          min={0}
          max={23}
          value={hourDraft}
          disabled={disabled}
          aria-label={`${label} — hour`}
          data-checkin-part="hour"
          onChange={event => { setHourDraft(event.target.value) }}
          onBlur={commit}
          onKeyDown={onKeyDown}
          style={{ ...timePartStyle, opacity: disabled === true ? 0.45 : 1 }}
        />
        <span style={labelStyle}>:</span>
        <input
          type="number"
          min={0}
          max={59}
          value={minuteDraft}
          disabled={disabled}
          aria-label={`${label} — minute`}
          data-checkin-part="minute"
          onChange={event => { setMinuteDraft(event.target.value) }}
          onBlur={commit}
          onKeyDown={onKeyDown}
          style={{ ...timePartStyle, opacity: disabled === true ? 0.45 : 1 }}
        />
        <span style={hintStyle}>UTC+8</span>
      </span>
    </div>
  )
}

/** The inner controls for sidebar quota settings. */
export function QuotaSettingsContent({ t = key => key, scope, signedIn }: QuotaSettingsCardInjected): React.ReactNode {
  const subscribe = useCallback((onStoreChange: () => void) => {
    return scope?.subscribe(onStoreChange) ?? (() => {})
  }, [scope])
  const projection = useSyncExternalStore(
    subscribe,
    () => stableProject(scope),
  )
  const liveSignIn = useSyncExternalStore(
    onQuotaSettingsChange,
    quotaSignInState,
  )
  const [probe, setProbe] = useState<{ cn: boolean; global: boolean }>()
  useEffect(() => {
    let disposed = false
    const probeOne = async (path: string): Promise<boolean | undefined> => {
      try {
        const response = await fetch(path, { headers: { accept: 'application/json' } })
        const body: unknown = await response.json()
        if (disposed || !isQoderWebStatus(body)) return undefined
        noteQuotaSignIn(variantOfStatusPath(path), body.status === 'signed-in')
        return body.status === 'signed-in'
      } catch {
        return undefined
      }
    }
    void (async () => {
      const [cn, global] = await Promise.all([probeOne(QODER_STATUS_PATH), probeOne(QODER_GLOBAL_STATUS_PATH)])
      if (!disposed) setProbe({ cn: cn === true, global: global === true })
    })()
    return () => {
      disposed = true
    }
  }, [])

  if (projection.status === 'unavailable') return null
  const reported = signedIn?.()

  const deriveSigned = (variant: 'cn' | 'global', variantId: 'qoder' | 'qoder-global'): boolean => {
    if (reported !== undefined) {
      return Boolean(reported[variant])
    }
    const currentStatus = quotaStatus(variantId)
    if (currentStatus?.status === 'signed-out') {
      return false
    }
    const live = liveSignIn[variant]
    if (probe !== undefined) {
      const probeResult = probe[variant]
      if (!probeResult) {
        return Boolean(live && currentStatus?.status === 'signed-in')
      }
      return Boolean(live)
    }
    return Boolean(live && currentStatus?.status === 'signed-in')
  }

  const signed = {
    cn: deriveSigned('cn', 'qoder'),
    global: deriveSigned('global', 'qoder-global'),
  }
  const write = (field: Field, value: boolean | number): void => {
    if (field === 'sidebarQuotaCN' && value === true && !signed.cn) {
      return
    }
    if (field === 'sidebarQuotaGlobal' && value === true && !signed.global) {
      return
    }
    if (field === 'autoCheckInCN' && value === true && !signed.cn) {
      return
    }
    if (field === 'autoCheckInGlobal' && value === true && !signed.global) {
      return
    }
    void scope?.set(field, value)
  }
  const minutes = Math.max(POLL_MIN_MS / 60_000, Math.round(projection.values.quotaPollMs / 60_000))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <ToggleRow
        label={t('quotaToggleCN')}
        hint={t('quotaToggleHint')}
        checked={projection.values.sidebarQuotaCN}
        disabled={!signed.cn}
        disabledHint={t('quotaSignInRequired')}
        onToggle={next => write('sidebarQuotaCN', next)}
      />
      <ToggleRow
        label={t('quotaToggleGlobal')}
        hint={t('quotaToggleHint')}
        checked={projection.values.sidebarQuotaGlobal}
        disabled={!signed.global}
        disabledHint={t('quotaSignInRequired')}
        onToggle={next => write('sidebarQuotaGlobal', next)}
      />
      <ToggleRow
        label={t('autoCheckInCN')}
        hint={t('autoCheckInHintCN')}
        checked={projection.values.autoCheckInCN}
        disabled={!signed.cn}
        disabledHint={t('quotaSignInRequired')}
        onToggle={next => write('autoCheckInCN', next)}
      />
      <TimeRow
        label={t('checkInTimeCN')}
        hint={t('checkInTimeHint')}
        value={projection.values.checkInMinuteCN}
        disabled={!signed.cn}
        onPick={next => write('checkInMinuteCN', next)}
      />
      <ToggleRow
        label={t('autoCheckInGlobal')}
        hint={t('autoCheckInHintGlobal')}
        checked={projection.values.autoCheckInGlobal}
        disabled={!signed.global}
        disabledHint={t('quotaSignInRequired')}
        onToggle={next => write('autoCheckInGlobal', next)}
      />
      <TimeRow
        label={t('checkInTimeGlobal')}
        hint={t('checkInTimeHint')}
        value={projection.values.checkInMinuteGlobal}
        disabled={!signed.global}
        onPick={next => write('checkInMinuteGlobal', next)}
      />
      <div style={{ ...rowStyle, borderBottom: 'none', paddingBottom: 0 }}>
        <div style={rowTextStyle}>
          <span style={labelStyle}>{t('quotaPollLabel')}</span>
          <span style={hintStyle}>{t('quotaPollHint')}</span>
        </div>
        <span style={pollFieldStyle}>
          <input
            type="number"
            min={POLL_MIN_MS / 60_000}
            step={1}
            value={minutes}
            aria-label={t('quotaPollLabel')}
            onChange={event => {
              const mins = Number.parseInt(event.target.value, 10)
              if (Number.isFinite(mins) && mins > 0) write('quotaPollMs', Math.max(POLL_MIN_MS, mins * 60_000))
            }}
            style={inputStyle}
          />
          <span style={hintStyle}>{t('quotaPollUnit')}</span>
        </span>
      </div>
      {projection.writable === false ? <span style={hintStyle}>{t('quotaSettingsSaveFailed')}</span> : null}
    </div>
  )
}

/** The standalone shared quota-settings card. */
export function QuotaSettingsCard(props: QuotaSettingsCardProps): React.ReactNode {
  const { t = key => key, scope, signedIn } = props
  const subscribe = useCallback((onStoreChange: () => void) => {
    return scope?.subscribe(onStoreChange) ?? (() => {})
  }, [scope])
  const projection = useSyncExternalStore(
    subscribe,
    () => stableProject(scope),
  )
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [headerFocused, setHeaderFocused] = useState(false)

  if (projection.status === 'unavailable') return null
  return (
    <li
      style={{ ...cardStyle, ...(hovered ? cardHoverStyle : {}), ...(open ? cardOpenStyle : {}) }}
      onMouseEnter={() => { setHovered(true) }}
      onMouseLeave={() => { setHovered(false) }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('quotaSettingsTitle')}`}
        onClick={() => setOpen(o => !o)}
        onFocus={event => {
          let keyboard = true
          try {
            keyboard = event.currentTarget.matches(':focus-visible')
          } catch {
            keyboard = true
          }
          if (keyboard) setHeaderFocused(true)
        }}
        onBlur={() => { setHeaderFocused(false) }}
        style={{ ...headerButtonStyle, ...(headerFocused ? headerFocusStyle : {}) }}
      >
        <span style={headTextStyle}>
          <span style={titleStyle}>{t('quotaSettingsTitle')}</span>
          <span style={introStyle}>{t('quotaSettingsIntro')}</span>
        </span>
        <span style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>
          <ChevronDownIcon />
        </span>
      </button>
      {open ? (
        <div style={cardBodyStyle}>
          <QuotaSettingsContent t={t} scope={scope} signedIn={signedIn} />
        </div>
      ) : null}
    </li>
  )
}

/** The disclosure chevron, drawn from the same path data as the variant cards'. */
function ChevronDownIcon(): React.ReactNode {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

/* ---- styles: verbatim copies of QoderPluginCard's card constants ---- */

const cardStyle: CSSProperties = {
  listStyle: 'none',
  // Border as longhands, never the shorthand (the variant card's comment
  // explains why: React's style-diff clear breaks shorthands).
  borderWidth: '0.5px',
  borderStyle: 'solid',
  borderColor: 'var(--dsw-alias-border-l4)',
  borderRadius: 16,
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}
/** Hover, matching the built-in card's `:hover` (inline styles cannot express pseudo-classes). */
const cardHoverStyle: CSSProperties = { borderColor: 'var(--dsw-alias-label-dimmed)' }
/** Expanded, matching the built-in card's open state. */
const cardOpenStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}
const headerButtonStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  border: 0,
  borderRadius: 12,
  padding: '14px 16px',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  // The built-in header declares this too; without it a native button can
  // paint its own chrome on top of the transparent background.
  appearance: 'none',
}
const headerFocusStyle: CSSProperties = { outline: '2px solid var(--dsw-alias-brand-primary)', outlineOffset: -2 }
const headTextStyle: CSSProperties = { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 4 }
const titleStyle: CSSProperties = { fontSize: 15, lineHeight: 1.4, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const introStyle: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
/** The variant cards' chevron rule. */
const chevronStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  color: 'var(--dsw-alias-label-tertiary)',
  transition: 'transform .16s',
}
/** The variant cards' body: hairline top border, inset margins, no extra box. */
const cardBodyStyle: CSSProperties = {
  borderTop: '.5px solid var(--dsw-alias-border-l2)',
  margin: '0 16px',
  padding: '12px 0 8px',
}
/**
 * One settings row: NO box of its own (the bordered rows read as nested
 * cards, which the user ruled against) — rows are separated by a hairline
 * bottom rule like the settings shell's own preference lists.
 */
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  borderBottom: '.5px solid var(--dsw-alias-border-l2)',
  paddingBottom: 10,
}
const rowTextStyle: CSSProperties = { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 2 }
const labelStyle: CSSProperties = { fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' }
const hintStyle: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
const switchStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  width: 36,
  height: 20,
  borderRadius: 10,
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--dsw-alias-border-l2)',
  padding: 1,
  cursor: 'pointer',
  alignItems: 'center',
  transition: 'background .16s',
}
const knobStyle: CSSProperties = { display: 'block', width: 16, height: 16, borderRadius: '50%', background: 'var(--dsw-alias-bg-layer-1, #fff)', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }
const pollFieldStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }
const timePartStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: 56,
  padding: '5px 8px',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
  textAlign: 'center',
}
const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: 55,
  padding: '5px 8px',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
  textAlign: 'right',
}
