/**
 * The plugin's data directory — the one place every file the plugin owns lives:
 * `<profile>/.dsh-qoder-connect/state/` (PATs, catalogs, probe records,
 * heartbeat, machine-id seed), so a profile never collects loose files.
 *
 * Resolution order: `DSH_QODER_DATA_DIR` → host-reported profile → discovered
 * profile → Harness home. The host's report outranks discovery because it is the
 * running profile, not an inference.
 *
 * @module dsh-qoder-connect/paths
 */

import { lstatSync, readFileSync, readdirSync, realpathSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** The per-profile directory the plugin's data folder lives under. */
export const QODER_DATA_DIR_NAME = '.dsh-qoder-connect'

/** The directory inside the data dir where the rebuildable state files live. */
export const QODER_STATE_DIR_NAME = 'state'

/** Environment override for the whole data directory. */
export const QODER_DATA_DIR_ENV = 'DSH_QODER_DATA_DIR'

const PROFILES_DIR_NAME = 'profiles'

/** The npm name of this package, as a profile's manifest declares it. */
const PLUGIN_PACKAGE_NAME = 'dsh-qoder-connect'

/** The subset of a logger this module reports decisions through. */
export interface PathsDiagnostics {
  warn(message: string): void
}

/** Host-reported facts about the running profile; see {@link configurePluginPaths}. */
let hostProfileDir: string | undefined
let diagnostics: PathsDiagnostics | undefined

/**
 * Adopt the host's answer for which profile is running, before any path is
 * resolved. Overwrites both fields, so a reload without a profile context clears
 * the previous answer.
 *
 * @param host - the host's report.
 * @param host.profileDir - `profileContext.dir`, when the host has one.
 * @param host.diagnostics - where an ambiguous discovery fallback is reported.
 */
export function configurePluginPaths(host: {
  profileDir: string | undefined
  diagnostics?: PathsDiagnostics | undefined
}): void {
  const reported = host.profileDir
  // An empty report is no report: joining the empty string as a directory would
  // put the data dir in the process's working directory.
  hostProfileDir = typeof reported === 'string' && reported.trim() !== '' ? reported : undefined
  diagnostics = host.diagnostics
}

function pluginPackageRoot(): string | undefined {
  try {
    // `<root>/lib/paths.js` in a build, `<root>/src/paths.ts` from source.
    return dirname(dirname(fileURLToPath(import.meta.url)))
  } catch {
    // Not loaded from a file URL (a bundled or synthetic module).
    return undefined
  }
}

/**
 * Whether a profile directory declares this plugin.
 *
 * Read from the profile's manifest rather than inferred from this module's path:
 * DSH installs a plugin into a profile by *link*, and the real path lies outside
 * `$DSH_HOME`, so walking up from the module would miss the profile.
 */
function profileDeclaresPlugin(profileDir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return typeof manifest.dependencies?.[PLUGIN_PACKAGE_NAME] === 'string'
      || typeof manifest.devDependencies?.[PLUGIN_PACKAGE_NAME] === 'string'
  } catch {
    // Not a profile, or unreadable: it simply is not a candidate.
    return false
  }
}

/**
 * Whether a profile's OWN `node_modules` is a link rather than a directory.
 *
 * A whole-tree link is the shape of a residual profile, never a real install, so
 * it must not claim the running package. An absent `node_modules` is not this
 * shape: a profile resolving from the shared `profiles/node_modules` has none.
 */
function profileNodeModulesIsLinked(profileDir: string): boolean {
  try {
    // On Windows a junction reports as a symbolic link here, which is the
    // intended detection.
    return lstatSync(join(profileDir, 'node_modules')).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Whether a profile's installed copy of this plugin resolves to this package,
 * so the data directory follows the profile actually running.
 *
 * A whole-tree link is rejected first (see {@link profileNodeModulesIsLinked}):
 * the realpath comparison cannot tell that shape apart from a real install.
 */
function profileLinksToThisPackage(profileDir: string): boolean {
  const own = pluginPackageRoot()
  if (own === undefined) return false
  if (profileNodeModulesIsLinked(profileDir)) return false
  try {
    return realpathSync(join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME)) === realpathSync(own)
  } catch {
    // No installed copy, or an unreadable link.
    return false
  }
}

/**
 * The profile directory this plugin belongs to, or undefined when none can be
 * determined.
 *
 * A single declaring profile is accepted without the link test (it may resolve
 * from the shared `profiles/node_modules`), but a whole-tree link is refused
 * either way. With several declaring profiles, only those resolving here are
 * eligible; a tie is broken by `readdirSync` order, which is undefined — so ties
 * and "nothing eligible" both warn. Warnings name the rejection only: each caller
 * owns its own consequence.
 */
function discoverProfileDir(): string | undefined {
  const profilesRoot = join(resolveDshHome(), PROFILES_DIR_NAME)
  let entries: Dirent[]
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    // No profiles directory at all: nothing to discover.
    return undefined
  }
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(profilesRoot, entry.name)
    if (profileDeclaresPlugin(dir)) candidates.push(dir)
  }
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) {
    // The length check above is what makes this defined.
    const only = candidates[0]!
    if (profileNodeModulesIsLinked(only)) {
      diagnostics?.warn(
        `qoder: the only profile declaring this plugin, ${only}, links its entire node_modules elsewhere and so `
        + `cannot be the running copy.`,
      )
      return undefined
    }
    return only
  }
  const eligible = candidates.filter(candidate => profileLinksToThisPackage(candidate))
  if (eligible.length === 0) {
    diagnostics?.warn(
      `qoder: ${candidates.length} profiles declare this plugin, none holds the running copy, and the host `
      + `reported no running profile. Candidates: ${candidates.join(', ')}`,
    )
    return undefined
  }
  if (eligible.length > 1) {
    diagnostics?.warn(
      `qoder: ${eligible.length} profiles hold a copy resolving to this package and the host reported no running `
      + `profile; following ${eligible[0]} on nothing but directory order. `
      + `Candidates: ${eligible.join(', ')}`,
    )
  }
  return eligible[0]
}

/**
 * The plugin's data directory: `<profile>/.dsh-qoder-connect`.
 *
 * Falls back to profile discovery, then to the Harness home, so the plugin
 * always has somewhere to write; `DSH_QODER_DATA_DIR` overrides either way.
 */
export function qoderPluginDataDir(): string {
  const override = process.env[QODER_DATA_DIR_ENV]
  if (override !== undefined && override.trim() !== '') return override
  const base = hostProfileDir ?? discoverProfileDir() ?? resolveDshHome()
  return join(base, QODER_DATA_DIR_NAME)
}

/**
 * The directory the rebuildable state files live in:
 * `<data dir>/state/` (saved catalogs, probe records, the host heartbeat).
 */
export function qoderStateDir(): string {
  return join(qoderPluginDataDir(), QODER_STATE_DIR_NAME)
}

/**
 * The plugin-owned seed for the Qoder transport's machine id.
 *
 * The transport reads trusted locations and writes its UUID into the last one;
 * this keeps the identifier inside the plugin's own folder.
 */
export function qoderMachineIdPath(): string {
  return join(qoderStateDir(), '.qoder-machine-id')
}
