import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configurePluginPaths, QODER_DATA_DIR_NAME, qoderPluginDataDir } from '../src/paths.ts'

// The data directory follows the running profile: the host's report first, then
// discovery of which profile declares this plugin, then the Harness home.

const homes: string[] = []
let previousHome: string | undefined
let previousOverride: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  previousOverride = process.env.DSH_QODER_DATA_DIR
  delete process.env.DSH_QODER_DATA_DIR
})

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousOverride === undefined) delete process.env.DSH_QODER_DATA_DIR
  else process.env.DSH_QODER_DATA_DIR = previousOverride
  configurePluginPaths({ profileDir: undefined })
})

/** A throwaway DSH home holding the given profiles. */
function home(profiles: Record<string, { declares?: boolean }> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'qoder-home-'))
  homes.push(root)
  process.env.DSH_HOME = root
  for (const [name, { declares = true }] of Object.entries(profiles)) {
    const dir = join(root, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(declares ? { dependencies: { 'dsh-qoder-connect': '^0.2.0' } } : { dependencies: {} }),
    )
  }
  return root
}

describe('data directory profile resolution', () => {
  it("prefers the host's report over discovery", () => {
    const root = home({ web: {} })
    const reported = join(root, 'profiles', 'web')
    configurePluginPaths({ profileDir: reported })
    expect(qoderPluginDataDir()).toBe(join(reported, QODER_DATA_DIR_NAME))
  })

  it('discovers the single profile declaring this plugin', () => {
    const root = home({ web: {} })
    configurePluginPaths({ profileDir: undefined })
    expect(qoderPluginDataDir()).toBe(join(root, 'profiles', 'web', QODER_DATA_DIR_NAME))
  })

  it('ignores a profile that does not declare this plugin', () => {
    const root = home({ other: { declares: false } })
    configurePluginPaths({ profileDir: undefined })
    expect(qoderPluginDataDir()).toBe(join(root, QODER_DATA_DIR_NAME))
  })

  it('falls back to the Harness home without any profile', () => {
    const root = home({})
    configurePluginPaths({ profileDir: undefined })
    expect(qoderPluginDataDir()).toBe(join(root, QODER_DATA_DIR_NAME))
  })

  it('treats an empty report as no report', () => {
    const root = home({ web: {} })
    configurePluginPaths({ profileDir: '' })
    expect(qoderPluginDataDir()).toBe(join(root, 'profiles', 'web', QODER_DATA_DIR_NAME))
  })
})
