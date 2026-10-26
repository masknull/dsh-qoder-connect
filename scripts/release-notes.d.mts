/** One commit, split into the conventional-commit parts the notes render. */
export interface ReleaseCommit {
  subject: string
  hash: string
  type: string
  scope: string
  text: string
}

export function parse(raw: string): ReleaseCommit[]

export function render(commits: readonly ReleaseCommit[], current: string, previous: string): string
