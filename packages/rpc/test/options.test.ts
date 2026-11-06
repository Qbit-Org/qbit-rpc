import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { QbitRpcClient, requests, type RpcRequest } from '../src'
import { stringifyRequest } from '../src/json'
import { chainResults, FakeNode, HASH_A, TX_HEX } from './helpers/fake-node'

// Every options or arguments object is strict: a key no builder reads would
// otherwise be dropped without a word, as qbit Core v1.0.0 itself drops
// subtract_fee_from_outputs.

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
const OUTPUT = { address: 'rq1a', amountBits: 1n }

/** A builder given an object with one key too many, the message it must throw, and the same call without it. */
const unknownKeys: [string, () => RpcRequest<unknown>, RegExp][] = [
  [
    'getRawTransaction options',
    () => requests.getRawTransaction(HASH_A, { blockhash: HASH_A } as never),
    /^options\.blockhash is not a known key: use options\.blockHash$/,
  ],
  [
    'getRawTransactionVerbose options',
    () => requests.getRawTransactionVerbose(HASH_A, { verbose: true } as never),
    /^options\.verbose is not a known key; the known keys are blockHash$/,
  ],
  [
    'getTxOut options',
    () => requests.getTxOut(HASH_A, 0, { include_mempool: false } as never),
    /use options\.includeMempool$/,
  ],
  [
    'getConfirmationTarget options',
    () => requests.getConfirmationTarget(1n, { security_level: 'high' } as never),
    /use options\.securityLevel$/,
  ],
  [
    'estimateSmartFee options',
    () => requests.estimateSmartFee(6, { estimate_mode: 'economical' } as never),
    /^options\.estimate_mode is not a known key; the known keys are mode$/,
  ],
  [
    'verifyDataPqcHash proof',
    () => requests.verifyDataPqcHash({ ...PROOF, message_hash: PROOF.messageHash } as never),
    /^proof\.message_hash is not a known key: use proof\.messageHash$/,
  ],
  [
    'testMempoolAccept options',
    () => requests.testMempoolAccept([TX_HEX], { maxfeerate: 1n } as never),
    /use options\.maxFeeRateBitsPerKvB, a bigint in bits per 1,000 vbytes \(1000n is 1 bit\/vB\)$/,
  ],
  [
    'sendRawTransaction options',
    () => requests.sendRawTransaction(TX_HEX, { maxburnamount: 1n } as never),
    /use options\.maxBurnAmountBits, a bigint in bits \(1 QBT is 100,000,000 bits\)$/,
  ],
  ['listUnspent options', () => requests.listUnspent({ minconf: 0 } as never), /use options\.minConf$/],
  [
    'listUnspent options (amount without its unit)',
    () => requests.listUnspent({ minimumAmount: 1n } as never),
    /use options\.minimumAmountBits, a bigint in bits/,
  ],
  [
    'walletCreateFundedPsbt args',
    () => requests.walletCreateFundedPsbt({ outputs: [OUTPUT], lockTime: 5 } as never),
    /^args\.lockTime is not a known key: use args\.locktime$/,
  ],
  [
    'walletCreateFundedPsbt args.inputs[]',
    () => requests.walletCreateFundedPsbt({ inputs: [{ txid: HASH_A, vout: 0, seq: 1 }], outputs: [OUTPUT] } as never),
    /^args\.inputs\[0\] has an unknown key \(not shown\); the known keys are txid, vout, sequence$/,
  ],
  [
    'walletCreateFundedPsbt args.outputs[]',
    () => requests.walletCreateFundedPsbt({ outputs: [OUTPUT, { address: 'rq1b', amount: 1n }] } as never),
    /^args\.outputs\[1\]\.amount is not a known key: use args\.outputs\[1\]\.amountBits, a bigint in bits/,
  ],
  [
    // The node's own { "<address>": amount } format: the address is caller data, never quoted.
    'walletCreateFundedPsbt args.outputs[] keyed by address',
    () =>
      requests.walletCreateFundedPsbt({
        outputs: [{ qbrt1zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9nlvx0: 150_000_000n }],
      } as never),
    /^args\.outputs\[0\] has an unknown key \(not shown\); the known keys are address, amountBits, data$/,
  ],
  [
    'walletCreateFundedPsbt args.options (the node spelling)',
    () =>
      requests.walletCreateFundedPsbt({
        outputs: [OUTPUT],
        options: { subtract_fee_from_outputs: [0], feeRateBitsPerKvB: 2500n },
      } as never),
    /^args\.options\.subtract_fee_from_outputs is not a known key: use args\.options\.subtractFeeFromOutputs$/,
  ],
  [
    'walletCreateFundedPsbt args.options (a typo)',
    () => requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options: { subtractFeeFromOutput: [0] } } as never),
    /use args\.options\.subtractFeeFromOutputs$/,
  ],
  [
    'walletCreateFundedPsbt args.options (the node fee rate)',
    () => requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options: { fee_rate: 2.5 } } as never),
    /use args\.options\.feeRateBitsPerKvB, a bigint in bits per 1,000 vbytes/,
  ],
  [
    'walletProcessPsbt options',
    () => requests.walletProcessPsbt('cHNidP8=', { sighash_type: 'ALL' } as never),
    /use options\.sighashType$/,
  ],
  [
    'finalizePsbt options',
    () => requests.finalizePsbt('cHNidP8=', { Extract: false } as never),
    /use options\.extract$/,
  ],
  [
    'getRawChangeAddress options',
    () => requests.getRawChangeAddress({ address_type: 'p2mr' } as never),
    /use options\.addressType$/,
  ],
  [
    'listSinceBlock options',
    () => requests.listSinceBlock({ blockhash: HASH_A } as never),
    /^options\.blockhash is not a known key: use options\.blockHash$/,
  ],
  [
    'listTransactions options',
    () => requests.listTransactions({ include_watchonly: true } as never),
    /use options\.includeWatchOnly$/,
  ],
  [
    'getNewAddress options',
    () => requests.getNewAddress({ address_type: 'p2mr' } as never),
    /use options\.addressType$/,
  ],
  [
    'psbtBumpFee options (the node fee rate)',
    () => requests.psbtBumpFee(HASH_A, { fee_rate: 4 } as never),
    /^options\.fee_rate is not a known key: use options\.feeRateBitsPerKvB, a bigint in bits per 1,000 vbytes \(1000n is 1 bit\/vB\)$/,
  ],
  [
    'psbtBumpFee options (the node confirmation target)',
    () => requests.psbtBumpFee(HASH_A, { conf_target: 6 } as never),
    /^options\.conf_target is not a known key: use options\.confTarget$/,
  ],
  [
    'psbtBumpFee options (the node change index)',
    () => requests.psbtBumpFee(HASH_A, { original_change_index: 1 } as never),
    /^options\.original_change_index is not a known key: use options\.originalChangeIndex$/,
  ],
  [
    'psbtBumpFee options (the node estimate mode)',
    () => requests.psbtBumpFee(HASH_A, { estimate_mode: 'economical' } as never),
    /^options\.estimate_mode is not a known key: use options\.estimateMode$/,
  ],
  [
    'psbtBumpFee options (a walletCreateFundedPsbt option)',
    () => requests.psbtBumpFee(HASH_A, { subtractFeeFromOutputs: [0] } as never),
    /^options\.subtractFeeFromOutputs is not a known key; the known keys are feeRateBitsPerKvB, confTarget, estimateMode, replaceable, outputs, originalChangeIndex$/,
  ],
  [
    'psbtBumpFee options.outputs[]',
    () => requests.psbtBumpFee(HASH_A, { outputs: [{ address: 'rq1a', amount: 1n }] } as never),
    /^options\.outputs\[0\]\.amount is not a known key: use options\.outputs\[0\]\.amountBits, a bigint in bits/,
  ],
  [
    'lockUnspent options',
    () => requests.lockUnspent([{ txid: HASH_A, vout: 0 }], { persist: true } as never),
    /^options\.persist is not a known key; the known keys are persistent$/,
  ],
  [
    'lockUnspent outputs[]',
    () => requests.lockUnspent([{ txid: HASH_A, vout: 0, n: 1 }] as never),
    /^outputs\[0\] has an unknown key \(not shown\); the known keys are txid, vout$/,
  ],
  [
    'unlockUnspent outputs[]',
    () => requests.unlockUnspent([{ txid: HASH_A, vout: 0, n: 1 }] as never),
    /^outputs\[0\] has an unknown key \(not shown\); the known keys are txid, vout$/,
  ],
  [
    'getTxOut options (a call option)',
    () => requests.getTxOut(HASH_A, 0, { timeoutMs: 5 } as never),
    /^options\.timeoutMs is a call option: pass it in the call options, the last argument of the client method or of batch\(\)$/,
  ],
  [
    'listUnspent options (a call option misspelled)',
    () => requests.listUnspent({ timeout: 5 } as never),
    /^options\.timeout is not a known key: use timeoutMs, in milliseconds, in the call options, the last argument of the client method or of batch\(\)$/,
  ],
]

describe('request builders', () => {
  it.each(unknownKeys)('reject an unknown key in %s, naming it', (_name, build, message) => {
    expect(build).toThrow(TypeError)
    expect(build).toThrow(message)
  })

  it('accept every known key, and keys set to undefined among them', () => {
    expect(requests.getTxOut(HASH_A, 0, { includeMempool: undefined } as never).params).toEqual([HASH_A, 0])
    expect(requests.verifyDataPqcHash(PROOF).params).toHaveLength(1)
    expect(
      requests.walletCreateFundedPsbt({
        inputs: [{ txid: HASH_A, vout: 0, sequence: 1 }],
        outputs: [OUTPUT, { data: 'cafe' }],
        locktime: 0,
        options: {
          addInputs: true,
          includeUnsafe: false,
          minConf: 1,
          maxConf: 10,
          changeAddress: 'rq1c',
          changePosition: 0,
          changeType: 'p2mr',
          lockUnspents: false,
          subtractFeeFromOutputs: [0],
          maxTxWeight: 400_000,
          replaceable: true,
          confTarget: 6,
          estimateMode: 'economical',
        },
        bip32derivs: true,
        version: 2,
      }).params
    ).toHaveLength(6)
    expect(
      requests.listUnspent({
        minConf: 0,
        maxConf: 9,
        addresses: ['rq1a'],
        includeUnsafe: true,
        minimumAmountBits: 1n,
        maximumAmountBits: 2n,
        maximumCount: 3,
        minimumSumAmountBits: 4n,
        includeImmatureCoinbase: false,
      }).params
    ).toHaveLength(5)
  })

  it('accept typed results that are outpoints where an outpoint is expected, reading only txid, vout (and sequence)', () => {
    const unspent = {
      txid: HASH_A,
      vout: 1,
      address: 'rq1a',
      scriptPubKey: '00',
      amountBits: 5n,
      confirmations: 3,
      spendable: true,
      solvable: true,
      parentDescs: [],
      safe: true,
    }
    expect(requests.lockUnspent([unspent]).params[1]).toEqual([{ txid: HASH_A, vout: 1 }])
    expect(requests.walletCreateFundedPsbt({ inputs: [unspent], outputs: [OUTPUT] }).params[0]).toEqual([
      { txid: HASH_A, vout: 1 },
    ])
    // A decoded transaction input, and a listSinceBlock() or listTransactions() entry.
    const input = { txid: HASH_A, vout: 1, scriptSig: { asm: '', hex: '' }, txinwitness: ['00'], sequence: 0xffff_fffd }
    expect(requests.lockUnspent([input]).params[1]).toEqual([{ txid: HASH_A, vout: 1 }])
    expect(requests.walletCreateFundedPsbt({ inputs: [input], outputs: [OUTPUT] }).params[0]).toEqual([
      { txid: HASH_A, vout: 1, sequence: 0xffff_fffd },
    ])
    const entry = {
      address: 'rq1a',
      category: 'receive',
      amountBits: 5n,
      vout: 1,
      abandoned: false,
      confirmations: 0,
      trusted: true,
      txid: HASH_A,
      wtxid: HASH_A,
      walletConflicts: [],
      mempoolConflicts: [],
      time: 1,
      timeReceived: 1,
      bip125Replaceable: 'no',
    }
    expect(requests.unlockUnspent([entry]).params[1]).toEqual([{ txid: HASH_A, vout: 1 }])
  })

  it('ignore an enumerable key on a polluted Object.prototype, but not the same key set by the caller', () => {
    const proto = Object.prototype as Record<string, unknown>
    proto['polluted'] = 1
    try {
      expect(requests.listUnspent({ minConf: 1 }).params).toEqual([1])
      expect(requests.getTxOut(HASH_A, 0, {}).params).toEqual([HASH_A, 0])
      expect(() => requests.listUnspent({ polluted: 1 } as never)).toThrow(/options\.polluted is not a known key/)
      // Nor the same key inherited from the caller's own prototype.
      const parent = Object.assign(Object.create(null) as object, { polluted: 1 })
      expect(() => requests.listUnspent(Object.create(parent) as never)).toThrow(/options\.polluted is not a known key/)
    } finally {
      delete proto['polluted']
    }
  })

  it("refuse a call option among a request's own options, pointing to the call options", () => {
    for (const key of ['signal', 'timeoutMs']) {
      // Even set to undefined: any key a builder does not read is refused.
      expect(() => requests.listUnspent({ minConf: 1, [key]: undefined } as never)).toThrow(TypeError)
      expect(() => requests.listUnspent({ minConf: 1, [key]: 5 } as never)).toThrow(
        new RegExp(
          `^options\\.${key} is a call option: pass it in the call options, the last argument of the client method or of batch\\(\\)$`
        )
      )
    }
    // Nested arguments never take call options, and say nothing about them.
    expect(() => requests.lockUnspent([{ txid: HASH_A, vout: 0, timeoutMs: 5 } as never])).toThrow(
      /^outputs\[0\] has an unknown key \(not shown\); the known keys are txid, vout$/
    )
    // A method's top-level arguments object points a call option to its place.
    expect(() => requests.walletCreateFundedPsbt({ outputs: [OUTPUT], signal: 5 } as never)).toThrow(
      /^args\.signal is a call option: pass it in the call options/
    )
  })

  it('read the options a check relates once, so a getter cannot pass it and then send both', () => {
    let reads = 0
    const options = {
      feeRateBitsPerKvB: 2500n,
      // undefined on the first read, a value on any later one
      get confTarget() {
        return reads++ === 0 ? undefined : 6
      },
    }
    const built = requests.walletCreateFundedPsbt({ outputs: [OUTPUT], options } as never)
    expect(built.params[3]).not.toHaveProperty('conf_target')
    expect(reads).toBe(1)
  })

  it('refuse inherited keys, naming a known one, and inherited unknown ones as before', () => {
    const defaults = Object.create({ minConf: 6 }) as { readonly minConf?: number }
    expect(() => requests.listUnspent(defaults)).toThrow(
      /^options\.minConf is not an own enumerable property \(it is inherited, a class getter or on a polluted Object\.prototype\): pass a plain object$/
    )
    const typo = Object.create({ minconf: 6 }) as never
    expect(() => requests.listUnspent(typo)).toThrow(/options\.minconf is not a known key: use options\.minConf/)
  })

  it('refuse, when call() sends it, a walletcreatefundedpsbt option qbit Core accepts and then ignores', async () => {
    const node = await FakeNode.start()
    try {
      node.results({
        ...chainResults('regtest'),
        walletcreatefundedpsbt: '{"psbt":"cHNidP8=","fee":0.0001,"changepos":-1}',
      })
      const rpc = new QbitRpcClient({
        url: node.url,
        auth: { username: 'u', password: 'p' },
        expectedChain: 'regtest',
        capabilities: ['wallet-write'],
      })
      await rpc.confirmChain()
      node.requests.length = 0
      const fund = (options: unknown): Promise<unknown> =>
        rpc.call('walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }], 0, options])
      const refused =
        /^walletcreatefundedpsbt option subtract_fee_from_outputs is accepted and then ignored by qbit Core v1\.0\.0: send subtractFeeFromOutputs, or use walletCreateFundedPsbt\(\)$/
      await expect(fund({ subtract_fee_from_outputs: [0], fee_rate: 2.5 })).rejects.toThrow(refused)
      // What is checked is what is sent: toJSON() applies.
      await expect(fund({ toJSON: () => ({ subtract_fee_from_outputs: [0] }) })).rejects.toThrow(refused)
      expect(node.requests).toHaveLength(0)
      // The spelling the node reads, an undefined value and a function value (both left out) are sent.
      await fund({ subtractFeeFromOutputs: [0] })
      await fund({ fee_rate: 2.5, subtract_fee_from_outputs: undefined })
      await fund({ fee_rate: 2.5, subtract_fee_from_outputs: () => [0] })
      expect(node.calls().map(call => call.params[3])).toEqual([
        { subtractFeeFromOutputs: [0] },
        { fee_rate: 2.5 },
        { fee_rate: 2.5 },
      ])
      // A getter is read once, by the serialization the node receives: a second
      // read can no longer slip the refused key past a check of the first.
      node.requests.length = 0
      let reads = 0
      const shifting = Object.defineProperty({ fee_rate: 2.5 }, 'subtract_fee_from_outputs', {
        enumerable: true,
        get: () => (++reads > 1 ? [0] : undefined),
      })
      await fund(shifting)
      expect(reads).toBe(1)
      expect(node.calls().map(call => call.params[3])).toEqual([{ fee_rate: 2.5 }])
      // Read first as the refused key, it is refused, and nothing is sent.
      reads = 0
      node.requests.length = 0
      const first = Object.defineProperty({ fee_rate: 2.5 }, 'subtract_fee_from_outputs', {
        enumerable: true,
        get: () => (++reads === 1 ? [0] : undefined),
      })
      await expect(fund(first)).rejects.toThrow(refused)
      expect(node.requests).toHaveLength(0)
      // Other methods pass the key through untouched.
      expect(requests.raw('decodepsbt', ['cHNidP8=', { subtract_fee_from_outputs: [0] }]).params).toHaveLength(2)
      // The request holds the options as they will be sent, which is what the check reads.
      const held = (options: object): string =>
        stringifyRequest(requests.raw('walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }], 0, options]).params[3])
      expect(held({ fee_rate: 2.5, subtract_fee_from_outputs: undefined })).toBe('{"fee_rate":2.5}')
      expect(held({ fee_rate: 2.5, subtract_fee_from_outputs: () => [0] })).toBe('{"fee_rate":2.5}')
    } finally {
      await node.close()
    }
  })
})

describe('client methods', () => {
  let node: FakeNode
  let rpc: QbitRpcClient

  beforeEach(async () => {
    node = await FakeNode.start()
    node.results(chainResults('regtest'))
    rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
    })
    await rpc.confirmChain()
    node.requests.length = 0
  })
  afterEach(async () => {
    await node.close()
  })

  it.each<[string, (rpc: QbitRpcClient) => Promise<unknown>, RegExp]>([
    // A method's own options.
    [
      'getTxOut',
      c => c.getTxOut(HASH_A, 0, { includeMempool: true, include_mempool: false } as never),
      /include_mempool/,
    ],
    [
      'listUnspent',
      c => c.listUnspent({ minconf: 0 } as never),
      /^options\.minconf is not a known key: use options\.minConf$/,
    ],
    ['sendRawTransaction', c => c.sendRawTransaction(TX_HEX, { maxfeerate: 1n } as never), /maxfeerate/],
    ['getRawChangeAddress', c => c.getRawChangeAddress({ address_type: 'p2mr' } as never), /addressType/],
    ['listSinceBlock', c => c.listSinceBlock({ blockhash: HASH_A } as never), /use options\.blockHash$/],
    ['getNewAddress', c => c.getNewAddress({ label_name: 'x' } as never), /label_name/],
    ['lockUnspent', c => c.lockUnspent([{ txid: HASH_A, vout: 0 }], { persist: true } as never), /persist/],
    [
      'psbtBumpFee',
      c => c.psbtBumpFee(HASH_A, { conf_target: 6 } as never),
      /^options\.conf_target is not a known key: use options\.confTarget$/,
    ],
    // A call option among them, as the merged options of earlier versions took it.
    [
      'listUnspent (a call option)',
      c => c.listUnspent({ minConf: 1, timeoutMs: 1000 } as never),
      /^options\.timeoutMs is a call option: pass it in the call options, the last argument of the client method or of batch\(\)$/,
    ],
    [
      'sendRawTransaction (a call option)',
      c => c.sendRawTransaction(TX_HEX, { signal: new AbortController().signal } as never),
      /^options\.signal is a call option/,
    ],
    [
      'psbtBumpFee (a call option misspelled)',
      c => c.psbtBumpFee(HASH_A, { timeout: 1000 } as never),
      /^options\.timeout is not a known key: use timeoutMs, in milliseconds, in the call options, the last argument of the client method or of batch\(\)$/,
    ],
    // The call options.
    [
      'getBlockCount',
      c => c.getBlockCount({ timeout: 1000 } as never),
      /^callOptions\.timeout is not a known key: use callOptions\.timeoutMs, in milliseconds$/,
    ],
    ['walletLock', c => c.walletLock({ signals: [] } as never), /signals/],
    [
      'getTxOut (a method option among the call options)',
      c => c.getTxOut(HASH_A, 0, {}, { includeMempool: false } as never),
      /^callOptions\.includeMempool is not a known key; the known keys are signal, timeoutMs$/,
    ],
    [
      'listUnspent (its options passed as call options)',
      c => c.listUnspent(undefined, { minConf: 1 } as never),
      /^callOptions\.minConf is not a known key/,
    ],
    [
      'lockUnspent (call options passed as its options)',
      c => c.lockUnspent([{ txid: HASH_A, vout: 0 }], { timeoutMs: 1000 } as never),
      /^options\.timeoutMs is a call option/,
    ],
    ['call', c => c.call('getblockcount', [], { timeout_ms: 5 } as never), /use callOptions\.timeoutMs$/],
    ['batch', c => c.batch([requests.getBlockCount()], { deadline: 5 } as never), /deadline/],
    ['an empty batch', c => c.batch([], { timeoutMS: 5 } as never), /use callOptions\.timeoutMs$/],
    ['confirmChain', c => c.confirmChain({ timeoutMS: 5 } as never), /use callOptions\.timeoutMs$/],
    [
      'walletCreateFundedPsbt',
      c => c.walletCreateFundedPsbt({ outputs: [OUTPUT] }, { timeoutMs: 1000, retries: 1 } as never),
      /retries/,
    ],
    [
      "call('walletcreatefundedpsbt')",
      c => c.call('walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }], 0, { subtract_fee_from_outputs: [0] }]),
      /accepted and then ignored/,
    ],
  ])('%s rejects an unknown key before sending anything', async (_name, run, message) => {
    const error = await run(rpc).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(message)
    expect(node.requests).toHaveLength(0)
  })

  it('pass the call options, the last argument, apart from the method options', async () => {
    node.results({ gettxout: 'null', getblockcount: '7' })
    expect(await rpc.getTxOut(HASH_A, 0, { includeMempool: false }, { timeoutMs: 1000 })).toBeNull()
    expect(node.calls().at(-1)!.params).toEqual([HASH_A, 0, false])
    expect(await rpc.getTxOut(HASH_A, 0, undefined, { timeoutMs: 1000 })).toBeNull()
    expect(node.calls().at(-1)!.params).toEqual([HASH_A, 0])
    const aborted = new AbortController()
    aborted.abort()
    await expect(rpc.getTxOut(HASH_A, 0, {}, { signal: aborted.signal })).rejects.toMatchObject({
      name: 'RpcAbortedError',
    })
    await expect(rpc.getBlockCount({ timeoutMs: 0 })).rejects.toThrow(
      /^callOptions\.timeoutMs must be an integer from 1 to 3600000$/
    )
    await expect(rpc.getBlockCount({ signal: 'stop' as never })).rejects.toThrow(
      /^callOptions\.signal must be an AbortSignal$/
    )
    await expect(rpc.getTxOut(HASH_A, 0, {}, 5 as never)).rejects.toThrow(/^callOptions must be an object$/)
    expect(await rpc.getBlockCount({ timeoutMs: 1000, signal: undefined } as never)).toBe(7)
    // Each reads its own enumerable properties only: a key held any other way is refused, named.
    const sent = node.requests.length
    const notOwn = (name: string): RegExp =>
      new RegExp(
        `^${name.replace('.', '\\.')} is not an own enumerable property \\(it is inherited, a class getter or on a polluted Object\\.prototype\\): pass a plain object$`
      )
    const inherited = Object.create({ includeMempool: false }) as { readonly includeMempool?: boolean }
    const callInherited = Object.create({ timeoutMs: 1000 }) as { readonly timeoutMs?: number }
    await expect(rpc.getTxOut(HASH_A, 0, inherited)).rejects.toThrow(notOwn('options.includeMempool'))
    await expect(rpc.getTxOut(HASH_A, 0, {}, callInherited)).rejects.toThrow(notOwn('callOptions.timeoutMs'))
    class Options {
      get includeMempool(): boolean {
        return false
      }
    }
    class CallOptions {
      get timeoutMs(): number {
        return 1000
      }
    }
    await expect(rpc.getTxOut(HASH_A, 0, new Options())).rejects.toThrow(notOwn('options.includeMempool'))
    await expect(rpc.getTxOut(HASH_A, 0, {}, new CallOptions())).rejects.toThrow(notOwn('callOptions.timeoutMs'))
    class Private {
      readonly #mempool = false
      get includeMempool(): boolean {
        return this.#mempool
      }
    }
    await expect(rpc.getTxOut(HASH_A, 0, new Private())).rejects.toThrow(notOwn('options.includeMempool'))
    const hidden = Object.defineProperty({}, 'includeMempool', { value: false, enumerable: false })
    await expect(rpc.getTxOut(HASH_A, 0, hidden)).rejects.toThrow(notOwn('options.includeMempool'))
    const stopped = new AbortController()
    stopped.abort()
    class Aborted {
      get signal(): AbortSignal {
        return stopped.signal
      }
    }
    await expect(rpc.getTxOut(HASH_A, 0, {}, new Aborted())).rejects.toThrow(notOwn('callOptions.signal'))
    // One object as both is refused: each argument holds only its own keys.
    const both = { includeMempool: false, timeoutMs: 1000 }
    await expect(rpc.getTxOut(HASH_A, 0, both as never, both as never)).rejects.toThrow(
      /^options\.timeoutMs is a call option/
    )
    expect(node.requests).toHaveLength(sent)
    // The getters' values, copied into plain objects, are read as meant.
    const copied = { includeMempool: new Options().includeMempool }
    expect(await rpc.getTxOut(HASH_A, 0, copied, { timeoutMs: new CallOptions().timeoutMs })).toBeNull()
    expect(node.calls().at(-1)!.params).toEqual([HASH_A, 0, false])
    const sentBefore = node.requests.length
    // A key on a polluted Object.prototype is no unknown option, for a builder
    // or the call options; the client then refuses the call before any
    // connection, as Node would read it too.
    const proto = Object.prototype as Record<string, unknown>
    proto['polluted'] = 1
    try {
      expect(requests.getTxOut(HASH_A, 0, { includeMempool: false }).params).toEqual([HASH_A, 0, false])
      for (const call of [
        () => rpc.getBlockCount(),
        () => rpc.getTxOut(HASH_A, 0, { includeMempool: false }, { timeoutMs: 1000 }),
        () => rpc.batch([requests.getBlockCount()]),
      ]) {
        await expect(call()).rejects.toMatchObject({ name: 'RpcTransportError', reason: 'prototype_polluted' })
      }
    } finally {
      delete proto['polluted']
    }
    expect(node.requests).toHaveLength(sentBefore)
    expect(await rpc.getBlockCount()).toBe(7)
  })
})

describe('client options', () => {
  const base = { url: 'http://127.0.0.1:1/', auth: { username: 'u', password: 'p' }, expectedChain: 'regtest' } as const

  /** Runs `run` with `values` set on Object.prototype, enumerable as a pollution sets them, and removes them after. */
  function polluted<T>(values: Record<string, unknown>, run: () => T): T {
    const proto = Object.prototype as Record<string, unknown>
    for (const [key, value] of Object.entries(values)) proto[key] = value
    try {
      return run()
    } finally {
      for (const key of Object.keys(values)) delete proto[key]
    }
  }

  it('refuse a known option on a polluted Object.prototype, naming it, unless the caller sets it too', () => {
    const known: Record<string, unknown> = {
      wallet: 'w',
      tls: {},
      connect: () => {},
      expectedGenesisHash: '00',
      expectedSignetChallenge: '51',
      capabilities: ['broadcast', 'wallet-write'],
      extraMethods: { getchaintxstats: { capability: 'read', sideEffects: false } },
      timeoutMs: 1,
      maxResponseBytes: 1,
      readRetries: 10,
      retryDelayMs: 1,
      chainCheckMaxAgeMs: 1,
      maxConcurrentRequests: 1,
      directNode: true,
      allowUnsupportedNodeVersion: true,
    }
    for (const [key, value] of Object.entries(known)) {
      const create = (): QbitRpcClient => polluted({ [key]: value }, () => new QbitRpcClient({ ...base }))
      expect(create).toThrow(TypeError)
      expect(create).toThrow(new RegExp(`^options\\.${key} is not an own enumerable property .*pass a plain object$`))
    }
    // An option the caller left out, and required.
    const { auth: _auth, ...withoutAuth } = base
    expect(() =>
      polluted({ auth: { username: 'x', password: 'y' } }, () => new QbitRpcClient(withoutAuth as never))
    ).toThrow(/^options\.auth is not an own enumerable property/)
    // The caller's own value stands: the prototype's holds no sway over it.
    const own = polluted(
      { capabilities: ['broadcast'], url: 'http://127.0.0.2:1/', expectedChain: 'main' },
      () => new QbitRpcClient({ ...base, capabilities: [] })
    )
    expect(own.toJSON()).toMatchObject({ url: base.url, capabilities: [], expectedChain: 'regtest' })
    // Any other key there is not an option at all.
    expect(() => polluted({ polluted: 1 }, () => new QbitRpcClient({ ...base }))).not.toThrow()
    // A hole in capabilities is refused, not read as the prototype's entry at its index.
    expect(() =>
      polluted({ 0: 'broadcast' }, () => new QbitRpcClient({ ...base, capabilities: new Array(1) as never }))
    ).toThrow(/^capabilities\[0\] is a hole, not an own element: pass an array without holes$/)
  })

  it('refuse a hole in tls.pinSha256 or tls.ca rather than read Array.prototype', () => {
    const https = { ...base, url: 'https://node.test/' }
    const arrayProto = Array.prototype as unknown as Record<string, unknown>
    // A pin the caller never gave, which a read through the hole would accept.
    arrayProto['0'] = 'A'.repeat(43) + '='
    try {
      expect(() => new QbitRpcClient({ ...https, tls: { pinSha256: new Array(1) as never } })).toThrow(
        /^tls\.pinSha256\[0\] is a hole, not an own element: pass an array without holes$/
      )
      expect(() => new QbitRpcClient({ ...https, tls: { ca: new Array(1) as never } })).toThrow(
        /^tls\.ca\[0\] is a hole, not an own element: pass an array without holes$/
      )
    } finally {
      delete arrayProto['0']
    }
  })

  it('refuse a known auth or tls key on a polluted Object.prototype', () => {
    expect(() => polluted({ cookieFile: '/elsewhere/.cookie' }, () => new QbitRpcClient({ ...base }))).toThrow(
      /^auth\.cookieFile is not an own enumerable property/
    )
    expect(() =>
      polluted(
        { username: 'x', password: 'y' },
        () => new QbitRpcClient({ ...base, auth: { cookieFile: '/c/.cookie' } })
      )
    ).toThrow(/^auth\.username is not an own enumerable property/)
    const https = { ...base, url: 'https://node.test/' }
    for (const key of ['ca', 'cert', 'key', 'passphrase', 'servername', 'pinSha256']) {
      expect(() => polluted({ [key]: 'x' }, () => new QbitRpcClient({ ...https, tls: {} }))).toThrow(
        new RegExp(`^tls\\.${key} is not an own enumerable property`)
      )
    }
    expect(() => polluted({ rejectUnauthorized: false }, () => new QbitRpcClient({ ...https, tls: {} }))).toThrow(
      /tls.rejectUnauthorized is not an option/
    )
    // With no tls option, its keys are not read at all.
    expect(() => polluted({ ca: 'x' }, () => new QbitRpcClient({ ...https }))).not.toThrow()
  })

  /** `key`, holding `value`, in each way that is not an own enumerable property. */
  function notOwn(key: string, value: unknown): [string, object][] {
    class Getter {
      get [key](): unknown {
        return value
      }
    }
    return [
      ['inherited', Object.create({ [key]: value }) as object],
      ['a class getter', new Getter()],
      ['not enumerable', Object.defineProperty({}, key, { enumerable: false, value })],
      [
        'inherited from an object without a prototype',
        Object.create(Object.assign(Object.create(null) as object, { [key]: value })) as object,
      ],
      [
        'described as its own, but left out of the keys a Proxy lists',
        new Proxy({ [key]: value }, { ownKeys: target => Reflect.ownKeys(target).filter(name => name !== key) }),
      ],
      [
        'answered only by a Proxy’s get trap',
        new Proxy({} as Record<string, unknown>, {
          get: (target, name) => (name === key ? value : target[name as string]),
        }),
      ],
      [
        'hidden by every trap of a Proxy but get',
        new Proxy({ [key]: value } as Record<string, unknown>, {
          has: (target, name) => name !== key && name in target,
          ownKeys: target => Reflect.ownKeys(target).filter(name => name !== key),
          getOwnPropertyDescriptor: (target, name) =>
            name === key ? undefined : Reflect.getOwnPropertyDescriptor(target, name),
        }),
      ],
    ]
  }

  it.each([
    ['capabilities', ['broadcast']],
    ['tls', {}],
    ['connect', () => {}],
    ['timeoutMs', 1],
  ])('refuse %s given any way but as an own enumerable property', (key, value) => {
    const url = key === 'tls' || key === 'connect' ? 'https://node.test/' : base.url
    for (const [, holder] of notOwn(key, value)) {
      const options = Object.assign(holder, { ...base, url })
      expect(() => new QbitRpcClient(options)).toThrow(TypeError)
      expect(() => new QbitRpcClient(options)).toThrow(
        new RegExp(`^options\\.${key} is not an own enumerable property`)
      )
    }
  })

  it.each([
    ['pinSha256', 'A'.repeat(43) + '='],
    ['ca', 'x'],
    ['servername', 'other.test'],
    ['cert', 'x'],
    ['key', 'x'],
    ['passphrase', 'x'],
  ])('refuse tls.%s given any way but as an own enumerable property', (key, value) => {
    for (const [, tls] of notOwn(key, value)) {
      expect(() => new QbitRpcClient({ ...base, url: 'https://node.test/', tls: tls as never })).toThrow(
        new RegExp(`^tls\\.${key} is not an own enumerable property`)
      )
    }
  })

  it.each([
    ['username', 'u'],
    ['password', 'p'],
    ['cookieFile', '/c/.cookie'],
  ])('refuse auth.%s given any way but as an own enumerable property', (key, value) => {
    for (const [, auth] of notOwn(key, value)) {
      expect(() => new QbitRpcClient({ ...base, auth: auth as never })).toThrow(
        new RegExp(`^auth\\.${key} is not an own enumerable property`)
      )
    }
  })

  it('are the own enumerable properties, read once', () => {
    let reads = 0
    const counted = Object.defineProperty({ ...base }, 'capabilities', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? ['broadcast'] : ['unknown']
      },
    })
    expect(new QbitRpcClient(counted).toJSON()).toMatchObject({ capabilities: ['broadcast'] })
    expect(reads).toBe(1)
  })
})
