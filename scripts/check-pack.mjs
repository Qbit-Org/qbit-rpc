#!/usr/bin/env node
// Assert what each package's npm tarball contains.
//
// `npm pack --dry-run` runs the package's `prepack` (a fresh tsup build), so
// this also proves a pack from a clean checkout ships the built `lib/` and not
// a stale or missing one. Fails when the packed file list is not exactly the
// expected one, the unpacked size is over the package's ceiling (or either is
// missing), a source map has no sources, leaves out a file of src/, maps one
// outside src/ or does not carry the source it maps to, the manifest's
// packaging fields or dependency policy have drifted (see docs/packaging.md
// and CONTRIBUTING.md's "Dependency policy"), a package's LICENSE copy has
// drifted from the root LICENSE, a package is not marked private, the packed
// README has a relative link that leaves the package or does not link the
// changelog, or `author` names no organisation URL for npm to link. The checks
// that need no pack are in pack-checks.mjs, which pack-checks.test.mjs tests.
//
// Declaration maps are not shipped, on purpose: tsup bundles the declarations
// into one file per format, and its bundler cannot emit maps for them. The
// JavaScript source maps carry `sourcesContent`. The exact file list below
// fails a `.d.ts.map` or `.d.mts.map` in a tarball until that changes.
// Adapted from Qbit-Org/qbit-js scripts/check-pack.mjs.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authorProblem, mapProblems, peerProblems, readmeProblems, sizeProblem } from './pack-checks.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// Each build ships its bundle, its source map and its declarations; `src/` is
// not shipped, as each map carries the sources in `sourcesContent`.
const FILES = [
  'LICENSE',
  'README.md',
  'lib/index.d.mts',
  'lib/index.d.ts',
  'lib/index.js',
  'lib/index.js.map',
  'lib/index.mjs',
  'lib/index.mjs.map',
  'package.json',
]
// Each map must name every file of src/, all of which go into the build, but
// the ESM one the entry: src/index.ts only re-exports, which the ESM bundle
// merges into its own exports without any code of the file's.
const MAPS = { 'lib/index.js.map': [], 'lib/index.mjs.map': ['../src/index.ts'] }

// Unpacked bytes, about a quarter above the size when the ceiling was last set
// (rpc at 1,817,000, when mining came in; zmq at 224,000, when heartbeats and
// the subscriber's own reconnect came in). Raise one deliberately, in the pull
// request that needs it.
const CEILINGS = { rpc: 2_270_000, zmq: 280_000 }

const packages = ['rpc', 'zmq']
const rootLicense = readFileSync(join(repoRoot, 'LICENSE'), 'utf8')
let failed = false

function fail(message) {
  failed = true
  console.error(`  ${message}`)
}

// Every TypeScript source under `dir`, as a map's `sources` names it from lib/: `../src/a/b.ts`.
function sourceFiles(cwd, dir = join(cwd, 'src')) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(cwd, path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [relative(join(cwd, 'lib'), path)] : []
  })
}

for (const name of packages) {
  const cwd = join(repoRoot, 'packages', name)
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  console.log(`packages/${name}`)
  // Nothing in this repository may be published by accident.
  if (manifest.private !== true || manifest.version !== '0.0.0') {
    fail(`package.json must stay "private": true at version 0.0.0`)
  }
  if (readFileSync(join(cwd, 'LICENSE'), 'utf8') !== rootLicense) {
    fail(`LICENSE differs from the root LICENSE`)
  }
  const author = authorProblem(manifest.author)
  if (author !== undefined) fail(author)
  readmeProblems(readFileSync(join(cwd, 'README.md'), 'utf8')).forEach(fail)
  // No module runs code at import that a consumer relies on (the error brands
  // are set on the package's own prototypes), so a bundler may drop the
  // package when nothing from it is used.
  if (manifest.sideEffects !== false) fail(`package.json must set "sideEffects": false`)
  // The CommonJS build is lib/index.js: "type": "module" would make Node.js
  // read it as ESM.
  if ('type' in manifest) fail(`package.json must not set "type"; the CommonJS build is lib/index.js`)
  // optionalDependencies are installed too, so they count as runtime dependencies.
  for (const field of ['dependencies', 'optionalDependencies']) {
    const names = Object.keys(manifest[field] ?? {})
    if (names.length > 0) fail(`no runtime dependencies are allowed, found ${field} ${names.join(', ')}`)
  }
  peerProblems(manifest).forEach(fail)
  if (name === 'zmq' && manifest.peerDependencies?.zeromq === undefined) {
    fail('zeromq must be an optional peer dependency')
  }

  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts=false'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  // prepack's build log shares stdout with npm's JSON, which comes last.
  const json = out.startsWith('[') ? out : out.slice(out.lastIndexOf('\n[') + 1)
  const [pack] = JSON.parse(json)
  const files = pack.files.map(file => file.path).sort()
  console.log(
    `${pack.name}@${pack.version}: ${files.length} files, ${pack.unpackedSize} bytes unpacked, ${pack.size} packed`
  )
  const missing = FILES.filter(path => !files.includes(path))
  const unexpected = files.filter(path => !FILES.includes(path))
  if (missing.length > 0) fail(`missing: ${missing.join(', ')}`)
  if (unexpected.length > 0) fail(`unexpected: ${unexpected.join(', ')}`)
  const size = sizeProblem(pack.unpackedSize, CEILINGS[name])
  if (size !== undefined) fail(size)

  // npm pack built lib/ in place: these are the maps it packed.
  const srcFiles = sourceFiles(cwd).sort()
  for (const [map, unmapped] of Object.entries(MAPS)) {
    const parsed = JSON.parse(readFileSync(join(cwd, map), 'utf8'))
    const expected = srcFiles.filter(source => !unmapped.includes(source))
    mapProblems(map, parsed, expected, source => readFileSync(join(cwd, 'lib', source), 'utf8')).forEach(fail)
  }
}

if (failed) process.exit(1)
console.log('pack check: PASS')
