import { describe, expect, it } from 'vitest'
import { QODER_PROVIDER, createQoderAdapter, reasoningFields } from '../src/adapter.ts'
import { QoderCredentialStore } from '../src/auth.ts'
import { QoderCatalog, type QoderModelInfo } from '../src/catalog.ts'
import type { QoderProbeRecord } from '../src/probe-store.ts'
import type { QoderShim } from '../src/shim.ts'
import { CHINA_VARIANT } from '../src/variants.ts'

/**
 * The Qoder pi-ai adapter: model descriptors pointed at the loopback shim,
 * the billing-rate display overlay, and the `reasoningFields` resolution
 * (declared set first, validating observation second, `off` never probed).
 */

/** The pi-ai collection built by an adapter exposes the exact model descriptor it consumes. */
interface PiModelDescriptor {
  id?: string
  name?: string
  provider?: string
  baseUrl?: string
  input?: readonly string[]
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
  contextWindow?: number
  maxTokens?: number
  compat?: { maxTokensField?: string }
}

interface AdapterSnapshot {
  models: {
    getModel(provider: string, model: string): PiModelDescriptor | undefined
  }
}

function fakeShim(baseUrl = 'http://127.0.0.1:40001'): QoderShim {
  return {
    ready: Promise.resolve(),
    baseUrl: () => baseUrl,
    token: () => 'test-shared-secret',
    close: async () => {},
  }
}

function unusedStore(): QoderCredentialStore {
  // The adapter never reads the store at construction time; this only
  // satisfies the option's type without touching the filesystem.
  return new QoderCredentialStore({ variant: CHINA_VARIANT, ownPath: 'qoder-adapter-spec-unused.json' })
}

function modelInfo(overrides: Partial<QoderModelInfo> = {}): QoderModelInfo {
  return {
    id: 'model',
    name: 'Model',
    contextWindow: 1_000,
    maxTokens: 128_000,
    supportsImages: false,
    billing: { free: false },
    ...overrides,
  }
}

describe('Qoder adapter model descriptors', () => {
  it('QODER_PROVIDER names the China route', () => {
    expect(QODER_PROVIDER).toBe('qoder')
  })

  it('uses Qoder\'s max_tokens output-cap field against the shim /v1 base', () => {
    const catalog = new QoderCatalog([modelInfo()])
    const { adapter } = createQoderAdapter({
      catalog,
      store: unusedStore(),
      shim: fakeShim(),
    })

    // `current()` is private in the adapter's public API, but this is the
    // descriptor seam pi-ai reads before it serializes a request.
    const snapshot = (adapter as unknown as { current(): AdapterSnapshot }).current()
    const descriptor = snapshot.models.getModel(QODER_PROVIDER, 'model')
    expect(descriptor?.compat?.maxTokensField).toBe('max_tokens')
    // The OpenAI SDK appends `/chat/completions`, so the shim sees `/v1`.
    expect(descriptor?.baseUrl).toBe('http://127.0.0.1:40001/v1')
    expect(descriptor?.provider).toBe('qoder')
    expect(descriptor?.contextWindow).toBe(1_000)
    expect(descriptor?.maxTokens).toBe(128_000)
  })

  it('carries the variant providerId into the descriptors', () => {
    const catalog = new QoderCatalog([modelInfo()])
    const { adapter } = createQoderAdapter({
      providerId: 'qoder-global',
      displayName: 'Qoder Global',
      catalog,
      store: unusedStore(),
      shim: fakeShim(),
    })
    const snapshot = (adapter as unknown as { current(): AdapterSnapshot }).current()
    expect(snapshot.models.getModel('qoder-global', 'model')?.provider).toBe('qoder-global')
  })

  it('maps image support onto the pi-ai input modalities', () => {
    const catalog = new QoderCatalog([
      modelInfo({ id: 'vision', supportsImages: true }),
      modelInfo({ id: 'text-only', supportsImages: false }),
    ])
    const { adapter } = createQoderAdapter({ catalog, store: unusedStore(), shim: fakeShim() })
    const snapshot = (adapter as unknown as { current(): AdapterSnapshot }).current()
    expect(snapshot.models.getModel(QODER_PROVIDER, 'vision')?.input).toEqual(['text', 'image'])
    expect(snapshot.models.getModel(QODER_PROVIDER, 'text-only')?.input).toEqual(['text'])
  })

  it('folds the catalog billing rate into the listed display name', async () => {
    const catalog = new QoderCatalog([
      modelInfo({ id: 'rated', name: 'Rated', billing: { credits: 'x1.8', free: false } }),
      modelInfo({ id: 'free', name: 'Free', billing: { credits: 'x0', free: true } }),
      modelInfo({ id: 'unknown', name: 'Unknown', billing: { free: false, rateUnknown: true } }),
      modelInfo({ id: 'plain', name: 'Plain', billing: { free: false } }),
    ])
    const { adapter } = createQoderAdapter({ catalog, store: unusedStore(), shim: fakeShim() })
    const listed = await adapter.listModels(QODER_PROVIDER)
    const byId = new Map(listed.map(model => [model.id, model.name]))
    // The rate rides the *name*: middle dot + normalized `x<n>` multiplier.
    expect(byId.get('rated')).toBe('Rated · x1.8')
    expect(byId.get('free')).toBe('Free · x0')
    // A rate the plugin cannot stand behind renders as words, not an empty
    // slot; a model missing from the catalog falls through untouched.
    expect(byId.get('unknown')).toBe('Unknown · 价格暂不可用')
    expect(byId.get('plain')).toBe('Plain')
    // Every listed row reports the adapter's own provider route.
    expect(listed.every(model => model.provider === QODER_PROVIDER)).toBe(true)
  })
})

describe('reasoningFields', () => {
  it('non-reasoning rows stay off', () => {
    expect(reasoningFields(modelInfo())).toEqual({ reasoning: false })
    expect(reasoningFields(modelInfo({
      reasoning: { supports: false, canDisableThinking: false },
    }))).toEqual({ reasoning: false })
  })

  it('offers exactly the declared efforts, and never more', () => {
    const result = reasoningFields(modelInfo({
      reasoning: {
        supports: true,
        supportedEfforts: ['low', 'medium', 'high'],
        canDisableThinking: false,
      },
    }))
    expect(result.reasoning).toBe(true)
    const map = result.thinkingLevelMap
    expect(map).toBeDefined()
    expect(map?.off).toBeNull() // `off` needs an explicit canDisableThinking
    expect(map?.minimal).toBeNull() // not part of the Qoder effort vocabulary
    expect(map?.low).toBe('low')
    expect(map?.medium).toBe('medium')
    expect(map?.high).toBe('high')
    expect(map?.xhigh).toBeNull()
    expect(map?.max).toBeNull()
  })

  it('declares `off` only when the upstream can disable thinking', () => {
    const result = reasoningFields(modelInfo({
      reasoning: { supports: true, supportedEfforts: ['low'], canDisableThinking: true },
    }))
    expect(result.thinkingLevelMap?.off).toBe('off')
  })

  it('an undeclared row with a validating observation gets the observed efforts', () => {
    const observed: QoderProbeRecord = {
      fingerprint: 'f'.repeat(16),
      validation: 'validating',
      efforts: ['low', 'xhigh'],
      probedAtMs: Date.now(),
      pluginVersion: '0.0.0-test',
    }
    const result = reasoningFields(
      modelInfo({ reasoning: { supports: true, canDisableThinking: false } }),
      observed,
    )
    expect(result.reasoning).toBe(true)
    expect(result.thinkingLevelMap?.low).toBe('low')
    expect(result.thinkingLevelMap?.xhigh).toBe('xhigh')
    expect(result.thinkingLevelMap?.medium).toBeNull()
    // A probing observation never grants `off`.
    expect(result.thinkingLevelMap?.off).toBeNull()
  })

  it('a non-validating (or empty) observation yields no control', () => {
    const nonValidating: QoderProbeRecord = {
      fingerprint: 'a'.repeat(16),
      validation: 'non-validating',
      efforts: [],
      probedAtMs: 1,
      pluginVersion: '0.0.0-test',
    }
    const reasoning = modelInfo({ reasoning: { supports: true, canDisableThinking: false } })
    expect(reasoningFields(reasoning, nonValidating)).toEqual({ reasoning: false })
    // Even a validating record with no efforts supplies nothing.
    const emptyValidating: QoderProbeRecord = { ...nonValidating, validation: 'validating' }
    expect(reasoningFields(reasoning, emptyValidating)).toEqual({ reasoning: false })
  })

  it('an observation never widens or narrows a declared set', () => {
    const observed: QoderProbeRecord = {
      fingerprint: 'b'.repeat(16),
      validation: 'validating',
      efforts: ['max'],
      probedAtMs: 1,
      pluginVersion: '0.0.0-test',
    }
    const result = reasoningFields(
      modelInfo({
        reasoning: { supports: true, supportedEfforts: ['low', 'high'], canDisableThinking: false },
      }),
      observed,
    )
    expect(result.thinkingLevelMap?.low).toBe('low')
    expect(result.thinkingLevelMap?.high).toBe('high')
    // The observed `max` is ignored: the declared set is the answer.
    expect(result.thinkingLevelMap?.max).toBeNull()
  })
})
