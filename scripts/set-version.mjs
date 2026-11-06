#!/usr/bin/env node
// Set both packages' version in one step, as they release in lockstep
// (RELEASING.md):
//
//   corepack pnpm release:version 0.1.0-rc.0
//
// A release version, X.Y.Z or X.Y.Z-rc.N, goes into packages/rpc and
// packages/zmq, and their "private": true comes out, as a release branch
// carries them. `0.0.0` puts both back to "private": true at 0.0.0, as `main`
// keeps them: a back-merge from a release branch runs it. Nothing else in the
// manifests changes, and their key order and formatting are kept. It then
// runs the release checks that need no pack for the new version, and prints
// what they find: CHANGELOG.md is usually edited after the bump. It commits,
// tags and publishes nothing.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readReleaseInputs } from './check-release.mjs'
import { PACKAGES, parseVersion, releaseProblems } from './release-checks.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * `manifest` at `version`: a release version without `private`, or `0.0.0`
 * with `"private": true` right after `version`. The other keys keep their
 * order. Throws a TypeError for any other version, or a manifest without one.
 */
export function withVersion(manifest, version) {
  const dev = version === '0.0.0'
  if (!dev && parseVersion(version) === undefined) {
    throw new TypeError(`${JSON.stringify(version)} is not X.Y.Z, X.Y.Z-rc.N or 0.0.0`)
  }
  if (!Object.hasOwn(manifest, 'version')) throw new TypeError('the manifest has no "version" to set')
  const entries = []
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'private') continue
    if (key !== 'version') {
      entries.push([key, value])
      continue
    }
    entries.push(['version', version])
    if (dev) entries.push(['private', true])
  }
  return Object.fromEntries(entries)
}

/** The manifest text as npm and pnpm write it, which this script keeps. */
const format = manifest => `${JSON.stringify(manifest, null, 2)}\n`

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    console.error('usage: corepack pnpm release:version <X.Y.Z | X.Y.Z-rc.N | 0.0.0>')
    process.exit(2)
  }
  const [version] = args
  const updates = PACKAGES.map(name => {
    const path = join(repoRoot, 'packages', name, 'package.json')
    const text = readFileSync(path, 'utf8')
    const manifest = JSON.parse(text)
    // Writing back what JSON.stringify makes must change nothing but the
    // version and "private": refuse a manifest formatted any other way.
    if (format(manifest) !== text) throw new Error(`${path} is not formatted as npm writes it; nothing was changed`)
    return { name, path, from: manifest.version, text: format(withVersion(manifest, version)) }
  })
  for (const { name, path, from, text } of updates) {
    writeFileSync(path, text)
    console.log(`@qbit-oss/${name}: ${from} -> ${version}${version === '0.0.0' ? ', "private": true' : ''}`)
  }
  if (version !== '0.0.0') {
    const parsed = parseVersion(version)
    const { problems } = releaseProblems(readReleaseInputs(repoRoot), `release/${parsed.line}`)
    for (const problem of problems) console.log(`still to do before a release: ${problem}`)
    console.log(
      `published from release/${parsed.line} under the dist-tag ${parsed.distTag}, by pushing the tag v${version}`
    )
  }
}
