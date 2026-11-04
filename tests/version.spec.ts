import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { QODER_CONNECT_VERSION } from '../src/version.ts'

/**
 * Guard the single-source-of-truth version contract: the build-time define
 * (`__DSH_QODER_VERSION__`) injects package.json's version into src/version.ts, and
 * dropping it makes version.ts fall back to '0.0.0-dev' — which this test refuses.
 */
describe('package version sync', () => {
  it('QODER_CONNECT_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(QODER_CONNECT_VERSION).toBe(pkg.version)
  })

  it('never leaks a build-define fallback marker', () => {
    expect(QODER_CONNECT_VERSION).not.toBe('0.0.0-dev')
  })
})
