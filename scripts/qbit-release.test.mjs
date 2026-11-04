// Offline tests for qbit-release.mjs, with fixture keys and signatures made
// in a temporary GnuPG home (never the user's): primary keys that only
// certify, each with an ed25519 signing subkey, as qbit's operators have.
// Run by `pnpm test:release`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { countSignatures, fetchSums, install, loadSigners, parseSha256Sums, release, sha256 } from './qbit-release.mjs'

const rel = release('1.0.0', 'linux', 'x64')
const root = mkdtempSync(join(tmpdir(), 'qbit-release-test-'))
const gnupgHome = join(root, 'gnupg')
mkdirSync(gnupgHome, { mode: 0o700 })

const gpg = (...args) =>
  execFileSync(
    'gpg',
    ['--homedir', gnupgHome, '--batch', '--no-tty', '--pinentry-mode', 'loopback', '--passphrase', '', ...args],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

/** A primary key that only certifies, with a signing subkey; `time` fakes the creation time. */
function makeSigner(alias, time) {
  const at = time === undefined ? [] : ['--faked-system-time', `${time}!`]
  const listing = () => gpg('--with-colons', '--fingerprint', '--list-keys', `<${alias}@example.invalid>`).toString()
  const fingerprints = () => [...listing().matchAll(/^fpr:(?:[^:]*:){8}([0-9A-F]{40}):/gm)].map(match => match[1])
  gpg(...at, '--quick-gen-key', `${alias} <${alias}@example.invalid>`, 'ed25519', 'cert', 'never')
  const [primary] = fingerprints()
  gpg(...at, '--quick-add-key', primary, 'ed25519', 'sign', 'never')
  const [, signing] = fingerprints()
  return { alias, primary, signing, time, certificate: () => gpg('--armor', '--export', primary) }
}

/** A detached, armored signature by `signer`'s signing subkey. */
function sign(signer, bytes, ...options) {
  const file = join(root, 'to-sign')
  writeFileSync(file, bytes)
  const at = signer.time === undefined ? [] : ['--faked-system-time', `${signer.time}!`]
  return gpg(...at, ...options, '--local-user', `${signer.signing}!`, '--armor', '--detach-sign', '--output', '-', file)
}

let tarball
let sums
let signers
let stranger
before(() => {
  signers = ['operator-a', 'operator-b', 'operator-c', 'operator-d'].map(alias => makeSigner(alias))
  stranger = makeSigner('stranger')

  const staging = join(root, 'tarball')
  mkdirSync(join(staging, rel.root, 'bin'), { recursive: true })
  for (const name of ['qbitd', 'qbit-cli']) {
    writeFileSync(join(staging, rel.root, 'bin', name), '#!/bin/sh\necho fixture\n', { mode: 0o755 })
  }
  tarball = execFileSync('tar', ['-czf', '-', '-C', staging, rel.root])
  sums = Buffer.from(
    `${'1'.repeat(64)}  qbit-1.0.0-aarch64-linux-gnu.tar.gz\n${sha256(tarball)}  ${rel.asset}\n${'2'.repeat(64)}  qbit-1.0.0-win64-unsigned.zip\n`
  )
})

after(() => {
  execFileSync('gpgconf', ['--homedir', gnupgHome, '--kill', 'all'], { stdio: 'ignore' })
  rmSync(root, { recursive: true, force: true })
})

/** A keys directory like qbit-release-keys/: keys.json, fingerprints.txt and the certificates. */
function keysDir(listed, { quorum = 3, certificates = listed.map(signer => signer.certificate()) } = {}) {
  const dir = mkdtempSync(join(root, 'keys-'))
  mkdirSync(join(dir, 'public-keys'))
  const policy = {
    schema_version: 2,
    release_lines: { mainnet: { release_signature_quorum: quorum }, testnet: { release_signature_quorum: 2 } },
    signers: listed.map(signer => ({
      alias: signer.alias,
      status: 'active',
      public_key_file: `public-keys/${signer.alias}-release.asc`,
      signing_fingerprint: signer.signing,
      release_lines: ['mainnet'],
      capabilities: ['release-signing', 'builder-attestation'],
    })),
  }
  writeFileSync(join(dir, 'keys.json'), JSON.stringify(policy, null, 2))
  writeFileSync(join(dir, 'fingerprints.txt'), listed.map(s => `${s.alias} ${s.primary} ${s.signing}\n`).join(''))
  listed.forEach((signer, index) =>
    writeFileSync(join(dir, policy.signers[index].public_key_file), certificates[index])
  )
  return dir
}

/** Serves the release's files, counting each request. */
function server(files) {
  const requests = []
  const fetchBytes = async url => {
    requests.push(url.slice(rel.baseUrl.length + 1))
    const body = files[url.slice(rel.baseUrl.length + 1)]
    if (body === undefined) throw new Error(`GET ${url}: HTTP 404`)
    return Buffer.from(body)
  }
  return { fetchBytes, requests }
}

const signedBy = (list, bytes = sums) => Buffer.concat(list.map(signer => sign(signer, bytes)))
const newDir = () => join(mkdtempSync(join(root, 'run-')), 'dir')

async function verify(files, keys = keysDir(signers)) {
  const { fetchBytes } = server(files)
  return fetchSums(newDir(), { rel, keysDir: keys, fetchBytes })
}

describe('SHA256SUMS signatures', () => {
  it('accepts a quorum of distinct listed signers and returns the asset digest', async () => {
    const [a, b, c] = signers
    const { digest, signers: counted } = await verify({ SHA256SUMS: sums, 'SHA256SUMS.asc': signedBy([c, a, b, a]) })
    assert.equal(digest, sha256(tarball))
    assert.deepEqual(
      counted.map(signer => signer.alias),
      ['operator-a', 'operator-b', 'operator-c']
    )
  })

  it('refuses fewer distinct signers than the quorum', async () => {
    const [a, b] = signers
    await assert.rejects(
      verify({ SHA256SUMS: sums, 'SHA256SUMS.asc': signedBy([a, b, b]) }),
      /2 distinct mainnet signers .*not the 3 required/
    )
  })

  it('refuses a signature by a key that is not listed, even beside a quorum', async () => {
    const [a, b, c] = signers
    await assert.rejects(
      verify({ SHA256SUMS: sums, 'SHA256SUMS.asc': signedBy([a, b, c, stranger]) }),
      /gpg refused a signature: \[GNUPG:\] (ERRSIG|NO_PUBKEY)/
    )
  })

  it('refuses a certificate file that holds a key fingerprints.txt does not list', async () => {
    const [a, b, c] = signers
    const certificates = [a.certificate(), b.certificate(), Buffer.concat([c.certificate(), stranger.certificate()])]
    await assert.rejects(
      verify({ SHA256SUMS: sums, 'SHA256SUMS.asc': signedBy([a, b, c]) }, keysDir([a, b, c], { certificates })),
      /the certificates hold primary keys/
    )
  })

  it('refuses signatures over other bytes than SHA256SUMS', async () => {
    const [a, b, c] = signers
    const tampered = Buffer.from(sums.toString().replace(sha256(tarball), 'f'.repeat(64)))
    await assert.rejects(
      verify({ SHA256SUMS: tampered, 'SHA256SUMS.asc': signedBy([a, b, c]) }),
      /gpg refused a signature: \[GNUPG:\] BADSIG/
    )
  })

  it('refuses an expired signature', async () => {
    const old = makeSigner('operator-old', '20200101T000000')
    const [a, b] = signers
    const signature = Buffer.concat([signedBy([a, b]), sign(old, sums, '--default-sig-expire', '1d')])
    await assert.rejects(
      verify({ SHA256SUMS: sums, 'SHA256SUMS.asc': signature }, keysDir([a, b, old])),
      /gpg refused a signature: \[GNUPG:\] EXPSIG/
    )
  })

  it('refuses a signature by a revoked key', async () => {
    const revoked = makeSigner('operator-revoked')
    const [a, b] = signers
    const signature = signedBy([a, b, revoked])
    // gpg writes a revocation certificate for each new key, with its armor disabled by a leading colon.
    const certificate = readFileSync(join(gnupgHome, 'openpgp-revocs.d', `${revoked.primary}.rev`), 'utf8')
    writeFileSync(join(root, 'revocation.asc'), certificate.replace(/^:-----BEGIN/m, '-----BEGIN'))
    gpg('--import', join(root, 'revocation.asc'))
    await assert.rejects(
      verify({ SHA256SUMS: sums, 'SHA256SUMS.asc': signature }, keysDir([a, b, revoked])),
      /gpg refused a signature: \[GNUPG:\] REVKEYSIG/
    )
  })

  it('refuses a keys.json and fingerprints.txt that disagree', () => {
    const [a, b, c] = signers
    const dir = keysDir([a, b, c])
    writeFileSync(
      join(dir, 'fingerprints.txt'),
      `${a.alias} ${a.primary} ${a.signing}\n${b.alias} ${b.primary} ${b.signing}\n`
    )
    assert.throws(() => loadSigners(dir, 'mainnet'), /list different signers/)
    writeFileSync(join(dir, 'fingerprints.txt'), [a, b, c].map(s => `${s.alias} ${s.primary} ${a.signing}\n`).join(''))
    assert.throws(() => loadSigners(dir, 'mainnet'), /disagree on operator-b/)
  })

  it('reads only status lines, and refuses anything but one GOODSIG and VALIDSIG per signature', () => {
    const [a, b, c] = signers
    const policy = { line: 'mainnet', quorum: 3, signers: [a, b, c] }
    const valid = (signer, hash = '10', primary = signer.primary) =>
      `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG ${signer.signing.slice(-16)} ${signer.alias}\n` +
      `[GNUPG:] VALIDSIG ${signer.signing} 2026-07-15 1784156878 0 4 0 22 ${hash} 00 ${primary}\n`
    const status = valid(a) + valid(b) + valid(c)
    assert.equal(countSignatures(status, 0, policy).length, 3)
    assert.throws(() => countSignatures(status, 1, policy), /exited with 1/)
    assert.throws(() => countSignatures(`gpg: Good signature from "${a.alias}"\n`, 0, policy), /holds no signature/)
    assert.throws(() => countSignatures(valid(a) + valid(b) + valid(c, '2'), 0, policy), /unexpected signature/)
    assert.throws(
      () => countSignatures(valid(a) + valid(b) + valid(c, '10', a.primary), 0, policy),
      /not a mainnet release signer/
    )
    assert.throws(
      () =>
        countSignatures(
          valid(a) + valid(b) + `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG ${c.signing.slice(-16)} c\n`,
          0,
          policy
        ),
      /without one GOODSIG and one VALIDSIG/
    )
    assert.throws(
      () => countSignatures(status + `[GNUPG:] NEWSIG\n[GNUPG:] EXPKEYSIG ${a.signing.slice(-16)} a\n`, 0, policy),
      /EXPKEYSIG/
    )
  })
})

describe('SHA256SUMS lines', () => {
  const line = name => `${'a'.repeat(64)}  ${name}\n`

  it('maps names to lower-case digests, in either mode', () => {
    const entries = parseSha256Sums(Buffer.from(`${'A'.repeat(64)}  one.tar.gz\n${'b'.repeat(64)} *two.zip\n`))
    assert.deepEqual(
      [...entries],
      [
        ['one.tar.gz', 'a'.repeat(64)],
        ['two.zip', 'b'.repeat(64)],
      ]
    )
  })

  for (const [what, text] of [
    ['a short digest', `${'a'.repeat(63)}  x.tar.gz\n`],
    ['a blank line', `${line('x.tar.gz')}\n`],
    ['a path', line('bin/x.tar.gz')],
    ['a hidden name', line('.x.tar.gz')],
    ['an escaped name', `\\${line('x\\ny')}`],
    ['a carriage return', line('x.tar.gz').replace('\n', '\r\n')],
    ['no final newline', line('x.tar.gz').trimEnd()],
    ['an empty file', ''],
  ]) {
    it(`refuses ${what}`, () => {
      assert.throws(() => parseSha256Sums(Buffer.from(text)), /malformed line|empty or does not end/)
    })
  }

  it('refuses a name listed twice, with the same or another digest', () => {
    assert.throws(() => parseSha256Sums(Buffer.from(line('x.tar.gz') + line('x.tar.gz'))), /listed twice/)
    assert.throws(
      () => parseSha256Sums(Buffer.from(line('x.tar.gz') + `${'b'.repeat(64)}  x.tar.gz\n`)),
      /SHA256SUMS:2: x\.tar\.gz is listed twice/
    )
  })

  it('refuses a malformed line or a duplicate name under good signatures', async () => {
    const [a, b, c] = signers
    for (const text of [`${sums}not a checksum line\n`, `${sums}${'3'.repeat(64)}  ${rel.asset}\n`]) {
      await assert.rejects(
        verify({ SHA256SUMS: text, 'SHA256SUMS.asc': signedBy([a, b, c], text) }),
        /malformed line|listed twice/
      )
    }
  })
})

describe('the tarball', () => {
  /** A verified SHA256SUMS in a new directory, and a server for the rest of the release. */
  async function verified(files = {}) {
    const [a, b, c] = signers
    const keys = keysDir([a, b, c])
    const release = { SHA256SUMS: sums, 'SHA256SUMS.asc': signedBy([a, b, c]), [rel.asset]: tarball, ...files }
    const sumsDir = newDir()
    await fetchSums(sumsDir, { rel, keysDir: keys, fetchBytes: server(release).fetchBytes })
    const { fetchBytes, requests } = server(release)
    const run = (tarballDir, destDir) => install(sumsDir, tarballDir, destDir, { rel, keysDir: keys, fetchBytes })
    return { run, requests }
  }

  it('downloads it, checks it against the verified digest, keeps it and extracts it', async () => {
    const { run, requests } = await verified()
    const tarballDir = newDir()
    const destDir = newDir()
    const binDir = await run(tarballDir, destDir)
    assert.equal(binDir, join(destDir, rel.root, 'bin'))
    assert.deepEqual(readdirSync(binDir).sort(), ['qbit-cli', 'qbitd'])
    assert.deepEqual(readdirSync(tarballDir), [rel.asset])
    assert.deepEqual(requests, [rel.asset])
  })

  it('refuses one with another hash, and neither keeps nor extracts it', async () => {
    const { run, requests } = await verified({ [rel.asset]: Buffer.concat([tarball, Buffer.from([0])]) })
    const tarballDir = newDir()
    const destDir = newDir()
    await assert.rejects(
      run(tarballDir, destDir),
      /has SHA-256 [0-9a-f]{64}, not the verified [0-9a-f]{64}: refusing it/
    )
    assert.equal(existsSync(tarballDir), false)
    assert.equal(existsSync(destDir), false)
    assert.deepEqual(requests, [rel.asset])
  })

  it('uses a restored one that has the verified digest, without downloading it', async () => {
    const { run, requests } = await verified()
    const tarballDir = newDir()
    mkdirSync(tarballDir)
    writeFileSync(join(tarballDir, rel.asset), tarball)
    await run(tarballDir, newDir())
    assert.deepEqual(requests, [])
  })

  it('deletes a restored one that no longer matches, and downloads it again once', async () => {
    const { run, requests } = await verified()
    const tarballDir = newDir()
    mkdirSync(tarballDir)
    writeFileSync(join(tarballDir, rel.asset), 'corrupted')
    await run(tarballDir, newDir())
    assert.deepEqual(readFileSync(join(tarballDir, rel.asset)), tarball)
    assert.deepEqual(requests, [rel.asset])
  })

  it('fails, without a second download, when the download after a bad restore does not match either', async () => {
    const { run, requests } = await verified({ [rel.asset]: 'also corrupted' })
    const tarballDir = newDir()
    mkdirSync(tarballDir)
    writeFileSync(join(tarballDir, rel.asset), 'corrupted')
    await assert.rejects(run(tarballDir, newDir()), /refusing it/)
    assert.deepEqual(readdirSync(tarballDir), [])
    assert.deepEqual(requests, [rel.asset])
  })

  it('treats a failed download as final', async () => {
    const { run, requests } = await verified({ [rel.asset]: undefined })
    await assert.rejects(run(newDir(), newDir()), /HTTP 404/)
    assert.deepEqual(requests, [rel.asset])
  })
})
