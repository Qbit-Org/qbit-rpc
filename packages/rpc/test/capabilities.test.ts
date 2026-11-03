import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  METHOD_POLICIES,
  QbitRpcClient,
  requests,
  RpcCapabilityError,
  RpcChainGuardError,
  type Capability,
} from '../src'
import { blockchainInfoJson, FakeNode, HASH_A, TX_HEX } from './helpers/fake-node'

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
  node.results({ getblockchaininfo: blockchainInfoJson('testnet4'), sendrawtransaction: '"x"', walletlock: 'null' })
})
afterEach(async () => {
  await node.close()
})

function client(capabilities?: Capability[]): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'user', password: 'pass' },
    expectedChain: 'testnet4',
    ...(capabilities === undefined ? {} : { capabilities }),
  })
}

async function refusal(promise: Promise<unknown>): Promise<RpcCapabilityError> {
  const error = await promise.then(
    () => expect.fail('expected a refusal'),
    (e: unknown) => e
  )
  expect(RpcCapabilityError.is(error)).toBe(true)
  return error as RpcCapabilityError
}

describe('capabilities', () => {
  it('defaults to read-only and refuses each other capability before sending anything', async () => {
    const rpc = client()
    const cases: [Promise<unknown>, Capability][] = [
      [rpc.getWalletInfo(), 'wallet-read'],
      [rpc.listUnspent(), 'wallet-read'],
      [rpc.getTransaction(HASH_A), 'wallet-read'],
      [rpc.getAddressInfo('qbrt1zaddress'), 'wallet-read'],
      [rpc.listLockUnspent(), 'wallet-read'],
      [rpc.listSinceBlock(), 'wallet-read'],
      [rpc.listTransactions(), 'wallet-read'],
      [rpc.getBalances(), 'wallet-read'],
      [rpc.walletLock(), 'wallet-write'],
      [rpc.getRawChangeAddress({ addressType: 'p2mr' }), 'wallet-write'],
      [rpc.getNewAddress({ label: 'deposit' }), 'wallet-write'],
      [rpc.lockUnspent(false, [{ txid: HASH_A, vout: 0 }]), 'wallet-write'],
      [rpc.walletPassphrase('secret passphrase', 10), 'wallet-write'],
      [rpc.walletProcessPsbt('cHNidP8='), 'wallet-write'],
      [rpc.finalizePsbt('cHNidP8='), 'wallet-write'],
      [rpc.sendRawTransaction(TX_HEX), 'broadcast'],
      [rpc.testMempoolAccept([TX_HEX]), 'broadcast'],
    ]
    for (const [promise, capability] of cases) {
      const error = await refusal(promise)
      expect(error.reason).toBe('not_enabled')
      expect(error.required).toBe(capability)
    }
    expect(node.requests).toHaveLength(0)
  })

  it('applies the same allowlist to call() and refuses unknown or excluded methods', async () => {
    const rpc = client(['wallet-read', 'wallet-write', 'broadcast'])
    await rpc.confirmChain()
    const before = node.requests.length
    for (const method of ['sendmany', 'sendtoaddress', 'send', 'sendall', 'bumpfee', 'dumpwallet', 'stop', '']) {
      const error = await rpc.call(method, []).then(
        () => expect.fail('expected a refusal'),
        (e: unknown) => e
      )
      expect(RpcCapabilityError.is(error) || error instanceof TypeError).toBe(true)
    }
    expect((await refusal(rpc.call('sendmany', ['', {}]))).reason).toBe('unknown_method')
    expect((await refusal(client().call('getbalances'))).required).toBe('wallet-read')
    expect((await refusal(client().call('sendrawtransaction', [TX_HEX]))).required).toBe('broadcast')
    expect(node.requests).toHaveLength(before)
  })

  it('refuses side-effecting and broadcast methods in a batch, sending nothing', async () => {
    const rpc = client(['wallet-read', 'wallet-write', 'broadcast'])
    await rpc.confirmChain()
    const before = node.requests.length
    const error = await refusal(rpc.batch([requests.getBestBlockHash(), requests.walletLock()]))
    expect(error.reason).toBe('not_batchable')
    expect((await refusal(rpc.batch([requests.testMempoolAccept([TX_HEX])]))).reason).toBe('not_batchable')
    expect((await refusal(rpc.batch([requests.getRawChangeAddress()]))).reason).toBe('not_batchable')
    expect((await refusal(rpc.batch([requests.getBalances(), requests.getNewAddress()]))).reason).toBe('not_batchable')
    const lock = requests.lockUnspent(true, [{ txid: HASH_A, vout: 0 }])
    expect((await refusal(rpc.batch([requests.listLockUnspent(), lock]))).reason).toBe('not_batchable')
    expect((await refusal(client().batch([requests.getWalletInfo()]))).reason).toBe('not_enabled')
    expect((await refusal(client().batch([requests.getBlockCount(), requests.listLockUnspent()]))).reason).toBe(
      'not_enabled'
    )
    expect(node.requests).toHaveLength(before)
  })

  it('allows reads without capabilities and enabled wallet reads without a chain check', async () => {
    node.results({ getbestblockhash: JSON.stringify(HASH_A), listwallets: '["w"]' })
    expect(await client().getBestBlockHash()).toBe(HASH_A)
    expect(await client(['wallet-read']).call('listwallets')).toEqual(['w'])
  })

  it('treats getblockcount, getmempoolentry and gettxout as reads, and the wallet methods by what they change', async () => {
    node.results({
      getblockcount: '7',
      getmempoolentry: JSON.stringify({
        vsize: 1,
        weight: 1,
        time: 1,
        height: 1,
        descendantcount: 1,
        descendantsize: 1,
        ancestorcount: 1,
        ancestorsize: 1,
        wtxid: HASH_A,
        fees: { base: 0, modified: 0, ancestor: 0, descendant: 0 },
        depends: [],
        spentby: [],
        'bip125-replaceable': false,
        unbroadcast: false,
      }),
      gettxout: 'null',
      listlockunspent: '[]',
    })
    const reader = client()
    expect(await reader.getBlockCount()).toBe(7)
    expect((await reader.getMempoolEntry(HASH_A)).unbroadcast).toBe(false)
    expect(await reader.getTxOut(HASH_A, 0)).toBeNull()
    const [count, out] = await reader.batch([requests.getBlockCount(), requests.getTxOut(HASH_A, 1)])
    expect([count, out]).toEqual([
      { ok: true, value: 7 },
      { ok: true, value: null },
    ])
    expect(await client(['wallet-read']).listLockUnspent()).toEqual([])
    // A wallet reader may not take change keys or lock coins.
    const walletReader = client(['wallet-read'])
    for (const promise of [
      walletReader.getRawChangeAddress(),
      walletReader.lockUnspent(true, [{ txid: HASH_A, vout: 0 }]),
    ]) {
      expect((await refusal(promise)).required).toBe('wallet-write')
    }
    const policies = Object.fromEntries(
      [
        'getblockcount',
        'getmempoolentry',
        'gettxout',
        'getaddressinfo',
        'listlockunspent',
        'getrawchangeaddress',
        'lockunspent',
      ].map(method => [method, METHOD_POLICIES[method]])
    )
    expect(policies).toEqual({
      getblockcount: { capability: 'read', sideEffects: false },
      getmempoolentry: { capability: 'read', sideEffects: false },
      gettxout: { capability: 'read', sideEffects: false },
      getaddressinfo: { capability: 'wallet-read', sideEffects: false },
      listlockunspent: { capability: 'wallet-read', sideEffects: false },
      getrawchangeaddress: { capability: 'wallet-write', sideEffects: true },
      lockunspent: { capability: 'wallet-write', sideEffects: true },
    })
  })

  it('rejects unknown capability names at construction', () => {
    expect(() => client(['admin' as Capability])).toThrow(TypeError)
  })
})

describe('chain guard', () => {
  it('refuses wallet-write and broadcast until confirmChain() matches, then allows them', async () => {
    const rpc = client(['wallet-write', 'broadcast'])
    for (const promise of [
      rpc.walletLock(),
      rpc.sendRawTransaction(TX_HEX),
      rpc.call('lockunspent', [true]),
      rpc.lockUnspent(false, [{ txid: HASH_A, vout: 0 }]),
      rpc.getRawChangeAddress(),
      rpc.getNewAddress(),
    ]) {
      const error = await promise.then(
        () => expect.fail('expected a refusal'),
        (e: unknown) => e
      )
      expect(RpcChainGuardError.is(error)).toBe(true)
      expect((error as RpcChainGuardError).reason).toBe('unconfirmed')
    }
    expect(node.requests).toHaveLength(0)
    expect(rpc.chainStatus).toBe('unconfirmed')

    const info = await rpc.confirmChain()
    expect(info.chain).toBe('testnet4')
    expect(rpc.chainStatus).toBe('confirmed')
    await rpc.walletLock()
    expect(node.calls().map(call => call.method)).toEqual(['getblockchaininfo', 'walletlock'])
  })

  it('keeps refusing after a mismatch, naming both chains', async () => {
    node.results({ getblockchaininfo: blockchainInfoJson('main') })
    const rpc = client(['wallet-write'])
    const mismatch = await rpc.confirmChain().then(
      () => expect.fail('expected a mismatch'),
      (e: unknown) => e
    )
    expect(RpcChainGuardError.is(mismatch)).toBe(true)
    expect(mismatch).toMatchObject({ reason: 'mismatch', expected: 'testnet4', actual: 'main' })
    expect(rpc.chainStatus).toBe('mismatch')
    const refused = await rpc.walletLock().then(
      () => expect.fail('expected a refusal'),
      (e: unknown) => e
    )
    expect(refused).toMatchObject({ reason: 'mismatch', actual: 'main' })
    expect(node.calls().map(call => call.method)).toEqual(['getblockchaininfo'])
  })

  it('gates testmempoolaccept like sendrawtransaction, but not reads', async () => {
    node.results({ getbestblockhash: JSON.stringify(HASH_A) })
    const rpc = client(['wallet-read', 'broadcast'])
    expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    const error = await rpc.testMempoolAccept([TX_HEX]).then(
      () => expect.fail('expected a refusal'),
      (e: unknown) => e
    )
    expect(RpcChainGuardError.is(error)).toBe(true)
  })
})
