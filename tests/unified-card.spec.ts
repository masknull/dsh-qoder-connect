import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderPluginCard, type QoderPluginCardProps } from '../src/client/QoderPluginCard.tsx'
import { QuotaSettingsContent } from '../src/client/QuotaSettingsCard.tsx'
import { SidebarQuotaCard } from '../src/client/SidebarQuotaCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { QoderSettingsKey } from '../src/client/locales.ts'
import { noteQuotaSignIn, noteQuotaStatus, resetQuotaStatusForTesting, setQuotaToggles } from '../src/client/quota-settings-store.ts'
import { QODER_AUTH_PATH, QODER_GLOBAL_AUTH_PATH, QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from '../src/status-paths.ts'

const t = (key: QoderSettingsKey, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
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
    expect(json).toContain(t('patTail', { tail: '****1111' }))
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
    expect(json).toContain(t('patTail', { tail: '****1111' }))
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
              status: 'claimed',
              amount: 100,
              logs: [
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

    // Verify check-in log entries rendered
    const amounts = view!.root.findAll(n => n.children.includes('+100'))
    expect(amounts.length).toBeGreaterThanOrEqual(1)

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
})
