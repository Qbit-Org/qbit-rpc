// The release checks of scripts/check-release.mjs and scripts/check-pack.mjs,
// apart so scripts/release-checks.test.mjs can test them without a pack or a
// tag. RELEASING.md describes the versioning they enforce: both packages in
// lockstep, `X.Y.Z` under the npm dist-tag `latest` and `X.Y.Z-rc.N` under
// `candidate`, cut on `release/X.Y`, each with its `## X.Y.Z` section in
// CHANGELOG.md. Each check returns what is wrong, as messages; none passes for
// lack of something to check.

/** The packages that release together, by directory under packages/. */
export const PACKAGES = ['rpc', 'zmq']

/** What every published manifest sets, so npm publishes it publicly and with provenance. */
export const PUBLISH_CONFIG = { access: 'public', provenance: true }

const N = '(0|[1-9][0-9]*)'
const FINAL = new RegExp(`^${N}\\.${N}\\.${N}$`)
const CANDIDATE = new RegExp(`^${N}\\.${N}\\.${N}-rc\\.${N}$`)
const LINE = new RegExp(`^${N}\\.${N}$`)

/**
 * A release version: `X.Y.Z` (final, dist-tag `latest`) or `X.Y.Z-rc.N`
 * (candidate, dist-tag `candidate`), with its release line `X.Y` and the final
 * version it leads to. Undefined for any other string, `0.0.0` included.
 */
export function parseVersion(version) {
  if (typeof version !== 'string') return undefined
  const match = FINAL.exec(version) ?? CANDIDATE.exec(version)
  if (match === null || version === '0.0.0') return undefined
  const [, major, minor, patch] = match
  const final = match.length === 4
  return {
    version,
    final,
    distTag: final ? 'latest' : 'candidate',
    line: `${major}.${minor}`,
    release: `${major}.${minor}.${patch}`,
  }
}

/**
 * What a release is checked against: a tag `vX.Y.Z` or `vX.Y.Z-rc.N`, which
 * names the exact version, or a release branch `release/X.Y`, which takes any
 * release version of that line. Undefined for anything else.
 */
export function parseReleaseRef(ref) {
  if (typeof ref !== 'string') return undefined
  if (ref.startsWith('v')) {
    const parsed = parseVersion(ref.slice(1))
    return parsed && { kind: 'tag', ref, ...parsed }
  }
  const line = ref.startsWith('release/') ? ref.slice('release/'.length) : undefined
  return line !== undefined && LINE.test(line) ? { kind: 'branch', ref, line } : undefined
}

/** Outside a release: the private/0.0.0 guard, so nothing here is published by accident. */
export function devManifestProblems(manifest) {
  return manifest.private === true && manifest.version === '0.0.0'
    ? []
    : ['package.json must stay "private": true at version 0.0.0 outside a release (see RELEASING.md)']
}

/** `publishConfig` is exactly {@link PUBLISH_CONFIG}, in a release and outside one. */
export function publishConfigProblems(manifest) {
  const config = manifest.publishConfig
  const ok =
    config !== null &&
    typeof config === 'object' &&
    !Array.isArray(config) &&
    Object.keys(config).length === Object.keys(PUBLISH_CONFIG).length &&
    Object.entries(PUBLISH_CONFIG).every(([key, value]) => Object.hasOwn(config, key) && config[key] === value)
  return ok ? [] : [`package.json must set "publishConfig": ${JSON.stringify(PUBLISH_CONFIG)}`]
}

/**
 * A manifest about to be published for `target` (from {@link parseReleaseRef}):
 * its version is the tag's, or on the branch's line; `private` is absent; and
 * `files`, `license` and `engines.node` are present. `hasLicenseFile` says
 * whether the package directory holds a LICENSE, which npm ships from there.
 */
export function releaseManifestProblems(manifest, target, hasLicenseFile) {
  const problems = []
  const version = parseVersion(manifest.version)
  if (target.kind === 'tag' && manifest.version !== target.version) {
    problems.push(`version ${manifest.version} is not the tag's: ${target.ref} needs ${target.version}`)
  } else if (target.kind === 'branch' && version?.line !== target.line) {
    problems.push(`version ${manifest.version} is not X.Y.Z or X.Y.Z-rc.N on ${target.ref}'s line ${target.line}`)
  }
  if (Object.hasOwn(manifest, 'private')) problems.push('package.json must not set "private" in a release')
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) problems.push('package.json must list "files"')
  if (typeof manifest.license !== 'string' || manifest.license === '') problems.push('package.json must set "license"')
  if (!hasLicenseFile) problems.push('the package directory must hold a LICENSE')
  if (typeof manifest.engines?.node !== 'string' || manifest.engines.node === '') {
    problems.push('package.json must set "engines": { "node": ... }')
  }
  return problems
}

/** Both packages share one version: `versions` maps each package to its own. */
export function lockstepProblems(versions) {
  const distinct = new Set(Object.values(versions))
  if (distinct.size === 1) return []
  const list = Object.entries(versions).map(([name, version]) => `${name} ${version}`)
  return [`the packages release in lockstep, but their versions differ: ${list.join(', ')}`]
}

/**
 * The `## X.Y.Z` heading for a release, and the lines under it up to the next
 * `## `. Undefined when CHANGELOG.md has none, or more than one.
 */
export function changelogSection(changelog, release) {
  const lines = changelog.split(/\r?\n/)
  const starts = lines.flatMap((line, i) => (line === `## ${release}` || line.startsWith(`## ${release} `) ? [i] : []))
  if (starts.length !== 1) return undefined
  const [start] = starts
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
  return { heading: lines[start], body: lines.slice(start + 1, end === -1 ? undefined : end) }
}

/**
 * CHANGELOG.md for `version` (a {@link parseVersion} result): one `## X.Y.Z`
 * section, for a candidate too, which ships what that section says so far. A
 * final release's heading carries its date, `## X.Y.Z - YYYY-MM-DD`; while it
 * is collecting, it reads `## X.Y.Z (unreleased)`. With `requireContent`, as
 * for a tag, the section must hold something: on a release branch it may be
 * empty, just opened after a release.
 */
export function changelogProblems(changelog, version, { requireContent = true } = {}) {
  const section = changelogSection(changelog, version.release)
  if (section === undefined) return [`CHANGELOG.md must have exactly one '## ${version.release}' section`]
  const problems = []
  if (requireContent && !section.body.some(line => line.trim() !== '')) {
    problems.push(`CHANGELOG.md's '${section.heading}' section is empty`)
  }
  if (version.final) {
    const date = new RegExp(`^## ${version.release.replaceAll('.', '\\.')} - (\\d{4}-\\d{2}-\\d{2})$`).exec(
      section.heading
    )
    const day = date === null ? undefined : new Date(`${date[1]}T00:00:00Z`)
    const valid = day !== undefined && !Number.isNaN(day.getTime()) && day.toISOString().startsWith(date[1])
    if (!valid)
      problems.push(
        `CHANGELOG.md's heading for a final release must be '## ${version.release} - YYYY-MM-DD', not '${section.heading}'`
      )
  }
  return problems
}

/**
 * Every release check that needs no pack, for `ref`: the manifests in lockstep
 * at a version the ref allows, ready to publish, and CHANGELOG.md's section.
 * `manifests` maps each package to `{ manifest, hasLicenseFile }`. Returns the
 * version (a {@link parseVersion} result, when the versions agree and parse)
 * and the problems.
 */
export function releaseProblems({ manifests, changelog }, ref) {
  const target = parseReleaseRef(ref)
  if (target === undefined) {
    return { problems: [`${JSON.stringify(ref)} is no release tag (vX.Y.Z, vX.Y.Z-rc.N) or branch (release/X.Y)`] }
  }
  const problems = []
  for (const [name, { manifest, hasLicenseFile }] of Object.entries(manifests)) {
    for (const problem of [
      ...releaseManifestProblems(manifest, target, hasLicenseFile),
      ...publishConfigProblems(manifest),
    ]) {
      problems.push(`packages/${name}: ${problem}`)
    }
  }
  const versions = Object.fromEntries(Object.entries(manifests).map(([name, { manifest }]) => [name, manifest.version]))
  const lockstep = lockstepProblems(versions)
  problems.push(...lockstep)
  const version = lockstep.length === 0 ? parseVersion(Object.values(versions)[0]) : undefined
  if (version !== undefined)
    problems.push(...changelogProblems(changelog, version, { requireContent: target.kind === 'tag' }))
  return { version, problems }
}
