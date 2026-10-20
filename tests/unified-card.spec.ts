import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderPluginCard, type QoderPluginCardProps } from '../src/client/QoderPluginCard.tsx'
import { QuotaSettingsContent } from '../src/client/QuotaSettingsCard.tsx'
import { QuotaDashboard, SidebarQuotaCard } from '../src/client/SidebarQuotaCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { QoderSettingsKey } from '../src/client/locales.ts'
import { noteQuotaSignIn, noteQuotaStatus, resetQuotaStatusForTesting, setQuotaToggles } from '../src/client/quota-settings-store.ts'
import { QODER_AUTH_PATH, QODER_GLOBAL_AUTH_PATH, QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from '../src/status-paths.ts'

const t = (key: QoderSettingsKey, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

/** The same bound translator over the Chinese copy, for the sidebar row's labels. */
const tZh = (key: QoderSettingsKey, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    zh[key] as string,
  )

/**
 * The shared status store is module state that outlives a test, and an
 * expanding card no longer re-reads a document that is still fresh — so each
 * test starts the clock well past the card's minute. A publish inside the
 * test then lands at the current time and stays fresh, which is what the
 * dedup assertions read.
 */
let clock = Date.parse('2024-05-01T00:00:00.000Z')

describe('Unified Qoder Plugin Card', () => {
  let view: ReactTestRenderer | undefined
  const request = vi.fn()
  const postedActions: { url: string; body: unknown }[] = []

  beforeEach(() => {
    clock += 10 * 60_000
    vi.useFakeTimers()
    vi.setSystemTime(clock)
    postedActions.length = 0
    request.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        postedActions.push({ url, body })
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      }
      const path = String(url)
      if (path === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-in',
            region: 'china',
            pat: { source: 'card', savedAtMs: 1700000000000, patTail: '1111' },
            authKey: 'cn-auth-key',
            credits: { total: 30, accounts: [] },
            models: [],
          }),
        }
      }
      if (path === QODER_GLOBAL_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-out',
            region: 'global',
            authKey: 'global-auth-key',
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => cb(0))
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    setQuotaToggles(false, false)
    noteQuotaSignIn('qoder', false)
    noteQuotaSignIn('qoder-global', false)
    // The shared store outlives a test: drop its documents and demand so the
    // next mount reads its own answer.
    resetQuotaStatusForTesting()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function mountUnified(): Promise<void> {
    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: { sidebarQuotaCN: true, sidebarQuotaGlobal: false, quotaPollMs: 300_000 },
      }),
      subscribe: () => () => {},
      set: vi.fn(),
    }
    const props = {
      t: t as QoderPluginCardProps['t'],
      unified: true,
      scope: fakeScope as any,
      signedIn: () => ({ cn: true, global: false }),
    } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => {
      view = create(createElement(QoderPluginCard, props))
    })
  }

  it('renders the unified title and intro in collapsed state', async () => {
    await mountUnified()
    const json = JSON.stringify(view!.toJSON())
    expect(json).toContain(en.unifiedTitle)
    expect(json).toContain(en.unifiedIntro)
  })

  it('expands to show quota settings at the top, followed by the segmented tabs', async () => {
    await mountUnified()
    // Click header to expand
    const headerBtn = view!.root.findAllByType('button')[0]!
    await act(async () => { headerBtn.props.onClick() })

    const json = JSON.stringify(view!.toJSON())
    // 1. Top section: Quota settings
    expect(json).toContain(en.quotaToggleCN)
    expect(json).toContain(en.quotaToggleGlobal)
    expect(json).toContain(en.quotaPollLabel)

    // 2. Segmented Tabs
    expect(json).toContain(en.variantTabCN)
    expect(json).toContain(en.variantTabGlobal)

    // 3. Default active is CN (signed-in in our mock)
    expect(json).toContain('****1111')
  })

  it('switches between China and Global tabs when clicked', async () => {
    await mountUnified()
    // Click header to expand
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })

    // Find the segmented tab buttons: China and Global
    const tabList = view!.root.find(n => n.props.role === 'tablist' && n.props['aria-label'] === 'Qoder Version Selection')
    const tabButtons = tabList.findAllByType('button')
    expect(tabButtons).toHaveLength(2)

    // Click Global tab (second tab)
    const globalTab = tabButtons[1]!
    await act(async () => { globalTab.props.onClick() })

    let json = JSON.stringify(view!.toJSON())
    // Global is signed out in mock, so it shows signed-out hint and Global PAT guide
    expect(json).toContain(en.signedOutHintAI)
    expect(json).toContain(en.patGuideAI)

    // Click China tab again (first tab)
    const cnTab = tabButtons[0]!
    await act(async () => { cnTab.props.onClick() })

    json = JSON.stringify(view!.toJSON())
    expect(json).toContain('****1111')
  })

  it('reactively enables sidebar quota toggle when user signs in or saves PAT', async () => {
    let cnSignedIn = false
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        postedActions.push({ url, body })
        if (body.action === 'save-pat') {
          cnSignedIn = true
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      }
      const path = String(url)
      if (path === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => cnSignedIn ? ({
            status: 'signed-in',
            region: 'china',
            pat: { source: 'card', savedAtMs: 1700000000000, patTail: '2222' },
            authKey: 'cn-auth-key',
            credits: { total: 50, accounts: [] },
            models: [],
          }) : ({
            status: 'signed-out',
            region: 'china',
            authKey: 'cn-auth-key',
          }),
        }
      }
      if (path === QODER_GLOBAL_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-out',
            region: 'global',
            authKey: 'global-auth-key',
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })

    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: { sidebarQuotaCN: false, sidebarQuotaGlobal: false, quotaPollMs: 300_000 },
      }),
      subscribe: () => () => {},
      set: vi.fn(),
    }
    const props = {
      t: t as QoderPluginCardProps['t'],
      unified: true,
      scope: fakeScope as any,
    } as unknown as Parameters<typeof QoderPluginCard>[0]

    await act(async () => {
      view = create(createElement(QoderPluginCard, props))
    })

    // Expand the card
    const headerBtn = view!.root.findAllByType('button')[0]!
    await act(async () => { headerBtn.props.onClick() })

    // Find the toggle switches: first one is China quota toggle
    const switches = view!.root.findAll(n => n.props.role === 'switch')
    expect(switches.length).toBeGreaterThanOrEqual(2)
    const cnSwitch = switches[0]!
    // Initially disabled because cn is signed out
    expect(cnSwitch.props.disabled).toBe(true)

    // Fill in PAT input and click save
    const patInput = view!.root.find(n => n.type === 'input' && n.props.type === 'password')
    await act(async () => {
      patInput.props.onChange({ target: { value: 'test-pat-token' } })
    })

    // Click save button
    const saveBtn = view!.root.findAll(n => n.type === 'button' && n.props.children === en.patSave)[0]!
    await act(async () => {
      await saveBtn.props.onClick()
    })

    // After saving PAT, China switch must be reactively enabled!
    const updatedSwitches = view!.root.findAll(n => n.props.role === 'switch')
    const updatedCnSwitch = updatedSwitches[0]!
    expect(updatedCnSwitch.props.disabled).toBe(false)
  })

  it('(a) disables quota switches when accounts are not signed in and (b) prevents disabled click from calling scope.set', async () => {
    request.mockImplementation(async () => {
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    const mockSet = vi.fn()
    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: { sidebarQuotaCN: false, sidebarQuotaGlobal: false, quotaPollMs: 300_000 },
      }),
      subscribe: () => () => {},
      set: mockSet,
    }
    const props = {
      t: t as QoderPluginCardProps['t'],
      unified: true,
      scope: fakeScope as any,
      signedIn: () => ({ cn: false, global: false }),
    } as unknown as Parameters<typeof QoderPluginCard>[0]

    await act(async () => {
      view = create(createElement(QoderPluginCard, props))
    })

    // Expand the card
    const headerBtn = view!.root.findAllByType('button')[0]!
    await act(async () => { headerBtn.props.onClick() })

    // (a) Verify switches are disabled when not signed in
    const switches = view!.root.findAll(n => n.props.role === 'switch')
    expect(switches.length).toBeGreaterThanOrEqual(2)
    const [cnSwitch, globalSwitch] = switches
    expect(cnSwitch!.props.disabled).toBe(true)
    expect(globalSwitch!.props.disabled).toBe(true)

    // (b) Simulate clicking switches in disabled state; verify scope.set is NEVER triggered
    await act(async () => {
      cnSwitch!.props.onClick()
      globalSwitch!.props.onClick()
    })
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('(c) safely blocks SidebarQuotaCard click when status is signed-out in wide and rail modes', async () => {
    request.mockImplementation(async () => {
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })

    // Enable quota toggles so SidebarQuotaCard renders instead of returning null
    setQuotaToggles(true, true)
    noteQuotaStatus('qoder', { status: 'signed-out' })
    noteQuotaSignIn('qoder', false)

    const openMock = vi.fn()

    // 1. Wide mode test
    let wideView: ReactTestRenderer | undefined
    await act(async () => {
      wideView = create(createElement(SidebarQuotaCard, {
        t: t as any,
        statusPath: QODER_STATUS_PATH,
        open: openMock,
        wide: true,
      } as any))
    })

    const wideBtn = wideView!.root.findByProps({ className: 'qdp-foot' })
    expect(wideBtn.props.disabled).toBe(true)

    // Attempt clicking wide button while signed-out
    await act(async () => {
      wideBtn.props.onClick()
    })
    expect(openMock).not.toHaveBeenCalled()
    act(() => wideView?.unmount())

    // 2. Rail mode (collapsed icon button) test
    let railView: ReactTestRenderer | undefined
    await act(async () => {
      railView = create(createElement(SidebarQuotaCard, {
        t: t as any,
        statusPath: QODER_STATUS_PATH,
        open: openMock,
        wide: false,
      } as any))
    })

    const railBtn = railView!.root.findByProps({ className: 'qdp-railButton' })
    expect(railBtn.props.disabled).toBe(true)

    // Attempt clicking rail button while signed-out
    await act(async () => {
      railBtn.props.onClick()
    })
    expect(openMock).not.toHaveBeenCalled()
    act(() => railView?.unmount())

    // 3. When signed-in, clicking wide button opens dashboard
    request.mockImplementation(async (url: string) => {
      const path = String(url)
      if (path === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-in',
            region: 'china',
            credits: { total: 50, accounts: [] },
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    noteQuotaStatus('qoder', {
      status: 'signed-in',
      credits: { total: 50, accounts: [] },
    })
    noteQuotaSignIn('qoder', true)

    let signedInView: ReactTestRenderer | undefined
    await act(async () => {
      signedInView = create(createElement(SidebarQuotaCard, {
        t: t as any,
        statusPath: QODER_STATUS_PATH,
        open: openMock,
        wide: true,
      } as any))
    })

    const signedInBtn = signedInView!.root.findByProps({ className: 'qdp-foot' })
    expect(signedInBtn.props.disabled).toBe(false)

    await act(async () => {
      signedInBtn.props.onClick()
    })
    expect(openMock).toHaveBeenCalledTimes(1)
    act(() => signedInView?.unmount())
  })

  it('prints the cycle USED percentage beside each package label in the sidebar card', async () => {
    // Issue #14's shape: the row already carried the REMAINING ratio, and the
    // label now carries the same ratio read as usage — Qoder desktop's
    // "60 / 2,400 (已使用 3%)" phrasing, one line down in our own card.
    setQuotaToggles(true, false)
    noteQuotaSignIn('qoder', true)
    noteQuotaStatus('qoder', {
      status: 'signed-in',
      credits: {
        total: 0,
        accounts: [
          { packageName: '个人额度', remain: 2000, size: 2000 },
          { packageName: '赠送额度', remain: 2340, size: 2400 },
        ],
      },
    })

    let card: ReactTestRenderer | undefined
    await act(async () => {
      card = create(createElement(SidebarQuotaCard, {
        t: tZh as any,
        statusPath: QODER_STATUS_PATH,
        open: () => {},
        wide: true,
      } as any))
    })

    const labels = card!.root
      .findAll(node => node.props.className === 'qdp-footLabel')
      .map(node => node.children.filter((child): child is string => typeof child === 'string').join(''))
    expect(labels).toEqual(['个人额度(已使用0%)', '赠送额度(已使用3%)'])
    act(() => card?.unmount())
  })

  it('omits the used suffix when the row has no ratio to state', async () => {
    // An unknown total and an uncapped package both have no percentage — the
    // suffix must vanish rather than assert a fabricated "已使用0%".
    setQuotaToggles(true, false)
    noteQuotaSignIn('qoder', true)
    noteQuotaStatus('qoder', {
      status: 'signed-in',
      credits: {
        total: 0,
        accounts: [
          { packageName: '个人额度', remain: 100, size: 0 },
          { packageName: '赠送额度', remain: 0, size: 0, unlimited: true },
        ],
      },
    })

    let card: ReactTestRenderer | undefined
    await act(async () => {
      card = create(createElement(SidebarQuotaCard, {
        t: tZh as any,
        statusPath: QODER_STATUS_PATH,
        open: () => {},
        wide: true,
      } as any))
    })

    const labels = card!.root
      .findAll(node => node.props.className === 'qdp-footLabel')
      .map(node => node.children.filter((child): child is string => typeof child === 'string').join(''))
    expect(labels).toEqual(['个人额度', '赠送额度'])
    act(() => card?.unmount())
  })

  it('shows a dedicated campaign package in the sidebar row set', async () => {
    // Qoder Global grants campaign credits in `dedicatedResourcePackages`; the
    // host maps them onto rows, and the card must draw them like any other
    // package. Before this mapping existed the 2,000-credit SOTA grant was
    // simply absent from every surface.
    setQuotaToggles(false, true)
    noteQuotaSignIn('qoder-global', true)
    noteQuotaStatus('qoder-global', {
      status: 'signed-in',
      pat: { source: 'card', savedAtMs: 1_792_116_336_888, patTail: 'd092' },
      credits: {
        total: 0.01,
        totalSize: 2100,
        accounts: [
          { packageName: '个人额度', remain: 0, size: 0 },
          { packageName: '赠送额度', remain: 95, size: 100 },
          {
            packageName: 'SOTA 专属积分',
            packageNameI18n: { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' },
            packageCode: 'act-20261014-129',
            remain: 2000,
            size: 2000,
            packageEndTime: '2026-10-19T02:00:00.000Z',
          },
        ],
      },
    })

    let card: ReactTestRenderer | undefined
    await act(async () => {
      card = create(createElement(SidebarQuotaCard, {
        t: tZh as any,
        statusPath: QODER_GLOBAL_STATUS_PATH,
        open: () => {},
        wide: true,
      } as any))
    })

    const labels = card!.root
      .findAll(node => node.props.className === 'qdp-footLabel')
      .map(node => node.children.filter((child): child is string => typeof child === 'string').join(''))
    // The grant renders with its own title and its own figures; the spent
    // personal row stays hidden because something else still has credit.
    expect(labels).toEqual(['赠送额度(已使用5%)', 'SOTA 专属积分(已使用0%)'])
    const amounts = card!.root
      .findAll(node => node.props.className === 'qdp-footAmount')
      .map(node => node.children.filter((child): child is string => typeof child === 'string').join(''))
    expect(amounts).toEqual(['95 / 100', '2,000 / 2,000'])
    act(() => card?.unmount())
  })

  it('lists a campaign grant in the dashboard ledger with its own expiry', async () => {
    // The panel is the itemised ledger: the SOTA grant must appear there with
    // its OWN deadline, printed as a date the user can read rather than the
    // raw UTC instant, and with the account's year-9999 sentinel nowhere in
    // sight. With no account-wide expiry to state, the panel says what it does
    // know — when this PAT was authorized.
    noteQuotaSignIn('qoder-global', true)
    noteQuotaStatus('qoder-global', {
      status: 'signed-in',
      pat: { source: 'card', savedAtMs: Date.parse('2026-10-16T02:05:36.888Z'), patTail: 'd092' },
      credits: {
        total: 0.01,
        totalSize: 2100,
        accounts: [
          { packageName: '个人额度', remain: 0, size: 0 },
          { packageName: '赠送额度', remain: 95, size: 100 },
          {
            packageName: 'SOTA 专属积分',
            packageNameI18n: { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' },
            remain: 2000,
            size: 2000,
            packageEndTime: '2026-10-19T01:59:57.331Z',
          },
        ],
      },
    })

    let panel: ReactTestRenderer | undefined
    await act(async () => {
      panel = create(createElement(QuotaDashboard, {
        t: tZh as any,
        statusPaths: [QODER_GLOBAL_STATUS_PATH],
        refresh: () => {},
        close: () => {},
        onVariantPicked: () => {},
        useQuotaDashboard: (selector: (state: { loading: boolean; activePath: string }) => unknown) =>
          selector({ loading: false, activePath: QODER_GLOBAL_STATUS_PATH }),
      } as any))
    })

    const expiryCells = panel!.root
      .findAll(node => node.props.className === 'qdp-expiry')
      .map(node => node.children.filter((child): child is string => typeof child === 'string').join(''))
    // One date column carries the grant's deadline, localized rather than the
    // verbatim instant; the personal and bonus rows state no expiry at all.
    const dated = expiryCells.filter(text => text.includes('2026'))
    expect(dated).toHaveLength(1)
    expect(dated[0]).not.toMatch(/T\d{2}:\d{2}/)

    // The ledger's figure column: every row the upstream reported, live rows
    // first and the spent personal quota sunk to the bottom (the panel is the
    // itemised ledger — collapsing a spent row here would destroy the only
    // place its standing allowance is visible). The grant keeps its own
    // 2,000 / 2,000 rather than being summed into the package beside it.
    const amounts = panel!.root
      .findAll(node => node.props.className === 'qdp-numText')
      .map(node => node.children.filter((child): child is string => typeof child === 'string').join(''))
    expect(amounts).toEqual(['95 / 100', '2,000 / 2,000', '0 / 0'])

    const tree = JSON.stringify(panel!.toJSON())
    expect(tree).not.toContain('9999')
    expect(tree).toContain('SOTA 专属积分')
    expect(tree).toContain(zh.patAuthorizedAt.replace('{time}', ''))
    act(() => panel?.unmount())
  })

  it('states a real cycle deadline alone, never beside the PAT stand-in', async () => {
    // The panel's two bottom lines are alternatives, not siblings: an account
    // whose upstream reports a real cycle deadline must state that deadline and
    // must NOT also print when the PAT was authorized. The plugin card's status
    // tab already gates the same fact this way; the panel let both through,
    // which is the asymmetry this case pins down.
    noteQuotaSignIn('qoder-global', true)
    noteQuotaStatus('qoder-global', {
      status: 'signed-in',
      pat: { source: 'card', savedAtMs: Date.parse('2026-10-16T02:05:36.888Z'), patTail: 'd092' },
      credits: {
        total: 12,
        totalSize: 300,
        accounts: [{ packageName: '个人额度', remain: 264, size: 300, packageEndTime: '2026-11-01T00:00:00.000Z' }],
        cycleResetTime: '2026-11-01T00:00:00.000Z',
      },
    })

    let panel: ReactTestRenderer | undefined
    await act(async () => {
      panel = create(createElement(QuotaDashboard, {
        t: tZh as any,
        statusPaths: [QODER_GLOBAL_STATUS_PATH],
        refresh: () => {},
        close: () => {},
        onVariantPicked: () => {},
        useQuotaDashboard: (selector: (state: { loading: boolean; activePath: string }) => unknown) =>
          selector({ loading: false, activePath: QODER_GLOBAL_STATUS_PATH }),
      } as any))
    })

    const bottomLines = panel!.root
      .findAll(node => node.props.className === 'qdp-windowReset')
      .map(node => node.children.filter((child): child is string => typeof child === 'string').join(''))
    // Exactly one line, and it is the deadline — not the PAT stand-in that
    // exists only for accounts whose upstream reports no deadline at all.
    expect(bottomLines).toHaveLength(1)
    expect(bottomLines[0]).toContain(zh.quotaExpires)
    expect(bottomLines[0]).not.toContain(zh.patAuthorizedAt.replace('{time}', '').trim())
    act(() => panel?.unmount())
  })

  it('offers the upstream itemized page where the API reports no expiry', async () => {
    // The summed 赠送额度 bucket has no expiry in the quota endpoint at all —
    // the account page is what breaks it into grants with per-grant dates. The
    // row must therefore stop claiming "no expiry" and point at the page
    // instead, labelled with the host the upstream sent so the international
    // and Chinese variants each name their own site with no hardcoded string.
    // A row that DOES carry a reported expiry keeps the date: the link stands
    // in for a missing answer and never replaces a real one.
    noteQuotaSignIn('qoder-global', true)
    noteQuotaStatus('qoder-global', {
      status: 'signed-in',
      pat: { source: 'card', savedAtMs: Date.parse('2026-10-16T02:05:36.888Z'), patTail: 'd092' },
      credits: {
        total: 0.23,
        totalSize: 400,
        accounts: [
          { packageName: '赠送额度', remain: 310, size: 400, detailUrl: 'https://qoder.com.cn/account/usage' },
          { packageName: 'SOTA 专属积分', remain: 2000, size: 2000, packageEndTime: '2026-10-19T01:59:57.331Z', detailUrl: 'https://qoder.com/account/usage' },
        ],
      },
    })

    let panel: ReactTestRenderer | undefined
    await act(async () => {
      panel = create(createElement(QuotaDashboard, {
        t: tZh as any,
        statusPaths: [QODER_GLOBAL_STATUS_PATH],
        refresh: () => {},
        close: () => {},
        onVariantPicked: () => {},
        useQuotaDashboard: (selector: (state: { loading: boolean; activePath: string }) => unknown) =>
          selector({ loading: false, activePath: QODER_GLOBAL_STATUS_PATH }),
      } as any))
    })

    const anchors = panel!.root.findAll(node => node.type === 'a')
    // Exactly one: the undated bucket links, the dated one prints its date.
    expect(anchors).toHaveLength(1)
    expect(anchors[0]!.props.href).toBe('https://qoder.com.cn/account/usage')
    expect(anchors[0]!.props.target).toBe('_blank')
    // Opens as an external link the page cannot reach back into the app.
    expect(anchors[0]!.props.rel).toBe('noreferrer noopener')
    // The label names the site the link points at — the .cn host, proving the
    // card echoes the upstream rather than assuming a region.
    const label = anchors[0]!.children.filter((child): child is string => typeof child === 'string').join('')
    expect(label).toContain('qoder.com.cn')
    expect(label).not.toContain('qoder.com/account')

    const tree = JSON.stringify(panel!.toJSON())
    // The dated row still shows a localized date, not a second link.
    expect(tree).toContain('2026')
    // "无到期时间" is no longer what an undated-but-linked row claims.
    expect(tree).not.toContain(zh.quotaNoExpiry)
    act(() => panel?.unmount())
  })

  it('rejects write to scope.set when attempting to turn on sidebarQuotaCN/Global while unsigned', async () => {
    const mockSet = vi.fn()
    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: { sidebarQuotaCN: false, sidebarQuotaGlobal: false, quotaPollMs: 300_000 },
      }),
      subscribe: () => () => {},
      set: mockSet,
    }
    let contentRenderer: ReactTestRenderer | undefined
    await act(async () => {
      contentRenderer = create(createElement(QuotaSettingsContent, {
        t: t as any,
        scope: fakeScope as any,
        signedIn: () => ({ cn: false, global: false }),
      }))
    })

    const switches = contentRenderer!.root.findAll(n => n.props.role === 'switch')
    expect(switches.length).toBeGreaterThanOrEqual(2)
    for (const sw of switches) {
      expect(sw.props.disabled).toBe(true)
    }

    // Even if onToggle was triggered directly with next=true, write() must intercept and drop it
    const toggleRows = contentRenderer!.root.findAll(n => typeof n.props.onToggle === 'function')
    for (const row of toggleRows) {
      await act(async () => {
        row.props.onToggle(true)
      })
    }
    expect(mockSet).not.toHaveBeenCalled()
    act(() => contentRenderer?.unmount())
  })

  it('renders check-in log tab after status, context, details when check-in logs exist', async () => {
    request.mockImplementation(async (url: string) => {
      const path = String(url)
      if (path === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-in',
            region: 'china',
            pat: { source: 'card', savedAtMs: 1700000000000, patTail: '1111' },
            authKey: 'cn-auth-key',
            credits: { total: 30, accounts: [] },
            models: [],
            checkIn: {
              lastDate: '2026-09-21',
              lastAt: 1700000000000,
              status: 'already-claimed',
              amount: 100,
              logs: [
                {
                  id: 'log-2',
                  date: '2026-09-21',
                  timestamp: 1700000100000,
                  status: 'already-claimed',
                  amount: 100,
                  message: 'Already claimed today',
                },
                {
                  id: 'log-1',
                  date: '2026-09-21',
                  timestamp: 1700000000000,
                  status: 'claimed',
                  amount: 100,
                },
              ],
            },
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })

    await act(async () => {
      view = create(createElement(QoderPluginCard, {
        t: t as any,
        unified: true,
      } as any))
    })

    // Expand card
    const expandBtn = view!.root.findByProps({ 'aria-expanded': false })
    await act(async () => {
      expandBtn.props.onClick()
    })

    // Find inner tabs (Status, Context, Details, Check-in log)
    const innerTabs = view!.root.findAll(n =>
      n.props.role === 'tab' && (
        n.children.includes(en.tabStatus) ||
        n.children.includes(en.tabContext) ||
        n.children.includes(en.tabDetails) ||
        n.children.includes(en.tabCheckIn)
      )
    )
    expect(innerTabs).toHaveLength(4)
    const checkInTab = innerTabs.find(n => n.children.includes(en.tabCheckIn))!
    expect(checkInTab).toBeDefined()

    // Click checkin tab
    await act(async () => {
      checkInTab.props.onClick()
    })

    // Verify check-in log entries rendered. Two rows, one grant: the
    // `already-claimed` row carries an amount in the record (it is the day's
    // benefit value), but that action obtained nothing, so only the `claimed`
    // row may print "+100" — otherwise one day reads as two grants of 100.
    const amounts = view!.root.findAll(n => n.children.includes('+100'))
    expect(amounts).toHaveLength(1)
    const alreadyClaimed = view!.root.findAll(n => n.children.includes(en.autoCheckInStatusAlready))
    expect(alreadyClaimed.length).toBeGreaterThanOrEqual(1)

    // Verify action buttons exist in check-in log panel (check in now, refresh, clear)
    const checkInBtn = view!.root.findAll(n => n.children.includes(en.checkInNow))
    expect(checkInBtn.length).toBeGreaterThanOrEqual(1)
    const refreshBtn = view!.root.findAll(n => n.children.includes(en.checkInRefresh))
    expect(refreshBtn.length).toBeGreaterThanOrEqual(1)
    const clearBtn = view!.root.findAll(n => n.children.includes(en.checkInClear))
    expect(clearBtn.length).toBeGreaterThanOrEqual(1)
  })

  it('stores a typed check-in time as minutes past midnight in UTC+8', async () => {
    const mockSet = vi.fn()
    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: {
          sidebarQuotaCN: false,
          sidebarQuotaGlobal: false,
          autoCheckInCN: true,
          autoCheckInGlobal: false,
          checkInMinuteCN: 600,
          checkInMinuteGlobal: 600,
          quotaPollMs: 300_000,
        },
      }),
      subscribe: () => () => {},
      set: mockSet,
    }
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(QuotaSettingsContent, {
        t: t as any,
        scope: fakeScope as any,
        signedIn: () => ({ cn: true, global: false }),
      }))
    })

    // Two rows, each an hour and a minute field — typeable under any input
    // method, unlike the `type="time"` spinner segments this replaced.
    const part = (name: string, index = 0) =>
      renderer!.root.findAll(n => n.props['data-checkin-part'] === name)[index]!
    expect(renderer!.root.findAll(n => n.props['data-checkin-part'] === 'hour')).toHaveLength(2)
    expect(renderer!.root.findAll(n => n.props['data-checkin-part'] === 'minute')).toHaveLength(2)
    expect(renderer!.root.findAll(n => n.props.type === 'time')).toHaveLength(0)

    // The stored minute count renders as 10:00.
    expect(part('hour').props.value).toBe('10')
    expect(part('minute').props.value).toBe('00')

    await act(async () => { part('hour').props.onChange({ target: { value: '14' } }) })
    await act(async () => { part('minute').props.onChange({ target: { value: '30' } }) })
    // Nothing is written mid-typing; the commit is what persists it.
    expect(mockSet).not.toHaveBeenCalled()
    await act(async () => { part('hour').props.onBlur() })
    expect(mockSet).toHaveBeenCalledWith('checkInMinuteCN', 870)

    // The Global row stays locked while its own account is signed out.
    expect(part('hour', 1).props.disabled).toBe(true)
    expect(part('minute', 1).props.disabled).toBe(true)
    act(() => renderer?.unmount())
  })

  it('refuses a check-in time before the 10:00 window opening', async () => {
    // A moment before 10:00 can never claim anything — the upstream has not
    // opened the day's benefit yet — so the field must not be able to store one
    // and leave the plugin looking broken for a reason the user chose.
    const mockSet = vi.fn()
    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: {
          sidebarQuotaCN: false,
          sidebarQuotaGlobal: false,
          autoCheckInCN: true,
          autoCheckInGlobal: false,
          checkInMinuteCN: 600,
          checkInMinuteGlobal: 600,
          quotaPollMs: 300_000,
        },
      }),
      subscribe: () => () => {},
      set: mockSet,
    }
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(QuotaSettingsContent, {
        t: t as any,
        scope: fakeScope as any,
        signedIn: () => ({ cn: true, global: false }),
      }))
    })

    const part = (name: string, index = 0) =>
      renderer!.root.findAll(n => n.props['data-checkin-part'] === name)[index]!

    await act(async () => { part('hour').props.onChange({ target: { value: '9' } }) })
    await act(async () => { part('minute').props.onChange({ target: { value: '30' } }) })
    await act(async () => { part('hour').props.onBlur() })

    // Nothing was written, and the fields snapped back to the earliest moment
    // the plugin will actually run.
    expect(mockSet).not.toHaveBeenCalled()
    expect(part('hour').props.value).toBe('10')
    expect(part('minute').props.value).toBe('00')

    // Midnight is refused the same way.
    await act(async () => { part('hour').props.onChange({ target: { value: '0' } }) })
    await act(async () => { part('minute').props.onChange({ target: { value: '0' } }) })
    await act(async () => { part('hour').props.onBlur() })
    expect(mockSet).not.toHaveBeenCalled()
    expect(part('hour').props.value).toBe('10')
    expect(part('minute').props.value).toBe('00')

    act(() => renderer?.unmount())
  })
})
