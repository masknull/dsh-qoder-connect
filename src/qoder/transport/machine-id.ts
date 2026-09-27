import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { qoderMachineIdPath } from '../../paths.ts'

/**
 * The machine id Qoder's own desktop CLI keeps at
 * `$HOME/.qoder/.auth/machine_id`.
 *
 * Strictly a read source for this plugin: when the official client generated
 * one, the transport reuses it so the same device presents one stable
 * identity upstream. The plugin never writes there — that tree belongs to
 * the official CLI.
 */
function officialMachineIdPath(): string {
  return join(homedir(), '.qoder', '.auth', 'machine_id')
}

/**
 * The trusted locations consulted when a caller nominates no chain: the
 * official Qoder CLI's id first, this plugin's own seed second.
 *
 * A freshly created id is saved ONLY at the end of the chain, which is now
 * always inside the plugin's data directory. An earlier default ended the
 * chain at `~/.dsh/qoder/machine_id`, derived from `os.homedir()` rather
 * than the resolved harness home, so any host with `DSH_HOME` pointed at
 * another location got a device credential scattered into the wrong `$HOME`
 * — outside every profile, with no owner deleting it. That fallback is
 * gone.
 */
function defaultMachineIdPaths(): string[] {
  return [officialMachineIdPath(), qoderMachineIdPath()]
}

/**
 * Read Qoder's machine id, or create this plugin's seed at the chain's end.
 *
 * `paths` is the read chain; its last entry doubles as the create point.
 * Passing no chain defaults to {@link defaultMachineIdPaths}; passing an
 * empty array nominates no save location, which keeps the id process-local.
 */
export function getMachineId(paths: readonly string[] = defaultMachineIdPaths()): string {
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (value) return value
    } catch {
      // Try the next trusted location.
    }
  }

  const machineId = crypto.randomUUID()
  const savePath = paths.at(-1)
  if (savePath === undefined) return machineId
  try {
    mkdirSync(dirname(savePath), { recursive: true })
    writeFileSync(savePath, machineId, { encoding: 'utf8', flag: 'wx' })
  } catch {
    // Another process may have won creation; prefer its stable value.
    try {
      const existing = readFileSync(savePath, 'utf8').trim()
      if (existing) return existing
    } catch {
      // An ephemeral id is still sufficient for this process.
    }
  }
  return machineId
}
