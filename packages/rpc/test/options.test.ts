import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { QbitRpcClient, requests, type RpcRequest } from '../src'
import { withCallOptions } from '../src/methods'
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
    () => requests.lockUnspent(false, [{ txid: HASH_A, vout: 0 }], { persist: true } as never),
    /^options\.persist is not a known key; the known keys are persistent$/,
  ],
  [
    'lockUnspent outputs[]',
    () => requests.lockUnspent(false, [{ txid: HASH_A, vout: 0, n: 1 }] as never),
    /^outputs\[0\] has an unknown key \(not shown\); the known keys are txid, vout$/,
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
    expect(requests.lockUnspent(false, [unspent]).params[1]).toEqual([{ txid: HASH_A, vout: 1 }])
    expect(requests.walletCreateFundedPsbt({ inputs: [unspent], outputs: [OUTPUT] }).params[0]).toEqual([
      { txid: HASH_A, vout: 1 },
    ])
    // A decoded transaction input, and a listSinceBlock() or listTransactions() entry.
    const input = { txid: HASH_A, vout: 1, scriptSig: { asm: '', hex: '' }, txinwitness: ['00'], sequence: 0xffff_fffd }
    expect(requests.lockUnspent(false, [input]).params[1]).toEqual([{ txid: HASH_A, vout: 1 }])
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
    expect(requests.lockUnspent(false, [entry]).params[1]).toEqual([{ txid: HASH_A, vout: 1 }])
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

  it('keep the call-option mark through a nested build with the same object', () => {
    const o = { includeMempool: true, timeoutMs: 5 }
    const params = withCallOptions(o, () => {
      withCallOptions(o, () => requests.getTxOut(HASH_A, 0, o))
      return requests.getTxOut(HASH_A, 0, o).params
    })
    expect(params).toEqual([HASH_A, 0, true])
    expect(() => requests.getTxOut(HASH_A, 0, o)).toThrow(/options\.timeoutMs is not a known key/)
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

  it('read inherited keys, and refuse inherited unknown ones', () => {
    const defaults = Object.create({ minConf: 6 }) as { readonly minConf?: number }
    expect(requests.listUnspent(defaults).params).toEqual([6])
    const typo = Object.create({ minconf: 6 }) as never
    expect(() => requests.listUnspent(typo)).toThrow(/options\.minconf is not a known key: use options\.minConf/)
  })

  it('refuse, in call(), a walletcreatefundedpsbt option qbit Core accepts and then ignores', () => {
    const options = { subtract_fee_from_outputs: [0], fee_rate: 2.5 }
    expect(() => requests.raw('walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }], 0, options])).toThrow(
      /^walletcreatefundedpsbt option subtract_fee_from_outputs is accepted and then ignored by qbit Core v1\.0\.0: send subtractFeeFromOutputs, or use walletCreateFundedPsbt\(\)$/
    )
    // The spelling the node reads, and other methods, pass through untouched.
    const read = requests.raw('walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }], 0, { subtractFeeFromOutputs: [0] }])
    expect(read.params[3]).toEqual({ subtractFeeFromOutputs: [0] })
    expect(requests.raw('walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }]]).params).toHaveLength(2)
    expect(requests.raw('decodepsbt', ['cHNidP8=', { subtract_fee_from_outputs: [0] }]).params).toHaveLength(2)
    // An undefined value is never sent, so it is not refused.
    const cleared = { fee_rate: 2.5, subtract_fee_from_outputs: undefined }
    expect(requests.raw('walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }], 0, cleared]).params[3]).toBe(cleared)
    // What is checked is what JSON.stringify sends: toJSON() applies, and function values are left out.
    const disguised = { toJSON: () => ({ subtract_fee_from_outputs: [0] }) }
    expect(() => requests.raw('walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }], 0, disguised])).toThrow(
      /option subtract_fee_from_outputs is accepted and then ignored/
    )
    const dropped = { fee_rate: 2.5, subtract_fee_from_outputs: () => [0] }
    expect(requests.raw('walletcreatefundedpsbt', [[], [{ rq1a: '0.5' }], 0, dropped]).params[3]).toBe(dropped)
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
    // Options that carry the method's own keys and the call options.
    [
      'getTxOut',
      c => c.getTxOut(HASH_A, 0, { includeMempool: true, include_mempool: false } as never),
      /include_mempool/,
    ],
    ['listUnspent', c => c.listUnspent({ timeoutMs: 1000, minconf: 0 } as never), /use options\.minConf$/],
    [
      'sendRawTransaction',
      c => c.sendRawTransaction(TX_HEX, { signal: new AbortController().signal, maxfeerate: 1n } as never),
      /maxfeerate/,
    ],
    ['getRawChangeAddress', c => c.getRawChangeAddress({ address_type: 'p2mr' } as never), /addressType/],
    [
      'listSinceBlock',
      c => c.listSinceBlock({ timeoutMs: 1000, blockhash: HASH_A } as never),
      /use options\.blockHash$/,
    ],
    ['getNewAddress', c => c.getNewAddress({ signal: undefined, label_name: 'x' } as never), /label_name/],
    ['lockUnspent', c => c.lockUnspent(false, [{ txid: HASH_A, vout: 0 }], { persist: true } as never), /persist/],
    [
      'psbtBumpFee',
      c => c.psbtBumpFee(HASH_A, { timeoutMs: 1000, conf_target: 6 } as never),
      /^options\.conf_target is not a known key: use options\.confTarget$/,
    ],
    [
      'psbtBumpFee (a call option misspelled)',
      c => c.psbtBumpFee(HASH_A, { timeout: 1000 } as never),
      /use options\.timeoutMs, in milliseconds$/,
    ],
    // Call options alone.
    [
      'getBlockCount',
      c => c.getBlockCount({ timeout: 1000 } as never),
      /^options\.timeout is not a known key: use options\.timeoutMs, in milliseconds$/,
    ],
    ['walletLock', c => c.walletLock({ signals: [] } as never), /signals/],
    ['call', c => c.call('getblockcount', [], { timeout_ms: 5 } as never), /use options\.timeoutMs$/],
    ['batch', c => c.batch([requests.getBlockCount()], { deadline: 5 } as never), /deadline/],
    ['an empty batch', c => c.batch([], { timeoutMS: 5 } as never), /use options\.timeoutMs$/],
    ['confirmChain', c => c.confirmChain({ timeoutMS: 5 } as never), /use options\.timeoutMs$/],
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

  it('still pass the call options through', async () => {
    node.results({ gettxout: 'null', getblockcount: '7' })
    expect(await rpc.getTxOut(HASH_A, 0, { includeMempool: false, timeoutMs: 1000 })).toBeNull()
    expect(node.calls().at(-1)!.params).toEqual([HASH_A, 0, false])
    const aborted = new AbortController()
    aborted.abort()
    await expect(rpc.getTxOut(HASH_A, 0, { signal: aborted.signal })).rejects.toMatchObject({ name: 'RpcAbortedError' })
    await expect(rpc.getBlockCount({ timeoutMs: 0 })).rejects.toThrow(RangeError)
    expect(await rpc.getBlockCount({ timeoutMs: 1000, signal: undefined } as never)).toBe(7)
    // A typed method's options may inherit their keys, call options included.
    const inherited = Object.create({ includeMempool: false, timeoutMs: 1000 }) as { readonly includeMempool?: boolean }
    expect(await rpc.getTxOut(HASH_A, 0, inherited)).toBeNull()
    expect(node.calls().at(-1)!.params).toEqual([HASH_A, 0, false])
    // And getters or non-enumerable keys, as the builders read them.
    class Options {
      get includeMempool(): boolean {
        return false
      }
      get timeoutMs(): number {
        return 1000
      }
    }
    expect(await rpc.getTxOut(HASH_A, 0, new Options())).toBeNull()
    expect(node.calls().at(-1)!.params).toEqual([HASH_A, 0, false])
    class Private {
      readonly #mempool = false
      get includeMempool(): boolean {
        return this.#mempool
      }
    }
    expect(await rpc.getTxOut(HASH_A, 0, new Private())).toBeNull()
    expect(node.calls().at(-1)!.params).toEqual([HASH_A, 0, false])
    // The builder alone still refuses the call options, and nested arguments never allow them.
    expect(() => requests.getTxOut(HASH_A, 0, { timeoutMs: 5 } as never)).toThrow(
      /options\.timeoutMs is not a known key/
    )
    const shared = { timeoutMs: 1000 }
    await expect(rpc.lockUnspent(false, [shared as never], shared)).rejects.toThrow(
      /outputs\[0\] has an unknown key \(not shown\); the known keys are txid, vout/
    )
    // A typo of a call option on a typed method is hinted too.
    await expect(rpc.getTxOut(HASH_A, 0, { timeout: 5 } as never)).rejects.toThrow(
      /options\.timeout is not a known key: use options\.timeoutMs, in milliseconds/
    )
    const hidden = Object.defineProperty({}, 'includeMempool', { value: false, enumerable: false })
    expect(await rpc.getTxOut(HASH_A, 0, hidden)).toBeNull()
    expect(node.calls().at(-1)!.params).toEqual([HASH_A, 0, false])
    const sent = node.requests.length
    const stopped = new AbortController()
    stopped.abort()
    class Aborted {
      get signal(): AbortSignal {
        return stopped.signal
      }
    }
    await expect(rpc.getTxOut(HASH_A, 0, new Aborted())).rejects.toMatchObject({ name: 'RpcAbortedError' })
    expect(node.requests).toHaveLength(sent)
    // A polluted Object.prototype does not make every call throw.
    const proto = Object.prototype as Record<string, unknown>
    proto['polluted'] = 1
    try {
      expect(await rpc.getBlockCount()).toBe(7)
      expect(await rpc.getTxOut(HASH_A, 0, { includeMempool: false })).toBeNull()
      expect(await rpc.batch([requests.getBlockCount()])).toEqual([{ ok: true, value: 7 }])
    } finally {
      delete proto['polluted']
    }
  })
})
