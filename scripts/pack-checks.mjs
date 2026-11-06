// The checks of scripts/check-pack.mjs that need no `npm pack`, apart so
// scripts/pack-checks.test.mjs can test them. Each returns what is wrong, as
// messages; none passes for lack of something to check.
import { posix } from 'node:path'

// The floor of a caret range, `^6.5.0` -> `6.5.0`, or undefined for any other form.
function caretFloor(range) {
  return /^\^(\d+\.\d+\.\d+)$/.exec(range ?? '')?.[1]
}

/**
 * A package's peer dependencies: each optional, a caret range, and its floor
 * the version devDependencies pins, which the workspace installs and CI tests.
 * Dependabot updates the pin alone (it does not read peerDependencies), so the
 * floor is moved by hand in the same pull request.
 */
export function peerProblems(manifest) {
  const problems = []
  for (const [dep, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const floor = caretFloor(range)
    if (floor === undefined) problems.push(`peer dependency ${dep} must be a caret range (^x.y.z), not ${range}`)
    if (manifest.peerDependenciesMeta?.[dep]?.optional !== true)
      problems.push(`peer dependency ${dep} must be optional`)
    if (floor !== undefined && manifest.devDependencies?.[dep] !== floor) {
      problems.push(
        `devDependencies.${dep} must pin the peer range's floor, ${floor}, not ${manifest.devDependencies?.[dep]}: ` +
          'Dependabot updates only the pin, so move the peer floor by hand in the same pull request'
      )
    }
  }
  return problems
}

/** The unpacked size against its ceiling: both must be finite numbers. */
export function sizeProblem(unpackedSize, ceiling) {
  if (!Number.isFinite(ceiling)) return `no size ceiling (${ceiling}): set one in CEILINGS`
  if (!Number.isFinite(unpackedSize)) return `npm reported no unpacked size (${unpackedSize})`
  if (unpackedSize > ceiling) return `${unpackedSize} bytes unpacked is over the ceiling of ${ceiling}`
  return undefined
}

/**
 * A source map's `sources`: each relative to lib/ into the package's src/ (no
 * absolute path, no `.` or `..` segment below src/, so no dependency bundled
 * in), carried as it is in `sourcesContent`, and together every file of
 * `expected`. `read(source)` gives a source file's text.
 */
export function mapProblems(map, { sources, sourcesContent }, expected, read) {
  if (!Array.isArray(sources) || sources.length === 0) return [`${map} has no sources`]
  const problems = []
  for (const [i, source] of sources.entries()) {
    const below = typeof source === 'string' && source.startsWith('../src/') ? source.slice(7).split('/') : []
    if (!/^\.\.\/src\/[\w./-]+\.ts$/.test(source) || below.some(segment => ['', '.', '..'].includes(segment))) {
      problems.push(`${map} maps to ${source}, outside src/`)
    } else {
      let text
      try {
        text = read(source)
      } catch {
        problems.push(`${map} maps to ${source}, which is not in src/`)
        continue
      }
      if (sourcesContent?.[i] !== text) problems.push(`${map} does not carry ${source} as it is in sourcesContent`)
    }
  }
  const missing = expected.filter(source => !sources.includes(source))
  if (missing.length > 0) problems.push(`${map} does not map ${missing.join(', ')}`)
  return problems
}

// The changelog is not in the tarballs; each README links it by absolute URL.
export const CHANGELOG_URL = 'https://github.com/Qbit-Org/qbit-rpc/blob/main/CHANGELOG.md'

/** `text` percent-decoded where it can be, as a browser follows the link. */
function decoded(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * A packed README's relative links that leave the package: npmjs.com shows the
 * README from the tarball, where `../../CHANGELOG.md` resolves to nothing, so
 * those are linked by absolute URL. Inline and reference-style Markdown links,
 * and HTML href and src, quoted or not; code blocks and inline code are not
 * links.
 */
export function linksLeavingPackage(markdown) {
  const prose = markdown.replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '')
  const targets = [
    ...prose.matchAll(/\]\(\s*<?([^)\s>]+)/g),
    ...prose.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)/gm),
    ...prose.matchAll(/\b(?:href|src)\s*=\s*(?:["']([^"']+)["']|([^\s"'>]+))/gi),
  ].map(match => match[1] ?? match[2])
  return targets.filter(target => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#')) return false
    const path = posix.normalize(decoded(target.split(/[?#]/)[0]))
    return path.startsWith('/') || path === '..' || path.startsWith('../')
  })
}

/** A packed README: no relative link out of the package, and a link to the changelog. */
export function readmeProblems(markdown) {
  const problems = []
  const outside = linksLeavingPackage(markdown)
  if (outside.length > 0) problems.push(`README.md links outside the package: ${outside.join(', ')}`)
  if (!markdown.includes(`](${CHANGELOG_URL})`)) problems.push(`README.md does not link ${CHANGELOG_URL}`)
  return problems
}

/** `author` as npm links it: a name and an https URL with a host, not a string. */
export function authorProblem(author) {
  const name = typeof author?.name === 'string' ? author.name.trim() : ''
  let host = ''
  try {
    const url = new URL(author?.url ?? '')
    if (url.protocol === 'https:') host = url.hostname
  } catch {
    // Not a URL.
  }
  if (name !== '' && host !== '') return undefined
  return 'package.json author must be { "name", "url": "https://..." }'
}
