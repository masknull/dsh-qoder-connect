import { afterEach, describe, expect, it } from 'vitest'
import { parse, render } from '../scripts/release-notes.mjs'

// The release job runs this on every tag, so the grouping rules are pinned here:
// a range with no conventional prefixes still has to produce a readable body.

const LOG = [
  'release: v0.2.10 - a dependency self-check\t1faee3b',
  'fix(load): finish the version check\t396677b',
  'feat(load): degrade on stale peers\t1be55f7',
  'chore(npm): ship only icon.svg\tda432cb',
  'feat!: drop the old transport\tdeadbee',
  'plain subject without a prefix\tcafe123',
].join('\n')

afterEach(() => {
  delete process.env.GITHUB_REPOSITORY
})

describe('release notes', () => {
  it('drops release commits and groups the rest by type', () => {
    const body = render(parse(LOG), 'v0.2.10', 'v0.2.9')
    expect(body).not.toContain('release: v0.2.10')
    expect(body).toContain('### Features')
    expect(body).toContain('- load: degrade on stale peers (`1be55f7`)')
    expect(body).toContain('- load: finish the version check (`396677b`)')
    expect(body).toContain('### Other changes')
    expect(body).toContain('- npm: ship only icon.svg (`da432cb`)')
    expect(body).toContain('- plain subject without a prefix (`cafe123`)')
  })

  it('keeps a breaking-change marker out of the rendered label', () => {
    const body = render(parse(LOG), 'v0.2.10', 'v0.2.9')
    expect(body).toContain('- drop the old transport (`deadbee`)')
    expect(body).not.toContain('!:')
  })

  it('links the compare range when the repository is known', () => {
    process.env.GITHUB_REPOSITORY = 'masknull/dsh-qoder-connect'
    const body = render(parse(LOG), 'v0.2.10', 'v0.2.9')
    expect(body).toContain('https://github.com/masknull/dsh-qoder-connect/compare/v0.2.9...v0.2.10')
  })

  it('omits the compare link on a first release and says so when empty', () => {
    expect(render(parse(LOG), 'v0.2.10', '')).not.toContain('Full Changelog')
    expect(render([], 'v0.2.10', 'v0.2.9')).toBe('No changes recorded for this release.\n')
  })
})
