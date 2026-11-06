import { inspect } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  QbitRpcClient,
  requests,
  RpcCapabilityError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
  type RpcRequest,
} from '../src'
import { METHOD_POLICIES } from '../src/capabilities'
import { descriptorChecksum } from '../src/methods'
import { CHECK, chainResults, FakeNode, HASH_A, type CallReply, type RpcCall } from './helpers/fake-node'

// Taken before any test fakes the timers: waits for the fake node's real I/O.
const realSetTimeout = setTimeout
const settle = (ms = 20): Promise<void> => new Promise(resolve => realSetTimeout(resolve, ms))

const withChecksum = (body: string): string => `${body}#${descriptorChecksum(body)!}`
/** Stands in for an extended private key: base58 characters, as long as one. */
const XPRV = `qrpvFakeExtendedKey${'Ab3x'.repeat(23)}`
const PUBKEY = '3c'.repeat(32)
const RANGED_BODY = `mr(pk(pqc(${XPRV}/87h/1h/0h/0/*)))`
const RANGED = withChecksum(RANGED_BODY)
const SINGLE = withChecksum(`mr(pk(${PUBKEY}))`)
const MULTIPATH = withChecksum(`mr(pk(pqc(${XPRV}/87h/1h/0h/<0;1>/*)))`)
/** getdescriptorinfo's canonical form of RANGED: the public key in place of the private one. */
const PUBLIC = withChecksum(`mr(pk(pqc(qrpbFakeExtendedPublicKey${'Zz9'.repeat(30)}/87h/1h/0h/0/*)))`)
const ADDRESS = 'qbrt1ztqgtfwcggnmxs7cfmrp74t4z63jzlv50jgjfdna5fy4yy89qvwcqz57et0'
const ADDRESSES = [ADDRESS, 'qbrt1zkfxfcsumamk6krsz8kudx382lhqff5kvffy8s65n8pgnmw25e8ss3w2kkr', 'qbrt1zsecond']
const PASSPHRASE = 'admin-passphrase-5e1d'
const NEW_PASSPHRASE = 'admin-passphrase-new-0c7a'
const SIGNATURE = 'cd'.repeat(3680)
const SIGNED = {
  address: ADDRESS,
  message_hash: 'ab'.repeat(32),
  datasig_hash: '18'.repeat(32),
  domain: 'QbitDataSigPQC',
  algorithm: 'SLH-DSA-SHA2-128s-bounded30',
  proof_mode: 'p2mr-pubkey',
  pubkey: PUBKEY,
  signature: SIGNATURE,
  leaf_version: 192,
  leaf_script: `20${PUBKEY}b3`,
  control_block: 'c1',
  p2mr_merkle_root: '58'.repeat(32),
}
const USAGE = {
  pqc_key_states: [
    {
      pubkey: PUBKEY,
      pqc_signature_count: 1,
      pqc_signature_limit: 1073741824,
      pqc_signatures_remaining: 1073741823,
      pqc_limit_state: 'normal',
    },
  ],
  pqc_overall_limit_state: 'normal',
  pqc_signature_count: 1,
  pqc_signature_limit: 1073741824,
  pqc_signatures_remaining: 1073741823,
  pqc_limit_state: 'normal',
}
const DESCRIPTOR_INFO = {
  descriptor: PUBLIC,
  checksum: RANGED.split('#')[1],
  isrange: true,
  issolvable: true,
  has_p2mr_standard_satisfaction: true,
  hasprivatekeys: true,
}

/** Each wallet-admin method, typed, with arguments it accepts. */
const ADMIN_CALLS: readonly [string, (rpc: QbitRpcClient) => Promise<unknown>][] = [
  ['createwallet', rpc => rpc.createWallet('w', { passphrase: PASSPHRASE })],
  ['loadwallet', rpc => rpc.loadWallet('w')],
  ['unloadwallet', rpc => rpc.unloadWallet('w')],
  ['listwalletdir', rpc => rpc.listWalletDir()],
  ['importdescriptors', rpc => rpc.importDescriptors([{ desc: RANGED, timestamp: 0 }])],
  ['rescanblockchain', rpc => rpc.rescanBlockchain()],
  ['backupwallet', rpc => rpc.backupWallet('/backups/w.dat')],
  ['walletpassphrasechange', rpc => rpc.walletPassphraseChange(PASSPHRASE, NEW_PASSPHRASE)],
  ['keypoolrefill', rpc => rpc.keypoolRefill()],
]

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await node.close()
})

function client(options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    ...options,
  })
}

const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    value => expect.fail(`expected a failure, got ${String(value)}`),
    (error: unknown) => error
  )

/** Answer the chain check, and every other call with `reply`. */
function replyWith(reply: (call: RpcCall) => CallReply): void {
  const check = chainResults('regtest')
  node.rpc(call => (Object.hasOwn(check, call.method) ? { result: check[call.method]! } : reply(call)))
}

const answer = (value: unknown): void => replyWith(() => ({ result: JSON.stringify(value) }))

async function admin(options: Partial<QbitRpcClientOptions> = {}): Promise<QbitRpcClient> {
  node.results(chainResults('regtest'))
  const rpc = client({ capabilities: ['wallet-admin', 'wallet-write'], ...options })
  await rpc.confirmChain()
  node.requests.length = 0
  return rpc
}

/** The params of the last call sent. */
const sentParams = (): unknown[] => node.calls().at(-1)!.params

/**
 * `String(value)`, where a result object, which has no prototype and so no
 * `toString`, shows as `[object Object]` rather than throwing.
 */
function shown(value: unknown): string {
  if (Array.isArray(value)) return value.map(shown).join(',')
  const bare = value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === null
  return bare ? '[object Object]' : String(value)
}

/** What a log or error report would show of `value`. */
function texts(value: unknown): string[] {
  return [
    inspect(value, { showHidden: true, depth: Infinity, getters: true }),
    JSON.stringify(value) ?? '',
    shown(value),
  ]
}

function assertClean(value: unknown, secrets: readonly string[]): void {
  for (const text of texts(value)) for (const secret of secrets) expect(text).not.toContain(secret)
}

describe('the wallet-admin capability', () => {
  it('gates each method as its policy says, with a 120 s floor where qbit Core derives keys or scans blocks', () => {
    const names = [
      'createwallet',
      'loadwallet',
      'unloadwallet',
      'listwalletdir',
      'importdescriptors',
      'rescanblockchain',
      'backupwallet',
      'walletpassphrasechange',
      'keypoolrefill',
      'getdescriptorinfo',
      'deriveaddresses',
      'signdatapqchash',
    ]
    expect(Object.fromEntries(names.map(name => [name, METHOD_POLICIES[name]]))).toEqual({
      createwallet: { capability: 'wallet-admin', sideEffects: true },
      loadwallet: { capability: 'wallet-admin', sideEffects: true, timeoutMs: 120_000 },
      unloadwallet: { capability: 'wallet-admin', sideEffects: true, timeoutMs: 120_000 },
      listwalletdir: { capability: 'wallet-admin', sideEffects: false },
      importdescriptors: { capability: 'wallet-admin', sideEffects: true, timeoutMs: 120_000 },
      rescanblockchain: { capability: 'wallet-admin', sideEffects: true, timeoutMs: 120_000 },
      backupwallet: { capability: 'wallet-admin', sideEffects: true },
      walletpassphrasechange: { capability: 'wallet-admin', sideEffects: true },
      keypoolrefill: { capability: 'wallet-admin', sideEffects: true, timeoutMs: 120_000 },
      getdescriptorinfo: { capability: 'read', sideEffects: false },
      deriveaddresses: { capability: 'read', sideEffects: false },
      signdatapqchash: { capability: 'wallet-write', sideEffects: true },
    })
  })

  it('refuses every wallet-admin call without the capability, unsent, typed or through call()', async () => {
    const rpc = client({ capabilities: ['wallet-read', 'wallet-write', 'broadcast', 'mining'] })
    for (const [, call] of ADMIN_CALLS) {
      expect(await failure(call(rpc))).toMatchObject({ reason: 'not_enabled', required: 'wallet-admin' })
    }
    for (const [method] of ADMIN_CALLS) {
      const error = await failure(rpc.call(method))
      expect(RpcCapabilityError.is(error)).toBe(true)
      expect(error).toMatchObject({ reason: 'not_enabled', required: 'wallet-admin', method })
    }
    // Signing a data hash is a wallet-write call.
    expect(await failure(client({ capabilities: ['wallet-admin'] }).signDataPqcHash(ADDRESS, HASH_A))).toMatchObject({
      reason: 'not_enabled',
      required: 'wallet-write',
    })
    expect(node.requests).toHaveLength(0)
  })

  it('makes every wallet-admin call wait for the chain guard, listwalletdir among them', async () => {
    const rpc = client({ capabilities: ['wallet-admin', 'wallet-write'] })
    const signing: (typeof ADMIN_CALLS)[number] = ['signdatapqchash', r => r.signDataPqcHash(ADDRESS, HASH_A)]
    for (const [method, call] of [...ADMIN_CALLS, signing]) {
      const error = await failure(call(rpc))
      expect(RpcChainGuardError.is(error)).toBe(true)
      expect(error).toMatchObject({ reason: 'unconfirmed', method })
    }
    node.results(chainResults('main'))
    await expect(rpc.confirmChain()).rejects.toMatchObject({ reason: 'mismatch' })
    for (const [, call] of ADMIN_CALLS) {
      expect(await failure(call(rpc))).toMatchObject({ reason: 'mismatch', actualChain: 'main' })
    }
    expect(node.calls().map(call => call.method)).toEqual([...CHECK])
  })

  it('refuses wallet-admin methods in a batch, listwalletdir among them, and batches the descriptor reads', async () => {
    const rpc = await admin()
    for (const request of [
      requests.createWallet('w'),
      requests.loadWallet('w'),
      requests.unloadWallet('w'),
      requests.listWalletDir(),
      requests.importDescriptors([{ desc: SINGLE, timestamp: 'now' }]),
      requests.rescanBlockchain(),
      requests.backupWallet('w.dat'),
      requests.walletPassphraseChange('a', 'b'),
      requests.keypoolRefill(),
      requests.signDataPqcHash(ADDRESS, HASH_A),
    ]) {
      expect(await failure(rpc.batch([request]))).toMatchObject({ reason: 'not_batchable', method: request.method })
    }
    expect(node.requests).toHaveLength(0)
    replyWith(call => ({ result: JSON.stringify(call.method === 'deriveaddresses' ? [ADDRESS] : DESCRIPTOR_INFO) }))
    const [info, derived] = await client().batch([requests.getDescriptorInfo(RANGED), requests.deriveAddresses(SINGLE)])
    expect(info.ok && info.value.hasPrivateKeys).toBe(true)
    expect(derived.ok && derived.value).toEqual([ADDRESS])
  })

  it('treats a side-effecting wallet-admin call as never retried, on a fresh connection, an unknown outcome when lost', async () => {
    const rpc = await admin({ readRetries: 3, retryDelayMs: 0 })
    for (const [method, call] of ADMIN_CALLS) {
      node.requests.length = 0
      // The chain checks a dropped connection calls for are answered; the call itself is dropped.
      node.results(chainResults('regtest'))
      const check = node.handler
      node.handler = (request, response) =>
        request.body.includes(`"method":"${method}"`) ? response.socket?.destroy() : check(request, response)
      const error = await failure(call(rpc))
      if (METHOD_POLICIES[method]!.sideEffects) {
        expect(RpcUnknownOutcomeError.is(error)).toBe(true)
        expect(node.calls().filter(c => c.method === method)).toHaveLength(1)
        expect(node.requests.at(-1)!.headers.connection).toBe('close')
      } else {
        // listwalletdir is a read: retried, and a definite failure.
        expect(error).toMatchObject({ name: 'RpcTransportError', method })
        expect(node.calls().filter(c => c.method === method).length).toBeGreaterThan(1)
      }
    }
  })
})

describe('createWallet, loadWallet, unloadWallet and listWalletDir', () => {
  it('send each option in its place, and check the wallet named in the reply', async () => {
    const rpc = await admin()
    answer({ name: 'payouts' })
    expect(await rpc.createWallet('payouts')).toEqual({ name: 'payouts' })
    expect(sentParams()).toEqual(['payouts'])
    answer({ name: 'payouts', warnings: ['Empty string given as passphrase, wallet will not be encrypted.'] })
    const created = await rpc.createWallet('payouts', {
      disablePrivateKeys: false,
      blank: true,
      passphrase: PASSPHRASE,
      avoidReuse: true,
      loadOnStartup: false,
    })
    expect(created.warnings).toEqual(['Empty string given as passphrase, wallet will not be encrypted.'])
    // descriptors (the sixth) stays null: qbit Core creates descriptor wallets only.
    expect(sentParams()).toEqual(['payouts', false, true, PASSPHRASE, true, null, false])
    answer({ name: 'payouts' })
    await rpc.createWallet('payouts', { loadOnStartup: true })
    expect(sentParams()).toEqual(['payouts', null, null, null, null, null, true])

    answer({ name: '/srv/wallets/cold' })
    expect(await rpc.loadWallet('/srv/wallets/cold', { loadOnStartup: true })).toEqual({ name: '/srv/wallets/cold' })
    expect(node.calls().at(-1)).toMatchObject({ method: 'loadwallet', params: ['/srv/wallets/cold', true] })

    answer({})
    expect(await rpc.unloadWallet('payouts')).toEqual({})
    answer({ warnings: ['Wallet settings could not be updated'] })
    expect(await rpc.unloadWallet('payouts', { loadOnStartup: false })).toEqual({
      warnings: ['Wallet settings could not be updated'],
    })
    expect(node.calls().at(-1)).toMatchObject({ method: 'unloadwallet', params: ['payouts', false] })

    answer({ wallets: [{ name: 'payouts', warnings: [] }, { name: 'old' }, { name: '', warnings: ['legacy'] }] })
    expect(await rpc.listWalletDir()).toEqual([
      { name: 'payouts', warnings: [] },
      { name: 'old' },
      { name: '', warnings: ['legacy'] },
    ])
  })

  it('refuse, unsent, a passphrase that would create the wallet unencrypted or that it cannot use', async () => {
    const rpc = await admin()
    await expect(rpc.createWallet('w', { passphrase: '' })).rejects.toThrow(/creates an unencrypted wallet/)
    await expect(rpc.createWallet('w', { passphrase: PASSPHRASE, disablePrivateKeys: true })).rejects.toThrow(
      /excludes options\.disablePrivateKeys/
    )
    await expect(rpc.createWallet(1 as never)).rejects.toThrow(TypeError)
    await expect(rpc.createWallet('w', { descriptors: true } as never)).rejects.toThrow(/not a known key/)
    await expect(rpc.createWallet('w', { load_on_startup: true } as never)).rejects.toThrow(
      /use options\.loadOnStartup/
    )
    await expect(rpc.loadWallet('w', { timeoutMs: 1 } as never)).rejects.toThrow(/is a call option/)
    await expect(rpc.unloadWallet(undefined as never)).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(0)
  })

  it('take a reply naming another wallet for an invalid one, which may have run', async () => {
    const rpc = await admin()
    answer({ name: 'other' })
    const error = await failure(rpc.createWallet('payouts'))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect((error as Error).cause).toMatchObject({ name: 'RpcResponseError', path: 'result.name' })
    answer({ name: 'other' })
    expect(await failure(rpc.loadWallet('payouts'))).toMatchObject({ cause: { path: 'result.name' } })
    answer({ wallets: [{ warnings: [] }] })
    expect(await failure(rpc.listWalletDir())).toMatchObject({
      name: 'RpcResponseError',
      path: 'result.wallets[0].name',
    })
  })
})

describe('importDescriptors', () => {
  it('sends each descriptor under the keys qbit Core reads, a range as [begin, end]', async () => {
    const rpc = await admin()
    answer([{ success: true }, { success: true, warnings: ['Range not given, using default keypool range'] }])
    const results = await rpc.importDescriptors([
      { desc: RANGED, timestamp: 0, active: true, range: [0, 99], nextIndex: 5, internal: true },
      { desc: SINGLE, timestamp: 'now', label: 'cold' },
    ])
    expect(results).toEqual([
      { success: true },
      { success: true, warnings: ['Range not given, using default keypool range'] },
    ])
    expect(sentParams()).toEqual([
      [
        { desc: RANGED, timestamp: 0, active: true, range: [0, 99], next_index: 5, internal: true },
        { desc: SINGLE, timestamp: 'now', label: 'cold' },
      ],
    ])
    answer([{ success: true }])
    await rpc.importDescriptors([{ desc: RANGED, timestamp: 1_700_000_000, range: 999 }])
    expect(sentParams()).toEqual([[{ desc: RANGED, timestamp: 1_700_000_000, range: [0, 999] }]])
  })

  it.each([
    ['no descriptors', [], /non-empty array/],
    ['a descriptor without its checksum', [{ desc: RANGED_BODY, timestamp: 0 }], /needs its checksum/],
    ['a wrong checksum', [{ desc: `${RANGED_BODY}#qqqqqqqq`, timestamp: 0 }], /does not match the descriptor/],
    ['a malformed checksum', [{ desc: `${RANGED_BODY}#abc`, timestamp: 0 }], /8 checksum characters/],
    ['a character descriptors do not use', [{ desc: 'mr(pk(é))#qqqqqqqq', timestamp: 0 }], /holds a character/],
    ['no timestamp', [{ desc: RANGED }], /timestamp must be 'now' or Unix time in seconds/],
    ['a timestamp in milliseconds', [{ desc: RANGED, timestamp: 1_700_000_000_000 }], /Unix time in seconds/],
    ['a range on a descriptor without *', [{ desc: SINGLE, timestamp: 0, range: 5 }], /for a ranged descriptor/],
    ['active without *', [{ desc: SINGLE, timestamp: 0, active: true }], /for a ranged descriptor/],
    ['a next index without *', [{ desc: SINGLE, timestamp: 0, nextIndex: 0 }], /for a ranged descriptor/],
    ['a next index past the range', [{ desc: RANGED, timestamp: 0, range: [0, 9], nextIndex: 10 }], /within range/],
    ['a range that begins after its end', [{ desc: RANGED, timestamp: 0, range: [5, 4] }], /must not begin after/],
    ['a range of 1,000,001 indexes', [{ desc: RANGED, timestamp: 0, range: [0, 1_000_000] }], /at most 1,000,000/],
    // qbit Core checks an end index as [0, end]: 1,000,000 is 1,000,001 indexes.
    ['an end index of 1,000,000', [{ desc: RANGED, timestamp: 0, range: 1_000_000 }], /end index of at most 999999/],
    // Without a range qbit Core derives the node's -keypool keys, which the client cannot know.
    ['a next index without a range', [{ desc: RANGED, timestamp: 0, nextIndex: 0 }], /nextIndex needs range/],
    ['a range end past 2^31 - 1', [{ desc: RANGED, timestamp: 0, range: 2 ** 31 }], /from 0 to 2147483647/],
    [
      'a label on a ranged descriptor',
      [{ desc: RANGED, timestamp: 0, label: 'x' }],
      /label is for a descriptor without \*/,
    ],
    ['a label on an internal one', [{ desc: SINGLE, timestamp: 0, label: 'x', internal: true }], /not for an internal/],
    ['the label *', [{ desc: SINGLE, timestamp: 0, label: '*' }], /must not be \*/],
    ['internal on a multipath one', [{ desc: MULTIPATH, timestamp: 0, internal: false }], /multipath descriptor takes/],
    ['the node’s key spelling', [{ desc: RANGED, timestamp: 0, next_index: 1 }], /use descriptors\[0\]\.nextIndex/],
  ])('refuses %s before sending anything', async (_name, descriptors, message) => {
    const rpc = await admin()
    const error = await failure(rpc.importDescriptors(descriptors as never))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(message)
    // A descriptor can hold private keys: no message quotes one.
    expect((error as Error).message).not.toContain(XPRV.slice(0, 20))
    expect(node.requests).toHaveLength(0)
  })

  it("returns each descriptor's refusal, its message redacted of key material, beside the others' success", async () => {
    const rpc = await admin()
    answer([
      { success: false, error: { code: -5, message: `pk(): pqc(): key '${XPRV}x' is not valid` } },
      {
        success: false,
        error: {
          code: -4,
          message: `Could not add descriptor '${RANGED}': new range must include current range = [0,999]`,
        },
      },
      { success: true, warnings: [`Not all private keys provided for ${XPRV}`] },
    ])
    const results = await rpc.importDescriptors([
      { desc: withChecksum(`mr(pk(pqc(${XPRV}x/87h/*)))`), timestamp: 0 },
      { desc: RANGED, timestamp: 0, range: [0, 4] },
      { desc: SINGLE, timestamp: 'now' },
    ])
    expect(results).toEqual([
      { success: false, error: { rpcCode: -5, message: "pk(): pqc(): key '[redacted]' is not valid" } },
      {
        success: false,
        error: {
          rpcCode: -4,
          message: `Could not add descriptor 'mr(pk(pqc([redacted]/87h/1h/0h/0/*)))#${RANGED.split('#')[1]}': new range must include current range = [0,999]`,
        },
      },
      { success: true, warnings: ['Not all private keys provided for [redacted]'] },
    ])
    assertClean(results, [XPRV])
  })

  it.each([
    ['fewer results than descriptors', [], 'result'],
    ['a success with an error', [{ success: true, error: { code: -1, message: 'x' } }], 'result[0].error'],
    ['a failure without its error', [{ success: false }], 'result[0].error'],
    ['an error without a code', [{ success: false, error: { message: 'x' } }], 'result[0].error.code'],
  ])('takes %s for an invalid reply, after which the import may have run', async (_name, reply, path) => {
    const rpc = await admin()
    answer(reply)
    const error = await failure(rpc.importDescriptors([{ desc: SINGLE, timestamp: 'now' }]))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect((error as Error).cause).toMatchObject({ name: 'RpcResponseError', reason: 'validation', path })
  })
})

describe("the node's errors about descriptors", () => {
  // The second copy of the key straddles the 1,000-character cap: cut first, a part of it would remain.
  const quoting = (call: RpcCall): CallReply => ({
    error: { code: -5, message: `${call.method}: key '${XPRV}' is not valid; ${'.'.repeat(800)}${XPRV} ends here` },
  })

  it('are redacted of key material, typed, raw and in a batch, before the message is capped', async () => {
    const rpc = await admin()
    replyWith(quoting)
    const errors = [
      await failure(rpc.getDescriptorInfo(RANGED)),
      await failure(rpc.deriveAddresses(RANGED, { range: 2 })),
      await failure(rpc.importDescriptors([{ desc: RANGED, timestamp: 0 }])),
      await failure(rpc.call('getdescriptorinfo', [RANGED])),
      await failure(rpc.call('deriveaddresses', [RANGED, [0, 2]])),
      await failure(rpc.call('importdescriptors', [[{ desc: RANGED, timestamp: 0 }]])),
    ]
    const [batched] = await rpc.batch([requests.getDescriptorInfo(RANGED)])
    errors.push(!batched.ok && batched.error)
    for (const error of errors) {
      expect(RpcError.is(error)).toBe(true)
      const { message } = error as RpcError
      expect(message).toMatch(/key '\[redacted\]' is not valid/)
      expect(message.endsWith('.[redacted] ends here')).toBe(true)
      assertClean(error, [XPRV.slice(0, 16), XPRV.slice(-16)])
    }
    // Other methods' messages are the node's as they are.
    replyWith(() => ({ error: { code: -5, message: `validateaddress: ${XPRV}` } }))
    expect(await failure(rpc.validateAddress(XPRV))).toMatchObject({ message: `validateaddress: ${XPRV}` })
  })
})

describe("the node's errors about descriptors, by what was sent", () => {
  const quoting = (call: RpcCall): CallReply => ({
    error: { code: -5, message: `${call.method}: key '${XPRV}' is not valid` },
  })
  const redacted = (error: unknown): void => {
    expect(RpcError.is(error)).toBe(true)
    expect((error as RpcError).message).toMatch(/key '\[redacted\]' is not valid$/)
    assertClean(error, [XPRV.slice(0, 16), XPRV.slice(-16)])
  }

  it('are redacted for a copied, hand-built or changed batch entry', async () => {
    const rpc = await admin()
    replyWith(quoting)
    const copied = { ...requests.getDescriptorInfo(RANGED) }
    const handBuilt: RpcRequest<unknown> = { method: 'getdescriptorinfo', params: [RANGED], parse: value => value }
    const changed = requests.raw('getdescriptorinfo', ['placeholder'])
    ;(changed.params as unknown[])[0] = RANGED
    for (const item of await rpc.batch([copied, handBuilt, changed])) redacted(!item.ok && item.error)
  })

  it('are redacted for a descriptor sent as a String or through toJSON()', async () => {
    const rpc = await admin()
    replyWith(quoting)
    redacted(await failure(rpc.call('getdescriptorinfo', [new String(RANGED)])))
    redacted(await failure(rpc.call('getdescriptorinfo', [{ toJSON: () => RANGED }])))
    redacted(await failure(rpc.call('deriveaddresses', [new String(RANGED), [0, 2]])))
    redacted(await failure(rpc.call('importdescriptors', [[{ desc: new String(RANGED), timestamp: 0 }]])))
    redacted(await failure(rpc.call('importdescriptors', [[{ toJSON: () => ({ desc: RANGED, timestamp: 0 }) }]])))
  })

  it('are redacted whatever case the node prints the key in', async () => {
    const rpc = await admin()
    const upper = PUBKEY.toUpperCase()
    expect(upper).not.toBe(PUBKEY)
    replyWith(() => ({ error: { code: -5, message: `key '${upper}' is not valid` } }))
    for (const call of [rpc.getDescriptorInfo(SINGLE), rpc.call('getdescriptorinfo', [SINGLE])]) {
      const error = await failure(call)
      expect(error).toMatchObject({ message: "key '[redacted]' is not valid" })
    }
    answer([{ success: false, error: { code: -5, message: `key '${upper}' is not valid` }, warnings: [upper] }])
    expect(await rpc.importDescriptors([{ desc: SINGLE, timestamp: 'now' }])).toEqual([
      { success: false, error: { rpcCode: -5, message: "key '[redacted]' is not valid" }, warnings: ['[redacted]'] },
    ])
  })

  it("caps each descriptor's message in an import's result, after redacting it", async () => {
    const rpc = await admin()
    // The key straddles the 1,000-character cap: cut first, a part of it would remain.
    const long = `${'.'.repeat(990)}${XPRV} ends here`
    answer([{ success: false, error: { code: -4, message: long }, warnings: [long] }])
    const [result] = await rpc.importDescriptors([{ desc: RANGED, timestamp: 0 }])
    const capped = `${'.'.repeat(990)}[redacted]`
    expect(result).toEqual({ success: false, error: { rpcCode: -4, message: capped }, warnings: [capped] })
  })
})

describe('rescanBlockchain', () => {
  it('sends the heights it is given, and checks the reply against them', async () => {
    const rpc = await admin()
    answer({ start_height: 0, stop_height: 1010 })
    expect(await rpc.rescanBlockchain()).toEqual({ startHeight: 0, stopHeight: 1010 })
    expect(sentParams()).toEqual([])
    answer({ start_height: 0, stop_height: 7 })
    await rpc.rescanBlockchain({ stopHeight: 7 })
    expect(sentParams()).toEqual([null, 7])
    answer({ start_height: 5, stop_height: null })
    expect(await rpc.rescanBlockchain({ startHeight: 5, stopHeight: 5 })).toEqual({ startHeight: 5, stopHeight: null })
    expect(sentParams()).toEqual([5, 5])

    for (const [reply, options, path] of [
      [{ start_height: 0, stop_height: 9 }, { startHeight: 5 }, 'result.start_height'],
      [{ start_height: 5, stop_height: 9 }, { startHeight: 5, stopHeight: 8 }, 'result.stop_height'],
      [{ start_height: 5, stop_height: 4 }, { startHeight: 5 }, 'result.stop_height'],
    ] as const) {
      answer(reply)
      expect(await failure(rpc.rescanBlockchain(options))).toMatchObject({ cause: { path } })
    }
    node.requests.length = 0
    await expect(rpc.rescanBlockchain({ startHeight: 5, stopHeight: 4 })).rejects.toThrow(
      /stopHeight must not be below/
    )
    await expect(rpc.rescanBlockchain({ startHeight: -1 })).rejects.toThrow(RangeError)
    await expect(rpc.rescanBlockchain({ start_height: 1 } as never)).rejects.toThrow(/use options\.startHeight/)
    expect(node.requests).toHaveLength(0)
  })
})

describe('backupWallet, walletPassphraseChange and keypoolRefill', () => {
  it('send their arguments, refuse what the node would not act on, and resolve with nothing', async () => {
    const rpc = await admin()
    answer(null)
    expect(await rpc.backupWallet('/var/backups/payouts.dat')).toBeUndefined()
    expect(sentParams()).toEqual(['/var/backups/payouts.dat'])
    expect(await rpc.walletPassphraseChange(PASSPHRASE, NEW_PASSPHRASE)).toBeUndefined()
    expect(sentParams()).toEqual([PASSPHRASE, NEW_PASSPHRASE])
    expect(await rpc.keypoolRefill()).toBeUndefined()
    expect(sentParams()).toEqual([])
    await rpc.keypoolRefill({ newSize: 1500 })
    expect(sentParams()).toEqual([1500])

    node.requests.length = 0
    // qbit Core answers an empty destination with success and writes nothing.
    await expect(rpc.backupWallet('')).rejects.toThrow(/non-empty string/)
    await expect(rpc.walletPassphraseChange('', NEW_PASSPHRASE)).rejects.toThrow(/oldPassphrase must be a non-empty/)
    await expect(rpc.walletPassphraseChange(PASSPHRASE, '')).rejects.toThrow(/newPassphrase must be a non-empty/)
    // 0 is qbit Core's "the -keypool default".
    await expect(rpc.keypoolRefill({ newSize: 0 })).rejects.toThrow(/from 1 to 2147483647/)
    await expect(rpc.keypoolRefill({ newsize: 10 } as never)).rejects.toThrow(/use options\.newSize/)
    expect(node.requests).toHaveLength(0)

    answer(true)
    expect(await failure(rpc.backupWallet('w.dat'))).toMatchObject({
      cause: { name: 'RpcResponseError', path: 'result' },
    })
  })
})

describe('getDescriptorInfo', () => {
  it('needs no capability or chain check, and checks the reply against the descriptor', async () => {
    node.results({ getdescriptorinfo: JSON.stringify(DESCRIPTOR_INFO) })
    expect(await client().getDescriptorInfo(RANGED_BODY)).toEqual({
      descriptor: PUBLIC,
      checksum: RANGED.split('#')[1],
      isRange: true,
      isSolvable: true,
      hasP2mrStandardSatisfaction: true,
      hasPrivateKeys: true,
    })
    // With or without its checksum.
    await client().getDescriptorInfo(RANGED)
    expect(node.calls().map(call => call.params)).toEqual([[RANGED_BODY], [RANGED]])

    const expansion = [withChecksum(RANGED_BODY), withChecksum(RANGED_BODY.replace('/0/*', '/1/*'))]
    node.results({
      getdescriptorinfo: JSON.stringify({
        ...DESCRIPTOR_INFO,
        checksum: MULTIPATH.split('#')[1],
        multipath_expansion: expansion,
      }),
    })
    expect((await client().getDescriptorInfo(MULTIPATH)).multipathExpansion).toEqual(expansion)
  })

  it.each([
    ['another checksum', { checksum: 'qqqqqqqq' }, 'result.checksum'],
    ['a canonical form without its checksum', { descriptor: PUBLIC.split('#')[0] }, 'result.descriptor'],
    ['a canonical form with a wrong checksum', { descriptor: `${PUBLIC.split('#')[0]}#qqqqqqqq` }, 'result.descriptor'],
    ['a range the descriptor does not have', { isrange: false }, 'result.isrange'],
    ['paths for a descriptor without <', { multipath_expansion: [PUBLIC, PUBLIC] }, 'result.multipath_expansion'],
  ])('refuses %s', async (_name, change, path) => {
    node.results({ getdescriptorinfo: JSON.stringify({ ...DESCRIPTOR_INFO, ...change }) })
    const error = await failure(client().getDescriptorInfo(RANGED))
    expect(RpcResponseError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'validation', path })
  })

  it('refuses a malformed descriptor before sending it, quoting none of it', async () => {
    for (const descriptor of ['', `${RANGED_BODY}#qqqqqqqq`, `${RANGED}#x`, 'mr(pk(\n))', 7]) {
      const error = await failure(client().getDescriptorInfo(descriptor as never))
      expect(error).toBeInstanceOf(TypeError)
      expect((error as Error).message).not.toContain(XPRV.slice(0, 16))
    }
    expect(node.requests).toHaveLength(0)
  })
})

describe('deriveAddresses', () => {
  it('derives one address per index of the range a ranged descriptor needs', async () => {
    node.results({ deriveaddresses: JSON.stringify(ADDRESSES) })
    expect(await client().deriveAddresses(RANGED, { range: [0, 2] })).toEqual(ADDRESSES)
    expect(node.calls().at(-1)!.params).toEqual([RANGED, [0, 2]])
    await client().deriveAddresses(RANGED, { range: 2 })
    expect(node.calls().at(-1)!.params).toEqual([RANGED, [0, 2]])
    node.results({ deriveaddresses: JSON.stringify([ADDRESS]) })
    expect(await client().deriveAddresses(SINGLE)).toEqual([ADDRESS])
    expect(node.calls().at(-1)!.params).toEqual([SINGLE])
    // combo() gives several addresses per index.
    const combo = withChecksum(`combo(${'02'}${'79'.repeat(32)})`)
    node.results({ deriveaddresses: JSON.stringify(ADDRESSES.slice(0, 2)) })
    expect(await client().deriveAddresses(combo)).toHaveLength(2)
  })

  it('refuses, unsent, what qbit Core refuses: no range for *, a range without one, no checksum, multipath', async () => {
    const rpc = client()
    await expect(rpc.deriveAddresses(RANGED)).rejects.toThrow(/range is required for a ranged descriptor/)
    await expect(rpc.deriveAddresses(SINGLE, { range: 1 })).rejects.toThrow(/only for a ranged descriptor/)
    await expect(rpc.deriveAddresses(RANGED_BODY, { range: 1 })).rejects.toThrow(/needs its checksum/)
    await expect(rpc.deriveAddresses(MULTIPATH, { range: 1 })).rejects.toThrow(/must not be multipath/)
    await expect(rpc.deriveAddresses(RANGED, { range: [3, 1] })).rejects.toThrow(RangeError)
    // The size limit holds for an end index too: 1,000,000 is 1,000,001 indexes.
    await expect(rpc.deriveAddresses(RANGED, { range: 1_000_000 })).rejects.toThrow(/end index of at most 999999/)
    await expect(rpc.deriveAddresses(RANGED, { range: [0, 1_000_000] })).rejects.toThrow(/at most 1,000,000/)
    await expect(rpc.deriveAddresses(RANGED, { range: [0, 1, 2] as never })).rejects.toThrow(/\[begin, end\]/)
    expect(node.requests).toHaveLength(0)
  })

  it('refuses a reply with another number of addresses than indexes', async () => {
    node.results({ deriveaddresses: JSON.stringify(ADDRESSES.slice(0, 2)) })
    expect(await failure(client().deriveAddresses(RANGED, { range: 2 }))).toMatchObject({
      name: 'RpcResponseError',
      path: 'result',
    })
    node.results({ deriveaddresses: JSON.stringify(['not an address!']) })
    expect(await failure(client().deriveAddresses(SINGLE))).toMatchObject({ path: 'result[0]' })
  })
})

describe('signDataPqcHash', () => {
  it('signs under the option names the node reads, and returns a proof verifyDataPqcHash takes as it is', async () => {
    const rpc = await admin()
    answer({ ...SIGNED, ...USAGE })
    const signed = await rpc.signDataPqcHash(ADDRESS, 'AB'.repeat(32), {
      pubkey: PUBKEY.toUpperCase(),
      leafScript: SIGNED.leaf_script,
      controlBlock: 'C1',
      includePqcUsage: true,
    })
    expect(sentParams()).toEqual([
      ADDRESS,
      'ab'.repeat(32),
      { pubkey: PUBKEY, leaf_script: SIGNED.leaf_script, control_block: 'c1', include_pqc_usage: true },
    ])
    expect(signed).toEqual({
      address: ADDRESS,
      messageHash: 'ab'.repeat(32),
      signature: SIGNATURE,
      pubkey: PUBKEY,
      leafScript: SIGNED.leaf_script,
      controlBlock: 'c1',
      leafVersion: 192,
      proofMode: 'p2mr-pubkey',
      datasigHash: '18'.repeat(32),
      domain: 'QbitDataSigPQC',
      algorithm: 'SLH-DSA-SHA2-128s-bounded30',
      p2mrMerkleRoot: '58'.repeat(32),
      pqcKeyStates: [
        {
          pubkey: PUBKEY,
          pqcSignatureCount: 1,
          pqcSignatureLimit: 1073741824,
          pqcSignaturesRemaining: 1073741823,
          pqcLimitState: 'normal',
        },
      ],
      pqcOverallLimitState: 'normal',
      pqcSignatureCount: 1,
      pqcSignatureLimit: 1073741824,
      pqcSignaturesRemaining: 1073741823,
      pqcLimitState: 'normal',
    })

    answer({ valid: true, address: ADDRESS })
    expect(await rpc.verifyDataPqcHash(signed)).toMatchObject({ valid: true })
    expect(sentParams()).toEqual([
      {
        address: ADDRESS,
        message_hash: 'ab'.repeat(32),
        signature: SIGNATURE,
        pubkey: PUBKEY,
        leaf_script: SIGNED.leaf_script,
        control_block: 'c1',
        leaf_version: 192,
        proof_mode: 'p2mr-pubkey',
      },
    ])
    await expect(rpc.verifyDataPqcHash({ ...signed, datasig: 'x' } as never)).rejects.toThrow(/not a known key/)

    answer(SIGNED)
    const plain = await rpc.signDataPqcHash(ADDRESS, 'ab'.repeat(32))
    expect(plain).not.toHaveProperty('pqcKeyStates')
    expect(sentParams()).toEqual([ADDRESS, 'ab'.repeat(32)])
  })

  it.each([
    ['another address', { address: 'qbrt1zother' }, 'result.address'],
    ['another hash', { message_hash: 'cd'.repeat(32) }, 'result.message_hash'],
    ['another pubkey than asked for', { pubkey: 'dd'.repeat(32) }, 'result.pubkey'],
    ['another proof mode', { proof_mode: 'p2mr-script' }, 'result.proof_mode'],
    ['an empty signature', { signature: '' }, 'result.signature'],
    ['an unknown budget state as nothing', { pqc_limit_state: '' }, 'result.pqc_limit_state'],
  ])('takes %s for an invalid reply, after which a signature may have counted', async (_name, change, path) => {
    const rpc = await admin()
    answer({ ...SIGNED, ...change })
    const error = await failure(rpc.signDataPqcHash(ADDRESS, 'ab'.repeat(32), { pubkey: PUBKEY }))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect((error as Error).cause).toMatchObject({ name: 'RpcResponseError', path })
  })

  it('takes the address back in either case, as bech32m does, and refuses another', async () => {
    const rpc = await admin()
    const upper = ADDRESS.toUpperCase()
    // qbit Core v1.0.0 echoes the address as it was sent (seen on regtest).
    answer({ ...SIGNED, address: upper })
    expect(await rpc.signDataPqcHash(upper, 'ab'.repeat(32))).toMatchObject({ address: upper })
    expect(sentParams()[0]).toBe(upper)
    // A node that printed it in lowercase names the same key: no failure after the signature was spent.
    answer(SIGNED)
    expect(await rpc.signDataPqcHash(upper, 'ab'.repeat(32))).toMatchObject({ address: ADDRESS })
    answer({ ...SIGNED, address: upper })
    expect(await rpc.signDataPqcHash(ADDRESS, 'ab'.repeat(32))).toMatchObject({ address: upper })
    answer({ ...SIGNED, address: ADDRESSES[1] })
    const other = await failure(rpc.signDataPqcHash(upper, 'ab'.repeat(32)))
    expect(RpcUnknownOutcomeError.is(other)).toBe(true)
    expect((other as Error).cause).toMatchObject({ reason: 'validation', path: 'result.address' })
  })

  it('refuses, unsent, a malformed argument, and in call() an option name the node would ignore', async () => {
    const rpc = await admin()
    await expect(rpc.signDataPqcHash('', HASH_A)).rejects.toThrow(TypeError)
    await expect(rpc.signDataPqcHash(ADDRESS, 'ab')).rejects.toThrow(/64 hex characters/)
    await expect(rpc.signDataPqcHash(ADDRESS, HASH_A, { pubkey: 'ab' })).rejects.toThrow(/options\.pubkey/)
    await expect(rpc.signDataPqcHash(ADDRESS, HASH_A, { controlBlock: 'c1ab' })).rejects.toThrow(/1 \+ 32 × n bytes/)
    await expect(rpc.signDataPqcHash(ADDRESS, HASH_A, { include_pqc_usage: true } as never)).rejects.toThrow(
      /use options\.includePqcUsage/
    )
    for (const key of ['includePqcUsage', 'leafScript', 'controlBlock']) {
      await expect(rpc.call('signdatapqchash', [ADDRESS, HASH_A, { [key]: true }])).rejects.toThrow(
        new RegExp(
          `^signdatapqchash option ${key} is accepted and then ignored by qbit Core v1\\.0\\.0: send [a-z_]+, or use signDataPqcHash\\(\\)$`
        )
      )
    }
    expect(node.requests).toHaveLength(0)
  })
})

describe('secrets', () => {
  const SECRETS = [PASSPHRASE, NEW_PASSPHRASE, XPRV.slice(0, 16), XPRV.slice(-16)]
  const secretCalls: readonly [string, (rpc: QbitRpcClient, call: { timeoutMs?: number }) => Promise<unknown>][] = [
    ['createwallet', (rpc, call) => rpc.createWallet('w', { passphrase: PASSPHRASE }, call)],
    ['walletpassphrasechange', (rpc, call) => rpc.walletPassphraseChange(PASSPHRASE, NEW_PASSPHRASE, call)],
    ['importdescriptors', (rpc, call) => rpc.importDescriptors([{ desc: RANGED, timestamp: 0 }], call)],
    ['getdescriptorinfo', (rpc, call) => rpc.getDescriptorInfo(RANGED, call)],
    ['deriveaddresses', (rpc, call) => rpc.deriveAddresses(RANGED, { range: 1 }, call)],
  ]

  it('keeps passphrases and descriptors out of every error, the client and the console, sending them only in the body', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'info'] as const).map(name => vi.spyOn(console, name))
    const rpc = await admin({ readRetries: 1, retryDelayMs: 0 })
    const incorrect = { code: -14, message: 'Error: The wallet passphrase entered was incorrect.' }
    const outcomes: [string, () => void][] = [
      ['a lost reply', () => (node.handler = (_request, response) => response.socket?.destroy())],
      ['a deadline', () => (node.handler = () => undefined)],
      ['an invalid reply', () => answer({ unexpected: true })],
      ['an answer of the node', () => replyWith(() => ({ error: incorrect }))],
    ]
    for (const [, fail] of outcomes) {
      for (const [method, call] of secretCalls) {
        node.results(chainResults('regtest'))
        await rpc.confirmChain()
        fail()
        const before = node.requests.length
        const error = await failure(call(rpc, { timeoutMs: 200 }))
        expect(error).toMatchObject({ method })
        assertClean(error, SECRETS)
        expect(node.requests.slice(before).some(request => request.body.includes(method))).toBe(true)
      }
    }
    // The argument checks name the argument, never its value.
    const refused = await Promise.all([
      failure(rpc.walletPassphraseChange(PASSPHRASE, 7 as never)),
      failure(rpc.createWallet(PASSPHRASE as never, { passphrase: PASSPHRASE, disablePrivateKeys: true })),
      failure(rpc.importDescriptors([{ desc: `${RANGED}x`, timestamp: 0 }])),
    ])
    for (const error of refused) assertClean(error, SECRETS)
    assertClean(rpc, SECRETS)
    assertClean(rpc.toJSON(), SECRETS)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  }, 20_000)

  it('redacts nothing from requests that carry no descriptor', () => {
    const request: RpcRequest<unknown> = requests.raw('getblockcount')
    expect(request.params).toEqual([])
    expect(requests.walletPassphraseChange(PASSPHRASE, NEW_PASSPHRASE).params).toEqual([PASSPHRASE, NEW_PASSPHRASE])
  })
})

/** A call's outcome, and whether it has settled yet. */
function track(promise: Promise<unknown>): { settled: boolean; readonly outcome: Promise<unknown> } {
  const tracked = {
    settled: false,
    outcome: promise.then(
      value => ({ value }),
      (error: unknown) => error
    ),
  }
  void tracked.outcome.then(() => (tracked.settled = true))
  return tracked
}

/** Wait (in real time) until the node has seen `count` requests. */
async function sent(count: number): Promise<void> {
  for (let waited = 0; node.requests.length < count; waited += 5) {
    if (waited > 5_000) throw new Error(`the node saw ${node.requests.length} requests, not ${count}`)
    await settle(5)
  }
}

describe('default deadlines', () => {
  const timedOut = (method: string, timeoutMs: number) => ({
    name: 'RpcUnknownOutcomeError',
    method,
    cause: { name: 'RpcTimeoutError', method, timeoutMs },
  })

  it('are 120 s for the calls that derive keys, scan blocks or wait for them, typed or raw, and 30 s for the rest', async () => {
    const rpc = await admin({ chainCheckMaxAgeMs: 86_400_000, maxConcurrentRequests: 16 })
    node.handler = () => {} // the node never answers
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const long = [
      ['keypoolrefill', track(rpc.keypoolRefill())],
      ['keypoolrefill', track(rpc.call('keypoolrefill'))],
      ['importdescriptors', track(rpc.importDescriptors([{ desc: SINGLE, timestamp: 0 }]))],
      ['rescanblockchain', track(rpc.rescanBlockchain())],
      ['rescanblockchain', track(rpc.call('rescanblockchain', [0]))],
      ['unloadwallet', track(rpc.unloadWallet('w'))],
      // Loading attaches the wallet to the chain: it rescans and tops up the keypool.
      ['loadwallet', track(rpc.loadWallet('w'))],
      ['loadwallet', track(rpc.call('loadwallet', ['w']))],
    ] as const
    const short = [
      ['createwallet', track(rpc.createWallet('w', { passphrase: PASSPHRASE }))],
      ['backupwallet', track(rpc.backupWallet('w.dat'))],
      ['walletpassphrasechange', track(rpc.walletPassphraseChange(PASSPHRASE, NEW_PASSPHRASE))],
      ['signdatapqchash', track(rpc.signDataPqcHash(ADDRESS, HASH_A))],
    ] as const
    const listing = track(rpc.listWalletDir())
    await sent(long.length + short.length + 1)

    await vi.advanceTimersByTimeAsync(29_999)
    await settle()
    expect([...long, ...short].some(([, call]) => call.settled) || listing.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    for (const [method, call] of short) expect(await call.outcome).toMatchObject(timedOut(method, 30_000))
    expect(await listing.outcome).toMatchObject({ name: 'RpcTimeoutError', method: 'listwalletdir', timeoutMs: 30_000 })

    await vi.advanceTimersByTimeAsync(89_999)
    await settle()
    expect(long.some(([, call]) => call.settled)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    for (const [method, call] of long) expect(await call.outcome).toMatchObject(timedOut(method, 120_000))
  })

  it("keep 120 s under a shorter client timeoutMs, take a longer one, and give way to the call's", async () => {
    const shortClient = await admin({ timeoutMs: 100, chainCheckMaxAgeMs: 86_400_000 })
    node.handler = () => {}
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const kept = track(shortClient.rescanBlockchain())
    const cut = track(shortClient.backupWallet('w.dat'))
    await sent(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(await cut.outcome).toMatchObject(timedOut('backupwallet', 100))
    await vi.advanceTimersByTimeAsync(119_899)
    await settle()
    expect(kept.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await kept.outcome).toMatchObject(timedOut('rescanblockchain', 120_000))
    vi.useRealTimers()

    const longClient = await admin({ timeoutMs: 600_000, chainCheckMaxAgeMs: 86_400_000 })
    node.handler = () => {}
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const refill = track(longClient.keypoolRefill({ newSize: 5000 }))
    const own = track(longClient.importDescriptors([{ desc: SINGLE, timestamp: 0 }], { timeoutMs: 50 }))
    await sent(2)
    await vi.advanceTimersByTimeAsync(50)
    expect(await own.outcome).toMatchObject(timedOut('importdescriptors', 50))
    await vi.advanceTimersByTimeAsync(599_949)
    await settle()
    expect(refill.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await refill.outcome).toMatchObject(timedOut('keypoolrefill', 600_000))
  })
})
