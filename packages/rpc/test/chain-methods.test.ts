import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  QbitRpcClient,
  requests,
  RpcCapabilityError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcResponseTooLargeError,
  RpcTimeoutError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
} from '../src'
import { METHOD_POLICIES } from '../src/capabilities'
import { chainResults, FakeNode, HASH_A, HASH_B, TX_HEX, TX_TXID, type CallReply } from './helpers/fake-node'

const realSetTimeout = setTimeout
const settle = (ms = 20): Promise<void> => new Promise(resolve => realSetTimeout(resolve, ms))

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
})
afterEach(async () => {
  vi.useRealTimers()
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

async function invalid(promise: Promise<unknown>, path: string): Promise<void> {
  const error = await failure(promise)
  expect(RpcResponseError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason: 'validation', path })
}

/** Answer `method` with a raw JSON result text. */
const answer = (method: string, result: unknown): void =>
  node.results({ [method]: typeof result === 'string' ? result : JSON.stringify(result) })

const HEADER = {
  hash: HASH_B,
  confirmations: 1,
  height: 1,
  version: 536870912,
  versionHex: '20000000',
  merkleroot: HASH_A,
  time: 1793821507,
  mediantime: 1793821506,
  nonce: 0,
  bits: '207fffff',
  target: '7f'.padEnd(64, 'f'),
  difficulty: 4.656542373906925e-10,
  chainwork: '00'.repeat(31) + '02',
  nTx: 1,
  previousblockhash: HASH_A,
  strippedsize: 226,
  size: 262,
  weight: 262,
}
const SCRIPT_PUB_KEY = { asm: '2 aa', desc: 'rawmr(aa)#x', hex: '5201aa', address: 'qbrt1z', type: 'witness_v2_p2mr' }
const BLOCK_TX = {
  txid: HASH_A,
  hash: HASH_B,
  version: 2,
  size: 181,
  vsize: 181,
  weight: 181,
  locktime: 0,
  vin: [{ txid: HASH_B, vout: 0, scriptSig: { asm: '', hex: '' }, txinwitness: ['aa'], sequence: 4294967293 }],
  vout: [{ value: '@1.5@', n: 0, scriptPubKey: SCRIPT_PUB_KEY }],
  fee: '@0.00001000@',
  hex: 'aabb',
}
/** JSON with the `@…@` strings as number literals, as the node prints amounts. */
const json = (value: unknown): string => JSON.stringify(value).replace(/"@([^@]*)@"/g, '$1')

describe('getBlock', () => {
  it('asks for verbosity 1, and checks the hash and the transaction count', async () => {
    const reply = { ...HEADER, tx: [HASH_A] }
    answer('getblock', reply)
    const rpc = client()
    expect(await rpc.getBlock(HASH_B.toUpperCase())).toMatchObject({
      hash: HASH_B,
      merkleRoot: HASH_A,
      previousBlockHash: HASH_A,
      strippedSize: 226,
      size: 262,
      weight: 262,
      tx: [HASH_A],
    })
    expect(node.calls()).toMatchObject([{ method: 'getblock', params: [HASH_B, 1] }])
    await invalid(rpc.getBlock(HASH_A), 'result.hash')
    answer('getblock', { ...reply, tx: [HASH_A, HASH_B] })
    await invalid(rpc.getBlock(HASH_B), 'result.tx')
    answer('getblock', { ...reply, size: undefined })
    await invalid(rpc.getBlock(HASH_B), 'result.size')
    await expect(rpc.getBlock('zz')).rejects.toThrow(TypeError)
  })

  it('reads a stale block as confirmations -1, and the node’s refusal as its error', async () => {
    answer('getblock', { ...HEADER, confirmations: -1, tx: [HASH_A] })
    expect((await client().getBlock(HASH_B)).confirmations).toBe(-1)
    node.rpc(() => ({ error: { code: -5, message: 'Block not found' } }))
    expect(await failure(client().getBlock(HASH_B))).toMatchObject({ rpcCode: -5 })
  })

  it('asks for verbosity 2, and validates each transaction as getRawTransactionVerbose does', async () => {
    const coinbase = { ...BLOCK_TX, vin: [{ coinbase: '02f2', sequence: 4294967294 }], fee: undefined }
    const reply = { ...HEADER, nTx: 2, tx: [coinbase, BLOCK_TX] }
    node.results({ getblock: json(reply) })
    const rpc = client()
    const block = await rpc.getBlockWithTransactions(HASH_B)
    expect(node.calls().at(-1)).toMatchObject({ method: 'getblock', params: [HASH_B, 2] })
    expect(block.tx[0]).not.toHaveProperty('feeBits')
    expect(block.tx[0]!.vin[0]).toEqual({ coinbase: '02f2', sequence: 4294967294 })
    expect(block.tx[1]).toMatchObject({ txid: HASH_A, feeBits: 1000n, vout: [{ valueBits: 150_000_000n, n: 0 }] })

    node.results({ getblock: json({ ...reply, tx: [coinbase] }) })
    await invalid(rpc.getBlockWithTransactions(HASH_B), 'result.tx')
    node.results({
      getblock: json({ ...reply, tx: [coinbase, { ...BLOCK_TX, vout: [{ ...BLOCK_TX.vout[0], n: 1 }] }] }),
    })
    await invalid(rpc.getBlockWithTransactions(HASH_B), 'result.tx[1].vout[0].n')
    node.results({ getblock: json({ ...reply, tx: [coinbase, { ...BLOCK_TX, fee: -1 }] }) })
    await invalid(rpc.getBlockWithTransactions(HASH_B), 'result.tx[1].fee')
    node.results({ getblock: json({ ...reply, tx: [HASH_A, HASH_B] }) })
    await invalid(rpc.getBlockWithTransactions(HASH_B), 'result.tx[0]')
  })

  it('reports a reply over maxResponseBytes as too large, a read’s plain failure', async () => {
    const tx = { ...BLOCK_TX, hex: 'aa'.repeat(2048) }
    node.results({ getblock: json({ ...HEADER, tx: [tx] }) })
    const error = await failure(client({ maxResponseBytes: 1024 }).getBlockWithTransactions(HASH_B))
    expect(RpcResponseTooLargeError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'getblock', limitBytes: 1024 })
    await expect(client({ maxResponseBytes: 8192 }).getBlockWithTransactions(HASH_B)).resolves.toMatchObject({
      hash: HASH_B,
    })
  })

  it('asks for verbosity 0, and checks the hex’s header hashes to the block', async () => {
    const header = 'ab'.repeat(80)
    const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest()
    const hash = Buffer.from(sha256(sha256(Buffer.from(header, 'hex'))))
      .reverse()
      .toString('hex')
    const blockHex = `${header}01aabb`
    answer('getblock', JSON.stringify(blockHex))
    const rpc = client()
    expect(await rpc.getBlockHex(hash)).toBe(blockHex)
    expect(node.calls()).toMatchObject([{ method: 'getblock', params: [hash, 0] }])
    await invalid(rpc.getBlockHex(HASH_A), 'result')
    answer('getblock', '"abab"')
    await invalid(rpc.getBlockHex(hash), 'result')
    answer('getblock', '"xyz"')
    await invalid(rpc.getBlockHex(hash), 'result')
  })

  it('goes in a batch', async () => {
    answer('getblock', { ...HEADER, tx: [HASH_A] })
    const [block] = await client().batch([requests.getBlock(HASH_B)])
    expect(block.ok && block.value.tx).toEqual([HASH_A])
  })
})

describe('getChainTips', () => {
  const active = { height: 5, hash: HASH_A, branchlen: 0, status: 'active' }
  const fork = { height: 4, hash: HASH_B, branchlen: 1, status: 'valid-fork' }

  it('returns every tip, and passes a status a later qbit Core adds through', async () => {
    answer('getchaintips', [active, fork, { ...fork, status: 'some-later-status' }])
    expect(await client().getChainTips()).toEqual([
      { height: 5, hash: HASH_A, branchLen: 0, status: 'active' },
      { height: 4, hash: HASH_B, branchLen: 1, status: 'valid-fork' },
      { height: 4, hash: HASH_B, branchLen: 1, status: 'some-later-status' },
    ])
  })

  it.each([
    ['no active tip', [fork], 'result'],
    ['two active tips', [active, active], 'result'],
    ['an empty status', [active, { ...fork, status: '' }], 'result[1].status'],
    ['an active tip on a branch', [{ ...active, branchlen: 1 }], 'result[0].branchlen'],
    ['another tip at branch length 0', [active, { ...fork, branchlen: 0 }], 'result[1].branchlen'],
    ['a negative height', [{ ...active, height: -1 }], 'result[0].height'],
  ])('refuses %s', async (_name, reply, path) => {
    answer('getchaintips', reply)
    await invalid(client().getChainTips(), path)
  })
})

describe('getMempoolInfo', () => {
  const info = {
    loaded: true,
    size: 2,
    bytes: 7634,
    usage: 14560,
    total_fee: '@0.00001000@',
    maxmempool: 300000000,
    mempoolminfee: '@0.00000250@',
    minrelaytxfee: '@0.00000250@',
    incrementalrelayfee: '@0.00000250@',
    unbroadcastcount: 0,
    fullrbf: true,
    permitbaremultisig: true,
    maxdatacarriersize: 200000,
  }

  it('reads the fee floor in bits per 1,000 vbytes', async () => {
    node.results({ getmempoolinfo: json(info) })
    expect(await client().getMempoolInfo()).toEqual({
      loaded: true,
      size: 2,
      bytes: 7634,
      usage: 14560,
      totalFeeBits: 1000n,
      maxMempool: 300000000,
      mempoolMinFeeBitsPerKvB: 250n,
      minRelayTxFeeBitsPerKvB: 250n,
      incrementalRelayFeeBitsPerKvB: 250n,
      unbroadcastCount: 0,
      fullRbf: true,
      permitBareMultisig: true,
      maxDataCarrierSize: 200000,
    })
  })

  it('takes a reply without the deprecated fullrbf, and refuses one without the fee floor', async () => {
    node.results({ getmempoolinfo: json({ ...info, fullrbf: undefined }) })
    expect(await client().getMempoolInfo()).not.toHaveProperty('fullRbf')
    node.results({ getmempoolinfo: json({ ...info, mempoolminfee: undefined }) })
    await invalid(client().getMempoolInfo(), 'result.mempoolminfee')
  })
})

describe('getRawMempool', () => {
  const entry = {
    vsize: 3817,
    weight: 3817,
    time: 1793821374,
    height: 1010,
    descendantcount: 1,
    descendantsize: 3817,
    ancestorcount: 1,
    ancestorsize: 3817,
    wtxid: HASH_B,
    fees: { base: '@0.2@', modified: '@0.2@', ancestor: '@0.2@', descendant: '@0.2@' },
    depends: [],
    spentby: [],
    'bip125-replaceable': true,
    unbroadcast: false,
  }

  it('returns txids', async () => {
    answer('getrawmempool', [HASH_A])
    expect(await client().getRawMempool()).toEqual([HASH_A])
    expect(node.calls()).toMatchObject([{ method: 'getrawmempool', params: [false] }])
    answer('getrawmempool', ['aa'])
    await invalid(client().getRawMempool(), 'result[0]')
  })

  it('returns each entry by txid, validated as getMempoolEntry does', async () => {
    node.results({ getrawmempool: json({ [HASH_A]: entry }) })
    const pool = await client().getRawMempoolVerbose()
    expect(node.calls()).toMatchObject([{ method: 'getrawmempool', params: [true] }])
    expect(Object.keys(pool)).toEqual([HASH_A])
    expect(pool[HASH_A]).toMatchObject({ vsize: 3817, wtxid: HASH_B, fees: { baseBits: 20_000_000n } })
    node.results({ getrawmempool: json({ [HASH_A]: { ...entry, vsize: -1 } }) })
    await invalid(client().getRawMempoolVerbose(), `result.${HASH_A}.vsize`)
    node.results({ getrawmempool: json({ __proto__x: entry }) })
    await invalid(client().getRawMempoolVerbose(), 'result.__proto__x (its key)')
    // The key JSON.parse keeps as an own property, which must not set the prototype of the result.
    node.results({ getrawmempool: `{"__proto__":${json(entry)}}` })
    await invalid(client().getRawMempoolVerbose(), 'result.__proto__ (its key)')
  })

  it('returns the mempool sequence as the ZMQ topic’s bigint, above 2^53 too', async () => {
    answer('getrawmempool', `{"txids":["${HASH_A}"],"mempool_sequence":18446744073709551615}`)
    expect(await client().getRawMempoolSequence()).toEqual({
      txids: [HASH_A],
      mempoolSequence: 18446744073709551615n,
    })
    expect(node.calls()).toMatchObject([{ method: 'getrawmempool', params: [false, true] }])
    answer('getrawmempool', `{"txids":[],"mempool_sequence":-1}`)
    await invalid(client().getRawMempoolSequence(), 'result.mempool_sequence')
  })
})

describe('getTxSpendingPrevout', () => {
  const outputs = [
    { txid: HASH_A, vout: 0 },
    { txid: HASH_B, vout: 7 },
  ]

  it('names the spender of a spent output and none for an unspent one', async () => {
    answer('gettxspendingprevout', [
      { txid: HASH_A, vout: 0, spendingtxid: HASH_B },
      { txid: HASH_B, vout: 7 },
    ])
    const spent = await client().getTxSpendingPrevout(outputs)
    expect(spent).toEqual([
      { txid: HASH_A, vout: 0, spendingTxid: HASH_B },
      { txid: HASH_B, vout: 7 },
    ])
    expect(spent[1]).not.toHaveProperty('spendingTxid')
    expect(node.calls()).toMatchObject([{ method: 'gettxspendingprevout', params: [outputs] }])
  })

  it('checks the reply against the outputs asked about, in case-folded order', async () => {
    const rpc = client()
    const asked = [{ txid: HASH_A.toUpperCase(), vout: 0 }]
    answer('gettxspendingprevout', [{ txid: HASH_A, vout: 0 }])
    expect(await rpc.getTxSpendingPrevout(asked)).toEqual([{ txid: HASH_A, vout: 0 }])
    await invalid(rpc.getTxSpendingPrevout(outputs), 'result')
    answer('gettxspendingprevout', [
      { txid: HASH_B, vout: 7 },
      { txid: HASH_A, vout: 0 },
    ])
    await invalid(rpc.getTxSpendingPrevout(outputs), 'result[0]')
    answer('gettxspendingprevout', [{ txid: HASH_A, vout: 1 }])
    await invalid(rpc.getTxSpendingPrevout([outputs[0]!]), 'result[0]')
    answer('gettxspendingprevout', [{ txid: HASH_A, vout: 0, spendingtxid: 'aa' }])
    await invalid(rpc.getTxSpendingPrevout([outputs[0]!]), 'result[0].spendingtxid')
  })

  it('refuses a bad argument unsent, and takes a listUnspent entry’s extra keys', async () => {
    const rpc = client()
    await expect(rpc.getTxSpendingPrevout([])).rejects.toThrow(RangeError)
    await expect(rpc.getTxSpendingPrevout([{ txid: HASH_A, vout: -1 }])).rejects.toThrow(RangeError)
    await expect(rpc.getTxSpendingPrevout([{ txid: HASH_A, vout: 0x8000_0000 }])).rejects.toThrow(RangeError)
    await expect(rpc.getTxSpendingPrevout([{ txid: 'aa', vout: 0 }])).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(0)
    answer('gettxspendingprevout', [{ txid: HASH_A, vout: 0 }])
    const coin = { txid: HASH_A, vout: 0, address: 'qbrt1z', amountBits: 1n }
    await rpc.getTxSpendingPrevout([coin])
    expect(node.calls()[0]!.params).toEqual([[{ txid: HASH_A, vout: 0 }]])
  })
})

describe('long polls', () => {
  const tip = { hash: HASH_A, height: 5 }
  /** The node holds `waitfornewblock` and `waitforblockheight`, and answers anything else at once. */
  const holdWaits = (): void => {
    node.results({ getblockcount: '5' })
    const reads = node.handler
    node.handler = (request, response) => {
      if (/"waitfor/.test(request.body)) return
      return reads(request, response)
    }
  }

  it('sends the wait as the node’s timeout, in milliseconds', async () => {
    answer('waitfornewblock', tip)
    const rpc = client()
    expect(await rpc.waitForNewBlock(1000)).toEqual(tip)
    expect(await rpc.waitForNewBlock(1000, { currentTip: HASH_B.toUpperCase() })).toEqual(tip)
    answer('waitforblockheight', tip)
    expect(await rpc.waitForBlockHeight(9, 2000)).toEqual(tip)
    expect(node.calls()).toMatchObject([
      { method: 'waitfornewblock', params: [1000] },
      { method: 'waitfornewblock', params: [1000, HASH_B] },
      { method: 'waitforblockheight', params: [9, 2000] },
    ])
  })

  it('returns a tip below the height asked for: the wait ran out, which is not a bad reply', async () => {
    answer('waitforblockheight', tip)
    expect(await client().waitForBlockHeight(1_000, 1)).toEqual(tip)
    answer('waitforblockheight', { hash: 'aa', height: 5 })
    await invalid(client().waitForBlockHeight(1_000, 1), 'result.hash')
    answer('waitforblockheight', { hash: HASH_A, height: -1 })
    await invalid(client().waitForBlockHeight(1_000, 1), 'result.height')
  })

  it('refuses a wait with no end, or longer than any deadline, unsent', async () => {
    const rpc = client()
    for (const waitMs of [0, -1, 1.5, 3_590_001, Number.NaN, '1000']) {
      await expect(rpc.waitForNewBlock(waitMs as number)).rejects.toThrow(RangeError)
      await expect(rpc.waitForBlockHeight(1, waitMs as number)).rejects.toThrow(RangeError)
    }
    await expect(rpc.waitForBlockHeight(-1, 1000)).rejects.toThrow(RangeError)
    await expect(rpc.waitForNewBlock(1000, { currentTip: 'zz' })).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(0)
    answer('waitfornewblock', tip)
    await expect(rpc.waitForNewBlock(3_590_000)).resolves.toEqual(tip)
  })

  it('refuses a call deadline under the wait plus the 10 s margin, unsent', async () => {
    const rpc = client()
    await expect(rpc.waitForNewBlock(1000, {}, { timeoutMs: 1000 })).rejects.toThrow(
      'callOptions.timeoutMs must be at least waitMs (1000) plus 10000 ms'
    )
    await expect(rpc.waitForNewBlock(1000, {}, { timeoutMs: 10_999 })).rejects.toThrow(RangeError)
    await expect(rpc.waitForBlockHeight(1, 1000, { timeoutMs: 999 })).rejects.toThrow(RangeError)
    await expect(rpc.call('waitforblockheight', [1, 1000], { timeoutMs: 10_999 })).rejects.toThrow(RangeError)
    expect(node.requests).toHaveLength(0)
    answer('waitfornewblock', tip)
    await expect(rpc.waitForNewBlock(1000, {}, { timeoutMs: 11_000 })).resolves.toEqual(tip)
  })

  it('runs past a short client timeoutMs until the wait plus 10 s, and keeps a longer one', async () => {
    holdWaits()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const outcome = (rpc: QbitRpcClient): { error: unknown } => {
      const seen: { error: unknown } = { error: undefined }
      rpc.waitForNewBlock(5_000).catch((e: unknown) => {
        seen.error = e
      })
      return seen
    }
    const short = outcome(client({ timeoutMs: 1_000 }))
    const byDefault = outcome(client())
    const long = outcome(client({ timeoutMs: 60_000 }))
    await settle()
    await vi.advanceTimersByTimeAsync(14_999)
    await settle()
    expect(short.error).toBeUndefined()
    expect(byDefault.error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(RpcTimeoutError.is(short.error)).toBe(true)
    expect(short.error).toMatchObject({ timeoutMs: 15_000 })
    expect(byDefault.error).toMatchObject({ timeoutMs: 15_000 })
    expect(long.error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(45_000)
    await settle()
    expect(long.error).toMatchObject({ timeoutMs: 60_000 })
  })

  it('lets the call’s timeoutMs set the deadline, above the wait and the margin', async () => {
    holdWaits()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let seen: unknown
    client({ timeoutMs: 60_000 })
      .waitForNewBlock(10, {}, { timeoutMs: 10_050 })
      .catch((e: unknown) => {
        seen = e
      })
    await settle()
    await vi.advanceTimersByTimeAsync(10_050)
    await settle()
    expect(RpcTimeoutError.is(seen)).toBe(true)
    expect(seen).toMatchObject({ timeoutMs: 10_050 })
  })

  it('holds one request slot: other calls go on beside it, and queue only when it holds the last', async () => {
    holdWaits()
    const stop = new AbortController()
    const rpc = client()
    const wait = rpc.waitForNewBlock(60_000, {}, { signal: stop.signal })
    await settle()
    await expect(rpc.getBlockCount()).resolves.toBe(5)
    stop.abort()
    await failure(wait)

    const only = client({ maxConcurrentRequests: 1 })
    const held = new AbortController()
    const holding = only.waitForNewBlock(60_000, {}, { signal: held.signal })
    await settle()
    node.requests.length = 0
    const queued = await failure(only.getBlockCount({ timeoutMs: 50 }))
    expect(RpcTimeoutError.is(queued)).toBe(true)
    expect(node.requests).toHaveLength(0)
    held.abort()
    await failure(holding)
    await expect(only.getBlockCount()).resolves.toBe(5)
  })

  it('asks for no more than the deadline has left after a long wait for a request slot, on its first attempt', async () => {
    holdWaits()
    const only = client({ maxConcurrentRequests: 1 })
    const held = new AbortController()
    const holding = only.waitForNewBlock(60_000, {}, { signal: held.signal })
    await settle()
    // Queued behind it for 2 s of a 13 s deadline: 11 s left, less the 10 s margin, of which a first attempt may use 1 s.
    const queued = only.waitForBlockHeight(9, 3000, { timeoutMs: 13_000 }).catch((e: unknown) => e)
    await new Promise(resolve => setTimeout(resolve, 2000))
    held.abort()
    await failure(holding)
    await expect.poll(() => node.calls().filter(call => call.method === 'waitforblockheight')).toHaveLength(1)
    const [, wait] = node.calls().find(call => call.method === 'waitforblockheight')!.params as [number, number]
    expect(wait).toBeGreaterThan(1500)
    expect(wait).toBeLessThanOrEqual(2000)
    only.close()
    await queued
  })

  it('refuses long polls in a batch, typed or raw, opened through extraMethods too, unsent', async () => {
    const rpc = client({ extraMethods: { waitforblock: { capability: 'read', sideEffects: false } } })
    for (const entry of [
      requests.waitForNewBlock(1000),
      requests.waitForBlockHeight(1, 1000),
      requests.raw('waitfornewblock', [1000]),
      requests.raw('waitforblockheight', [1, 1000]),
      requests.raw('waitforblock', [HASH_A, 1000]),
    ]) {
      const error = await failure(rpc.batch([requests.getBlockCount(), entry]))
      expect(RpcCapabilityError.is(error)).toBe(true)
      expect(error).toMatchObject({ reason: 'not_batchable', method: entry.method })
      expect((error as Error).message).toMatch(/cannot be sent in a batch/)
    }
    // A hand-built entry, with no waitMs, by its method: waitforblock with timeout 0 would wait with no end.
    const handBuilt = { method: 'waitforblock', params: [HASH_A, 0], parse: (value: unknown) => value }
    const error = await failure(rpc.batch([requests.getBlockCount(), handBuilt as never]))
    expect(error).toMatchObject({ reason: 'not_batchable', method: 'waitforblock' })
    expect(node.requests).toHaveLength(0)
  })

  it('bounds a long poll through call() by its own wait, as a typed one', async () => {
    const rpc = client({ timeoutMs: 50, extraMethods: { waitforblock: { capability: 'read', sideEffects: false } } })
    expect(requests.raw('waitfornewblock', [1000])).toMatchObject({ waitMs: 1000 })
    expect(requests.raw('waitforblockheight', [1, 2000])).toMatchObject({ waitMs: 2000 })
    expect(requests.raw('waitforblock', [HASH_A, 3000])).toMatchObject({ waitMs: 3000 })
    expect(requests.raw('getblockcount', [])).not.toHaveProperty('waitMs')
    // Absent or 0, the node waits with no end, holding a worker.
    for (const [method, params] of [
      ['waitfornewblock', []],
      ['waitfornewblock', [0]],
      ['waitfornewblock', [null, HASH_A]],
      ['waitforblockheight', [1]],
      ['waitforblockheight', [1, 0]],
      ['waitforblock', [HASH_A]],
    ] as const) {
      expect(() => requests.raw(method, params), method).toThrow(RangeError)
      expect(() => requests.raw(method, params), method).toThrow(
        `${method} without a timeout, or with 0, waits with no end and holds a qbitd worker meanwhile: pass a timeout in ms as params[`
      )
      await expect(rpc.call(method, params)).rejects.toThrow(/waits with no end/)
    }
    for (const wait of [-1, 1.5, 3_590_001, '1000']) {
      expect(() => requests.raw('waitfornewblock', [wait])).toThrow(/params\[0\] \(waitfornewblock's timeout\)/)
    }
    expect(node.requests).toHaveLength(0)
    // The client's 50 ms do not cut the wait short: the deadline is the wait plus 10 s.
    holdWaits()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let seen: unknown
    rpc.call('waitfornewblock', [5_000]).catch((e: unknown) => {
      seen = e
    })
    await settle()
    await vi.advanceTimersByTimeAsync(14_999)
    await settle()
    expect(seen).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(seen).toMatchObject({ timeoutMs: 15_000 })
  })

  /** The node holds each long poll until the test lets go of it, which drops the connection. */
  function heldWaits(): { readonly held: (() => void)[] } {
    node.results({ getblockcount: '5' })
    const reads = node.handler
    const held: (() => void)[] = []
    node.handler = (request, response) => {
      if (/"waitfor/.test(request.body)) held.push(() => response.destroy())
      else reads(request, response)
    }
    return { held }
  }

  it('asks a retry for what the deadline has left, less the margin, and gives up unsent with nothing left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { held } = heldWaits()
    const rpc = client({ readRetries: 1, retryDelayMs: 1 })
    let seen: unknown
    rpc.waitForBlockHeight(9, 5_000, { timeoutMs: 20_000 }).catch((e: unknown) => {
      seen = e
    })
    await settle()
    expect(held).toHaveLength(1)
    // 7 s into the deadline the connection drops; 1 ms later the retry has 2,999 ms once the margin is kept.
    await vi.advanceTimersByTimeAsync(7_000)
    held[0]!()
    await settle()
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(held).toHaveLength(2)
    expect(node.calls().map(call => call.params)).toEqual([
      [9, 5_000],
      [9, 2_999],
    ])
    held[1]!()
    await settle()
    expect(seen).toBeDefined()

    // 12 s in, 8 s are left: less than the margin, so the retry is not sent.
    node.requests.length = 0
    seen = undefined
    rpc.waitForBlockHeight(9, 5_000, { timeoutMs: 20_000 }).catch((e: unknown) => {
      seen = e
    })
    await settle()
    await vi.advanceTimersByTimeAsync(12_000)
    held[2]!()
    await settle()
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(RpcTimeoutError.is(seen)).toBe(true)
    expect(seen).toMatchObject({ timeoutMs: 20_000 })
    expect(node.calls()).toHaveLength(1)
  })

  it('needs no capability, and retries like a read, but waitForNewBlock only with currentTip', async () => {
    // The node drops the first connection of each call, after the request reached it.
    let calls = 0
    let dropped = false
    node.handler = (_request, response) => {
      calls += 1
      if (!dropped) {
        dropped = true
        response.destroy()
        return
      }
      response.end(`{"jsonrpc":"2.0","result":${JSON.stringify(tip)},"id":${node.calls().at(-1)!.id as number}}`)
    }
    const rpc = client({ readRetries: 1, retryDelayMs: 0 })
    const sent = async (call: () => Promise<unknown>): Promise<{ calls: number; outcome: unknown }> => {
      calls = 0
      dropped = false
      const outcome = await call().catch((e: unknown) => e)
      return { calls, outcome }
    }
    expect(await sent(() => rpc.waitForNewBlock(1000, { currentTip: HASH_A }))).toEqual({ calls: 2, outcome: tip })
    expect(await sent(() => rpc.waitForBlockHeight(9, 1000))).toEqual({ calls: 2, outcome: tip })
    expect(await sent(() => rpc.call('waitfornewblock', [1000, HASH_A]))).toMatchObject({ calls: 2 })
    // Without a tip, a retry would wait from the tip at the retry, past a block found in between:
    // neither readRetries nor a reused socket's second attempt sends it again.
    for (const call of [() => rpc.waitForNewBlock(1000), () => rpc.call('waitfornewblock', [1000])]) {
      const { calls: sentTimes, outcome } = await sent(call)
      expect(sentTimes).toBe(1)
      expect(outcome).toMatchObject({ name: 'RpcTransportError', reason: 'network' })
    }
    expect(METHOD_POLICIES['waitfornewblock']).toMatchObject({ capability: 'read', sideEffects: false })
  })
})

describe('submitPackage', () => {
  // TX_HEX with another locktime: a child's stand-in, with a txid of its own.
  const CHILD_HEX = `${TX_HEX.slice(0, -8)}01000000`
  const CHILD_TXID = requests.sendRawTransaction(CHILD_HEX).txid!
  const PACKAGE = [TX_HEX, CHILD_HEX]
  const SUCCESS = {
    package_msg: 'success',
    'tx-results': {
      [HASH_A]: { txid: TX_TXID, vsize: 3817, fees: { base: '@0.00001@' } },
      [HASH_B]: {
        txid: CHILD_TXID,
        vsize: 3817,
        fees: { base: '@0.1@', 'effective-feerate': '@0.02619858@', 'effective-includes': [HASH_B] },
      },
    },
    'replaced-transactions': [],
  }

  async function broadcaster(options: Partial<QbitRpcClientOptions> = {}): Promise<QbitRpcClient> {
    node.results(chainResults('regtest'))
    const rpc = client({ capabilities: ['broadcast'], ...options })
    await rpc.confirmChain()
    node.requests.length = 0
    return rpc
  }

  /** Answer the chain check, and `submitpackage` with `reply`. */
  const replyWith = (reply: (call: { method: string }) => CallReply): void => {
    const check = chainResults('regtest')
    node.rpc(call => (Object.hasOwn(check, call.method) ? { result: check[call.method]! } : reply(call)))
  }

  it('needs the broadcast capability and a confirmed chain, unsent', async () => {
    const closed = await failure(client().submitPackage(PACKAGE))
    expect(RpcCapabilityError.is(closed)).toBe(true)
    expect(closed).toMatchObject({ reason: 'not_enabled', required: 'broadcast', method: 'submitpackage' })
    const unconfirmed = await failure(client({ capabilities: ['broadcast'] }).submitPackage(PACKAGE))
    expect(RpcChainGuardError.is(unconfirmed)).toBe(true)
    expect(unconfirmed).toMatchObject({ reason: 'unconfirmed' })
    expect(node.requests).toHaveLength(0)
    expect(METHOD_POLICIES['submitpackage']).toEqual({ capability: 'broadcast', sideEffects: true })
  })

  it('returns each transaction’s outcome, with amounts in bits', async () => {
    const rpc = await broadcaster()
    replyWith(() => ({ result: json(SUCCESS) }))
    expect(await rpc.submitPackage(PACKAGE)).toEqual({
      packageMsg: 'success',
      txResults: {
        [HASH_A]: { txid: TX_TXID, vsize: 3817, fees: { baseBits: 1000n } },
        [HASH_B]: {
          txid: CHILD_TXID,
          vsize: 3817,
          fees: { baseBits: 10_000_000n, effectiveFeeRateBitsPerKvB: 2_619_858n, effectiveIncludes: [HASH_B] },
        },
      },
      replacedTransactions: [],
    })
    expect(node.calls().at(-1)).toMatchObject({ method: 'submitpackage', params: [PACKAGE] })
  })

  it('resolves a refusal, whole or partial, as a result: the node has answered', async () => {
    const rpc = await broadcaster()
    const partial = {
      package_msg: 'transaction failed',
      'tx-results': {
        [HASH_A]: { txid: TX_TXID, vsize: 3817, fees: { base: '@0.00001@' } },
        [HASH_B]: { txid: CHILD_TXID, error: 'max feerate exceeded' },
      },
      'replaced-transactions': [],
    }
    replyWith(() => ({ result: json(partial) }))
    const result = await rpc.submitPackage(PACKAGE)
    expect(result.packageMsg).toBe('transaction failed')
    expect(result.txResults[HASH_B]).toEqual({ txid: CHILD_TXID, error: 'max feerate exceeded' })
    // Refused as a whole: nothing was evaluated, so no transaction has an entry.
    replyWith(() => ({ result: json({ package_msg: 'package-too-large', 'tx-results': {} }) }))
    expect(await rpc.submitPackage(PACKAGE)).toEqual({ packageMsg: 'package-too-large', txResults: {} })
    // Another witness in the mempool.
    replyWith(() => ({
      result: json({ package_msg: 'success', 'tx-results': { [HASH_A]: { txid: TX_TXID, 'other-wtxid': HASH_B } } }),
    }))
    expect((await rpc.submitPackage([TX_HEX])).txResults[HASH_A]).toEqual({ txid: TX_TXID, otherWtxid: HASH_B })
  })

  it('takes the caps sendRawTransaction takes, and refuses a fee-rate cap of 0n, unsent', async () => {
    const rpc = await broadcaster()
    replyWith(() => ({ result: json(SUCCESS) }))
    await rpc.submitPackage(PACKAGE, { maxFeeRateBitsPerKvB: 99_999_999n, maxBurnAmountBits: 1000n })
    const body = node.requests.at(-1)!.body
    expect(body).toContain('],0.99999999,0.00001000]')
    node.requests.length = 0
    await expect(rpc.submitPackage(PACKAGE, { maxFeeRateBitsPerKvB: 0n })).rejects.toThrow(/reads 0 as no cap/)
    await expect(rpc.submitPackage(PACKAGE, { maxFeeRateBitsPerKvB: 100_000_000n })).rejects.toThrow(RangeError)
    await expect(rpc.submitPackage(PACKAGE, { maxBurnAmountBits: -1n })).rejects.toThrow(RangeError)
    await expect(rpc.submitPackage([])).rejects.toThrow(RangeError)
    await expect(rpc.submitPackage(Array.from({ length: 26 }, () => TX_HEX))).rejects.toThrow(RangeError)
    await expect(rpc.submitPackage(['zz'])).rejects.toThrow(TypeError)
    await expect(rpc.submitPackage(PACKAGE, { fee_rate: 1n } as never)).rejects.toThrow(/not a known key/)
    expect(node.requests).toHaveLength(0)
  })

  it.each([
    ['a dropped reply', 'network'],
    ['an HTTP 500', 'http'],
  ])('names every txid in package order after %s, sent once, on a fresh connection', async (_name, kind) => {
    const rpc = await broadcaster({ readRetries: 3, retryDelayMs: 0 })
    node.requests.length = 0
    node.handler = (_request, response) => {
      if (kind === 'network') {
        response.destroy()
        return
      }
      response.statusCode = 500
      response.end()
    }
    const error = await failure(rpc.submitPackage(PACKAGE))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'submitpackage', txids: [TX_TXID, CHILD_TXID] })
    expect((error as RpcUnknownOutcomeError).txid).toBeUndefined()
    expect(Object.isFrozen((error as RpcUnknownOutcomeError).txids)).toBe(true)
    expect(node.calls().filter(call => call.method === 'submitpackage')).toHaveLength(1)
  })

  it('names the txids after a passed deadline and a malformed reply, and through call()', async () => {
    const rpc = await broadcaster()
    node.handler = () => undefined
    const late = await failure(rpc.submitPackage(PACKAGE, undefined, { timeoutMs: 50 }))
    expect(RpcUnknownOutcomeError.is(late)).toBe(true)
    expect(late).toMatchObject({ txids: [TX_TXID, CHILD_TXID] })
    const raw = await failure(rpc.call('submitpackage', [PACKAGE], { timeoutMs: 50 }))
    expect(RpcUnknownOutcomeError.is(raw)).toBe(true)
    expect(raw).toMatchObject({ txids: [TX_TXID, CHILD_TXID] })

    replyWith(() => ({ result: '{"package_msg":7}' }))
    const malformed = (await failure(rpc.submitPackage(PACKAGE))) as RpcUnknownOutcomeError
    expect(RpcUnknownOutcomeError.is(malformed)).toBe(true)
    expect(malformed.txids).toEqual([TX_TXID, CHILD_TXID])
    expect(malformed.cause).toMatchObject({ reason: 'validation', path: 'result.package_msg' })
  })

  it('keeps a position in txids for each transaction, null for a hex that does not parse, and sends it', async () => {
    const rpc = await broadcaster()
    // Drops only the package: the chain re-check after each dropped connection is answered.
    const check = node.handler
    node.handler = (request, response) =>
      /submitpackage/.test(request.body) ? response.destroy() : check(request, response)
    expect(requests.submitPackage(['aabb', TX_HEX, CHILD_HEX]).txids).toEqual([null, TX_TXID, CHILD_TXID])
    const some = (await failure(rpc.submitPackage(['aabb', TX_HEX]))) as RpcUnknownOutcomeError
    expect(some.txids).toEqual([null, TX_TXID])
    expect(Object.isFrozen(some.txids)).toBe(true)
    for (const call of [rpc.submitPackage(['aabb']), rpc.call('submitpackage', [['aabb']])]) {
      const error = (await failure(call)) as RpcUnknownOutcomeError
      expect(RpcUnknownOutcomeError.is(error)).toBe(true)
      expect(error.txids).toEqual([null])
    }
    const raw = (await failure(rpc.call('submitpackage', [[7, TX_HEX]]))) as RpcUnknownOutcomeError
    expect(raw.txids).toEqual([null, TX_TXID])
    // Each was sent: the node decides about hex this package cannot parse, as sendRawTransaction leaves it to.
    expect(
      node
        .calls()
        .filter(call => call.method === 'submitpackage')
        .map(call => call.params[0])
    ).toEqual([['aabb', TX_HEX], ['aabb'], ['aabb'], [7, TX_HEX]])
  })

  // qbit Core v1.0.0's submitpackage (src/rpc/mempool.cpp) raises these before it
  // hands any transaction to the mempool: nothing was accepted.
  const REFUSED: [number, string][] = [
    [-28, 'Loading block index…'],
    [
      -3,
      'Wrong type passed:\n{\n    "Position 1 (package)": "JSON value of type string is not of expected type array"\n}',
    ],
    [-3, 'Amount out of range'],
    [-8, 'Array must contain between 1 and 25 transactions.'],
    [-8, 'Fee rates larger than or equal to 1QBT/kvB are not accepted'],
    [-22, 'TX decode failed: aabb Make sure the tx has at least one input.'],
    [-25, 'Unspendable output exceeds maximum configured by user (maxburnamount)'],
    [-25, 'package topology disallowed. not child-with-parents or parents depend on each other.'],
    // The JSON-RPC layer's (src/rpc/request.cpp, src/httprpc.cpp), before any method runs.
    [-32700, 'Parse error'],
    [-32600, 'Invalid Request object'],
    [-32601, 'Method not found'],
    [-32602, 'Params must be an array or object'],
  ]
  // These can follow the acceptance of part of the package.
  const AFTER_ACCEPTANCE: [number, string][] = [
    [-26, 'transaction broadcast failed: Transaction rejected by mempool (1 transactions were broadcast successfully)'],
    [
      -27,
      'transaction broadcast failed: Transaction outputs already in utxo set (0 transactions were broadcast successfully)',
    ],
    [-25, 'transaction broadcast failed: Mempool internal error (1 transactions were broadcast successfully)'],
    [-25, 'bad-txns-inputs-missingorspent'],
    [-25, 'package topology disallowed'],
    [-1, 'Internal bug detected: mempool.exists(tx->GetHash())'],
    [-32603, 'Internal error'],
  ]

  it.each(REFUSED)('treats %i %s as a definite refusal, typed and through call()', async (code, message) => {
    const rpc = await broadcaster()
    replyWith(() => ({ error: { code, message } }))
    for (const call of [rpc.submitPackage(PACKAGE), rpc.call('submitpackage', [PACKAGE])]) {
      const error = await failure(call)
      expect(RpcError.is(error)).toBe(true)
      expect(error).toMatchObject({ rpcCode: code, message })
    }
  })

  it.each(AFTER_ACCEPTANCE)(
    'reports %i %s as an unknown outcome naming every txid, typed and through call()',
    async (code, message) => {
      const rpc = await broadcaster()
      replyWith(() => ({ error: { code, message } }))
      for (const call of [rpc.submitPackage(PACKAGE), rpc.call('submitpackage', [PACKAGE])]) {
        const error = (await failure(call)) as RpcUnknownOutcomeError
        expect(RpcUnknownOutcomeError.is(error)).toBe(true)
        expect(error.txids).toEqual([TX_TXID, CHILD_TXID])
        expect(RpcError.is(error.cause)).toBe(true)
        expect(error.cause).toMatchObject({ rpcCode: code, message })
      }
      expect(node.calls().filter(call => call.method === 'submitpackage')).toHaveLength(2)
    }
  )

  it.each([400, 404, 500])(
    'tells the errors apart the same way under HTTP %i, as JSON-RPC 1.x sends them',
    async status => {
      const rpc = await broadcaster()
      const answer = (code: number, message: string): void => {
        replyWith(() => ({ error: { code, message } }))
        const check = node.handler
        node.handler = (request, response) => {
          if (!/"submitpackage"/.test(request.body)) {
            check(request, response)
            return
          }
          const { id } = JSON.parse(request.body) as { id: number }
          response.statusCode = status
          response.end(JSON.stringify({ result: null, error: { code, message }, id }))
        }
      }
      for (const [code, message] of REFUSED) {
        answer(code, message)
        for (const call of [rpc.submitPackage(PACKAGE), rpc.call('submitpackage', [PACKAGE])]) {
          const error = await failure(call)
          expect(RpcError.is(error)).toBe(true)
          expect(error).toMatchObject({ rpcCode: code, message })
        }
      }
      for (const [code, message] of AFTER_ACCEPTANCE) {
        answer(code, message)
        for (const call of [rpc.submitPackage(PACKAGE), rpc.call('submitpackage', [PACKAGE])]) {
          const error = (await failure(call)) as RpcUnknownOutcomeError
          expect(RpcUnknownOutcomeError.is(error)).toBe(true)
          expect(error.txids).toEqual([TX_TXID, CHILD_TXID])
          expect(error.cause).toMatchObject({ rpcCode: code, message })
        }
      }
    }
  )

  it.each([
    [
      'a transaction outside the package',
      { package_msg: 'transaction failed', 'tx-results': { [HASH_A]: { txid: HASH_B } } },
      `result.tx-results.${HASH_A}.txid`,
    ],
    [
      'a success missing a transaction',
      { package_msg: 'success', 'tx-results': { [HASH_A]: { txid: TX_TXID } } },
      'result.tx-results',
    ],
    [
      'a success with an error',
      {
        package_msg: 'success',
        'tx-results': { [HASH_A]: { txid: TX_TXID, error: 'x' }, [HASH_B]: { txid: CHILD_TXID } },
      },
      `result.tx-results.${HASH_A}.error`,
    ],
    [
      'a key that is no wtxid',
      { package_msg: 'x', 'tx-results': { aa: { txid: TX_TXID } } },
      'result.tx-results.aa (its key)',
    ],
    [
      'a bad fee',
      { package_msg: 'x', 'tx-results': { [HASH_A]: { txid: TX_TXID, fees: { base: -1 } } } },
      `result.tx-results.${HASH_A}.fees.base`,
    ],
    [
      'bad replaced transactions',
      { package_msg: 'x', 'tx-results': {}, 'replaced-transactions': ['aa'] },
      'result.replaced-transactions[0]',
    ],
  ])('reports %s as an unknown outcome: the node has acted', async (_name, reply, path) => {
    const rpc = await broadcaster()
    replyWith(() => ({ result: JSON.stringify(reply) }))
    const error = (await failure(rpc.submitPackage(PACKAGE))) as RpcUnknownOutcomeError
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(error.cause).toMatchObject({ reason: 'validation', path })
  })

  it('is refused in a batch', async () => {
    const rpc = await broadcaster()
    const error = await failure(rpc.batch([requests.submitPackage(PACKAGE)]))
    expect(error).toMatchObject({ reason: 'not_batchable' })
    expect(node.requests).toHaveLength(0)
  })
})

describe('RpcUnknownOutcomeError', () => {
  it('keeps its three-argument form, with txid and without txids', () => {
    const cause = new RpcTimeoutError('sendrawtransaction', 5)
    const error = new RpcUnknownOutcomeError('sendrawtransaction', cause, TX_TXID)
    expect(error.txid).toBe(TX_TXID)
    expect(error.txids).toBeUndefined()
    const copied = new RpcUnknownOutcomeError('submitpackage', cause, undefined, [TX_TXID])
    expect(copied.txids).toEqual([TX_TXID])
    expect(Object.isFrozen(copied.txids)).toBe(true)
    expect(copied.txid).toBeUndefined()
  })
})
