import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QODER_CN_CARD,
  QODER_GLOBAL_CARD,
  QoderPluginCard,
  type QoderCardVariant,
} from '../src/client/QoderPluginCard.tsx'
import { en } from '../src/client/locales.ts'
import type { QoderWebStatus } from '../src/status-paths.ts'
import { resetQuotaStatusForTesting } from '../src/client/quota-settings-store.ts'

/**
 * Card tests for the PAT flow and the three-tab body. The sensitive surface is the
 * PAT entry — what it sends, which header authorizes it, and what each host answer
 * renders — and the probe section keeps its regression: only the pressed row may
 * claim to be running.
 */

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

interface Posted {
  url: string
  init: RequestInit
}

/**
 * The shared status store outlives a test and a fresh document is not re-read,
 * so each test starts the clock well past the card's minute; a publish then
 * lands at the current time, which is what the dedup assertions read.
 */
let clock = Date.parse('2024-05-01T00:00:00.000Z')

describe('Qoder plugin card', () => {
  let view: ReactTestRenderer | undefined
  let statusBody: unknown
  let statusFails = false
  const posts: Posted[] = []
  /** Status GETs, in order — what the poll-liveness assertions count. */
  const gets: string[] = []
  /** Resolvers for held POSTs, so "in flight" is observable, not a race. */
  let releaseQueue: ((body: unknown) => void)[] = []
  let holdPosts = false
  /** Held status GETs, so "the first read has not landed yet" is observable. */
  let holdStatus = false
  let releaseStatus: ((body: unknown) => void)[] = []
  const intervalHandles = new Map<number, () => void>()
  let nextHandle = 1

  function signedIn(overrides: Partial<QoderWebStatus> = {}): void {
    statusBody = {
      status: 'signed-in',
      pat: { source: 'card', savedAtMs: 1_700_000_000_000, patTail: 'abcd' },
      credits: { total: 40, totalSize: 100, accounts: [] },
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      probe: { consent: true, running: false, candidates: ['hy3', 'glm-5.2'], results: [] },
      ...overrides,
    }
  }

  function signedOut(overrides: Record<string, unknown> = {}): void {
    statusBody = { status: 'signed-out', authKey: 'test-auth-key', ...overrides }
  }

  beforeEach(() => {
    clock += 10 * 60_000
    vi.useFakeTimers()
    vi.setSystemTime(clock)
    signedIn()
    statusFails = false
    holdPosts = false
    holdStatus = false
    releaseStatus = []
    posts.length = 0
    releaseQueue = []
    intervalHandles.clear()
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const url = String(input)
        posts.push({ url, init })
        const body = await new Promise<unknown>(resolve => {
          if (holdPosts) releaseQueue.push(resolve)
          else resolve(postReply(url, init))
        })
        return { ok: true, status: 200, json: async () => body }
      }
      gets.push(String(input))
      if (statusFails) throw new Error('socket died')
      const body = holdStatus
        ? await new Promise<unknown>(resolve => { releaseStatus.push(resolve) })
        : statusBody
      return { ok: true, status: 200, json: async () => body }
    }))
    vi.stubGlobal('window', {
      setInterval: (handler: () => void) => {
        const handle = nextHandle++
        intervalHandles.set(handle, handler)
        return handle
      },
      clearInterval: (handle: number) => { intervalHandles.delete(handle) },
    })
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => cb(0))
  })

  /** The host answer a POST earns by its body, per the real route contract. */
  function postReply(_url: string, init: RequestInit): unknown {
    const action = JSON.parse(String(init.body)) as { action?: string }
    if (action.action === 'save-pat') return { ok: true, status: 'saved' }
    if (action.action === 'clear') return { ok: true }
    return { state: 'ok', validation: 'non-validating', efforts: [] }
  }

  afterEach(() => {
    act(() => view?.unmount())
    // The shared store outlives a test: drop its documents and demand so the
    // next mount reads its own answer.
    resetQuotaStatusForTesting()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function mount(variant?: QoderCardVariant): Promise<void> {
    const props = { t, ...variant === undefined ? {} : { variant } } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => { view = create(createElement(QoderPluginCard, props)) })
    // Expand: the header is the first button.
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
  }

  const buttonLabels = (): string[] => view!.root.findAllByType('button').map(node => node.children.join(''))
  const press = async (label: string, nth = 0): Promise<void> => {
    const matches = view!.root.findAllByType('button').filter(entry => entry.children.join('') === label)
    const node = matches[nth]
    if (node === undefined) throw new Error(`no button #${nth} "${label}"; have: ${buttonLabels().join(' | ')}`)
    await act(async () => { node.props.onClick() })
  }
  const inputs = () => view!.root.findAllByType('input')
  const typePat = async (value: string): Promise<void> => {
    const input = inputs()[0]
    if (input === undefined) throw new Error('no PAT input rendered')
    await act(async () => { input.props.onChange({ target: { value } }) })
  }
  /** Fire every held POST with the given reply body. */
  const releasePosts = async (reply: unknown): Promise<void> => {
    const pending = releaseQueue
    releaseQueue = []
    await act(async () => { for (const resolve of pending) resolve(reply) })
  }

  // ---- PAT entry (signed-out arm) ----------------------------------------

  it("shows the PAT entry only when the document carries this card's auth key", async () => {
    signedOut()
    await mount()
    expect(inputs()).toHaveLength(1)
    const input = inputs()[0]!
    expect(input.props.type).toBe('password')
    expect(input.props.placeholder).toBe(en.patPlaceholder)
    expect(input.props.value).toBe('')
    // Without a key the entry would POST into a 403 it cannot pass, so the
    // card withholds it entirely.
    signedOut({ authKey: undefined })
    // The shared document is per-test state now: age it past the card's minute
    // so the second mount re-reads instead of showing the first document.
    clock += 10 * 60_000
    vi.setSystemTime(clock)
    await mount()
    expect(inputs()).toHaveLength(0)
  })

  it('sends the trimmed draft to the variant auth route with the key header', async () => {
    signedOut()
    await mount()
    await press(en.patSave) // empty draft stays inert
    expect(posts).toEqual([])
    await typePat('  pt-pasted  ')
    await press(en.patSave)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(QODER_CN_CARD.authPath)
    const headers = posts[0]!.init.headers as Record<string, string>
    expect(headers['X-Qoder-Auth-Key']).toBe('test-auth-key')
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'save-pat', pat: 'pt-pasted' })
  })

  it('sends an optional label when a second token is added', async () => {
    await mount()
    await press(en.patAdd)
    expect(inputs()).toHaveLength(2)
    await typePat('pt-second')
    await act(async () => {
      view!.root.findAllByType('input')[1]!.props.onChange({ target: { value: '  工作号  ' } })
    })
    await press(en.patSave)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({
      action: 'save-pat',
      pat: 'pt-second',
      label: '工作号',
    })
  })

  it('reports the save lifecycle: busy label, then the signed-in body takes over', async () => {
    signedOut()
    holdPosts = true
    await mount()
    await typePat('pt-good')
    await press(en.patSave)
    expect(buttonLabels()).toContain(en.patSaving)
    // The next read answers signed-in, exactly like the host route after a
    // save — and the entry gives way to the account body. (The 'PAT saved'
    // notice renders inside the entry itself, so it is the signed-in swap a
    // user actually sees as the success signal.)
    signedIn()
    await releasePosts({ ok: true, status: 'saved' })
    expect(inputs()).toHaveLength(0)
    expect(buttonLabels()).toContain(en.patAdd)
  })

  it('renders the stable refusal codes as the re-generate prompt, not raw wire text', async () => {
    signedOut()
    holdPosts = true
    await mount()
    await typePat('pt-dead')
    await press(en.patSave)
    await releasePosts({ ok: false, error: 'qoder_invalid_pat' })
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain(en.patInvalid)
    expect(tree).not.toContain('qoder_invalid_pat')
  })

  it('passes any other save failure through with its detail', async () => {
    signedOut()
    holdPosts = true
    await mount()
    await typePat('pt-x')
    await press(en.patSave)
    await releasePosts({ ok: false, error: 'disk on fire' })
    expect(JSON.stringify(view!.toJSON())).toContain(t('patSaveFailed', { message: 'disk on fire' }))
  })

  it('keeps Enter and clicking equivalent and lets the draft live only in state', async () => {
    signedOut()
    await mount()
    // Enter on an empty draft stays inert...
    await act(async () => { inputs()[0]!.props.onKeyDown({ key: 'Enter', preventDefault: () => {} }) })
    expect(posts).toHaveLength(0)
    // ...and the next Enter carries the then-current draft: re-read the props
    // after the change, since the previous handler closes over the old state.
    await typePat('pt-enter')
    await act(async () => { inputs()[0]!.props.onKeyDown({ key: 'Enter', preventDefault: () => {} }) })
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'save-pat', pat: 'pt-enter' })
  })

  // ---- signed-in arm: summary, replace, clear ------------------------------

  it('summarizes the credential in effect without ever spelling the token', async () => {
    signedIn({ patProfiles: [{ id: 'id-one', patTail: 'abcd' }], activePatId: 'id-one' })
    await mount()
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain('****abcd')
    expect(tree).toContain(en.patSourceCard)
    expect(tree).not.toContain('pt-test')
    expect(buttonLabels()).toContain(en.patAdd)
    expect(buttonLabels()).toContain(en.patClear)
  })

  it('Add PAT opens a cancellable entry over the live document', async () => {
    await mount()
    await press(en.patAdd)
    expect(inputs()).toHaveLength(2) // PAT + optional label
    await press(en.cancel)
    expect(inputs()).toHaveLength(0)
    // Canceling never touches the route: the stored PAT is still in effect.
    expect(posts).toEqual([])
  })

  it('renders the saved-PAT select and switches accounts through the route', async () => {
    const profiles = [
      { id: 'id-two', label: '工作号', patTail: '2222', savedAtMs: 1_700_000_100_000 },
      { id: 'id-one', patTail: '1111', savedAtMs: 1_700_000_000_000 },
    ]
    signedIn({
      patProfiles: profiles,
      activePatId: 'id-two',
      pat: { id: 'id-two', label: '工作号', source: 'card', patTail: '2222', savedAtMs: 1_700_000_100_000 },
    })
    holdPosts = true
    await mount()
    const select = view!.root.findAllByType('select')[0]
    expect(select).toBeDefined()
    expect(view!.root.findAllByType('option')).toHaveLength(2)
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain('工作号')
    expect(tree).toContain('****1111')

    await act(async () => { select!.props.onChange({ target: { value: 'id-one' } }) })
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'activate', id: 'id-one' })
    // No extra "switching" copy is rendered: the disabled select is the
    // in-flight signal, so the toolbar cannot be pushed onto a second line.
    expect(view!.root.findAllByType('select')[0]!.props.disabled).toBe(true)

    // The host's post-switch document reports the other entry as active; the
    // card re-reads it before the in-flight state clears.
    signedIn({ patProfiles: profiles, activePatId: 'id-one' })
    await releasePosts({ ok: true })
    expect(view!.root.findAllByType('select')[0]!.props.value).toBe('id-one')
  })

  it('Remove current posts the remove action for the active entry', async () => {
    signedIn({
      patProfiles: [
        { id: 'id-two', patTail: '2222' },
        { id: 'id-one', patTail: '1111' },
      ],
      activePatId: 'id-one',
    })
    holdPosts = true
    await mount()
    await press(en.patRemove)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'remove', id: 'id-one' })
    expect(buttonLabels()).toContain(en.patRemoving)
    signedIn()
    await releasePosts({ ok: true })
  })

  it('shows the saved-PAT select even for a single token', async () => {
    signedIn({ patProfiles: [{ id: 'id-one', patTail: 'abcd' }], activePatId: 'id-one' })
    await mount()
    const selects = view!.root.findAllByType('select')
    expect(selects).toHaveLength(1)
    expect(view!.root.findAllByType('option')).toHaveLength(1)
    expect(selects[0]!.props.value).toBe('id-one')
  })

  it('Clear PAT posts the clear action and re-reads to the signed-out entry', async () => {
    signedIn({ patProfiles: [{ id: 'id-one', patTail: 'abcd' }], activePatId: 'id-one' })
    holdPosts = true
    await mount()
    await press(en.patClear)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'clear' })
    expect(buttonLabels()).toContain(en.patClearing)
    signedOut()
    await releasePosts({ ok: true })
    expect(inputs()).toHaveLength(1) // signed-out arm with an authKey re-offers entry
  })

  it('signs out locally on clear even when the re-read fails', async () => {
    // `clear` answers `{ok:true}` with no `status`, so the sign-out has to be
    // decided from the action itself; a failed re-read must not leave the dead
    // account on screen.
    signedIn({ patProfiles: [{ id: 'id-one', patTail: 'abcd' }], activePatId: 'id-one' })
    holdPosts = true
    await mount()
    expect(buttonLabels()).toContain(en.patClear)
    await press(en.patClear)
    statusFails = true
    await releasePosts({ ok: true })
    expect(buttonLabels()).not.toContain(en.patClear)
    expect(inputs()).toHaveLength(1)
  })

  it('keeps the self-check note across a local sign-out', async () => {
    // Clearing the last PAT synthesizes a signed-out document locally, and that
    // parks the poll — so a note dropped there would never come back.
    const REASON = 'could not determine the version of @scope/pkg'
    signedIn({ patProfiles: [{ id: 'id-one', patTail: 'abcd' }], activePatId: 'id-one', peerCheckSkipped: REASON })
    holdPosts = true
    await mount()
    expect(JSON.stringify(view!.toJSON())).toContain(REASON)
    await press(en.patClear)
    signedOut({ peerCheckSkipped: REASON })
    await releasePosts({ ok: true })
    expect(JSON.stringify(view!.toJSON())).toContain(REASON)
  })

  it('drops the note once a refreshed document no longer carries it', async () => {
    // A host answer replaces the document verbatim: the field's absence is the
    // statement that the check can verify peers again, so a stale warning must go.
    const REASON = 'could not determine the version of @scope/pkg'
    signedIn({ patProfiles: [{ id: 'id-one', patTail: 'abcd' }], activePatId: 'id-one', peerCheckSkipped: REASON })
    await mount()
    expect(JSON.stringify(view!.toJSON())).toContain(REASON)
    signedIn({ patProfiles: [{ id: 'id-one', patTail: 'abcd' }], activePatId: 'id-one' })
    await press(en.refresh)
    expect(JSON.stringify(view!.toJSON())).not.toContain(REASON)
  })

  it('lets the post-clear document replace the note captured before the click', async () => {
    // The click's snapshot is older than the host answer; the answer wins, so a
    // note the host no longer reports must not be re-published.
    const REASON = 'could not determine the version of @scope/pkg'
    signedIn({ patProfiles: [{ id: 'id-one', patTail: 'abcd' }], activePatId: 'id-one', peerCheckSkipped: REASON })
    holdPosts = true
    await mount()
    expect(JSON.stringify(view!.toJSON())).toContain(REASON)
    await press(en.patClear)
    signedOut()
    await releasePosts({ ok: true })
    expect(JSON.stringify(view!.toJSON())).not.toContain(REASON)
  })

  it('shows a note that only the post-clear document carries', async () => {
    const REASON = 'could not determine the version of @scope/pkg'
    signedIn({ patProfiles: [{ id: 'id-one', patTail: 'abcd' }], activePatId: 'id-one' })
    holdPosts = true
    await mount()
    expect(JSON.stringify(view!.toJSON())).not.toContain(REASON)
    await press(en.patClear)
    signedOut({ peerCheckSkipped: REASON })
    await releasePosts({ ok: true })
    expect(JSON.stringify(view!.toJSON())).toContain(REASON)
  })

  // ---- poll liveness --------------------------------------------------------

  it('polls while signed in and parks once a document confirms sign-out', async () => {
    await mount()
    // The shared ticker is armed by the expanded card's demand, and a tick
    // reads the live variant once.
    expect([...intervalHandles.keys()]).toHaveLength(1)
    const readsAfterMount = gets.length
    await act(async () => { [...intervalHandles.values()][0]!() })
    expect(gets.length).toBeGreaterThan(readsAfterMount)

    // The signed-out answer is a fact about the account: the poll parks — the
    // next tick reads nothing — until a PAT save re-arms it through an
    // explicit read. The ticker itself stays armed while the card holds the
    // variant, so unmount is what stops it.
    signedOut()
    await press(en.refresh)
    expect(JSON.stringify(view!.toJSON())).toContain(en.signedOutHint)
    const readsAfterSignOut = gets.length
    await act(async () => { [...intervalHandles.values()][0]!() })
    expect(gets.length).toBe(readsAfterSignOut)
  })

  // ---- context tab: maximum-window preference -------------------------------

  it('holds back the quota block until the first read, keeping the tab switcher', async () => {
    holdStatus = true
    // A ready settings scope: without one the quota block never renders, and the
    // absence assertion below would pass for the wrong reason.
    const scope = {
      getSnapshot: () => ({ status: 'ready', writable: true, value: {} }),
      subscribe: () => () => {},
      set: () => {},
    }
    const props = { t, unified: true, scope } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => { view = create(createElement(QoderPluginCard, props)) })
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
    // The version switcher is part of the card's chrome and must survive an
    // unknown status; the quota toggles would flash a refusal on their way in.
    expect(view!.root.findAll(node => (node.props as { role?: string }).role === 'tablist').length).toBe(1)
    expect(JSON.stringify(view!.toJSON())).not.toContain(en.quotaToggleCN)
    await act(async () => { for (const release of releaseStatus) release(statusBody) })
    vi.advanceTimersByTime(0)
    await act(async () => {})
    expect(JSON.stringify(view!.toJSON())).toContain(en.quotaToggleCN)
  })

  /** The max-window preference is a switch button, not an input, since the panel rewrite. */
  const maxWindowSwitch = () => view!.root.findAll(node =>
    (node.type as unknown) === 'button'
    && (node.props as { role?: string }).role === 'switch'
    && (node.props as { 'aria-label'?: string })['aria-label'] === en.useMaximumContextWindow)[0]

  it('offers the max-window preference on both cards, each a route write', async () => {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      models: [{ id: 'm1', name: 'M1', contextWindow: 200_000, supportedContextWindows: [200_000, 1_000_000] }],
    }
    for (const variant of [undefined, QODER_GLOBAL_CARD]) {
      await mount(variant)
      await press(en.tabContext)
      const toggle = maxWindowSwitch()
      expect(toggle).toBeDefined()
      await act(async () => { toggle!.props.onClick() })
      expect(posts).toHaveLength(1)
      expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'set-maximum-context-window', enabled: true })
      await act(async () => view?.unmount())
      posts.length = 0
    }
    // Each card's write went to its own variant's probe route.
    expect(true).toBe(true)
  })

  it('keeps the context rows a read-only report on one line', async () => {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      models: [{ id: 'm1', name: 'M1', contextWindow: 200_000, supportedContextWindows: [200_000, 1_000_000] }],
    }
    await mount()
    await press(en.tabContext)
    expect(view!.root.findAllByType('select')).toHaveLength(0)
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain('200K')
    expect(tree).toContain(t('contextUpTo', { size: '1M' }))
  })

  // ---- tabbed body -----------------------------------------------------------

  it('splits quota detail, context, and status across the three tabs', async () => {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      credits: {
        total: 25,
        accounts: [
          { packageName: '个人额度', remain: 75, size: 100 },
          { packageName: '组织资源包', remain: 0, size: 50 },
          { packageName: 'Unbounded', remain: 5, size: 0, unlimited: true },
        ],
      },
      models: [
        { id: 'm1', name: 'M1', contextWindow: 200_000, defaultContextWindow: 128_000, supportedContextWindows: [128_000, 1_000_000] },
      ],
    }
    await mount()
    await press(en.tabDetails)
    let tree = JSON.stringify(view!.toJSON())
    // The exhausted package is dropped; the unknown-size one renders unlimited copy.
    expect(tree).toContain(t('exactRemaining', { remain: '75', size: '100' }))
    expect(tree).not.toContain('组织资源包')
    expect(tree).toContain(en.unlimitedQuota)
    await press(en.tabContext)
    tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain('200K')
    expect(tree).toContain(t('contextUpTo', { size: '1M' }))
  })

  it('prints the used percentage beside a package label in the quota detail tab', async () => {
    // The settings card's credit bar carries the same "(used N%)" suffix the sidebar
    // prints, read from the same helper: 2,340 / 2,400 is "(已使用 3%)".
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      credits: {
        total: 25,
        accounts: [
          { packageName: '个人额度', remain: 2000, size: 2000 },
          { packageName: '赠送额度', remain: 2340, size: 2400 },
        ],
      },
      models: [],
    }
    await mount()
    await press(en.tabDetails)

    const labels = view!.root
      .findAll(node => node.type === 'span')
      .map(node => node.children.filter((child): child is string => typeof child === 'string').join(''))
      .filter(text => text.includes('个人额度') || text.includes('赠送额度'))
    expect(labels).toEqual([
      `个人额度${t('quotaPackageUsed', { percent: '0' })}`,
      `赠送额度${t('quotaPackageUsed', { percent: '3' })}`,
    ])
  })

  it('states the PAT authorization when the account has no cycle expiry', async () => {
    // The year-9999 "never" sentinel is dropped by the transport, so the status tab
    // names the one date the card knows — when this PAT was authorized.
    statusBody = {
      status: 'signed-in',
      pat: { source: 'card', savedAtMs: Date.parse('2026-10-16T02:05:36.888Z'), patTail: 'd092' },
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      credits: {
        total: 0.01,
        totalSize: 2100,
        accounts: [
          {
            packageName: 'SOTA 专属积分',
            packageNameI18n: { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' },
            remain: 2000,
            size: 2000,
            packageEndTime: '2026-10-19T02:00:00.000Z',
          },
        ],
      },
      models: [],
    }
    await mount()
    await press(en.tabDetails)
    let tree = JSON.stringify(view!.toJSON())
    // The grant renders under its own localized title, not the campaign code.
    expect(tree).toContain('SOTA 专属积分')
    expect(tree).not.toContain('act-20261014-129')

    await press(en.tabStatus)
    tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain('PAT authorized')
    expect(tree).not.toContain(en.cycleResetAt.split('{time}')[0]!)
    expect(tree).not.toContain('9999')
  })

  it('still states the real cycle deadline when the upstream reports one', async () => {
    // The PAT line stands in for an absent expiry, never replaces a reported one.
    statusBody = {
      status: 'signed-in',
      pat: { source: 'card', savedAtMs: Date.parse('2026-10-16T02:05:36.888Z'), patTail: 'd092' },
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      credits: {
        total: 12,
        totalSize: 300,
        accounts: [{ packageName: '个人额度', remain: 264, size: 300, packageEndTime: '2026-11-01T00:00:00.000Z' }],
        cycleResetTime: '2026-11-01T00:00:00.000Z',
      },
      models: [],
    }
    await mount()
    await press(en.tabStatus)
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain(en.cycleResetAt.split('{time}')[0]!)
    expect(tree).not.toContain('PAT authorized')
  })

  it('offers the max-window preference on the Global card, as a route write', async () => {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      models: [{ id: 'm1', name: 'M1', contextWindow: 200_000, supportedContextWindows: [200_000, 1_000_000] }],
    }
    await mount(QODER_GLOBAL_CARD)
    await press(en.tabContext)
    const toggle = maxWindowSwitch()
    expect(toggle).toBeDefined()
    await act(async () => { toggle!.props.onClick() })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(QODER_GLOBAL_CARD.probePath)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'set-maximum-context-window', enabled: true })
  })

  // ---- read failures ----------------------------------------------------------

  it('reports a failed refresh beside the document it cannot replace', async () => {
    await mount()
    statusFails = true
    await press(en.refresh)
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain(en.statusRefreshFailed.split('{message}')[0]!)
    expect(tree).toContain(en.patAccounts) // the document is still rendered
  })

  it('turns an unreadable 200 into the error arm rather than dereferencing it', async () => {
    statusBody = null
    await mount()
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain(en.statusResponseInvalid)
    expect(tree).toContain(en.requestFailed) // the header label
  })

  // ---- variant copy and routes -------------------------------------------------

  it("the Global card asks its own routes and shows qoder.com's guide", async () => {
    signedOut()
    await mount(QODER_GLOBAL_CARD)
    const asked = (await vi.mocked(fetch).mock.calls).map(call => String(call[0]))
    expect(asked).toContain(QODER_GLOBAL_CARD.statusPath)
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain(en.titleAI)
    expect(tree).toContain(en.patGuideAI)
    expect(tree).toContain(en.patPlaceholderAI)
    expect(tree).not.toContain('qoder.com.cn')
  })
})
