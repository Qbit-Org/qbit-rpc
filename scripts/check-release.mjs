#!/usr/bin/env node
// Check that this checkout can be released as <ref>, before anything is
// installed or built: both packages at the same version, which is the tag's
// (vX.Y.Z or vX.Y.Z-rc.N) or on the release branch's line (release/X.Y),
// ready to publish (no "private"; files, license, LICENSE, engines and
// publishConfig present), and CHANGELOG.md's `## X.Y.Z` section, dated for a
// final release. The publish workflow runs it on the tag; `pack:check` runs
// the same checks in its release mode. RELEASING.md describes the scheme.
//
// Usage: node scripts/check-release.mjs <ref>
//   Prints version=, dist_tag= and line= lines, for $GITHUB_OUTPUT, and exits
//   1 with each problem on stderr when the checkout cannot be released.
// Needs Node.js only: no dependency of this repository is loaded.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PACKAGES, releaseProblems } from './release-checks.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** The manifests, their LICENSE files and CHANGELOG.md, as releaseProblems takes them. */
export function readReleaseInputs(root = repoRoot) {
  const manifests = Object.fromEntries(
    PACKAGES.map(name => {
      const dir = join(root, 'packages', name)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      return [name, { manifest, hasLicenseFile: existsSync(join(dir, 'LICENSE')) }]
    })
  )
  return { manifests, changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8') }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    console.error('usage: node scripts/check-release.mjs <vX.Y.Z | vX.Y.Z-rc.N | release/X.Y>')
    process.exit(2)
  }
  const { version, problems } = releaseProblems(readReleaseInputs(), args[0])
  if (problems.length > 0) {
    for (const problem of problems) console.error(`${args[0]}: ${problem}`)
    process.exit(1)
  }
  console.log(`version=${version.version}`)
  console.log(`dist_tag=${version.distTag}`)
  console.log(`line=${version.line}`)
}
