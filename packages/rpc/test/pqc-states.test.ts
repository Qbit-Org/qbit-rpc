import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { QbitRpcClient, type PqcKeyState } from '../src'
import { chainResults, FakeNode } from './helpers/fake-node'

// qbit Core v1.0.0's PQC signature budget (src/wallet/pqc_usage.{h,cpp},
// src/crypto/pqc.h): a key's state follows from its count alone, warning from
// 2^28 signatures, critical from 2^30 - 2^24, exhausted at the 2^30 limit.
// walletprocesspsbt adds a warning line when a signature moves a key into
// another state, or past another 2^24 (warning) or 2^20 (critical) signatures
// beyond the threshold. getaddressinfo reports the counts without warnings.
//
// The replies below are the ones a v1.0.0 regtest node gave, with the counter
// raised in the wallet file (see the smoke test), except the two-key ones in
// different states, built from AppendPQCUsage (src/wallet/rpc/util.cpp). The
// node writes the psbt and hex in full; they are shortened here.
const LIMIT = 2 ** 30
const WARNING_FROM = 2 ** 28
const CRITICAL_FROM = 2 ** 30 - 2 ** 24
const PUBKEY = 'f929027e01cce553b16b12a09859ca51916254892e73ef2d66f9d60dd2db76ef'
const OTHER_PUBKEY = 'a2f11b0a1e3f77ee4d443b7078107b4bb20aa11e9116ddf3f08cd0d140fd73f1'
const PSBT = 'cHNidP8='

type State = PqcKeyState['pqcLimitState']

function nodeKey(pubkey: string, count: number, state: State): Record<string, unknown> {
  return {
    pubkey,
    pqc_signature_count: count,
    pqc_signature_limit: LIMIT,
    pqc_signatures_remaining: LIMIT - count,
    pqc_limit_state: state,
  }
}

/** The fields AppendPQCUsage writes for one key. */
function oneKey(count: number, state: State, pubkey = PUBKEY): Record<string, unknown> {
  return {
    pqc_key_states: [nodeKey(pubkey, count, state)],
    pqc_overall_limit_state: state,
    pqc_signature_count: count,
    pqc_signature_limit: LIMIT,
    pqc_signatures_remaining: LIMIT - count,
    pqc_limit_state: state,
  }
}

function typedKey(pubkey: string, count: number, state: State): PqcKeyState {
  return {
    pubkey,
    pqcSignatureCount: count,
    pqcSignatureLimit: LIMIT,
    pqcSignaturesRemaining: LIMIT - count,
    pqcLimitState: state,
  }
}

function typedOneKey(count: number, state: State, pubkey = PUBKEY) {
  return {
    pqcKeyStates: [typedKey(pubkey, count, state)],
    pqcOverallLimitState: state,
    pqcSignatureCount: count,
    pqcSignatureLimit: LIMIT,
    pqcSignaturesRemaining: LIMIT - count,
    pqcLimitState: state,
  }
}

const entered = (state: State, count: number) =>
  `PQC key ${PUBKEY} entered ${state} usage range (${count} of ${LIMIT} signatures used, ${LIMIT - count} remaining)`
const remains = (state: State, count: number) =>
  `PQC key ${PUBKEY} remains in ${state} usage range (${count} of ${LIMIT} signatures used, ${LIMIT - count} remaining)`
const reached = `PQC key ${PUBKEY} reached the signature limit (${LIMIT} of ${LIMIT} signatures used, 0 remaining). Rotate to a new key/address.`

let node: FakeNode
let rpc: QbitRpcClient

beforeEach(async () => {
  node = await FakeNode.start()
  rpc = new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-read', 'wallet-write'],
  })
  node.results(chainResults('regtest'))
  await rpc.confirmChain()
})
afterEach(async () => {
  await node.close()
})

async function processReply(reply: Record<string, unknown>) {
  node.results({ walletprocesspsbt: JSON.stringify(reply) })
  return rpc.walletProcessPsbt(PSBT, { pqcCheck: false })
}

describe('walletprocesspsbt in each PQC budget state', () => {
  // [the count after signing, its state, the warning lines]
  const signed: [string, number, State, string[] | undefined][] = [
    ['normal', 1, 'normal', undefined],
    ['the last normal signature', WARNING_FROM - 1, 'normal', undefined],
    ['the signature entering warning', WARNING_FROM, 'warning', [entered('warning', WARNING_FROM)]],
    ['a warning signature in the same reminder bucket', WARNING_FROM + 1, 'warning', undefined],
    [
      'a warning signature reaching the next 2^24',
      WARNING_FROM + 2 ** 24,
      'warning',
      [remains('warning', WARNING_FROM + 2 ** 24)],
    ],
    ['the last warning signature', CRITICAL_FROM - 1, 'warning', undefined],
    ['the signature entering critical', CRITICAL_FROM, 'critical', [entered('critical', CRITICAL_FROM)]],
    [
      'a critical signature reaching the next 2^20',
      CRITICAL_FROM + 2 ** 20,
      'critical',
      [remains('critical', CRITICAL_FROM + 2 ** 20)],
    ],
    ['the second-to-last signature', LIMIT - 1, 'critical', undefined],
  ]

  it.each(signed)('%s', async (_name, count, state, warnings) => {
    const reply = { psbt: PSBT, complete: true, hex: '00', ...oneKey(count, state), ...(warnings && { warnings }) }
    expect(await processReply(reply)).toEqual({
      psbt: PSBT,
      complete: true,
      hex: '00',
      ...typedOneKey(count, state),
      ...(warnings && { warnings }),
    })
  })

  it('the signature that uses the last of the budget: exhausted, with the rotate warning', async () => {
    // Two inputs of one key with one signature left: the first is signed, the
    // second is left unsigned, and the node answers without an error.
    const processed = await processReply({
      psbt: PSBT,
      complete: false,
      ...oneKey(LIMIT, 'exhausted'),
      warnings: [reached],
    })
    expect(processed).toEqual({
      psbt: PSBT,
      complete: false,
      ...typedOneKey(LIMIT, 'exhausted'),
      warnings: [reached],
    })
    expect(processed.pqcSignaturesRemaining).toBe(0)
  })

  it('a key already exhausted: no error, no signature, and no PQC fields at all', async () => {
    // The key cannot sign (FlatSigningProvider::CanSignPQC), so it takes no part
    // in the response: the PSBT comes back incomplete and nothing says why.
    expect(await processReply({ psbt: PSBT, complete: false })).toEqual({ psbt: PSBT, complete: false })
  })

  it('an exhausted key beside a normal one: only the key that signed is reported, as normal', async () => {
    const processed = await processReply({ psbt: PSBT, complete: false, ...oneKey(1, 'normal', OTHER_PUBKEY) })
    expect(processed).toEqual({ psbt: PSBT, complete: false, ...typedOneKey(1, 'normal', OTHER_PUBKEY) })
    expect(processed.pqcOverallLimitState).toBe('normal')
  })

  it('two keys: the overall state is the worst of them, and the single-key fields are absent', async () => {
    const processed = await processReply({
      psbt: PSBT,
      complete: true,
      hex: '00',
      pqc_key_states: [nodeKey(OTHER_PUBKEY, WARNING_FROM + 5, 'warning'), nodeKey(PUBKEY, CRITICAL_FROM, 'critical')],
      pqc_overall_limit_state: 'critical',
      warnings: [entered('critical', CRITICAL_FROM)],
    })
    expect(processed).toEqual({
      psbt: PSBT,
      complete: true,
      hex: '00',
      pqcKeyStates: [typedKey(OTHER_PUBKEY, WARNING_FROM + 5, 'warning'), typedKey(PUBKEY, CRITICAL_FROM, 'critical')],
      pqcOverallLimitState: 'critical',
      warnings: [entered('critical', CRITICAL_FROM)],
    })
    expect(processed).not.toHaveProperty('pqcLimitState')
  })

  it('passes a state qbit Core does not name through, and refuses an empty one', async () => {
    node.results({
      walletprocesspsbt: JSON.stringify({ psbt: PSBT, complete: false, ...oneKey(LIMIT, 'depleted') }),
    })
    expect(await rpc.walletProcessPsbt(PSBT, { pqcCheck: false })).toMatchObject(typedOneKey(LIMIT, 'depleted'))
    node.results({
      walletprocesspsbt: JSON.stringify({ psbt: PSBT, complete: false, ...oneKey(LIMIT, '') }),
    })
    const error = await rpc.walletProcessPsbt(PSBT, { pqcCheck: false }).catch((e: unknown) => e)
    expect((error as Error).cause).toMatchObject({
      reason: 'validation',
      path: 'result.pqc_key_states[0].pqc_limit_state',
    })
  })
})

describe('getaddressinfo in each PQC budget state', () => {
  const ADDRESS = 'qbrt1zy4lcyrvkrz6xaqe8ra9wlkwc0ven0yla2zvzul608f4egqqmhflse3was7'
  const PROGRAM = '257f820d9618b46e83271f4aefd9d87b333793fd50982e7f4f3a6b94001bba7f'
  const info = (fields: Record<string, unknown>) => ({
    address: ADDRESS,
    scriptPubKey: `5220${PROGRAM}`,
    ismine: true,
    solvable: true,
    desc: `mr(pk(${PUBKEY}))#4mzdltxn`,
    iswatchonly: false,
    isscript: true,
    iswitness: true,
    witness_version: 2,
    witness_program: PROGRAM,
    ischange: false,
    labels: [''],
    ...fields,
  })

  // A count read back, and the state it is in: each threshold and the count before it.
  const counts: [number, State][] = [
    [0, 'normal'],
    [WARNING_FROM - 1, 'normal'],
    [WARNING_FROM, 'warning'],
    [CRITICAL_FROM - 1, 'warning'],
    [CRITICAL_FROM, 'critical'],
    [LIMIT - 1, 'critical'],
    [LIMIT, 'exhausted'],
  ]

  it.each(counts)('%i signatures: %s', async (count, state) => {
    node.results({ getaddressinfo: JSON.stringify(info(oneKey(count, state))) })
    const result = await rpc.getAddressInfo(ADDRESS)
    expect(result).toMatchObject(typedOneKey(count, state))
    expect(result.pqcSignaturesRemaining).toBe(LIMIT - count)
    expect(result).not.toHaveProperty('warnings')
  })

  it('an address without local PQC keys: no PQC fields', async () => {
    node.results({ getaddressinfo: JSON.stringify({ ...info({}), ismine: false }) })
    const result = await rpc.getAddressInfo(ADDRESS)
    expect(result).not.toHaveProperty('pqcKeyStates')
    expect(result).not.toHaveProperty('pqcOverallLimitState')
  })

  it('two keys in different states: the overall state is the worst, without single-key fields', async () => {
    node.results({
      getaddressinfo: JSON.stringify(
        info({
          pqc_key_states: [nodeKey(OTHER_PUBKEY, LIMIT, 'exhausted'), nodeKey(PUBKEY, 7, 'normal')],
          pqc_overall_limit_state: 'exhausted',
        })
      ),
    })
    const result = await rpc.getAddressInfo(ADDRESS)
    expect(result.pqcOverallLimitState).toBe('exhausted')
    expect(result.pqcKeyStates).toEqual([typedKey(OTHER_PUBKEY, LIMIT, 'exhausted'), typedKey(PUBKEY, 7, 'normal')])
    expect(result).not.toHaveProperty('pqcSignatureCount')
  })
})
