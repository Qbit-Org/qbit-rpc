#!/usr/bin/env node
// Download the qbit Core release named in qbit-core-release.mjs and verify it
// before anything in it runs, the way qbit's ci/release/validate_release_artifacts.py
// does:
//
// 0. The release key policy has one source of truth, qbit's own
//    contrib/keys/operator-keys/. qbit-release-keys/pin.json pins it: a qbit
//    commit, the SHA-256 of its keys.json (the digest qbit's policy approvals
//    sign) and of each signer's certificate, which keys.json does not cover.
//    keys.json and the certificates are downloaded from that commit, and each
//    must have its pinned digest before it is written to disk or read.
// 1. SHA256SUMS and SHA256SUMS.asc (the operators' detached signatures,
//    concatenated) from the release on github.com/Qbit-Org/qbit.
// 2. gpg, in a temporary GnuPG home holding only the pinned certificates,
//    verifies SHA256SUMS.asc over SHA256SUMS. Every signature must be good and
//    made by the signing subkey keys.json lists, under the primary key the pin
//    lists, for a signer keys.json makes active for the release line, and the
//    distinct signers must reach that line's release_signature_quorum. Only
//    gpg's --status-fd lines are read.
// 3. The asset's digest comes from the verified SHA256SUMS, which must have no
//    malformed line and no name twice.
// 4. The tarball must have that SHA-256 before it is written to disk or
//    extracted, and only qbitd and qbit-cli are used from it.
//
// Usage (logs go to stderr):
//   qbit-release.mjs sums <sums-dir>
//     Steps 0-3 into <sums-dir>, which must not exist; the policy goes into
//     <sums-dir>/policy/. Prints asset=, sha256=, cache-key= and signers=
//     lines, for $GITHUB_OUTPUT.
//   qbit-release.mjs install <sums-dir> <tarball-dir> <dest-dir>
//     Verifies <sums-dir>, its policy included, against the pin again, and
//     uses <tarball-dir>/<asset> if it has the verified digest (a restored
//     cache entry); otherwise deletes it and downloads the asset, once.
//     Extracts it into <dest-dir>, which must not exist, and prints bin-dir=.
//   qbit-release.mjs fetch <dir>
//     Both, into <dir>, which must not exist. Prints the bin directory.
//   qbit-release.mjs pin <qbit-commit>
//     Prints a pin.json for the policy at <qbit-commit>, for review. The commit
//     must be on main, 1.x.x or a release tag, and the policy the pinned one or
//     its direct successor: previous_policy_sha256 is the pinned digest and
//     policy_sequence one more (qbit-release-keys/README.md).
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { QBIT_CORE_VERSION } from './qbit-core-release.mjs'

export const PIN = fileURLToPath(new URL('./qbit-release-keys/pin.json', import.meta.url))
// Where qbit keeps its release key policy, read at the pinned commit.
const POLICY_SOURCE = 'https://raw.githubusercontent.com/Qbit-Org/qbit'
const POLICY_PATH = 'contrib/keys/operator-keys'
const POLICY_DIR = 'policy'
const EXECUTABLES = ['qbitd', 'qbit-cli']
const SUMS = 'SHA256SUMS'
const SIGNATURES = 'SHA256SUMS.asc'
// v1.0.0's are 2,013 and 758 bytes, and its largest non-debug tarball 88 MB;
// its keys.json is 2,951 bytes, and each certificate under 1 KB.
const MAX_SUMS_BYTES = 64 * 1024
const MAX_SIGNATURES_BYTES = 64 * 1024
const MAX_TARBALL_BYTES = 512 * 1024 * 1024
const MAX_POLICY_BYTES = 64 * 1024
const MAX_CERTIFICATE_BYTES = 64 * 1024
// As qbit's ci/release/validate_key_metadata.py accepts them.
const SIGNER_ALIAS = /^[a-z0-9][a-z0-9-]{2,31}$/
const POLICY_ID = /^[a-z0-9][a-z0-9-]{2,127}$/
const STATUSES = new Set(['active', 'rotated', 'revoked', 'lost'])
const FINGERPRINT = /^[0-9A-F]{40}$/
const DIGEST = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
// VALIDSIG hash algorithms (RFC 9580): SHA2-256, -384, -512 and -224, SHA3-256 and -512.
const HASH_ALGORITHMS = new Set(['8', '9', '10', '11', '12', '14'])
// Signatures over a binary or a text document.
const DOCUMENT_CLASSES = new Set(['00', '01'])
// Status keywords for a signature or input gpg did not accept.
const REFUSED = new Set([
  'BADSIG',
  'ERRSIG',
  'EXPSIG',
  'EXPKEYSIG',
  'REVKEYSIG',
  'NO_PUBKEY',
  'NODATA',
  'BADARMOR',
  'FAILURE',
])
const TARGETS = {
  linux: { x64: 'x86_64-linux-gnu', arm64: 'aarch64-linux-gnu' },
  darwin: { x64: 'x86_64-apple-darwin-unsigned', arm64: 'arm64-apple-darwin-unsigned' },
}

const log = message => process.stderr.write(`qbit-release: ${message}\n`)
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Everything derived from the version: tag, release line, asset, cache key. */
export function release(version = QBIT_CORE_VERSION, platform = process.platform, arch = process.arch) {
  if (!/^\d+\.\d+\.\d+(-[0-9a-z][0-9a-z.-]*)?$/.test(version)) throw new Error(`malformed qbit Core version ${version}`)
  const target = TARGETS[platform]?.[arch]
  if (target === undefined) throw new Error(`qbit Core ${version} has no release asset for ${platform}/${arch}`)
  const tag = `v${version}`
  return {
    version,
    tag,
    // qbit's validate_release_artifacts.py requires "testnet" in a testnet
    // release's version, and refuses it in a mainnet one's.
    line: version.includes('testnet') ? 'testnet' : 'mainnet',
    baseUrl: `https://github.com/Qbit-Org/qbit/releases/download/${tag}`,
    asset: `qbit-${version}-${target}.tar.gz`,
    root: `qbit-${version}`,
    cacheKey: digest => `qbit-core-${version}-${platform}-${arch}-${digest}`,
  }
}

/**
 * SHA256SUMS as a map from file name to digest. Every line must be
 * `<64 hex> <space or *><basename>`; a blank, escaped or malformed line, or a
 * name listed twice, is refused, as qbit's validator refuses them.
 */
export function parseSha256Sums(bytes) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${SUMS} is not UTF-8`)
  }
  if (!text.endsWith('\n')) throw new Error(`${SUMS} is empty or does not end with a newline`)
  const entries = new Map()
  text
    .slice(0, -1)
    .split('\n')
    .forEach((line, index) => {
      const where = `${SUMS}:${index + 1}`
      const match = /^([0-9a-fA-F]{64}) [ *]([^\s/\\]+)$/.exec(line)
      if (match === null || match[2].startsWith('.')) throw new Error(`${where}: malformed line`)
      const [, digest, name] = match
      if (entries.has(name)) throw new Error(`${where}: ${name} is listed twice`)
      entries.set(name, digest.toLowerCase())
    })
  return entries
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Appended to every refusal that a new qbit key policy can cause.
const BUMP = 'if qbit has published a new key policy, update scripts/qbit-release-keys/pin.json as its README says'

/**
 * The pin in `file`: `commit`, the qbit commit to take the policy from;
 * `policy_id` and `policy_sha256`, keys.json's; and for each signer keys.json
 * lists, the SHA-256 of its certificate and its primary key's fingerprint.
 */
export function readPin(file = PIN) {
  let pin
  try {
    pin = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: ${error.message}`)
  }
  const fail = problem => {
    throw new Error(`${file}: ${problem}`)
  }
  const fields = ['commit', 'policy_id', 'policy_sha256', 'signers']
  if (!isObject(pin) || Object.keys(pin).sort().join() !== fields.sort().join()) {
    fail(`must hold exactly ${fields.join(', ')}`)
  }
  if (!COMMIT.test(pin.commit)) fail(`malformed commit ${pin.commit}`)
  if (!POLICY_ID.test(pin.policy_id)) fail(`malformed policy_id ${pin.policy_id}`)
  if (!DIGEST.test(pin.policy_sha256)) fail(`malformed policy_sha256 ${pin.policy_sha256}`)
  if (!isObject(pin.signers) || Object.keys(pin.signers).length === 0) fail('no signers')
  for (const [alias, signer] of Object.entries(pin.signers)) {
    if (!SIGNER_ALIAS.test(alias)) fail(`malformed signer alias ${alias}`)
    if (!isObject(signer) || Object.keys(signer).sort().join() !== 'certificate_sha256,primary_fingerprint') {
      fail(`${alias} must hold exactly certificate_sha256 and primary_fingerprint`)
    }
    if (!DIGEST.test(signer.certificate_sha256)) fail(`${alias}: malformed certificate_sha256`)
    if (!FINGERPRINT.test(signer.primary_fingerprint)) fail(`${alias}: malformed primary_fingerprint`)
  }
  return pin
}

const policyUrl = (commit, file) => `${POLICY_SOURCE}/${commit}/${POLICY_PATH}/${file}`

/**
 * keys.json's signers, from its bytes, which must be UTF-8 JSON with schema
 * version 2: each with a well-formed alias, status, certificate file and
 * signing fingerprint, no alias or signing key listed twice. Fingerprints are
 * normalized as qbit's validator does.
 */
export function parsePolicy(bytes) {
  let policy
  try {
    policy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('keys.json is not UTF-8 JSON')
  }
  if (!isObject(policy)) throw new Error('keys.json is not a JSON object')
  if (policy.schema_version !== 2) throw new Error(`keys.json: schema_version ${policy.schema_version}, not 2`)
  if (!Array.isArray(policy.signers) || policy.signers.length === 0) throw new Error('keys.json: no signers')
  const aliases = new Set()
  const keys = new Set()
  const signers = policy.signers.map((entry, index) => {
    const where = `keys.json: signers[${index}]`
    if (!isObject(entry)) throw new Error(`${where} is not an object`)
    const text = key => (typeof entry[key] === 'string' ? entry[key].trim() : '')
    const alias = text('alias')
    if (!SIGNER_ALIAS.test(alias)) throw new Error(`${where}: malformed alias`)
    if (aliases.has(alias)) throw new Error(`keys.json: ${alias} is listed twice`)
    aliases.add(alias)
    const signing = text('signing_fingerprint').replace(/\s+/g, '').toUpperCase()
    if (!FINGERPRINT.test(signing)) throw new Error(`keys.json: ${alias} has a malformed signing_fingerprint`)
    if (keys.has(signing)) throw new Error(`keys.json: signing key ${signing} is listed twice`)
    keys.add(signing)
    const status = text('status')
    if (!STATUSES.has(status)) throw new Error(`keys.json: ${alias} has unknown status ${status}`)
    const file = text('public_key_file')
    if (!/^public-keys\/[^/\\.][^/\\]*\.asc$/.test(file) || file.includes('..')) {
      throw new Error(`keys.json: ${alias} has public_key_file ${entry.public_key_file}`)
    }
    const list = key => {
      if (!Array.isArray(entry[key]) || entry[key].some(item => typeof item !== 'string')) {
        throw new Error(`keys.json: ${alias} has no ${key} list`)
      }
      return entry[key].map(item => item.trim())
    }
    return { alias, status, file, signing, releaseLines: list('release_lines'), capabilities: list('capabilities') }
  })
  return { policy, signers }
}

/**
 * keys.json's bytes as the pin allows them: with the pinned SHA-256 and
 * policy_id, and naming exactly the pinned signers.
 */
function pinnedPolicy(bytes, pin) {
  const digest = sha256(bytes)
  if (digest !== pin.policy_sha256) {
    throw new Error(`keys.json has SHA-256 ${digest}, not the pinned ${pin.policy_sha256}: refusing it; ${BUMP}`)
  }
  const parsed = parsePolicy(bytes)
  if (parsed.policy.policy_id !== pin.policy_id) {
    throw new Error(`keys.json: policy_id ${parsed.policy.policy_id}, not the pinned ${pin.policy_id}; ${BUMP}`)
  }
  const aliases = parsed.signers.map(signer => signer.alias)
  const pinned = Object.keys(pin.signers)
  if (aliases.length !== pinned.length || pinned.some(alias => !aliases.includes(alias))) {
    throw new Error(`keys.json lists signers ${aliases.join(', ')}, the pin ${pinned.join(', ')}; ${BUMP}`)
  }
  return parsed
}

/** Refuse `bytes` unless they have the pinned certificate digest for `signer`. */
function checkCertificate(bytes, signer, pin) {
  const expected = pin.signers[signer.alias].certificate_sha256
  const digest = sha256(bytes)
  if (digest !== expected) {
    throw new Error(`${signer.file} has SHA-256 ${digest}, not the pinned ${expected}: refusing it; ${BUMP}`)
  }
}

/**
 * Step 0: download the pinned policy into `dir`, which must not exist:
 * keys.json and every signer's certificate, each written only once it has its
 * pinned digest.
 */
export async function fetchPolicy(dir, { pin = readPin(), fetchBytes = download } = {}) {
  mkdirSync(dir)
  mkdirSync(join(dir, 'public-keys'))
  const policy = await fetchBytes(policyUrl(pin.commit, 'keys.json'), MAX_POLICY_BYTES)
  const { signers } = pinnedPolicy(policy, pin)
  writeFileSync(join(dir, 'keys.json'), policy)
  for (const signer of signers) {
    const certificate = await fetchBytes(policyUrl(pin.commit, signer.file), MAX_CERTIFICATE_BYTES)
    checkCertificate(certificate, signer, pin)
    writeFileSync(join(dir, signer.file), certificate)
  }
  log(`key policy ${pin.policy_id} (keys.json ${pin.policy_sha256}) from qbit ${pin.commit}`)
}

/**
 * The signers that count for `line`, from the policy in `keysDir`, checked
 * against the pin again: those keys.json makes active release signers for
 * it, with the primary-key fingerprint from the pin. As in qbit's validator,
 * the line's active signers must number exactly its active_signer_set_size,
 * and its release-signing signers must be able to reach its quorum.
 */
export function loadSigners(keysDir, line, pin = readPin()) {
  const { policy, signers: all } = pinnedPolicy(readFileSync(join(keysDir, 'keys.json')), pin)
  // Each certificate is read once: gpg imports these checked bytes, never the file again.
  const certificates = new Map()
  for (const signer of all) {
    const bytes = readFileSync(join(keysDir, signer.file))
    checkCertificate(bytes, signer, pin)
    certificates.set(signer.alias, bytes)
  }
  const settings = isObject(policy.release_lines) ? policy.release_lines[line] : undefined
  const quorum = settings?.release_signature_quorum
  const size = settings?.active_signer_set_size
  if (!Number.isSafeInteger(quorum) || quorum < 1) throw new Error(`keys.json: no release_signature_quorum for ${line}`)
  if (!Number.isSafeInteger(size) || size < quorum) {
    throw new Error(`keys.json: ${line} active_signer_set_size ${size} is not at least its quorum ${quorum}`)
  }
  const active = all.filter(signer => signer.status === 'active' && signer.releaseLines.includes(line))
  if (active.length !== size) {
    throw new Error(`keys.json: ${active.length} active ${line} signers, not its active_signer_set_size ${size}`)
  }
  const signers = active
    .filter(signer => signer.capabilities.includes('release-signing'))
    .map(signer => ({
      alias: signer.alias,
      primary: pin.signers[signer.alias].primary_fingerprint,
      signing: signer.signing,
      file: join(keysDir, signer.file),
      certificate: certificates.get(signer.alias),
    }))
  if (signers.length < quorum)
    throw new Error(`keys.json: ${signers.length} ${line} signers cannot reach quorum ${quorum}`)
  return { line, quorum, signers }
}

/** Run `fn` with a new, empty GnuPG home, removed afterwards. */
function withGnupgHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'qbit-release-gnupg-'))
  try {
    return fn(home)
  } finally {
    // Every gpg call uses --no-autostart, so no agent should be running.
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'], { stdio: 'ignore' })
    rmSync(home, { recursive: true, force: true })
  }
}

const gpgArgs = home => ['--homedir', home, '--batch', '--no-tty', '--no-autostart']

function gpg(args, input) {
  const result = spawnSync('gpg', args, { encoding: 'utf8', ...(input === undefined ? {} : { input }) })
  if (result.error !== undefined) throw new Error(`could not run gpg: ${result.error.message}`)
  return result
}

/** From gpg's --with-colons --fingerprint listing: primary fingerprint -> fingerprints of the primary and its subkeys. */
function listedKeys(listing) {
  const keys = new Map()
  let record
  for (const fields of listing.split('\n').map(text => text.split(':'))) {
    if (fields[0] === 'pub' || fields[0] === 'sub') record = fields[0]
    else if (fields[0] === 'fpr' && record === 'pub') keys.set(fields[9], new Set([fields[9]]))
    else if (fields[0] === 'fpr' && record === 'sub') [...keys.values()].at(-1)?.add(fields[9])
    if (fields[0] === 'fpr') record = undefined
  }
  return keys
}

/**
 * Import each signer's certificate, the bytes checked against the pin, from
 * stdin, and check the keyring holds exactly those keys.
 */
function importSigners(home, signers) {
  for (const signer of signers) {
    const result = gpg([...gpgArgs(home), '--import'], signer.certificate)
    if (result.status !== 0) throw new Error(`gpg could not import ${signer.file}:\n${result.stderr}`)
  }
  const listing = gpg([...gpgArgs(home), '--with-colons', '--fingerprint', '--list-keys'])
  if (listing.status !== 0) throw new Error(`gpg could not list the imported keys:\n${listing.stderr}`)
  const keys = listedKeys(listing.stdout)
  const expected = signers.map(signer => signer.primary).sort()
  if (JSON.stringify([...keys.keys()].sort()) !== JSON.stringify(expected)) {
    throw new Error(`the certificates hold primary keys ${[...keys.keys()].join(', ')}, not ${expected.join(', ')}`)
  }
  for (const signer of signers) {
    if (!keys.get(signer.primary).has(signer.signing)) {
      throw new Error(`${signer.file} has no key ${signer.signing}`)
    }
  }
}

/**
 * The distinct signers in `gpg --verify --status-fd` output, `status`: every
 * signature must be good (one GOODSIG and one VALIDSIG, nothing refused) and
 * made by a listed signing subkey under its listed primary key, and there must
 * be at least `quorum` signers.
 */
export function countSignatures(status, exitCode, { line, quorum, signers }) {
  const groups = []
  for (const text of status.split('\n')) {
    if (!text.startsWith('[GNUPG:] ')) continue
    const [keyword, ...args] = text.slice('[GNUPG:] '.length).split(' ')
    if (REFUSED.has(keyword)) throw new Error(`gpg refused a signature: ${text}`)
    if (keyword === 'NEWSIG') groups.push([])
    else groups.at(-1)?.push({ keyword, args })
  }
  if (exitCode !== 0) throw new Error(`gpg --verify exited with ${exitCode}`)
  if (groups.length === 0) throw new Error(`${SIGNATURES} holds no signature`)
  const counted = new Map()
  for (const group of groups) {
    const good = group.filter(item => item.keyword === 'GOODSIG')
    const valid = group.filter(item => item.keyword === 'VALIDSIG')
    if (good.length !== 1 || valid.length !== 1 || valid[0].args.length < 10) {
      throw new Error('gpg reported a signature without one GOODSIG and one VALIDSIG')
    }
    const [fingerprint, , , , , , , hash, sigClass, primary] = valid[0].args
    if (!HASH_ALGORITHMS.has(hash) || !DOCUMENT_CLASSES.has(sigClass) || !fingerprint.endsWith(good[0].args[0])) {
      throw new Error(`unexpected signature: VALIDSIG ${valid[0].args.join(' ')}`)
    }
    const signer = signers.find(item => item.signing === fingerprint && item.primary === primary)
    if (signer === undefined) throw new Error(`${fingerprint} (primary ${primary}) is not a ${line} release signer`)
    counted.set(signer.alias, signer)
  }
  if (counted.size < quorum) {
    throw new Error(
      `${counted.size} distinct ${line} signers (${[...counted.keys()].join(', ')}), not the ${quorum} required`
    )
  }
  return [...counted.values()].sort((a, b) => a.alias.localeCompare(b.alias))
}

/**
 * Verify `<dir>/SHA256SUMS.asc` over `<dir>/SHA256SUMS`, and return the
 * signers and the parsed SHA256SUMS.
 */
export function verifySums(dir, { line, pin = readPin(), keysDir = join(dir, POLICY_DIR) }) {
  return verifySignatures(dir, loadSigners(keysDir, line, pin), pin)
}

/**
 * Verify `<dir>/SHA256SUMS.asc` over `<dir>/SHA256SUMS` with the signers
 * loadSigners returned: gpg imports the certificate bytes it checked, so the
 * policy files are not read again.
 */
export function verifySignatures(dir, policy, pin) {
  // gpg verifies these bytes, from stdin, and only these are parsed.
  const sums = readFileSync(join(dir, SUMS))
  const signers = withGnupgHome(home => {
    importSigners(home, policy.signers)
    const verify = ['--trust-model', 'always', '--status-fd', '1', '--verify', join(dir, SIGNATURES), '-']
    const result = gpg([...gpgArgs(home), ...verify], sums)
    try {
      return countSignatures(result.stdout, result.status, policy)
    } catch (error) {
      // A release signed under a newer policy than the pinned one fails here.
      throw new Error(`${error.message} (checked against the pinned key policy ${pin.policy_id}; ${BUMP})`)
    }
  })
  return { quorum: policy.quorum, signers, entries: parseSha256Sums(sums) }
}

export async function download(url, maxBytes) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error(`GET ${url}: over ${maxBytes} bytes`)
  const chunks = []
  let total = 0
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength
    if (total > maxBytes) throw new Error(`GET ${url}: over ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const GITHUB_API = 'https://api.github.com/repos/Qbit-Org/qbit'
// A pinned policy must come from qbit's own history: a commit these protected
// branches contain, or a release tag's. raw.githubusercontent.com serves any
// commit in the repository network, forks' included.
const PROTECTED_BRANCHES = ['main', '1.x.x']
const RELEASE_TAG = /^v[0-9]/

/** GET a GitHub API URL as JSON; `undefined` for a 404. GITHUB_TOKEN, if set, raises the rate limit. */
export async function githubJson(url) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (response.status === 404) return undefined
  if (!response.ok) {
    throw new Error(`GET ${url}: HTTP ${response.status}; set GITHUB_TOKEN if GitHub's API rate limit was reached`)
  }
  return response.json()
}

/**
 * Where qbit `commit` is reachable from: a protected branch or a release tag
 * that contains it, by GitHub's compare API (`identical`, or `behind`: the
 * commit is an ancestor). Refuses a commit reachable from none.
 */
export async function reachableFrom(commit, { getJson = githubJson } = {}) {
  const contains = async base => {
    const compare = await getJson(`${GITHUB_API}/compare/${base}...${commit}`)
    return compare?.status === 'identical' || compare?.status === 'behind'
  }
  for (const branch of PROTECTED_BRANCHES) {
    if (await contains(branch)) return `branch ${branch}`
  }
  const tags = (await getJson(`${GITHUB_API}/tags?per_page=100`)) ?? []
  for (const tag of tags.filter(tag => RELEASE_TAG.test(tag?.name ?? ''))) {
    if (tag.commit?.sha === commit || (await contains(tag.commit?.sha))) return `tag ${tag.name}`
  }
  throw new Error(
    `qbit commit ${commit} is not on ${PROTECTED_BRANCHES.join(' or ')} or a release tag: refusing to pin a policy ` +
      "from outside qbit's own history (scripts/qbit-release-keys/README.md)"
  )
}

/** Steps 0-3: download the policy and SHA256SUMS into `dir`, verify them, and return the asset's digest. */
export async function fetchSums(dir, { rel = release(), pin = readPin(), fetchBytes = download } = {}) {
  mkdirSync(dir)
  await fetchPolicy(join(dir, POLICY_DIR), { pin, fetchBytes })
  for (const [name, max] of [
    [SUMS, MAX_SUMS_BYTES],
    [SIGNATURES, MAX_SIGNATURES_BYTES],
  ]) {
    writeFileSync(join(dir, name), await fetchBytes(`${rel.baseUrl}/${name}`, max))
  }
  return verifiedDigest(dir, { rel, pin })
}

function verifiedDigest(dir, { rel, pin }) {
  const { quorum, signers, entries } = verifySums(dir, { line: rel.line, pin })
  const digest = entries.get(rel.asset)
  if (digest === undefined) throw new Error(`the verified ${SUMS} does not list ${rel.asset}`)
  const names = signers.map(signer => `${signer.alias} (${signer.signing})`).join(', ')
  log(`${SUMS} for ${rel.tag} is signed by ${names}: ${signers.length} distinct ${rel.line} signers, quorum ${quorum}`)
  log(`${rel.asset}: ${digest}`)
  return { digest, signers }
}

/**
 * Step 4: re-verify `sumsDir`, take `<tarballDir>/<asset>` if it has the
 * verified digest, or else download it once, then extract it into `destDir`.
 * Returns the bin directory.
 */
export async function install(
  sumsDir,
  tarballDir,
  destDir,
  { rel = release(), pin = readPin(), fetchBytes = download } = {}
) {
  const { digest } = verifiedDigest(sumsDir, { rel, pin })
  const file = join(tarballDir, rel.asset)
  let tarball
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (stat !== undefined && !stat.isFile()) throw new Error(`${file} is not a regular file`)
  if (stat !== undefined) {
    tarball = readFileSync(file)
    if (sha256(tarball) === digest) {
      log(`${file} has the verified digest`)
    } else {
      log(`${file} has SHA-256 ${sha256(tarball)}, not the verified ${digest}: deleting it and downloading it again`)
      rmSync(file)
      tarball = undefined
    }
  }
  if (tarball === undefined) {
    log(`downloading ${rel.baseUrl}/${rel.asset}`)
    tarball = await fetchBytes(`${rel.baseUrl}/${rel.asset}`, MAX_TARBALL_BYTES)
    const actual = sha256(tarball)
    if (actual !== digest)
      throw new Error(`${rel.asset} has SHA-256 ${actual}, not the verified ${digest}: refusing it`)
    mkdirSync(tarballDir, { recursive: true })
    const partial = join(tarballDir, `.${rel.asset}.${process.pid}`)
    writeFileSync(partial, tarball)
    renameSync(partial, file)
  }
  // tar reads the verified bytes, not the file, which could change meanwhile.
  mkdirSync(destDir)
  execFileSync('tar', ['-xzf', '-', '-C', destDir], { input: tarball, stdio: ['pipe', 'inherit', 'inherit'] })
  const roots = readdirSync(destDir)
  if (roots.length !== 1 || roots[0] !== rel.root)
    throw new Error(`${rel.asset} holds ${roots.join(', ')}, not ${rel.root}`)
  const binDir = join(destDir, rel.root, 'bin')
  for (const name of EXECUTABLES) accessSync(join(binDir, name), constants.X_OK)
  log(`extracted ${rel.asset} into ${destDir}`)
  return binDir
}

/**
 * A pin for the policy at qbit `commit`, for review. The commit must be on a
 * protected qbit branch or a release tag (reachableFrom). Its keys.json must be
 * the pinned one, or its direct successor, whose previous_policy_sha256 is the
 * pinned digest and whose policy_sequence is one more. Each certificate must
 * hold one primary key, with the signing key keys.json lists under it. This
 * does not check that the previous signers approved the successor;
 * qbit-release-keys/README.md says how to check that with qbit's validator.
 */
export async function proposePin(commit, { pin = readPin(), fetchBytes = download, getJson = githubJson } = {}) {
  if (!COMMIT.test(commit)) throw new Error(`malformed qbit commit ${commit}`)
  log(`qbit ${commit} is on ${await reachableFrom(commit, { getJson })}`)
  const bytes = await fetchBytes(policyUrl(commit, 'keys.json'), MAX_POLICY_BYTES)
  const { policy, signers } = parsePolicy(bytes)
  const digest = sha256(bytes)
  if (!POLICY_ID.test(policy.policy_id)) throw new Error(`keys.json: malformed policy_id ${policy.policy_id}`)
  if (digest !== pin.policy_sha256) {
    // The pinned policy's sequence, from the pinned commit's keys.json, checked against the pin.
    const current = pinnedPolicy(await fetchBytes(policyUrl(pin.commit, 'keys.json'), MAX_POLICY_BYTES), pin)
    if (policy.previous_policy_sha256 !== pin.policy_sha256) {
      throw new Error(
        `keys.json at ${commit} has previous_policy_sha256 ${policy.previous_policy_sha256}, not the pinned ${pin.policy_sha256}`
      )
    }
    const sequence = current.policy.policy_sequence
    if (!Number.isSafeInteger(sequence) || policy.policy_sequence !== sequence + 1) {
      throw new Error(`keys.json at ${commit} has policy_sequence ${policy.policy_sequence}, not ${sequence} + 1`)
    }
  }
  const certificates = []
  for (const signer of signers) {
    certificates.push([signer, await fetchBytes(policyUrl(commit, signer.file), MAX_CERTIFICATE_BYTES)])
  }
  const proposed = { commit, policy_id: policy.policy_id, policy_sha256: digest, signers: {} }
  withGnupgHome(home => {
    for (const [signer, certificate] of certificates) {
      const listing = gpg([...gpgArgs(home), '--with-colons', '--fingerprint', '--show-keys'], certificate)
      if (listing.status !== 0) throw new Error(`gpg could not read ${signer.file}:\n${listing.stderr}`)
      const keys = listedKeys(listing.stdout)
      if (keys.size !== 1) throw new Error(`${signer.file} holds ${keys.size} primary keys, not 1`)
      const [[primary, fingerprints]] = keys
      if (!fingerprints.has(signer.signing)) throw new Error(`${signer.file} has no key ${signer.signing}`)
      proposed.signers[signer.alias] = { certificate_sha256: sha256(certificate), primary_fingerprint: primary }
    }
  })
  return proposed
}

async function main([command, ...args]) {
  if (command === 'sums' && args.length === 1) {
    const rel = release()
    const { digest, signers } = await fetchSums(args[0], { rel })
    return [
      `asset=${rel.asset}`,
      `sha256=${digest}`,
      `cache-key=${rel.cacheKey(digest)}`,
      `signers=${signers.map(signer => signer.alias).join(',')}`,
    ].join('\n')
  }
  if (command === 'install' && args.length === 3) return `bin-dir=${await install(args[0], args[1], args[2])}`
  if (command === 'fetch' && args.length === 1) {
    mkdirSync(args[0])
    await fetchSums(join(args[0], 'sums'))
    return install(join(args[0], 'sums'), args[0], join(args[0], 'core'))
  }
  if (command === 'pin' && args.length === 1) return JSON.stringify(await proposePin(args[0]), null, 2)
  throw new Error(
    'usage: qbit-release.mjs sums <sums-dir> | install <sums-dir> <tarball-dir> <dest-dir> | fetch <dir> | pin <qbit-commit>'
  )
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // gpg runs synchronously, so a signal is handled only after the temporary
  // GnuPG home has been removed.
  process.once('SIGINT', () => process.exit(130))
  process.once('SIGTERM', () => process.exit(143))
  main(process.argv.slice(2)).then(
    output => process.stdout.write(`${output}\n`),
    error => {
      log(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
  )
}
