import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { QbitRpcClient, RpcResponseError, RpcUnknownOutcomeError } from '../src'
import { blockchainInfoJson, FakeNode, HASH_A, HASH_B, TX_HEX } from './helpers/fake-node'

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
  node.results({ getblockchaininfo: blockchainInfoJson('regtest') })
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
  it('getblockchaininfo maps every field and rejects an unknown chain', async () => {
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
    node.results({ getblockchaininfo: blockchainInfoJson('bitcoin') })
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
    expect(await rpc.getRawTransaction(HASH_A, { blockHash: HASH_B })).toBe(TX_HEX)
    expect(params()).toEqual([HASH_A, 0, HASH_B])
    await rpc.getRawTransaction(HASH_A)
    expect(params()).toEqual([HASH_A, 0])

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
    expect(await rpc.sendRawTransaction('00', { maxFeeRateBitsPerKvB: 0n, maxBurnAmountBits: 1n })).toBe(HASH_A)
    expect(node.requests.at(-1)!.body).toContain('"params":["00",0.00000000,0.00000001]')
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
    const processed = await rpc.walletProcessPsbt('cHNidP8=', { sighashType: 'ALL' })
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
    node.results({ walletprocesspsbt: '{"psbt":"cHNidP8=","complete":false,"pqc_limit_state":"depleted"}' })
    await invalidAfterSideEffect(rpc.walletProcessPsbt('cHNidP8='), 'result.pqc_limit_state')
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
    await invalidAfterSideEffect(rpc.walletProcessPsbt('cHNidP8='), 'result.hex')
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
    await invalidAfterSideEffect(rpc.walletProcessPsbt('cHNidP8='), 'result.psbt')
    await invalid(rpc.finalizePsbt('cHNidP8='), 'result.psbt')
  })
})
