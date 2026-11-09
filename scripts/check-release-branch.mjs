#!/usr/bin/env node
// Fail unless a commit is on a release branch's first-parent chain.
//
// Usage: node scripts/check-release-branch.mjs <branch ref> [<commit>]
//   <commit> defaults to HEAD. publish.yml and docs.yml run it on the tagged
//   commit against refs/remotes/origin/release/X.Y, with full history.
//
// Being an ancestor of release/X.Y is not enough: every commit inside a
// merged pull request is one. A pull request could bump the version with
// changed source in one commit and revert the source in the next, so that
// the merge looks harmless, and a tag on the first commit would publish it.
// The first-parent chain holds only what the branch itself took: each merge
// or squash commit of an approved pull request (RELEASING.md allows no other
// merge method into release branches), and main's history it was cut from.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** Whether `commit` is on `branch`'s first-parent chain, in the repository at `cwd`. */
export function onFirstParentChain(branch, commit = 'HEAD', cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim()
  const sha = git(['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`])
  return git(['rev-list', '--first-parent', '--end-of-options', branch]).split('\n').includes(sha)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [branch, commit = 'HEAD'] = process.argv.slice(2)
  if (branch === undefined) {
    console.error('usage: node scripts/check-release-branch.mjs <branch ref> [<commit>]')
    process.exit(2)
  }
  if (!onFirstParentChain(branch, commit)) {
    console.error(
      `${commit} is not on the first-parent chain of ${branch}: only a merge or squash commit there is released`
    )
    process.exit(1)
  }
}
