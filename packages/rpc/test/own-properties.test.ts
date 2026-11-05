import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  JsonNumber,
  parseQbt,
  QbitRpcClient,
  requests,
  RpcAbortedError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcTransportError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
  type RpcRequest,
} from '../src'
import { parseJsonLossless, stringifyRequest } from '../src/json'
import { blockchainInfoJson, chainResults, FakeNode, HASH_A, HASH_B, TX_HEX, TX_TXID } from './helpers/fake-node'
import { withPrototype } from './helpers/null-prototype'

// Options, arguments, call options and replies are read from their own
// properties only. A polluted Object.prototype (a JSON merge of attacker
// input is the usual way) must never supply a value: a known key it holds is
// refused, and any other is never read.

const proto = Object.prototype as Record<string, unknown>
const arrayProto = Array.prototype as unknown as Record<string, unknown>

/** Run `run` with `keys` set on Object.prototype, restoring it however `run` ends. */
function polluted<T>(keys: Readonly<Record<string, unknown>>, run: () => T): T {
  const names = Object.keys(keys)
  for (const name of names) {
    if (Object.hasOwn(proto, name)) throw new Error(`Object.prototype.${name} is already set`)
    proto[name] = keys[name]
  }
  try {
    return run()
  } finally {
    for (const name of names) delete proto[name]
  }
}

/**
 * Run `run` with `keys` on Object.prototype as properties that are not
 * enumerable, as a polyfill defines them. The client refuses every call while
 * Object.prototype has an enumerable property (`prototype_polluted`); this is
 * the pollution that check lets through, so what a call reads beneath it is
 * tested with it.
 */
function pollutedQuietly<T>(keys: Readonly<Record<string, unknown>>, run: () => T): T {
  const names = Object.keys(keys)
  for (const name of names) {
    if (Object.hasOwn(proto, name)) throw new Error(`Object.prototype.${name} is already set`)
    Object.defineProperty(proto, name, { value: keys[name], writable: true, configurable: true, enumerable: false })
  }
  try {
    return run()
  } finally {
    for (const name of names) delete proto[name]
  }
}

const POLLUTION_REFUSED = { name: 'RpcTransportError', reason: 'prototype_polluted' }

const NOT_OWN =
  /is not an own enumerable property \(it is inherited, a class getter or on a polluted Object\.prototype\): pass a plain object$/
const notOwn = (name: string): RegExp => new RegExp(`^${name.replace(/[.[\]]/g, '\\$&')} ${NOT_OWN.source}`)

const OUTPUT = { address: 'rq1a', amountBits: 1n }
const PSBT = 'cHNidP8='
const PROOF = {
  address: 'rq1a',
  messageHash: '11'.repeat(32),
  signature: 'aa',
  pubkey: '22'.repeat(32),
  leafScript: 'bb',
  controlBlock: 'cc',
  leafVersion: 0xc0,
  proofMode: 'p2mr-pubkey',
} as const

type Builders = typeof requests
type Build = (...args: unknown[]) => RpcRequest<unknown>

/**
 * Arguments for every request builder: the compiler refuses a builder left
 * out, so a new one is covered by every test below. Each nested object that
 * a builder reads keys from appears in one set at least.
 */
const CASES: { readonly [K in keyof Builders]: readonly (() => Parameters<Builders[K]>)[] } = {
  raw: [() => ['getblockcount'], () => ['walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }], 0, {}]]],
  getBlockchainInfo: [() => []],
  getNetworkInfo: [() => []],
  getBestBlockHash: [() => []],
  getBlockCount: [() => []],
  getBlockHash: [() => [1]],
  getBlockHeader: [() => [HASH_A]],
  getRawTransaction: [() => [HASH_A], () => [HASH_A, {}]],
  getRawTransactionVerbose: [() => [HASH_A], () => [HASH_A, {}]],
  getMempoolEntry: [() => [HASH_A]],
  getTxOut: [() => [HASH_A, 0], () => [HASH_A, 0, {}]],
  getConfirmationTarget: [() => [1n], () => [1n, {}]],
  estimateSmartFee: [() => [6], () => [6, {}]],
  validateAddress: [() => ['rq1a']],
  verifyDataPqcHash: [() => [{ ...PROOF }]],
  testMempoolAccept: [() => [[TX_HEX]], () => [[TX_HEX], {}]],
  sendRawTransaction: [() => [TX_HEX], () => [TX_HEX, {}]],
  getWalletInfo: [() => []],
  getTransaction: [() => [HASH_A]],
  listUnspent: [() => [], () => [{}]],
  getAddressInfo: [() => ['rq1a']],
  listLockUnspent: [() => []],
  listSinceBlock: [() => [], () => [{}]],
  listTransactions: [() => [], () => [{}]],
  getBalances: [() => []],
  walletCreateFundedPsbt: [
    () => [{ outputs: [{ ...OUTPUT }] }],
    () => [{ inputs: [{ txid: HASH_A, vout: 0 }], outputs: [{ ...OUTPUT }, { data: 'cafe' }], options: {} }],
  ],
  walletProcessPsbt: [() => [PSBT], () => [PSBT, {}]],
  finalizePsbt: [() => [PSBT], () => [PSBT, {}]],
  psbtBumpFee: [() => [HASH_A], () => [HASH_A, {}], () => [HASH_A, { outputs: [{ ...OUTPUT }] }]],
  walletPassphrase: [() => ['passphrase', 60]],
  walletLock: [() => []],
  getRawChangeAddress: [() => [], () => [{}]],
  getNewAddress: [() => [], () => [{}]],
  lockUnspent: [() => [[{ txid: HASH_A, vout: 0 }]], () => [[{ txid: HASH_A, vout: 0 }], {}]],
  unlockUnspent: [() => [[{ txid: HASH_A, vout: 0 }]]],
}
const NAMES = Object.keys(CASES) as (keyof Builders)[]

const aborted = (): AbortSignal => {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

/**
 * A value each option would take, so a builder that read it from a polluted
 * Object.prototype would send it rather than refuse it as malformed.
 */
const SAMPLES: Readonly<Record<string, unknown>> = {
  blockHash: HASH_B,
  includeMempool: false,
  securityLevel: 'maximum',
  mergeMiningPct: 0.5,
  btcHashrate: 1e18,
  mode: 'conservative',
  maxFeeRateBitsPerKvB: 99_999_999n,
  maxBurnAmountBits: 100_000_000n,
  minConf: 0,
  maxConf: 5,
  addresses: ['rq1attacker'],
  includeUnsafe: true,
  minimumAmountBits: 1n,
  maximumAmountBits: 2n,
  maximumCount: 3,
  minimumSumAmountBits: 4n,
  includeImmatureCoinbase: true,
  targetConfirmations: 6,
  includeWatchOnly: true,
  includeRemoved: false,
  includeChange: true,
  label: 'attacker',
  count: 1000,
  skip: 1,
  inputs: [{ txid: HASH_B, vout: 1 }],
  outputs: [{ address: 'rq1attacker', amountBits: 1n }],
  locktime: 1,
  options: { changeAddress: 'rq1attacker', subtractFeeFromOutputs: [0] },
  bip32derivs: false,
  version: 3,
  addInputs: false,
  changeAddress: 'rq1attacker',
  changePosition: 0,
  changeType: 'legacy',
  lockUnspents: true,
  feeRateBitsPerKvB: 99_999_999n,
  subtractFeeFromOutputs: [0],
  maxTxWeight: 65,
  replaceable: false,
  confTarget: 1008,
  estimateMode: 'conservative',
  sequence: 0,
  data: 'cafe',
  sign: false,
  sighashType: 'NONE|ANYONECANPAY',
  finalize: false,
  extract: false,
  originalChangeIndex: 1,
  addressType: 'legacy',
  persistent: true,
  signal: aborted(),
  timeoutMs: 1,
}

/** Wrap every plain object in `value` in a Proxy that records the keys looked up on it. */
function recording(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map(item => recording(item, keys))
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value
  const target = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, recording(item, keys)]))
  const note = (key: string | symbol): void => {
    if (typeof key === 'string') keys.add(key)
  }
  return new Proxy(target, {
    has: (t, key) => (note(key), Reflect.has(t, key)),
    get: (t, key, receiver) => (note(key), Reflect.get(t, key, receiver)),
  })
}

/** The option keys a builder looks up on the objects it is given, whichever way it looks them up. */
function keysRead(name: keyof Builders, args: readonly unknown[]): Set<string> {
  const keys = new Set<string>()
  ;(requests[name] as Build)(...args.map(arg => recording(arg, keys)))
  return keys
}

const ALL_KEYS = [...new Set(NAMES.flatMap(name => CASES[name].flatMap(args => [...keysRead(name, args())])))]
  .concat(['signal', 'timeoutMs'])
  .filter((key, index, all) => all.indexOf(key) === index)

describe('request builders under a polluted Object.prototype', () => {
  it('find the keys they read, so the cases below cover them', () => {
    for (const key of ['changeAddress', 'subtractFeeFromOutputs', 'options', 'inputs', 'minConf', 'blockHash']) {
      expect(ALL_KEYS).toContain(key)
    }
    // Every key a builder may read from somewhere other than the caller's own object has a sample it would take.
    const own = new Set<string>()
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect)
      else if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          own.add(key)
          collect(item)
        }
      }
    }
    for (const name of NAMES) for (const args of CASES[name]) collect(args())
    expect(ALL_KEYS.filter(key => !Object.hasOwn(SAMPLES, key) && !own.has(key))).toEqual([])
  })

  it.each(NAMES.flatMap(name => CASES[name].map((args, index) => [`${name} #${index + 1}`, name, args] as const)))(
    '%s refuses each polluted key it reads, naming it, and sends the same request for any other',
    (_label, name, args) => {
      const build = (): RpcRequest<unknown> => (requests[name] as Build)(...args())
      const clean = stringifyRequest(build().params)
      const failures: string[] = []
      for (const key of ALL_KEYS) {
        const sample = Object.hasOwn(SAMPLES, key) ? SAMPLES[key] : 'polluted'
        let built: RpcRequest<unknown> | undefined
        let thrown: unknown
        polluted({ [key]: sample }, () => {
          try {
            built = build()
          } catch (error) {
            thrown = error
          }
        })
        if (built !== undefined) {
          const sent = stringifyRequest(built.params)
          if (sent !== clean) failures.push(`${key}: sent ${sent}, not ${clean}`)
        } else if (!(thrown instanceof TypeError) || !new RegExp(`\\.${key} ${NOT_OWN.source}`).test(thrown.message)) {
          failures.push(`${key}: threw ${String(thrown)}`)
        }
      }
      expect(failures).toEqual([])
    }
  )

  it('build requests without a prototype, so a txid left out is never read from Object.prototype', () => {
    for (const request of [
      requests.getBlockCount(),
      requests.raw('getblockcount'),
      requests.sendRawTransaction('00'),
    ]) {
      expect(Object.getPrototypeOf(request)).toBeNull()
      expect(Object.isFrozen(request)).toBe(true)
      expect(polluted({ txid: TX_TXID }, () => request.txid)).toBeUndefined()
    }
  })
})

// The case a reviewer ran end to end: the change went to the attacker.
describe('walletCreateFundedPsbt with changeAddress and subtractFeeFromOutputs polluted', () => {
  const attack = { changeAddress: 'rq1attacker', subtractFeeFromOutputs: [0] }

  it('refuses options: {}, naming the first key', () => {
    expect(() => polluted(attack, () => requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options: {} }))).toThrow(
      notOwn('args.options.changeAddress')
    )
  })

  it('sends no options when they are left out', () => {
    const built = polluted(attack, () => requests.walletCreateFundedPsbt({ outputs: [OUTPUT] }))
    expect(stringifyRequest(built.params)).toBe('[[],[{"rq1a":0.00000001}]]')
  })

  it('refuses a polluted options bag when options are left out', () => {
    expect(() => polluted({ options: attack }, () => requests.walletCreateFundedPsbt({ outputs: [OUTPUT] }))).toThrow(
      notOwn('args.options')
    )
  })

  it('refuses polluted inputs, which would pick the coins', () => {
    const inputs = [{ txid: HASH_B, vout: 7 }]
    expect(() => polluted({ inputs }, () => requests.walletCreateFundedPsbt({ outputs: [OUTPUT] }))).toThrow(
      notOwn('args.inputs')
    )
  })
})

describe('nested objects and arrays', () => {
  it('refuse a hole in every array a builder reads, naming its index', () => {
    const holey = <T>(item: T): T[] => [, item] as T[]
    const cases: [() => unknown, string][] = [
      [() => requests.walletCreateFundedPsbt({ outputs: holey(OUTPUT) }), 'args.outputs[0]'],
      [
        () => requests.walletCreateFundedPsbt({ inputs: holey({ txid: HASH_A, vout: 0 }), outputs: [OUTPUT] }),
        'args.inputs[0]',
      ],
      [
        () => requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options: { subtractFeeFromOutputs: holey(0) } }),
        'args.options.subtractFeeFromOutputs[0]',
      ],
      [() => requests.psbtBumpFee(HASH_A, { outputs: holey(OUTPUT) }), 'options.outputs[0]'],
      [() => requests.listUnspent({ addresses: holey('rq1a') }), 'options.addresses[0]'],
      [() => requests.testMempoolAccept(holey(TX_HEX)), 'rawTxs[0]'],
      [() => requests.lockUnspent(holey({ txid: HASH_A, vout: 0 })), 'outputs[0]'],
      [() => requests.unlockUnspent(holey({ txid: HASH_A, vout: 0 })), 'outputs[0]'],
      [() => requests.raw('getblockhash', holey(0)), 'params[0]'],
    ]
    for (const [build, name] of cases) {
      expect(build).toThrow(TypeError)
      expect(build).toThrow(`${name} is a hole, not an own element: pass an array without holes`)
    }
  })

  it('never read an element from Array.prototype', () => {
    const outputs = [, OUTPUT] as (typeof OUTPUT)[]
    arrayProto['0'] = { address: 'rq1attacker', amountBits: 100_000_000n }
    try {
      expect(() => requests.walletCreateFundedPsbt({ outputs })).toThrow(/^args\.outputs\[0\] is a hole/)
      expect(() => requests.testMempoolAccept([, TX_HEX] as string[])).toThrow(/^rawTxs\[0\] is a hole/)
      // An index past the end is not a hole, and is not read either.
      expect(requests.raw('getblockcount', []).params).toEqual([])
      expect(requests.raw('sendrawtransaction', []).txid).toBeUndefined()
    } finally {
      delete arrayProto['0']
    }
    // Nor from Object.prototype, which arrays inherit too.
    expect(() => polluted({ 0: TX_HEX }, () => requests.testMempoolAccept([, TX_HEX] as string[]))).toThrow(
      /^rawTxs\[0\] is a hole/
    )
  })

  it('read a class instance by its own fields, and refuse a class getter', () => {
    class Options {
      changeAddress = 'rq1c'
      get feeRateBitsPerKvB(): bigint {
        return 2500n
      }
    }
    expect(() => requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options: new Options() })).toThrow(
      notOwn('args.options.feeRateBitsPerKvB')
    )
    class Fields {
      changeAddress = 'rq1c'
      feeRateBitsPerKvB = 2500n
    }
    expect(requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options: new Fields() }).params[3]).toEqual({
      change_address: 'rq1c',
      fee_rate: expect.anything(),
    })
  })

  it('refuse a non-enumerable property, and read a getter on the object itself once', () => {
    const hidden = Object.defineProperty({}, 'changeAddress', { value: 'rq1c', enumerable: false })
    expect(() => requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options: hidden })).toThrow(
      notOwn('args.options.changeAddress')
    )
    let reads = 0
    const own = {
      get changeAddress() {
        reads += 1
        return 'rq1c'
      },
    }
    expect(requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options: own }).params[3]).toEqual({
      change_address: 'rq1c',
    })
    expect(reads).toBe(1)
  })

  it('refuse a key a Proxy reports as present but leaves out of its own keys', () => {
    const options = new Proxy({ changeAddress: 'rq1attacker' }, { ownKeys: () => [] })
    expect(() => requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options })).toThrow(
      notOwn('args.options.changeAddress')
    )
    const output = new Proxy({ address: 'rq1a', amountBits: 1n }, { ownKeys: () => ['address'] })
    expect(() => requests.walletCreateFundedPsbt({ outputs: [output] })).toThrow(notOwn('args.outputs[0].amountBits'))
  })

  it('refuse a key a Proxy answers only from its get trap, listing no key and not saying it has one', () => {
    const answering = (key: string, value: unknown): object =>
      new Proxy({}, { get: (target, name) => (name === key ? value : Reflect.get(target, name)) })
    expect(() =>
      requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options: answering('changeAddress', 'rq1attacker') })
    ).toThrow(notOwn('args.options.changeAddress'))
    expect(() => requests.getTxOut(TX_TXID, 0, answering('includeMempool', false))).toThrow(
      notOwn('options.includeMempool')
    )
    // A trap that answers nothing for the keys read is an empty object.
    expect(requests.listUnspent(answering('other', 1)).params).toEqual([])
  })

  it('keep the unknown-key messages for inherited keys, and skip one only on Object.prototype', () => {
    const inherited = Object.create({ minconf: 1 }) as never
    expect(() => requests.listUnspent(inherited)).toThrow(/^options\.minconf is not a known key: use options\.minConf$/)
    expect(polluted({ minconf: 1 }, () => requests.listUnspent({}).params)).toEqual([])
  })
})

/** A FakeNode reply after `ms`: the chain check as regtest, any other call a node error, so every call is sent. */
function slowNode(node: FakeNode, ms: number): void {
  const chain = chainResults('regtest')
  node.handler = (request, response) => {
    const parsed = JSON.parse(request.body) as { id: unknown; method: string } | { id: unknown; method: string }[]
    const reply = (call: { id: unknown; method: string }): string =>
      Object.hasOwn(chain, call.method)
        ? `{"jsonrpc":"2.0","result":${chain[call.method]!},"id":${JSON.stringify(call.id)}}`
        : `{"jsonrpc":"2.0","error":{"code":-1,"message":"no"},"id":${JSON.stringify(call.id)}}`
    setTimeout(() => {
      response.setHeader('content-type', 'application/json')
      response.end(Array.isArray(parsed) ? `[${parsed.map(reply).join(',')}]` : reply(parsed))
    }, ms)
  }
}

describe('call options under a polluted Object.prototype', () => {
  let node: FakeNode
  let rpc: QbitRpcClient

  beforeEach(async () => {
    node = await FakeNode.start()
    slowNode(node, 0)
    rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
      chainCheckMaxAgeMs: 86_400_000,
    })
    await rpc.confirmChain()
    slowNode(node, 25)
    node.requests.length = 0
  })
  afterEach(async () => {
    await node.close()
  })

  type Call = (callOptions: unknown) => Promise<unknown>
  const calls: [string, (rpc: QbitRpcClient) => Call][] = [
    ...NAMES.filter((name): name is Exclude<keyof Builders, 'raw'> => name !== 'raw').map(
      (name): [string, (rpc: QbitRpcClient) => Call] => [
        name,
        c => callOptions => {
          const args: unknown[] = [...CASES[name][0]!()]
          while (args.length < requests[name].length) args.push(undefined)
          return (c[name] as (...a: unknown[]) => Promise<unknown>).call(c, ...args, callOptions)
        },
      ]
    ),
    ['call', c => callOptions => c.call('getblockcount', [], callOptions as never)],
    ['batch', c => callOptions => c.batch([requests.getBlockCount()], callOptions as never)],
    ['confirmChain', c => callOptions => c.confirmChain(callOptions as never)],
  ]
  const cases = calls.flatMap(([name, call]) =>
    (['signal', 'timeoutMs'] as const).map(key => [name, key, call] as const)
  )

  it.each(cases)('%s with %s polluted: refused in {}, never read when left out', async (_name, key, call) => {
    const sample = SAMPLES[key]
    // Enumerable, as a pollution sets it, the call is refused before its call options are read.
    await expect(polluted({ [key]: sample }, () => call(rpc)({}))).rejects.toMatchObject(POLLUTION_REFUSED)
    // The call options are read before the first await, so the pollution can end before anything is sent.
    const refused = pollutedQuietly({ [key]: sample }, () => call(rpc)({}))
    await expect(refused).rejects.toThrow(notOwn(`callOptions.${key}`))
    expect(node.requests).toHaveLength(0)
    const left = pollutedQuietly({ [key]: sample }, () => call(rpc)(undefined))
    const settled = await left.then(
      value => ({ value }),
      (error: unknown) => ({ error })
    )
    // Sent, and answered by the node: neither aborted by the polluted signal nor timed out after 1 ms.
    expect(node.requests.length).toBeGreaterThan(0)
    if ('error' in settled) expect(settled.error).toBeInstanceOf(RpcError)
  })

  it('refuse a call option a Proxy answers only from its get trap', async () => {
    const answering = new Proxy({}, { get: (target, name) => (name === 'timeoutMs' ? 1 : Reflect.get(target, name)) })
    await expect(rpc.getBlockCount(answering as never)).rejects.toThrow(notOwn('callOptions.timeoutMs'))
    await expect(rpc.batch([requests.getBlockCount()], answering as never)).rejects.toThrow(
      notOwn('callOptions.timeoutMs')
    )
    expect(node.requests).toHaveLength(0)
  })
})

/** Parse `text` as the client does and give it to `request`'s parser, with `keys` polluted throughout. */
function parsedUnder<T>(request: RpcRequest<T>, text: string, keys: Readonly<Record<string, unknown>>): T {
  return polluted(keys, () => request.parse(parseJsonLossless(text)))
}

/** `node` and `typed` names of the same optional fields, polluted with values each would take. */
function both(fields: Readonly<Record<string, readonly [string, unknown]>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [typed, [node, value]] of Object.entries(fields)) {
    out[node] = value
    out[typed] = value
  }
  return out
}

const HISTORY_ENTRY = {
  address: 'rq1a',
  category: 'receive',
  amount: 1.5,
  label: '',
  vout: 0,
  abandoned: false,
  parent_descs: [],
  confirmations: 0,
  trusted: true,
  txid: HASH_A,
  wtxid: HASH_A,
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1700000000,
  timereceived: 1700000000,
  'bip125-replaceable': 'no',
}
const MINED_SEND = {
  address: 'rq1b',
  category: 'send',
  amount: -1,
  vout: 1,
  fee: -0.0001,
  abandoned: false,
  confirmations: 3,
  blockhash: HASH_B,
  blockheight: 10,
  blockindex: 1,
  blocktime: 1700000100,
  txid: HASH_B,
  wtxid: HASH_B,
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1700000000,
  timereceived: 1700000000,
  'bip125-replaceable': 'no',
}
/** Optional fields of a history entry or wallet transaction, as the node names them and as typed. */
const PLACEMENT = both({
  blockHash: ['blockhash', HASH_B],
  blockHeight: ['blockheight', 10],
  blockIndex: ['blockindex', 1],
  blockTime: ['blocktime', 1700000100],
  trusted: ['trusted', true],
  generated: ['generated', true],
  feeBits: ['fee', -1n],
  replacedByTxid: ['replaced_by_txid', HASH_B],
  replacesTxid: ['replaces_txid', HASH_B],
  label: ['label', 'attacker'],
  to: ['to', 'attacker'],
  comment: ['comment', 'attacker'],
  parentDescs: ['parent_descs', ['attacker']],
})

describe('replies under a polluted Object.prototype', () => {
  it('getTransaction: an unconfirmed transaction never looks mined', () => {
    const reply = JSON.stringify({
      amount: 1.5,
      confirmations: 0,
      trusted: true,
      txid: HASH_A,
      wtxid: HASH_A,
      walletconflicts: [],
      mempoolconflicts: [],
      time: 1700000000,
      timereceived: 1700000000,
      'bip125-replaceable': 'no',
      details: [{ category: 'receive', amount: 1.5, vout: 0, abandoned: false }],
      hex: '00',
      lastprocessedblock: { hash: HASH_B, height: 10 },
    })
    const clean = requests.getTransaction(HASH_A).parse(parseJsonLossless(reply))
    const tx = parsedUnder(requests.getTransaction(HASH_A), reply, { ...PLACEMENT, address: 'rq1attacker' })
    expect(tx).toStrictEqual(clean)
    expect(withPrototype(tx)).toEqual([])
    polluted({ ...PLACEMENT, address: 'rq1attacker' }, () => {
      expect(tx.blockHash).toBeUndefined()
      expect(tx.blockHeight).toBeUndefined()
      expect(tx.blockTime).toBeUndefined()
      expect('blockHash' in tx).toBe(false)
      expect(tx.details[0]!.address).toBeUndefined()
      expect(tx.lastProcessedBlock.hash).toBe(HASH_B)
    })
  })

  it('listTransactions and listSinceBlock: entries parse as they are, whatever the prototype holds', () => {
    const reply = JSON.stringify([HISTORY_ENTRY, MINED_SEND]).replace('"fee":-0.0001', '"fee":-0.00010000')
    const clean = requests.listTransactions().parse(parseJsonLossless(reply))
    // A polluted trusted made every mined entry fail validation; a polluted blockHash an unconfirmed one.
    const entries = parsedUnder(requests.listTransactions(), reply, PLACEMENT)
    expect(entries).toStrictEqual(clean)
    expect(withPrototype(entries)).toEqual([])
    polluted(PLACEMENT, () => {
      expect(entries[0]!.blockHash).toBeUndefined()
      expect(entries[0]!.feeBits).toBeUndefined()
      expect(entries[1]!.trusted).toBeUndefined()
    })
    const since = JSON.stringify({ transactions: [HISTORY_ENTRY, MINED_SEND], lastblock: HASH_B })
    // Asked for no removed list: a polluted removed must not read as one the node sent.
    const history = parsedUnder(requests.listSinceBlock({ includeRemoved: false }), since, {
      ...PLACEMENT,
      removed: [],
    })
    expect(withPrototype(history)).toEqual([])
    expect(polluted({ removed: [] }, () => history.removed)).toBeUndefined()
  })

  it('getRawTransactionVerbose: a mempool transaction gains no block, and an output no address', () => {
    const reply = JSON.stringify({
      txid: HASH_A,
      hash: HASH_A,
      version: 2,
      size: 100,
      vsize: 100,
      weight: 400,
      locktime: 0,
      vin: [{ txid: HASH_B, vout: 0, scriptSig: { asm: '', hex: '' }, sequence: 4294967293 }],
      vout: [{ value: 0, n: 0, scriptPubKey: { asm: 'OP_RETURN', desc: 'raw(6a)#x', hex: '6a', type: 'nulldata' } }],
      hex: '00',
    })
    const keys = {
      ...both({
        blockHash: ['blockhash', HASH_B],
        confirmations: ['confirmations', 6],
        blockTime: ['blocktime', 1700000100],
        time: ['time', 1700000100],
        inActiveChain: ['in_active_chain', true],
        txinwitness: ['txinwitness', ['00']],
      }),
      address: 'rq1attacker',
    }
    const clean = requests.getRawTransactionVerbose(HASH_A).parse(parseJsonLossless(reply))
    const tx = parsedUnder(requests.getRawTransactionVerbose(HASH_A), reply, keys)
    expect(tx).toStrictEqual(clean)
    expect(withPrototype(tx)).toEqual([])
    polluted(keys, () => {
      expect(tx.blockHash).toBeUndefined()
      expect(tx.confirmations).toBeUndefined()
      // As qbit-game-kit reads it: output.scriptPubKey.address ?? ''.
      expect(tx.vout[0]!.scriptPubKey.address ?? '').toBe('')
    })
  })

  it('testMempoolAccept: an entry the node did not validate never reads as allowed', () => {
    const reply = JSON.stringify([{ txid: TX_TXID, wtxid: TX_TXID, 'package-error': 'package-not-validated' }])
    const keys = {
      ...both({
        allowed: ['allowed', true],
        vsize: ['vsize', 61],
        rejectReason: ['reject-reason', 'attacker'],
        rejectDetails: ['reject-details', 'attacker'],
      }),
      fees: { baseBits: 1n, effectiveFeeRateBitsPerKvB: 1n, effectiveIncludes: [] },
    }
    const [entry] = parsedUnder(requests.testMempoolAccept([TX_HEX]), reply, keys)
    expect(withPrototype(entry)).toEqual([])
    polluted(keys, () => {
      expect(entry!.allowed).toBeUndefined()
      expect(entry!.fees).toBeUndefined()
      expect(entry!.packageError).toBe('package-not-validated')
    })
  })

  it('getBlockchainInfo: fields only some chains report stay absent', () => {
    const keys = both({
      pruneHeight: ['pruneheight', 1],
      automaticPruning: ['automatic_pruning', true],
      pruneTargetSize: ['prune_target_size', 1],
      signetChallenge: ['signet_challenge', '51'],
    })
    const info = parsedUnder(requests.getBlockchainInfo(), blockchainInfoJson('regtest'), keys)
    expect(withPrototype(info)).toEqual([])
    polluted(keys, () => {
      expect(info.signetChallenge).toBeUndefined()
      expect(info.pruneHeight).toBeUndefined()
    })
  })

  it('keep call() results as the node sent them, in objects without a prototype that serialize as before', () => {
    const text = '{"a":{"b":[1,{"c":0.10000000}]},"n":12345678901234567890}'
    const raw = parseJsonLossless(text) as { a: { b: [JsonNumber, { c: JsonNumber }] }; n: JsonNumber }
    expect(withPrototype(raw)).toEqual([])
    expect(polluted({ d: 1 }, () => (raw as Record<string, unknown>)['d'])).toBeUndefined()
    expect(JSON.stringify(raw)).toBe(text)
    expect(stringifyRequest(raw)).toBe(text)
    expect(raw.a.b[1].c.toBits()).toBe(10_000_000n)
    expect(raw.n.toBigInt()).toBe(12345678901234567890n)
    expect({ ...raw.a }).toEqual({ b: raw.a.b })
    expect(Object.getPrototypeOf({ ...raw.a })).toBe(Object.prototype)
  })

  it('check amounts as non-negative, whatever Object.prototype.allowNegative holds', () => {
    const unspent = `[{"txid":"${HASH_A}","vout":0,"scriptPubKey":"00","amount":-1,"confirmations":1,"spendable":true,"solvable":true,"parent_descs":[],"safe":true}]`
    expect(() =>
      polluted({ allowNegative: true }, () => requests.listUnspent().parse(parseJsonLossless(unspent)))
    ).toThrow(/result\[0\]\.amount: expected a QBT amount from 0/)
  })
})

describe('JSON-RPC replies under a polluted Object.prototype', () => {
  let node: FakeNode
  let rpc: QbitRpcClient

  beforeEach(async () => {
    node = await FakeNode.start()
    node.results({ ...chainResults('regtest'), getblockcount: '7', sendrawtransaction: JSON.stringify(TX_TXID) })
    rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      capabilities: ['broadcast'],
      chainCheckMaxAgeMs: 86_400_000,
    })
    await rpc.confirmChain()
  })
  afterEach(async () => {
    await node.close()
  })

  /** Pollute `keys` while the client handles the node's reply, restoring it once the call settles. */
  async function underReply<T>(keys: Readonly<Record<string, unknown>>, run: () => Promise<T>): Promise<T> {
    const handler = node.handler
    node.handler = (request, response) => {
      const end = response.end.bind(response)
      response.end = ((...args: Parameters<typeof end>) => {
        for (const [key, value] of Object.entries(keys)) proto[key] = value
        return end(...args)
      }) as typeof response.end
      return handler(request, response)
    }
    try {
      return await run()
    } finally {
      for (const key of Object.keys(keys)) delete proto[key]
      node.handler = handler
    }
  }

  const ERROR = { error: { code: -26, message: 'polluted' }, code: -26, message: 'polluted' }

  it('a successful reply stays a success, and an accepted broadcast resolves with its txid', async () => {
    expect(await underReply(ERROR, () => rpc.getBlockCount())).toBe(7)
    expect(await underReply(ERROR, () => rpc.sendRawTransaction(TX_HEX))).toBe(TX_TXID)
    expect(await underReply(ERROR, () => rpc.batch([requests.getBlockCount()]))).toEqual([{ ok: true, value: 7 }])
    expect((await underReply(ERROR, () => rpc.confirmChain())).chain).toBe('regtest')
  })

  it('an error without a message is malformed, never one carrying a polluted message', async () => {
    node.rpc(() => ({ error: { code: -26 } as never }))
    const error = await underReply({ message: 'polluted' }, () => rpc.getBlockCount()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcResponseError)
    expect(error).toMatchObject({ reason: 'protocol', path: 'response.error' })
    // An HTTP error status with such a body is no JSON-RPC answer either.
    node.handler = (request, response) => {
      const { id } = JSON.parse(request.body) as { id: number }
      response.statusCode = 500
      response.end(`{"jsonrpc":"2.0","error":{"code":-26},"id":${id}}`)
    }
    const legacy = await underReply({ message: 'polluted' }, () => rpc.getBlockCount()).catch((e: unknown) => e)
    expect(legacy).toBeInstanceOf(RpcTransportError)
    expect((legacy as Error).message).not.toContain('polluted')
  })

  // An array or a JsonNumber from parseJsonLossless keeps its prototype: an error
  // read through one would make a broadcast the node may have accepted a definite failure.
  const MEMPOOL_CONFLICT = { code: new JsonNumber('-26'), message: 'txn-mempool-conflict' }

  it.each(['[]', '5', '"txn-mempool-conflict"'])(
    'an error %s is malformed: a broadcast has an unknown outcome, at HTTP 200 or 500',
    async error => {
      for (const status of [200, 500]) {
        node.handler = (request, response) => {
          const { id } = JSON.parse(request.body) as { id: number }
          response.statusCode = status
          response.end(`{"jsonrpc":"2.0","id":${id},"error":${error}}`)
        }
        const sent = await underReply(MEMPOOL_CONFLICT, () => rpc.sendRawTransaction(TX_HEX)).catch((e: unknown) => e)
        expect(sent).toBeInstanceOf(RpcUnknownOutcomeError)
        expect(sent).toMatchObject({ txid: TX_TXID })
      }
    }
  )

  it.each(['[]', '5'])('an HTTP 500 body %s answers nothing: a broadcast has an unknown outcome', async body => {
    node.handler = (request, response) => {
      // The id only the request knows, so the pollution matches it.
      proto['id'] = new JsonNumber(String((JSON.parse(request.body) as { id: number }).id))
      response.statusCode = 500
      response.end(body)
    }
    try {
      const sent = await underReply({ error: MEMPOOL_CONFLICT }, () => rpc.sendRawTransaction(TX_HEX)).catch(
        (e: unknown) => e
      )
      expect(sent).toBeInstanceOf(RpcUnknownOutcomeError)
    } finally {
      delete proto['id']
    }
  })

  it.each([[[]], [5]])('a batch reply whose error is %j is malformed, not a node error for its entry', async error => {
    node.rpc(() => ({ error: error as never }))
    const failed = await underReply(MEMPOOL_CONFLICT, () => rpc.batch([requests.getBlockCount()])).catch(
      (e: unknown) => e
    )
    expect(failed).toBeInstanceOf(RpcResponseError)
    expect(failed).toMatchObject({ reason: 'protocol', path: expect.stringMatching(/^response\[id=\d+\]\.error$/) })
  })
})

describe('error properties under a polluted Object.prototype', () => {
  const values = (error: object): unknown[] =>
    Object.getOwnPropertyNames(error).map(name => (error as Record<string, unknown>)[name])

  it('take no polluted value', () => {
    const keys = {
      code: 'EPOLLUTED',
      status: 418,
      cause: 'polluted',
      actualGenesisHash: 'polluted',
      expectedSignetChallenge: 'polluted',
      actualSignetChallenge: 'polluted',
      actualChain: 'polluted',
      nodeVersion: 'polluted',
    }
    const errors = polluted(keys, () => [
      new RpcTransportError('getblockcount', 'network'),
      new RpcTransportError('getblockcount', 'http_status', {}),
      new RpcChainGuardError('sendrawtransaction', 'check_failed', 'regtest'),
      new RpcChainGuardError('sendrawtransaction', 'mismatch', 'regtest', {
        actualChain: 'main',
        mismatch: { differs: ['chain', 'genesis_hash', 'signet_challenge'], expectedGenesisHash: HASH_A },
      }),
      new RpcChainGuardError('sendrawtransaction', 'unsupported_version', 'regtest'),
      new RpcResponseError('getblockcount', 'validation', 'result', 'a number', {}),
    ])
    for (const error of errors) {
      expect(values(error)).not.toContain('polluted')
      expect(values(error)).not.toContain('EPOLLUTED')
      expect(values(error)).not.toContain(418)
      expect(polluted(keys, () => error.cause)).toBeUndefined()
      expect(error.message).not.toMatch(/polluted|418/i)
    }
  })

  it('have an own cause, undefined when none was given, with the attributes Error gives one', () => {
    const native = Object.getOwnPropertyDescriptor(new Error('x', { cause: 1 }), 'cause')
    expect(native).toEqual({ value: 1, writable: true, enumerable: false, configurable: true })
    const causeless = polluted({ cause: 'polluted' }, () => [
      new RpcError('getblockcount', -1, 'no'),
      new RpcTransportError('getblockcount', 'network'),
      new RpcResponseError('getblockcount', 'protocol', 'response', 'a JSON body'),
      new RpcChainGuardError('sendrawtransaction', 'unconfirmed', 'regtest'),
    ])
    for (const error of causeless) {
      expect(Object.getOwnPropertyDescriptor(error, 'cause')).toEqual({ ...native, value: undefined })
      // Read while Object.prototype.cause is set: the error's own undefined, not the polluted value.
      expect(polluted({ cause: 'polluted' }, () => error.cause)).toBeUndefined()
      expect(Object.keys(error)).not.toContain('cause')
    }
    const failure = new RpcTransportError('sendrawtransaction', 'network')
    const given = [
      new RpcAbortedError('getblockcount', 'stop'),
      new RpcUnknownOutcomeError('sendrawtransaction', failure),
    ]
    expect(given.map(error => Object.getOwnPropertyDescriptor(error, 'cause'))).toEqual([
      { ...native, value: 'stop' },
      { ...native, value: failure },
    ])
  })
})

/** Wrap `target` in a Proxy that records the string keys looked up on it, with `in` or by reading. */
function recorder<T extends object>(target: T, keys: Set<string>): T {
  const note = (key: string | symbol): void => {
    if (typeof key === 'string') keys.add(key)
  }
  return new Proxy(target, {
    has: (t, key) => (note(key), Reflect.has(t, key)),
    get: (t, key, receiver) => (note(key), Reflect.get(t, key, receiver)),
  })
}

const CLIENT_BASE = {
  url: 'http://127.0.0.1:1/',
  auth: { username: 'u', password: 'p' },
  expectedChain: 'regtest',
} as const satisfies QbitRpcClientOptions

/**
 * A value each client option and auth key would take, so a client that read
 * it from a polluted Object.prototype would be built with it.
 */
const CLIENT_SAMPLES: Readonly<Record<string, unknown>> = {
  url: 'http://127.0.0.1:2/',
  wallet: 'other',
  auth: { username: 'attacker', password: 'attacker' },
  tls: {},
  connect: () => undefined,
  expectedChain: 'regtest',
  expectedGenesisHash: HASH_B,
  expectedSignetChallenge: '51',
  capabilities: ['broadcast', 'wallet-write'],
  timeoutMs: 1,
  maxResponseBytes: 2048,
  readRetries: 10,
  retryDelayMs: 0,
  chainCheckMaxAgeMs: 86_400_000,
  maxConcurrentRequests: 1,
  directNode: true,
  allowUnsupportedNodeVersion: true,
  username: 'attacker',
  password: 'attacker',
  cookieFile: '/dev/null',
}

/** The keys the client's constructor looks up on its options and on `auth`, whichever way it looks them up. */
const CLIENT_KEYS = ((): { readonly options: string[]; readonly auth: string[] } => {
  const options = new Set<string>()
  const auth = new Set<string>()
  new QbitRpcClient(recorder({ ...CLIENT_BASE, auth: recorder({ ...CLIENT_BASE.auth }, auth) }, options)).close()
  return { options: [...options], auth: [...auth] }
})()

/** `value` without `key`. */
const without = (value: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))

describe('client options under a polluted Object.prototype', () => {
  it('find the keys the constructor reads, the reviewer’s among them', () => {
    for (const key of ['capabilities', 'wallet', 'directNode', 'chainCheckMaxAgeMs', 'auth', 'url']) {
      expect(CLIENT_KEYS.options).toContain(key)
    }
    expect(CLIENT_KEYS.auth).toEqual(expect.arrayContaining(['username', 'password', 'cookieFile']))
    const keys = [...CLIENT_KEYS.options, ...CLIENT_KEYS.auth]
    expect(keys.filter(key => !Object.hasOwn(CLIENT_SAMPLES, key))).toEqual([])
  })

  it.each([
    ...CLIENT_KEYS.options.map(key => ['options', key] as const),
    ...CLIENT_KEYS.auth.map(key => ['auth', key] as const),
  ])('refuse a polluted %s.%s left out of the object, naming it', (object, key) => {
    // capabilities would enable broadcasts, wallet send wallet calls to another
    // wallet, directNode make a proxy's 503 a definite failure, and password fill a missing one.
    const options =
      object === 'options' ? without(CLIENT_BASE, key) : { ...CLIENT_BASE, auth: without(CLIENT_BASE.auth, key) }
    expect(() => polluted({ [key]: CLIENT_SAMPLES[key] }, () => new QbitRpcClient(options as never))).toThrow(
      notOwn(`${object}.${key}`)
    )
  })

  it('read options given as own properties as they are, whatever the prototype holds', () => {
    const rpc = polluted(
      { capabilities: ['broadcast'], wallet: 'other' },
      () => new QbitRpcClient({ ...CLIENT_BASE, capabilities: [], wallet: 'mine' })
    )
    expect(rpc.toJSON()).toMatchObject({ url: 'http://127.0.0.1:1/wallet/mine', capabilities: [] })
    rpc.close()
  })

  it('refuse a class getter, and a hole in capabilities rather than read Array.prototype', () => {
    class Settings {
      readonly url = CLIENT_BASE.url
      readonly auth = CLIENT_BASE.auth
      readonly expectedChain = 'regtest'
      get capabilities(): readonly string[] {
        return ['broadcast']
      }
    }
    expect(() => new QbitRpcClient(new Settings() as never)).toThrow(notOwn('options.capabilities'))
    const capabilities = [, 'wallet-read'] as never
    arrayProto['0'] = 'broadcast'
    try {
      expect(() => new QbitRpcClient({ ...CLIENT_BASE, capabilities })).toThrow(
        'capabilities[0] is a hole, not an own element: pass an array without holes'
      )
    } finally {
      delete arrayProto['0']
    }
  })
})

describe('client options are strict', () => {
  const OPTIONS =
    'url, wallet, auth, tls, connect, expectedChain, expectedGenesisHash, expectedSignetChallenge, capabilities, ' +
    'timeoutMs, maxResponseBytes, readRetries, retryDelayMs, chainCheckMaxAgeMs, maxConcurrentRequests, directNode, ' +
    'allowUnsupportedNodeVersion'
  const TLS = 'ca, cert, key, passphrase, servername, pinSha256'

  it.each([
    // Without a wallet path, wallet-write calls would go to whichever wallet the node has loaded.
    [{ walletName: 'hot' }, `options.walletName is not a known key; the known keys are ${OPTIONS}`],
    [{ capabilites: ['broadcast'] }, `options.capabilites is not a known key; the known keys are ${OPTIONS}`],
    [{ timeout: 5_000 }, 'options.timeout is not a known key: use options.timeoutMs, in milliseconds'],
    [{ max_response_bytes: 1024 }, 'options.max_response_bytes is not a known key: use options.maxResponseBytes'],
    // Left out, a guarded call to an unsupported version would still be refused.
    [
      { allow_unsupported_node_version: true },
      'options.allow_unsupported_node_version is not a known key: use options.allowUnsupportedNodeVersion',
    ],
    // Left out, the client would trust the system's CAs, or connect directly.
    [{ TLS: {} }, 'options.TLS is not a known key: use options.tls'],
    [{ Connect: 'tunnel' }, 'options.Connect is not a known key: use options.connect'],
    [{ proxy: 'http://127.0.0.1:3128' }, `options.proxy is not a known key; the known keys are ${OPTIONS}`],
  ])('refuse the option %j, naming it', (extra, message) => {
    expect(() => new QbitRpcClient({ ...CLIENT_BASE, ...extra } as never)).toThrow(new TypeError(message))
  })

  it.each([
    [{ server_name: 'node.test' }, 'tls.server_name is not a known key: use tls.servername'],
    [{ pin_sha256: 'A'.repeat(43) + '=' }, 'tls.pin_sha256 is not a known key: use tls.pinSha256'],
    [{ CA: 'x' }, 'tls.CA is not a known key: use tls.ca'],
    [{ ciphers: 'x' }, `tls.ciphers is not a known key; the known keys are ${TLS}`],
  ])('refuse the tls key %j, naming it', (tls, message) => {
    expect(() => new QbitRpcClient({ ...CLIENT_BASE, url: 'https://node.test/', tls } as never)).toThrow(
      new TypeError(message)
    )
  })

  it.each([
    [
      { ...CLIENT_BASE.auth, realm: 'x' },
      'auth.realm is not a known key; the known keys are username, password, cookieFile',
    ],
    [{ cookie_file: '.cookie' }, 'auth.cookie_file is not a known key: use auth.cookieFile'],
  ])('refuse the auth %j, naming the key', (auth, message) => {
    expect(() => new QbitRpcClient({ ...CLIENT_BASE, auth } as never)).toThrow(new TypeError(message))
  })

  it('skip an unknown key only on Object.prototype, as it is never read', () => {
    polluted({ walletName: 'hot', realm: 'x' }, () => new QbitRpcClient(CLIENT_BASE)).close()
  })

  it('take capabilities as an array or left out, and null is neither', () => {
    expect(() => new QbitRpcClient({ ...CLIENT_BASE, capabilities: null } as never)).toThrow(
      new TypeError('capabilities must be an array')
    )
  })
})

describe('batch entries under a polluted Object.prototype', () => {
  let node: FakeNode
  let rpc: QbitRpcClient
  const parse = (result: unknown): unknown => result

  beforeEach(async () => {
    node = await FakeNode.start()
    node.results({ getblockcount: '7', getbestblockhash: JSON.stringify(HASH_A) })
    rpc = new QbitRpcClient({ url: node.url, auth: { username: 'u', password: 'p' }, expectedChain: 'regtest' })
  })
  afterEach(async () => {
    await node.close()
  })

  it('refuse params, a method or a parse an entry has only through a prototype, sending nothing', async () => {
    // The entries are read before the first await, so the pollution can end before anything is sent.
    const noParams = { method: 'getblockcount', parse } as unknown as RpcRequest<unknown>
    // Enumerable, as a pollution sets it, the batch is refused before its entries are read.
    await expect(polluted({ params: ['polluted'] }, () => rpc.batch([noParams]))).rejects.toMatchObject(
      POLLUTION_REFUSED
    )
    await expect(pollutedQuietly({ params: ['polluted'] }, () => rpc.batch([noParams]))).rejects.toThrow(
      notOwn('entries[0].params')
    )
    const noParse = { method: 'getblockcount', params: [] } as unknown as RpcRequest<unknown>
    await expect(pollutedQuietly({ parse }, () => rpc.batch([noParse]))).rejects.toThrow(notOwn('entries[0].parse'))
    const noMethod = { params: [], parse } as unknown as RpcRequest<unknown>
    await expect(pollutedQuietly({ method: 'getblockcount' }, () => rpc.batch([noMethod]))).rejects.toThrow(
      notOwn('entries[0].method')
    )
    class Request {
      readonly method = 'getblockcount'
      readonly params = []
      parse(result: unknown): unknown {
        return result
      }
    }
    await expect(rpc.batch([new Request()])).rejects.toThrow(notOwn('entries[0].parse'))
    expect(node.requests).toHaveLength(0)
    // Its own fields are sent as they are, and one it leaves out is left out.
    const [count] = await pollutedQuietly({ params: ['polluted'] }, () => rpc.batch([requests.getBlockCount()]))
    expect(count).toEqual({ ok: true, value: 7 })
    await rpc.batch([noParams])
    expect(node.calls().map(call => Object.keys(call))).toEqual([
      ['jsonrpc', 'id', 'method', 'params'],
      ['jsonrpc', 'id', 'method'],
    ])
    // A parse runs on the caller's entry, as entry.parse(result) would.
    const self = {
      method: 'getblockcount',
      params: [],
      parse(this: unknown): unknown {
        return this === self
      },
    }
    expect(await rpc.batch([self])).toEqual([{ ok: true, value: true }])
  })

  it('refuse a hole in the entries rather than send what Array.prototype holds', async () => {
    let refused: Promise<unknown>
    arrayProto['0'] = requests.getBlockCount()
    try {
      refused = rpc.batch([, requests.getBestBlockHash()] as never)
    } finally {
      delete arrayProto['0']
    }
    await expect(refused).rejects.toThrow('entries[0] is a hole, not an own element: pass an array without holes')
    expect(node.requests).toHaveLength(0)
  })

  it('hold at most 1,000 as copied, whatever a Proxy first says its length is', async () => {
    let reads = 0
    const shifting = new Proxy(
      Array.from({ length: 1001 }, () => requests.getBlockCount()),
      { get: (target, key, receiver) => (key === 'length' && reads++ === 0 ? 1 : Reflect.get(target, key, receiver)) }
    )
    // The first read passes the check on the given length; the copy, which is what would be sent, does not.
    await expect(rpc.batch(shifting)).rejects.toThrow(new RangeError('a batch holds at most 1000 requests'))
    expect(node.calls()).toEqual([])
    expect(reads).toBe(2)
  })
})

describe('call() params', () => {
  let node: FakeNode

  beforeEach(async () => {
    node = await FakeNode.start()
    node.results(chainResults('regtest'))
  })
  afterEach(async () => {
    await node.close()
  })

  it('are serialized once, so a toJSON or a getter cannot pass the check and then send a refused key', async () => {
    const rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      capabilities: ['wallet-write'],
      chainCheckMaxAgeMs: 86_400_000,
    })
    await rpc.confirmChain()
    let calls = 0
    const disguised = { toJSON: () => (calls++ === 0 ? { fee_rate: 2.5 } : { subtract_fee_from_outputs: [0] }) }
    let reads = 0
    const getter = {
      fee_rate: 2.5,
      get subtract_fee_from_outputs() {
        return reads++ === 0 ? undefined : [0]
      },
    }
    for (const options of [disguised, getter]) {
      node.requests.length = 0
      // The fake node answers walletcreatefundedpsbt with an error: only what was sent matters.
      await rpc.call('walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }], 0, options]).catch(() => undefined)
      const sent = node.calls().filter(call => call.method === 'walletcreatefundedpsbt')
      expect(sent.map(call => call.params[3])).toEqual([{ fee_rate: 2.5 }])
    }
    expect([calls, reads]).toEqual([1, 1])
    // The request holds the params as they are sent: a toJSON ran once, and its result is what is kept.
    const raw = requests.raw('walletcreatefundedpsbt', [[], [], 0, { toJSON: () => ({ lockUnspents: true }) }])
    expect(stringifyRequest(raw.params)).toBe('[[],[],0,{"lockUnspents":true}]')
    expect(withPrototype(raw.params)).toEqual([])
  })

  it('nest at most as deep as qbit Core parses, the envelope included, refused before anything is sent', async () => {
    const nest = (depth: number): unknown => {
      let value: unknown = 0
      for (let i = 0; i < depth; i++) value = i % 2 === 0 ? [value] : { a: value }
      return value
    }
    // qbitd v1.0.0 answers a 513-level body with HTTP 500 Parse error, and parses 512.
    const message = 'RPC parameters must not nest deeper than 512 arrays and objects, the request envelope included'
    expect(stringifyRequest(nest(512))).toBe(JSON.stringify(nest(512)))
    expect(() => stringifyRequest(nest(513))).toThrow(new TypeError(message))
    // A fixed bound, not the stack: JSON.stringify writes these, and a recursive serializer overflowed.
    expect(() => stringifyRequest(nest(10_000))).toThrow(new TypeError(message))
    const growing = { toJSON: (): unknown => [growing] }
    expect(() => stringifyRequest(growing)).toThrow(new TypeError(message))

    const rpc = new QbitRpcClient({ url: node.url, auth: { username: 'u', password: 'p' }, expectedChain: 'regtest' })
    /** Params nesting `levels` arrays and objects, the params array included. */
    const params = (levels: number): unknown[] => [nest(levels - 1)]
    const entry = (levels: number): RpcRequest<unknown> => ({
      method: 'getblockhash',
      params: params(levels),
      parse: result => result,
    })
    // The request envelope is one more level: raw() counts it, as call() sends it.
    expect(() => requests.raw('getblockhash', params(512))).toThrow(new TypeError(message))
    await expect(rpc.call('getblockhash', params(512))).rejects.toThrow(new TypeError(message))
    // A batch's array is one more again: batch() refuses the entry, naming it.
    const inBatch = new TypeError(`batch() entry 1: ${message}`)
    await expect(rpc.batch([entry(1), requests.raw('getblockhash', params(511))])).rejects.toThrow(inBatch)
    await expect(rpc.batch([entry(1), entry(511)])).rejects.toThrow(inBatch)
    await expect(rpc.batch([entry(1), entry(512)])).rejects.toThrow(inBatch)
    expect(node.requests).toHaveLength(0)

    for (const levels of [510, 511]) {
      await rpc.call('getblockhash', params(levels)).catch(() => undefined)
    }
    await rpc.batch([requests.raw('getblockhash', params(510))])
    await rpc.batch([entry(510)])
    // Every body sent is within the limit, and the longest reach it exactly.
    const depth = (body: string): number => {
      let open = 0
      let deepest = 0
      for (const character of body) {
        if (character === '[' || character === '{') deepest = Math.max(deepest, ++open)
        if (character === ']' || character === '}') open--
      }
      return deepest
    }
    expect(node.requests.map(request => depth(request.body))).toEqual([511, 512, 512, 512])
  })
})

describe('parseQbt under a polluted Object.prototype', () => {
  it('reads allowNegative from its options’ own properties only', () => {
    expect(() => polluted({ allowNegative: true }, () => parseQbt('-1'))).toThrow(
      new RangeError('QBT amount must not be negative')
    )
    expect(() => polluted({ allowNegative: true }, () => parseQbt('-1', {}))).toThrow(notOwn('options.allowNegative'))
    expect(polluted({ allowNegative: false }, () => parseQbt('-1', { allowNegative: true }))).toBe(-100_000_000n)
  })
})

describe('stringifyRequest', () => {
  it('writes what JSON.stringify writes for own data', () => {
    const value = [
      'a" ',
      -0,
      1.5,
      true,
      null,
      undefined,
      () => 1,
      { b: undefined, c: [undefined, Symbol('s')], d: new Date(0), e: new JsonNumber('1.10'), f: new String('x') },
      Object.assign(Object.create(null) as object, { g: 1 }),
      [new Number(2), new Boolean(false)],
    ]
    expect(stringifyRequest(value)).toBe(JSON.stringify(value))
    expect(stringifyRequest([1n, Object(2n)])).toBe('[1,2]')
    expect(() => stringifyRequest([Number.NaN])).toThrow('RPC parameters must not contain NaN or Infinity')
    const cycle: unknown[] = []
    cycle.push(cycle)
    expect(() => stringifyRequest(cycle)).toThrow(TypeError)
    // An own toJSON applies, with the key, as JSON.stringify calls it.
    expect(stringifyRequest({ k: { toJSON: (key: string) => `at ${key}` } })).toBe('{"k":"at k"}')
  })

  it('never applies a toJSON from Object.prototype, Array.prototype or BigInt.prototype', () => {
    const hijack = function (): unknown {
      return { change_address: 'rq1attacker' }
    }
    const bigintProto = BigInt.prototype as unknown as Record<string, unknown>
    for (const target of [proto, arrayProto, bigintProto]) {
      target['toJSON'] = hijack
      try {
        expect(stringifyRequest([{ a: 1 }, [2], 3n])).toBe('[{"a":1},[2],3]')
        expect(stringifyRequest([new JsonNumber('0.5'), new Date(0)])).toBe(
          `[0.5,${JSON.stringify(new Date(0).toISOString())}]`
        )
      } finally {
        delete target['toJSON']
      }
    }
  })

  it('refuses an array hole rather than writing what a prototype holds at its index', () => {
    const holey = [, 1]
    arrayProto['0'] = 'polluted'
    try {
      expect(() => stringifyRequest({ params: holey })).toThrow('RPC parameters must not contain an array hole')
    } finally {
      delete arrayProto['0']
    }
  })
})
