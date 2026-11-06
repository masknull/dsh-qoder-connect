/**
 * Per-turn Qoder request identity.
 *
 * One DSH turn is many model requests: every reasoning step sends its own
 * `agent_chat_generation` POST. Qoder's Credits panel aggregates consumption per
 * agent run — the `business.id` a request reports — so every step of one turn must
 * carry the same run identity, while the next human prompt opens a new one.
 *
 * Without this, `business.id` equaled the per-call `request_set_id`, so each step
 * became its own usage record.
 *
 * The boundary is derived from the request's own messages: the loop stamps a human
 * prompt with a durable message id and `source.kind === 'user'`, while everything
 * the host injects around it (time snapshot, runtime context, model-switch notice,
 * subagent messages, question replies) carries its own producer kind. A human
 * message id this run has not claimed yet therefore opens a turn; appended context
 * joins the open one. A model switch inside a turn keeps the same record.
 *
 * @module dsh-qoder-connect/qoder/transport/wire/turn-identity
 */

import crypto from 'node:crypto'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/** How one request relates to a subscriber turn. */
export type QoderCallKind = 'conversation' | 'auxiliary'

/** Run identity shared by every request of one turn. */
export interface QoderTurnIdentity {
  /** Queue key and legacy record id: stable for the whole turn. */
  readonly requestSetId: string
  /** Agent run the Credits panel aggregates against. */
  readonly businessId: string
  /** When the agent run opened, epoch milliseconds. */
  readonly beginAt: number
  /** `start` opens the run; every later request of the turn reports `processing`. */
  readonly stage: 'start' | 'processing'
  /** Label the Credits panel shows; the opening prompt, bounded. */
  readonly businessName: string
}

/** Longest label the panel renders; the official client uses ten characters. */
const businessNameLimit = 10

/** Bounded memory: one entry per conversation this process serves. */
const defaultMaxSessions = 64

/** A conversation untouched for this long cannot still be mid-turn. */
const defaultIdleSessionTtlMs = 60 * 60 * 1000

/** Auxiliary calls (title, compaction) group in a short fixed window. */
const defaultAuxiliaryWindowTtlMs = 5 * 60 * 1000

interface SessionTurnState {
  /** Human messages this run has claimed, keyed by {@link promptKey}. */
  readonly claimed: Set<string>
  businessId: string
  beginAt: number
  businessName: string
  /** Whether the open run already reported its `start` stage. */
  started: boolean
  lastTouchedAt: number
}

interface AuxiliaryWindow {
  expiresAt: number
  identity: QoderTurnIdentity
}

/** Tracker options; every field exists so tests can freeze time and memory. */
export interface QoderTurnTrackerOptions {
  maxSessions?: number
  idleSessionTtlMs?: number
  auxiliaryWindowTtlMs?: number
  now?: () => number
}

/** One human message, as the turn boundary sees it. */
interface PromptKey {
  key: string
  text: string
}

/** Whether one message is human input rather than host-injected context. */
export function isHumanPrompt(message: RequestMessage): boolean {
  if (message.role !== 'user') return false
  const source = (message as { source?: { kind?: string } | undefined }).source
  // A loop-built request stamps a human prompt with `kind: 'user'`; anything the
  // host injects carries its own producer kind. A one-shot caller's identity-free
  // user input has no source at all and is the prompt by construction.
  return source === undefined || source.kind === 'user'
}

/** Concatenated text of one message. */
function messageText(message: RequestMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  let text = ''
  for (const block of content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/**
 * Identity of one human message.
 *
 * The durable message id is authoritative. A one-shot caller's identity-free input
 * has none, so its text stands in; images are counted rather than hashed because a
 * published URL is re-signed as its cache entry expires.
 */
function promptKey(message: RequestMessage): PromptKey {
  const text = messageText(message)
  const id = (message as { id?: unknown }).id
  if (typeof id === 'string' && id.length > 0) return { key: `id:${id}`, text }
  const hash = crypto.createHash('sha256')
  hash.update(text)
  let images = 0
  const content = message.content
  if (typeof content !== 'string') {
    for (const block of content) if (block.type === 'image') images += 1
  }
  hash.update(`\0images=${images}`)
  return { key: `text:${hash.digest('hex').slice(0, 16)}`, text }
}

/** The run label: the opening prompt, bounded to what the panel renders. */
function businessNameOf(text: string): string {
  return text.trim().slice(0, businessNameLimit)
}

/**
 * Resolve one request's human prompts.
 *
 * @param messages - the request's model-facing messages, in order.
 * @returns the human prompts it carries, oldest first.
 */
export function humanPrompts(messages: readonly RequestMessage[] | undefined): PromptKey[] {
  const prompts: PromptKey[] = []
  // A hand-built caller may omit the list entirely; that is not a turn boundary.
  for (const message of messages ?? []) if (isHumanPrompt(message)) prompts.push(promptKey(message))
  return prompts
}

/**
 * Resolves the agent-run identity one request belongs to.
 *
 * One instance serves a whole provider route. State is bounded by `maxSessions`
 * and drops idle conversations first, so a long-running process cannot grow
 * without limit while an active turn keeps its identity.
 */
export class QoderTurnTracker {
  private readonly maxSessions: number
  private readonly idleSessionTtlMs: number
  private readonly auxiliaryWindowTtlMs: number
  private readonly now: () => number
  private readonly sessions = new Map<string, SessionTurnState>()
  private readonly auxiliary = new Map<string, AuxiliaryWindow>()

  constructor(options: QoderTurnTrackerOptions = {}) {
    this.maxSessions = options.maxSessions ?? defaultMaxSessions
    this.idleSessionTtlMs = options.idleSessionTtlMs ?? defaultIdleSessionTtlMs
    this.auxiliaryWindowTtlMs = options.auxiliaryWindowTtlMs ?? defaultAuxiliaryWindowTtlMs
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Resolve the identity for one request.
   *
   * @param sessionId - the DSH conversation, when the caller supplied one.
   * @param messages - the request's model-facing messages, in order.
   * @param kind - `auxiliary` calls never open or displace a subscriber turn.
   * @returns the identity to stamp on the wire request.
   */
  resolve(
    sessionId: string | undefined,
    messages: readonly RequestMessage[] | undefined,
    kind: QoderCallKind,
  ): QoderTurnIdentity {
    const now = this.now()
    const prompts = humanPrompts(messages)
    if (kind === 'auxiliary' || sessionId === undefined || sessionId.length === 0) {
      return this.windowIdentity(kind === 'auxiliary' ? 'aux' : 'anon', prompts, now)
    }

    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      const opened = this.openRun(prompts, now)
      this.sessions.set(sessionId, opened)
      return this.startIdentity(opened)
    }

    // Refresh recency so eviction drops the coldest conversation.
    state.lastTouchedAt = now
    this.sessions.delete(sessionId)
    this.sessions.set(sessionId, state)

    // A human message this run has not claimed is the next turn. Everything the
    // host appended around the previous prompt is never claimed here, so it cannot
    // open one.
    let opening: PromptKey | undefined
    for (const prompt of prompts) {
      if (state.claimed.has(prompt.key)) continue
      opening ??= prompt
    }

    if (opening !== undefined) {
      const opened = this.openRun(prompts, now, opening.text)
      this.sessions.set(sessionId, opened)
      return this.startIdentity(opened)
    }

    // A conversation whose first request carried no human prompt still belongs to
    // a run; it keeps that run until a real prompt arrives.
    const stage = state.started ? 'processing' : 'start'
    state.started = true
    return {
      requestSetId: state.businessId,
      businessId: state.businessId,
      beginAt: state.beginAt,
      stage,
      businessName: state.businessName,
    }
  }

  /** Forget every conversation; used when the provider is disposed. */
  clear(): void {
    this.sessions.clear()
    this.auxiliary.clear()
  }

  /** How many conversations are tracked; tests read it to check eviction. */
  get size(): number {
    return this.sessions.size
  }

  /** Stamp the opening request of a freshly opened run. */
  private startIdentity(state: SessionTurnState): QoderTurnIdentity {
    state.started = true
    return {
      requestSetId: state.businessId,
      businessId: state.businessId,
      beginAt: state.beginAt,
      stage: 'start',
      businessName: state.businessName,
    }
  }

  /** Open a run, claiming every human prompt this request already carries. */
  private openRun(
    prompts: readonly PromptKey[],
    now: number,
    nameSource?: string,
  ): SessionTurnState {
    const claimed = new Set<string>()
    let firstText = ''
    for (const prompt of prompts) {
      claimed.add(prompt.key)
      if (firstText === '') firstText = prompt.text
    }
    this.evict(now)
    return {
      claimed,
      businessId: crypto.randomUUID(),
      beginAt: now,
      businessName: businessNameOf(nameSource ?? firstText),
      started: false,
      lastTouchedAt: now,
    }
  }

  /** Auxiliary and session-less calls group in a short fixed window. */
  private windowIdentity(
    scope: string,
    prompts: readonly PromptKey[],
    now: number,
  ): QoderTurnIdentity {
    const existing = this.auxiliary.get(scope)
    if (existing !== undefined && existing.expiresAt > now) {
      return { ...existing.identity, stage: 'processing' }
    }
    this.pruneAuxiliary(now)
    const businessId = crypto.randomUUID()
    const identity: QoderTurnIdentity = {
      requestSetId: businessId,
      businessId,
      beginAt: now,
      stage: 'start',
      businessName: businessNameOf(prompts.at(-1)?.text ?? ''),
    }
    this.auxiliary.set(scope, { expiresAt: now + this.auxiliaryWindowTtlMs, identity })
    return identity
  }

  /** Drop expired windows; they are short-lived, so the map stays small. */
  private pruneAuxiliary(now: number): void {
    for (const [scope, window] of this.auxiliary) {
      if (window.expiresAt <= now) this.auxiliary.delete(scope)
    }
  }

  /** Evict one conversation when the ceiling is reached, preferring idle ones. */
  private evict(now: number): void {
    if (this.sessions.size < this.maxSessions) return
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, state] of this.sessions) {
      // An active turn is never the coldest, and must never be split.
      if (now - state.lastTouchedAt < this.idleSessionTtlMs) continue
      if (state.lastTouchedAt < oldestAt) {
        oldestAt = state.lastTouchedAt
        oldestKey = key
      }
    }
    // A process serving more live conversations than the ceiling keeps the
    // oldest one rather than splitting a turn that is still running.
    if (oldestKey !== undefined) this.sessions.delete(oldestKey)
  }
}

/** Narrow an untrusted wire value back into a turn identity. */
export function parseTurnIdentity(value: unknown): QoderTurnIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const text = (name: string): string | undefined =>
    typeof record[name] === 'string' && (record[name] as string).length > 0 ? record[name] as string : undefined
  const requestSetId = text('requestSetId')
  const businessId = text('businessId')
  const beginAt = record['beginAt']
  const stage = record['stage']
  if (requestSetId === undefined || businessId === undefined) return undefined
  if (typeof beginAt !== 'number' || !Number.isFinite(beginAt)) return undefined
  if (stage !== 'start' && stage !== 'processing') return undefined
  return {
    requestSetId,
    businessId,
    beginAt,
    stage,
    businessName: typeof record['businessName'] === 'string' ? record['businessName'] : '',
  }
}
