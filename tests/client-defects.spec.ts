import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FALLBACK_QODER_MODELS } from '../src/catalog.ts'
import { QoderPluginCard } from '../src/client/QoderPluginCard.tsx'
import { QoderProbeControl } from '../src/client/QoderProbeControl.tsx'
import { en } from '../src/client/locales.ts'
import { resetQuotaStatusForTesting } from '../src/client/quota-settings-store.ts'
import { QODER_CN_CARD, QODER_GLOBAL_CARD } from '../src/client/QoderPluginCard.tsx'

/**
 * Regression tests for the browser-half defect list, carried over from the
 * WorkBuddy era and re-pinned against the Qoder components. Each case names a
 * behaviour that was once broken and must never break again: unreadable bodies
 * never enter state, a failed read annotates the document instead of erasing
 * it, the poll parks only on a real sign-out, and the composer control reports
 * what the host knows rather than what the last click happened to see.
 *
 * Driven through react-test-renderer with an in-process fetch; no request
 * leaves the process.
 */

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

const NOTICE = en.statusRefreshFailed.split('{message}')[0]!

interface Reply {
  ok?: boolean
  status?: number
  body?: unknown
  /** A 200 whose body is not JSON at all (a proxy page, an HTML fallback). */
  invalidJson?: true
  /** Reject the fetch itself, the way a dead socket does. */
  reject?: boolean
}
type Step = Reply | { hang: true }

const calls: { url: string, init: RequestInit | undefined }[] = []
const hung = new Map<number, (reply: Reply) => void>()
let statusReply: Step = { ok: true, body: {} }
let writeReply: Step = { ok: true, body: {} }
let plan: ((url: string, init: RequestInit | undefined, index: number) => Step) | undefined

const intervals = new Map<number, () => void>()
const clearedHandles: number[] = []
const focusListeners = new Set<() => void>()
let nextHandle = 1

function makeResponse(reply: Reply): Response {
  const ok = reply.ok ?? true
  return {
    ok,
    status: reply.status ?? (ok ? 200 : 500),
    json: async () => {
      if (reply.invalidJson === true) throw new SyntaxError('Unexpected token < in JSON at position 0')
      return reply.body
    },
  } as unknown as Response
}

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const index = calls.length
    calls.push({ url: String(input), init })
    const step = plan?.(String(input), init, index)
      ?? (init?.method === 'POST' ? writeReply : statusReply)
    if ('hang' in step) {
      return await new Promise<Response>(resolve => {
        hung.set(index, reply => { resolve(makeResponse(reply)) })
      })
    }
    if (step.reject === true) throw new Error('socket died')
    return makeResponse(step)
  }))
}

function stubWindow(): void {
  vi.stubGlobal('window', {
    setInterval: (handler: () => void) => {
      const handle = nextHandle++
      intervals.set(handle, handler)
      return handle
    },
    clearInterval: (handle: number) => {
      clearedHandles.push(handle)
      intervals.delete(handle)
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'focus') focusListeners.add(listener)
    },
    removeEventListener: (type: string, listener: () => void) => {
      focusListeners.delete(listener)
    },
  })
}

async function release(index: number, reply: Reply): Promise<void> {
  const resolve = hung.get(index)
  if (resolve === undefined) throw new Error(`no request held open at index ${index}`)
  hung.delete(index)
  await act(async () => { resolve(reply) })
}

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    pat: { source: 'card', savedAtMs: 1_700_000_000_000, patTail: 'wxyz' },
    probeKey: 'probe-key',
    authKey: 'auth-key',
    credits: { total: 10, totalSize: 100, accounts: [{ packageName: '个人额度', remain: 90, size: 100 }] },
    probe: { consent: true, running: false, candidates: ['hy3'], results: [] },
    ...overrides,
  }
}

let view: ReactTestRenderer | undefined

/**
 * The shared status store is module state that outlives a test, and an
 * expanding card no longer re-reads a document that is still fresh — so each
 * test starts the clock well past the card's minute. A publish inside the
 * test then lands at the current time and stays fresh, which is what the
 * dedup assertions read.
 */
let clock = Date.parse('2024-05-01T00:00:00.000Z')

async function mountCard(): Promise<void> {
  const props = { t } as unknown as Parameters<typeof QoderPluginCard>[0]
  await act(async () => { view = create(createElement(QoderPluginCard, props)) })
  await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
}

const pressCard = async (label: string, nth = 0): Promise<void> => {
  const matches = view!.root.findAllByType('button').filter(entry => entry.children.join('') === label)
  const node = matches[nth]
  if (node === undefined) throw new Error(`no button "${label}"`)
  await act(async () => { node.props.onClick() })
}

beforeEach(() => {
  clock += 10 * 60_000
  vi.useFakeTimers()
  vi.setSystemTime(clock)
  calls.length = 0
  hung.clear()
  intervals.clear()
  clearedHandles.length = 0
  focusListeners.clear()
  nextHandle = 1
  plan = undefined
  statusReply = { ok: true, body: doc() }
  writeReply = { ok: true, body: { state: 'ok' } }
  stubFetch()
  stubWindow()
})

afterEach(() => {
  act(() => view?.unmount())
  // The shared store outlives a test: drop its documents and demand so the
  // next mount reads its own answer.
  resetQuotaStatusForTesting()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('QoderPluginCard', () => {
  describe('#1 unreadable status bodies', () => {
    it('renders an error state for a 200 whose body is literal null, without throwing', async () => {
      statusReply = { ok: true, body: null }
      await mountCard()
      const tree = JSON.stringify(view!.toJSON())
      expect(tree).toContain(en.statusResponseInvalid)
      expect(tree).toContain(en.requestFailed)
    })

    it('renders an error state for a 200 whose body is not JSON, without throwing', async () => {
      statusReply = { ok: true, invalidJson: true }
      await mountCard()
      expect(JSON.stringify(view!.toJSON())).toContain(en.statusResponseInvalid)
    })

    it('never stores an unreadable body over a document already on screen', async () => {
      await mountCard()
      statusReply = { ok: true, body: null }
      await pressCard(en.refresh)
      const tree = JSON.stringify(view!.toJSON())
      expect(tree).toContain(en.signedIn)
      expect(tree).toContain(NOTICE)
      expect(tree).toContain(en.statusResponseInvalid)
    })
  })

  describe('#3 a failed read must not discard the document', () => {
    it('keeps every rendered value and adds the notice after a failed tick', async () => {
      await mountCard()
      const before = JSON.stringify(view!.toJSON())
      statusReply = { reject: true }
      await act(async () => { [...intervals.values()][0]!() }) // the 60s poll fires
      const after = JSON.stringify(view!.toJSON())
      expect(after).toContain(NOTICE)
      expect(after).toContain(en.signedIn)
      expect(before).toContain('wxyz') // the PAT tail was on screen before…
      expect(after).toContain('wxyz') // …and is still on screen after
    })

    it('clears the notice after the next successful read', async () => {
      await mountCard()
      statusReply = { reject: true }
      await act(async () => { [...intervals.values()][0]!() })
      expect(JSON.stringify(view!.toJSON())).toContain(NOTICE)
      statusReply = { ok: true, body: doc() }
      await act(async () => { [...intervals.values()][0]!() })
      expect(JSON.stringify(view!.toJSON())).not.toContain(NOTICE)
    })

    it('keeps the poll armed after a failed tick and recovers without a manual click', async () => {
      await mountCard()
      const handle = [...intervals.keys()][0]!
      statusReply = { reject: true }
      await act(async () => { intervals.get(handle)!() })
      expect(clearedHandles).not.toContain(handle) // the interval survived the failure
      statusReply = { ok: true, body: doc({ credits: { total: 99, accounts: [] } }) }
      await act(async () => { intervals.get(handle)!() })
      expect(JSON.stringify(view!.toJSON())).toContain(t('creditsUsed', { percent: '99' }))
    })

    it('parks the poll when the upstream answers signed-out', async () => {
      // The shared ticker owns the poll now, so "stopping" is per variant:
      // once the document says signed-out, the next tick reads nothing — the
      // card's demand stays, and a saved PAT's explicit read revives it.
      await mountCard()
      const readsBefore = calls.length
      statusReply = { ok: true, body: { status: 'signed-out' } }
      await act(async () => { [...intervals.values()][0]!() })
      expect(JSON.stringify(view!.toJSON())).toContain(en.signedOut)

      const readsAfterSignedOut = calls.length
      await act(async () => { [...intervals.values()][0]!() })
      expect(calls.length).toBe(readsAfterSignedOut) // parked: no further read
      expect(readsAfterSignedOut).toBeGreaterThan(readsBefore) // the parked read itself happened

      // Unmounting the last holder stops the shared ticker.
      act(() => view?.unmount())
      expect(clearedHandles.length).toBeGreaterThan(0)
    })
  })

  describe('#4 unknown package size', () => {
    it('states the remaining share as unknown instead of a fabricated 100%', async () => {
      statusReply = { ok: true, body: doc({
        credits: { total: 0, accounts: [{ packageName: 'Mystery', remain: 12, size: 0 }] },
      }) }
      await mountCard()
      await pressCard(en.tabDetails)
      const tree = JSON.stringify(view!.toJSON())
      expect(tree).toContain(en.percentUnknown)
      expect(tree).toContain(t('creditPackageUnknownSize', { remain: '12' }))
    })

    it('draws no fill and announces no numeric value when the size is unknown', async () => {
      statusReply = { ok: true, body: doc({
        credits: { total: 0, accounts: [{ packageName: 'Mystery', remain: 12, size: 0 }] },
      }) }
      await mountCard()
      await pressCard(en.tabDetails)
      const bar = view!.root.findAll(node => (node.props as { role?: string }).role === 'progressbar')[0]
      expect(bar).toBeDefined()
      expect(bar!.props['aria-valuenow']).toBeUndefined()
      expect(bar!.props['aria-valuemin']).toBeUndefined()
      expect(bar!.props['aria-valuetext']).toBe(t('creditPackageUnknownSize', { remain: '12' }))
      expect(bar!.children).toHaveLength(0) // no fill element
    })
  })

  describe('#5 before the first response', () => {
    it('shows the loading label, a pending live region and no signed-out claim', async () => {
      statusReply = { hang: true }
      await mountCard()
      const tree = JSON.stringify(view!.toJSON())
      expect(tree).toContain(en.loading)
      expect(tree).not.toContain(en.signedOut)
      const live = view!.root.findAll(node => (node.props as { role?: string }).role === 'status')[0]
      expect(live!.props['aria-busy']).toBe(true)
      await release(0, { ok: true, body: doc() })
      expect(JSON.stringify(view!.toJSON())).toContain(en.signedIn)
    })
  })

  describe('#6 no sequence guard on reads', () => {
    it('keeps the document whose read started last, even when it settles first', async () => {
      // Read #1 (mount) settles; read #2 (manual refresh) is held; read #3
      // (poll) settles first with a newer answer; releasing #2 must not roll
      // the card back to its older document.
      plan = (_url, _init, index) => index === 1 ? { hang: true } : { ok: true, body: doc({
        credits: { total: index === 2 ? 7 : 77, accounts: [] },
      }) }
      await mountCard()
      await pressCard(en.refresh) // read #2, held
      await act(async () => { [...intervals.values()][0]!() }) // read #3, lands first
      expect(JSON.stringify(view!.toJSON())).toContain(t('creditsUsed', { percent: '7' }))
      await release(1, { ok: true, body: doc({ credits: { total: 77, accounts: [] } }) })
      expect(JSON.stringify(view!.toJSON())).toContain(t('creditsUsed', { percent: '7' }))
    })

    it('drops a superseded failure silently instead of blanking the card', async () => {
      plan = (_url, _init, index) => index === 1 ? { hang: true } : { ok: true, body: doc() }
      await mountCard()
      await pressCard(en.refresh) // read #2, held
      await act(async () => { [...intervals.values()][0]!() }) // read #3 supersedes it
      // The late answer is a failure (an unreadable body); the sequence guard
      // must swallow it without a notice and without touching the document.
      await release(1, { ok: true, body: null })
      expect(JSON.stringify(view!.toJSON())).not.toContain(NOTICE)
      expect(JSON.stringify(view!.toJSON())).toContain(en.signedIn)
    })
  })

  describe('#11 a failed write reports beside the document', () => {
    /**
     * Mount with the Global variant so the context-window preference write
     * exists, and with a model that declares a larger alternative so the
     * preference checkbox renders.
     */
    async function mountGlobal(): Promise<void> {
      statusReply = { ok: true, body: doc({
        models: [{ id: 'm1', name: 'M1', contextWindow: 200_000, supportedContextWindows: [200_000, 1_000_000] }],
      }) }
      const props = { t, variant: QODER_GLOBAL_CARD } as unknown as Parameters<typeof QoderPluginCard>[0]
      await act(async () => { view = create(createElement(QoderPluginCard, props)) })
      await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
      await pressCard(en.tabContext)
    }
    /** Fire the preference checkbox, the smallest write the card offers. */
    async function firePreferenceWrite(): Promise<void> {
      const checkbox = view!.root.findAllByType('input').find(node => node.props.type === 'checkbox')!
      await act(async () => { checkbox.props.onChange({ currentTarget: { checked: true } }) })
    }

    it('keeps the account and credits on screen when the write is rejected', async () => {
      await mountGlobal()
      writeReply = { ok: false, status: 403, body: { error: 'invalid-auth-key' } }
      await firePreferenceWrite()
      const tree = JSON.stringify(view!.toJSON())
      expect(tree).toContain(NOTICE)
      expect(tree).toContain(en.signedIn)
      expect(tree).toContain('invalid-auth-key') // the reason survives the round trip
    })

    it('clears the notice after a good read follows the failed write', async () => {
      await mountGlobal()
      writeReply = { ok: false, status: 403, body: { error: 'invalid-auth-key' } }
      await firePreferenceWrite()
      expect(JSON.stringify(view!.toJSON())).toContain(NOTICE)
      writeReply = { ok: true, body: { state: 'updated' } }
      await pressCard(en.refresh)
      expect(JSON.stringify(view!.toJSON())).not.toContain(NOTICE)
    })
  })
})

describe('QoderProbeControl', () => {
  // The control resolves the session selection through a model directory; the
  // smallest honest stand-in is the store surface it actually consumes.
  function directoryFor(provider: string, model: string) {
    const snapshot = { current: { provider, model } }
    return {
      subscribe: (_listener: () => void) => () => {},
      getSnapshot: () => snapshot,
    }
  }

  async function mountControl(model = 'hy3'): Promise<void> {
    const props = { t, directory: directoryFor('qoder', model) } as unknown as Parameters<typeof QoderProbeControl>[0]
    await act(async () => { view = create(createElement(QoderProbeControl, props)) })
  }

  const controlButton = () => view!.root.findAllByType('button')[0]!
  const hoverTooltip = async (): Promise<string> => {
    await act(async () => { view!.root.findByType('span').props.onMouseEnter() })
    const tip = view!.root.findAll(node => (node.props as { role?: string }).role === 'tooltip')[0]
    const text = tip === undefined ? '' : tip.children.join('')
    await act(async () => { view!.root.findByType('span').props.onMouseLeave() })
    return text
  }

  it('hides itself for a non-Qoder selection', async () => {
    const props = { t, directory: directoryFor('deepseek', 'dsv4') } as unknown as Parameters<typeof QoderProbeControl>[0]
    await act(async () => { view = create(createElement(QoderProbeControl, props)) })
    expect(view!.toJSON()).toBeNull()
  })

  it('#2 survives a status body of literal null without tearing the control down', async () => {
    statusReply = { ok: true, body: null }
    await mountControl()
    // The seat stays alive; with no document the control simply has no result
    // to show, and the candidate list never said anything either.
    expect(JSON.stringify(view!.toJSON())).not.toContain('crash')
    const tree = JSON.stringify(view!.toJSON())
    // hy3 is not advertised as a candidate by any document, so nothing renders
    // — and crucially, nothing threw on the way here.
    expect(tree === 'null' || tree.includes(en.probeLabel)).toBe(true)
  })

  it('#2 recovers on the next readable document', async () => {
    statusReply = { ok: true, body: null }
    await mountControl()
    statusReply = { ok: true, body: doc() }
    await act(async () => { [...focusListeners][0]!() }) // a window focus re-reads
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeLabel)
  })

  it('keeps the entry visible for a model that left the candidate list after detection', async () => {
    statusReply = { ok: true, body: doc({
      probe: { consent: true, running: false, candidates: [], results: [
        { id: 'hy3', name: 'hy3', validation: 'validating', efforts: ['low', 'high'], probedAt: 1 },
      ] },
    }) }
    await mountControl()
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeLabel)
    expect(await hoverTooltip()).toBe(t('probeTooltipVerified', { levels: 'low / high' }))
  })

  describe('#7 tooltip precedence order', () => {
    it('ranks busy above a recorded result', async () => {
      statusReply = { ok: true, body: doc({
        probe: { consent: true, running: false, candidates: ['hy3'], results: [
          { id: 'hy3', name: 'hy3', validation: 'validating', efforts: ['low'], probedAt: 1 },
        ] },
      }) }
      writeReply = { hang: true } as never
      await mountControl()
      // Open the confirmation and detect; the POST is held so busy is observable.
      await act(async () => { controlButton().props.onClick() })
      const confirm = view!.root.findAllByType('button').find(node => node.children.join('') === en.probeConfirmAction)!
      await act(async () => { confirm.props.onClick() })
      expect(controlButton().props['aria-busy']).toBe(true)
      expect(await hoverTooltip()).toBe(t('probeRunning', { model: 'hy3' }))
      // The host has now recorded the fuller result the sweep produced; the
      // control's follow-up read is what puts it in the document.
      statusReply = { ok: true, body: doc({
        probe: { consent: true, running: false, candidates: ['hy3'], results: [
          { id: 'hy3', name: 'hy3', validation: 'validating', efforts: ['low', 'high'], probedAt: 1 },
        ] },
      }) }
      await release(calls.length - 1, { ok: true, body: { state: 'ok', validation: 'validating', efforts: ['low', 'high'] } })
      // The completed run opens a result note; dismissing it must hand the
      // answer back to the stored result, never to a stale failure.
      expect(JSON.stringify(view!.toJSON())).toContain(t('probeNoteVerified', { levels: 'low / high' }))
      const dismiss = view!.root.findAllByType('button').find(node => node.children.join('') === en.probeNoteDismiss)!
      await act(async () => { dismiss.props.onClick() })
      expect(await hoverTooltip()).toBe(t('probeTooltipVerified', { levels: 'low / high' }))
    })

    it('ranks a recorded result above a remembered failure', async () => {
      // First: a failing POST sets the failed flag with no result present.
      writeReply = { ok: false, status: 500, body: {} }
      await mountControl()
      await act(async () => { controlButton().props.onClick() })
      const confirm = view!.root.findAllByType('button').find(node => node.children.join('') === en.probeConfirmAction)!
      await act(async () => { confirm.props.onClick() })
      expect(await hoverTooltip()).toBe(en.probeTooltipRetry)
      // Then: the host records a result (a card-side detection landing).
      writeReply = { ok: true, body: { state: 'ok' } }
      statusReply = { ok: true, body: doc({
        probe: { consent: true, running: false, candidates: ['hy3'], results: [
          { id: 'hy3', name: 'hy3', validation: 'non-validating', efforts: [], probedAt: 1 },
        ] },
      }) }
      await act(async () => { [...focusListeners][0]!() })
      expect(await hoverTooltip()).toBe(en.probeTooltipNotValidating)
    })

    it('keeps the failure copy for a failure with no result, and the idle copy for neither', async () => {
      await mountControl()
      expect(await hoverTooltip()).toBe(t('probeTooltipIdle', { model: 'hy3' }))
      writeReply = { reject: true } as never
      await act(async () => { controlButton().props.onClick() })
      const confirm = view!.root.findAllByType('button').find(node => node.children.join('') === en.probeConfirmAction)!
      await act(async () => { confirm.props.onClick() })
      expect(await hoverTooltip()).toBe(en.probeTooltipRetry)
    })
  })
})

describe('#8 fallback catalog identity', () => {
  it('gives every fallback row a distinct id and a display name', () => {
    const ids = FALLBACK_QODER_MODELS.map(model => model.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const model of FALLBACK_QODER_MODELS) {
      expect(model.name.length).toBeGreaterThan(0)
      expect(model.contextWindow).toBeGreaterThan(0)
      expect(model.maxTokens).toBeGreaterThan(0)
    }
    // The routes both cards call match the compiled-in roster's ids exactly —
    // a model id in the card but not the roster would 400 on the first chat.
    expect(ids).toEqual(['cmodel', 'auto', 'ultimate', 'performance', 'efficient', 'lite'])
    void QODER_CN_CARD
  })
})
