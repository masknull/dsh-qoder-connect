/** Browser half: Qoder account status, quota cards, and plugin settings. */

import { useEffect } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// The settings domain base owns the `settings.section` slot contract (and the
// 0.1.5-only `ctx.settingsScope` augmentation) — imported for its TYPES only,
// which is what keeps this bundle free of a runtime dependency on either
// version's settings package.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { QoderProbeControl } from './QoderProbeControl.tsx'
import { QODER_CARD_VARIANTS, QoderPluginCard } from './QoderPluginCard.tsx'
import type { QoderPluginCardInjected } from './QoderPluginCard.tsx'
import { QuotaSettingsCard } from './QuotaSettingsCard.tsx'
import type { QuotaSection, QuotaSettingsCardInjected, QuotaSettingsScope } from './QuotaSettingsCard.tsx'
import { OwnQuotaSettingsScope } from './http-settings-scope.ts'
import { QuotaDashboard, SidebarQuotaCard } from './SidebarQuotaCard.tsx'
import type { QuotaDashboardInjected, QuotaDashboardState, QuotaDashboardProps, SidebarQuotaCardInjected, SidebarQuotaCardProps } from './SidebarQuotaCard.tsx'
import { injectQuotaCss } from './quota-styles.ts'
import './quota-slots.ts'
import { setQuotaPollMs, setQuotaToggles, quotaSignInState, quotaPollMs, noteQuotaStatus, quotaStatusIsFresh, variantOfStatusPath } from './quota-settings-store.ts'
import { isQoderWebStatus } from './status-document.ts'
import { en, zh } from './locales.ts'
import type { QoderSettingsKey } from './locales.ts'
import { QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from '../status-paths.ts'
import type { QoderWebStatus } from '../status-paths.ts'

/** The dashboard face's props are bound directly; no extra key props are needed. */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Qoder plugin card copy. */
    'settings.qoder': QoderSettingsKey
    /** Shared quota-settings and sidebar-card copy. */
    'panel.qoder-quota': QoderSettingsKey
  }
  interface SlotMap {
    /**
     * One card inside the shared 《插件设置》 block that the connect plugins
     * build on DSH 0.1.7 from `settings.section`.
     *
     * 0.1.7 removed the Plugins tab's card list (`settings.plugin.item`), so the
     * three connect plugins declare this child slot under the shared container
     * and register their own entry into it. Options: `id` (the registering
     * plugin's package name, unique), `order` (card order). Declared by
     * whichever plugin wins the container race — the declaration is part of the
     * container's `children` table, so it exists exactly while the container
     * does.
     */
    'plugin-settings.item': { kind: 'list'; scope: 'root' }
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-qoder-connect-client'
/**
 * Client services this bundle requires BEFORE it activates.
 *
 * DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
 * hold the browser `ClientContext` alias and the `slots` service). The services
 * this card relies on now come from narrower packages: the `slots` registry
 * moved to `@deepseek-ai/dsh-client-ui-renderer`, `locale` stayed in
 * `@deepseek-ai/dsh-client-locale`, and the Plugins tab's card list
 * (`settings.plugin.item`) is declared by
 * `@deepseek-ai/dsh-client-ui-settings-plugins`. Those packages are named in
 * the package's `dsh.client.inject` list.
 */
// `modelDirectories` reads the active session through `remote.session`.
// Declaring that dependency at the client entry is required by the Desktop
// renderer; without it Cordis rejects `directoryFor()` before this bundle can
// finish registering its contributions.
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/** The status routes per variant id (mirrors the host's locked route table). */
const VARIANT_STATUS: Record<string, string> = {
  qoder: QODER_STATUS_PATH,
  'qoder-global': QODER_GLOBAL_STATUS_PATH,
}

/**
 * The shared 《插件设置》 block's slot and entry ids.
 *
 * The three connect plugins must agree on these exactly: `settings.section` is
 * a `list` slot, so many blocks may coexist, but a child slot name may be
 * declared once and a list entry id may be registered once. The first plugin to
 * arrive registers the container (declaring the child slot); the others detect
 * it and attach their own entry, which is why the ids are fixed constants
 * rather than per-plugin names.
 */
const SHARED_SECTION_SLOT = 'settings.section'
const SHARED_SECTION_ID = 'plugin-settings'
const SHARED_SECTION_ORDER = 900
const SHARED_ITEM_SLOT = 'plugin-settings.item'
/** This plugin's entry id inside the shared block: its package name (unique). */
const SHARED_ITEM_ID = 'dsh-qoder-connect'
/** The shared block's title, fixed by the contract so all three plugins agree. */
const SHARED_SECTION_LABEL = '插件设置'

/**
 * The shared 《插件设置》 section the 0.1.7 card list lives in.
 *
 * It renders nothing but its child slot: every connect plugin contributes its
 * own card as one `plugin-settings.item` entry. The list wrapper mirrors the
 * list the removed Plugins tab used for the same cards (`gap: 10`, no markers),
 * so the cards keep the spacing they had on 0.1.5.
 *
 * @param props - the section's slot props (owner share plus `renderSlot`).
 * @returns the ordered card list.
 */
function PluginSettingsSection(
  props: PropsRuntime<'settings.section'> & PropsRenderSlots<typeof SHARED_ITEM_SLOT>,
): React.ReactNode {
  return (
    <ul style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 0, listStyle: 'none' }}>
      {props.renderSlot(SHARED_ITEM_SLOT, {})}
    </ul>
  )
}

/**
 * Register card copy, the shared quota-settings card, the two variant cards,
 * and the sidebar quota cards.
 *
 * The entire body is wrapped so that a DSH slot-API breaking change (for
 * example the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades
 * to a `console.error` instead of throwing into the DSH loader and raising
 * the red "Failed to load plugins" banner. The host provider keeps working:
 * the `qoder` model channel is unaffected, and `dsh-qoder-connect
 * status` reports host health via the heartbeat file.
 *
 * Card ORDER: the Plugins tab dispatches `settings.plugin.item` in
 * registration order, so this entry registers the shared quota-settings card
 * first (top), then CN, then Global — the layout agreed for this feature
 * (统一设置 → CN → Global, china first).
 *
 * NOTE: the try/catch boundary of this function is mirrored (duplicated) in
 * `tests/client-fallback.spec.ts`, because the real client entry imports
 * browser-only DSH packages that cannot load in the Node test environment.
 * That test therefore does not import this function — it replicates its
 * shape. If you change the guarded body or the `console.error` message here,
 * update the mirrored `apply()` in that spec too, or the fallback test will
 * silently diverge from this real implementation.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.qoder'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-qoder-connect: settings copy')
    const t = ctx.locale.bind(namespace) as QoderPluginCardInjected['t']

    // 1. Shared quota-settings card. Card ORDER is priority-ascending in the
    // Plugins tab (measured: lower priority renders first), so this card gets
    // the lowest priority number of the three to sit above the two variant
    // cards: 统一设置 (50) → CN (60) → Global (70).
    //
    // The band starts at 50 deliberately: the sibling connect plugin in this
    // workspace registers the same three seats at 10/20/30, and the ledger
    // breaks priority ties by registration order, so equal or overlapping
    // values interleaved the two plugins' cards instead of keeping each
    // plugin's group together. A band no sibling uses makes the grouping
    // independent of load order.
    const quotaSettingsInjected: QuotaSettingsCardInjected = {
      t,
      // Read live at render: the sign-in state changes without a remount.
      signedIn: () => quotaSignInState(),
    }
    /**
     * The bound quota settings face, filled in as soon as a host configuration
     * service becomes available (see the two `ctx.inject` callbacks below).
     *
     * It is bound as a SERVICE ARRIVES rather than when the settings card's
     * inject factory first runs: the factory only executes while the settings
     * page renders, so a fresh page load read no toggles and rendered no sidebar
     * card until the user opened settings — the exact regression the
     * commandcode card avoids by reading its STORED fact independently of the
     * settings page. The face's subscription mirrors every accepted snapshot
     * (toggles + interval) into the shared store the sidebar cards and the
     * dashboard read; a deployment with no configuration service never binds,
     * and the sidebar cards stay hidden.
     */
    let quotaScope: QuotaSettingsScope<QuotaSection> | undefined
    const adoptQuotaScope = (scope: QuotaSettingsScope<QuotaSection>): void => {
      quotaScope = scope
      const applySnapshot = (): void => {
        const value = scope.getSnapshot().value
        setQuotaToggles(value?.sidebarQuotaCN === true, value?.sidebarQuotaGlobal === true)
        if (typeof value?.quotaPollMs === 'number') setQuotaPollMs(value.quotaPollMs)
      }
      applySnapshot()
      scope.subscribe(applySnapshot)
    }

    // Unified Qoder plugin configuration card: merges sidebar quota settings,
    // China variant, and Global variant into one single card titled "Qoder".
    // The shared 《插件设置》 block dispatches its `list` entries by id
    // (ascending order); the card rank is fixed across the three connect
    // plugins: the first sibling takes 10, the second 20, this one 30.
    const registerUnifiedCard = (): (() => void) => {
      const inject = (): QoderPluginCardInjected => ({
        t,
        scope: quotaScope,
        signedIn: () => quotaSignInState(),
        unified: true,
      })
      return ctx.slots.inject(SHARED_ITEM_SLOT, () => ctx.slots.register({ name: SHARED_ITEM_SLOT, id: SHARED_ITEM_ID, order: 30, inject }, QoderPluginCard))
    }

    /**
     * Attach this plugin's card to the shared 《插件设置》 block, building the
     * block first if nobody has.
     *
     * Backoff protocol (identical in all three connect plugins, on purpose: a
     * `list` slot takes many entries but only ONE registration per id, and a
     * child slot name may be declared once, so the container is a rendezvous
     * rather than a race to be won):
     *   1. wait for the host to declare `settings.section`;
     *   2. if an entry with the shared id is already there, only attach;
     *   3. otherwise register the container — and if a sibling won the race and
     *      the registration throws, fall back to attaching to theirs.
     */
    const joinSharedSettingsBlock = (): void => {
      ctx.slots.inject(SHARED_SECTION_SLOT, () => {
        let disposeContainer: (() => void) | undefined
        const claimed = ctx.slots.entries(SHARED_SECTION_SLOT)
          .some(entry => entry.options?.id === SHARED_SECTION_ID)
        if (!claimed) {
          try {
            disposeContainer = ctx.slots.register({
              name: SHARED_SECTION_SLOT,
              id: SHARED_SECTION_ID,
              order: SHARED_SECTION_ORDER,
              label: () => SHARED_SECTION_LABEL,
              children: { [SHARED_ITEM_SLOT]: { kind: 'list', scope: 'root' } },
            }, PluginSettingsSection)
          } catch (error: unknown) {
            // A sibling registered the container between the probe and this
            // call: their declaration is the live one, so attach to it.
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

    /**
     * 插件自有配置（`<profile>/.dsh-qoder-connect/settings.json`）：两条宿主线的
     * 读写都走宿主半的 settings face，不再经过 settingsScope / configForms。
     *
     * 0.1.7 的 configForms 写入会整树 reconcile + fiber 热重载（每次约
     * 1~1.5 秒，且每次保存都刷新所有客户端镜像）；自有文件写入是本地毫秒级
     * 原子写。卡片注册无条件进行：scope 在启动时载入，迟到也不会漏掉 UI。
     */
    const ownQuotaScope = new OwnQuotaSettingsScope()
    void ownQuotaScope.load()
    adoptQuotaScope(ownQuotaScope as unknown as QuotaSettingsScope<QuotaSection>)
    joinSharedSettingsBlock()

    // Sidebar quota cards + the dashboard they open. Two registrations, one
    // navigation entry — commandcode's pattern: the layout's keyed `main` slot
    // holds the shared dashboard, each footer card selects it on click. The
    // `layout` service is read REFLECTIVELY at click time (never a static
    // inject — ui-layout is not this bundle's dependency), and the footer
    // registration is gated on the layout seam so a profile without
    // `selectPanel` never renders a dead button.
    const QUOTA_PANEL_ID = 'qoder-quota-panel'
    const CONVERSATION_PANEL_ID = 'conversation'
    interface LayoutSelectionSeam {
      selectPanel: (id: string | null) => void
    }

    // ---- dashboard state (module-closure, read by both the face and open()) ----
    const dashboardDocuments: { cn: QoderWebStatus | undefined; global: QoderWebStatus | undefined } = { cn: undefined, global: undefined }
    let dashboardFetchedAt: number | undefined
    let dashboardLoading = false
    let dashboardRequestedPath: string = QODER_STATUS_PATH
    /** Whether the dashboard is the CURRENT center panel (its mount owns this). */
    let quotaPanelOpen = false
    const dashboardListeners = new Set<() => void>()
    /**
     * The observable source the dashboard reads through the inject face's
     * `hooks` compartment. The renderer caches an inject face ONCE per entry
     * and SPREADS it into props — a face getter is read exactly once and
     * frozen, which is why face-carried documents/activePath went stale. The
     * hooks channel survives: `bindInjectSources` converts each hooks member
     * into a `use<Name>` selector hook, and the hook reads the CURRENT
     * snapshot on every render (the same mechanism commandcode's usage store
     * rides).
     *
     * STABILITY CONTRACT: useSyncExternalStore requires getSnapshot() to
     * return the SAME reference between changes — a fresh object per call
     * re-renders forever and React kills the entry (error #185, the same
     * class of crash the settings card's unstable projection caused). So the
     * snapshot is a CACHED object, replaced wholesale by publish(); every
     * mutator builds the next snapshot and publishes exactly once.
     */
    let dashboardSnap: QuotaDashboardState = {
      documents: [undefined, undefined],
      fetchedAt: undefined,
      loading: false,
      activePath: QODER_STATUS_PATH,
    }
    const rebuildSnapshot = (): void => {
      const next: QuotaDashboardState = {
        documents: [dashboardDocuments.cn, dashboardDocuments.global],
        fetchedAt: dashboardFetchedAt,
        loading: dashboardLoading,
        activePath: dashboardRequestedPath,
      }
      // Publish only on an actual change: identity-stable otherwise.
      if (JSON.stringify(next) !== JSON.stringify(dashboardSnap)) {
        dashboardSnap = next
        for (const listener of dashboardListeners) listener()
      }
    }
    const dashboardSource = {
      getSnapshot: (): QuotaDashboardState => dashboardSnap,
      subscribe: (listener: () => void): (() => void) => {
        dashboardListeners.add(listener)
        return () => {
          dashboardListeners.delete(listener)
        }
      },
    }
    const notifyDashboard = (): void => {
      rebuildSnapshot()
    }

    /**
     * Refresh ONE variant's document (the one the panel is showing) — not
     * both. The earlier version fetched both routes on every panel mount, so
     * clicking the CN card also refreshed the Global card's data and timestamp;
     * the user ruled each click refreshes only what it shows.
     *
     * Freshness rule (also the user's): if the shared document for THIS
     * variant is newer than the configured interval, the fetch is SKIPPED —
     * a click shows the cached numbers instead of re-billing upstream. A
     * variant with NO result yet always fetches. A manual Refresh click
     * (force=true) bypasses the freshness check: an explicit user action
     * always re-reads.
     */
    const refreshDashboard = async (options: { force?: boolean } = {}): Promise<void> => {
      if (dashboardLoading) return
      const variantId = variantOfStatusPath(dashboardRequestedPath)
      if (options.force !== true && quotaStatusIsFresh(variantId, quotaPollMs())) return
      dashboardLoading = true
      rebuildSnapshot()
      try {
        const result = await fetchStatusDocument(variantId === 'qoder' ? QODER_STATUS_PATH : QODER_GLOBAL_STATUS_PATH)
        // Publish through the SHARED store: the sidebar cards and the settings
        // toggles read the same documents, so one refresh updates every
        // surface AT WHICH IT IS SHOWN — and only that variant's document.
        if (result !== undefined) noteQuotaStatus(variantId, result)
        dashboardFetchedAt = Date.now()
      } finally {
        dashboardLoading = false
        rebuildSnapshot()
      }
    }

    let dashboardTimer: number | undefined
    const startDashboardPoll = (): void => {
      if (dashboardTimer !== undefined) return
      void refreshDashboard()
      dashboardTimer = window.setInterval(() => {
        if (document.hidden) return
        // Interval ticks honour the freshness rule too: a tick within the
        // interval of the last read is a no-op, not a fetch.
        void refreshDashboard()
      }, Math.max(60_000, quotaPollMs()))
    }
    const stopDashboardPoll = (): void => {
      if (dashboardTimer === undefined) return
      window.clearInterval(dashboardTimer)
      dashboardTimer = undefined
    }

    async function fetchStatusDocument(path: string): Promise<QoderWebStatus | undefined> {
      try {
        const response = await fetch(path, { headers: { accept: 'application/json' } })
        const body: unknown = await response.json()
        return response.ok && isQoderWebStatus(body) ? body : undefined
      } catch {
        return undefined
      }
    }

    // Mount/unmount wrapper. A FUNCTION DECLARATION, defined before the
    // register call that names it: the last build named a `const` from inside
    // the slots.inject factory, which ran synchronously (ui-layout was already
    // live) and hit the temporal dead zone — the ReferenceError was contained
    // by the register's own try/catch, the dashboard cell never registered,
    // and every card click threw "main panel not registered" (the dead
    // button). Hoisted declarations cannot hit the dead zone. The child
    // renders as JSX (not a bare function call) so its hooks stay in their
    // own component instance.
    function QuotaDashboardWithLifecycle(props: QuotaDashboardProps): React.ReactNode {
      useEffect(() => {
        quotaPanelOpen = true
        startDashboardPoll()
        return () => {
          quotaPanelOpen = false
          stopDashboardPoll()
        }
      }, [])
      return <QuotaDashboard {...props} />
    }

    const panelFace = (): QuotaDashboardInjected => ({
      hooks: {
        // Renderer converts this to the `useQuotaDashboard` selector hook
        // (standardHookPropName capitalises the name). Its snapshots MUST be
        // reference-stable between changes — useSyncExternalStore compares
        // identity — so refreshDashboard publishes a fresh top-level object.
        quotaDashboard: dashboardSource,
      },
      t,
      statusPaths: [QODER_STATUS_PATH, QODER_GLOBAL_STATUS_PATH],
      refresh: () => {
        // The dashboard's Refresh button is an explicit user action: it
        // bypasses the freshness rule and re-reads the SHOWN variant only.
        void refreshDashboard({ force: true })
      },
      // The user switched to another variant's tab: point the dashboard at it
      // and fetch that variant when the shared store holds nothing for it (or
      // something stale). Its sidebar card being off means no other surface
      // ever fetched it, so without this the tab showed "save a PAT" until the
      // user toggled a setting.
      onVariantPicked: (path: string) => {
        dashboardRequestedPath = path
        notifyDashboard()
        void refreshDashboard()
      },
      close: () => {
        const layout = ctx.get('layout') as LayoutSelectionSeam | undefined
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

    ctx.effect(() => injectQuotaCss(), 'dsh-qoder-connect: quota styles')

    // The dashboard cell itself needs no gate: registering for a declaration
    // that never arrives is a no-op by construction.
    try {
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: QUOTA_PANEL_ID, locale: 'panel.qoder-quota', inject: panelFace as never },
        QuotaDashboardWithLifecycle as never,
      ))
    } catch (error: unknown) {
      console.error('[dsh-qoder-connect] could not register the quota dashboard:', error)
    }

    ctx.inject(['layout'], layoutCtx => {
      const layout = layoutCtx.get('layout') as LayoutSelectionSeam | undefined
      if (typeof layout?.selectPanel !== 'function') return
      try {
        for (const variant of QODER_CARD_VARIANTS) {
          const statusPath = VARIANT_STATUS[variant.id]
          if (statusPath === undefined) continue
          const injected: SidebarQuotaCardInjected = {
            t,
            statusPath,
            // Toggle semantics (the user's spec): clicking the card of the
            // variant ALREADY showing closes the panel; clicking the other
            // variant's card switches the panel to it and keeps it open.
            open: () => {
              const current = layoutCtx.get('layout') as LayoutSelectionSeam | undefined
              if (typeof current?.selectPanel !== 'function') return
              if (quotaPanelOpen && dashboardRequestedPath === statusPath) {
                current.selectPanel(null)
                return
              }
              dashboardRequestedPath = statusPath
              // An already-mounted panel will not re-render from selectPanel
              // (the panel key is unchanged), so push the tab change through
              // the revision the dashboard subscribes to. The variant switch
              // must also FETCH the newly shown variant when the shared store
              // holds nothing (or something stale) for it — without this,
              // opening the panel on one variant and switching to the other
              // showed "save a PAT" forever for a variant no surface had ever
              // fetched (its sidebar card being off means nobody polls it).
              notifyDashboard()
              void refreshDashboard()
              current.selectPanel(QUOTA_PANEL_ID)
            },
          }
          layoutCtx.slots.inject('sidebar.footer.action', () => layoutCtx.slots.register({
            name: 'sidebar.footer.action',
            id: variant.id === 'qoder' ? 'qoder-quota' : 'qoder-global-quota',
            order: variant.id === 'qoder' ? 20 : 21,
            locale: 'panel.qoder-quota',
            inject: (): SidebarQuotaCardProps | SidebarQuotaCardInjected => injected,
          } as never, SidebarQuotaCard))
        }
      } catch (error: unknown) {
        console.error('[dsh-qoder-connect] could not register the sidebar footer card:', error)
      }
    })

    ctx.inject(['modelDirectories'], scope => {
      scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right',
        id: 'qoder-probe',
        order: 10,
        inject: sessionId => ({
          directory: scope.modelDirectories.directoryFor(
            sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
          ).store,
          t,
        }),
      }, QoderProbeControl))
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-qoder-connect] client card failed to load (host provider unaffected):', error)
  }
}
