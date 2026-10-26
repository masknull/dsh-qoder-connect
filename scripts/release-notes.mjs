#!/usr/bin/env node
/**
 * Markdown release notes for the commits between two tags.
 *
 * Usage: node scripts/release-notes.mjs <tag> [previous-tag]
 *
 * The previous tag defaults to the newest `v*` tag reachable from `<tag>^`, so a
 * release describes exactly the range its own tag covers. Conventional-commit
 * types become sections; `release:` commits are dropped as noise.
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
]
const OTHER = 'Other changes'
const SKIP = /^(release|chore\(release\))(:|$)/u

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

function previousTag(tag) {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`])
  } catch {
    // No reachable tag: this is the first release.
    return ''
  }
}

export function parse(raw) {
  return raw.split('\n').filter(line => line !== '').map(line => {
    const [subject = '', hash = ''] = line.split('\t')
    const match = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/u.exec(subject)
    return { subject, hash, type: match?.[1] ?? '', scope: match?.[2] ?? '', text: match?.[3] ?? subject }
  }).filter(commit => !SKIP.test(commit.subject))
}

export function render(commits, current, previous) {
  if (commits.length === 0) return 'No changes recorded for this release.\n'

  const buckets = new Map()
  for (const commit of commits) {
    const title = SECTIONS.find(([type]) => type === commit.type)?.[1] ?? OTHER
    const list = buckets.get(title) ?? []
    list.push(commit)
    buckets.set(title, list)
  }

  const order = [...SECTIONS.map(([, title]) => title), OTHER]
  const parts = []
  for (const title of order) {
    const list = buckets.get(title)
    if (list === undefined) continue
    parts.push(`### ${title}\n\n${list.map(commit => {
      const label = commit.scope === '' ? commit.text : `${commit.scope}: ${commit.text}`
      return `- ${label} (\`${commit.hash}\`)`
    }).join('\n')}`)
  }

  const repo = process.env.GITHUB_REPOSITORY
  if (repo !== undefined && previous !== '') {
    parts.push(`**Full Changelog**: https://github.com/${repo}/compare/${previous}...${current}`)
  }
  return `${parts.join('\n\n')}\n`
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  const current = process.argv[2]
  if (current === undefined) {
    console.error('usage: release-notes.mjs <tag> [previous-tag]')
    process.exit(2)
  }
  const previous = process.argv[3] ?? previousTag(current)
  const range = previous === '' ? current : `${previous}..${current}`
  const log = git(['log', range, '--no-merges', '--pretty=format:%s\t%h'])
  process.stdout.write(render(parse(log), current, previous))
}
