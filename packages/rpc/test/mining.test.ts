import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  QbitRpcClient,
  requests,
  RpcCapabilityError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcTimeoutError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
} from '../src'
import { METHOD_POLICIES } from '../src/capabilities'
import { CHECK, chainResults, FakeNode, HASH_A, HASH_B, TX_HEX, TX_TXID, type CallReply } from './helpers/fake-node'

// A header of zeros, then a block's transaction count and more: the hash is that of the 80 bytes alone.
const BLOCK_HEX = `${'00'.repeat(80)}0100`
/** Double SHA-256 of 80 zero bytes, in display order. */
const BLOCK_HASH = '14508459b221041eab257d2baaa7459775ba748246c8403609eb708f0e57e74b'
const AUXPOW_HEX = 'abcd'
const ADDRESS = 'qbrt1zaddress'

const BITS = '207fffff'
const TARGET = `7fffff${'00'.repeat(29)}`
const WEIGHT_RULE = { per_sigop: 3683, v2_active: true, v2_activation_height: 0 }
const TIME_RULE = { limit_seconds: 600, v2_active: true, v2_activation_height: 0 }

// As qbit Core v1.0.0 prints them on regtest.
const MINING_INFO = {
  blocks: 3,
  currentblockweight: 4000,
  currentblocktx: 0,
  bits: BITS,
  difficulty: 4.656542373906925e-10,
  target: TARGET,
  networkhashps: 1.088688305326555e-7,
  pooledtx: 0,
  blockmintxfee: '@0.00000001@',
  chain: 'regtest',
  next: { height: 4, bits: BITS, difficulty: 4.656542373906925e-10, target: TARGET },
  warnings: [],
}
/** The double SHA-256 of hex, in display order: a txid or wtxid. */
const sha256d = (hex: string): string =>
  createHash('sha256')
    .update(createHash('sha256').update(Buffer.from(hex, 'hex')).digest())
    .digest()
    .reverse()
    .toString('hex')
// TX_HEX has no witness, so its wtxid is its txid. This one adds a witness, so
// its txid stays TX_TXID and its wtxid differs.
const WITNESS_HEX = `01000000000101${'aa'.repeat(32)}0000000000ffffffff010100000000000000000101ab00000000`
const WITNESS_WTXID = sha256d(WITNESS_HEX)
const TEMPLATE_TX = { data: TX_HEX, txid: TX_TXID, hash: TX_TXID, depends: [], fee: 1000, sigops: 1, weight: 400 }
const TEMPLATE = {
  capabilities: ['proposal'],
  version: 536870912,
  rules: ['csv', '!segwit', 'taproot'],
  vbavailable: { testdummy: 28 },
  vbrequired: 0,
  versionrollingmask: '1fffe000',
  previousblockhash: HASH_A,
  transactions: [TEMPLATE_TX],
  coinbaseaux: {},
  coinbasevalue: 21000001000,
  longpollid: `${HASH_A}4`,
  target: TARGET,
  mintime: 1793825796,
  mutable: ['time', 'transactions', 'prevblock'],
  noncerange: '00000000ffffffff',
  sigoplimit: 80000,
  sizelimit: 2000000,
  weightlimit: 2000000,
  curtime: 1793825796,
  bits: BITS,
  height: 4,
  p2mr_validation_weight: WEIGHT_RULE,
  future_block_time: TIME_RULE,
  default_witness_commitment: '6a24aa21a9ed',
}
const AUX_BLOCK = {
  hash: HASH_B,
  chainid: 31430,
  previousblockhash: HASH_A,
  coinbasevalue: 21000000000,
  bits: BITS,
  height: 4,
  p2mr_validation_weight: WEIGHT_RULE,
  future_block_time: TIME_RULE,
  commitmentorder: 'display',
  commitmentactivationheight: 0,
  target: TARGET,
}

/** JSON with amounts written `@0.1@` as number literals. */
const json = (value: unknown): string => JSON.stringify(value).replace(/"@([^@]*)@"/g, '$1')

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
})
afterEach(async () => {
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

async function miner(options: Partial<QbitRpcClientOptions> = {}): Promise<QbitRpcClient> {
  node.results(chainResults('regtest'))
  const rpc = client({ capabilities: ['mining'], ...options })
  await rpc.confirmChain()
  node.requests.length = 0
  return rpc
}

/** Answer the chain check, and every other call with `reply`. */
function replyWith(reply: (call: { method: string; params: unknown[] }) => CallReply): void {
  const check = chainResults('regtest')
  node.rpc(call => (Object.hasOwn(check, call.method) ? { result: check[call.method]! } : reply(call)))
}

const answer = (value: unknown): void => replyWith(() => ({ result: json(value) }))

describe('the mining capability', () => {
  it('gates each method as its policy says', () => {
    const policies = ['getmininginfo', 'getblocktemplate', 'submitblock', 'createauxblock', 'submitauxblock'].map(
      method => METHOD_POLICIES[method]
    )
    expect(policies).toEqual([
      { capability: 'read', sideEffects: false },
      { capability: 'mining', sideEffects: false },
      { capability: 'mining', sideEffects: true },
      { capability: 'mining', sideEffects: true },
      { capability: 'mining', sideEffects: true },
    ])
  })

  it('refuses every mining call without the capability, unsent, typed or through call()', async () => {
    const rpc = client({ capabilities: ['wallet-read', 'wallet-write', 'broadcast'] })
    for (const promise of [
      rpc.getBlockTemplate(),
      rpc.checkBlockProposal(BLOCK_HEX),
      rpc.submitBlock(BLOCK_HEX),
      rpc.createAuxBlock(ADDRESS),
      rpc.submitAuxBlock(HASH_A, AUXPOW_HEX),
      rpc.call('submitblock', [BLOCK_HEX]),
    ]) {
      const error = await failure(promise)
      expect(RpcCapabilityError.is(error)).toBe(true)
      expect(error).toMatchObject({ reason: 'not_enabled', required: 'mining' })
    }
    expect(node.requests).toHaveLength(0)
  })

  it('makes every mining call wait for the chain guard, the read among them', async () => {
    const rpc = client({ capabilities: ['mining'] })
    for (const promise of [
      rpc.getBlockTemplate(),
      rpc.checkBlockProposal(BLOCK_HEX),
      rpc.submitBlock(BLOCK_HEX),
      rpc.createAuxBlock(ADDRESS),
      rpc.submitAuxBlock(HASH_A, AUXPOW_HEX),
    ]) {
      const error = await failure(promise)
      expect(RpcChainGuardError.is(error)).toBe(true)
      expect(error).toMatchObject({ reason: 'unconfirmed' })
    }
    expect(node.requests).toHaveLength(0)
  })

  it('refuses a block for a node on another chain, unsent', async () => {
    node.results(chainResults('main'))
    const rpc = client({ capabilities: ['mining'] })
    await expect(rpc.confirmChain()).rejects.toMatchObject({ reason: 'mismatch' })
    expect(await failure(rpc.submitBlock(BLOCK_HEX))).toMatchObject({ reason: 'mismatch', actualChain: 'main' })
    expect(node.calls().map(call => call.method)).toEqual([...CHECK])
  })

  it('re-checks a stale chain before a block is sent, and a failed re-check leaves it unsent to send again', async () => {
    const rpc = await miner({ chainCheckMaxAgeMs: 0 })
    replyWith(() => ({ result: 'null' }))
    expect(await rpc.submitBlock(BLOCK_HEX)).toBeNull()
    expect(node.calls().map(call => call.method)).toEqual([...CHECK, 'submitblock'])

    node.requests.length = 0
    node.rpc(() => ({ error: { code: -28, message: 'Loading block index' } }))
    const error = await failure(rpc.submitBlock(BLOCK_HEX))
    expect(RpcChainGuardError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'check_failed', method: 'submitblock' })
    expect(node.calls().map(call => call.method)).not.toContain('submitblock')
  })

  it('refuses mining methods in a batch, the read among them, and allows getmininginfo', async () => {
    const rpc = await miner()
    for (const request of [
      requests.getBlockTemplate(),
      requests.checkBlockProposal(BLOCK_HEX),
      requests.submitBlock(BLOCK_HEX),
      requests.createAuxBlock(ADDRESS),
      requests.submitAuxBlock(HASH_A, AUXPOW_HEX),
    ]) {
      expect(await failure(rpc.batch([request]))).toMatchObject({ reason: 'not_batchable' })
    }
    expect(node.requests).toHaveLength(0)
    answer(MINING_INFO)
    const [info] = await rpc.batch([requests.getMiningInfo()])
    expect(info.ok && info.value.blocks).toBe(3)
  })
})

describe('getMiningInfo', () => {
  it('needs no capability or chain check, with the fee floor in bits', async () => {
    node.results({ getmininginfo: json(MINING_INFO) })
    expect(await client().getMiningInfo()).toEqual({
      blocks: 3,
      currentBlockWeight: 4000,
      currentBlockTx: 0,
      bits: BITS,
      difficulty: 4.656542373906925e-10,
      target: TARGET,
      networkHashPs: 1.088688305326555e-7,
      pooledTx: 0,
      blockMinTxFeeBitsPerKvB: 1n,
      chain: 'regtest',
      next: { height: 4, bits: BITS, difficulty: 4.656542373906925e-10, target: TARGET },
      warnings: [],
    })
    expect(node.calls().map(call => call.method)).toEqual(['getmininginfo'])
  })

  it('leaves out what the node has not assembled yet, and reads a signet challenge', async () => {
    const { currentblockweight: _weight, currentblocktx: _tx, ...fresh } = MINING_INFO
    node.results({ getmininginfo: json({ ...fresh, chain: 'signet', signet_challenge: '51' }) })
    const info = await client().getMiningInfo()
    expect(info).not.toHaveProperty('currentBlockWeight')
    expect(info).not.toHaveProperty('currentBlockTx')
    expect(info.signetChallenge).toBe('51')
  })

  it.each([
    ['a target that is not its bits', { target: `7ffffe${'00'.repeat(29)}` }, 'result.target'],
    ['a next target that is not its bits', { next: { ...MINING_INFO.next, bits: '1d00ffff' } }, 'result.next.target'],
    ['a negative fee floor', { blockmintxfee: -1 }, 'result.blockmintxfee'],
  ])('refuses %s', async (_name, change, path) => {
    node.results({ getmininginfo: json({ ...MINING_INFO, ...change }) })
    const error = await failure(client().getMiningInfo())
    expect(RpcResponseError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'validation', path })
  })
})

describe('getBlockTemplate', () => {
  it('asks for a template under the segwit rule by default, with amounts in bits', async () => {
    const rpc = await miner()
    answer(TEMPLATE)
    expect(await rpc.getBlockTemplate()).toEqual({
      version: 536870912,
      rules: ['csv', '!segwit', 'taproot'],
      vbAvailable: { testdummy: 28 },
      capabilities: ['proposal'],
      vbRequired: 0,
      versionRollingMask: '1fffe000',
      previousBlockHash: HASH_A,
      transactions: [
        { data: TX_HEX, txid: TX_TXID, hash: TX_TXID, depends: [], feeBits: 1000n, sigops: 1, weight: 400 },
      ],
      coinbaseAux: {},
      coinbaseValueBits: 21000001000n,
      longPollId: `${HASH_A}4`,
      target: TARGET,
      minTime: 1793825796,
      mutable: ['time', 'transactions', 'prevblock'],
      nonceRange: '00000000ffffffff',
      sigOpLimit: 80000,
      sizeLimit: 2000000,
      weightLimit: 2000000,
      curTime: 1793825796,
      bits: BITS,
      height: 4,
      p2mrValidationWeight: { perSigop: 3683, v2Active: true, v2ActivationHeight: 0 },
      futureBlockTime: { limitSeconds: 600, v2Active: true, v2ActivationHeight: 0 },
      defaultWitnessCommitment: '6a24aa21a9ed',
    })
    expect(node.calls().at(-1)).toMatchObject({
      method: 'getblocktemplate',
      params: [{ mode: 'template', rules: ['segwit'] }],
    })
  })

  it('takes rules and capabilities, and refuses what the node would, unsent', async () => {
    const rpc = await miner()
    answer(TEMPLATE)
    await rpc.getBlockTemplate({ rules: ['segwit', 'signet'], capabilities: ['proposal'] })
    expect(node.calls().at(-1)?.params).toEqual([
      { mode: 'template', rules: ['segwit', 'signet'], capabilities: ['proposal'] },
    ])
    node.requests.length = 0
    await expect(rpc.getBlockTemplate({ rules: ['signet'] })).rejects.toThrow(RangeError)
    await expect(rpc.getBlockTemplate({ rules: 'segwit' as never })).rejects.toThrow(TypeError)
    await expect(rpc.getBlockTemplate({ rules: ['segwit', ''] })).rejects.toThrow(TypeError)
    await expect(rpc.getBlockTemplate({ capabilities: [1] as never })).rejects.toThrow(TypeError)
    await expect(rpc.getBlockTemplate({ longpollid: 'x' } as never)).rejects.toThrow(/not a known key/)
    expect(node.requests).toHaveLength(0)
  })

  it('asks for the signet rule too on signet, unless the caller gives rules', async () => {
    node.results(chainResults('signet'))
    const rpc = client({ expectedChain: 'signet', capabilities: ['mining'] })
    await rpc.confirmChain()
    node.requests.length = 0
    const check = chainResults('signet')
    node.rpc(call => (Object.hasOwn(check, call.method) ? { result: check[call.method]! } : { result: json(TEMPLATE) }))
    await rpc.getBlockTemplate()
    await rpc.getBlockTemplate({ capabilities: ['proposal'] })
    await rpc.getBlockTemplate({ rules: undefined } as never)
    await rpc.getBlockTemplate({ rules: ['segwit'] })
    expect(node.calls().map(call => call.params)).toEqual([
      // qbit Core refuses a signet template without the signet rule.
      [{ mode: 'template', rules: ['segwit', 'signet'] }],
      [{ mode: 'template', rules: ['segwit', 'signet'], capabilities: ['proposal'] }],
      [{ mode: 'template', rules: ['segwit', 'signet'] }],
      // Given rules are sent as given, and the node is the judge of them.
      [{ mode: 'template', rules: ['segwit'] }],
    ])
    // The request builder does not know the chain.
    expect(requests.getBlockTemplate().params).toEqual([{ mode: 'template', rules: ['segwit'] }])
    // Options that are not an object are refused as on any other chain, unsent.
    const sent = node.requests.length
    await expect(rpc.getBlockTemplate(null as never)).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(sent)
  })

  it('refuses a BIP22 long poll through call(): it has no timeout, and holds a qbitd worker', async () => {
    const rpc = await miner()
    node.requests.length = 0
    const longpollid = `${HASH_A}4`
    expect(() => requests.raw('getblocktemplate', [{ rules: ['segwit'], longpollid }])).toThrow(
      /getblocktemplate with longpollid waits with no end/
    )
    await expect(rpc.call('getblocktemplate', [{ rules: ['segwit'], longpollid }])).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(0)
  })

  it('retries like a read, as it changes nothing', async () => {
    const rpc = await miner({ readRetries: 1, retryDelayMs: 0 })
    let calls = 0
    replyWith(() => {
      calls += 1
      return calls === 1 ? { error: { code: -28, message: 'Loading block index' } } : { result: json(TEMPLATE) }
    })
    expect((await rpc.getBlockTemplate()).height).toBe(4)
    expect(calls).toBe(2)
  })

  it.each([
    ['a target that is not its bits', { target: `7ffffe${'00'.repeat(29)}` }, 'result.target'],
    ['a coinbase value over the money supply', { coinbasevalue: '@21000000000000001@' }, 'result.coinbasevalue'],
    ['a fractional coinbase value', { coinbasevalue: 1.5 }, 'result.coinbasevalue'],
    [
      'a txid that is not its data’s',
      { transactions: [{ ...TEMPLATE_TX, txid: HASH_A }] },
      'result.transactions[0].txid',
    ],
    [
      'a hash that is not its data’s wtxid',
      { transactions: [{ ...TEMPLATE_TX, hash: HASH_A }] },
      'result.transactions[0].hash',
    ],
    [
      'a witness transaction’s txid as its wtxid',
      { transactions: [{ ...TEMPLATE_TX, data: WITNESS_HEX, hash: TX_TXID }] },
      'result.transactions[0].hash',
    ],
    // The txid and wtxid cannot be checked against data that is no transaction.
    ['data that does not parse', { transactions: [{ ...TEMPLATE_TX, data: 'aabb' }] }, 'result.transactions[0].data'],
    [
      'a dependency on no earlier transaction',
      { transactions: [{ ...TEMPLATE_TX, depends: [1] }] },
      'result.transactions[0].depends[0]',
    ],
    [
      'the coinbase as a dependency',
      { transactions: [{ ...TEMPLATE_TX, depends: [0] }] },
      'result.transactions[0].depends[0]',
    ],
    ['a transaction with no fee', { transactions: [{ ...TEMPLATE_TX, fee: undefined }] }, 'result.transactions[0].fee'],
    ['no future-time rule', { future_block_time: undefined }, 'result.future_block_time'],
    ['coinbase data that is not hex', { coinbaseaux: { flags: 'xy' } }, 'result.coinbaseaux.flags'],
    ['height 0', { height: 0 }, 'result.height'],
  ])('refuses %s', async (_name, change, path) => {
    const rpc = await miner()
    answer({ ...TEMPLATE, ...change })
    const error = await failure(rpc.getBlockTemplate())
    expect(RpcResponseError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'validation', path })
  })

  it('accepts a later transaction depending on an earlier one', async () => {
    const rpc = await miner()
    answer({
      ...TEMPLATE,
      transactions: [TEMPLATE_TX, { ...TEMPLATE_TX, data: WITNESS_HEX, hash: WITNESS_WTXID, depends: [1] }],
    })
    expect((await rpc.getBlockTemplate()).transactions[1]!.depends).toEqual([1])
  })

  it('reads a template without its optional fields, and with a signet challenge', async () => {
    const { weightlimit: _limit, default_witness_commitment: _commitment, ...rest } = TEMPLATE
    const rpc = await miner()
    answer({ ...rest, signet_challenge: '51' })
    const template = await rpc.getBlockTemplate()
    expect(template).not.toHaveProperty('weightLimit')
    expect(template).not.toHaveProperty('defaultWitnessCommitment')
    expect(template.signetChallenge).toBe('51')
  })

  it('treats a lost reply as a plain failure: no unknown outcome', async () => {
    const rpc = await miner()
    node.handler = (_request, response) => response.destroy()
    const error = await failure(rpc.getBlockTemplate())
    expect(RpcUnknownOutcomeError.is(error)).toBe(false)
  })
})

describe('checkBlockProposal', () => {
  it('sends the block in proposal mode, with no rules, and returns the node’s answer', async () => {
    const rpc = await miner()
    answer(null)
    expect(await rpc.checkBlockProposal(BLOCK_HEX)).toBeNull()
    expect(node.calls().at(-1)).toMatchObject({
      method: 'getblocktemplate',
      params: [{ mode: 'proposal', data: BLOCK_HEX }],
    })
    answer('inconclusive-not-best-prevblk')
    expect(await rpc.checkBlockProposal(BLOCK_HEX)).toBe('inconclusive-not-best-prevblk')
    await expect(rpc.checkBlockProposal('zz')).rejects.toThrow(TypeError)
  })
})

describe('submitBlock', () => {
  it('returns null for a block accepted, and passes every reason through, a later one included', async () => {
    const rpc = await miner()
    answer(null)
    expect(await rpc.submitBlock(BLOCK_HEX)).toBeNull()
    expect(node.calls().at(-1)).toMatchObject({ method: 'submitblock', params: [BLOCK_HEX] })
    for (const reason of ['duplicate', 'inconclusive', 'high-hash', 'bad-txnmrklroot', 'a-reason-from-later']) {
      answer(reason)
      expect(await rpc.submitBlock(BLOCK_HEX)).toBe(reason)
    }
  })

  it('refuses an argument that is not hex, unsent', async () => {
    const rpc = await miner()
    for (const bad of ['', 'zz', 'abc', 7]) await expect(rpc.submitBlock(bad as string)).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(0)
  })

  it.each([
    ['a dropped reply', 'network'],
    ['an HTTP 500', 'http'],
  ])('names the block after %s, sent once, on a fresh connection', async (_name, kind) => {
    const rpc = await miner({ readRetries: 3, retryDelayMs: 0 })
    node.handler = (_request, response) => {
      if (kind === 'network') {
        response.destroy()
        return
      }
      response.statusCode = 500
      response.end()
    }
    const error = await failure(rpc.submitBlock(BLOCK_HEX))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'submitblock', blockHash: BLOCK_HASH })
    expect(node.calls().filter(call => call.method === 'submitblock')).toHaveLength(1)
  })

  it('names the block after a passed deadline and a malformed reply, and through call()', async () => {
    const rpc = await miner()
    node.handler = () => undefined
    const late = (await failure(rpc.submitBlock(BLOCK_HEX, { timeoutMs: 50 }))) as RpcUnknownOutcomeError
    expect(RpcUnknownOutcomeError.is(late)).toBe(true)
    expect(late.blockHash).toBe(BLOCK_HASH)
    expect(RpcTimeoutError.is(late.cause)).toBe(true)
    const raw = await failure(rpc.call('submitblock', [BLOCK_HEX.toUpperCase()], { timeoutMs: 50 }))
    expect(RpcUnknownOutcomeError.is(raw)).toBe(true)
    expect(raw).toMatchObject({ blockHash: BLOCK_HASH })

    for (const reply of [true, 7, '']) {
      answer(reply)
      const malformed = (await failure(rpc.submitBlock(BLOCK_HEX))) as RpcUnknownOutcomeError
      expect(RpcUnknownOutcomeError.is(malformed)).toBe(true)
      expect(malformed.blockHash).toBe(BLOCK_HASH)
      expect(malformed.cause).toMatchObject({ reason: 'validation', path: 'result' })
    }
  })

  it('names the header submitheader sent, opened through extraMethods, after a lost reply', async () => {
    const header = BLOCK_HEX.slice(0, 160)
    expect(requests.raw('submitheader', [header]).blockHash).toBe(BLOCK_HASH)
    expect(requests.raw('submitheader', [header.toUpperCase()]).blockHash).toBe(BLOCK_HASH)
    expect(requests.raw('submitheader', [header.slice(2)])).not.toHaveProperty('blockHash')
    const rpc = await miner({ extraMethods: { submitheader: { capability: 'mining', sideEffects: true } } })
    node.handler = () => undefined
    const late = (await failure(rpc.call('submitheader', [header], { timeoutMs: 50 }))) as RpcUnknownOutcomeError
    expect(RpcUnknownOutcomeError.is(late)).toBe(true)
    expect(late.blockHash).toBe(BLOCK_HASH)
  })

  it('names no block for hex too short to hold a header, or not hex', async () => {
    const rpc = await miner()
    const check = node.handler
    node.handler = (request, response) =>
      /submitblock/.test(request.body) ? response.destroy() : check(request, response)
    for (const call of [
      rpc.submitBlock('00'.repeat(79)),
      rpc.call('submitblock', ['00'.repeat(79)]),
      rpc.call('submitblock', [`${'zz'.repeat(80)}00`]),
      rpc.call('submitblock', [7]),
    ]) {
      const error = (await failure(call)) as RpcUnknownOutcomeError
      expect(RpcUnknownOutcomeError.is(error)).toBe(true)
      expect(error.blockHash).toBeUndefined()
    }
  })

  it('treats the node’s error as definite: no unknown outcome', async () => {
    const rpc = await miner()
    replyWith(() => ({ error: { code: -22, message: 'Block decode failed' } }))
    const error = await failure(rpc.submitBlock(BLOCK_HEX))
    expect(RpcError.is(error)).toBe(true)
    expect(error).toMatchObject({ rpcCode: -22 })
  })

  it('uses a new connection for each block', async () => {
    const rpc = await miner()
    answer(null)
    await rpc.submitBlock(BLOCK_HEX)
    await rpc.submitBlock(BLOCK_HEX)
    const [first, second] = node.requests.filter(request => /submitblock/.test(request.body))
    expect(first!.remotePort).not.toBe(second!.remotePort)
  })
})

describe('createAuxBlock', () => {
  it('asks for a candidate for the address, with the coinbase value in bits', async () => {
    const rpc = await miner()
    answer(AUX_BLOCK)
    expect(await rpc.createAuxBlock(ADDRESS)).toEqual({
      hash: HASH_B,
      chainId: 31430,
      previousBlockHash: HASH_A,
      coinbaseValueBits: 21000000000n,
      bits: BITS,
      height: 4,
      target: TARGET,
      p2mrValidationWeight: { perSigop: 3683, v2Active: true, v2ActivationHeight: 0 },
      futureBlockTime: { limitSeconds: 600, v2Active: true, v2ActivationHeight: 0 },
      commitmentOrder: 'display',
      commitmentActivationHeight: 0,
    })
    expect(node.calls().at(-1)).toMatchObject({ method: 'createauxblock', params: [ADDRESS] })
    await expect(rpc.createAuxBlock('')).rejects.toThrow(TypeError)
    await expect(rpc.createAuxBlock(7 as never)).rejects.toThrow(TypeError)
  })

  it.each([
    ['a target that is not its bits', { bits: '1d00ffff' }, 'result.target'],
    ['a chain id over 16 bits', { chainid: 65536 }, 'result.chainid'],
    ['a coinbase value that is a QBT amount', { coinbasevalue: 210.5 }, 'result.coinbasevalue'],
    // The proof commits in this order: one this package cannot name would waste the work.
    ['a commitment order it does not know', { commitmentorder: 'reversed' }, 'result.commitmentorder'],
    ['a hash that is not one', { hash: 'ab' }, 'result.hash'],
  ])('reports %s as an unknown outcome: the node has acted', async (_name, change, path) => {
    const rpc = await miner()
    answer({ ...AUX_BLOCK, ...change })
    const error = (await failure(rpc.createAuxBlock(ADDRESS))) as RpcUnknownOutcomeError
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(error.cause).toMatchObject({ reason: 'validation', path })
  })

  it('names nothing after a lost reply, sent once, on a fresh connection', async () => {
    const rpc = await miner({ readRetries: 3, retryDelayMs: 0 })
    answer(AUX_BLOCK)
    await rpc.createAuxBlock(ADDRESS)
    await rpc.createAuxBlock(ADDRESS)
    const [first, second] = node.requests.filter(request => /createauxblock/.test(request.body))
    expect(first!.remotePort).not.toBe(second!.remotePort)
    node.requests.length = 0
    const check = node.handler
    node.handler = (request, response) =>
      /createauxblock/.test(request.body) ? response.destroy() : check(request, response)
    const error = (await failure(rpc.createAuxBlock(ADDRESS))) as RpcUnknownOutcomeError
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(error.blockHash).toBeUndefined()
    expect(error.txid).toBeUndefined()
    expect(node.calls().filter(call => call.method === 'createauxblock')).toHaveLength(1)
  })
})

describe('submitAuxBlock', () => {
  it('sends the hash in lowercase and the proof, and returns null or the reason, as qbit Core does, no boolean', async () => {
    const rpc = await miner()
    answer(null)
    expect(await rpc.submitAuxBlock(HASH_A.toUpperCase(), AUXPOW_HEX)).toBeNull()
    expect(node.calls().at(-1)).toMatchObject({ method: 'submitauxblock', params: [HASH_A, AUXPOW_HEX] })
    for (const reason of ['stale-prevblk', 'bad-auxpow-commitment', 'a-reason-from-later']) {
      answer(reason)
      expect(await rpc.submitAuxBlock(HASH_A, AUXPOW_HEX)).toBe(reason)
    }
    answer(true)
    const malformed = (await failure(rpc.submitAuxBlock(HASH_A, AUXPOW_HEX))) as RpcUnknownOutcomeError
    expect(RpcUnknownOutcomeError.is(malformed)).toBe(true)
    expect(malformed.blockHash).toBe(HASH_A)
  })

  it('refuses a bad hash or proof, unsent', async () => {
    const rpc = await miner()
    await expect(rpc.submitAuxBlock('ab', AUXPOW_HEX)).rejects.toThrow(TypeError)
    await expect(rpc.submitAuxBlock(HASH_A, '')).rejects.toThrow(TypeError)
    await expect(rpc.submitAuxBlock(HASH_A, 'zz')).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(0)
  })

  it('names the block after a lost reply, sent once, typed or through call()', async () => {
    const rpc = await miner({ readRetries: 3, retryDelayMs: 0 })
    const check = node.handler
    node.handler = (request, response) =>
      /submitauxblock/.test(request.body) ? response.destroy() : check(request, response)
    const typed = await failure(rpc.submitAuxBlock(HASH_A.toUpperCase(), AUXPOW_HEX))
    expect(RpcUnknownOutcomeError.is(typed)).toBe(true)
    expect(typed).toMatchObject({ method: 'submitauxblock', blockHash: HASH_A })
    expect(node.calls().filter(call => call.method === 'submitauxblock')).toHaveLength(1)
    const raw = await failure(rpc.call('submitauxblock', [HASH_A.toUpperCase(), AUXPOW_HEX]))
    expect(raw).toMatchObject({ blockHash: HASH_A })
    const short = (await failure(rpc.call('submitauxblock', ['ab', AUXPOW_HEX]))) as RpcUnknownOutcomeError
    expect(short.blockHash).toBeUndefined()
  })
})

describe('RpcUnknownOutcomeError', () => {
  it('keeps its shorter forms, and leaves blockHash out of them', () => {
    const cause = new RpcTimeoutError('submitblock', 5)
    expect(new RpcUnknownOutcomeError('sendrawtransaction', cause, TX_TXID).blockHash).toBeUndefined()
    const error = new RpcUnknownOutcomeError('submitblock', cause, undefined, undefined, BLOCK_HASH)
    expect(error.blockHash).toBe(BLOCK_HASH)
    expect(error.txid).toBeUndefined()
    expect(error.txids).toBeUndefined()
  })
})
