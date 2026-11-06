#!/usr/bin/env node
// Fail a change to a package's source that adds nothing to CHANGELOG.md.
//
// Usage: node scripts/check-changelog.mjs <base> <head>
//   Compares the two commits. CI's `changelog` job passes a pull request's
//   merge commit and its first parent, the tip of the branch it merges into,
//   so the comparison is exactly what merging the pull request changes.
//   Locally: node scripts/check-changelog.mjs origin/main HEAD
//
// A change under packages/<package>/src/ (added, changed, deleted or renamed
// from or to there) needs at least one added line in CHANGELOG.md, under the
// section of the release it goes into (RELEASING.md). Tests, docs and
// configuration need none. A source change no consumer can see still gets a
// line, so the changelog can be read as the complete list of what a release
// changes in the published code.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const SOURCE = /^packages\/[^/]+\/src\//

/**
 * What is wrong with a change, or undefined: `files` are the paths it touches
 * (both sides of a rename), `changelogAdded` the lines it adds to CHANGELOG.md.
 */
export function missingChangelogEntry({ files, changelogAdded }) {
  const sources = files.filter(path => SOURCE.test(path))
  if (sources.length === 0 || changelogAdded > 0) return undefined
  const shown = sources.slice(0, 5).join(', ') + (sources.length > 5 ? `, and ${sources.length - 5} more` : '')
  return `${shown} changed, but CHANGELOG.md gained no line: add an entry to the release this change goes into (RELEASING.md)`
}

/** The paths that `git diff base head` touches, renames as both paths, and the lines it adds to CHANGELOG.md. */
export function readChange(base, head, cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const files = git(['diff', '--no-renames', '--name-only', '-z', base, head, '--']).split('\0').filter(Boolean)
  // `<added>\t<deleted>\tCHANGELOG.md`, or nothing when the file is unchanged.
  const [added = '0'] = git(['diff', '--no-renames', '--numstat', base, head, '--', 'CHANGELOG.md']).split('\t')
  return { files, changelogAdded: Number.parseInt(added, 10) || 0 }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length !== 2) {
    console.error('usage: node scripts/check-changelog.mjs <base> <head>')
    process.exit(2)
  }
  const change = readChange(args[0], args[1])
  const problem = missingChangelogEntry(change)
  if (problem !== undefined) {
    console.error(problem)
    process.exit(1)
  }
  const sources = change.files.filter(path => SOURCE.test(path)).length
  console.log(
    sources === 0
      ? 'no package source changed'
      : `${sources} source files changed, CHANGELOG.md gained ${change.changelogAdded} lines`
  )
}
