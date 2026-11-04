#!/usr/bin/env node
// Download the qbit Core release named in qbit-core-release.mjs and verify it
// before anything in it runs, the way qbit's ci/release/validate_release_artifacts.py
// does:
//
// 1. SHA256SUMS and SHA256SUMS.asc (the operators' detached signatures,
//    concatenated) from the release on github.com/Qbit-Org/qbit.
// 2. gpg, in a temporary GnuPG home holding only the certificates in
//    qbit-release-keys/, verifies SHA256SUMS.asc over SHA256SUMS. Every
//    signature must be good and made by the signing subkey and primary key
//    that fingerprints.txt lists for a signer keys.json makes active for the
//    release line, and the distinct signers must reach that line's
//    release_signature_quorum. Only gpg's --status-fd lines are read.
// 3. The asset's digest comes from the verified SHA256SUMS, which must have no
//    malformed line and no name twice.
// 4. The tarball must have that SHA-256 before it is written to disk or
//    extracted, and only qbitd and qbit-cli are used from it.
//
// Usage (logs go to stderr):
//   qbit-release.mjs sums <sums-dir>
//     Steps 1-3 into <sums-dir>, which must not exist. Prints asset=,
//     sha256=, cache-key= and signers= lines, for $GITHUB_OUTPUT.
//   qbit-release.mjs install <sums-dir> <tarball-dir> <dest-dir>
//     Verifies <sums-dir> again and uses <tarball-dir>/<asset> if it has the
//     verified digest (a restored cache entry); otherwise deletes it and
//     downloads the asset, once. Extracts it into <dest-dir>, which must not
//     exist, and prints bin-dir=.
//   qbit-release.mjs fetch <dir>
//     Both, into <dir>, which must not exist. Prints the bin directory.
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

export const KEYS_DIR = fileURLToPath(new URL('./qbit-release-keys', import.meta.url))
const EXECUTABLES = ['qbitd', 'qbit-cli']
const SUMS = 'SHA256SUMS'
const SIGNATURES = 'SHA256SUMS.asc'
// v1.0.0's are 2,013 and 758 bytes, and its largest non-debug tarball 88 MB.
const MAX_SUMS_BYTES = 64 * 1024
const MAX_SIGNATURES_BYTES = 64 * 1024
const MAX_TARBALL_BYTES = 512 * 1024 * 1024
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

/**
 * The signers that count for `line`: those keys.json makes active release
 * signers for it, with the primary-key fingerprint from fingerprints.txt.
 * The two files must name the same signers and signing keys.
 */
export function loadSigners(keysDir, line) {
  const policy = JSON.parse(readFileSync(join(keysDir, 'keys.json'), 'utf8'))
  if (policy.schema_version !== 2) throw new Error(`keys.json: schema_version ${policy.schema_version}, not 2`)
  const quorum = policy.release_lines?.[line]?.release_signature_quorum
  if (!Number.isSafeInteger(quorum) || quorum < 1) throw new Error(`keys.json: no release_signature_quorum for ${line}`)

  const listed = new Map()
  for (const [index, text] of readFileSync(join(keysDir, 'fingerprints.txt'), 'utf8').split('\n').entries()) {
    if (text === '' || text.startsWith('#')) continue
    const match = /^([a-z0-9][a-z0-9-]*) ([0-9A-F]{40}) ([0-9A-F]{40})$/.exec(text)
    if (match === null) throw new Error(`fingerprints.txt:${index + 1}: malformed line`)
    const [, alias, primary, signing] = match
    if (listed.has(alias)) throw new Error(`fingerprints.txt:${index + 1}: ${alias} is listed twice`)
    listed.set(alias, { primary, signing })
  }

  const all = Array.isArray(policy.signers) ? policy.signers : []
  const aliases = all.map(signer => signer.alias)
  if (new Set(aliases).size !== aliases.length || aliases.length !== listed.size) {
    throw new Error('keys.json and fingerprints.txt list different signers')
  }
  const signers = []
  for (const signer of all) {
    const fingerprints = listed.get(signer.alias)
    if (fingerprints === undefined || fingerprints.signing !== signer.signing_fingerprint) {
      throw new Error(`keys.json and fingerprints.txt disagree on ${signer.alias}`)
    }
    if (!/^public-keys\/[a-z0-9][a-z0-9-]*\.asc$/.test(signer.public_key_file)) {
      throw new Error(`keys.json: ${signer.alias} has public_key_file ${signer.public_key_file}`)
    }
    const counts =
      signer.status === 'active' &&
      Array.isArray(signer.release_lines) &&
      signer.release_lines.includes(line) &&
      Array.isArray(signer.capabilities) &&
      signer.capabilities.includes('release-signing')
    if (counts) signers.push({ alias: signer.alias, ...fingerprints, file: join(keysDir, signer.public_key_file) })
  }
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

/** Import each signer's certificate, and check the keyring holds exactly those keys. */
function importSigners(home, signers) {
  for (const signer of signers) {
    const result = gpg([...gpgArgs(home), '--import', signer.file])
    if (result.status !== 0) throw new Error(`gpg could not import ${signer.file}:\n${result.stderr}`)
  }
  const listing = gpg([...gpgArgs(home), '--with-colons', '--fingerprint', '--list-keys'])
  if (listing.status !== 0) throw new Error(`gpg could not list the imported keys:\n${listing.stderr}`)
  const keys = new Map() // primary fingerprint -> fingerprints of the primary and its subkeys
  let record
  for (const fields of listing.stdout.split('\n').map(text => text.split(':'))) {
    if (fields[0] === 'pub' || fields[0] === 'sub') record = fields[0]
    else if (fields[0] === 'fpr' && record === 'pub') keys.set(fields[9], new Set([fields[9]]))
    else if (fields[0] === 'fpr' && record === 'sub') [...keys.values()].at(-1)?.add(fields[9])
    if (fields[0] === 'fpr') record = undefined
  }
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
export function verifySums(dir, { line, keysDir = KEYS_DIR }) {
  const policy = loadSigners(keysDir, line)
  // gpg verifies these bytes, from stdin, and only these are parsed.
  const sums = readFileSync(join(dir, SUMS))
  const signers = withGnupgHome(home => {
    importSigners(home, policy.signers)
    const verify = ['--trust-model', 'always', '--status-fd', '1', '--verify', join(dir, SIGNATURES), '-']
    const result = gpg([...gpgArgs(home), ...verify], sums)
    return countSignatures(result.stdout, result.status, policy)
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

/** Steps 1-3: download and verify SHA256SUMS into `dir`, and return the asset's digest. */
export async function fetchSums(dir, { rel = release(), keysDir = KEYS_DIR, fetchBytes = download } = {}) {
  mkdirSync(dir)
  for (const [name, max] of [
    [SUMS, MAX_SUMS_BYTES],
    [SIGNATURES, MAX_SIGNATURES_BYTES],
  ]) {
    writeFileSync(join(dir, name), await fetchBytes(`${rel.baseUrl}/${name}`, max))
  }
  return verifiedDigest(dir, { rel, keysDir })
}

function verifiedDigest(dir, { rel, keysDir }) {
  const { quorum, signers, entries } = verifySums(dir, { line: rel.line, keysDir })
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
  { rel = release(), keysDir = KEYS_DIR, fetchBytes = download } = {}
) {
  const { digest } = verifiedDigest(sumsDir, { rel, keysDir })
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
  throw new Error('usage: qbit-release.mjs sums <sums-dir> | install <sums-dir> <tarball-dir> <dest-dir> | fetch <dir>')
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
