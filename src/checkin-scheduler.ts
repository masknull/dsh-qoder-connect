/** Scheduling and catch-up orchestration for daily 10:00 (UTC+8) check-in. */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { QoderCheckInResult } from './qoder/transport/checkin.ts'
import { qoderPluginDataDir } from './paths.ts'
import { formatUtc8Date, utc8WallClock } from './utc8.ts'

/**
 * One saved account the daily benefit can be claimed for.
 *
 * Carries the token because the claim is per-credential: the same machine, the
 * same day, and every saved PAT has its own untouched window. The id is the
 * credential store's stable local id, which is what keys the status record.
 */
export interface CheckInAccount {
  /** Stable local id of the saved credential; the store's key dimension. */
  id: string
  /** The token itself. Host-side only: never logged, never sent to the card. */
  pat: string
  /** Display label of the saved entry, when the user gave one. */
  label?: string | undefined
  /** Last four characters of the token, for the log row. */
  patTail?: string | undefined
}

export interface VariantCheckInTarget {
  variantId: string
  /**
   * Claim today's benefit for this variant's active account.
   *
   * The variant's transport owns credential resolution, so this takes no token; a
   * missing credential surfaces as an `error` result rather than a throw, so one
   * signed-out variant cannot stop the sweep for the other.
   */
  checkIn: (signal?: AbortSignal) => Promise<QoderCheckInResult>
  /**
   * The moment this variant checks in, as minutes past midnight in UTC+8.
   *
   * A getter, not a value: the user can retime it on the card and the scheduler
   * must see the new value on its next pass without being rebuilt.
   */
  minuteOfDay: () => number
  onClaimed?: () => void
  /**
   * Every saved account of this variant, newest first.
   *
   * Absent, empty, or rejecting leaves the sweep on its single-account path: an
   * environment token has no saved list, and a credential read that fails must not
   * cost the active account its day.
   */
  accounts?: (() => Promise<readonly CheckInAccount[]>) | undefined
  /** Claim for one specific account; paired with {@link accounts}. */
  checkInAs?: ((account: CheckInAccount, signal?: AbortSignal) => Promise<QoderCheckInResult>) | undefined
  /**
   * Report a claim that landed, for the account that earned it.
   *
   * Separate from `onClaimed`: the quota refresh reads the *active* token, so
   * crediting a background account must not rewrite the card with another
   * account's balance.
   */
  onAccountClaimed?: (account: CheckInAccount) => void
}

/** The outcome of one claim attempt. */
export type CheckInStatus = 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error'

export interface CheckInLogItem {
  id: string
  date: string
  timestamp: number
  status: CheckInStatus
  amount?: number | undefined
  campaignKey?: string | undefined
  message?: string | undefined
  /** Which saved token this row belongs to, once a variant claims per account. */
  account?: CheckInAccountTag | undefined
}

/** The secret-free half of a {@link CheckInAccount}, safe to persist and render. */
export interface CheckInAccountTag {
  id: string
  label?: string | undefined
  patTail?: string | undefined
}

/**
 * What one account's last attempt settled to.
 *
 * Held per credential because the daily window belongs to the account, not to the
 * machine: a token that already claimed today is done for today, and its sibling
 * is not.
 */
export interface CheckInAccountState {
  date: string
  status: CheckInStatus
  amount?: number | undefined
}

export interface CheckInRecord {
  /** The most recent attempt of any account, for the card's header row. */
  lastDate: string
  lastAt: number
  status: CheckInStatus
  amount?: number | undefined
  message?: string | undefined
  logs?: CheckInLogItem[] | undefined
  /** The account the header row describes; absent on pre-per-account files. */
  account?: CheckInAccountTag | undefined
  /**
   * Per-account day flags, keyed by credential id: what the sweep consults before
   * claiming. The header row above is display state and cannot answer "has this
   * token claimed today", so this map is the authority.
   */
  accounts?: Record<string, CheckInAccountState> | undefined
}

export interface CheckInStatusStore {
  read(variantId: string): CheckInRecord | undefined
  write(variantId: string, record: CheckInRecord): void
  clearLogs(variantId: string): void
}

/**
 * Whether one account's day is settled.
 *
 * Only an actually claimed day is: "no campaign", "before window" and errors must
 * stay retryable, otherwise one early failure burns the whole day.
 *
 * An account with no flag of its own falls back to the record's header row when it
 * is the variant's only account — the shape every file written before per-account
 * claiming carries, so an upgrade does not re-POST a settled day.
 */
export function isAccountSettledToday(
  record: CheckInRecord | undefined,
  today: string,
  accountId?: string | undefined,
  soleAccount?: boolean | undefined,
): boolean {
  if (record === undefined) return false
  const state = accountId === undefined ? undefined : record.accounts?.[accountId]
  if (state !== undefined) {
    return state.date === today && (state.status === 'claimed' || state.status === 'already-claimed')
  }
  if (soleAccount === true) {
    return record.lastDate === today && (record.status === 'claimed' || record.status === 'already-claimed')
  }
  return false
}

/** How many rows the card keeps per variant, across every account. */
export const CHECK_IN_LOG_LIMIT = 30

/** Strip the secret from an account, leaving what a record and the card may carry. */
export function checkInAccountTag(account: CheckInAccount): CheckInAccountTag {
  return {
    id: account.id,
    ...account.label === undefined ? {} : { label: account.label },
    ...account.patTail === undefined ? {} : { patTail: account.patTail },
  }
}

export class JsonFileCheckInStore implements CheckInStatusStore {
  private readonly filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(qoderPluginDataDir(), 'checkin-status.json')
  }

  private readAll(): Record<string, CheckInRecord> {
    try {
      if (!existsSync(this.filePath)) return {}
      const raw = readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as Record<string, CheckInRecord>
    } catch {
      return {}
    }
  }

  read(variantId: string): CheckInRecord | undefined {
    return this.readAll()[variantId]
  }

  clearLogs(variantId: string): void {
    try {
      const all = this.readAll()
      if (all[variantId]) {
        all[variantId] = {
          ...all[variantId],
          logs: [],
        }
        mkdirSync(dirname(this.filePath), { recursive: true })
        writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
      }
    } catch {
      // Best-effort persistence
    }
  }

  write(variantId: string, record: CheckInRecord): void {
    try {
      const all = this.readAll()
      const existing = all[variantId]
      const existingLogs = existing?.logs ?? []
      // The id names the account as well as the instant: one sweep claims several
      // tokens in the same second, and a date-plus-time key would let the later
      // row overwrite the earlier one — the log would read as a single account's
      // day when every saved token was signed.
      const newLog: CheckInLogItem = {
        id: `${record.lastDate}-${record.lastAt}${record.account === undefined ? '' : `-${record.account.id}`}`,
        date: record.lastDate,
        timestamp: record.lastAt,
        status: record.status,
        ...record.amount === undefined ? {} : { amount: record.amount },
        ...record.message === undefined ? {} : { message: record.message },
        ...record.account === undefined ? {} : { account: record.account },
      }
      const updatedLogs = [newLog, ...existingLogs.filter(l => l.id !== newLog.id)].slice(0, CHECK_IN_LOG_LIMIT)
      all[variantId] = {
        ...record,
        logs: updatedLogs,
      }
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
    } catch {
      // Best-effort persistence
    }
  }
}

/**
 * The moment a variant checks in, as minutes past midnight in UTC+8.
 *
 * 600 is 10:00, which is when the upstream resets the daily campaign; it is
 * also the default a variant falls back to when its setting is absent or
 * malformed, so a bad stored value can never leave the day unscheduled.
 */
export const DEFAULT_CHECK_IN_MINUTE = 600

/**
 * The earliest moment a variant may be scheduled for: the window's opening.
 *
 * An earlier moment would read the *previous* window's status and settle a day
 * that was never claimed. The settings schema refuses such a value; this is the
 * floor a stored one is lifted to, so an old or hand-edited config still lands on
 * something honourable.
 */
export const EARLIEST_CHECK_IN_MINUTE = DEFAULT_CHECK_IN_MINUTE

/** Clamp any stored/typed value onto a minute the plugin can actually honour. */
export function normalizeCheckInMinute(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHECK_IN_MINUTE
  const whole = Math.trunc(value)
  if (whole < 0 || whole > 1439) return DEFAULT_CHECK_IN_MINUTE
  return Math.max(EARLIEST_CHECK_IN_MINUTE, whole)
}

/**
 * Calculates milliseconds until the next occurrence of `minuteOfDay` (UTC+8).
 *
 * Five seconds past the configured minute are used so the request lands after
 * the upstream has flipped the day over rather than on the boundary itself.
 */
export function msUntilNextCheckIn(minuteOfDay: number, nowMs: number = Date.now()): number {
  const minute = normalizeCheckInMinute(minuteOfDay)
  // Calculate current UTC+8 wall clock
  const utc8Time = utc8WallClock(nowMs)
  const targetUtc8 = new Date(utc8Time.getTime())
  targetUtc8.setHours(Math.floor(minute / 60), minute % 60, 5, 0)

  let diff = targetUtc8.getTime() - utc8Time.getTime()
  if (diff <= 0) {
    // Today's moment has passed, schedule for tomorrow
    targetUtc8.setDate(targetUtc8.getDate() + 1)
    diff = targetUtc8.getTime() - utc8Time.getTime()
  }
  return diff
}

/**
 * Whether today's configured check-in moment (UTC+8) has already passed.
 */
export function isPastCheckInTime(minuteOfDay: number, nowMs: number = Date.now()): boolean {
  const minute = normalizeCheckInMinute(minuteOfDay)
  const utc8 = utc8WallClock(nowMs)
  return utc8.getHours() * 60 + utc8.getMinutes() >= minute
}

/** One account's answer from a manual run, secret-free. */
export interface CheckInAccountOutcome {
  account: CheckInAccountTag
  status: CheckInStatus
  amount?: number | undefined
  message?: string | undefined
}

/** What an immediate claim did, across every account it walked. */
export interface CheckInRunOutcome {
  status: CheckInStatus
  amount?: number | undefined
  message?: string | undefined
  /** Per-account rows; empty for a variant with a single credential. */
  outcomes: CheckInAccountOutcome[]
}

export interface CheckInSchedulerOptions {
  targets: VariantCheckInTarget[]
  isEnabled: (variantId: string) => boolean
  store?: CheckInStatusStore | undefined
  onResult?: ((result: QoderCheckInResult) => void) | undefined
  now?: (() => number) | undefined
}

export class CheckInScheduler {
  private readonly targets: VariantCheckInTarget[]
  private readonly isEnabled: (variantId: string) => boolean
  private readonly store: CheckInStatusStore
  private readonly onResult: ((result: QoderCheckInResult) => void) | undefined
  private readonly now: () => number
  /**
   * One timer per enabled variant, keyed by variant id.
   *
   * Per-variant because the two products may check in at different moments.
   */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /**
   * Variants with a sweep in progress, so concurrent callers cannot double-claim,
   * and so a manual run can wait for the sweep already in the air instead of
   * racing it.
   */
  private readonly inFlight = new Map<string, Promise<void>>()
  /** When each variant's timer is next due, epoch ms, for the card to show. */
  private readonly nextRuns = new Map<string, number>()
  private disposed = false

  constructor(options: CheckInSchedulerOptions) {
    this.targets = options.targets
    this.isEnabled = options.isEnabled
    this.store = options.store ?? new JsonFileCheckInStore()
    this.onResult = options.onResult
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.disposed) return
    // Immediate catch-up evaluation on startup
    void this.sweepAll(true)
    this.rearm()
  }

  /**
   * Re-run the startup catch-up once the toggles are actually readable.
   *
   * `start()` runs before the settings section hands over its stored values, so
   * the first sweep may skip the day. The sweep is idempotent, so a day already
   * handled costs nothing.
   */
  catchUp(): void {
    if (this.disposed) return
    void this.sweepAll(true)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * Re-place every variant's timer.
   *
   * Called after each fire and whenever configuration lands, so a retimed card
   * takes effect without a restart. A timer is placed for every target, including
   * disabled variants: `start()` runs before the stored toggles are readable, and
   * gating placement on `isEnabled` left the variant with no timer and nothing to
   * re-arm it. Whether work is due is decided in the sweep; the timer only decides
   * when to look.
   */
  rearm(): void {
    if (this.disposed) return
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.nextRuns.clear()
    const nowMs = this.now()
    for (const target of this.targets) {
      const delay = msUntilNextCheckIn(target.minuteOfDay(), nowMs)
      // Published so the card can say when the next automatic run is due: a day
      // already claimed goes quiet by design, and silence looks like a broken
      // scheduler.
      this.nextRuns.set(target.variantId, nowMs + delay)
      const timer = setTimeout(() => {
        this.timers.delete(target.variantId)
        void this.sweepAll(false, target.variantId).finally(() => { this.rearm() })
      }, delay)
      timer.unref?.()
      this.timers.set(target.variantId, timer)
    }
  }

  /** When this variant's timer is next due, epoch ms; absent before first arm. */
  nextRunAt(variantId: string): number | undefined {
    return this.nextRuns.get(variantId)
  }

  async sweepAll(isCatchUp: boolean, only?: string): Promise<void> {
    if (this.disposed) return
    const nowMs = this.now()
    const today = formatUtc8Date(nowMs)

    for (const target of this.targets) {
      if (only !== undefined && target.variantId !== only) continue
      if (!this.isEnabled(target.variantId)) continue
      // One variant is never swept twice at once: `start()` and the settings
      // section's first catch-up can both be in the air during assembly. The
      // guard holds the run's promise so a manual claim can wait it out.
      if (this.inFlight.has(target.variantId)) continue
      const running = this.sweepOne(target, isCatchUp, nowMs, today)
      this.inFlight.set(target.variantId, running)
      try {
        await running
      } finally {
        this.inFlight.delete(target.variantId)
      }
    }
  }

  /**
   * Run one variant's daily claim immediately, for every saved account.
   *
   * The card's manual button. Unlike the scheduled sweep this never treats a day
   * as settled: the user asked for an attempt, and an upstream that reported "no
   * campaign" a minute ago may answer now. It still waits for a sweep already in
   * the air rather than racing it toward a double claim.
   *
   * @returns `undefined` when this variant has no scheduler target at all, so the
   *   caller can fall back to claiming through the credential directly.
   */
  async checkInNow(variantId: string): Promise<CheckInRunOutcome | undefined> {
    const target = this.targets.find(candidate => candidate.variantId === variantId)
    if (target === undefined) return undefined
    const running = this.inFlight.get(variantId)
    if (running !== undefined) await running.catch(() => undefined)
    if (this.disposed) return undefined

    const accounts = await this.accountsOf(target)
    if (accounts === undefined) {
      // One credential, the active one: the same call the card made before
      // per-account claiming existed.
      const result = await target.checkIn()
      this.recordActiveResult(target, result)
      return {
        status: result.status,
        ...result.amount === undefined ? {} : { amount: result.amount },
        ...result.message === undefined ? {} : { message: result.message },
        outcomes: [],
      }
    }

    const outcomes: CheckInAccountOutcome[] = []
    let claimed = 0
    for (const account of accounts) {
      if (this.disposed) break
      try {
        const result = await target.checkInAs!(account)
        this.recordAccountResult(target, account, result)
        outcomes.push({
          account: checkInAccountTag(account),
          status: result.status,
          ...result.amount === undefined ? {} : { amount: result.amount },
          ...result.message === undefined ? {} : { message: result.message },
        })
        if (result.status === 'claimed') claimed += result.amount ?? 100
      } catch (error: unknown) {
        outcomes.push({
          account: checkInAccountTag(account),
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const first = outcomes[0]
    // The card reads one reason off the aggregate: a run where accounts failed
    // must not sit silent, so the per-account errors are joined here.
    const failureReasons = [...new Set(outcomes
      .filter(outcome => outcome.status === 'error')
      .map(outcome => outcome.message ?? 'unknown error'))]
    return {
      // One account answers exactly as the single-account card always did; only a
      // multi-account run needs an aggregate, which reports what the run won.
      status: outcomes.length === 1 ? first!.status : claimed > 0 ? 'claimed' : first?.status ?? 'error',
      ...(claimed > 0
        ? { amount: claimed }
        : outcomes.length === 1 ? { ...first?.amount === undefined ? {} : { amount: first.amount } } : {}),
      ...failureReasons.length === 0 ? {} : { message: failureReasons.join('; ') },
      outcomes,
    }
  }

  /** Record a claim made through the active credential, as before per-account runs. */
  private recordActiveResult(target: VariantCheckInTarget, result: QoderCheckInResult): void {
    try {
      if (result.status !== 'error') {
        const previous = this.store.read(target.variantId)
        this.store.write(target.variantId, {
          lastDate: result.date,
          lastAt: result.timestamp,
          status: result.status,
          amount: result.amount,
          message: result.message,
          ...previous?.accounts === undefined ? {} : { accounts: previous.accounts },
        })
        if (result.status === 'claimed') target.onClaimed?.()
      }
      this.onResult?.(result)
    } catch {
      // Ignored to protect loop
    }
  }

  private async sweepOne(
    target: VariantCheckInTarget,
    isCatchUp: boolean,
    nowMs: number,
    today: string,
  ): Promise<void> {
    // A catch-up run only makes sense once this variant's configured moment
    // has passed; before it, the variant's own timer still owns today.
    if (isCatchUp && !isPastCheckInTime(target.minuteOfDay(), nowMs)) return

    // Every saved token gets its own window: the same machine, the same day, and
    // each account still unclaimed. A variant that lists no accounts — an
    // environment token, a credential read that failed — keeps the single-account
    // path it had before, so signing in one way cannot cost the other its day.
    const accounts = await this.accountsOf(target)
    if (accounts === undefined) {
      await this.sweepActive(target, isCatchUp, nowMs, today)
      return
    }

    const record = this.store.read(target.variantId)
    // A variant with exactly one saved token still reads the legacy header row, so
    // an upgrade does not re-POST a day that token already claimed. With several
    // tokens the header row describes only one of them and proves nothing about the
    // rest, so each needs its own flag.
    const sole = accounts.length === 1
    const settled = accounts.filter(account => isAccountSettledToday(record, today, account.id, sole))
    if (settled.length === accounts.length) {
      // A scheduled run that finds every account already handled still leaves a
      // row: total silence is indistinguishable from a timer that never fired.
      if (!isCatchUp) {
        this.store.write(target.variantId, {
          lastDate: today,
          lastAt: nowMs,
          status: 'already-claimed',
          ...record?.amount === undefined ? {} : { amount: record.amount },
          message: 'Scheduled check-in ran; today was already claimed',
          ...record?.accounts === undefined ? {} : { accounts: record.accounts },
        })
      }
      return
    }

    for (const account of accounts) {
      if (this.disposed) return
      if (isAccountSettledToday(this.store.read(target.variantId), today, account.id, sole)) continue
      let result: QoderCheckInResult
      try {
        result = await target.checkInAs!(account)
      } catch {
        // One bad token must not burn the others: an unreachable account is not a
        // settled day, so the next sweep retries it.
        continue
      }
      this.recordAccountResult(target, account, result)
    }
  }

  /** The saved accounts to sweep, or `undefined` for the legacy single-account path. */
  private async accountsOf(target: VariantCheckInTarget): Promise<readonly CheckInAccount[] | undefined> {
    if (target.accounts === undefined || target.checkInAs === undefined) return undefined
    try {
      const listed = await target.accounts()
      return listed.length > 0 ? listed : undefined
    } catch {
      // A credential read that fails is not a reason to skip the day entirely.
      return undefined
    }
  }

  /**
   * Persist one account's attempt.
   *
   * The result carries its own timestamp — the instant the upstream saw it, not
   * when the sweep began — so accounts claimed in one run keep distinct log rows
   * even though the run is measured once.
   */
  private recordAccountResult(
    target: VariantCheckInTarget,
    account: CheckInAccount,
    result: QoderCheckInResult,
  ): void {
    try {
      if (result.status === 'error') {
        // As before: a failed attempt is not a settled day, so nothing is
        // recorded and the next sweep retries this account. The result still
        // reaches `onResult`, so a manual run reports what went wrong.
        this.onResult?.(result)
        return
      }
      const previous = this.store.read(target.variantId)
      const accounts = { ...previous?.accounts }
      accounts[account.id] = {
        date: result.date,
        status: result.status,
        ...result.amount === undefined ? {} : { amount: result.amount },
      }
      // `logs` is left to the store, which prepends the row built from these
      // fields and caps the history: both the single- and per-account paths end
      // up with one writer for the history.
      this.store.write(target.variantId, {
        lastDate: result.date,
        lastAt: result.timestamp,
        status: result.status,
        ...result.amount === undefined ? {} : { amount: result.amount },
        ...result.message === undefined ? {} : { message: result.message },
        account: checkInAccountTag(account),
        accounts,
      })
      if (result.status === 'claimed') {
        target.onAccountClaimed?.(account)
      }
      this.onResult?.(result)
    } catch {
      // Ignored to protect loop
    }
  }

  /**
   * The pre-per-account path: claim once through the variant's own credential.
   *
   * Still the whole story for a variant signed in by environment token, and the
   * fallback when the saved list is unreadable.
   */
  private async sweepActive(
    target: VariantCheckInTarget,
    isCatchUp: boolean,
    nowMs: number,
    today: string,
  ): Promise<void> {
    const record = this.store.read(target.variantId)
    const settledToday = isAccountSettledToday(record, today, undefined, true)
    if (settledToday) {
      // A scheduled run that finds the day already handled still leaves a row:
      // total silence is indistinguishable from a timer that never fired.
      if (!isCatchUp) {
        this.store.write(target.variantId, {
          lastDate: today,
          lastAt: nowMs,
          status: 'already-claimed',
          ...record?.amount === undefined ? {} : { amount: record.amount },
          message: 'Scheduled check-in ran; today was already claimed',
        })
      }
      return
    }

    let result: QoderCheckInResult
    try {
      result = await target.checkIn()
    } catch {
      // A transport-level throw (no credential at all, a rejection) is not a
      // settled day: leave the record alone so a later sweep can retry.
      return
    }
    try {
      if (result.status !== 'error') {
        this.store.write(target.variantId, {
          lastDate: result.date,
          lastAt: result.timestamp,
          status: result.status,
          amount: result.amount,
          message: result.message,
          ...record?.accounts === undefined ? {} : { accounts: record.accounts },
          ...record?.logs === undefined ? {} : { logs: record.logs },
        })
        if (result.status === 'claimed') {
          target.onClaimed?.()
        }
      }
      this.onResult?.(result)
    } catch {
      // Ignored to protect loop
    }
  }
}
