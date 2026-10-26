import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { peerExpectations, peerVersionFailure, satisfiesRange } from '../src/index.ts'

/**
 * The load-time peer check exists because a profile installed with
 * `autoInstallPeers: false` keeps whatever copy of `dsh-llm` / `pi-ai` it first
 * resolved, and the plugin imports that copy regardless of what peer ranges
 * declare. These tests pin the two halves: the range comparison itself, and
 * the resolution-to-version walk that asks the host's resolver which copy it
 * will actually load.
 */

describe('peer range comparison', () => {
  const cases: ReadonlyArray<readonly [string, string, boolean, string]> = [
    // The floor this plugin declares, and the host versions in the wild.
    ['0.2.1-rc.2', '>=0.2.1-rc.1', true, 'current host build passes'],
    ['0.2.1-rc.1', '>=0.2.1-rc.1', true, 'exact floor passes'],
    ['0.2.1', '>=0.2.1-rc.1', true, 'release above the rc floor passes'],
    ['0.3.0', '>=0.2.1-rc.1', true, 'newer minor passes'],
    ['0.2.0', '>=0.2.1-rc.1', false, 'older minor fails'],
    ['0.1.6-alpha.2', '>=0.2.1-rc.1', false, 'stale profile copy fails'],
    // pi-ai's caret floor.
    ['1.3.0', '^1.1.0', true, 'current pi-ai passes'],
    ['1.1.0', '^1.1.0', true, 'exact caret floor passes'],
    ['1.4.0', '^1.1.0', true, 'caret admits the next minor'],
    ['1.0.9', '^1.1.0', false, 'caret rejects a lower minor'],
    ['2.0.0', '^1.1.0', false, 'caret rejects the next major'],
    ['2.0.0-rc.1', '^1.1.0', false, 'a preview of the next major is still out of range'],
    ['0.3.0-rc.1', '^0.2.1', false, 'a preview of the next minor is still out of range'],
    ['1.5.0-rc.1', '^1.1.0', true, 'a preview inside an admitted minor passes'],
    ['1.1.0-rc.1', '^1.1.0', true, 'an rc of the caret floor passes'],
    ['0.82.1', '^1.1.0', false, 'stale pi-ai 0.82.x fails'],
    ['0.85.1', '^1.1.0', false, 'stale pi-ai 0.85.x fails'],
    // Pre-release ordering.
    ['0.2.1-alpha', '>=0.2.1-beta', false, 'alpha sorts below beta'],
    ['0.2.1-beta.2', '>=0.2.1-alpha.1', true, 'beta sorts above alpha'],
    ['0.2.1-rc.1', '>=0.2.1-rc.2', false, 'rc.1 sorts below rc.2'],
    ['0.2.1-rc.10', '>=0.2.1-rc.9', true, 'numeric pre-release id compares numerically'],
    ['0.2.1', '>=0.2.1-rc.1', true, 'release sorts above its own rc'],
    // Deliberate leniency: an rc of the floor base counts as the floor.
    ['0.2.1-rc.2', '>=0.2.1', true, 'rc of the bound base passes a bare floor'],
    ['0.2.1-rc.2', '^0.2.1', true, 'rc of the bound base passes caret'],
    // 0.x caret locks the first non-zero field.
    ['0.0.5', '^0.0.1', false, '^0.0.1 admits only 0.0.1'],
    ['0.0.5', '^0.0.5', true, 'exact 0.0.x floor passes'],
    ['0.0.6', '^0.0.5', false, '^0.0.5 admits only 0.0.5'],
    ['0.2.9', '^0.2.1', true, '^0.2.1 admits the rest of 0.2.x'],
    ['0.3.0', '^0.2.1', false, '^0.2.1 stops at 0.3.0'],
    ['1.9.9', '^1.2.3', true, '^1.2.3 admits the rest of 1.x'],
    // Unknowable forms pass: a declaration we cannot parse must never block a load.
    ['latest', '^1.1.0', true, 'non-semver tag passes'],
    ['canary', '>=0.0.0', true, 'non-semver tag passes'],
    ['1.0', '>=1.0.0', true, 'two-part version is not semver, passes'],
    ['0.2.1+build.5', '>=0.2.1-rc.1', true, 'build metadata is ignored'],
    ['1.0.0', '', true, 'empty range passes'],
    ['1.0.0', 'invalid', true, 'unparseable range passes'],
    ['1.0.0', '~1.0.0', true, 'tilde admits its own patch'],
    ['1.0.4', '~1.0.0', true, 'tilde admits a later patch'],
    ['1.0.9', '~1.0.0', true, 'tilde stays inside the minor'],
    ['1.1.0', '~1.0.0', false, 'tilde stops at the next minor'],
    ['0.2.9', '~0.2.1', true, 'tilde on a 0.x line admits later patches'],
    ['0.3.0', '~0.2.1', false, 'tilde on a 0.x line stops at the next minor'],
    ['1.0.0', '1.x', true, 'unimplemented range form passes'],
  ]

  for (const [version, range, expected, note] of cases) {
    it(`${version} vs ${range} -> ${expected} (${note})`, () => {
      expect(satisfiesRange(version, range)).toBe(expected)
    })
  }
})

describe('checked peers come from the manifest', () => {
  it('uses the ranges this package declares, not a copy of them', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies: Record<string, string> }
    const expectations = peerExpectations()
    expect(expectations.length).toBeGreaterThan(0)
    for (const { spec, range } of expectations) {
      expect(range).toBe(manifest.peerDependencies[spec])
    }
  })
})

describe('peer version resolution', () => {
  const dirs: string[] = []

  /** A throwaway package tree holding one package at one version. */
  function fixture(tree: Record<string, string | null>): string {
    const root = mkdtempSync(join(tmpdir(), 'qoder-peer-'))
    dirs.push(root)
    for (const [spec, version] of Object.entries(tree)) {
      const dir = join(root, 'node_modules', ...spec.split('/'))
      mkdirSync(dir, { recursive: true })
      // A null version writes a manifest JSON cannot parse.
      writeFileSync(
        join(dir, 'package.json'),
        version === null ? '{ not json' : JSON.stringify({ name: spec, version }),
      )
      // The entry file readResolvedVersion anchors its walk from.
      writeFileSync(join(dir, 'index.js'), 'export {}')
    }
    return root
  }

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  const expectations = [{ spec: '@scope/pkg', range: '>=0.2.1-rc.1' }]

  /** A resolver stub that maps each spec to the entry file the host picked. */
  function resolveEntryFrom(root: string): (specifier: string) => string {
    return (specifier: string) =>
      new URL(`file://${join(root, 'node_modules', ...specifier.split('/'), 'index.js').replaceAll('\\', '/')}`).href
  }

  it('passes when the resolved copy meets the floor', () => {
    const root = fixture({ '@scope/pkg': '0.2.1-rc.2' })
    const outcome = peerVersionFailure(expectations, undefined, resolveEntryFrom(root))
    expect(outcome.failure).toBeUndefined()
    expect(outcome.unverified).toEqual([])
  })

  it('names the spec, the range and the resolved version on a stale copy', () => {
    const root = fixture({ '@scope/pkg': '0.1.6-alpha.2' })
    expect(peerVersionFailure(expectations, undefined, resolveEntryFrom(root)).failure).toMatch(
      /@scope\/pkg@>=0\.2\.1-rc\.1.*0\.1\.6-alpha\.2/s,
    )
  })

  it('never refuses the load over a peer it cannot resolve', () => {
    // The static imports already linked, so a resolution that still yields no
    // entry means missing evidence, not a broken install.
    const outcome = peerVersionFailure(
      expectations,
      undefined,
      () => { throw new Error('ERR_MODULE_NOT_FOUND') },
    )
    expect(outcome.failure).toBeUndefined()
    expect(outcome.unverified).toEqual(['@scope/pkg'])
  })

  it('reports an unreadable manifest as unverified', () => {
    const root = fixture({ '@scope/pkg': null })
    const outcome = peerVersionFailure(expectations, undefined, resolveEntryFrom(root))
    expect(outcome.failure).toBeUndefined()
    expect(outcome.unverified).toEqual(['@scope/pkg'])
  })

  it('walks up from the resolved entry to the package manifest', () => {
    const outer = mkdtempSync(join(tmpdir(), 'qoder-peer-'))
    dirs.push(outer)
    const pkgDir = join(outer, 'node_modules', '@scope', 'pkg')
    mkdirSync(join(pkgDir, 'dist'), { recursive: true })
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@scope/pkg', version: '0.1.6-alpha.2' }),
    )
    writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export {}')
    const resolveEntry = () =>
      new URL(`file://${join(pkgDir, 'dist', 'index.js').replaceAll('\\', '/')}`).href
    expect(peerVersionFailure(expectations, undefined, resolveEntry).failure).toMatch(/0\.1\.6-alpha\.2/)
  })

  it('walks past a nested manifest that is not the package itself', () => {
    // A build stub (`{"type":"module"}`) sits closer to the entry than the real
    // manifest; ending the walk there would fail open.
    const outer = mkdtempSync(join(tmpdir(), 'qoder-peer-'))
    dirs.push(outer)
    const pkgDir = join(outer, 'node_modules', '@scope', 'pkg')
    mkdirSync(join(pkgDir, 'dist'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@scope/pkg', version: '0.2.1-rc.2' }))
    writeFileSync(join(pkgDir, 'dist', 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export {}')
    const resolveEntry = () =>
      new URL(`file://${join(pkgDir, 'dist', 'index.js').replaceAll('\\', '/')}`).href
    expect(peerVersionFailure(expectations, undefined, resolveEntry).failure).toBeUndefined()
  })

  it('does not read a neighbouring package with a different name', () => {
    const outer = mkdtempSync(join(tmpdir(), 'qoder-peer-'))
    dirs.push(outer)
    const pkgDir = join(outer, 'node_modules', '@scope', 'pkg')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    // The only manifest above the entry belongs to another package and carries a
    // version that would pass; reading it would be a verdict about the wrong code.
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'other', version: '0.2.1-rc.2' }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export {}')
    const resolveEntry = () =>
      new URL(`file://${join(pkgDir, 'lib', 'index.js').replaceAll('\\', '/')}`).href
    const outcome = peerVersionFailure(expectations, undefined, resolveEntry)
    expect(outcome.failure).toBeUndefined()
    expect(outcome.unverified).toEqual(['@scope/pkg'])
  })

  it('reports a range it cannot interpret instead of enforcing nothing quietly', () => {
    const root = fixture({ '@scope/pkg': '0.1.0' })
    const warnings: string[] = []
    const outcome = peerVersionFailure(
      [{ spec: '@scope/pkg', range: '*' }],
      message => warnings.push(message),
      resolveEntryFrom(root),
    )
    expect(outcome.failure).toBeUndefined()
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toMatch(/cannot interpret the range "\*"/)
  })
})
