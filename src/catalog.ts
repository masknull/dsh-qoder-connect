/**
 * Qoder model catalog: a static fallback roster, replaced by the upstream's
 * dynamic answer once it loads. These row types are the plugin's own model
 * vocabulary; `upstream.ts` translates them to and from the transport's.
 *
 * @module dsh-qoder-connect/catalog
 */

/** One model entry the adapter exposes. */
export interface QoderModelInfo {
  id: string
  name: string
  /** Effective input budget in tokens. */
  contextWindow: number
  /** The upstream's preferred window before a larger one is selected. */
  defaultContextWindow?: number
  /** Selectable window sizes the upstream declares, ascending. */
  supportedContextWindows?: readonly number[]
  /** Output cap the provider declared; absent when it declares none. */
  maxTokens?: number
  /** True only when the provider declared that cap, rather than this plugin's reserve. */
  maxTokensDeclared?: boolean
  /** Whether the model accepts image input. */
  supportsImages: boolean
  /** Reasoning metadata; absent means the upstream declared none. */
  reasoning?: QoderModelReasoning
  billing: QoderModelBilling
  /** Upstream provenance marker (`system` / `user`), when reported. */
  source?: string
  /** Catalog scene roster this model came from (`assistant`, `app`, …). */
  scene?: string
}

/** What the upstream declares about one model's reasoning. */
export interface QoderModelReasoning {
  supports: boolean
  /** Effort ids the model advertises, in canonical order. */
  supportedEfforts?: readonly string[]
  /** The model's default effort id, when the upstream names one. */
  defaultEffort?: string
  /** Whether thinking can be switched off; Qoder's catalog never says so. */
  canDisableThinking: boolean
}

/** The price the catalog reports for one model. */
export interface QoderModelBilling {
  /** Rate label, spelled `x<n>` (a multiplier on the base rate). */
  credits?: string
  /** Whether the model is free; the `x0` marker and nothing else sets this. */
  free: boolean
  /** The upstream disclosed no rate; the card shows "rate unknown". */
  rateUnknown?: boolean
}

/**
 * The built-in roster, mirrored from the transport's own `defaultModels`: the
 * model keys both regions start from before the first discovery.
 *
 * It lets the provider register while the first fetch is in flight or the
 * endpoint is unreachable; the discovery answer replaces it at startup. Reasoning
 * and rate metadata are absent because the defaults declare none.
 */
export const FALLBACK_QODER_MODELS: readonly QoderModelInfo[] = [
  { id: 'cmodel', name: 'Cantus (Qoder)', contextWindow: 1_000_000, supportsImages: true, billing: { free: false, rateUnknown: true }, source: 'system' },
  { id: 'auto', name: 'Qoder Auto', contextWindow: 180_000, supportsImages: true, billing: { free: false, rateUnknown: true }, source: 'system' },
  { id: 'ultimate', name: 'Qoder Ultimate', contextWindow: 1_000_000, supportsImages: true, billing: { free: false, rateUnknown: true }, source: 'system' },
  { id: 'performance', name: 'Qoder Performance', contextWindow: 1_000_000, supportsImages: true, billing: { free: false, rateUnknown: true }, source: 'system' },
  { id: 'efficient', name: 'Qoder Efficient', contextWindow: 180_000, supportsImages: true, billing: { free: false, rateUnknown: true }, source: 'system' },
  { id: 'lite', name: 'Qoder Lite', contextWindow: 180_000, supportsImages: false, billing: { free: false, rateUnknown: true }, source: 'system' },
]

/**
 * Mutable catalog shared by the shim's `/v1/models` and the adapter.
 *
 * Visibility is separate from content: a variant with no usable credential must
 * expose no models rather than a fallback roster, since the model picker drops an
 * empty group — and serving models that can only fail is worse than nothing.
 * The flag defaults to visible; the plugin runtime applies the credential gate.
 */
export class QoderCatalog {
  private models: readonly QoderModelInfo[]
  private visible = true
  private useMaximumContextWindow = false
  /** Per-model window overrides (model id → tokens); an override wins over the preference. */
  private modelContextWindows: Readonly<Record<string, number>> = {}
  /** Disabled model IDs (blacklist); disabled models are filtered out from current(). */
  private disabledModels: ReadonlySet<string> = new Set()

  constructor(initial: readonly QoderModelInfo[] = FALLBACK_QODER_MODELS) {
    this.models = initial
  }

  /** Current entries; empty while the variant has no usable credential, excluding disabled models. */
  current(): readonly QoderModelInfo[] {
    if (!this.visible) return []
    return this.all().filter(model => !this.disabledModels.has(model.id))
  }

  /** All configured entries including disabled ones; empty while the variant has no usable credential. */
  all(): readonly QoderModelInfo[] {
    if (!this.visible) return []
    return this.models.map(model => {
      const override = this.modelContextWindows[model.id]
      if (override !== undefined && override > 0) {
        return {
          ...model,
          defaultContextWindow: model.defaultContextWindow ?? model.contextWindow,
          contextWindow: override,
        }
      }
      const maximum = model.supportedContextWindows === undefined ? undefined : Math.max(...model.supportedContextWindows)
      return this.useMaximumContextWindow && maximum !== undefined && maximum > model.contextWindow
        ? { ...model, defaultContextWindow: model.defaultContextWindow ?? model.contextWindow, contextWindow: maximum }
        : model
    })
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly QoderModelInfo[]): void {
    this.models = [...models]
  }

  /** Whether this variant's models are exposed at all. */
  isVisible(): boolean {
    return this.visible
  }

  /**
   * Show or hide the whole catalog. Returns whether the value changed, so the
   * caller can skip an invalidation that would re-render an identical list.
   */
  setVisible(visible: boolean): boolean {
    if (this.visible === visible) return false
    this.visible = visible
    return true
  }

  /** Select the largest declared window where the upstream offers one. */
  setUseMaximumContextWindow(useMaximum: boolean): boolean {
    if (this.useMaximumContextWindow === useMaximum) return false
    this.useMaximumContextWindow = useMaximum
    return true
  }

  /**
   * Replace the per-model window overrides wholesale. Returns whether the map
   * changed, so the caller can skip an invalidation over an identical write.
   */
  setModelContextWindows(modelContextWindows: Readonly<Record<string, number>>): boolean {
    const next = { ...modelContextWindows }
    if (JSON.stringify(next) === JSON.stringify(this.modelContextWindows)) return false
    this.modelContextWindows = next
    return true
  }

  /**
   * Replace the disabled model IDs wholesale. Returns whether the set
   * changed, so the caller can skip an invalidation over an identical write.
   */
  setDisabledModels(disabledModels: readonly string[]): boolean {
    const next = new Set(disabledModels)
    if (next.size === this.disabledModels.size && [...next].every(id => this.disabledModels.has(id))) {
      return false
    }
    this.disabledModels = next
    return true
  }

  /** Current disabled model IDs. */
  getDisabledModels(): readonly string[] {
    return Array.from(this.disabledModels)
  }

  /**
   * Models to fall back to when the upstream fetch fails; ignores
   * visibility, because the caller asking for the fallback already knows the
   * credential state.
   */
  fallback(): readonly QoderModelInfo[] {
    return this.models
  }
}
