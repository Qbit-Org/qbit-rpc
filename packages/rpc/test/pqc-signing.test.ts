import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PqcSigningError,
  QbitRpcClient,
  RpcAbortedError,
  RpcCapabilityError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcTimeoutError,
  RpcUnknownOutcomeError,
  type PqcLimitState,
  type QbitRpcClientOptions,
} from '../src'
import { chainResults, FakeNode, type RpcCall } from './helpers/fake-node'

// The PQC check before signing: decodepsbt for each input's address, one
// getaddressinfo batch for the PQC keys of each address, then the count. The
// replies follow qbit Core v1.0.0 (decodepsbt in src/rpc/rawtransaction.cpp,
// AppendPQCUsage in src/wallet/rpc/util.cpp); the PSBT itself is never read
// here, so a short one stands in for it.
const LIMIT = 2 ** 30
const CRITICAL_FROM = 2 ** 30 - 2 ** 24
const PSBT = 'cHNidP8='
const A = 'qbrt1zy4lcyrvkrz6xaqe8ra9wlkwc0ven0yla2zvzul608f4egqqmhflse3was7'
const B = 'qbrt1zst3uq7dclyhe3q93en60jn6v745gxecudfsa86fhxqm7hsrz244q6urs83'
const C = 'qbrt1z0lkwyxtzdcf0lj4m76jf7dd7n4f96jv0yl09dakfmaefp7nzt8xs4jdxp5'
const KEY_1 = 'f929027e01cce553b16b12a09859ca51916254892e73ef2d66f9d60dd2db76ef'
const KEY_2 = 'a2f11b0a1e3f77ee4d443b7078107b4bb20aa11e9116ddf3f08cd0d140fd73f1'
const KEY_3 = '0f7a14b1a7e4a2c3d6f1b6c5e4d3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b'
const PROCESSED = JSON.stringify({ psbt: PSBT, complete: true, hex: '00' })

type State = PqcLimitState

const txid = (index: number): string => index.toString(16).padStart(64, '0')
// Taken before a test fakes the timers: the fake node's delays stay real.
const realSetTimeout = setTimeout

function scriptPubKey(address: string | undefined): Record<string, unknown> {
  return {
    asm: '2 0000000000000000000000000000000000000000000000000000000000000000',
    desc: 'rawtr(...)#00000000',
    hex: `5220${'00'.repeat(32)}`,
    ...(address === undefined ? {} : { address }),
    type: 'witness_v2_p2mr',
  }
}

/** How an input names the output it spends, as decodepsbt prints it. */
type Utxo =
  { readonly witness: string | undefined } | { readonly full: string | undefined; readonly witness?: string } | 'none'

/** A decodepsbt reply for inputs spending from these addresses (or naming them as `Utxo` says), output 1 of txid(i + 1) each. */
function decoded(inputs: readonly (string | Utxo)[]): Record<string, unknown> {
  const utxos = inputs.map((input): Utxo =>
    typeof input === 'string' && input !== 'none' ? { witness: input } : input
  )
  return {
    tx: {
      txid: txid(0xee),
      hash: txid(0xee),
      version: 2,
      size: 94,
      vsize: 94,
      weight: 376,
      locktime: 0,
      vin: utxos.map((_, i) => ({
        txid: txid(i + 1),
        vout: 1,
        scriptSig: { asm: '', hex: '' },
        sequence: 4294967293,
      })),
      vout: [],
    },
    global_xpubs: [],
    psbt_version: 0,
    proprietary: [],
    unknown: {},
    inputs: utxos.map((utxo, i) => {
      if (utxo === 'none') return {}
      const entry: Record<string, unknown> = {}
      if ('full' in utxo) {
        entry['non_witness_utxo'] = {
          txid: txid(i + 1),
          hash: txid(i + 1),
          version: 2,
          size: 1,
          vsize: 1,
          weight: 4,
          locktime: 0,
          vin: [],
          vout: [
            { value: 0.5, n: 0, scriptPubKey: scriptPubKey(C) },
            { value: 1, n: 1, scriptPubKey: scriptPubKey(utxo.full) },
          ],
        }
      }
      if ('witness' in utxo && (utxo.witness !== undefined || !('full' in utxo))) {
        entry['witness_utxo'] = { amount: 1, scriptPubKey: scriptPubKey(utxo.witness) }
      }
      return entry
    }),
    outputs: [],
    fee: 0.0001,
  }
}

function nodeKey(pubkey: string, count: number, state: State): Record<string, unknown> {
  return {
    pubkey,
    pqc_signature_count: count,
    pqc_signature_limit: LIMIT,
    pqc_signatures_remaining: LIMIT - count,
    pqc_limit_state: state,
  }
}

/** The PQC fields AppendPQCUsage writes for one key. */
function oneKey(count: number, state: State, pubkey = KEY_1): Record<string, unknown> {
  return {
    pqc_key_states: [nodeKey(pubkey, count, state)],
    pqc_overall_limit_state: state,
    pqc_signature_count: count,
    pqc_signature_limit: LIMIT,
    pqc_signatures_remaining: LIMIT - count,
    pqc_limit_state: state,
  }
}

/** The fields for several keys: no single-key fields, and the worst state overall. */
function keys(overall: State, ...list: Record<string, unknown>[]): Record<string, unknown> {
  return { pqc_key_states: list, pqc_overall_limit_state: overall }
}

function addressInfo(address: string, fields: Record<string, unknown>): string {
  return JSON.stringify({
    address,
    scriptPubKey: `5220${'00'.repeat(32)}`,
    ismine: true,
    solvable: true,
    isscript: true,
    iswitness: true,
    witness_version: 2,
    witness_program: '00'.repeat(32),
    ischange: false,
    labels: [''],
    ...fields,
  })
}

let node: FakeNode
let rpc: QbitRpcClient

function client(options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-read', 'wallet-write'],
    ...options,
  })
}

beforeEach(async () => {
  node = await FakeNode.start()
  rpc = client()
  node.results(chainResults('regtest'))
  await rpc.confirmChain()
  node.requests.length = 0
})
afterEach(async () => {
  await node.close()
})

/**
 * A node whose PSBT spends from `inputs`, each address's PQC fields in
 * `states` (or the reply itself, raw, or an error), signing with `processed`.
 */
function answer(
  inputs: readonly (string | Utxo)[] | { readonly raw: unknown },
  states: Record<string, Record<string, unknown> | { readonly raw: string } | 'error'>,
  processed = PROCESSED
): void {
  node.rpc((call: RpcCall) => {
    if (call.method === 'decodepsbt') {
      return { result: JSON.stringify('raw' in inputs ? inputs.raw : decoded(inputs)) }
    }
    if (call.method === 'getaddressinfo') {
      const address = call.params[0] as string
      const fields = states[address]!
      if (fields === 'error') return { error: { code: -5, message: 'Invalid address' } }
      return { result: 'raw' in fields ? (fields.raw as string) : addressInfo(address, fields) }
    }
    if (call.method === 'walletprocesspsbt') return { result: processed }
    return { error: { code: -32601, message: 'Method not found' } }
  })
}

/** The methods the node was sent, a batch as `[...]`. */
function sent(): string[] {
  return node.requests.map(request => {
    const parsed = JSON.parse(request.body) as RpcCall | RpcCall[]
    return Array.isArray(parsed) ? `[${parsed.map(call => call.method).join(',')}]` : parsed.method
  })
}

async function refusal(promise: Promise<unknown>): Promise<PqcSigningError> {
  const error = await promise.catch((e: unknown) => e)
  expect(PqcSigningError.is(error), String(error)).toBe(true)
  return error as PqcSigningError
}

describe('checkPqcSigning', () => {
  it('reads decodepsbt, then each address once in one batch, and counts one signature per input', async () => {
    answer([A, B, A], { [A]: oneKey(5, 'normal'), [B]: oneKey(9, 'warning', KEY_2) })
    const plan = await rpc.checkPqcSigning(PSBT)
    expect(plan).toEqual({
      keys: [
        { pubkey: KEY_1, addresses: [A], needed: 2, remaining: LIMIT - 5, state: 'normal' },
        { pubkey: KEY_2, addresses: [B], needed: 1, remaining: LIMIT - 9, state: 'warning' },
      ],
      state: 'warning',
      warnings: [],
    })
    expect(sent()).toEqual(['decodepsbt', '[getaddressinfo,getaddressinfo]'])
    expect(node.calls().map(call => call.params)).toEqual([[PSBT], [A], [B]])
    expect(Object.getPrototypeOf(plan)).toBeNull()
    expect(Object.getPrototypeOf(plan.keys[0])).toBeNull()
  })

  it('counts an address with several keys against each, and a key behind several addresses once per input', async () => {
    answer([A, A, B], {
      [A]: keys('normal', nodeKey(KEY_1, 1, 'normal'), nodeKey(KEY_2, 2, 'normal')),
      [B]: keys('normal', nodeKey(KEY_2, 2, 'normal'), nodeKey(KEY_3, 3, 'normal')),
    })
    expect((await rpc.checkPqcSigning(PSBT)).keys).toEqual([
      { pubkey: KEY_1, addresses: [A], needed: 2, remaining: LIMIT - 1, state: 'normal' },
      { pubkey: KEY_2, addresses: [A, B], needed: 3, remaining: LIMIT - 2, state: 'normal' },
      { pubkey: KEY_3, addresses: [B], needed: 1, remaining: LIMIT - 3, state: 'normal' },
    ])
  })

  it('takes the least left and the worst state when the node reports a key twice', async () => {
    answer([A, B], {
      [A]: keys('warning', nodeKey(KEY_1, CRITICAL_FROM - 1, 'warning'), nodeKey(KEY_1, CRITICAL_FROM - 1, 'warning')),
      [B]: oneKey(CRITICAL_FROM, 'critical'),
    })
    expect((await rpc.checkPqcSigning(PSBT)).keys).toEqual([
      { pubkey: KEY_1, addresses: [A, B], needed: 2, remaining: LIMIT - CRITICAL_FROM, state: 'critical' },
    ])
  })

  it('lets a critical key sign, with a warning to move its coins on', async () => {
    answer([A, B], { [A]: oneKey(5, 'normal'), [B]: oneKey(CRITICAL_FROM, 'critical', KEY_2) })
    const plan = await rpc.checkPqcSigning(PSBT)
    expect(plan.state).toBe('critical')
    expect(plan.warnings).toEqual([
      `PQC key ${KEY_2} is critical, with ${LIMIT - CRITICAL_FROM} signatures left and 1 for this PSBT: stop using its addresses, and spend their coins to a new address now`,
    ])
  })

  it('takes the worst of the overall states too', async () => {
    answer([A], { [A]: { ...oneKey(5, 'normal'), pqc_overall_limit_state: 'critical' } })
    expect(await rpc.checkPqcSigning(PSBT)).toMatchObject({ state: 'critical', warnings: [] })
  })

  it('lets inputs whose addresses hold no PQC key of the wallet through, counting nothing', async () => {
    answer([A, B], { [A]: { ismine: false, solvable: false }, [B]: {} })
    expect(await rpc.checkPqcSigning(PSBT)).toEqual({ keys: [], state: 'normal', warnings: [] })
  })

  it('reads an input by its non_witness_utxo, as the wallet signs, and by witness_utxo without one', async () => {
    // The witness_utxo names C, keyless; the full previous transaction's output 1 pays A.
    answer([{ full: A, witness: C }, { full: B }, { witness: A }], {
      [A]: oneKey(5, 'normal'),
      [B]: oneKey(5, 'normal', KEY_2),
    })
    expect((await rpc.checkPqcSigning(PSBT)).keys).toMatchObject([
      { pubkey: KEY_1, addresses: [A], needed: 2 },
      { pubkey: KEY_2, addresses: [B], needed: 1 },
    ])
    expect(
      node
        .calls()
        .slice(1)
        .map(call => call.params[0])
    ).toEqual([A, B])
  })

  it('passes a key with exactly the signatures it needs, and needs nothing to sign', async () => {
    answer([A, A], { [A]: oneKey(LIMIT - 2, 'critical') })
    expect((await rpc.checkPqcSigning(PSBT)).keys[0]).toMatchObject({ needed: 2, remaining: 2 })
    answer([], {})
    expect(await rpc.checkPqcSigning(PSBT)).toEqual({ keys: [], state: 'normal', warnings: [] })
    expect(sent().at(-1)).toBe('decodepsbt')
  })

  describe('refuses, with nothing signed', () => {
    it('an input that names no address, before reading any key', async () => {
      for (const input of ['none', { witness: undefined }, { full: undefined, witness: A }] as const) {
        answer([A, input], { [A]: oneKey(5, 'normal') })
        node.requests.length = 0
        const error = await refusal(rpc.checkPqcSigning(PSBT))
        expect(error).toMatchObject({ name: 'PqcSigningError', reason: 'no_address', inputIndex: 1 })
        expect(error.method).toBe('walletprocesspsbt')
        expect(error.message).toBe(
          'PQC signing refused, nothing signed: input 1 names no output with an address (witness_utxo or non_witness_utxo), so the PQC signatures it needs cannot be counted'
        )
        expect(sent()).toEqual(['decodepsbt'])
      }
    })

    it('a PQC state without its keys', async () => {
      for (const fields of [
        { pqc_overall_limit_state: 'normal' },
        { pqc_overall_limit_state: 'normal', pqc_key_states: [] },
        { pqc_limit_state: 'normal' },
        { pqc_signatures_remaining: 5 },
      ]) {
        answer([B, A], { [A]: fields, [B]: {} })
        const error = await refusal(rpc.checkPqcSigning(PSBT))
        expect(error).toMatchObject({ reason: 'no_keys', inputIndex: 1, address: A })
        expect(error.message).not.toContain(A)
      }
    })

    it('an exhausted key, or an address the node reports exhausted', async () => {
      answer([A, B], { [A]: oneKey(5, 'normal'), [B]: oneKey(LIMIT, 'exhausted', KEY_2) })
      const error = await refusal(rpc.checkPqcSigning(PSBT))
      expect(error).toMatchObject({ reason: 'exhausted', inputIndex: 1, address: B, pubkey: KEY_2, state: 'exhausted' })
      expect(error.message).toBe(
        `PQC signing refused, nothing signed: PQC key ${KEY_2} (input 1) is exhausted: it signs nothing more, and its inputs would stay unsigned; rotate to a new key`
      )
      // Beside a normal key, as the node reports two keys: the exhausted one refuses.
      answer([A], { [A]: keys('exhausted', nodeKey(KEY_1, 7, 'normal'), nodeKey(KEY_2, LIMIT, 'exhausted')) })
      expect(await refusal(rpc.checkPqcSigning(PSBT))).toMatchObject({ reason: 'exhausted', pubkey: KEY_2 })
      // An overall state that says more than the keys do.
      answer([A], { [A]: { ...oneKey(7, 'normal'), pqc_overall_limit_state: 'exhausted' } })
      const overall = await refusal(rpc.checkPqcSigning(PSBT))
      expect(overall).toMatchObject({ reason: 'exhausted', address: A, state: 'exhausted' })
      expect(overall.pubkey).toBeUndefined()
    })

    it('a state this version does not know, closed', async () => {
      answer([A], { [A]: oneKey(LIMIT, 'depleted') })
      const error = await refusal(rpc.checkPqcSigning(PSBT))
      expect(error).toMatchObject({ reason: 'unknown_state', pubkey: KEY_1, state: 'depleted', inputIndex: 0 })
      expect(error.message).toContain("is in PQC state 'depleted', which this version does not know")
      answer([A], { [A]: { ...oneKey(7, 'normal'), pqc_limit_state: 'x'.repeat(100) } })
      const long = await refusal(rpc.checkPqcSigning(PSBT))
      expect(long).toMatchObject({ reason: 'unknown_state', state: 'x'.repeat(100) })
      expect(long.pubkey).toBeUndefined()
      expect(long.message).toContain(`'${'x'.repeat(40)}...'`)
    })

    it('a key with fewer signatures left than the inputs it signs, with one key or several', async () => {
      answer([A, B, B, B], { [A]: oneKey(5, 'normal'), [B]: oneKey(LIMIT - 2, 'critical', KEY_2) })
      const error = await refusal(rpc.checkPqcSigning(PSBT))
      expect(error).toMatchObject({ reason: 'would_run_out', pubkey: KEY_2, needed: 3, remaining: 2 })
      expect(error.message).toBe(
        `PQC signing refused, nothing signed: PQC key ${KEY_2} has 2 signatures left and this PSBT needs 3: it would run out partway, leaving inputs unsigned`
      )
      answer([A, A], { [A]: keys('critical', nodeKey(KEY_1, 5, 'normal'), nodeKey(KEY_2, LIMIT - 1, 'critical')) })
      expect(await refusal(rpc.checkPqcSigning(PSBT))).toMatchObject({
        reason: 'would_run_out',
        pubkey: KEY_2,
        needed: 2,
        remaining: 1,
      })
      // One key behind two addresses: their inputs add up.
      answer([A, B], { [A]: oneKey(LIMIT - 1, 'critical'), [B]: oneKey(LIMIT - 1, 'critical') })
      expect(await refusal(rpc.checkPqcSigning(PSBT))).toMatchObject({ pubkey: KEY_1, needed: 2, remaining: 1 })
      // A count the state does not account for: none left is none left.
      answer([A], { [A]: { ...oneKey(LIMIT, 'normal') } })
      expect(await refusal(rpc.checkPqcSigning(PSBT))).toMatchObject({ reason: 'would_run_out', remaining: 0 })
    })

    it('address by address in input order, before counting', async () => {
      answer([A, B], { [A]: oneKey(LIMIT - 1, 'critical'), [B]: oneKey(LIMIT, 'exhausted', KEY_2) })
      // A's key alone would not run out; B's exhaustion is found first, as the count needs every address.
      expect(await refusal(rpc.checkPqcSigning(PSBT))).toMatchObject({ reason: 'exhausted', pubkey: KEY_2 })
      answer([A, A, B], { [A]: oneKey(LIMIT - 1, 'critical'), [B]: { pqc_overall_limit_state: 'normal' } })
      expect(await refusal(rpc.checkPqcSigning(PSBT))).toMatchObject({ reason: 'no_keys', address: B })
    })
  })

  describe('refuses a malformed node reply at the boundary', () => {
    async function invalid(promise: Promise<unknown>, method: string, path: string): Promise<void> {
      const error = await promise.catch((e: unknown) => e)
      expect(RpcResponseError.is(error), String(error)).toBe(true)
      expect(error).toMatchObject({ method, reason: 'validation', path })
    }

    it('from decodepsbt', async () => {
      const good = decoded([A, { full: B }])
      const tx = good['tx'] as Record<string, unknown>
      const inputs = good['inputs'] as Record<string, unknown>[]
      const full = inputs[1]!['non_witness_utxo'] as Record<string, unknown>
      const cases: [unknown, string][] = [
        [null, 'result'],
        [{ ...good, inputs: undefined }, 'result.inputs'],
        [{ inputs }, 'result.tx'],
        [{ ...good, inputs: [inputs[0]] }, 'result.inputs'],
        [{ ...good, inputs: [inputs[0], 'x'] }, 'result.inputs[1]'],
        [
          { ...good, tx: { ...tx, vin: [{ coinbase: '00', sequence: 0 }, (tx['vin'] as unknown[])[1]] } },
          'result.tx.vin[0]',
        ],
        [
          { ...good, tx: { ...tx, vin: [{ txid: txid(1), vout: -1, scriptSig: { asm: '', hex: '' }, sequence: 0 }] } },
          'result.tx.vin[0].vout',
        ],
        [
          { ...good, inputs: [{ witness_utxo: { amount: 1, scriptPubKey: { address: A } } }, inputs[1]] },
          'result.inputs[0].witness_utxo.scriptPubKey.asm',
        ],
        [
          { ...good, inputs: [{ witness_utxo: { amount: 1, scriptPubKey: scriptPubKey('') } }, inputs[1]] },
          'result.inputs[0].witness_utxo.scriptPubKey.address',
        ],
        [
          {
            ...good,
            inputs: [{ witness_utxo: { amount: 1, scriptPubKey: { ...scriptPubKey(A), address: 7 } } }, inputs[1]],
          },
          'result.inputs[0].witness_utxo.scriptPubKey.address',
        ],
        [
          { ...good, inputs: [inputs[0], { non_witness_utxo: { ...full, txid: txid(9) } }] },
          'result.inputs[1].non_witness_utxo.txid',
        ],
        [
          { ...good, inputs: [inputs[0], { non_witness_utxo: { ...full, vout: [(full['vout'] as unknown[])[0]] } }] },
          'result.inputs[1].non_witness_utxo.vout',
        ],
        [
          {
            ...good,
            inputs: [inputs[0], { non_witness_utxo: { ...full, vout: (full['vout'] as unknown[]).slice().reverse() } }],
          },
          'result.inputs[1].non_witness_utxo.vout',
        ],
        [{ ...good, inputs: [inputs[0], { non_witness_utxo: 'x' }] }, 'result.inputs[1].non_witness_utxo'],
      ]
      for (const [raw, path] of cases) {
        answer({ raw }, { [A]: oneKey(5, 'normal'), [B]: oneKey(5, 'normal') })
        await invalid(rpc.checkPqcSigning(PSBT), 'decodepsbt', path)
      }
    })

    it('from getaddressinfo, and its errors, as they are', async () => {
      const cases: [Record<string, unknown> | { readonly raw: string }, string][] = [
        [
          { pqc_key_states: [{ ...nodeKey(KEY_1, 5, 'normal'), pqc_signatures_remaining: -1 }] },
          'pqc_signatures_remaining',
        ],
        [
          { pqc_key_states: [{ ...nodeKey(KEY_1, 5, 'normal'), pqc_signatures_remaining: 1.5 }] },
          'pqc_signatures_remaining',
        ],
        [
          { pqc_key_states: [{ ...nodeKey(KEY_1, 5, 'normal'), pqc_signatures_remaining: 2 ** 32 }] },
          'pqc_signatures_remaining',
        ],
        [
          { pqc_key_states: [{ ...nodeKey(KEY_1, 5, 'normal'), pqc_signatures_remaining: undefined }] },
          'pqc_signatures_remaining',
        ],
        [{ pqc_key_states: [{ ...nodeKey(KEY_1, 5, 'normal'), pqc_limit_state: '' }] }, 'pqc_limit_state'],
        [{ pqc_key_states: [{ ...nodeKey(KEY_1, 5, 'normal'), pqc_limit_state: null }] }, 'pqc_limit_state'],
        [{ pqc_key_states: [{ ...nodeKey(KEY_1.toUpperCase(), 5, 'normal') }] }, 'pubkey'],
        [{ pqc_key_states: [{ ...nodeKey('ab', 5, 'normal') }] }, 'pubkey'],
      ]
      for (const [fields, key] of cases) {
        answer([A], { [A]: fields })
        await invalid(rpc.checkPqcSigning(PSBT), 'getaddressinfo', `result.pqc_key_states[0].${key}`)
      }
      answer([A], { [A]: { pqc_key_states: {} } })
      await invalid(rpc.checkPqcSigning(PSBT), 'getaddressinfo', 'result.pqc_key_states')
      answer([A], { [A]: { pqc_overall_limit_state: 7 } })
      await invalid(rpc.checkPqcSigning(PSBT), 'getaddressinfo', 'result.pqc_overall_limit_state')
      // A reply about another address.
      answer([A], { [A]: { raw: addressInfo(B, oneKey(5, 'normal')) } })
      await invalid(rpc.checkPqcSigning(PSBT), 'getaddressinfo', 'result.address')
      answer([A, B], { [A]: oneKey(5, 'normal'), [B]: 'error' })
      await expect(rpc.checkPqcSigning(PSBT)).rejects.toMatchObject({
        name: 'RpcError',
        rpcCode: -5,
        method: 'getaddressinfo',
      })
    })
  })

  it('refuses a PSBT that is not base64, and needs wallet-read, before sending anything', async () => {
    await expect(rpc.checkPqcSigning('not base64!')).rejects.toThrow(
      new TypeError('psbt must be non-empty padded base64')
    )
    await expect(rpc.checkPqcSigning(PSBT, { timeoutMs: 0 })).rejects.toThrow(RangeError)
    const writer = client({ capabilities: ['wallet-write'] })
    const error = await writer.checkPqcSigning(PSBT).catch((e: unknown) => e)
    expect(RpcCapabilityError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'getaddressinfo', reason: 'not_enabled', required: 'wallet-read' })
    expect(node.requests).toHaveLength(0)
  })

  it('reads more than a batch holds in several batches', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `qbrt1z${i.toString().padStart(56, '0')}`)
    node.rpc(call => {
      if (call.method === 'decodepsbt') return { result: JSON.stringify(decoded(many)) }
      const address = call.params[0] as string
      return { result: addressInfo(address, oneKey(5, 'normal', many.indexOf(address).toString(16).padStart(64, '0'))) }
    })
    const plan = await rpc.checkPqcSigning(PSBT)
    expect(plan.keys).toHaveLength(1001)
    expect(sent().map(method => method.split(',').length)).toEqual([1, 1000, 1])
  })
})

describe('walletProcessPsbt runs the check first', () => {
  it('then signs, under the same deadline', async () => {
    answer([A, A], { [A]: oneKey(5, 'normal') })
    expect(await rpc.walletProcessPsbt(PSBT, { sighashType: 'ALL' })).toEqual({ psbt: PSBT, complete: true, hex: '00' })
    expect(sent()).toEqual(['decodepsbt', '[getaddressinfo]', 'walletprocesspsbt'])
    expect(node.calls()[2]).toMatchObject({ method: 'walletprocesspsbt', params: [PSBT, null, 'ALL'] })
  })

  it('sends nothing to sign when the check refuses, or fails', async () => {
    answer([A, A], { [A]: oneKey(LIMIT - 1, 'critical') })
    expect(await refusal(rpc.walletProcessPsbt(PSBT))).toMatchObject({
      reason: 'would_run_out',
      remaining: 1,
      needed: 2,
    })
    answer([A], { [A]: oneKey(LIMIT, 'exhausted') })
    expect(await refusal(rpc.walletProcessPsbt(PSBT))).toMatchObject({ reason: 'exhausted' })
    answer([A, 'none'], { [A]: oneKey(5, 'normal') })
    expect(await refusal(rpc.walletProcessPsbt(PSBT))).toMatchObject({ reason: 'no_address' })
    answer([A], { [A]: 'error' })
    await expect(rpc.walletProcessPsbt(PSBT)).rejects.toSatisfy(
      (error: unknown) => RpcError.is(error) && error.method === 'getaddressinfo'
    )
    answer({ raw: {} }, {})
    await expect(rpc.walletProcessPsbt(PSBT)).rejects.toMatchObject({ name: 'RpcResponseError', method: 'decodepsbt' })
    expect(sent()).not.toContain('walletprocesspsbt')
  })

  it('lets a wallet without PQC keys straight through', async () => {
    answer([A, B], { [A]: {}, [B]: { ismine: false, solvable: false } })
    expect(await rpc.walletProcessPsbt(PSBT)).toMatchObject({ complete: true })
    expect(sent()).toEqual(['decodepsbt', '[getaddressinfo,getaddressinfo]', 'walletprocesspsbt'])
  })

  it('is skipped with pqcCheck: false, unsafe, and when it signs nothing', async () => {
    answer([A], { [A]: oneKey(LIMIT, 'exhausted') })
    expect(await rpc.walletProcessPsbt(PSBT, { pqcCheck: false })).toMatchObject({ complete: true })
    expect(await rpc.walletProcessPsbt(PSBT, { sign: false, finalize: false })).toMatchObject({ complete: true })
    expect(sent()).toEqual(['walletprocesspsbt', 'walletprocesspsbt'])
    // pqcCheck is the client's: never sent.
    expect(node.calls().map(call => call.params)).toEqual([[PSBT], [PSBT, false, null, null, false]])
    // pqcCheck: true is the default, as with it left out.
    await refusal(rpc.walletProcessPsbt(PSBT, { pqcCheck: true, sign: true }))
  })

  it('needs wallet-read, unless pqcCheck is false', async () => {
    const writer = client({ capabilities: ['wallet-write'] })
    node.results(chainResults('regtest'))
    await writer.confirmChain()
    node.requests.length = 0
    const error = await writer.walletProcessPsbt(PSBT).catch((e: unknown) => e)
    expect(RpcCapabilityError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'walletprocesspsbt', reason: 'not_enabled', required: 'wallet-read' })
    expect(node.requests).toHaveLength(0)
    answer([A], { [A]: oneKey(5, 'normal') })
    expect(await writer.walletProcessPsbt(PSBT, { pqcCheck: false })).toMatchObject({ complete: true })
    expect(await writer.walletProcessPsbt(PSBT, { sign: false })).toMatchObject({ complete: true })
  })

  it('refuses a call the guard or the capabilities refuse before the check reads anything', async () => {
    const unconfirmed = client()
    await expect(unconfirmed.walletProcessPsbt(PSBT)).rejects.toSatisfy(RpcChainGuardError.is)
    const reader = client({ capabilities: ['wallet-read'] })
    await expect(reader.walletProcessPsbt(PSBT)).rejects.toMatchObject({
      name: 'RpcCapabilityError',
      method: 'walletprocesspsbt',
      required: 'wallet-write',
    })
    expect(node.requests).toHaveLength(0)
  })

  it('checks its options, pqcCheck included, before sending anything', async () => {
    await expect(rpc.walletProcessPsbt(PSBT, { pqcCheck: 'no' } as never)).rejects.toThrow(
      new TypeError('options.pqcCheck must be a boolean')
    )
    await expect(rpc.walletProcessPsbt(PSBT, { pqc_check: false } as never)).rejects.toThrow(
      'options.pqc_check is not a known key: use options.pqcCheck'
    )
    await expect(rpc.walletProcessPsbt(PSBT, { timeoutMs: 5 } as never)).rejects.toThrow('is a call option')
    await expect(rpc.walletProcessPsbt(PSBT, { sign: 1 } as never)).rejects.toThrow('options.sign must be a boolean')
    await expect(rpc.walletProcessPsbt('not base64!')).rejects.toThrow(TypeError)
    await expect(rpc.walletProcessPsbt(PSBT, undefined, { timeoutMs: -1 })).rejects.toThrow(RangeError)
    expect(node.requests).toHaveLength(0)
  })
})

describe('one deadline over the check and the signing', () => {
  /** Answer as `answer` does, each request after its method's delay, a batch under `batch`. */
  function slow(delays: Record<string, number>): void {
    const reply = node.handler
    node.handler = (request, response) => {
      const parsed = JSON.parse(request.body) as RpcCall | RpcCall[]
      const ms = delays[Array.isArray(parsed) ? 'batch' : parsed.method] ?? 0
      realSetTimeout(() => void reply(request, response), ms)
    }
  }

  it('times the signing out at the deadline the check began, though each call alone would fit', async () => {
    answer([A], { [A]: oneKey(5, 'normal') })
    slow({ decodepsbt: 150, batch: 150, walletprocesspsbt: 150 })
    const started = performance.now()
    const error = await rpc.walletProcessPsbt(PSBT, undefined, { timeoutMs: 400 }).catch((e: unknown) => e)
    const elapsed = performance.now() - started
    expect(RpcUnknownOutcomeError.is(error), String(error)).toBe(true)
    expect((error as Error).cause).toMatchObject({ name: 'RpcTimeoutError', timeoutMs: 400 })
    // Each call alone fits in 400 ms; under one deadline the signing is cut off at 400 ms from the start.
    expect(elapsed).toBeGreaterThanOrEqual(390)
    expect(elapsed).toBeLessThan(600)
    expect(sent()).toEqual(['decodepsbt', '[getaddressinfo]', 'walletprocesspsbt'])
  })

  it('sends nothing to sign when the deadline passes during the check', async () => {
    answer([A], { [A]: oneKey(5, 'normal') })
    slow({ decodepsbt: 150, batch: 300 })
    const error = await rpc.walletProcessPsbt(PSBT, undefined, { timeoutMs: 400 }).catch((e: unknown) => e)
    expect(RpcTimeoutError.is(error), String(error)).toBe(true)
    expect(error).toMatchObject({ method: 'batch(1)', timeoutMs: 400 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(sent()).toEqual(['decodepsbt', '[getaddressinfo]'])
  })

  it('sends nothing to sign once the deadline has passed, though the check finished', async () => {
    answer([A], { [A]: oneKey(5, 'normal') })
    slow({ batch: 150 })
    // The client's timers held, so the batch's reply comes in past the deadline before its timer fires.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const error = await rpc.walletProcessPsbt(PSBT, undefined, { timeoutMs: 100 }).catch((e: unknown) => e)
      expect(error).toMatchObject({ name: 'RpcTimeoutError', method: 'walletprocesspsbt', timeoutMs: 100 })
    } finally {
      vi.useRealTimers()
    }
    expect(sent()).toEqual(['decodepsbt', '[getaddressinfo]'])
  })

  it('covers checkPqcSigning as one operation too', async () => {
    answer([A], { [A]: oneKey(5, 'normal') })
    slow({ decodepsbt: 150, batch: 150 })
    await expect(rpc.checkPqcSigning(PSBT, { timeoutMs: 250 })).rejects.toMatchObject({
      name: 'RpcTimeoutError',
      method: 'batch(1)',
      timeoutMs: 250,
    })
    // The client's own timeoutMs, without call options.
    const short = client({ timeoutMs: 250 })
    await expect(short.checkPqcSigning(PSBT)).rejects.toMatchObject({ name: 'RpcTimeoutError', timeoutMs: 250 })
  })

  it('stops at the caller’s abort, with nothing signed', async () => {
    answer([A], { [A]: oneKey(5, 'normal') })
    slow({ batch: 200 })
    const controller = new AbortController()
    setTimeout(() => controller.abort('stop'), 100)
    const error = await rpc.walletProcessPsbt(PSBT, undefined, { signal: controller.signal }).catch((e: unknown) => e)
    expect(RpcAbortedError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'batch(1)' })
    expect((error as Error).cause).toBe('stop')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(sent()).not.toContain('walletprocesspsbt')
    await expect(rpc.walletProcessPsbt(PSBT, undefined, { signal: controller.signal })).rejects.toSatisfy(
      RpcAbortedError.is
    )
  })
})

describe("the payout example's check before signing", () => {
  /** The example's lines, as written: returns what it warned and what it signed. */
  async function payout(funded: { psbt: string }): Promise<[string[], unknown]> {
    const warned: string[] = []
    const console = { warn: (line: string) => void warned.push(line) }
    // From here to the signing, as in docs/rpc/payments.md.
    const plan = await rpc.checkPqcSigning(funded.psbt) // PqcSigningError if a PQC key cannot sign each input it holds
    for (const warning of plan.warnings) console.warn(warning) // a critical key: move its coins on now
    const signed = await rpc.walletProcessPsbt(funded.psbt) // checks again first, by default
    return [warned, signed]
  }

  it('is the docs text, line for line', () => {
    const page = readFileSync(new URL('../../../docs/rpc/payments.md', import.meta.url), 'utf8')
    const source = readFileSync(new URL(import.meta.url), 'utf8').split('\n')
    const from = source.findIndex(line => line.includes('// From here to the signing')) + 1
    const to = source.findIndex((line, i) => i > from && line.trim() === 'return [warned, signed]')
    expect(from, 'the marker comment').toBeGreaterThan(0)
    expect(to, 'the end of the block').toBeGreaterThan(from)
    const block = source.slice(from, to).map(line => line.slice(4))
    expect(block).toHaveLength(3)
    expect(page).toContain(block.join('\n'))
  })

  it('warns of a critical key, signs, and refuses a key that would run out', async () => {
    answer([A, B], { [A]: oneKey(5, 'normal'), [B]: oneKey(CRITICAL_FROM, 'critical', KEY_2) })
    const [warned, signed] = await payout({ psbt: PSBT })
    expect(warned).toEqual([expect.stringContaining(`PQC key ${KEY_2} is critical`)])
    expect(signed).toMatchObject({ complete: true })
    answer([B, B], { [B]: oneKey(LIMIT - 1, 'critical', KEY_2) })
    node.requests.length = 0
    expect(await refusal(payout({ psbt: PSBT }))).toMatchObject({ reason: 'would_run_out' })
    expect(sent()).toEqual(['decodepsbt', '[getaddressinfo]'])
  })
})
