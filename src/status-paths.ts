/** Node-free constants and types shared by the Host and browser halves. */

import type { QoderRegion } from './qoder/region.ts'

/** The two Qoder product variants this plugin serves, by provider id. */
export type QoderVariantId = 'qoder' | 'qoder-global'

/** Plugin-owned status endpoint consumed by its browser half. */
export const QODER_STATUS_PATH = '/plugins/dsh-qoder-connect/status'

/**
 * Plugin-owned settings endpoint consumed by its browser half.
 *
 * GET answers the whole entry configuration as three layers (value/base/user) plus
 * the write key; POST applies one patch.
 */
export const QODER_SETTINGS_FACE_PATH = '/plugins/dsh-qoder-connect/settings'

/**
 * Plugin-owned probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback guard protects against a rebinding *page*, which is not the same as
 * authorizing an action. This route also requires the in-process key.
 */
export const QODER_PROBE_PATH = '/plugins/dsh-qoder-connect/probe'

/**
 * Plugin-owned PAT endpoint, one per variant.
 *
 * A POST here saves (validates and persists) a Personal Access Token, or clears
 * the stored one. A write, so it also requires the in-process key.
 */
export const QODER_AUTH_PATH = '/plugins/dsh-qoder-connect/auth'

/**
 * The international (Qoder Global) variant's own triple of routes.
 *
 * Separate constants rather than a computed suffix so both halves reference
 * literal strings: the bundles are built independently, and a shared expression is
 * one build-config drift away from asking a route the host never mounted.
 */
export const QODER_GLOBAL_STATUS_PATH = '/plugins/dsh-qoder-connect/global/status'
export const QODER_GLOBAL_PROBE_PATH = '/plugins/dsh-qoder-connect/global/probe'
export const QODER_GLOBAL_AUTH_PATH = '/plugins/dsh-qoder-connect/global/auth'

/**
 * One action the PAT route accepts.
 *
 * `save-pat` validates the pasted token against the variant's region and, only on
 * success, appends it to the saved list and makes it active; `activate` switches
 * entry; `remove` deletes one; `clear` removes every saved credential. There is no
 * device flow. All are writes — `activate` changes which account signs later
 * requests — so all require the in-process key.
 */
export type QoderAuthAction = 'save-pat' | 'activate' | 'remove' | 'clear'

/** Request body accepted by the PAT route. */
export interface QoderAuthRequest {
  action: QoderAuthAction
  /** The token to validate and store; required for `save-pat`. */
  pat?: string
  /** Optional display label for a saved entry; `save-pat` only. */
  label?: string
  /** Target saved entry; required for `activate` and `remove`. */
  id?: string
}

/** Where the credential in effect came from. */
export type QoderCredentialSource = 'card' | 'env' | 'cli'

/**
 * One saved PAT, redacted for the switch select: the id is a one-way hash prefix,
 * the label is display copy, the tail the last four characters.
 */
export interface QoderPatProfile {
  id: string
  /** Optional display label supplied when the token was saved. */
  label?: string
  /** Last four characters of the token. */
  patTail?: string
  /** When this token was saved, epoch milliseconds. */
  savedAtMs?: number
}

/**
 * Redacted summary of one variant's active PAT: never the token itself — source,
 * save time, and the last four characters only.
 */
export interface QoderPatSummary {
  /** Local id of the saved entry in effect; absent for the environment token. */
  id?: string
  /** Display label of the saved entry in effect, when it carries one. */
  label?: string
  source: QoderCredentialSource
  /** When the stored token was saved, epoch milliseconds; absent for env fallback. */
  savedAtMs?: number
  /** Last four characters of the token. */
  patTail?: string
}

/** One model's recorded probe observation, as the card displays it. */
export interface QoderWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface QoderWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[]
  /** Recorded observations. */
  results: readonly QoderWebProbeModel[]
}

/** Action requested from the probe control route. */
export interface QoderProbeAction {
  /**
   * `probe` spends credit on one model; `clear` drops recorded observations;
   * `refresh` re-reads the credential and re-fetches the catalog;
   * `set-maximum-context-window` persists the card's preference.
   *
   * All are writes, hence this route's in-process key and loopback guards.
   */
  action: 'probe' | 'clear' | 'refresh' | 'set-maximum-context-window' | 'clear-checkin-logs' | 'checkin' | 'set-models-enabled'
  /** Target model id; required for `probe`. */
  model?: string
  /** Requested value for `set-maximum-context-window` or `set-models-enabled`. */
  enabled?: boolean
  /** Target model ids for `set-models-enabled` (supports single, batch, or all). */
  models?: readonly string[]
}

/**
 * Where the models a card is currently showing came from.
 *
 * A stale list must be distinguishable from an offline one, and the card must be
 * able to say when the last attempt failed.
 */
export interface QoderWebCatalog {
  /**
   * Where the models on screen came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch,
   * restored after a restart or a failed fetch) → `fallback` (the roster
   * compiled into the plugin). The card distinguishes them because "stale" and
   * "offline with a saved list" are different situations for the user.
   */
  source: 'live' | 'saved' | 'fallback'
  /** When the live catalog last succeeded, epoch ms. */
  fetchedAt?: number
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string
}

/** One quota package and its remaining credit. */
export interface QoderWebCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
  /**
   * Package credit expiry, carried through in whatever form the upstream reported
   * (an ISO string, or an epoch-ms value normalized to one). Absent when the
   * upstream reported no expiry — never guessed into a date. The year-9999 "never"
   * sentinel is dropped at the transport.
   */
  packageEndTime?: string
  /**
   * The package's localized display titles, when the upstream named it. `packageName`
   * remains the single-language guess for renderers that ignore this map.
   */
  packageNameI18n?: { zh?: string | undefined; en?: string | undefined }
  /** The opaque upstream campaign code behind the same grant, when known. */
  packageCode?: string
}

/** Aggregated credit answer rendered by the plugin card. */
export interface QoderWebCredits {
  /**
   * Usage percentage across the account (0..100), taken from the Qoder quota
   * answer's `userQuota.percentage`. The card renders its headline from this.
   */
  total: number
  /** Summed per-package totals — the denominator of the dashboard's bar. */
  totalSize?: number
  accounts: readonly QoderWebCreditAccount[]
  /** The account's quota is uncapped; renderers test this flag first. */
  unlimited?: true
  /** When the current quota cycle ends, verbatim from the upstream. */
  cycleResetTime?: string
}

/**
 * One catalog model as the status document snapshots it.
 *
 * A plain-Qoder mirror of the transport's `QoderCatalogModel`: the browser half
 * renders reasoning, price factor, and context capacity from these fields alone.
 * Field names follow the Qoder catalog vocabulary so the halves cannot drift.
 */
export interface QoderCatalogModelSnapshot {
  id: string
  name: string
  /** Effective input budget in tokens. */
  contextWindow?: number
  /** The upstream's preferred window before a larger one is selected. */
  defaultContextWindow?: number
  /** Selectable window sizes the upstream declares, ascending. */
  supportedContextWindows?: readonly number[]
  /** Whether the model reasons at all. */
  isReasoning?: boolean
  /** Effort ids the model advertises (wire spellings). */
  reasoningEfforts?: readonly string[]
  /** The model's default effort id, when the upstream names one. */
  defaultReasoningEffort?: string
  /** Price multiplier vs the baseline (1 = base rate); absent means unknown. */
  priceFactor?: number
  /** Whether the model accepts image input. */
  supportsImages?: boolean
  /** Upstream provenance marker (`system` / `user`), when reported. */
  source?: string
}

/** The JSON document the plugin card renders. */
export type QoderWebStatus =
  | {
    status: 'signed-in'
    /** Which upstream region the stored token belongs to. */
    region?: QoderRegion
    /** Redacted summary of the PAT in effect. */
    pat?: QoderPatSummary
    /**
     * Every saved token for this variant, newest first, redacted.
     *
     * One entry means nothing to switch; two or more render the account select.
     * Variant-scoped: a token minted for one region is never offered to the other.
     */
    patProfiles?: readonly QoderPatProfile[]
    /** The saved entry in effect; absent when the token comes from the environment. */
    activePatId?: string
    credits?: QoderWebCredits
    creditsError?: string
    /** The models the plugin serves, as catalog snapshots. */
    models?: readonly QoderCatalogModelSnapshot[]
    /** Where those models came from, and whether the last fetch failed. */
    catalog?: QoderWebCatalog
    /** Reasoning-effort probe state, consent, and recorded observations. */
    probe?: QoderWebProbeSection
    /** Card preference selecting larger declared context windows. */
    useMaximumContextWindow?: boolean
    /** Disabled model IDs (blacklist) for this variant. */
    disabledModels?: readonly string[]
    /**
     * The last automatic job-token refresh the self-heal performed, epoch ms; absent
     * when none happened in this process. The card renders it as a visible notice,
     * so an otherwise invisible recovery is observable.
     */
    jobTokenRefreshedAt?: number
    /**
     * In-process key authorizing probe control writes. Handed to the card with
     * the status document (the card is same-origin and already had to pass the
     * loopback guard); it is never persisted and rotates per process.
     */
    probeKey?: string
    /**
     * Daily check-in status record for this variant.
     */
    checkIn?: {
      lastDate: string
      lastAt: number
      status: 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error'
      amount?: number | undefined
      message?: string | undefined
      /**
       * When the scheduler's timer is next due, epoch ms.
       *
       * A day already claimed goes deliberately quiet, so without this the card
       * cannot tell "scheduled and waiting" from "no timer at all".
       */
      nextRunAt?: number | undefined
      logs?: readonly {
        id: string
        date: string
        timestamp: number
        status: 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error'
        amount?: number | undefined
        campaignKey?: string | undefined
        message?: string | undefined
      }[] | undefined
    }
    /**
     * In-process key authorizing PAT writes, including clearing. Travels with
     * the document for the same reason `probeKey` does.
     */
    authKey?: string
    /**
     * Which peers the load-time check could not verify, when any. Declared on the
     * card so a check that stopped enforcing is never silent.
     */
    peerCheckSkipped?: string
  }
  | {
    /**
     * No usable token, and the card may save one.
     *
     * Its own arm because the PAT key below is exactly what a signed-out card
     * needs: one shared arm would let a card offer clear and save at once.
     */
    status: 'signed-out'
    /**
     * Why no credential is usable, when that is diagnosable rather than simply
     * "nobody signed in". The card renders it in place of the generic hint.
     */
    reason?: string
    /**
     * In-process key authorizing PAT writes; see the signed-in arm's
     * `probeKey` for why it travels with the document.
     */
    authKey?: string
    /** Why the load-time peer check did not run; see the signed-in arm. */
    peerCheckSkipped?: string
  }
  /**
   * The host half refused to load, and `message` is that refusal verbatim.
   *
   * The card renders this instead of its body: a degraded host registers only
   * the status route, so every other control it offered would answer 404.
   */
  | { status: 'error'; message: string; inactive?: true }
