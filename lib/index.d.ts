import z from "@deepseek-ai/schemastery";
import "@earendil-works/pi-ai";
import { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { IncomingMessage, ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/paths.d.ts
/**
 * The plugin's data directory — the ONE place every file the plugin owns
 * lives.
 *
 * Layout: `<profile>/.dsh-qoder-connect/state/` (the profile discovered
 * the same way the credential store always did). Everything — PAT files,
 * saved catalogs, probe records, the host heartbeat, and the machine-id
 * seed — writes there, so a profile directory never collects loose
 * `.qoder-*` files and the whole plugin's footprint is one folder.
 *
 * Fallbacks, in order: `DSH_QODER_DATA_DIR` env override → the discovered
 * profile → the Harness home (a checkout running its own tests, or a host
 * loading the plugin from outside any profile).
 *
 * Split out of `auth.ts` so catalog/probe/heartbeat stores can import the
 * directory without pulling in the credential code (and its upstream
 * dependency) — these modules stay leaf-light on purpose.
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
 * Falls back to the Harness home when no profile can be discovered — a
 * checkout running its own tests, or a host that loads the plugin from
 * outside a profile — so the plugin always has somewhere to write, and
 * `DSH_QODER_DATA_DIR` overrides either way.
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
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore
 * also requires the in-process key the browser half receives with the status
 * document.
 */
declare const QODER_PROBE_PATH = "/plugins/dsh-qoder-connect/probe";
/**
 * Plugin-owned PAT endpoint, one per variant.
 *
 * A POST here saves (validates and persists) a Personal Access Token, or
 * clears the stored one. Unlike the read-only status GET it is a write —
 * it persists a credential — so it also requires the in-process key the
 * browser half receives with the status document.
 */
declare const QODER_AUTH_PATH = "/plugins/dsh-qoder-connect/auth";
/**
 * The international (Qoder Global) variant's own triple of routes.
 *
 * Kept as separate constants rather than a computed suffix so both halves
 * reference literal strings: the browser bundle and the host bundle are built
 * independently, and a shared expression is one build-config drift away from
 * the desk asking a route the host never mounted.
 */
declare const QODER_GLOBAL_STATUS_PATH = "/plugins/dsh-qoder-connect/global/status";
declare const QODER_GLOBAL_PROBE_PATH = "/plugins/dsh-qoder-connect/global/probe";
declare const QODER_GLOBAL_AUTH_PATH = "/plugins/dsh-qoder-connect/global/auth";
/**
 * One action the PAT route accepts.
 *
 * `save-pat` validates the pasted token against the variant's region and, only
 * on success, persists it; `clear` removes the stored credential. There is no
 * device flow and no credential import: the token is the whole auth surface.
 */
type QoderAuthAction = 'save-pat' | 'clear';
/** Request body accepted by the PAT route. */
interface QoderAuthRequest {
  action: QoderAuthAction;
  /** The token to validate and store; required for `save-pat`. */
  pat?: string;
}
/** Where the credential in effect came from. */
type QoderCredentialSource = 'card' | 'env' | 'cli';
/**
 * Redacted summary of one variant's PAT.
 *
 * Never the token itself: the browser half displays where the credential came
 * from, when it was saved, and the last four characters — enough to tell two
 * tokens apart, not enough to misuse one.
 */
interface QoderPatSummary {
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
   * `refresh` re-reads the credential and re-fetches the model catalog;
   * `set-maximum-context-window` persists the card's maximum-window
   * preference (one per variant section).
   *
   * All are writes, which is why they share this route's in-process key
   * and loopback guards rather than the read-only status GET.
   */
  action: 'probe' | 'clear' | 'refresh' | 'set-maximum-context-window' | 'clear-checkin-logs' | 'checkin';
  /** Target model id; required for `probe`. */
  model?: string;
  /** Requested value for `set-maximum-context-window`. */
  enabled?: boolean;
}
/**
 * Where the models a card is currently showing came from.
 *
 * The plan requires the card to distinguish a live catalog from the built-in
 * fallback, and to say when the last attempt failed — otherwise a stale list is
 * indistinguishable from an offline one, and a user cannot tell whether the
 * models they see still match the upstream.
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
   * When the package's credit expires, carried through in whatever form the
   * upstream reported it (an ISO string or a numeric epoch-millisecond value
   * normalized to an ISO string). Absent when the upstream reported no
   * expiry — rendered as "no expiry", never guessed into a date.
   */
  packageEndTime?: string;
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
 * A plain-Qoder mirror of `src/qoder/catalog.ts`'s `QoderCatalogModel` (the
 * WorkBuddy-era billing/promotion/free fields are gone): the browser half
 * renders reasoning, price factor, and context capacity from these fields and
 * nothing else. Field names follow the Qoder catalog vocabulary so the two
 * halves cannot drift on spelling.
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
  /**
   * The last automatic job-token refresh the self-heal performed, epoch ms.
   * Absent when no refresh has happened in this process. The card renders
   * this as a visible "token auto-refreshed" notice, so an otherwise
   * invisible recovery is observable.
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
    status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error';
    amount?: number | undefined;
    message?: string | undefined;
    logs?: readonly {
      id: string;
      date: string;
      timestamp: number;
      status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error';
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
} | {
  /**
   * No usable token, and the card may save one.
   *
   * Its own arm rather than an optional field on the signed-in document,
   * because the PAT key below is exactly what a signed-out card needs and a
   * signed-in one does not: the two states ask for different actions, and a
   * single arm would let a card offer clear and save at once.
   */
  status: 'signed-out';
  /**
   * Why no credential is usable, when that is diagnosable rather than simply
   * "nobody signed in" — a stale WorkBuddy-era credential file being the
   * case that matters. The card renders it in place of the generic hint.
   */
  reason?: string;
  /**
   * In-process key authorizing PAT writes; see the signed-in arm's
   * `probeKey` for why it travels with the document.
   */
  authKey?: string;
} | {
  status: 'error';
  message: string;
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
   *
   * One per variant, like the probe records: the two deployments disagree about
   * rates, windows, and even which models exist for a shared id, so a catalog
   * saved from one must never be served as the other's.
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
/** Runtime credential, timestamps in epoch milliseconds. */
interface QoderCredential {
  pat: string;
  region: QoderRegion;
  /** When the stored token was saved; absent for environment-sourced tokens. */
  savedAtMs?: number;
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
 * Stable identity key for a credential, used by probe records and saved
 * catalogs.
 *
 * A PAT is a bearer secret, so the key is its one-way hash rather than any
 * suffix of it: surfaces that show the key (cards, JSON diagnostics) leak
 * nothing usable, while two reads of the same token still correlate locally.
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
   * Resolution order: the plugin-owned file, then the arm's environment
   * variable (only when no file exists — a saved token always wins over a
   * stray env), then nothing. There is no refresh and no expiry check: a PAT
   * lives until revoked.
   */
  current(): Promise<QoderCredential | undefined>;
  /**
   * The credential, or a thrown `MISSING_CREDENTIAL` error.
   *
   * Callers that serve requests (the shim, the catalog sweep) use this so the
   * absence of a token surfaces as the same classified failure the transport
   * itself raises when a saved token turns out empty.
   */
  resolve(): Promise<QoderCredential>;
  /** The token in effect as a bare string, rejecting when there is none. */
  patPromise(): Promise<string>;
  /**
   * Persist a token for this variant. The caller is responsible for having
   * validated it against the region first (`validateApiKey` upstream).
   */
  save(pat: string, source?: QoderCredentialSource): Promise<QoderCredential>;
  /** Remove the stored credential. A missing file is not an error. */
  clear(): Promise<void>;
  /** Alias kept for call-site readability (`logout` is just clearing). */
  logout(): Promise<void>;
  /** Redacted summary for the card, the PAT route, and doctor output. */
  status(): Promise<QoderAuthStatus>;
  /** Set when a read found a stale WorkBuddy-era file; consumed once. */
  private pendingLegacyReason;
  private fromEnvironment;
  private readOwn;
  private writeOwn;
}
/**
 * The plugin-owned credential path for one variant's default filename.
 * Kept as a free function for the CLI, which builds no store per display line.
 */
declare function qoderOwnAuthPath(variant: QoderVariant): string;
//#endregion
//#region src/catalog.d.ts
/**
 * Qoder model catalog: a static fallback roster captured from the transport's
 * built-in defaults, replaced by the upstream's dynamic answer once it loads.
 *
 * The row types moved here from the WorkBuddy-era upstream module: they are
 * the plugin's own model vocabulary (what the catalog stores, the adapter
 * exposes, and the card renders), while `QoderCatalogModel` in
 * `src/qoder/catalog.ts` is the upstream's. `upstream.ts` translates one into
 * the other.
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
  /** Per-request output cap. */
  maxTokens: number;
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
 * The built-in roster, transcribed from the transport's own `defaultModels`
 * (`src/qoder/catalog.ts`) — the Qoder model keys both regions start from
 * before the first successful discovery: `cmodel`, `auto`, `ultimate`,
 * `performance`, `efficient`, `lite`.
 *
 * It exists so the provider registers with a usable catalog while the first
 * fetch is in flight or the endpoint is unreachable, and it is deliberately
 * *not* a promise about the upstream's current state: the discovery answer
 * replaces it at startup. No per-region roster is invented here — the
 * transport ships one shared default set, and this mirror keeps the same
 * discipline. Reasoning and rate metadata are absent because the defaults
 * declare none; those rows offer no thinking control until the upstream says
 * otherwise.
 */
declare const FALLBACK_QODER_MODELS: readonly QoderModelInfo[];
/**
 * Mutable catalog shared by the shim's `/v1/models` and the adapter.
 *
 * Visibility is separate from content. A variant with no usable credential
 * must expose *no* models rather than a fallback roster: the DSH model picker
 * drops an empty group, so an empty catalog is exactly how a provider hides
 * without touching registration. Serving the fallback to a signed-out user
 * instead offers models that can only fail (the transport throws
 * `MISSING_CREDENTIAL` on the first message), which is worse than showing
 * nothing.
 *
 * The flag defaults to visible so a directly-constructed catalog behaves as
 * it always has; the plugin runtime applies the credential gate.
 */
declare class QoderCatalog {
  private models;
  private visible;
  private useMaximumContextWindow;
  /** Per-model window overrides (model id → tokens); an override wins over the preference. */
  private modelContextWindows;
  constructor(initial?: readonly QoderModelInfo[]);
  /** Current entries; empty while the variant has no usable credential. */
  current(): readonly QoderModelInfo[];
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
  maxTokens?: number;
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
interface QoderQuotaUsage {
  userQuota?: QoderQuota | undefined;
  addOnQuota?: QoderQuota | undefined;
  orgResourcePackage?: QoderQuota | undefined;
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
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error';
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
 * Mirrors the canonical order of `src/qoder/catalog.ts` (`low` … `max`).
 * `minimal` and `off` are deliberately absent: `off` is a separate capability
 * the upstream must declare, never something probing may infer.
 */
type QoderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** How the shim should present an upstream failure to its OpenAI client. */
type UpstreamErrorKind = 'missing_credential' | 'auth' | 'soft_rate' | 'quota_exceeded' | 'server' | 'client';
/** HTTP status the shim answers each failure kind with. */
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
  /** Expiry of this package, verbatim from the upstream (ISO string). */
  packageEndTime?: string;
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
 * Qoder reports a `priceFactor` number; the host spells it `x<n>` (and the
 * WorkBuddy-era saved files sometimes carried a trailing " credits"). The card
 * wants one shape: a trimmed multiplier without the suffix.
 */
declare function normalizeCredits(credits: string | undefined): string | undefined;
/**
 * Classify a raw HTTP upstream failure from status and a body excerpt.
 *
 * Status first, then phrases: a throttling body often also says "quota
 * exceeded", and reading that as an exhausted balance parks a healthy account
 * until the next billing day instead of retrying shortly.
 */
declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/**
 * Map one structured transport failure onto the shim's error kind.
 *
 * The transport's taxonomy (`src/qoder/errors.ts`) codes an HTTP 402 as
 * `INVALID_REQUEST`, so the status gets the last say for the quota and auth
 * families before the code-based defaults apply.
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
   * The catalog row for one model id: this client's own discovery answers
   * first (it is the same data the upstream catalog call produced), and an
   * externally supplied provider — the plugin's fallback roster, say — fills
   * ids the discovery never listed.
   */
  catalogModelFor(id: string): QoderCatalogModel | undefined;
  /**
   * Discover this variant's models and translate them into plugin rows.
   *
   * The raw rows stay addressable via {@link catalogModelFor}: a chat request
   * for a discovered model must hand the transport its row, because effort
   * support, image capability, and the output cap are all validated against
   * it. The last successful fetch's provenance lands in {@link lastCatalog}
   * for the status card.
   */
  fetchModels(signal?: AbortSignal): Promise<QoderModelInfo[]>;
  /**
   * The subscriber's quota answer, mapped onto the card's credit shape.
   *
   * Qoder reports one personal quota and an optional organization resource
   * package; each becomes a package row the card already knows how to draw.
   * An unbounded personal allowance (`total === 0`, not exceeded) is the
   * account's "unlimited" state.
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
   * everything the transport can reject without touching the network — a
   * missing or empty credential, an effort the model does not advertise, an
   * image on a text-only model — must still be able to answer as a real HTTP
   * status, not as a 200 whose first frame is an error. Once streaming has
   * begun, failures degrade to the error-frame-then-`[DONE]` form the
   * {@link ChunkEncoder} documents.
   */
  chatStream(bodyJson: string, signal?: AbortSignal): Promise<QoderChatResult>;
  /** Drive the SSE body from an already-started chunk iterator. */
  private bodyStream;
  /**
   * One minimal reasoning-effort request, as the probe sweep needs it.
   *
   * The transport validates `reasoningEffort` against the model's advertised
   * efforts **locally** before any network call: a rejection therefore reads
   * as an attributable 400 with code `UNSUPPORTED_REASONING_EFFORT`, and an
   * accepted value costs exactly one streamed request, which this method ends
   * after the first chunk arrives. A probe on this upstream measures the
   * discovery catalog as much as the endpoint behind it — see the module docs
   * in `probe.ts`.
   */
  probeEffort(model: string, effort: string | undefined, signal: AbortSignal): Promise<ProbeAttempt>;
}
/**
 * Translate one Qoder catalog row into the plugin's model-info shape.
 *
 * The Qoder vocabulary carries less than the WorkBuddy one did — no badges,
 * no promotions, no free/credits strings — so the billing section reports the
 * price factor only, spelled `x<n>`, and says so honestly when the upstream
 * reported nothing (`rateUnknown`). Context capacity comes from the effective
 * window, with the declared options kept for the card and the maximum-window
 * preference; a row with no capacity at all takes the transport's own default.
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
   * An effort set is a fact about one account's entitlement as much as about
   * the model: the same model id can accept different levels under a different
   * subscription. Without this a record outlived the account that produced it,
   * so signing out and in as someone else inherited the previous account's
   * detected levels. Records written before this field existed carry no
   * identity and are therefore never reused.
   */
  account?: string;
}
/**
 * Plugin-owned probe record path inside the plugin's state directory.
 *
 * One file per variant. The two regions serve overlapping model ids with
 * different entitlements, and {@link fingerprintModel} covers only
 * `id`/`reasoning`/`supportsImages` — never the provider — so a single shared
 * file would let one variant's observation answer for the other. The paths
 * differ; the format does not.
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
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream credential, because the shim
   * resolves the real credential itself via the store.
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
}
/**
 * Start the loopback endpoint. Requests carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 */
declare function createQoderShim(options: QoderShimOptions): QoderShim;
//#endregion
//#region src/adapter.d.ts
/** Default provider route owned by this bundle (the China variant). */
declare const QODER_PROVIDER = "qoder";
/** Provider idle ceiling while one stream read is outstanding. */
declare const QODER_STREAM_IDLE_TIMEOUT_MS = 300000;
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
}
/** What {@link createQoderAdapter} hands back. */
interface QoderAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 *
 * The profile is constructed by hand rather than through dsh-llm-pi-ai's
 * internal `resolveProfiles()`: that helper is not part of the package's
 * public export surface (root entry, `lib/` deep imports blocked by the
 * exports map, `src/` not shipped), so hand-assembly is the only supported
 * path and every newly required field must be adopted here explicitly —
 * `modelErrors` since 0.1.5-alpha.2 (#12).
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
 * Malformed content reads as "nothing saved" rather than throwing: this file
 * is an optimization for the offline and first-seconds cases, and a corrupt one
 * must never be able to stop the plugin from serving models.
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
   *
   * A failed write is swallowed: the plugin has already served these models,
   * and losing the *memory* of them is not worth surfacing.
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
   * Records are read and written against this identity, and it is re-checked
   * after the sweep finishes: an observation produced under account A must not
   * be stored once account B is in effect, however long the probe took. The
   * caller's `clear()` on an account switch is not sufficient on its own,
   * because an in-flight probe completes *after* that clear.
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
   * Applies the plan's precedence (§5): a declared set always wins, so a model
   * that declares `supportedEfforts` is never answered from an observation.
   */
  recordFor(modelId: string): QoderProbeRecord | undefined;
  /**
   * Probe one model, serially.
   *
   * The authenticated manual route supplies one-request consent after UI
   * confirmation. Other callers must pass the configured consent gate.
   * Manual consent never changes the automatic-probing configuration.
   * Explicit requests bypass historical results, but share an ongoing run.
   */
  probe(modelId: string, manualConsent?: boolean): Promise<QoderProbeStatus>;
}
//#endregion
//#region src/auth-route.d.ts
/** Outcome of a save attempt: stored, or refused with a stable reason. */
type QoderAuthSaveResult = {
  ok: true;
  status: QoderAuthStatus;
} | {
  ok: false;
  error: 'qoder_invalid_pat' | 'qoder_missing_pat';
};
/** Constructor dependencies. */
interface QoderAuthRouteOptions {
  /**
   * Validate one pasted token against this variant's region and, only on
   * success, persist it. The route never decides validity itself.
   */
  save: (pat: string) => Promise<QoderAuthSaveResult>;
  /** Remove the stored credential. */
  clear: () => Promise<void>;
  /**
   * Route path to mount. Defaults to the China variant's path so callers that
   * only serve it keep their behaviour; the global variant passes its own.
   */
  path?: string;
}
/** Mint the per-process PAT control key. */
declare function createAuthKey(): string;
/**
 * The PAT route's handler, extracted so tests can mount it on a bare server
 * with a known key.
 *
 * @param deps - the save/clear operations for one variant.
 * @param key - the in-process control key this route requires.
 * @returns the Node request handler.
 */
declare function qoderAuthHandler(deps: QoderAuthRouteOptions, key: string): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** Mount the POST PAT route on an optional webServer context. */
declare function registerQoderAuthRoute(ctx: Context, deps: QoderAuthRouteOptions, key: string): void;
//#endregion
//#region src/host-heartbeat.d.ts
/**
 * Host-side heartbeat: a small JSON file written into the plugin's data
 * directory once the `qoder` providers are registered. The status CLI reads it
 * to report whether the host bundle is alive, independent of the browser card.
 *
 * The browser (client) bundle cannot write files; its health is reported
 * only through `console.error` on failure (see `src/client/index.tsx`).
 * This asymmetry is intentional: the host is the load-bearing half, and
 * a missing heartbeat unambiguously means the host never started.
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
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number;
}
/** Absolute path of the host heartbeat file. */
declare function qoderHostHeartbeatPath(): string;
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
declare function clearHostHeartbeat(): Promise<void>;
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
declare function readHostHeartbeat(): Promise<QoderHostHeartbeat | undefined>;
/**
 * Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
 * when it cannot be determined (no such PID, platform lacks a readable source).
 *
 * - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
 *   `Date.parse` resolves it against the local clock, which matches how
 *   `registeredAt` (a `Date.now()` absolute value) is expressed.
 * - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
 *   `Date.UTC`, again comparable to `registeredAt`.
 *
 * Failures return `undefined` so callers can fall back to plain PID liveness
 * rather than mis-report a running host as dead.
 */
declare function processStartTimeMs(pid: number): number | undefined;
/**
 * Whether the heartbeat's PID is still alive *and* still the same process that
 * registered it. A stale heartbeat (host crashed without clearing the file)
 * is distinguished from a live host by two checks:
 *
 * 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
 * 2. The process holding that PID started at or before `registeredAt`. A host
 *    that registered the heartbeat must have been started before writing it,
 *    so `start <= registeredAt`; a recycled PID belongs to an unrelated process
 *    started after the host died, so `start > registeredAt` correctly reads dead.
 *
 * PID-only detection is not enough: after a crash the OS may hand the same PID
 * to an unrelated process, and the un-cleared stale heartbeat would otherwise
 * produce a false "Host running". When the process start time cannot be read
 * (e.g. unsupported platform) the check degrades to plain PID liveness.
 */
declare function isHeartbeatProcessAlive(heartbeat: QoderHostHeartbeat): boolean;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "llm-qoder";
/** The model registry required before the provider can register. */
declare const inject: string[];
/**
 * Settings namespace owning the China card's section.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call. The brand is compile-time only, so this
 * stays the plain string it always was — every comparison, descriptor lookup,
 * and `dsh` config file still sees `'qoder'`. It is cast once here so the
 * public constant carries the seam's type without pulling the brand helper
 * into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
 * their namespaces as plain string literals).
 */
declare const QODER_SETTINGS_NS: SettingsNamespace;
/**
 * Settings namespace owning the global card's section.
 *
 * One namespace per card, not one shared: the settings Plugins tab dispatches a
 * card by rendering `settings.plugin.item` with `entryKey = ns` for each
 * namespace the Host serves, and skips an entry whose key names no served
 * namespace. With a single installed section, the global card registers
 * into the slot but is never rendered — the card list is built from the Host's
 * sections, not from the slot's entries. Each card therefore needs its own
 * installed section whose namespace equals the card's slot key.
 */
declare const QODER_GLOBAL_SETTINGS_NS: SettingsNamespace;
/**
 * Settings namespace owning the shared quota-card section.
 *
 * One card above the two variant cards configures both sidebar quota widgets
 * (China and global) from a single place, so its toggles cannot live in
 * either variant's section — they are per-variant fields on a cross-variant
 * card. The Plugins tab dispatches by namespace, so this section is what makes
 * that card render (see {@link QODER_GLOBAL_SETTINGS_NS} for the mechanism).
 */
declare const QODER_QUOTA_SETTINGS_NS: SettingsNamespace;
/** Plugin configuration. */
interface Config {
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent?: boolean;
  /** Use the largest context window the global catalog explicitly offers. */
  useMaximumContextWindow?: boolean;
  /** The China variant's own maximum-window preference, persisted in its section. */
  useMaximumContextWindowCN?: boolean;
  /**
   * Per-model context-window overrides for the global variant (model id →
   * tokens). Kept for schema compatibility; the card no longer writes
   * per-model overrides because the upstream honours only the default and
   * the maximum, nothing between.
   */
  modelContextWindows?: Record<string, number>;
  /** The China variant's per-model overrides; see {@link Config.modelContextWindows}. */
  modelContextWindowsCN?: Record<string, number>;
  /** Show the China variant's sidebar quota card. */
  sidebarQuotaCN?: boolean;
  /** Show the global variant's sidebar quota card. */
  sidebarQuotaGlobal?: boolean;
  /** Automatically check in daily at 10:00 (UTC+8) to claim credits for China variant. */
  autoCheckInCN?: boolean;
  /** Automatically check in daily at 10:00 (UTC+8) to claim credits for Global variant. */
  autoCheckInGlobal?: boolean;
  /**
   * Sidebar quota refresh interval in milliseconds. One shared value (both
   * cards poll on it) because the two widgets hit the same rate-limited
   * billing family; the floor guards against a typo hammering the quota
   * endpoint, which serves no cache.
   */
  quotaPollMs?: number;
}
/**
 * Quota poll interval: default 5 minutes, floor 1 minute. The status route
 * performs a live upstream billing call per request with no cache, so an
 * aggressively small interval translates directly into upstream load; the
 * floor is the smallest value the UI offers rather than a silent clamp —
 * smaller staged values fail Host validation and refuse to save.
 */
declare const QUOTA_POLL_DEFAULT_MS = 300000;
declare const QUOTA_POLL_MIN_MS = 60000;
declare const Config: z<Config>;
/**
 * Start both variants: their loopback endpoints, the `qoder` and
 * `qoder-global` providers, their configuration cards, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a token saved after startup working
 * without re-registering the provider.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { CHINA_VARIANT, Config, FALLBACK_QODER_MODELS, GLOBAL_VARIANT, KIND_STATUS, PROBE_EFFORT_CANDIDATES, type ProbeAttempt, type ProbeOutcome, type ProbeSender, QODER_AUTH_FILENAME, QODER_AUTH_PATH, QODER_DATA_DIR_ENV, QODER_DATA_DIR_NAME, QODER_GLOBAL_AUTH_PATH, QODER_GLOBAL_PROBE_PATH, QODER_GLOBAL_SETTINGS_NS, QODER_GLOBAL_STATUS_PATH, QODER_HOST_HEARTBEAT_FILENAME, QODER_PAT_ENV_CN, QODER_PAT_ENV_GLOBAL, QODER_PROBE_FILENAME, QODER_PROBE_PATH, QODER_PROVIDER, QODER_QUOTA_SETTINGS_NS, QODER_SETTINGS_NS, QODER_STATUS_PATH, QODER_STREAM_IDLE_TIMEOUT_MS, QODER_VARIANTS, QUOTA_POLL_DEFAULT_MS, QUOTA_POLL_MIN_MS, type QoderAdapter, type QoderAuthRequest, type QoderAuthRouteOptions, type QoderAuthSaveResult, type QoderAuthStatus, QoderCatalog, type QoderCatalogFetch, type QoderCatalogModelSnapshot, QoderCatalogStore, type QoderCatalogStoreOptions, type QoderChatResult, type QoderCredential, QoderCredentialStore, type QoderCreditAccount, type QoderCredits, type QoderEffort, type QoderHostHeartbeat, type QoderModelBilling, type QoderModelInfo, type QoderModelReasoning, type QoderPatSummary, type QoderProbeAction, type QoderProbeRecord, QoderProbeService, type QoderProbeStatus, QoderProbeStore, type QoderProbeValidation, type QoderShim, QoderUpstreamClient, type QoderVariant, type QoderVariantId, type QoderWebCatalog, type QoderWebCreditAccount, type QoderWebCredits, type QoderWebProbeModel, type QoderWebProbeSection, type QoderWebStatus, type ShimLogger, type UpstreamErrorKind, apply, classifyUpstreamError, clearHostHeartbeat, createAuthKey, createQoderAdapter, createQoderShim, fingerprintModel, inject, isHeartbeatProcessAlive, kindFromQoderFailure, modelInfoOf, name, normalizeCredits, patTail, probeModel, processStartTimeMs, qoderAuthHandler, qoderCatalogPath, qoderCredentialIdentity, qoderHostHeartbeatPath, qoderOwnAuthPath, qoderPluginDataDir, qoderProbePath, randomSentinel, readHostHeartbeat, registerQoderAuthRoute, variantFor };