import z from "@deepseek-ai/schemastery";
import "@earendil-works/pi-ai";
import { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { IncomingMessage, ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
//#region src/paths.d.ts
/**
 * The plugin's data directory — the one place every file the plugin owns lives:
 * `<profile>/.dsh-qoder-connect/state/` (PATs, catalogs, probe records,
 * heartbeat, machine-id seed), so a profile never collects loose files.
 *
 * Resolution order: `DSH_QODER_DATA_DIR` → host-reported profile → discovered
 * profile → Harness home. The host's report outranks discovery because it is the
 * running profile, not an inference.
 *
 * @module dsh-qoder-connect/paths
 */
/** The per-profile directory the plugin's data folder lives under. */
declare const QODER_DATA_DIR_NAME = ".dsh-qoder-connect";
/** Environment override for the whole data directory. */
declare const QODER_DATA_DIR_ENV = "DSH_QODER_DATA_DIR";
/**
 * The plugin's data directory: `<profile>/.dsh-qoder-connect`.
 *
 * Falls back to profile discovery, then to the Harness home, so the plugin
 * always has somewhere to write; `DSH_QODER_DATA_DIR` overrides either way.
 */
declare function qoderPluginDataDir(): string;
//#endregion
//#region src/qoder/region.d.ts
/** Qoder upstream deployment selected for one immutable transport instance. */
type QoderRegion = 'global' | 'china';
//#endregion
//#region src/status-paths.d.ts
/** The two Qoder product variants this plugin serves, by provider id. */
type QoderVariantId = 'qoder' | 'qoder-global';
/** Plugin-owned status endpoint consumed by its browser half. */
declare const QODER_STATUS_PATH = "/plugins/dsh-qoder-connect/status";
/**
 * Plugin-owned probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback guard protects against a rebinding *page*, which is not the same as
 * authorizing an action. This route also requires the in-process key.
 */
declare const QODER_PROBE_PATH = "/plugins/dsh-qoder-connect/probe";
/**
 * Plugin-owned PAT endpoint, one per variant.
 *
 * A POST here saves (validates and persists) a Personal Access Token, or clears
 * the stored one. A write, so it also requires the in-process key.
 */
declare const QODER_AUTH_PATH = "/plugins/dsh-qoder-connect/auth";
/**
 * The international (Qoder Global) variant's own triple of routes.
 *
 * Separate constants rather than a computed suffix so both halves reference
 * literal strings: the bundles are built independently, and a shared expression is
 * one build-config drift away from asking a route the host never mounted.
 */
declare const QODER_GLOBAL_STATUS_PATH = "/plugins/dsh-qoder-connect/global/status";
declare const QODER_GLOBAL_PROBE_PATH = "/plugins/dsh-qoder-connect/global/probe";
declare const QODER_GLOBAL_AUTH_PATH = "/plugins/dsh-qoder-connect/global/auth";
/**
 * One action the PAT route accepts.
 *
 * `save-pat` validates the pasted token against the variant's region and, only on
 * success, appends it to the saved list and makes it active; `activate` switches
 * entry; `remove` deletes one; `clear` removes every saved credential. There is no
 * device flow. All are writes — `activate` changes which account signs later
 * requests — so all require the in-process key.
 */
type QoderAuthAction = 'save-pat' | 'activate' | 'remove' | 'clear';
/** Request body accepted by the PAT route. */
interface QoderAuthRequest {
  action: QoderAuthAction;
  /** The token to validate and store; required for `save-pat`. */
  pat?: string;
  /** Optional display label for a saved entry; `save-pat` only. */
  label?: string;
  /** Target saved entry; required for `activate` and `remove`. */
  id?: string;
}
/** Where the credential in effect came from. */
type QoderCredentialSource = 'card' | 'env' | 'cli';
/**
 * One saved PAT, redacted for the switch select: the id is a one-way hash prefix,
 * the label is display copy, the tail the last four characters.
 */
interface QoderPatProfile {
  id: string;
  /** Optional display label supplied when the token was saved. */
  label?: string;
  /** Last four characters of the token. */
  patTail?: string;
  /** When this token was saved, epoch milliseconds. */
  savedAtMs?: number;
}
/**
 * Redacted summary of one variant's active PAT: never the token itself — source,
 * save time, and the last four characters only.
 */
interface QoderPatSummary {
  /** Local id of the saved entry in effect; absent for the environment token. */
  id?: string;
  /** Display label of the saved entry in effect, when it carries one. */
  label?: string;
  source: QoderCredentialSource;
  /** When the stored token was saved, epoch milliseconds; absent for env fallback. */
  savedAtMs?: number;
  /** Last four characters of the token. */
  patTail?: string;
}
/** One model's recorded probe observation, as the card displays it. */
interface QoderWebProbeModel {
  id: string;
  name: string;
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown';
  efforts: readonly string[];
  probedAt: number;
}
/** Probe section of the status document. */
interface QoderWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean;
  /** Whether a sweep is in flight right now. */
  running: boolean;
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[];
  /** Recorded observations. */
  results: readonly QoderWebProbeModel[];
}
/** Action requested from the probe control route. */
interface QoderProbeAction {
  /**
   * `probe` spends credit on one model; `clear` drops recorded observations;
   * `refresh` re-reads the credential and re-fetches the catalog;
   * `set-maximum-context-window` persists the card's preference.
   *
   * All are writes, hence this route's in-process key and loopback guards.
   */
  action: 'probe' | 'clear' | 'refresh' | 'set-maximum-context-window' | 'clear-checkin-logs' | 'checkin' | 'set-models-enabled';
  /** Target model id; required for `probe`. */
  model?: string;
  /** Requested value for `set-maximum-context-window` or `set-models-enabled`. */
  enabled?: boolean;
  /** Target model ids for `set-models-enabled` (supports single, batch, or all). */
  models?: readonly string[];
}
/**
 * Where the models a card is currently showing came from.
 *
 * A stale list must be distinguishable from an offline one, and the card must be
 * able to say when the last attempt failed.
 */
interface QoderWebCatalog {
  /**
   * Where the models on screen came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch,
   * restored after a restart or a failed fetch) → `fallback` (the roster
   * compiled into the plugin). The card distinguishes them because "stale" and
   * "offline with a saved list" are different situations for the user.
   */
  source: 'live' | 'saved' | 'fallback';
  /** When the live catalog last succeeded, epoch ms. */
  fetchedAt?: number;
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string;
}
/** One quota package and its remaining credit. */
interface QoderWebCreditAccount {
  packageName: string;
  remain: number;
  size: number;
  unlimited?: true;
  /**
   * Package credit expiry, carried through in whatever form the upstream reported
   * (an ISO string, or an epoch-ms value normalized to one). Absent when the
   * upstream reported no expiry — never guessed into a date. The year-9999 "never"
   * sentinel is dropped at the transport.
   */
  packageEndTime?: string;
  /**
   * The package's localized display titles, when the upstream named it. `packageName`
   * remains the single-language guess for renderers that ignore this map.
   */
  packageNameI18n?: {
    zh?: string | undefined;
    en?: string | undefined;
  };
  /** The opaque upstream campaign code behind the same grant, when known. */
  packageCode?: string;
}
/** Aggregated credit answer rendered by the plugin card. */
interface QoderWebCredits {
  /**
   * Usage percentage across the account (0..100), taken from the Qoder quota
   * answer's `userQuota.percentage`. The card renders its headline from this.
   */
  total: number;
  /** Summed per-package totals — the denominator of the dashboard's bar. */
  totalSize?: number;
  accounts: readonly QoderWebCreditAccount[];
  /** The account's quota is uncapped; renderers test this flag first. */
  unlimited?: true;
  /** When the current quota cycle ends, verbatim from the upstream. */
  cycleResetTime?: string;
}
/**
 * One catalog model as the status document snapshots it.
 *
 * A plain-Qoder mirror of the transport's `QoderCatalogModel`: the browser half
 * renders reasoning, price factor, and context capacity from these fields alone.
 * Field names follow the Qoder catalog vocabulary so the halves cannot drift.
 */
interface QoderCatalogModelSnapshot {
  id: string;
  name: string;
  /** Effective input budget in tokens. */
  contextWindow?: number;
  /** The upstream's preferred window before a larger one is selected. */
  defaultContextWindow?: number;
  /** Selectable window sizes the upstream declares, ascending. */
  supportedContextWindows?: readonly number[];
  /** Whether the model reasons at all. */
  isReasoning?: boolean;
  /** Effort ids the model advertises (wire spellings). */
  reasoningEfforts?: readonly string[];
  /** The model's default effort id, when the upstream names one. */
  defaultReasoningEffort?: string;
  /** Price multiplier vs the baseline (1 = base rate); absent means unknown. */
  priceFactor?: number;
  /** Whether the model accepts image input. */
  supportsImages?: boolean;
  /** Upstream provenance marker (`system` / `user`), when reported. */
  source?: string;
}
/** The JSON document the plugin card renders. */
type QoderWebStatus = {
  status: 'signed-in';
  /** Which upstream region the stored token belongs to. */
  region?: QoderRegion;
  /** Redacted summary of the PAT in effect. */
  pat?: QoderPatSummary;
  /**
   * Every saved token for this variant, newest first, redacted.
   *
   * One entry means nothing to switch; two or more render the account select.
   * Variant-scoped: a token minted for one region is never offered to the other.
   */
  patProfiles?: readonly QoderPatProfile[];
  /** The saved entry in effect; absent when the token comes from the environment. */
  activePatId?: string;
  credits?: QoderWebCredits;
  creditsError?: string;
  /** The models the plugin serves, as catalog snapshots. */
  models?: readonly QoderCatalogModelSnapshot[];
  /** Where those models came from, and whether the last fetch failed. */
  catalog?: QoderWebCatalog;
  /** Reasoning-effort probe state, consent, and recorded observations. */
  probe?: QoderWebProbeSection;
  /** Card preference selecting larger declared context windows. */
  useMaximumContextWindow?: boolean;
  /** Disabled model IDs (blacklist) for this variant. */
  disabledModels?: readonly string[];
  /**
   * The last automatic job-token refresh the self-heal performed, epoch ms; absent
   * when none happened in this process. The card renders it as a visible notice,
   * so an otherwise invisible recovery is observable.
   */
  jobTokenRefreshedAt?: number;
  /**
   * In-process key authorizing probe control writes. Handed to the card with
   * the status document (the card is same-origin and already had to pass the
   * loopback guard); it is never persisted and rotates per process.
   */
  probeKey?: string;
  /**
   * Daily check-in status record for this variant.
   */
  checkIn?: {
    lastDate: string;
    lastAt: number;
    status: 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error';
    amount?: number | undefined;
    message?: string | undefined;
    /**
     * When the scheduler's timer is next due, epoch ms.
     *
     * A day already claimed goes deliberately quiet, so without this the card
     * cannot tell "scheduled and waiting" from "no timer at all".
     */
    nextRunAt?: number | undefined;
    logs?: readonly {
      id: string;
      date: string;
      timestamp: number;
      status: 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error';
      amount?: number | undefined;
      campaignKey?: string | undefined;
      message?: string | undefined;
    }[] | undefined;
  };
  /**
   * In-process key authorizing PAT writes, including clearing. Travels with
   * the document for the same reason `probeKey` does.
   */
  authKey?: string;
  /**
   * Which peers the load-time check could not verify, when any. Declared on the
   * card so a check that stopped enforcing is never silent.
   */
  peerCheckSkipped?: string;
} | {
  /**
   * No usable token, and the card may save one.
   *
   * Its own arm because the PAT key below is exactly what a signed-out card
   * needs: one shared arm would let a card offer clear and save at once.
   */
  status: 'signed-out';
  /**
   * Why no credential is usable, when that is diagnosable rather than simply
   * "nobody signed in". The card renders it in place of the generic hint.
   */
  reason?: string;
  /**
   * In-process key authorizing PAT writes; see the signed-in arm's
   * `probeKey` for why it travels with the document.
   */
  authKey?: string;
  /** Why the load-time peer check did not run; see the signed-in arm. */
  peerCheckSkipped?: string;
} |
/**
 * The host half refused to load, and `message` is that refusal verbatim.
 *
 * The card renders this instead of its body: a degraded host registers only
 * the status route, so every other control it offered would answer 404.
 */
{
  status: 'error';
  message: string;
  inactive?: true;
};
//#endregion
//#region src/variants.d.ts
/** One Qoder product variant. */
interface QoderVariant {
  /** Provider id registered with DSH, e.g. `qoder-global`. */
  id: QoderVariantId;
  /** Model-group heading and card title stem, e.g. `Qoder Global`. */
  displayName: string;
  /** Product name as users know it, for diagnostics and error copy. */
  appName: string;
  /** Which upstream region this variant's transport talks to. */
  region: QoderRegion;
  /** Basename of the plugin-owned credential file under the data dir. */
  ownFilename: string;
  /** Basename of the plugin-owned probe-record file under the data dir. */
  probeFilename: string;
  /**
   * Basename of the plugin-owned saved-catalog file under the data dir.
   * One per variant: the deployments disagree about rates, windows, and models,
   * so a catalog saved from one must never be served as the other's.
   */
  catalogFilename: string;
  /** Same-origin status route consumed by this variant's card. */
  statusPath: string;
  /** Same-origin probe-control route consumed by this variant's card. */
  probePath: string;
  /** Same-origin PAT route consumed by this variant's card. */
  authPath: string;
}
/** China Qoder first: the no-suffix arm keeps the plugin's primary routes. */
declare const QODER_VARIANTS: readonly QoderVariant[];
/** The China variant; the plugin's default and compatibility anchor. */
declare const CHINA_VARIANT: QoderVariant;
/** The international variant. */
declare const GLOBAL_VARIANT: QoderVariant;
/** Look up a variant by provider id. */
declare function variantFor(id: string): QoderVariant | undefined;
//#endregion
//#region src/auth.d.ts
/** Environment fallback for the global arm when no file exists. */
declare const QODER_PAT_ENV_GLOBAL = "QODER_PERSONAL_ACCESS_TOKEN";
/** Environment fallback for the China arm when no file exists. */
declare const QODER_PAT_ENV_CN = "QODER_CN_PERSONAL_ACCESS_TOKEN";
/** Basename of the China variant's credential file inside the data directory. */
declare const QODER_AUTH_FILENAME = ".qoder-auth.json";
/** Minimal logger surface the plugin context already provides. */
interface AuthLogger {
  warn?(...args: unknown[]): void;
}
/** One saved credential, as the file stores it. */
interface QoderCredentialEntry {
  /** Stable local id (a one-way hash prefix of the token). */
  id: string;
  pat: string;
  region: QoderRegion;
  /** When the stored token was saved, epoch milliseconds. */
  savedAtMs?: number;
  /** Optional display label; never sent upstream. */
  label?: string;
}
/** Runtime credential, timestamps in epoch milliseconds. */
interface QoderCredential {
  /** Local id of the saved entry; absent for an environment token. */
  id?: string;
  pat: string;
  region: QoderRegion;
  /** When the stored token was saved; absent for environment-sourced tokens. */
  savedAtMs?: number;
  /** Display label, when the saved entry carries one. */
  label?: string;
  source: QoderCredentialSource;
}
/** Read-only sign-in summary for status, the PAT route, and doctor output. */
interface QoderAuthStatus {
  state: 'configured' | 'missing';
  /** Redacted summary of the token in effect, when there is one. */
  pat?: QoderPatSummary;
  /** Which upstream region the token is used against. */
  region?: QoderRegion;
  /** Why no credential is usable, when diagnosable (a stale legacy file). */
  reason?: string;
  /** Absolute path of the credential file this store owns. */
  filePath: string;
  /** Every saved token for this variant, newest first, redacted. */
  profiles?: readonly QoderPatProfile[];
  /** The entry id in effect, when a saved entry is active. */
  activeId?: string;
}
/** Constructor options. */
interface QoderStoreOptions {
  variant: QoderVariant;
  /** Explicit plugin-owned credential path, defaulting under the data dir. */
  ownPath?: string;
  /** Logger for the legacy-file warning; optional so tests stay quiet. */
  logger?: AuthLogger;
}
/** Last four characters of a token, for display. */
declare function patTail(pat: string): string | undefined;
/**
 * Stable local id for one token.
 *
 * A one-way hash prefix rather than a suffix: surfaces showing the id leak nothing
 * usable, while two saves of the same token still resolve to the same entry.
 */
declare function qoderCredentialId(pat: string): string;
/**
 * Stable identity key for a credential, used by probe records and saved catalogs.
 *
 * Wider than the local id: these keys address stored data, not UI, and 16 hex
 * characters keep two tokens from sharing a bucket.
 */
declare function qoderCredentialIdentity(credential: Pick<QoderCredential, 'pat'>): string;
declare class QoderCredentialStore {
  private readonly variant;
  private readonly ownPath;
  private readonly logger;
  /** The legacy-file warning is emitted once per process, not per read. */
  private legacyWarned;
  constructor(options: QoderStoreOptions);
  /** Absolute path of this variant's credential file, for display and tests. */
  ownAuthPath(): string;
  /**
   * The credential currently in effect, or `undefined` when there is none.
   *
   * Resolution order: the active saved entry (or the first when the pointer is
   * stale), then the arm's environment variable (only when no saved entry
   * exists). No refresh and no expiry check.
   */
  current(): Promise<QoderCredential | undefined>;
  /**
   * The credential, or a thrown `MISSING_CREDENTIAL` error.
   *
   * Serving callers use this so an absent token surfaces as the classified failure
   * the transport itself raises.
   */
  resolve(): Promise<QoderCredential>;
  /** The token in effect as a bare string, rejecting when there is none. */
  patPromise(): Promise<string>;
  /** Every saved entry (tokens included; host-side callers only). */
  entries(): Promise<readonly QoderCredentialEntry[]>;
  /**
   * Add a token and make it active.
   *
   * Re-saving an existing token updates that entry instead of appending a
   * duplicate — the id is derived from the token. The caller must have validated
   * the token against the region first.
   *
   * @param pat - the token to store.
   * @param label - optional display label for the select row.
   * @returns the stored entry.
   */
  add(pat: string, label?: string): Promise<QoderCredentialEntry>;
  /**
   * Make one saved entry active.
   *
   * @param id - the entry id.
   * @returns the activated entry, or `undefined` when no entry has that id.
   */
  activate(id: string): Promise<QoderCredentialEntry | undefined>;
  /**
   * Remove one saved entry.
   *
   * The active pointer moves to the first remaining entry; removing the last entry
   * deletes the file, exactly like {@link clear}.
   *
   * @param id - the entry id.
   * @returns the removed entry, or `undefined` when no entry has that id.
   */
  remove(id: string): Promise<QoderCredentialEntry | undefined>;
  /**
   * Persist a token for this variant and make it active; {@link add} behind the
   * runtime-credential shape older call sites expect.
   */
  save(pat: string, source?: QoderCredentialSource): Promise<QoderCredential>;
  /** Remove every stored credential. A missing file is not an error. */
  clear(): Promise<void>;
  /** Alias kept for call-site readability (`logout` is just clearing). */
  logout(): Promise<void>;
  /** Redacted summary for the card, the PAT route, and doctor output. */
  status(): Promise<QoderAuthStatus>;
  /** Set when a read found a stale WorkBuddy-era file; consumed once. */
  private pendingLegacyReason;
  private fromEnvironment;
  private readOwn;
  private writeDocument;
}
/**
 * The plugin-owned credential path for one variant's default filename.
 * Kept as a free function for the CLI, which builds no store per display line.
 */
declare function qoderOwnAuthPath(variant: QoderVariant): string;
//#endregion
//#region src/catalog.d.ts
/**
 * Qoder model catalog: a static fallback roster, replaced by the upstream's
 * dynamic answer once it loads. These row types are the plugin's own model
 * vocabulary; `upstream.ts` translates them to and from the transport's.
 *
 * @module dsh-qoder-connect/catalog
 */
/** One model entry the adapter exposes. */
interface QoderModelInfo {
  id: string;
  name: string;
  /** Effective input budget in tokens. */
  contextWindow: number;
  /** The upstream's preferred window before a larger one is selected. */
  defaultContextWindow?: number;
  /** Selectable window sizes the upstream declares, ascending. */
  supportedContextWindows?: readonly number[];
  /** Output cap the provider declared; absent when it declares none. */
  maxTokens?: number;
  /** True only when the provider declared that cap, rather than this plugin's reserve. */
  maxTokensDeclared?: boolean;
  /** Whether the model accepts image input. */
  supportsImages: boolean;
  /** Reasoning metadata; absent means the upstream declared none. */
  reasoning?: QoderModelReasoning;
  billing: QoderModelBilling;
  /** Upstream provenance marker (`system` / `user`), when reported. */
  source?: string;
}
/** What the upstream declares about one model's reasoning. */
interface QoderModelReasoning {
  supports: boolean;
  /** Effort ids the model advertises, in canonical order. */
  supportedEfforts?: readonly string[];
  /** The model's default effort id, when the upstream names one. */
  defaultEffort?: string;
  /** Whether thinking can be switched off; Qoder's catalog never says so. */
  canDisableThinking: boolean;
}
/** The price the catalog reports for one model. */
interface QoderModelBilling {
  /** Rate label, spelled `x<n>` (a multiplier on the base rate). */
  credits?: string;
  /** Whether the model is free; the `x0` marker and nothing else sets this. */
  free: boolean;
  /** The upstream disclosed no rate; the card shows "rate unknown". */
  rateUnknown?: boolean;
}
/**
 * The built-in roster, mirrored from the transport's own `defaultModels`: the
 * model keys both regions start from before the first discovery.
 *
 * It lets the provider register while the first fetch is in flight or the
 * endpoint is unreachable; the discovery answer replaces it at startup. Reasoning
 * and rate metadata are absent because the defaults declare none.
 */
declare const FALLBACK_QODER_MODELS: readonly QoderModelInfo[];
/**
 * Mutable catalog shared by the shim's `/v1/models` and the adapter.
 *
 * Visibility is separate from content: a variant with no usable credential must
 * expose no models rather than a fallback roster, since the model picker drops an
 * empty group — and serving models that can only fail is worse than nothing.
 * The flag defaults to visible; the plugin runtime applies the credential gate.
 */
declare class QoderCatalog {
  private models;
  private visible;
  private useMaximumContextWindow;
  /** Per-model window overrides (model id → tokens); an override wins over the preference. */
  private modelContextWindows;
  /** Disabled model IDs (blacklist); disabled models are filtered out from current(). */
  private disabledModels;
  constructor(initial?: readonly QoderModelInfo[]);
  /** Current entries; empty while the variant has no usable credential, excluding disabled models. */
  current(): readonly QoderModelInfo[];
  /** All configured entries including disabled ones; empty while the variant has no usable credential. */
  all(): readonly QoderModelInfo[];
  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly QoderModelInfo[]): void;
  /** Whether this variant's models are exposed at all. */
  isVisible(): boolean;
  /**
   * Show or hide the whole catalog. Returns whether the value changed, so the
   * caller can skip an invalidation that would re-render an identical list.
   */
  setVisible(visible: boolean): boolean;
  /** Select the largest declared window where the upstream offers one. */
  setUseMaximumContextWindow(useMaximum: boolean): boolean;
  /**
   * Replace the per-model window overrides wholesale. Returns whether the map
   * changed, so the caller can skip an invalidation over an identical write.
   */
  setModelContextWindows(modelContextWindows: Readonly<Record<string, number>>): boolean;
  /**
   * Replace the disabled model IDs wholesale. Returns whether the set
   * changed, so the caller can skip an invalidation over an identical write.
   */
  setDisabledModels(disabledModels: readonly string[]): boolean;
  /** Current disabled model IDs. */
  getDisabledModels(): readonly string[];
  /**
   * Models to fall back to when the upstream fetch fails; ignores
   * visibility, because the caller asking for the fallback already knows the
   * credential state.
   */
  fallback(): readonly QoderModelInfo[];
}
//#endregion
//#region src/probe.d.ts
/**
 * The canonical values a probe tests, in a fixed order.
 *
 * `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
 * by policy — disabling thinking is a separate capability the upstream must
 * declare through `canDisableThinking`, never something probing may infer.
 */
declare const PROBE_EFFORT_CANDIDATES: readonly QoderEffort[];
/** Sentinel generator; injectable so tests get deterministic values. */
type SentinelFactory = () => string;
/** Default sentinel: unmistakably non-canonical, different on every call. */
declare function randomSentinel(): string;
/**
 * One response as the probe sees it, split into the only distinctions the
 * attribution rule needs.
 */
interface ProbeAttempt {
  /** HTTP status, or 0 for a transport failure. */
  status: number;
  /** True when a parseable SSE event arrived. */
  streamed: boolean;
  /** `extError.code` from a JSON error body, when present. */
  errorCode?: string;
  /** Free-form detail for logs; never shown as a capability claim. */
  detail?: string;
}
/** How one attempt is performed; the caller owns credentials and HTTP. */
type ProbeSender = (effort: string | undefined, signal: AbortSignal) => Promise<ProbeAttempt>;
/** The outcome of probing one model. */
type ProbeOutcome = {
  validation: 'validating';
  efforts: readonly QoderEffort[];
  requests: number;
} | {
  validation: 'non-validating';
  efforts: readonly [];
  requests: number;
} | {
  validation: 'unknown';
  efforts: readonly [];
  requests: number;
  reason: string;
};
/**
 * Probe one model.
 *
 * `options.candidates` exists so tests can shorten the sweep; production always
 * uses {@link PROBE_EFFORT_CANDIDATES}.
 */
declare function probeModel(options: {
  send: ProbeSender;
  sentinel?: SentinelFactory;
  candidates?: readonly QoderEffort[];
  timeoutMs?: number;
}): Promise<ProbeOutcome>;
//#endregion
//#region src/qoder/catalog.d.ts
/** Browser-safe Qoder model catalog types and built-in fallback entries. */
interface QoderCatalogModel {
  id: string;
  name: string;
  description?: string;
  /** Effective DSH input budget, which may be smaller than the provider default tier. */
  contextWindow?: number;
  /** Largest known capacity, independent of the effective input budget. */
  maxContextWindow?: number;
  /** Output budget hint for the harness; may be the built-in reserve, not a provider limit. */
  maxTokens?: number;
  /** True only when the provider declared `max_output_tokens`. */
  maxTokensDeclared?: boolean;
  source?: string;
  isReasoning?: boolean;
  supportsEffort?: boolean;
  reasoningEfforts?: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  defaultReasoningEffort?: string;
  priceFactor?: number;
  contextOptions?: Record<string, {
    tokenCount?: number;
    isDefault?: boolean;
  }>;
  supportsImages?: boolean;
}
//#endregion
//#region src/qoder/account.d.ts
/** Browser-safe Qoder subscriber account and quota types. */
interface QoderSubscriberProfile {
  id: string;
  name: string;
  email: string;
}
interface QoderQuota {
  total: number;
  used: number;
  remaining: number;
  percentage: number;
  unit: string;
}
/**
 * A named grant of credits that expires on its own schedule, reported in the
 * international upstream's `dedicatedResourcePackages`.
 */
interface QoderDedicatedResourcePackage extends QoderQuota {
  /** Upstream package id (`01a1426f-…`), when reported. */
  id?: string | undefined;
  /** Raw upstream name — usually an opaque campaign code, not display copy. */
  name?: string | undefined;
  /** Localized display title from `displayLabels`, when the upstream sends one. */
  title?: {
    zh?: string | undefined;
    en?: string | undefined;
  } | undefined;
  /** This package's own expiry, ISO; not the account's cycle-level date. */
  expiresAt?: string | undefined;
  /** Whether the upstream says the package is currently usable. */
  available?: boolean | undefined;
  /** Upstream lifecycle marker (`QUOTA_DETAIL_STATUS_ACTIVE`). */
  status?: string | undefined;
}
interface QoderQuotaUsage {
  userQuota?: QoderQuota | undefined;
  orgResourcePackage?: QoderQuota | undefined;
  /** Credits granted on top of the plan, with their own total and remaining. */
  addOnQuota?: QoderQuota | undefined;
  /** Campaign grants carrying their own expiry and display title. */
  dedicatedResourcePackages?: readonly QoderDedicatedResourcePackage[] | undefined;
  totalUsagePercentage?: number | undefined;
  isQuotaExceeded?: boolean | undefined;
  expiresAt?: string | undefined;
  raw?: unknown;
}
interface QoderSubscriberOrganization {
  orgId: string;
  orgName: string;
  roleName?: string | undefined;
  isSuspended?: boolean;
  canManageSubscriptions?: boolean;
  resourcePackageFeatureEnabled?: boolean;
}
interface QoderSubscriberFeatureAllowed {
  quest?: boolean;
  wiki?: boolean;
  codeReview?: boolean;
}
interface QoderSubscriberPlan {
  userType: string;
  planTierName: string;
  planTier?: string;
  isPersonalVersion: boolean;
  isHighestTier?: boolean;
  isRenewed?: boolean;
  startDate?: string;
  endDate?: string;
  organization?: QoderSubscriberOrganization;
  featureAllowed?: QoderSubscriberFeatureAllowed;
  raw?: unknown;
}
interface QoderSubscriberStatus {
  allowByok: number;
  teamAllowByok?: number;
  isPrivacyPolicyModifiable?: boolean;
  raw?: unknown;
}
interface QoderAccountInfo {
  profile: QoderSubscriberProfile;
  usage?: QoderQuotaUsage;
  plan?: QoderSubscriberPlan;
  status?: QoderSubscriberStatus;
  updatedAt: string;
}
//#endregion
//#region src/qoder/transport/checkin.d.ts
interface QoderCheckInResult {
  variantId: string;
  date: string;
  timestamp: number;
  status: 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error';
  amount?: number | undefined;
  campaignKey?: string | undefined;
  message?: string | undefined;
}
//#endregion
//#region src/qoder/transport/index.d.ts
interface QoderTransport {
  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk>;
  discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]>;
  readAccount(options?: {
    force?: boolean | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<QoderAccountInfo>;
  checkIn(signal?: AbortSignal): Promise<QoderCheckInResult>;
}
//#endregion
//#region src/upstream.d.ts
/**
 * The reasoning-effort vocabulary the probe sweeps and the effort map speak.
 * `minimal` and `off` are deliberately absent: `off` is a separate capability the
 * upstream must declare, never something probing may infer.
 */
type QoderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** How the shim should present an upstream failure to its OpenAI client. */
type UpstreamErrorKind = 'missing_credential' | 'auth' | 'soft_rate' | 'quota_exceeded' | 'timeout' | 'server' | 'client';
/**
 * HTTP status the shim answers each failure kind with.
 *
 * `timeout` is 408, deliberately not 504: the harness's pi-ai classifier tests
 * `/\b5\d\d\b/` before its `timeout` test, so a 5xx would read as SERVER.
 */
declare const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>>;
/** The chat-completions answer: a streaming `Response`, or a classified failure. */
type QoderChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: UpstreamErrorKind;
  message: string;
  /**
   * The upstream's own "try again in N ms" answer (Qoder's queue body carries
   * `retryAfterSeconds`, and a plain 429 may carry `Retry-After`).
   *
   * It must survive this layer: the shim turns it into the `Retry-After` header
   * and the `[retry-after=<n>s]` tag, which the adapter reads back into
   * `failure.providerRetryAfterMs` — the only field the harness retry policy
   * honors. Dropped here, the host can only fall back to its own backoff.
   */
  retryAfterMs?: number;
};
/** Provenance of the last successful catalog fetch. */
interface QoderCatalogFetch {
  fetchedAtMs: number;
  source: string;
}
/** One quota package and its remaining credit, as the card renders it. */
interface QoderCreditAccount {
  packageName: string;
  remain: number;
  size: number;
  unlimited?: true;
  /**
   * Expiry of this package, verbatim from the upstream (ISO string).
   *
   * Absent when the upstream reported no expiry — including the year-9999 "never"
   * sentinel, which the transport drops rather than forwarding.
   */
  packageEndTime?: string;
  /**
   * The package's own localized titles, when the upstream sent a real display name.
   * The renderer picks the active language; `packageName` stays the single-language
   * fallback.
   */
  packageNameI18n?: {
    zh?: string | undefined;
    en?: string | undefined;
  };
  /** Opaque upstream code for the same grant (`act-<date>-<n>`), when known. */
  packageCode?: string;
}
/** The aggregated credit answer the card renders. */
interface QoderCredits {
  /** Usage percentage of the personal quota (0..100). */
  total: number;
  /** Summed per-package totals — the denominator of the dashboard's bar. */
  totalSize?: number;
  accounts: readonly QoderCreditAccount[];
  /** The account's quota is uncapped; renderers test this flag first. */
  unlimited?: true;
  /** When the current quota cycle ends, verbatim from the upstream. */
  cycleResetTime?: string;
}
/**
 * Normalize a billing rate label for display.
 *
 * Qoder reports a `priceFactor` number; the host spells it `x<n>`. The card wants
 * one shape: a trimmed multiplier without the trailing "credits".
 */
declare function normalizeCredits(credits: string | undefined): string | undefined;
/**
 * Classify a raw HTTP upstream failure from status and a body excerpt.
 *
 * A documented result code outranks the status: Qoder answers a saturated queue
 * or a spent daily window with 401/403, and reading either as a dead credential
 * would park a healthy account. Status comes next, then body phrases.
 */
declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/**
 * Map one structured transport failure onto the shim's error kind.
 *
 * Code families are tested before the status arm because the upstream keeps its
 * 401/403 for throttles, spent windows, and refused requests alike: letting the
 * status claim them would report a dead credential the host never retries.
 * `status === 402` is tested before the request arm because the transport codes a
 * 402 as `INVALID_REQUEST`.
 */
declare function kindFromQoderFailure(failure: {
  code: string;
  status?: number | undefined;
}): UpstreamErrorKind;
/** Constructor options for {@link QoderUpstreamClient}. */
interface QoderUpstreamClientOptions {
  /** Which upstream region this client's transport talks to. */
  region: QoderRegion;
  /** Provider id stamped into translated requests. */
  providerId: string;
  /** Resolves the current Personal Access Token (rejects when none). */
  getPat: () => Promise<string>;
  /** The transport this client drives. */
  transport: QoderTransport;
  /**
   * The attachment service's image commit path. Without it, any request
   * carrying image parts fails as a client error — the Qoder wire only ever
   * transports durable references.
   */
  attachments?: Pick<AttachmentStore, 'saveImage'> | undefined;
  /**
   * Extra catalog lookup used when a requested model is not one this client
   * fetched itself. The transport validates effort and image support against
   * the model row, so a stream must carry it whenever one is known.
   */
  catalogProvider?: ((id: string) => QoderCatalogModel | undefined) | undefined;
}
declare class QoderUpstreamClient {
  private readonly region;
  private readonly providerId;
  private readonly getPat;
  private readonly transport;
  private readonly attachments;
  private readonly externalCatalog;
  /** The raw discovery rows of the last successful `fetchModels`, by id. */
  private readonly discovered;
  /** Provenance of the last successful catalog fetch, for the status card. */
  lastCatalog: QoderCatalogFetch | undefined;
  constructor(options: QoderUpstreamClientOptions);
  /** The region this client's transport serves. */
  get clientRegion(): QoderRegion;
  /**
   * The catalog row for one model id: this client's own discovery answers first,
   * and an externally supplied provider fills ids the discovery never listed.
   */
  catalogModelFor(id: string): QoderCatalogModel | undefined;
  /**
   * Discover this variant's models and translate them into plugin rows.
   *
   * The raw rows stay addressable via {@link catalogModelFor}: a chat request must
   * hand the transport its row, because effort support, image capability, and the
   * output cap are validated against it.
   */
  fetchModels(signal?: AbortSignal): Promise<QoderModelInfo[]>;
  /**
   * The subscriber's quota answer, mapped onto the card's credit shape.
   *
   * One personal quota, an optional organization package, bonus credits, and — on
   * the international edition — campaign grants, each becoming a package row. An
   * unbounded personal allowance (`total === 0`, not exceeded) is the "unlimited"
   * state. A campaign grant carries its own expiry and localized title, never
   * borrowed from the account.
   */
  fetchCredits(signal?: AbortSignal): Promise<QoderCredits>;
  /**
   * Run daily benefit check-in for this client's variant.
   */
  checkIn(signal?: AbortSignal): Promise<QoderCheckInResult>;
  /**
   * Stream one translated chat-completions request.
   *
   * The first transport chunk is pulled before the response is constructed:
   * everything rejectable without the network — a missing credential, an
   * unadvertised effort, an image on a text-only model — must still answer as a
   * real HTTP status, not a 200 whose first frame is an error. Once streaming has
   * begun, failures degrade to the error-frame-then-`[DONE]` form.
   */
  chatStream(bodyJson: string, signal?: AbortSignal, sessionId?: string, purpose?: GenerateOptions['purpose']): Promise<QoderChatResult>;
  /** Drive the SSE body from an already-started chunk iterator. */
  private bodyStream;
  /**
   * One minimal reasoning-effort request, as the probe sweep needs it.
   *
   * A row that declares efforts is checked locally, so an unlisted value costs no
   * request; a row that declares none sends the value to the upstream, the only
   * authority on spellings the catalog never lists. Either refusal is an
   * attributable 400 with code `UNSUPPORTED_REASONING_EFFORT`, and the stream is
   * ended after the first chunk arrives.
   */
  probeEffort(model: string, effort: string | undefined, signal: AbortSignal): Promise<ProbeAttempt>;
}
/**
 * Translate one Qoder catalog row into the plugin's model-info shape.
 *
 * The billing section reports the price factor only, spelled `x<n>`, and says so
 * honestly when the upstream reported nothing (`rateUnknown`). Context capacity
 * comes from the effective window, with the declared options kept for the card; a
 * row with no capacity takes the transport's default.
 */
declare function modelInfoOf(model: QoderCatalogModel): QoderModelInfo;
//#endregion
//#region src/probe-store.d.ts
/** Basename of the China variant's probe record inside the plugin's state dir. */
declare const QODER_PROBE_FILENAME = ".qoder-probe.json";
/**
 * Whether the model's effort parameter is actually validated.
 *
 * - `validating`: the upstream rejected an unknown sentinel value, so a
 *   per-level answer is meaningful.
 * - `non-validating`: the upstream accepted the sentinel, so it ignores or
 *   loosely coerces the parameter and no per-level answer can be trusted.
 * - `unknown`: baseline or sentinel failed for an unrelated reason (auth,
 *   rate limit, transport, ambiguous error body). Not a negative claim.
 */
type QoderProbeValidation = 'validating' | 'non-validating' | 'unknown';
/** One model's recorded observation. */
interface QoderProbeRecord {
  /** Fingerprint of the catalog row this observation was made against. */
  fingerprint: string;
  validation: QoderProbeValidation;
  /** Efforts verified as accepted; only ever non-empty for `validating`. */
  efforts: readonly QoderEffort[];
  /** When the probe ran, epoch milliseconds. */
  probedAtMs: number;
  /** Plugin version that produced the record. */
  pluginVersion: string;
  /**
   * The account this observation was made under, as a one-way hash of the
   * credential in effect.
   *
   * An effort set is a fact about one account's entitlement as much as about the
   * model, so a record must not outlive its account. Records written before this
   * field existed carry no identity and are therefore never reused.
   */
  account?: string;
}
/**
 * Plugin-owned probe record path inside the plugin's state directory.
 *
 * One file per variant: the regions serve overlapping ids with different
 * entitlements, and {@link fingerprintModel} never covers the provider, so a
 * shared file would let one variant's observation answer for the other.
 */
declare function qoderProbePath(filename?: string): string;
/**
 * Fingerprint the catalog fields a probe depends on.
 *
 * Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
 * so a rename or a rate relabel does not throw away a valid observation, and
 * deliberately includes the whole reasoning object so any change to the
 * declared shape re-probes.
 */
declare function fingerprintModel(info: QoderModelInfo): string;
/** Options for {@link QoderProbeStore}. */
interface QoderProbeStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string;
  /** Observation lifetime; defaults to 14 days. */
  ttlMs?: number;
  /** Plugin version stamped into new records. */
  pluginVersion: string;
  /** Clock injection for tests. */
  now?: () => number;
}
/**
 * The plugin's probe records: read once, written atomically, never trusted
 * across a fingerprint change or past the TTL.
 */
declare class QoderProbeStore {
  private readonly path;
  private readonly ttlMs;
  private readonly pluginVersion;
  private readonly now;
  private records;
  constructor(options: QoderProbeStoreOptions | string);
  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string;
  private load;
  /**
   * The usable record for a model, or `undefined` when there is none, it is
   * expired, it was taken against a different catalog row, or it belongs to a
   * different account.
   *
   * @param account - the account in effect, as `uid:enterpriseId`. Records are
   *   only returned for the account that produced them.
   */
  get(modelId: string, fingerprint: string, account: string): QoderProbeRecord | undefined;
  /**
   * Store one observation. Only a decisive answer (`validating` /
   * `non-validating`) replaces an existing decisive record: a transient
   * `unknown` must not erase knowledge the user already paid for.
   */
  set(modelId: string, record: QoderProbeRecord): void;
  /** Drop every record; used by the card's explicit "clear" action. */
  clear(): void;
  /**
   * Drop every record that belongs to one account, leaving other accounts'
   * observations intact.
   *
   * A saved token's detected effort levels are that account's data; a plain
   * {@link clear} would erase the observations of every account still saved.
   */
  clearFor(account: string): void;
  /** Every record currently held, for status display. */
  all(): Readonly<Record<string, QoderProbeRecord>>;
  /** Build a record stamped with this store's clock, version, and account. */
  record(fingerprint: string, validation: QoderProbeValidation, efforts: readonly QoderEffort[], account: string): QoderProbeRecord;
  /**
   * Write through a temporary file and rename, so a crash mid-write cannot
   * leave a half-parsed document that reads as "no records" and silently drops
   * every observation.
   */
  private persist;
}
//#endregion
//#region src/shim.d.ts
/** Minimal logger surface the plugin context already provides. */
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface QoderShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the shim resolves the
   * real credential itself via the store.
   */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface QoderShimOptions {
  store: QoderCredentialStore;
  client: Pick<QoderUpstreamClient, 'chatStream'>;
  catalog: QoderCatalog;
  /** Provider id reported as each model's `owned_by`; one per variant. */
  providerId: string;
  logger?: ShimLogger;
  /**
   * Override of the pending-answer keep-alive interval. Only tests shorten it;
   * production always keeps the default, which is what the client's body clock
   * leaves room for.
   */
  keepAliveMs?: number;
  /**
   * How long a failure may still arrive as its real HTTP status before the stream
   * head is committed. Only tests shorten it; see {@link STREAM_GRACE_MS}.
   */
  graceMs?: number;
  /**
   * One-line diagnostic sink. The queue log the user can hand back is the only
   * place that records when a head was committed or an answer abandoned, which is
   * what separates a client-side clock from an upstream stall.
   */
  onDiag?: (message: string) => void;
}
/**
 * Start the loopback endpoint. The upstream credential comes from the store alone;
 * the bearer checked is the per-process shared secret.
 */
declare function createQoderShim(options: QoderShimOptions): QoderShim;
//#endregion
//#region src/adapter.d.ts
/** Default provider route owned by this bundle (the China variant). */
declare const QODER_PROVIDER = "qoder";
/**
 * Provider idle ceiling while one stream read is outstanding.
 *
 * It has to cover a queue wait, which the settings bound (up to an hour, the
 * official client's own limit) plus room for the replay: a shorter ceiling
 * would abort exactly the wait the user asked for.
 */
declare const QODER_STREAM_IDLE_TIMEOUT_MS = 3660000;
/** Constructor dependencies. */
interface QoderAdapterOptions {
  providerId?: string;
  displayName?: string;
  shim: QoderShim;
  store: QoderCredentialStore;
  catalog: QoderCatalog;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
  /**
   * Look up a local probe observation for a model. Consulted only for rows the
   * upstream left undeclared; absent means declared-set-only behavior.
   */
  observe?: (modelId: string) => QoderProbeRecord | undefined;
  /** Configured queue-wait budget in ms, read per call to size the idle window. */
  queueBudgetMs?: () => number;
}
/** What {@link createQoderAdapter} hands back. */
interface QoderAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
/**
 * Assemble the adapter. `getModels` reads the live catalog and each `baseUrl` is
 * re-resolved per read, so the shim's ephemeral port applies immediately.
 *
 * The profile is hand-built because dsh-llm-pi-ai's `resolveProfiles()` is not
 * public, so every newly required profile field must be adopted here explicitly.
 */
declare function createQoderAdapter(options: QoderAdapterOptions): QoderAdapter;
//#endregion
//#region src/catalog-store.d.ts
/** One saved catalog: the account it belonged to, and the models it listed. */
interface SavedCatalog {
  /** The credential-identity key the catalog was fetched for. */
  account: string;
  /** Which answer served, so one region's roster is never used as the other's. */
  source: string;
  /** When the fetch succeeded, epoch milliseconds. */
  fetchedAtMs: number;
  models: readonly QoderModelInfo[];
}
/** Plugin-owned saved-catalog path inside the plugin's state directory. */
declare function qoderCatalogPath(filename: string): string;
/** Options for {@link QoderCatalogStore}. */
interface QoderCatalogStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string;
}
/**
 * The last successful catalog per account, read once and written atomically.
 *
 * Malformed content reads as "nothing saved" rather than throwing: a corrupt file
 * must never stop the plugin from serving models.
 */
declare class QoderCatalogStore {
  private readonly path;
  private entries;
  constructor(options?: QoderCatalogStoreOptions | string);
  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string;
  private load;
  /** The saved catalog for one account, or `undefined` when there is none. */
  get(account: string): SavedCatalog | undefined;
  /**
   * Remember a catalog for an account, replacing whatever was saved before.
   * A failed write is swallowed: the models have already been served.
   */
  set(account: string, catalog: Omit<SavedCatalog, 'account'>): void;
  /** Forget one account's catalog — used when that account signs out. */
  delete(account: string): void;
  private persist;
}
//#endregion
//#region src/probe-service.d.ts
/** What the caller learns about a completed probe. */
type QoderProbeStatus = {
  state: 'ok';
  validation: QoderProbeRecord['validation'];
  efforts: readonly string[];
  requests: number;
} | {
  state: 'unavailable';
  reason: string;
};
/** Options for {@link QoderProbeService}. */
interface QoderProbeServiceOptions {
  store: QoderProbeStore;
  catalog: QoderCatalog;
  credentials: QoderCredentialStore;
  client: QoderUpstreamClient;
  /** Whether probing is permitted at all; consulted before every sweep. */
  consent: () => boolean;
  /**
   * The account currently in effect, as a one-way hash of the credential, or
   * `undefined` while signed out.
   *
   * Re-checked after the sweep finishes: an observation produced under account A
   * must not be stored once B is in effect, and the caller's `clear()` on a switch
   * is not enough because an in-flight probe completes after it.
   */
  account: () => string | undefined;
  sentinel?: SentinelFactory;
  /** Injectable for tests; defaults to the live upstream sender. */
  send?: (modelId: string) => ProbeSender;
}
/**
 * Serial probe runner. One instance is shared by the manual API and any
 * future automatic trigger, so the two can never overlap.
 */
declare class QoderProbeService {
  private readonly options;
  private queue;
  private readonly pending;
  private running;
  constructor(options: QoderProbeServiceOptions);
  /** Whether a sweep is in flight right now. */
  isRunning(): boolean;
  /**
   * The record the adapter may use for this model, or `undefined`.
   *
   * A declared set always wins, so a model declaring `supportedEfforts` is never
   * answered from an observation.
   */
  recordFor(modelId: string): QoderProbeRecord | undefined;
  /**
   * Probe one model, serially.
   *
   * The authenticated manual route supplies one-request consent after UI
   * confirmation; other callers must pass the configured consent gate. Explicit
   * requests bypass historical results but share an ongoing run.
   */
  probe(modelId: string, manualConsent?: boolean): Promise<QoderProbeStatus>;
}
//#endregion
//#region src/auth-route.d.ts
/** Outcome of a save/activate/remove attempt: stored, or refused with a stable reason. */
type QoderAuthSaveResult = {
  ok: true;
  status: QoderAuthStatus;
} | {
  ok: false;
  error: 'qoder_invalid_pat' | 'qoder_missing_pat' | 'qoder_unknown_pat';
};
/** Constructor dependencies. */
interface QoderAuthRouteOptions {
  /**
   * Validate one pasted token against this variant's region and, only on
   * success, persist it and make it active. The route never decides validity
   * itself.
   */
  save: (pat: string, label?: string) => Promise<QoderAuthSaveResult>;
  /** Switch to one already-saved token. */
  activate: (id: string) => Promise<QoderAuthSaveResult>;
  /** Remove one saved token; the host moves the active pointer. */
  remove: (id: string) => Promise<QoderAuthSaveResult>;
  /** Remove every saved token (`logout`). */
  clear: () => Promise<void>;
  /**
   * Route path to mount. Defaults to the China variant's path; the global variant
   * passes its own.
   */
  path?: string;
}
/** Mint the per-process PAT control key. */
declare function createAuthKey(): string;
/**
 * The PAT route's handler, extracted so tests can mount it on a bare server with a
 * known key.
 *
 * @param deps - the save/activate/remove/clear operations for one variant.
 * @param key - the in-process control key this route requires.
 * @returns the Node request handler.
 */
declare function qoderAuthHandler(deps: QoderAuthRouteOptions, key: string): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** Mount the POST PAT route on an optional webServer context. */
declare function registerQoderAuthRoute(ctx: Context, deps: QoderAuthRouteOptions, key: string): void;
//#endregion
//#region src/host-heartbeat.d.ts
/**
 * Host-side heartbeat: a small JSON file written into the plugin's data directory
 * once the `qoder` providers are registered. The status CLI reads it to report
 * whether the host bundle is alive, independent of the browser card (the browser
 * bundle cannot write files, and the host is the load-bearing half).
 *
 * @module dsh-qoder-connect/host-heartbeat
 */
/** Basename of the host heartbeat file inside the plugin's state directory. */
declare const QODER_HOST_HEARTBEAT_FILENAME = ".qoder-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
declare const HEARTBEAT_FORMAT_VERSION = 1;
/** On-disk shape of the heartbeat. */
interface QoderHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION;
  package: 'dsh-qoder-connect';
  pluginVersion: string;
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number;
  /** Host process PID. Liveness is a bare existence probe: a reused PID reads as alive. */
  pid: number;
}
/** Absolute path of the host heartbeat file. */
declare function qoderHostHeartbeatPath(): string;
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
declare function clearHostHeartbeat(expectedPid?: number): Promise<void>;
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
declare function readHostHeartbeat(): Promise<QoderHostHeartbeat | undefined>;
/**
 * Whether the heartbeat's PID is still alive.
 *
 * Uses Node's native `process.kill(pid, 0)` cross-platform signal probe:
 * - Returns true on success or EPERM (process exists and is alive);
 * - Returns false on ESRCH (process does not exist in the operating system);
 * - Rejects non-positive or non-integer PIDs to prevent matching process groups.
 *
 * Known limitation: after a host crash, if the OS recycles and reassigns the same PID
 * to another process before cleanup, it reads as alive until that PID exits. This trade-off
 * is accepted because wmic was removed in Windows 11 24H2+, PowerShell child processes are
 * fragile under restrictive sandboxes, and the status check serves only as an informational
 * hint in the doctor CLI rather than a critical operational invariant.
 */
declare function isHeartbeatProcessAlive(heartbeat: QoderHostHeartbeat): boolean;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "llm-qoder";
/** The model registry the provider needs before it can register. */
declare const inject: string[];
/**
 * Settings namespace for the China card's section.
 *
 * A namespace is a nominal string checked at compile time only; the cast keeps
 * the public constant typed without pulling the branding helper into this package.
 */
declare const QODER_SETTINGS_NS: SettingsNamespace;
/**
 * Settings namespace for the global card's section.
 *
 * One namespace per card: the Plugins tab dispatches a card per served
 * namespace, so a single section would leave the other card registered but
 * never rendered.
 */
declare const QODER_GLOBAL_SETTINGS_NS: SettingsNamespace;
/**
 * Settings namespace for the shared quota card, whose per-variant fields
 * configure both sidebar widgets from one place.
 */
declare const QODER_QUOTA_SETTINGS_NS: SettingsNamespace;
/** Plugin configuration. */
interface Config {
  /** Whether the user authorized reasoning-effort probes (each one spends real credit). */
  probeConsent?: boolean;
  /** Use the largest context window the global catalog explicitly offers. */
  useMaximumContextWindow?: boolean;
  /** The China variant's own maximum-window preference. */
  useMaximumContextWindowCN?: boolean;
  /** Per-model context-window overrides, global (model id → tokens); kept for schema compatibility. */
  modelContextWindows?: Record<string, number>;
  /** The China variant's per-model overrides; see {@link Config.modelContextWindows}. */
  modelContextWindowsCN?: Record<string, number>;
  /** Models disabled for the global variant (blacklist). */
  disabledModels?: string[];
  /** Models disabled for the China variant (blacklist). */
  disabledModelsCN?: string[];
  /** Show the China variant's sidebar quota card. */
  sidebarQuotaCN?: boolean;
  /** Show the global variant's sidebar quota card. */
  sidebarQuotaGlobal?: boolean;
  /** Automatically check in daily at 10:00 (UTC+8) to claim credits for China variant. */
  autoCheckInCN?: boolean;
  /** Automatically check in daily at 10:00 (UTC+8) to claim credits for Global variant. */
  autoCheckInGlobal?: boolean;
  /** When the China variant checks in, as minutes past midnight in UTC+8 (600 = 10:00). */
  checkInMinuteCN?: number;
  /** When the Global variant checks in, as minutes past midnight in UTC+8 (600 = 10:00). */
  checkInMinuteGlobal?: number;
  /** Sidebar quota refresh interval in ms, shared by both cards (same rate-limited upstream). */
  quotaPollMs?: number;
  /**
   * Wait out Qoder's model queue inside the plugin (default on). When off, a
   * queue answer keeps its retry hint and is handed to the host instead.
   */
  queueWait?: boolean;
  /** Upper bound of that wait, in seconds (10–3600). */
  queueWaitSeconds?: number;
}
/**
 * Quota poll interval: default 5 minutes, floor 1 minute. The status route makes
 * a live, uncached upstream billing call per request, so the floor is the
 * smallest value the UI offers rather than a silent clamp.
 */
declare const QUOTA_POLL_DEFAULT_MS = 300000;
declare const QUOTA_POLL_MIN_MS = 60000;
/**
 * How long one call may wait in the model queue, in seconds.
 *
 * Only a floor is enforced: the wait is a budget the user owns, and the loop
 * divides it by whatever pace the upstream reports, so a value larger than the
 * upstream's own countdown simply spans more rounds.
 */
declare const QUEUE_WAIT_SECONDS_DEFAULT = 540;
declare const QUEUE_WAIT_SECONDS_MIN = 1;
declare const Config: z<Config>;
/**
 * The field groups the configuration is merged from, one list per card: a field
 * added to {@link Config} but missing here is never read.
 */
declare const CN_SECTION_KEYS: readonly ["probeConsent", "useMaximumContextWindowCN", "modelContextWindowsCN", "disabledModelsCN"];
declare const GLOBAL_SECTION_KEYS: readonly ["useMaximumContextWindow", "modelContextWindows", "disabledModels"];
declare const QUOTA_SECTION_KEYS: readonly ["sidebarQuotaCN", "sidebarQuotaGlobal", "autoCheckInCN", "autoCheckInGlobal", "checkInMinuteCN", "checkInMinuteGlobal", "quotaPollMs", "queueWait", "queueWaitSeconds"];
/**
 * Start both variants: loopback endpoints, the `qoder` and `qoder-global`
 * providers, their cards, and their credential-driven catalog lifecycles. Each
 * variant registers unconditionally; an empty catalog is how DSH hides a group,
 * which keeps a token saved after startup working without re-registering.
 */
/** One peer this plugin cannot run without: the spec and its declared range. */
interface PeerExpectation {
  readonly spec: string;
  readonly range: string;
}
/**
 * Read the checked peers' ranges from the manifest beside this build.
 *
 * @returns one expectation per peer that declares a string range; an unreadable
 * manifest yields none, which simply skips the check rather than blocking a load
 * on a fact it cannot establish.
 * @internal Exported for tests.
 */
declare function peerExpectations(): readonly PeerExpectation[];
/**
 * Whether this checker can decide a range at all.
 *
 * Form alone is not enough: `~1`, `^1.2` and `>=abc` share the shape of a range
 * this checker claims to enforce, yet its bound does not parse, so the
 * comparison would pass everything without ever saying so. Callers use this to
 * report the limit instead of enforcing nothing quietly.
 *
 * @internal Exported for tests.
 */
declare function supportsRange(range: unknown): boolean;
/**
 * Compare a resolved package version against a semver range. `^x.y.z`, `~x.y.z`
 * and `>=x.y.z` are enforced; every other form returns true, because a
 * declaration this checker cannot express must not block a working install —
 * callers report those forms rather than treating the pass as a verdict.
 *
 * @internal Exported for tests; the load-time check is the only caller.
 */
declare function satisfiesRange(version: string, range: string): boolean;
/** What the load-time peer check concluded. */
interface PeerCheckOutcome {
  /** A peer the host loads below its declared floor; the load must be refused. */
  failure?: string;
  /** Peers whose copy could not be named, so they went unenforced. */
  unverified: readonly string[];
}
/**
 * Report the first peer the host loads below its declared floor.
 *
 * Only a proven mismatch refuses the load. A peer whose copy cannot be resolved
 * or read is reported as unverified instead: the static imports already linked,
 * so the host supplied a working copy and failing here would refuse every clean
 * install. Unverified peers still have to reach the card, or a check that quietly
 * stopped enforcing would look like one that passed.
 *
 * @param expectations - peers to check, in report order.
 * @param warn - sink for a range it cannot interpret.
 * @param resolveEntry - injectable resolver for tests.
 * @internal Exported for tests.
 */
declare function peerVersionFailure(expectations?: readonly PeerExpectation[], warn?: (message: string) => void, resolveEntry?: (specifier: string) => string): PeerCheckOutcome;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { CHINA_VARIANT, CN_SECTION_KEYS, Config, FALLBACK_QODER_MODELS, GLOBAL_SECTION_KEYS, GLOBAL_VARIANT, KIND_STATUS, PROBE_EFFORT_CANDIDATES, PeerCheckOutcome, type ProbeAttempt, type ProbeOutcome, type ProbeSender, QODER_AUTH_FILENAME, QODER_AUTH_PATH, QODER_DATA_DIR_ENV, QODER_DATA_DIR_NAME, QODER_GLOBAL_AUTH_PATH, QODER_GLOBAL_PROBE_PATH, QODER_GLOBAL_SETTINGS_NS, QODER_GLOBAL_STATUS_PATH, QODER_HOST_HEARTBEAT_FILENAME, QODER_PAT_ENV_CN, QODER_PAT_ENV_GLOBAL, QODER_PROBE_FILENAME, QODER_PROBE_PATH, QODER_PROVIDER, QODER_QUOTA_SETTINGS_NS, QODER_SETTINGS_NS, QODER_STATUS_PATH, QODER_STREAM_IDLE_TIMEOUT_MS, QODER_VARIANTS, QUEUE_WAIT_SECONDS_DEFAULT, QUEUE_WAIT_SECONDS_MIN, QUOTA_POLL_DEFAULT_MS, QUOTA_POLL_MIN_MS, QUOTA_SECTION_KEYS, type QoderAdapter, type QoderAuthRequest, type QoderAuthRouteOptions, type QoderAuthSaveResult, type QoderAuthStatus, QoderCatalog, type QoderCatalogFetch, type QoderCatalogModelSnapshot, QoderCatalogStore, type QoderCatalogStoreOptions, type QoderChatResult, type QoderCredential, type QoderCredentialEntry, QoderCredentialStore, type QoderCreditAccount, type QoderCredits, type QoderEffort, type QoderHostHeartbeat, type QoderModelBilling, type QoderModelInfo, type QoderModelReasoning, type QoderPatProfile, type QoderPatSummary, type QoderProbeAction, type QoderProbeRecord, QoderProbeService, type QoderProbeStatus, QoderProbeStore, type QoderProbeValidation, type QoderShim, QoderUpstreamClient, type QoderVariant, type QoderVariantId, type QoderWebCatalog, type QoderWebCreditAccount, type QoderWebCredits, type QoderWebProbeModel, type QoderWebProbeSection, type QoderWebStatus, type ShimLogger, type UpstreamErrorKind, apply, classifyUpstreamError, clearHostHeartbeat, createAuthKey, createQoderAdapter, createQoderShim, fingerprintModel, inject, isHeartbeatProcessAlive, kindFromQoderFailure, modelInfoOf, name, normalizeCredits, patTail, peerExpectations, peerVersionFailure, probeModel, qoderAuthHandler, qoderCatalogPath, qoderCredentialId, qoderCredentialIdentity, qoderHostHeartbeatPath, qoderOwnAuthPath, qoderPluginDataDir, qoderProbePath, randomSentinel, readHostHeartbeat, registerQoderAuthRoute, satisfiesRange, supportsRange, variantFor };