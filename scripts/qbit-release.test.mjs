// Offline tests for qbit-release.mjs, with fixture keys and signatures made
// in a temporary GnuPG home (never the user's): primary keys that only
// certify, each with an ed25519 signing subkey, as qbit's operators have.
// Fixture key policies stand in for qbit's contrib/keys/operator-keys at a
// fixture commit, served with the release by a fake fetch, never the network.
// Run by `pnpm test:release`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  countSignatures,
  fetchPolicy,
  fetchSums,
  install,
  loadSigners,
  parseSha256Sums,
  proposePin,
  readPin,
  release,
  sha256,
  verifySignatures,
} from './qbit-release.mjs'

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

let commits = 0

/**
 * qbit's key policy at a new fixture commit: keys.json and the certificates,
 * as `files`, and a pin for them. `edit` changes keys.json before it is pinned.
 */
function policy(
  listed,
  {
    quorum = 3,
    size = listed.length,
    sequence = 2,
    previous = 'e'.repeat(64),
    certificates = listed.map(signer => signer.certificate()),
    edit = keys => keys,
  } = {}
) {
  const commit = (++commits).toString(16).padStart(40, '0')
  const keys = edit({
    schema_version: 2,
    policy_id: `qbit-release-keys-mainnet-${String(sequence).padStart(6, '0')}`,
    policy_sequence: sequence,
    previous_policy_sha256: previous,
    effective_from_tag: 'v1.0.0',
    release_lines: {
      mainnet: { active_signer_set_size: size, release_signature_quorum: quorum },
      testnet: { active_signer_set_size: 0, release_signature_quorum: 2 },
    },
    signers: listed.map(signer => ({
      alias: signer.alias,
      status: 'active',
      public_key_file: `public-keys/${signer.alias}-release.asc`,
      signing_fingerprint: signer.signing,
      release_lines: ['mainnet'],
      capabilities: ['release-signing', 'builder-attestation'],
    })),
  })
  const files = { 'keys.json': Buffer.from(JSON.stringify(keys, null, 2)) }
  listed.forEach((signer, index) => (files[`public-keys/${signer.alias}-release.asc`] = certificates[index]))
  const pin = {
    commit,
    policy_id: keys.policy_id,
    policy_sha256: sha256(files['keys.json']),
    signers: Object.fromEntries(
      listed.map((signer, index) => [
        signer.alias,
        { certificate_sha256: sha256(certificates[index]), primary_fingerprint: signer.primary },
      ])
    ),
  }
  return { pin, files }
}

const POLICY_URL =
  /^https:\/\/raw\.githubusercontent\.com\/Qbit-Org\/qbit\/([0-9a-f]{40})\/contrib\/keys\/operator-keys\/(.+)$/

/** Serves the release's files and the policies' files, counting each request. */
function server(files, policies = []) {
  const requests = []
  const fetchBytes = async url => {
    const match = POLICY_URL.exec(url)
    const name = match === null ? url.slice(rel.baseUrl.length + 1) : `${match[1]}:${match[2]}`
    requests.push(name)
    const body = match === null ? files[name] : policies.find(item => item.pin.commit === match[1])?.files[match[2]]
    if (body === undefined) throw new Error(`GET ${url}: HTTP 404`)
    return Buffer.from(body)
  }
  return { fetchBytes, requests }
}

const signedBy = (list, bytes = sums) => Buffer.concat(list.map(signer => sign(signer, bytes)))
const newDir = () => join(mkdtempSync(join(root, 'run-')), 'dir')

async function verify(files, fixture = policy(signers), dir = newDir()) {
  const { fetchBytes } = server(files, [fixture])
  return fetchSums(dir, { rel, pin: fixture.pin, fetchBytes })
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
      /gpg refused a signature: \[GNUPG:\] (ERRSIG|NO_PUBKEY).*checked against the pinned key policy .*pin\.json/s
    )
  })

  it('refuses a pinned certificate that holds a key the pin does not list', async () => {
    const [a, b, c] = signers
    const certificates = [a.certificate(), b.certificate(), Buffer.concat([c.certificate(), stranger.certificate()])]
    await assert.rejects(
      verify({ SHA256SUMS: sums, 'SHA256SUMS.asc': signedBy([a, b, c]) }, policy([a, b, c], { certificates })),
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
      verify({ SHA256SUMS: sums, 'SHA256SUMS.asc': signature }, policy([a, b, old])),
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
      verify({ SHA256SUMS: sums, 'SHA256SUMS.asc': signature }, policy([a, b, revoked])),
      /gpg refused a signature: \[GNUPG:\] REVKEYSIG/
    )
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

describe('the pinned key policy', () => {
  const release = () => ({ SHA256SUMS: sums, 'SHA256SUMS.asc': signedBy(signers.slice(0, 3)) })
  /** The policy files, one replaced, under the original pin. */
  const tampered = (fixture, file, bytes) => ({ pin: fixture.pin, files: { ...fixture.files, [file]: bytes } })

  it("pins v1.0.0's policy, qbit-release-keys-mainnet-000002", () => {
    const pin = readPin()
    assert.equal(pin.commit, '7ebcddb622d6e639041f005a189b048ec2a221fe')
    assert.equal(pin.policy_id, 'qbit-release-keys-mainnet-000002')
    assert.equal(pin.policy_sha256, 'f04ae262bd40cdda5c481fc18cef29b405878e66d06c33b49865ea42b38eaf9f')
    assert.deepEqual(Object.keys(pin.signers), [
      'operator-01',
      'operator-02',
      'operator-03',
      'operator-04',
      'operator-05',
    ])
  })

  it('refuses a malformed pin', () => {
    const fixture = policy(signers)
    const write = pin => {
      const file = join(mkdtempSync(join(root, 'pin-')), 'pin.json')
      writeFileSync(file, typeof pin === 'string' ? pin : JSON.stringify(pin))
      return file
    }
    assert.throws(() => readPin(write('{')), /pin\.json: /)
    assert.throws(() => readPin(write({ ...fixture.pin, tag: 'v1.0.0' })), /must hold exactly/)
    assert.throws(() => readPin(write({ ...fixture.pin, policy_sha256: 'F'.repeat(64) })), /malformed policy_sha256/)
    assert.throws(() => readPin(write({ ...fixture.pin, signers: {} })), /no signers/)
    const [first] = Object.keys(fixture.pin.signers)
    const signer = { ...fixture.pin.signers[first], primary_fingerprint: 'a'.repeat(40) }
    assert.throws(
      () => readPin(write({ ...fixture.pin, signers: { ...fixture.pin.signers, [first]: signer } })),
      /malformed primary_fingerprint/
    )
  })

  it('stores keys.json and the certificates once each has its pinned digest', async () => {
    const fixture = policy(signers)
    const dir = newDir()
    await verify(release(), fixture, dir)
    for (const [file, bytes] of Object.entries(fixture.files)) {
      assert.deepEqual(readFileSync(join(dir, 'policy', file)), bytes)
    }
  })

  it('refuses a keys.json with another digest, before writing it', async () => {
    const fixture = policy(signers)
    const keys = Buffer.concat([fixture.files['keys.json'], Buffer.from('\n')])
    const dir = newDir()
    await assert.rejects(
      verify(release(), tampered(fixture, 'keys.json', keys), dir),
      /keys\.json has SHA-256 [0-9a-f]{64}, not the pinned [0-9a-f]{64}: refusing it; .*update scripts\/qbit-release-keys\/pin\.json/
    )
    assert.deepEqual(readdirSync(join(dir, 'policy')), ['public-keys'])
  })

  it('refuses a certificate with another digest, before writing it', async () => {
    const fixture = policy(signers)
    const file = 'public-keys/operator-b-release.asc'
    const dir = newDir()
    await assert.rejects(
      verify(release(), tampered(fixture, file, stranger.certificate()), dir),
      /public-keys\/operator-b-release\.asc has SHA-256 [0-9a-f]{64}, not the pinned/
    )
    assert.equal(existsSync(join(dir, 'policy', file)), false)
  })

  it('treats a missing policy file as final', async () => {
    const fixture = policy(signers)
    const { 'public-keys/operator-c-release.asc': _, ...files } = fixture.files
    await assert.rejects(verify(release(), { pin: fixture.pin, files }), /HTTP 404/)
  })

  it('refuses a malformed keys.json, or one of another schema version, even when pinned', async () => {
    const fixture = policy(signers)
    for (const bytes of [Buffer.from('{'), Buffer.from([0x7b, 0xff, 0x7d])]) {
      const malformed = {
        pin: { ...fixture.pin, policy_sha256: sha256(bytes) },
        files: { ...fixture.files, 'keys.json': bytes },
      }
      await assert.rejects(verify(release(), malformed), /keys\.json is not UTF-8 JSON/)
    }
    await assert.rejects(verify(release(), policy(signers, { edit: () => [] })), /keys\.json is not a JSON object/)
    await assert.rejects(
      verify(release(), policy(signers, { edit: keys => ({ ...keys, schema_version: 3 }) })),
      /schema_version 3, not 2/
    )
  })

  it('refuses a keys.json whose policy_id or signers are not the pinned ones', async () => {
    const fixture = policy(signers)
    const other = { ...fixture.pin, policy_id: 'qbit-release-keys-mainnet-000003' }
    await assert.rejects(verify(release(), { pin: other, files: fixture.files }), /policy_id .*, not the pinned/)
    const [a, b, c, d] = signers
    const unknown = policy([a, b, c, d])
    delete unknown.pin.signers['operator-d']
    await assert.rejects(verify(release(), unknown), /keys\.json lists signers .*, the pin /)
  })

  it('refuses a signer or signing key listed twice', async () => {
    const [a, b, c] = signers
    const twice = keys => ({ ...keys, signers: [...keys.signers, keys.signers[0]] })
    await assert.rejects(verify(release(), policy([a, b, c], { edit: twice })), /operator-a is listed twice/)
    const sameKey = keys => ({
      ...keys,
      signers: keys.signers.map((signer, index) =>
        index === 2 ? { ...signer, signing_fingerprint: a.signing.toLowerCase() } : signer
      ),
    })
    await assert.rejects(
      verify(release(), policy([a, b, c], { edit: sameKey })),
      /signing key [0-9A-F]{40} is listed twice/
    )
  })

  it('refuses a policy whose quorum cannot be reached, or whose signer count is not its set size', async () => {
    const [a, b, c] = signers
    const noSigning = keys => ({
      ...keys,
      signers: keys.signers.map((signer, index) =>
        index === 2 ? { ...signer, capabilities: ['builder-attestation'] } : signer
      ),
    })
    await assert.rejects(
      verify(release(), policy([a, b, c], { edit: noSigning })),
      /2 mainnet signers cannot reach quorum 3/
    )
    await assert.rejects(
      verify(release(), policy([a, b, c], { size: 4 })),
      /3 active mainnet signers, not its active_signer_set_size 4/
    )
    await assert.rejects(verify(release(), policy([a, b, c], { quorum: 0 })), /no release_signature_quorum for mainnet/)
    const unknownStatus = keys => ({ ...keys, signers: keys.signers.map(signer => ({ ...signer, status: 'retired' })) })
    await assert.rejects(verify(release(), policy([a, b, c], { edit: unknownStatus })), /unknown status retired/)
  })

  it('checks the stored policy against the pin again before each use', async () => {
    const fixture = policy(signers)
    const dir = newDir()
    await verify(release(), fixture, dir)
    assert.equal(loadSigners(join(dir, 'policy'), 'mainnet', fixture.pin).signers.length, 4)
    writeFileSync(join(dir, 'policy', 'public-keys', 'operator-a-release.asc'), stranger.certificate())
    assert.throws(() => loadSigners(join(dir, 'policy'), 'mainnet', fixture.pin), /not the pinned/)
    await assert.rejects(
      install(dir, newDir(), newDir(), { rel, pin: fixture.pin, fetchBytes: server({}).fetchBytes }),
      /operator-a-release\.asc has SHA-256 [0-9a-f]{64}, not the pinned/
    )
  })

  it('imports the certificate bytes it checked, not the files again', async () => {
    const fixture = policy(signers)
    const dir = newDir()
    await verify(release(), fixture, dir)
    const loaded = loadSigners(join(dir, 'policy'), 'mainnet', fixture.pin)
    // Replace every certificate after the check: verification must still use the checked bytes.
    for (const signer of signers) {
      writeFileSync(join(dir, 'policy', 'public-keys', `${signer.alias}-release.asc`), stranger.certificate())
    }
    const { signers: counted } = verifySignatures(dir, loaded, fixture.pin)
    assert.deepEqual(
      counted.map(signer => signer.alias),
      ['operator-a', 'operator-b', 'operator-c']
    )
  })

  it("downloads only the pinned commit's files", async () => {
    const fixture = policy(signers)
    const { fetchBytes, requests } = server({}, [fixture])
    await fetchPolicy(newDir(), { pin: fixture.pin, fetchBytes })
    assert.deepEqual(requests, [
      `${fixture.pin.commit}:keys.json`,
      ...signers.map(signer => `${fixture.pin.commit}:public-keys/${signer.alias}-release.asc`),
    ])
  })
})

describe('proposing a pin', () => {
  // GitHub's API, stubbed: every commit is on main.
  const onMain = async url => (url.includes('/compare/main...') ? { status: 'behind' } : undefined)

  it('reproduces the pin for the pinned policy', async () => {
    const fixture = policy(signers)
    const { fetchBytes } = server({}, [fixture])
    assert.deepEqual(
      await proposePin(fixture.pin.commit, { pin: fixture.pin, fetchBytes, getJson: onMain }),
      fixture.pin
    )
  })

  it('pins a direct successor, and only one chained to the pinned digest with the next sequence', async () => {
    const current = policy(signers.slice(0, 3))
    const chained = { previous: current.pin.policy_sha256, sequence: 3 }
    const next = policy(signers, chained)
    const unchained = policy(signers, { ...chained, previous: 'f'.repeat(64) })
    const skipped = policy(signers, { ...chained, sequence: 4 })
    const { fetchBytes } = server({}, [current, next, unchained, skipped])
    const options = { pin: current.pin, fetchBytes, getJson: onMain }
    assert.deepEqual(await proposePin(next.pin.commit, options), next.pin)
    await assert.rejects(proposePin(unchained.pin.commit, options), /previous_policy_sha256 f{64}, not the pinned/)
    await assert.rejects(proposePin(skipped.pin.commit, options), /policy_sequence 4, not 2 \+ 1/)
  })

  it('pins only a commit on a protected branch or a release tag', async () => {
    const fixture = policy(signers)
    const { fetchBytes } = server({}, [fixture])
    const { commit } = fixture.pin
    const github = ({ compare = {}, tags = [] }) => {
      const requests = []
      const getJson = async url => {
        requests.push(url)
        if (url.endsWith('/tags?per_page=100')) return tags
        const base = /\/compare\/(.+)\.\.\./.exec(url)?.[1]
        return compare[base] === undefined ? undefined : { status: compare[base] }
      }
      return { getJson, requests }
    }
    const tag = { name: 'v1.0.0', commit: { sha: 'b'.repeat(40) } }
    for (const [where, stub] of [
      ['main', github({ compare: { main: 'identical' } })],
      ['1.x.x', github({ compare: { main: 'ahead', '1.x.x': 'behind' } })],
      ['a release tag', github({ compare: { [tag.commit.sha]: 'behind' }, tags: [tag] })],
      ['a release tag itself', github({ tags: [{ name: 'v1.0.1', commit: { sha: commit } }] })],
    ]) {
      assert.deepEqual(
        await proposePin(commit, { pin: fixture.pin, fetchBytes, getJson: stub.getJson }),
        fixture.pin,
        where
      )
    }
    for (const [where, stub] of [
      [
        'diverged from every ref',
        github({ compare: { main: 'diverged', '1.x.x': 'diverged', [tag.commit.sha]: 'ahead' }, tags: [tag] }),
      ],
      ['unknown to GitHub', github({})],
      [
        'only on a tag that is not a release tag',
        github({
          compare: { ['c'.repeat(40)]: 'behind' },
          tags: [{ name: 'test-1', commit: { sha: 'c'.repeat(40) } }],
        }),
      ],
    ]) {
      await assert.rejects(
        proposePin(commit, { pin: fixture.pin, fetchBytes, getJson: stub.getJson }),
        /is not on main or 1\.x\.x or a release tag: refusing to pin/,
        where
      )
    }
  })

  it('refuses a certificate with more than one primary key, or without the listed signing key', async () => {
    const [first, second, third] = signers
    const bundled = policy([first, second, third], {
      certificates: [
        first.certificate(),
        second.certificate(),
        Buffer.concat([third.certificate(), stranger.certificate()]),
      ],
    })
    const swapped = policy([first, second, third], {
      certificates: [first.certificate(), second.certificate(), stranger.certificate()],
    })
    for (const [fixture, error] of [
      [bundled, /operator-c-release\.asc holds 2 primary keys, not 1/],
      [swapped, /operator-c-release\.asc has no key/],
    ]) {
      const { fetchBytes } = server({}, [fixture])
      await assert.rejects(proposePin(fixture.pin.commit, { pin: fixture.pin, fetchBytes, getJson: onMain }), error)
    }
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
    const fixture = policy([a, b, c])
    const release = { SHA256SUMS: sums, 'SHA256SUMS.asc': signedBy([a, b, c]), [rel.asset]: tarball, ...files }
    const sumsDir = newDir()
    await fetchSums(sumsDir, { rel, pin: fixture.pin, fetchBytes: server(release, [fixture]).fetchBytes })
    const { fetchBytes, requests } = server(release)
    const run = (tarballDir, destDir) => install(sumsDir, tarballDir, destDir, { rel, pin: fixture.pin, fetchBytes })
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
