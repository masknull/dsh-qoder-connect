/**
 * SlotMap merge for the plugin manager's bundle-configuration seat — a
 * structural re-statement of the contract
 * `@deepseek-ai/dsh-client-ui-plugin-manager` declares for its Plugins page
 * (its `slot-contract.ts`): the sidebar's Plugins panel renders one bundle's
 * own configuration ON THE BUNDLE'S DETAIL PAGE — the page a plugin card opens
 * into — through the `plugins.bundle.config` keyed slot, keyed by the bundle's
 * npm package name, between the page's description and its component rows
 * (`view: 'page'` only).
 *
 * The package is a Host built-in this bundle does not depend on (client bundle
 * purity: cross-plugin collaboration goes through services and slots, never
 * imports), so the seat is re-declared here to make the registration
 * type-check. The declarations must stay STRUCTURALLY IDENTICAL to upstream's:
 * when a peer package ships its own merge, a duplicate conflicting member
 * would fail compilation — the guard against drift. The owner shapes below are
 * upstream's `PluginConfigViewProps` / `ConfigPageForm` verbatim, with the
 * `ConfigForm` types taken from the settings client package this bundle already
 * types against (the same source upstream imports them from).
 */

import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Host-owned configuration values and write actions for one page's entry. */
export interface ConfigPageForm {
  /** Accepted Host values; refreshed by the page owner. */
  readonly state: ConfigFormSnapshot<Record<string, unknown>>
  /** Submit all field edits together with the revision the editor read. */
  readonly mutate: ConfigForm<Record<string, unknown>>['mutate']
}

/** The view the plugin manager asks a configuration entry for. */
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone; `page` renders the form with its save control. */
  readonly view: 'summary' | 'page'
  /** Host-owned configuration values and write actions for this page's entry. */
  readonly form?: ConfigPageForm | undefined
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * A bundle's own configuration, keyed by the bundle's package name and
     * rendered on the bundle's page between its description and its rows
     * (`view: 'page'` only). Declared by the Host's plugin manager as a child
     * of its `main` registration; a bundle's key is its package name, the same
     * key the page's configuration ledger reads to decide whether the
     * configuration section shows.
     */
    'plugins.bundle.config': {
      kind: 'keyed'
      scope: 'root'
      owner: PluginConfigViewProps
    }
  }
}
