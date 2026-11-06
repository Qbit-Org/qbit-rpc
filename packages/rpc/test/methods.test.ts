import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  QbitRpcClient,
  requests,
  RpcResponseError,
  RpcUnknownOutcomeError,
  type AddressType,
  type RpcRequest,
  type WalletCreateFundedPsbtArgs,
} from '../src'
import { blockchainInfoJson, chainResults, FakeNode, HASH_A, HASH_B, TX_HEX, TX_TXID } from './helpers/fake-node'

let node: FakeNode
let rpc: QbitRpcClient

beforeEach(async () => {
  node = await FakeNode.start()
  rpc = new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
  })
})
afterEach(async () => {
  await node.close()
})

async function confirm(): Promise<void> {
  node.results(chainResults('regtest'))
  await rpc.confirmChain()
}

function params(index = -1): unknown[] {
  const calls = node.calls()
  return calls.at(index)!.params
}

async function invalid(promise: Promise<unknown>, path: string): Promise<void> {
  const error = await promise.catch((e: unknown) => e)
  expect(RpcResponseError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason: 'validation', path })
}

/** A side-effecting call's invalid result: the node acted, so the outcome is unknown, caused by the validation error. */
async function invalidAfterSideEffect(promise: Promise<unknown>, path: string): Promise<void> {
  const error = await promise.catch((e: unknown) => e)
  expect(RpcUnknownOutcomeError.is(error)).toBe(true)
  const cause = (error as Error).cause
  expect(RpcResponseError.is(cause)).toBe(true)
  expect(cause).toMatchObject({ reason: 'validation', path })
}

const header = {
  hash: HASH_B,
  confirmations: 1,
  height: 1,
  version: 536870912,
  versionHex: '20000000',
  merkleroot: HASH_A,
  time: 1700000000,
  mediantime: 1700000000,
  nonce: 4294967295,
  bits: '207fffff',
  target: '7fffff0000000000000000000000000000000000000000000000000000000000',
  difficulty: 4.656542373906925e-10,
  chainwork: '0000000000000000000000000000000000000000000000000000000000000004',
  nTx: 1,
  previousblockhash: HASH_A,
}

describe('chain methods', () => {
  it('getblockchaininfo maps every field, and passes an unknown chain name through', async () => {
    node.results({ getblockchaininfo: blockchainInfoJson('regtest') })
    const info = await rpc.getBlockchainInfo()
    expect(info).toMatchObject({
      chain: 'regtest',
      blocks: 10,
      bestBlockHash: HASH_A,
      verificationProgress: 1,
      p2mrValidationWeight: { legacyPerSigop: 3730, v2PerSigop: 3683 },
      futureBlockTime: { nextBlockTimeHeadroomSeconds: 1599 },
      warnings: [],
    })
    expect(info).not.toHaveProperty('pruneHeight')
    // A chain a later qbit Core adds stays readable; the chain guard compares the name itself.
    node.results({ getblockchaininfo: blockchainInfoJson('bitcoin') })
    expect((await rpc.getBlockchainInfo()).chain).toBe('bitcoin')
    node.results({ getblockchaininfo: blockchainInfoJson('') })
    await invalid(rpc.getBlockchainInfo(), 'result.chain')
    node.results({ getblockchaininfo: blockchainInfoJson('main').replace('"blocks":10', '"blocks":10.5') })
    await invalid(rpc.getBlockchainInfo(), 'result.blocks')
    node.results({
      getblockchaininfo: blockchainInfoJson('main').replace('"verificationprogress":1', '"verificationprogress":1.5'),
    })
    await invalid(rpc.getBlockchainInfo(), 'result.verificationprogress')
    node.results({
      getblockchaininfo: blockchainInfoJson('main').replace('"warnings":[]', '"warnings":"legacy warning"'),
    })
    expect((await rpc.getBlockchainInfo()).warnings).toEqual(['legacy warning'])
  })

  it('getnetworkinfo converts fee rates to bits per kvB', async () => {
    node.results({
      getnetworkinfo: JSON.stringify({
        version: 10000,
        subversion: '/qbit:1.0.0/',
        protocolversion: 70016,
        localservices: '0000000000000c09',
        localservicesnames: ['NETWORK', 'WITNESS', 'NODE_ARCHIVE'],
        localrelay: true,
        timeoffset: -2,
        networkactive: true,
        connections: 8,
        connections_in: 0,
        connections_out: 8,
        networks: [{ name: 'ipv4', limited: false, reachable: true, proxy: '', proxy_randomize_credentials: false }],
        relayfee: 0,
        incrementalfee: 0,
        localaddresses: [],
        warnings: [],
      })
        .replace('"relayfee":0', '"relayfee":0.00000250')
        .replace('"incrementalfee":0', '"incrementalfee":0.00001000'),
    })
    const info = await rpc.getNetworkInfo()
    expect(info.relayFeeBitsPerKvB).toBe(250n)
    expect(info.incrementalFeeBitsPerKvB).toBe(1000n)
    expect(info.localServicesNames).toContain('NODE_ARCHIVE')
    expect(info.timeOffset).toBe(-2)
  })

  it('getblockhash and getbestblockhash require lowercase 64-hex hashes', async () => {
    node.results({ getblockhash: JSON.stringify(HASH_A), getbestblockhash: JSON.stringify(HASH_A.toUpperCase()) })
    expect(await rpc.getBlockHash(0)).toBe(HASH_A)
    expect(params()).toEqual([0])
    await invalid(rpc.getBestBlockHash(), 'result')
  })

  it('getblockheader checks the hash, version and genesis linkage', async () => {
    node.results({ getblockheader: JSON.stringify(header) })
    expect(await rpc.getBlockHeader(HASH_B.toUpperCase())).toMatchObject({
      height: 1,
      nonce: 4294967295,
      previousBlockHash: HASH_A,
    })
    expect(params()).toEqual([HASH_B, true])
    await invalid(rpc.getBlockHeader(HASH_A), 'result.hash')
    node.results({ getblockheader: JSON.stringify({ ...header, versionHex: '20000001' }) })
    await invalid(rpc.getBlockHeader(HASH_B), 'result.versionHex')
    node.results({ getblockheader: JSON.stringify({ ...header, height: 0 }) })
    await invalid(rpc.getBlockHeader(HASH_B), 'result.previousblockhash')
    node.results({ getblockheader: JSON.stringify({ ...header, nonce: 4294967296 }) })
    await invalid(rpc.getBlockHeader(HASH_B), 'result.nonce')
  })

  it('getrawtransaction returns hex, and the verbose form decodes with bits', async () => {
    node.results({ getrawtransaction: JSON.stringify(TX_HEX) })
    expect(await rpc.getRawTransaction(TX_TXID, { blockHash: HASH_B })).toBe(TX_HEX)
    expect(params()).toEqual([TX_TXID, 0, HASH_B])
    await rpc.getRawTransaction(TX_TXID)
    expect(params()).toEqual([TX_TXID, 0])

    const decoded = {
      txid: HASH_A,
      hash: HASH_B,
      version: 2,
      size: 100,
      vsize: 100,
      weight: 100,
      locktime: 0,
      vin: [
        { coinbase: '51', sequence: 4294967295 },
        { txid: HASH_B, vout: 1, scriptSig: { asm: '', hex: '' }, txinwitness: ['aa', 'bb'], sequence: 4294967293 },
      ],
      vout: [{ value: 0, n: 0, scriptPubKey: { asm: 'x', desc: 'raw(00)#x', hex: '00', type: 'nonstandard' } }],
      hex: TX_HEX,
      confirmations: 3,
    }
    node.results({ getrawtransaction: JSON.stringify(decoded).replace('"value":0', '"value":12.34567890') })
    const tx = await rpc.getRawTransactionVerbose(HASH_A)
    expect(params()).toEqual([HASH_A, 1])
    expect(tx.vout[0]!.valueBits).toBe(1_234_567_890n)
    expect(tx.vin[0]).toEqual({ coinbase: '51', sequence: 4294967295 })
    expect(tx.vin[1]).toMatchObject({ txid: HASH_B, vout: 1, txinwitness: ['aa', 'bb'] })
    node.results({ getrawtransaction: JSON.stringify({ ...decoded, vout: [{ ...decoded.vout[0], n: 1 }] }) })
    await invalid(rpc.getRawTransactionVerbose(HASH_A), 'result.vout[0].n')
  })

  it('getrawtransaction checks that the hex hashes to the requested txid', async () => {
    node.results({ getrawtransaction: JSON.stringify(TX_HEX) })
    expect(await rpc.getRawTransaction(TX_TXID.toUpperCase())).toBe(TX_HEX)
    // The same transaction with a witness: the txid leaves the witness out.
    const body = TX_HEX.slice(8, -8)
    const withWitness = `${TX_HEX.slice(0, 8)}0001${body}010101${TX_HEX.slice(-8)}`
    node.results({ getrawtransaction: JSON.stringify(withWitness) })
    expect(await rpc.getRawTransaction(TX_TXID)).toBe(withWitness)

    // A reply about another transaction.
    node.results({ getrawtransaction: JSON.stringify(TX_HEX) })
    await invalid(rpc.getRawTransaction(HASH_A), 'result')
    // Hex that is not a whole transaction: empty, too short, cut off, a trailing byte, no inputs.
    for (const bad of ['', '00', TX_HEX.slice(0, -2), `${TX_HEX}00`, `${TX_HEX.slice(0, 8)}00${TX_HEX.slice(10)}`]) {
      node.results({ getrawtransaction: JSON.stringify(bad) })
      await invalid(rpc.getRawTransaction(TX_TXID), 'result')
    }
  })

  it('getconfirmationtarget sends the value as integer bits and drops the float QBT echo', async () => {
    node.results({
      getconfirmationtarget: JSON.stringify({
        required_confirmations: 12,
        required_minutes: 12,
        equivalent_btc_confirmations: 6.2,
        permissionless_hashrate: 1.5e12,
        auxpow_hashrate: 0,
        total_observed_hashrate: 1.5e12,
        orphan_rate: 0.01,
        security_level: 'high',
        value_qbt: 1,
        model: {
          btc_target_confirmations: 6,
          block_time_seconds: 60,
          hashrate_source: 'fallback_merge_mining_pct',
          hashrate_window_blocks: 120,
          permissionless_blocks_in_window: 120,
          auxpow_blocks_in_window: 0,
          merge_mining_pct: 0,
          btc_hashrate: 6e20,
          orphan_rate_penalty: 1.02,
          security_per_confirmation: 0.5,
          cadence_merged_fraction: 0.5,
        },
      }),
    })
    const target = await rpc.getConfirmationTarget(100_000_000n, { securityLevel: 'high', mergeMiningPct: 0.01 })
    expect(params()).toEqual([100000000, 'high', 0.01])
    expect(target.requiredConfirmations).toBe(12)
    expect(target).not.toHaveProperty('valueQbt')
    expect(target.model.hashrateSource).toBe('fallback_merge_mining_pct')
    await expect(rpc.getConfirmationTarget(1n, { mergeMiningPct: 1.5 })).rejects.toThrow(RangeError)
    await expect(rpc.getConfirmationTarget(1n, { btcHashrate: 0 })).rejects.toThrow(RangeError)
    await expect(rpc.getConfirmationTarget(1n, { btcHashrate: Number.NaN })).rejects.toThrow(RangeError)
    await expect(rpc.getConfirmationTarget(1n, { securityLevel: 'extreme' as never })).rejects.toThrow(RangeError)
  })

  it('getblockcount returns the tip height and rejects anything but a non-negative integer', async () => {
    node.results({ getblockcount: '1010' })
    expect(await rpc.getBlockCount()).toBe(1010)
    expect(params()).toEqual([])
    for (const bad of ['-1', '10.5', '"10"', '1e3', 'null']) {
      node.results({ getblockcount: bad })
      await invalid(rpc.getBlockCount(), 'result')
    }
  })

  // As qbit Core v1.0.0 returns it on regtest.
  const mempoolEntry = {
    vsize: 3860,
    weight: 3860,
    time: 1793687308,
    height: 1010,
    descendantcount: 1,
    descendantsize: 3860,
    ancestorcount: 1,
    ancestorsize: 3860,
    wtxid: HASH_B,
    fees: { base: 0.00007722, modified: 0.00007722, ancestor: 0.00007722, descendant: 0.00007722 },
    depends: [],
    spentby: [HASH_A],
    'bip125-replaceable': true,
    unbroadcast: true,
  }

  it('getmempoolentry maps sizes, relatives and fees in bits', async () => {
    node.results({ getmempoolentry: JSON.stringify(mempoolEntry) })
    expect(await rpc.getMempoolEntry(HASH_A.toUpperCase())).toEqual({
      vsize: 3860,
      weight: 3860,
      time: 1793687308,
      height: 1010,
      descendantCount: 1,
      descendantSize: 3860,
      ancestorCount: 1,
      ancestorSize: 3860,
      wtxid: HASH_B,
      fees: { baseBits: 7722n, modifiedBits: 7722n, ancestorBits: 7722n, descendantBits: 7722n },
      depends: [],
      spentBy: [HASH_A],
      bip125Replaceable: true,
      unbroadcast: true,
    })
    expect(params()).toEqual([HASH_A])

    // Fee deltas can make the modified fees negative, never the base fee.
    const fees = (changes: Record<string, number>): string =>
      JSON.stringify({ ...mempoolEntry, fees: { ...mempoolEntry.fees, ...changes } })
    node.results({ getmempoolentry: fees({ modified: -0.00001 }) })
    expect((await rpc.getMempoolEntry(HASH_A)).fees.modifiedBits).toBe(-1000n)
    node.results({ getmempoolentry: fees({ base: -0.00001 }) })
    await invalid(rpc.getMempoolEntry(HASH_A), 'result.fees.base')
    node.results({ getmempoolentry: fees({ descendant: 0.000000001 }) })
    await invalid(rpc.getMempoolEntry(HASH_A), 'result.fees.descendant')

    const { 'bip125-replaceable': _deprecated, ...current } = mempoolEntry
    node.results({ getmempoolentry: JSON.stringify(current) })
    expect(await rpc.getMempoolEntry(HASH_A)).not.toHaveProperty('bip125Replaceable')
    const malformed: [Record<string, unknown>, string][] = [
      [{ ancestorcount: 0 }, 'result.ancestorcount'],
      [{ vsize: -1 }, 'result.vsize'],
      [{ wtxid: 'ab' }, 'result.wtxid'],
      [{ depends: ['not-a-txid'] }, 'result.depends[0]'],
      [{ spentby: null }, 'result.spentby'],
      [{ unbroadcast: 'yes' }, 'result.unbroadcast'],
      [{ fees: null }, 'result.fees'],
    ]
    for (const [change, path] of malformed) {
      node.results({ getmempoolentry: JSON.stringify({ ...mempoolEntry, ...change }) })
      await invalid(rpc.getMempoolEntry(HASH_A), path)
    }
    node.rpc(() => ({ error: { code: -5, message: 'Transaction not in mempool' } }))
    await expect(rpc.getMempoolEntry(HASH_A)).rejects.toMatchObject({ rpcCode: -5, method: 'getmempoolentry' })
    const sent = node.requests.length
    await expect(rpc.getMempoolEntry('zz')).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(sent)
  })

  // As qbit Core v1.0.0 returns it on regtest.
  const txOut = {
    bestblock: HASH_B,
    confirmations: 1003,
    value: 210,
    scriptPubKey: {
      asm: `2 ${'11'.repeat(32)}`,
      desc: `rawmr(${'11'.repeat(32)})#ta6x5d6k`,
      hex: `5220${'11'.repeat(32)}`,
      address: 'qbrt1zzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsqxjqt8',
      type: 'witness_v2_p2mr',
    },
    coinbase: true,
  }

  it('gettxout returns the output with its value in bits, or null when spent', async () => {
    node.results({ gettxout: JSON.stringify(txOut).replace('"value":210', '"value":210.00000000') })
    expect(await rpc.getTxOut(HASH_A.toUpperCase(), 0)).toEqual({
      bestBlock: HASH_B,
      confirmations: 1003,
      valueBits: 21_000_000_000n,
      scriptPubKey: txOut.scriptPubKey,
      coinbase: true,
    })
    expect(params()).toEqual([HASH_A, 0])
    await rpc.getTxOut(HASH_A, 7, { includeMempool: false })
    expect(params()).toEqual([HASH_A, 7, false])
    node.results({ gettxout: 'null' })
    expect(await rpc.getTxOut(HASH_A, 0, { includeMempool: true })).toBeNull()
    expect(params()).toEqual([HASH_A, 0, true])

    const malformed: [Record<string, unknown>, string][] = [
      [{ confirmations: 0 }, 'result.confirmations'], // a coinbase output is never in the mempool
      [{ confirmations: -1, coinbase: false }, 'result.confirmations'],
      [{ value: 0.000000001 }, 'result.value'],
      [{ value: -1 }, 'result.value'],
      [{ bestblock: HASH_B.toUpperCase() }, 'result.bestblock'],
      [{ scriptPubKey: { ...txOut.scriptPubKey, hex: 'zz' } }, 'result.scriptPubKey.hex'],
      [{ coinbase: 'no' }, 'result.coinbase'],
    ]
    for (const [change, path] of malformed) {
      node.results({ gettxout: JSON.stringify({ ...txOut, ...change }) })
      await invalid(rpc.getTxOut(HASH_A, 0), path)
    }
    node.results({ gettxout: JSON.stringify({ ...txOut, confirmations: 0, coinbase: false }) })
    expect(await rpc.getTxOut(HASH_A, 0)).toMatchObject({ confirmations: 0, coinbase: false })
    node.results({ gettxout: 'false' })
    await invalid(rpc.getTxOut(HASH_A, 0), 'result')

    // qbit Core reads vout as an unsigned 32-bit integer.
    node.results({ gettxout: 'null' })
    for (const vout of [2 ** 31, 2 ** 32 - 1]) {
      expect(await rpc.getTxOut(HASH_A, vout)).toBeNull()
      expect(params()).toEqual([HASH_A, vout])
    }
    const sent = node.requests.length
    await expect(rpc.getTxOut(HASH_A, -1)).rejects.toThrow(RangeError)
    await expect(rpc.getTxOut(HASH_A, 1.5)).rejects.toThrow(RangeError)
    await expect(rpc.getTxOut(HASH_A, 2 ** 32)).rejects.toThrow(/^vout must be an integer from 0 to 4294967295$/)
    await expect(rpc.getTxOut('zz', 0)).rejects.toThrow(TypeError)
    await expect(rpc.getTxOut(HASH_A, 0, { includeMempool: 'yes' as never })).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(sent)
  })

  it('estimatesmartfee returns bits per kvB or the node errors', async () => {
    node.results({ estimatesmartfee: '{"feerate":0.00001000,"blocks":2}' })
    expect(await rpc.estimateSmartFee(6, { mode: 'conservative' })).toEqual({ feeRateBitsPerKvB: 1000n, blocks: 2 })
    expect(params()).toEqual([6, 'conservative'])
    node.results({ estimatesmartfee: '{"errors":["Insufficient data or no feerate found"],"blocks":0}' })
    expect(await rpc.estimateSmartFee(1)).toEqual({ errors: ['Insufficient data or no feerate found'], blocks: 0 })
    await expect(rpc.estimateSmartFee(0)).rejects.toThrow(RangeError)
    await expect(rpc.estimateSmartFee(1009)).rejects.toThrow(RangeError)
  })
})

describe('util methods', () => {
  it('validateaddress distinguishes valid and invalid addresses', async () => {
    node.results({
      validateaddress: `{"isvalid":true,"address":"rq1a","scriptPubKey":"5220${'11'.repeat(32)}","isscript":true,"iswitness":true,"witness_version":2,"witness_program":"${'11'.repeat(32)}"}`,
    })
    expect(await rpc.validateAddress('rq1a')).toMatchObject({ isValid: true, witnessVersion: 2, isWitness: true })
    node.results({ validateaddress: '{"isvalid":false,"error_locations":[3],"error":"Invalid checksum"}' })
    expect(await rpc.validateAddress('rq1b')).toEqual({
      isValid: false,
      error: 'Invalid checksum',
      errorLocations: [3],
    })
  })

  it('verifydatapqchash sends the proof in qbit Core field names', async () => {
    node.results({
      verifydatapqchash: `{"valid":true,"address":"rq1a","message_hash":"${HASH_A}","datasig_hash":"${HASH_B}","pubkey":"${HASH_A}","proof_mode":"p2mr-pubkey","p2mr_merkle_root":"${HASH_B}"}`,
    })
    const proof = {
      address: 'rq1a',
      messageHash: HASH_A,
      signature: 'ab'.repeat(10),
      pubkey: HASH_A,
      leafScript: '20' + HASH_A + 'bc',
      controlBlock: 'c1',
      leafVersion: 192,
      proofMode: 'p2mr-pubkey',
    } as const
    expect(await rpc.verifyDataPqcHash(proof)).toMatchObject({ valid: true, datasigHash: HASH_B })
    expect(params()).toEqual([
      {
        address: 'rq1a',
        message_hash: HASH_A,
        signature: 'ab'.repeat(10),
        pubkey: HASH_A,
        leaf_script: '20' + HASH_A + 'bc',
        control_block: 'c1',
        leaf_version: 192,
        proof_mode: 'p2mr-pubkey',
      },
    ])
    await expect(rpc.verifyDataPqcHash({ ...proof, leafVersion: 256 })).rejects.toThrow(RangeError)
    await expect(rpc.verifyDataPqcHash({ ...proof, messageHash: 'ab' })).rejects.toThrow(TypeError)
  })
})

describe('broadcast methods', () => {
  it('testmempoolaccept checks one entry per transaction, in order', async () => {
    await confirm()
    node.results({
      testmempoolaccept: `[{"txid":"${HASH_A}","wtxid":"${HASH_A}","allowed":true,"vsize":61,"fees":{"base":0.00000061,"effective-feerate":0.00001000,"effective-includes":["${HASH_A}"]}}]`,
    })
    // The fixture's txid is not TX_HEX's txid, so the position check rejects it.
    await invalid(rpc.testMempoolAccept([TX_HEX]), 'result[0].txid')
    // A hex the client cannot parse is checked by count only.
    const accepted = await rpc.testMempoolAccept(['00'], { maxFeeRateBitsPerKvB: 10_000n })
    expect(accepted[0]).toMatchObject({
      allowed: true,
      vsize: 61,
      fees: { baseBits: 61n, effectiveFeeRateBitsPerKvB: 1000n },
    })
    expect(params()).toEqual([['00'], 0.0001])
    await expect(rpc.testMempoolAccept([])).rejects.toThrow(RangeError)
    await expect(rpc.testMempoolAccept(Array(26).fill('00'))).rejects.toThrow(RangeError)
    await expect(rpc.testMempoolAccept(['0'])).rejects.toThrow(TypeError)
    await expect(rpc.testMempoolAccept(['00'], { maxFeeRateBitsPerKvB: 100_000_000n })).rejects.toThrow(RangeError)
  })

  it('sendrawtransaction passes fee and burn caps as QBT decimals', async () => {
    await confirm()
    node.rpc(() => ({ result: JSON.stringify(HASH_A) }))
    expect(await rpc.sendRawTransaction('00', { maxFeeRateBitsPerKvB: 1n, maxBurnAmountBits: 0n })).toBe(HASH_A)
    expect(node.requests.at(-1)!.body).toContain('"params":["00",0.00000001,0.00000000]')
    expect(await rpc.sendRawTransaction('00', { maxBurnAmountBits: 1n })).toBe(HASH_A)
    expect(node.requests.at(-1)!.body).toContain('"params":["00",null,0.00000001]')
  })

  it('refuses a fee-rate cap of 0n, which qbit Core reads as no cap at all, and takes 1n to 99,999,999n', async () => {
    await confirm()
    node.rpc(call => ({ result: call.method === 'sendrawtransaction' ? JSON.stringify(HASH_A) : '[]' }))
    const builds: [string, (cap?: bigint) => RpcRequest<unknown>][] = [
      [
        'testMempoolAccept',
        cap => requests.testMempoolAccept(['00'], cap === undefined ? {} : { maxFeeRateBitsPerKvB: cap }),
      ],
      [
        'sendRawTransaction',
        cap => requests.sendRawTransaction('00', cap === undefined ? {} : { maxFeeRateBitsPerKvB: cap }),
      ],
    ]
    for (const [, build] of builds) {
      for (const cap of [0n, 100_000_000n]) {
        expect(() => build(cap)).toThrow(
          /^options\.maxFeeRateBitsPerKvB must be from 1 to 99999999 bits\/kvB: qbit Core reads 0 as no cap and refuses 1 QBT\/kvB or more$/
        )
      }
      expect(JSON.stringify(build(1n).params[1])).toBe('0.00000001')
      expect(JSON.stringify(build(99_999_999n).params[1])).toBe('0.99999999')
      // Left out, the node applies its own default cap, 0.10 QBT/kvB.
      expect(build().params).toHaveLength(1)
    }
    const sent = node.requests.length
    await expect(rpc.testMempoolAccept(['00'], { maxFeeRateBitsPerKvB: 0n })).rejects.toThrow(RangeError)
    await expect(rpc.sendRawTransaction('00', { maxFeeRateBitsPerKvB: 0n })).rejects.toThrow(RangeError)
    expect(node.requests).toHaveLength(sent)
  })
})

describe('argument ranges, as qbit Core v1.0.0 reads each', () => {
  const outputs = [{ address: 'rq1a', amountBits: 1n }]
  it.each<[string, (value: number) => RpcRequest<unknown>, string, number, number]>([
    // gettxout: getInt<uint32_t>.
    ['getTxOut vout', v => requests.getTxOut(HASH_A, v), 'vout', 0, 0xffff_ffff],
    // walletcreatefundedpsbt's inputs and lockunspent: getInt<int>, negative refused.
    [
      'walletCreateFundedPsbt input vout',
      v => requests.walletCreateFundedPsbt({ inputs: [{ txid: HASH_A, vout: v }], outputs }),
      'args.inputs[0].vout',
      0,
      0x7fff_ffff,
    ],
    ['lockUnspent vout', v => requests.lockUnspent([{ txid: HASH_A, vout: v }]), 'outputs[0].vout', 0, 0x7fff_ffff],
    ['unlockUnspent vout', v => requests.unlockUnspent([{ txid: HASH_A, vout: v }]), 'outputs[0].vout', 0, 0x7fff_ffff],
    // TX_MIN_STANDARD_VERSION to TX_MAX_STANDARD_VERSION.
    [
      'walletCreateFundedPsbt version',
      v => requests.walletCreateFundedPsbt({ outputs, version: v }),
      'args.version',
      1,
      3,
    ],
    // MIN_STANDARD_TX_NONWITNESS_SIZE times WITNESS_SCALE_FACTOR (1) to MAX_STANDARD_TX_WEIGHT.
    [
      'walletCreateFundedPsbt maxTxWeight',
      v => requests.walletCreateFundedPsbt({ outputs, options: { maxTxWeight: v } }),
      'args.options.maxTxWeight',
      65,
      400_000,
    ],
  ])('%s: sends its minimum and maximum, and refuses one beyond either', (_label, build, name, min, max) => {
    for (const value of [min, max]) expect(JSON.stringify(build(value).params)).toMatch(new RegExp(`\\b${value}\\b`))
    for (const value of [min - 1, max + 1]) {
      expect(() => build(value)).toThrow(RangeError)
      expect(() => build(value)).toThrow(`${name} must be an integer from ${min} to ${max}`)
    }
  })
})

describe('wallet methods', () => {
  it('getwalletinfo reports PQC key validation and scanning state', async () => {
    const info = {
      walletname: 'w',
      walletversion: 169900,
      format: 'sqlite',
      txcount: 3,
      keypoolsize: 1000,
      keypoolsize_hd_internal: 1000,
      unlocked_until: 0,
      paytxfee: 0,
      private_keys_enabled: true,
      avoid_reuse: false,
      scanning: false,
      descriptors: true,
      pqc_key_validation: {
        status: 'complete',
        progress: 1,
        plaintext_records: 2,
        pending_records: 0,
        validated_records: 2,
        failed_records: 0,
        signing_blocked: false,
        encryption_recommended: true,
      },
      external_signer: false,
      blank: false,
      birthtime: 1700000000,
      flags: ['descriptor_wallet'],
      lastprocessedblock: { hash: HASH_A, height: 10 },
    }
    node.results({ getwalletinfo: JSON.stringify(info).replace('"paytxfee":0', '"paytxfee":0.00000000') })
    expect(await rpc.getWalletInfo()).toMatchObject({
      walletName: 'w',
      payTxFeeBitsPerKvB: 0n,
      scanning: false,
      pqcKeyValidation: { status: 'complete', signingBlocked: false },
      lastProcessedBlock: { height: 10 },
    })
    node.results({
      getwalletinfo: JSON.stringify({ ...info, scanning: { duration: 5, progress: 0.25 } }).replace(
        '"paytxfee":0',
        '"paytxfee":0.00000000'
      ),
    })
    expect((await rpc.getWalletInfo()).scanning).toEqual({ duration: 5, progress: 0.25 })
    node.results({
      getwalletinfo: JSON.stringify({ ...info, scanning: true }).replace('"paytxfee":0', '"paytxfee":0.00000000'),
    })
    await invalid(rpc.getWalletInfo(), 'result.scanning')
  })

  it('listunspent sends filters positionally and reads ancestor fees as integer bits', async () => {
    node.results({
      listunspent: `[{"txid":"${HASH_A}","vout":1,"scriptPubKey":"00","amount":1.00000000,"confirmations":0,"ancestorcount":1,"ancestorsize":200,"ancestorfees":9007199254740993,"spendable":true,"solvable":true,"parent_descs":["p2mr(x)"],"safe":false}]`,
    })
    const [output] = await rpc.listUnspent({ minConf: 0, addresses: ['rq1a'], minimumAmountBits: 500_000n })
    expect(output).toMatchObject({ amountBits: 100_000_000n, ancestorFeesBits: 9007199254740993n, safe: false })
    expect(node.requests.at(-1)!.body).toContain('"params":[0,null,["rq1a"],null,{"minimumAmount":0.00500000}]')
    await rpc.listUnspent()
    expect(params()).toEqual([])
  })

  it('walletcreatefundedpsbt maps options to qbit Core names', async () => {
    await confirm()
    node.results({ walletcreatefundedpsbt: '{"psbt":"cHNidP8BAAoCAAAAAAAAAAAA","fee":0.00001000,"changepos":1}' })
    await rpc.walletCreateFundedPsbt({
      inputs: [{ txid: HASH_A, vout: 0, sequence: 4294967293 }],
      outputs: [{ address: 'rq1a', amountBits: 5n }, { data: 'cafe' }],
      locktime: 0,
      options: {
        addInputs: true,
        changeType: 'p2mr',
        lockUnspents: true,
        subtractFeeFromOutputs: [0],
        replaceable: true,
        confTarget: 6,
        estimateMode: 'economical',
      },
      version: 2,
    })
    expect(params()).toEqual([
      [{ txid: HASH_A, vout: 0, sequence: 4294967293 }],
      [{ rq1a: 5e-8 }, { data: 'cafe' }],
      0,
      {
        add_inputs: true,
        change_type: 'p2mr',
        lock_unspents: true,
        subtractFeeFromOutputs: [0],
        replaceable: true,
        conf_target: 6,
        estimate_mode: 'economical',
      },
      null,
      2,
    ])
    await expect(
      rpc.walletCreateFundedPsbt({
        outputs: [{ address: 'a', amountBits: 1n }],
        options: { feeRateBitsPerKvB: 1n, confTarget: 2 },
      })
    ).rejects.toThrow(TypeError)
    await expect(rpc.walletCreateFundedPsbt({ outputs: [] })).rejects.toThrow(TypeError)
  })

  it('walletprocesspsbt surfaces the PQC usage fields', async () => {
    await confirm()
    node.results({
      walletprocesspsbt: `{"psbt":"cHNidP8=","complete":true,"hex":"00","pqc_key_states":[{"pubkey":"${HASH_A}","pqc_signature_count":268435457,"pqc_signature_limit":1073741824,"pqc_signatures_remaining":805306367,"pqc_limit_state":"warning"}],"pqc_overall_limit_state":"warning","pqc_signature_count":268435457,"pqc_signature_limit":1073741824,"pqc_signatures_remaining":805306367,"pqc_limit_state":"warning","warnings":["PQC key ... crossed the warning threshold"]}`,
    })
    const processed = await rpc.walletProcessPsbt('cHNidP8=', { sighashType: 'ALL', pqcCheck: false })
    expect(params()).toEqual(['cHNidP8=', null, 'ALL'])
    expect(processed).toMatchObject({
      complete: true,
      hex: '00',
      pqcOverallLimitState: 'warning',
      pqcSignatureCount: 268435457,
      pqcSignaturesRemaining: 805306367,
      pqcLimitState: 'warning',
      pqcKeyStates: [{ pubkey: HASH_A, pqcSignatureLimit: 1073741824, pqcLimitState: 'warning' }],
    })
    node.results({ walletprocesspsbt: '{"psbt":"cHNidP8=","complete":false,"pqc_limit_state":3}' })
    await invalidAfterSideEffect(rpc.walletProcessPsbt('cHNidP8=', { pqcCheck: false }), 'result.pqc_limit_state')
    await expect(rpc.walletProcessPsbt('not base64!')).rejects.toThrow(TypeError)
  })

  it('finalizepsbt, walletpassphrase and walletlock', async () => {
    await confirm()
    node.results({ finalizepsbt: '{"hex":"00","complete":true}', walletpassphrase: 'null', walletlock: 'null' })
    expect(await rpc.finalizePsbt('cHNidP8=')).toEqual({ hex: '00', complete: true })
    await rpc.walletPassphrase('correct horse', 60)
    expect(params()).toEqual(['correct horse', 60])
    await rpc.walletLock()
    await expect(rpc.walletPassphrase('', 60)).rejects.toThrow(TypeError)
    await expect(rpc.walletPassphrase('x', -1)).rejects.toThrow(RangeError)
    node.results({ walletlock: 'true' })
    await invalidAfterSideEffect(rpc.walletLock(), 'result')
  })

  // A wallet-owned P2MR address, as qbit Core v1.0.0 reports it on regtest.
  const ADDRESS = 'qbrt1zhst9fr02wm72702a34cu3xp43w59ekrg6z4vm9e9u56edf3r5ncsaz6cs7'
  const keyState = {
    pubkey: HASH_A,
    pqc_signature_count: 0,
    pqc_signature_limit: 1073741824,
    pqc_signatures_remaining: 1073741824,
    pqc_limit_state: 'normal',
  }
  const addressInfo = {
    address: ADDRESS,
    scriptPubKey: `5220${'bc'.repeat(32)}`,
    ismine: true,
    solvable: true,
    desc: `mr(pk(${HASH_A}))#d67txqyn`,
    iswatchonly: false,
    isscript: true,
    iswitness: true,
    witness_version: 2,
    witness_program: 'bc'.repeat(32),
    ischange: false,
    labels: [''],
    pqc_key_states: [keyState],
    pqc_overall_limit_state: 'normal',
    pqc_signature_count: 0,
    pqc_signature_limit: 1073741824,
    pqc_signatures_remaining: 1073741824,
    pqc_limit_state: 'normal',
  }

  it('getaddressinfo surfaces the PQC signature budget of the address keys', async () => {
    node.results({ getaddressinfo: JSON.stringify(addressInfo) })
    expect(await rpc.getAddressInfo(ADDRESS)).toEqual({
      address: ADDRESS,
      scriptPubKey: `5220${'bc'.repeat(32)}`,
      isMine: true,
      solvable: true,
      desc: `mr(pk(${HASH_A}))#d67txqyn`,
      isScript: true,
      isChange: false,
      isWitness: true,
      witnessVersion: 2,
      witnessProgram: 'bc'.repeat(32),
      labels: [''],
      pqcKeyStates: [
        {
          pubkey: HASH_A,
          pqcSignatureCount: 0,
          pqcSignatureLimit: 1073741824,
          pqcSignaturesRemaining: 1073741824,
          pqcLimitState: 'normal',
        },
      ],
      pqcOverallLimitState: 'normal',
      pqcSignatureCount: 0,
      pqcSignatureLimit: 1073741824,
      pqcSignaturesRemaining: 1073741824,
      pqcLimitState: 'normal',
    })
    expect(params()).toEqual([ADDRESS])
    // The node answers an uppercase bech32 address in lowercase.
    expect((await rpc.getAddressInfo(ADDRESS.toUpperCase())).address).toBe(ADDRESS)
    expect(params()).toEqual([ADDRESS.toUpperCase()])

    // Two keys: the single-key fields are absent.
    const second = { ...keyState, pubkey: HASH_B, pqc_signature_count: 805306368, pqc_signatures_remaining: 268435456 }
    const {
      pqc_signature_count: _count,
      pqc_signature_limit: _limit,
      pqc_signatures_remaining: _remaining,
      pqc_limit_state: _state,
      ...twoKeys
    } = addressInfo
    node.results({
      getaddressinfo: JSON.stringify({
        ...twoKeys,
        pqc_key_states: [keyState, { ...second, pqc_limit_state: 'critical' }],
        pqc_overall_limit_state: 'critical',
      }),
    })
    const multi = await rpc.getAddressInfo(ADDRESS)
    expect(multi.pqcOverallLimitState).toBe('critical')
    expect(multi.pqcKeyStates?.[1]).toMatchObject({ pubkey: HASH_B, pqcSignaturesRemaining: 268435456 })
    expect(multi).not.toHaveProperty('pqcSignatureCount')

    // An address the wallet does not know: no descriptor, no PQC fields.
    const foreign = {
      address: ADDRESS,
      scriptPubKey: addressInfo.scriptPubKey,
      ismine: false,
      solvable: false,
      iswatchonly: false,
      isscript: true,
      iswitness: true,
      witness_version: 2,
      witness_program: addressInfo.witness_program,
      ischange: false,
      labels: [],
    }
    node.results({ getaddressinfo: JSON.stringify(foreign) })
    const unknown = await rpc.getAddressInfo(ADDRESS)
    expect(unknown).toMatchObject({ isMine: false, solvable: false, labels: [] })
    expect(Object.keys(unknown).some(key => key.startsWith('pqc') || key === 'desc')).toBe(false)
  })

  it('getaddressinfo ignores case in bech32 and bech32m addresses only', async () => {
    // Addresses a qbit Core v1.0.0 regtest node made: P2MR (witness v2), and
    // with -p2mronly=0 also witness v0, v1, base58 P2PKH and P2SH. It answers
    // an uppercase bech32 or bech32m address in lowercase, and refuses a
    // mixed-case one and a base58 one in another case (-5).
    const bech32 = [
      'qbrt1zxfk5jzjwfrq9tqc3rcs87876h8p0dtl34f4k45rqdc7xmvtgkqpsfnj4hq',
      'qbrt1qcht35a2q26h2shjzx82u7c5hjutv9lcn49y5p4',
      'qbrt1p83jx4ccw2whthzqgw5kdvly5zpnh2c5zpvak5fwl0eleydxnlenqnps8wc',
    ]
    for (const address of bech32) {
      node.results({ getaddressinfo: JSON.stringify({ ...addressInfo, address }) })
      expect((await rpc.getAddressInfo(address)).address).toBe(address)
      expect((await rpc.getAddressInfo(address.toUpperCase())).address).toBe(address)
      // Mixed case is not bech32, so the reply must match it exactly.
      const mixed = `${address.slice(0, 2).toUpperCase()}${address.slice(2)}`
      await invalid(rpc.getAddressInfo(mixed), 'result.address')
    }

    const swapCase = (text: string): string =>
      [...text].map(c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('')
    for (const address of ['qV5ux1vV8qkvCgfeECyjrqmDZdy9Qzp5L8', 'sMoGRagvb7Wm8JWtPaCJKkrWW33ZVkcSyR']) {
      node.results({ getaddressinfo: JSON.stringify({ ...addressInfo, address }) })
      expect((await rpc.getAddressInfo(address)).address).toBe(address)
      // Case is part of a base58 address: in another case it is another one.
      for (const other of [address.toLowerCase(), address.toUpperCase(), swapCase(address)]) {
        node.results({ getaddressinfo: JSON.stringify({ ...addressInfo, address: other }) })
        await invalid(rpc.getAddressInfo(address), 'result.address')
      }
    }
  })

  it('getaddressinfo rejects a reply about another address or with malformed PQC fields', async () => {
    const malformed: [Record<string, unknown>, string][] = [
      [{ address: 'qbrt1zother' }, 'result.address'],
      [{ ismine: 'true' }, 'result.ismine'],
      [{ ischange: undefined }, 'result.ischange'],
      [{ scriptPubKey: 'not hex' }, 'result.scriptPubKey'],
      [{ witness_version: 17 }, 'result.witness_version'],
      [{ labels: [1] }, 'result.labels[0]'],
      [{ pqc_key_states: [{ ...keyState, pqc_limit_state: '' }] }, 'result.pqc_key_states[0].pqc_limit_state'],
      [{ pqc_key_states: [{ ...keyState, pubkey: 'ab' }] }, 'result.pqc_key_states[0].pubkey'],
      [
        { pqc_key_states: [{ ...keyState, pqc_signatures_remaining: -1 }] },
        'result.pqc_key_states[0].pqc_signatures_remaining',
      ],
      [{ pqc_key_states: {} }, 'result.pqc_key_states'],
      [{ pqc_overall_limit_state: 3 }, 'result.pqc_overall_limit_state'],
      [{ pqc_signature_count: 4294967296 }, 'result.pqc_signature_count'],
    ]
    for (const [change, path] of malformed) {
      node.results({ getaddressinfo: JSON.stringify({ ...addressInfo, ...change }) })
      await invalid(rpc.getAddressInfo(ADDRESS), path)
    }
    node.rpc(() => ({ error: { code: -5, message: 'Invalid or unsupported Segwit (Bech32) or Base58 encoding.' } }))
    await expect(rpc.getAddressInfo('qb1zqqqs')).rejects.toMatchObject({ rpcCode: -5 })
    const sent = node.requests.length
    await expect(rpc.getAddressInfo('')).rejects.toThrow(TypeError)
    await expect(rpc.getAddressInfo(1 as never)).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(sent)
  })

  it('listlockunspent returns outpoints', async () => {
    node.results({ listlockunspent: `[{"txid":"${HASH_A}","vout":0},{"txid":"${HASH_B}","vout":4294967295}]` })
    expect(await rpc.listLockUnspent()).toEqual([
      { txid: HASH_A, vout: 0 },
      { txid: HASH_B, vout: 4294967295 },
    ])
    expect(params()).toEqual([])
    node.results({ listlockunspent: '[]' })
    expect(await rpc.listLockUnspent()).toEqual([])
    const malformed: [string, string][] = [
      [`[{"txid":"${HASH_A}","vout":-1}]`, 'result[0].vout'],
      [`[{"txid":"${HASH_A.toUpperCase()}","vout":0}]`, 'result[0].txid'],
      [`[{"txid":"${HASH_A}"}]`, 'result[0].vout'],
      ['{}', 'result'],
    ]
    for (const [reply, path] of malformed) {
      node.results({ listlockunspent: reply })
      await invalid(rpc.listLockUnspent(), path)
    }
  })

  it('getrawchangeaddress sends the address type and checks the address', async () => {
    await confirm()
    node.results({ getrawchangeaddress: JSON.stringify(ADDRESS) })
    expect(await rpc.getRawChangeAddress()).toBe(ADDRESS)
    expect(params()).toEqual([])
    expect(await rpc.getRawChangeAddress({ addressType: 'p2mr' })).toBe(ADDRESS)
    expect(params()).toEqual(['p2mr'])
    for (const bad of ['""', '"qbrt1z with space"', '5', 'null']) {
      node.results({ getrawchangeaddress: bad })
      await invalidAfterSideEffect(rpc.getRawChangeAddress(), 'result')
    }
    // A type the chain does not offer is the node's answer.
    node.rpc(() => ({ error: { code: -5, message: "change type 'bech32' is not available on this chain" } }))
    await expect(rpc.getRawChangeAddress({ addressType: 'bech32' })).rejects.toMatchObject({ rpcCode: -5 })
    const sent = node.requests.length
    // @ts-expect-error qbit Core v1.0.0 parses no such type.
    await expect(rpc.getRawChangeAddress({ addressType: 'bogus' })).rejects.toThrow(RangeError)
    // @ts-expect-error The names are lowercase.
    await expect(rpc.getRawChangeAddress({ addressType: 'P2MR' })).rejects.toThrow(RangeError)
    await expect(rpc.getRawChangeAddress({ addressType: '' as never })).rejects.toThrow(RangeError)
    await expect(rpc.getRawChangeAddress({ addressType: 2 as never })).rejects.toThrow(TypeError)
    expect(node.requests).toHaveLength(sent)
  })

  it('types addressType and changeType as the five types qbit Core v1.0.0 parses, and sends each as it is', async () => {
    await confirm()
    const types: AddressType[] = ['p2mr', 'bech32m', 'bech32', 'p2sh-segwit', 'legacy']
    node.results({
      getnewaddress: JSON.stringify(ADDRESS),
      getrawchangeaddress: JSON.stringify(ADDRESS),
      walletcreatefundedpsbt: JSON.stringify({ psbt: 'cHNidP8=', fee: 0.0001, changepos: -1 }),
    })
    for (const type of types) {
      await rpc.getNewAddress({ addressType: type })
      expect(params()).toEqual([null, type])
      await rpc.getRawChangeAddress({ addressType: type })
      expect(params()).toEqual([type])
      await rpc.walletCreateFundedPsbt({
        outputs: [{ address: ADDRESS, amountBits: 1000n }],
        options: { changeType: type },
      })
      expect(params()[3]).toEqual({ change_type: type })
    }
    const sent = node.requests.length
    // @ts-expect-error Not a type qbit Core v1.0.0 parses.
    await expect(rpc.getNewAddress({ addressType: 'p2tr' })).rejects.toThrow(
      /^options\.addressType must be one of p2mr, bech32m, bech32, p2sh-segwit, legacy$/
    )
    const outputs = [{ address: ADDRESS, amountBits: 1000n }]
    // @ts-expect-error Not a type qbit Core v1.0.0 parses.
    const p2tr: WalletCreateFundedPsbtArgs = { outputs, options: { changeType: 'p2tr' } }
    await expect(rpc.walletCreateFundedPsbt(p2tr)).rejects.toThrow(
      /^args\.options\.changeType must be one of p2mr, bech32m, bech32, p2sh-segwit, legacy$/
    )
    expect(node.requests).toHaveLength(sent)
  })

  it('lockunspent locks outpoints, with the persistent flag', async () => {
    await confirm()
    node.results({ lockunspent: 'true' })
    expect(await rpc.lockUnspent([{ txid: HASH_A.toUpperCase(), vout: 1 }])).toBeUndefined()
    expect(params()).toEqual([false, [{ txid: HASH_A, vout: 1 }]])
    await rpc.lockUnspent(
      [
        { txid: HASH_A, vout: 1 },
        { txid: HASH_B, vout: 0 },
      ],
      { persistent: true }
    )
    expect(params()).toEqual([
      false,
      [
        { txid: HASH_A, vout: 1 },
        { txid: HASH_B, vout: 0 },
      ],
      true,
    ])
    await rpc.lockUnspent([{ txid: HASH_A, vout: 1 }], { persistent: false }, { timeoutMs: 1000 })
    expect(params()).toEqual([false, [{ txid: HASH_A, vout: 1 }], false])
    // Only txid and vout go out, so listUnspent() entries can be passed; any other key is refused.
    const outpoint = Object.assign({ txid: HASH_A, vout: 1 }, { amountBits: 5n, safe: true })
    await rpc.lockUnspent([outpoint])
    expect(params()).toEqual([false, [{ txid: HASH_A, vout: 1 }]])
    await expect(rpc.lockUnspent([{ txid: HASH_A, vout: 1, index: 1 } as never])).rejects.toThrow(
      /outputs\[0\] has an unknown key \(not shown\); the known keys are txid, vout/
    )
    // qbit Core answers true or an error: anything else is not a lock.
    for (const bad of ['false', 'null', '"true"', '1']) {
      node.results({ lockunspent: bad })
      await invalidAfterSideEffect(rpc.lockUnspent([outpoint]), 'result')
    }
    node.rpc(() => ({ error: { code: -8, message: 'Invalid parameter, output already locked' } }))
    await expect(rpc.lockUnspent([outpoint])).rejects.toMatchObject({ rpcCode: -8, method: 'lockunspent' })

    const sent = node.requests.length
    const refused: [() => Promise<unknown>, typeof TypeError | typeof RangeError][] = [
      [() => rpc.lockUnspent([]), RangeError],
      [() => rpc.lockUnspent('all' as never), RangeError],
      // The old (unlock, outputs) order is refused, not read as outputs.
      [() => rpc.lockUnspent(false as never, [outpoint] as never), RangeError],
      [() => rpc.lockUnspent([{ txid: 'zz', vout: 0 }]), TypeError],
      [() => rpc.lockUnspent([{ txid: HASH_A, vout: -1 }]), RangeError],
      [() => rpc.lockUnspent([null as never]), TypeError],
      [() => rpc.lockUnspent([outpoint], { persistent: 'yes' as never }), TypeError],
      [() => rpc.lockUnspent([outpoint], { unlock: true } as never), TypeError],
    ]
    for (const [run, type] of refused) await expect(run()).rejects.toThrow(type)
    expect(node.requests).toHaveLength(sent)
  })

  it('unlockunspent unlocks outpoints, with no persistent flag', async () => {
    await confirm()
    node.results({ lockunspent: 'true' })
    const outpoint = Object.assign({ txid: HASH_A.toUpperCase(), vout: 1 }, { amountBits: 5n, safe: true })
    expect(await rpc.unlockUnspent([outpoint, { txid: HASH_B, vout: 0 }])).toBeUndefined()
    expect(params()).toEqual([
      true,
      [
        { txid: HASH_A, vout: 1 },
        { txid: HASH_B, vout: 0 },
      ],
    ])
    expect(requests.unlockUnspent([outpoint])).toMatchObject({
      method: 'lockunspent',
      params: [true, [{ txid: HASH_A, vout: 1 }]],
    })
    for (const bad of ['false', 'null']) {
      node.results({ lockunspent: bad })
      await invalidAfterSideEffect(rpc.unlockUnspent([outpoint]), 'result')
    }
    node.rpc(() => ({ error: { code: -8, message: 'Invalid parameter, expected locked output' } }))
    await expect(rpc.unlockUnspent([outpoint])).rejects.toMatchObject({ rpcCode: -8, method: 'lockunspent' })

    const sent = node.requests.length
    const refused: [() => Promise<unknown>, typeof TypeError | typeof RangeError, RegExp][] = [
      // An empty list unlocks nothing in qbit Core, and leaving it out unlocks everything: neither is sent.
      [() => rpc.unlockUnspent([]), RangeError, /^outputs must be a non-empty array of \{ txid, vout \}$/],
      [() => rpc.unlockUnspent(undefined as never), RangeError, /non-empty array/],
      [() => rpc.unlockUnspent([{ txid: HASH_A, vout: 2 ** 31 }]), RangeError, /from 0 to 2147483647/],
      // persistent only applies to locking.
      [() => rpc.unlockUnspent([outpoint], { persistent: true } as never), TypeError, /callOptions\.persistent/],
    ]
    for (const [run, type, message] of refused) {
      const error = await run().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(type)
      expect((error as Error).message).toMatch(message)
    }
    expect(node.requests).toHaveLength(sent)
  })

  it('gettransaction checks the txid and categories', async () => {
    const tx = {
      amount: 0,
      confirmations: 2,
      blockhash: HASH_B,
      blockheight: 9,
      blockindex: 1,
      blocktime: 1700000000,
      txid: HASH_A,
      wtxid: HASH_A,
      walletconflicts: [],
      mempoolconflicts: [],
      time: 1700000000,
      timereceived: 1700000000,
      'bip125-replaceable': 'no',
      details: [
        {
          address: 'rq1a',
          category: 'receive',
          amount: 0,
          label: '',
          vout: 0,
          abandoned: false,
          parent_descs: ['p2mr(x)'],
        },
      ],
      hex: '00',
      lastprocessedblock: { hash: HASH_B, height: 10 },
    }
    node.results({ gettransaction: JSON.stringify(tx) })
    expect(await rpc.getTransaction(HASH_A)).toMatchObject({
      amountBits: 0n,
      confirmations: 2,
      details: [{ category: 'receive' }],
    })
    expect(params()).toEqual([HASH_A])
    node.results({ gettransaction: JSON.stringify({ ...tx, txid: HASH_B }) })
    await invalid(rpc.getTransaction(HASH_A), 'result.txid')
    node.results({ gettransaction: JSON.stringify({ ...tx, details: [{ ...tx.details[0], category: 'gift' }] }) })
    await invalid(rpc.getTransaction(HASH_A), 'result.details[0].category')
  })
})

describe('hex and base64 results', () => {
  it.each(['zz', 'ABCD', 'abc', ' 00', '0x00'])('rejects %j as a raw transaction', async bad => {
    node.results({ getrawtransaction: JSON.stringify(bad) })
    await invalid(rpc.getRawTransaction(HASH_A), 'result')
  })

  it('rejects non-hex transaction fields in wallet and PSBT replies', async () => {
    await confirm()
    const tx = {
      amount: 0,
      confirmations: 1,
      txid: HASH_A,
      wtxid: HASH_A,
      walletconflicts: [],
      mempoolconflicts: [],
      time: 1,
      timereceived: 1,
      'bip125-replaceable': 'no',
      details: [],
      hex: 'not-hex',
      lastprocessedblock: { hash: HASH_A, height: 1 },
    }
    node.results({
      gettransaction: JSON.stringify(tx),
      finalizepsbt: '{"hex":"0G","complete":true}',
      walletprocesspsbt: '{"psbt":"cHNidP8=","complete":true,"hex":"ABC"}',
    })
    await invalid(rpc.getTransaction(HASH_A), 'result.hex')
    await invalid(rpc.finalizePsbt('cHNidP8='), 'result.hex')
    await invalidAfterSideEffect(rpc.walletProcessPsbt('cHNidP8=', { pqcCheck: false }), 'result.hex')
  })

  it.each(['not base64!', 'cHNidP8', 'cHNi=dP8', '', 'cHNidP8=='])('rejects %j as a PSBT', async bad => {
    await confirm()
    const psbt = JSON.stringify(bad)
    node.results({
      walletcreatefundedpsbt: `{"psbt":${psbt},"fee":0.00001000,"changepos":-1}`,
      walletprocesspsbt: `{"psbt":${psbt},"complete":false}`,
      finalizepsbt: `{"psbt":${psbt},"complete":false}`,
    })
    await invalidAfterSideEffect(
      rpc.walletCreateFundedPsbt({ outputs: [{ address: 'rq1a', amountBits: 1n }] }),
      'result.psbt'
    )
    await invalidAfterSideEffect(rpc.walletProcessPsbt('cHNidP8=', { pqcCheck: false }), 'result.psbt')
    await invalid(rpc.finalizePsbt('cHNidP8='), 'result.psbt')
  })
})

describe('number arguments', () => {
  it('send -0 as 0', async () => {
    // JSON.stringify writes -0 as 0, but a request's params are read before that too.
    expect(requests.getBlockHash(-0).params).toEqual([0])
    expect(requests.getTxOut(HASH_A, -0).params).toEqual([HASH_A, 0])
    expect(requests.listUnspent({ minConf: -0, maxConf: -0 }).params).toEqual([0, 0])
    expect(requests.walletPassphrase('p', -0).params).toEqual(['p', 0])
    expect(requests.getConfirmationTarget(1n, { mergeMiningPct: -0 }).params).toEqual([1n, null, 0])
    expect(() => requests.getConfirmationTarget(1n, { btcHashrate: -0 })).toThrow(RangeError)

    node.results({ getblockhash: JSON.stringify(HASH_A) })
    await rpc.getBlockHash(-0)
    expect(node.requests.at(-1)!.body).toContain('"params":[0]')
  })
})

describe('number results', () => {
  it('read an integer written -0 as 0', async () => {
    node.results({ getblockcount: '-0', listlockunspent: `[{"txid":"${HASH_A}","vout":-0}]` })
    expect(Object.is(await rpc.getBlockCount(), 0)).toBe(true)
    const [locked] = await rpc.listLockUnspent()
    expect(Object.is(locked!.vout, 0)).toBe(true)
  })
})
