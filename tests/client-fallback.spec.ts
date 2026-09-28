/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
} from '../src/status-paths.ts'

/**
 * The client entry degrades a slot-API breaking change (the rc.6→rc.7
 * `id`→`key` rename that caused the red "Failed to load plugins" banner)
 * to a console.error, so the host provider keeps working without a banner.
 *
 * We cannot import the real client entry (it pulls browser-only DSH client
 * packages, and its dashboard internals need the DOM); instead we replicate the
 * try/catch shape from `src/client/index.tsx` and assert it swallows a
 * simulated throw at each guarded boundary.
 *
 * DRIFT WARNING: the `apply()` below is a manual mirror of the real `apply()`
 * in `src/client/index.tsx` (see the NOTE on that function). It is NOT the
 * product code, so these tests prove the fallback boundaries work — they cannot
 * by themselves detect a regression in the real entry. The final case closes
 * that gap mechanically: it reads the entry off disk and requires every
 * `console.error` message, every `ctx.effect` label, and the locale namespace
 * it registers to appear VERBATIM in this file's own source. Change the real
 * entry's guarded body or one of those literals without updating the mirror,
 * and that case fails.
 */

/** The variant ids, mirroring `QODER_CARD_VARIANTS` in QoderPluginCard.tsx. */
const CARD_VARIANT_IDS = ['qoder', 'qoder-global'] as const

/** The status routes per variant id, mirroring VARIANT_STATUS in the entry. */
const VARIANT_STATUS: Record<string, string> = {
  qoder: QODER_STATUS_PATH,
  'qoder-global': QODER_GLOBAL_STATUS_PATH,
}

/**
 * The configuration-face constants, mirroring src/client/index.tsx.
 *
 * The `SHARED_*` group is the 《插件设置》 block the three connect plugins
 * rendezvous on: the container slot, its id and order, the child slot, this
 * plugin's entry id, and the block's title.
 */
const SHARED_SECTION_SLOT = 'settings.section'
const SHARED_SECTION_ID = 'plugin-settings'
const SHARED_SECTION_ORDER = 900
const SHARED_ITEM_SLOT = 'plugin-settings.item'
const SHARED_ITEM_ID = 'dsh-qoder-connect'
const SHARED_SECTION_LABEL = '插件设置'

/**
 * The plugin manager's bundle-configuration seat, mirroring src/client/index.tsx:
 * the sidebar's Plugins panel renders a bundle's own configuration on the
 * bundle's detail page through this keyed slot, keyed by the package name.
 */
const PLUGIN_MANAGER_SLOT = 'plugins.bundle.config'
const PLUGIN_MANAGER_KEY = 'dsh-qoder-connect'

/** A minimal stand-in for the plugin-owned settings scope (load() never resolves in the mirror). */
const stubQuotaScope = {
  getSnapshot: () => ({ status: 'loading', value: undefined, writable: true }),
  subscribe: () => () => {},
}

/** Minimal component stand-in: the mirror never renders anything. */
const Component = (): null => null

/**
 * Mirror of src/client/index.tsx apply() body.
 *
 * Not mirrored: the dashboard's mount-time internals (its cached snapshot, its
 * polling, `fetchStatusDocument`, and the mount wrapper's JSX) — they need the
 * DOM and only run once the panel is open. They are replaced by no-op
 * stand-ins so the guarded registration sequence above them stays verbatim.
 */
function apply(ctx: any): void {
  try {
    const namespace = 'settings.qoder'
    ctx.effect(() => ctx.locale.register(namespace, { zh: {}, en: {} }), 'dsh-qoder-connect: settings copy')
    const t = ctx.locale.bind(namespace)

    // 1. Shared quota-settings card, registered first so it sits above the two
    // variant cards (统一设置 (50) → CN (60) → Global (70); the band starts at
    // 50 so the sibling connect plugin's 10/20/30 cards never interleave these).
    const quotaSettingsInjected = { t, signedIn: () => ({ cn: false, global: false }) }
    let quotaScope: any
    const adoptQuotaScope = (scope: any): void => {
      quotaScope = scope
      const applySnapshot = (): void => {
        const value = scope.getSnapshot().value
        void value
      }
      applySnapshot()
      scope.subscribe(applySnapshot)
    }
    // Unified Qoder plugin configuration card: merges sidebar quota settings,
    // China variant, and Global variant into one single card titled "Qoder".
    // The shared 《插件设置》 block dispatches its `list` entries by id
    // (ascending order); the card rank is fixed across the three connect
    // plugins: the first sibling takes 10, the second 20, this one 30. The
    // same face is reused on this bundle's plugin-manager page below, opened
    // expanded there.
    const unifiedCardInject = (defaultOpen = false): any => ({
      t,
      scope: quotaScope,
      signedIn: () => ({ cn: false, global: false }),
      unified: true,
      defaultOpen,
    })
    const registerUnifiedCard = (): (() => void) =>
      ctx.slots.inject(SHARED_ITEM_SLOT, () => ctx.slots.register({ name: SHARED_ITEM_SLOT, id: SHARED_ITEM_ID, order: 30, inject: unifiedCardInject }, Component))
    const joinSharedSettingsBlock = (): void => {
      ctx.slots.inject(SHARED_SECTION_SLOT, () => {
        let disposeContainer: (() => void) | undefined
        const claimed = ctx.slots.entries(SHARED_SECTION_SLOT)
          .some((entry: any) => entry.options?.id === SHARED_SECTION_ID)
        if (!claimed) {
          try {
            disposeContainer = ctx.slots.register({
              name: SHARED_SECTION_SLOT,
              id: SHARED_SECTION_ID,
              order: SHARED_SECTION_ORDER,
              label: () => SHARED_SECTION_LABEL,
              children: { [SHARED_ITEM_SLOT]: { kind: 'list', scope: 'root' } },
            }, Component)
          } catch (error: unknown) {
            console.error('[dsh-qoder-connect] shared plugin-settings block lost the race; attaching to the winner:', error)
          }
        }
        const disposeItem = registerUnifiedCard()
        return () => {
          disposeItem()
          disposeContainer?.()
        }
      })
    }

    // 插件自有配置（`<profile>/.dsh-qoder-connect/settings.json`）：读写走宿主半
    // 的 settings face。镜像用 stub scope 顶替（真实实现见
    // src/client/http-settings-scope.ts），adopt 与 joinSharedSettingsBlock
    // 无条件进行。
    adoptQuotaScope(stubQuotaScope)
    joinSharedSettingsBlock()

    // The same unified card on this bundle's page in the sidebar's Plugins
    // panel: `ctx.slots.inject` defers until the Host's plugin manager
    // declares the seat, so a deployment without it never throws.
    const joinPluginManagerBlock = (): void => {
      try {
        ctx.slots.inject(PLUGIN_MANAGER_SLOT, () => ctx.slots.register({
          name: PLUGIN_MANAGER_SLOT,
          key: PLUGIN_MANAGER_KEY,
          // The bundle's page in the Plugins panel has room for the whole
          // configuration, so the card opens expanded there.
          inject: () => unifiedCardInject(true),
        }, Component))
      } catch (error: unknown) {
        console.error('[dsh-qoder-connect] could not join the plugin manager page:', error)
      }
    }
    joinPluginManagerBlock()

    // Dashboard internals stand-ins (see the note above).
    const QUOTA_PANEL_ID = 'qoder-quota-panel'
    const CONVERSATION_PANEL_ID = 'conversation'
    let dashboardRequestedPath: string = QODER_STATUS_PATH
    /** Whether the dashboard is the CURRENT center panel (its mount owns this). */
    let quotaPanelOpen = false
    const notifyDashboard = (): void => {}
    const refreshDashboard = async (_options: { force?: boolean } = {}): Promise<void> => {}

    ctx.effect(() => Component(), 'dsh-qoder-connect: quota styles')

    const panelFace = (): any => ({
      t,
      statusPaths: [QODER_STATUS_PATH, QODER_GLOBAL_STATUS_PATH],
      refresh: () => { void refreshDashboard({ force: true }) },
      onVariantPicked: (path: string) => {
        dashboardRequestedPath = path
        notifyDashboard()
        void refreshDashboard()
      },
      close: () => {
        const layout = ctx.get('layout') as { selectPanel: (id: string | null) => void } | undefined
        if (typeof layout?.selectPanel !== 'function') return
        try {
          layout.selectPanel(null)
        } catch {
          try {
            layout.selectPanel(CONVERSATION_PANEL_ID)
          } catch (error: unknown) {
            console.error('[dsh-qoder-connect] could not close the quota panel:', error)
          }
        }
      },
    })
    void panelFace

    try {
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: QUOTA_PANEL_ID, locale: 'panel.qoder-quota', inject: panelFace },
        Component,
      ))
    } catch (error: unknown) {
      console.error('[dsh-qoder-connect] could not register the quota dashboard:', error)
    }

    ctx.inject(['layout'], (layoutCtx: any) => {
      const layout = layoutCtx.get('layout') as { selectPanel: (id: string | null) => void } | undefined
      if (typeof layout?.selectPanel !== 'function') return
      try {
        for (const variantId of CARD_VARIANT_IDS) {
          const statusPath = VARIANT_STATUS[variantId]
          if (statusPath === undefined) continue
          const injected = {
            t,
            statusPath,
            // Toggle semantics: the card of the variant ALREADY showing closes
            // the panel; the other card switches to it and keeps it open.
            open: () => {
              if (quotaPanelOpen && dashboardRequestedPath === statusPath) {
                layout.selectPanel(null)
                return
              }
              dashboardRequestedPath = statusPath
              notifyDashboard()
              void refreshDashboard()
              layout.selectPanel(QUOTA_PANEL_ID)
            },
          }
          layoutCtx.slots.inject('sidebar.footer.action', () => layoutCtx.slots.register({
            name: 'sidebar.footer.action',
            id: variantId === 'qoder' ? 'qoder-quota' : 'qoder-global-quota',
            order: variantId === 'qoder' ? 20 : 21,
            locale: 'panel.qoder-quota',
            inject: () => injected,
          }, Component))
        }
      } catch (error: unknown) {
        console.error('[dsh-qoder-connect] could not register the sidebar footer card:', error)
      }
    })

    ctx.inject(['modelDirectories'], (scope: any) => {
      scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right',
        id: 'qoder-probe',
        order: 10,
        inject: () => ({ t }),
      }, Component))
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    console.error('[dsh-qoder-connect] client card failed to load (host provider unaffected):', error)
  }
}

interface FakeContext {
  readonly ctx: any
  readonly injections: string[]
  readonly registerCalls: Record<string, unknown>[]
}

/**
 * A stand-in for the DSH client context. `throwOn` names the service call that
 * must fail, which is how each test moves a different guarded boundary.
 *
 * `containerRace` pre-registers a sibling's shared block before this plugin's
 * factory runs, which is how the "attach to the winner" path is exercised; the
 * mid-call race (register throws after the probe saw nothing) is driven by the
 * test itself wrapping `ctx.slots.register`.
 */
function fakeContext(
  throwOn: { slot?: string; containerRace?: boolean } = {},
): FakeContext {
  const injections: string[] = []
  const registerCalls: Record<string, unknown>[] = []
  const slots = {
    inject: (name: string, factory: () => unknown) => {
      if (throwOn.slot !== undefined && throwOn.slot === name) {
        throw new Error(`slot "${name}" requires options.key`)
      }
      if (throwOn.containerRace === true && name === SHARED_SECTION_SLOT) {
        // A sibling claimed the shared block before this plugin looked.
        registerCalls.push({ name: SHARED_SECTION_SLOT, id: SHARED_SECTION_ID })
      }
      injections.push(name)
      // The mirror's factories only run when the settings page renders; the
      // register call is recorded here so a test can assert the contribution.
      const contribution = factory()
      if (typeof contribution === 'function') return contribution
      return () => {}
    },
    register: (options: Record<string, unknown>, component: unknown) => {
      // `settings.section` is a list slot: a second entry with a taken id
      // throws, which is exactly the container race the backoff catches.
      const name = options['name']
      const id = options['id']
      if (name === SHARED_SECTION_SLOT && typeof id === 'string' && registerCalls.some(call => call['id'] === id)) {
        throw new Error(`slot "${String(name)}" already has a registration for id "${id}"`)
      }
      registerCalls.push({ ...options, component })
      return () => {}
    },
    entries: (name: string) => registerCalls
      .filter(call => call['name'] === name)
      .map(call => ({ options: { id: call['id'] } })),
  }
  const layout = { selectPanel: () => {} }
  const ctx: any = {
    effect: (fn: () => unknown) => { fn() },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots,
    get: (name: string) => (name === 'layout' ? layout : undefined),
    inject: (deps: string[], cb: (scope: any) => void) => {
      cb({ get: ctx.get, slots })
    },
  }
  return { ctx, injections, registerCalls }
}

/** Console.error calls captured as strings. */
function useErrorSpy(): { errors: string[]; restore: () => void } {
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
  return { errors, restore: () => spy.mockRestore() }
}

describe('client card fallback', () => {
  it('swallows a slot registration failure instead of throwing', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx } = fakeContext({ slot: SHARED_ITEM_SLOT })

    // Must not throw — the whole point of the fallback.
    expect(() => apply(ctx)).not.toThrow()

    // The error is visible in the console for developers.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('[dsh-qoder-connect] client card failed to load')

    restore()
  })

  it('still registers the sidebar cards and the composer entry when the panel slot breaks', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections } = fakeContext({ slot: 'main' })

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('could not register the quota dashboard')
    // A dead dashboard cell must not take the rest of the plugin with it.
    expect(injections).toContain('sidebar.footer.action')
    expect(injections).toContain('conversation.input.right')

    restore()
  })

  it('still registers the composer entry when the sidebar footer seat breaks', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections } = fakeContext({ slot: 'sidebar.footer.action' })

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('could not register the sidebar footer card')
    expect(injections).toContain('conversation.input.right')

    restore()
  })

  it('contributes unified card, the panel seat, and the probe seat', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections, registerCalls } = fakeContext()

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toEqual([])
    expect(injections.filter(name => name === SHARED_ITEM_SLOT)).toHaveLength(1)
    expect(injections).toContain('main')
    expect(injections).toContain('sidebar.footer.action')
    expect(injections).toContain('conversation.input.right')
    expect(injections).toContain(PLUGIN_MANAGER_SLOT)

    // The seats this plugin claims, by their Qoder keys and ids.
    const pluginKeys = registerCalls.flatMap(call => typeof call['key'] === 'string' ? [call['key']] : [])
    expect(pluginKeys.sort()).toEqual(['dsh-qoder-connect', 'qoder-quota-panel'])
    const seatIds = registerCalls.flatMap(call => typeof call['id'] === 'string' ? [call['id']] : [])
    expect(seatIds.sort()).toEqual(['dsh-qoder-connect', 'plugin-settings', 'qoder-global-quota', 'qoder-probe', 'qoder-quota'])
    // The probe seat belongs to the international-or-not composer chrome this
    // plugin owns; its route pair is what the control reads.
    expect(QODER_PROBE_PATH).toBe('/plugins/dsh-qoder-connect/probe')

    restore()
  })

  it('builds the shared settings block and homes the card in it', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections, registerCalls } = fakeContext()

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toEqual([])
    expect(injections).toContain(SHARED_SECTION_SLOT)
    expect(injections).toContain(SHARED_ITEM_SLOT)

    const container = registerCalls.find(call => call['name'] === SHARED_SECTION_SLOT)
    expect(container).toBeDefined()
    // The three connect plugins must agree on these exactly, or the block comes
    // out half-built.
    expect(container?.['id']).toBe(SHARED_SECTION_ID)
    expect(container?.['order']).toBe(SHARED_SECTION_ORDER)
    expect(container?.['children']).toEqual({ [SHARED_ITEM_SLOT]: { kind: 'list', scope: 'root' } })
    expect((container?.['label'] as () => string)()).toBe(SHARED_SECTION_LABEL)

    const item = registerCalls.find(call => call['name'] === SHARED_ITEM_SLOT)
    expect(item?.['id']).toBe(SHARED_ITEM_ID)
    expect((item?.['inject'] as () => { unified?: boolean })()).toMatchObject({ unified: true })

    restore()
  })

  it('attaches to a block a sibling already built', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, registerCalls } = fakeContext({ containerRace: true })

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toEqual([])
    // Exactly one container: the sibling's. This plugin only adds its card.
    expect(registerCalls.filter(call => call['name'] === SHARED_SECTION_SLOT)).toHaveLength(1)
    expect(registerCalls.filter(call => call['name'] === SHARED_ITEM_SLOT)).toHaveLength(1)

    restore()
  })

  it('registers the unified card on the plugin manager page under the package key', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, registerCalls } = fakeContext()

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toEqual([])

    const entries = registerCalls.filter(call => call['name'] === PLUGIN_MANAGER_SLOT)
    expect(entries).toHaveLength(1)
    // The key is the ledger key the page reads to show the configuration
    // section: this bundle's npm package name, spelled exactly.
    expect(entries[0]?.['key']).toBe(PLUGIN_MANAGER_KEY)
    // The same face the shared block's card gets — same scope, same unified
    // layout — so one save updates both surfaces; the Plugins-panel copy
    // opens expanded, the settings block's stays collapsed.
    const settingsFace = (entries[0]?.['inject'] as () => { unified?: boolean; defaultOpen?: boolean })()
    expect(settingsFace).toMatchObject({ unified: true, defaultOpen: true })
    const blockFace = registerCalls
      .find(call => call['name'] === SHARED_ITEM_SLOT)?.['inject'] as () => { unified?: boolean; defaultOpen?: boolean }
    expect(blockFace()).toMatchObject({ unified: true, defaultOpen: false })

    restore()
  })

  it('still registers everything else when the plugin manager seat is unavailable', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections, registerCalls } = fakeContext({ slot: PLUGIN_MANAGER_SLOT })

    expect(() => apply(ctx)).not.toThrow()
    // One boundary reports itself; the settings block and the model channel
    // are untouched.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('could not join the plugin manager page')
    expect(injections).not.toContain(PLUGIN_MANAGER_SLOT)
    expect(registerCalls.filter(call => call['name'] === SHARED_ITEM_SLOT)).toHaveLength(1)
    expect(injections).toContain('main')
    expect(injections).toContain('sidebar.footer.action')
    expect(injections).toContain('conversation.input.right')

    restore()
  })

  it('falls back to attaching when the container race is lost mid-call', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, registerCalls } = fakeContext()
    // The probe sees no container, then a sibling's lands first: the register
    // call throws and the backoff has to attach to theirs instead.
    const first = true
    const original = ctx.slots.register
    let raced = false
    ctx.slots.register = (options: Record<string, unknown>, component: unknown) => {
      if (first && options['name'] === SHARED_SECTION_SLOT && !raced) {
        raced = true
        registerCalls.push({ name: SHARED_SECTION_SLOT, id: SHARED_SECTION_ID })
      }
      return original(options, component)
    }

    expect(() => apply(ctx)).not.toThrow()
    // The lost race is reported, and the card still lands in the winner's block.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('lost the race')
    expect(registerCalls.filter(call => call['name'] === SHARED_ITEM_SLOT)).toHaveLength(1)

    restore()
  })
})

describe('mirror stays verbatim with src/client/index.tsx', () => {
  const entrySource = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const mirrorSource = readFileSync(new URL(import.meta.url), 'utf8')

  it('every console.error message in the entry is mirrored word for word', () => {
    const messages = [...entrySource.matchAll(/console\.error\(\s*'([^']+)'/g)].map(match => match[1]!)
    // Guard the guard: the real entry must actually carry the six boundaries
    // this spec mirrors (outer catch + the lost container race, the dashboard,
    // the sidebar footer, the panel close, and the plugin manager page).
    expect(messages).toHaveLength(6)
    for (const message of messages) {
      expect(mirrorSource).toContain(message)
    }
  })

  it('every effect label and locale namespace in the entry is mirrored', () => {
    const labels = [...entrySource.matchAll(/,\s*'(dsh-qoder-connect: [^']+)'/g)].map(match => match[1]!)
    expect(labels).toEqual(['dsh-qoder-connect: settings copy', 'dsh-qoder-connect: quota styles'])
    for (const label of labels) expect(mirrorSource).toContain(label)
    // The two locale namespaces and the settings namespace the scope binds.
    expect(entrySource).toContain("'settings.qoder'")
    expect(entrySource).toContain("'panel.qoder-quota'")
    expect(mirrorSource).toContain("'settings.qoder'")
    expect(mirrorSource).toContain("'panel.qoder-quota'")
  })

  it('the entry has no legacy brand literal left anywhere', () => {
    // Assembled at runtime so this spec's own source stays out of its way.
    const legacy = ['work', 'buddy'].join('')
    expect(entrySource.toLowerCase()).not.toContain(legacy)
    expect(mirrorSource.toLowerCase()).not.toContain(legacy)
  })

  it('every seat this plugin claims in the entry is claimed by the mirror too', () => {
    // The registration identity of the plugin: slot names plus the keys/ids it
    // contributes. A rename on one side and not the other is exactly the drift
    // the mirror obligation warns about.
    const seats = [
      'conversation.input.right', 'sidebar.footer.action',
      'qoder-global-quota', 'qoder-quota-panel', 'qoder-probe',
      // The shared 《插件设置》 block: the container and the child slot the
      // three connect plugins must spell identically.
      'settings.section', 'plugin-settings', 'plugin-settings.item',
      // The plugin manager's bundle-configuration seat, keyed by the package name.
      'plugins.bundle.config',
    ]
    for (const seat of seats) {
      expect(entrySource).toContain(seat)
      expect(mirrorSource).toContain(seat)
    }
  })
})
