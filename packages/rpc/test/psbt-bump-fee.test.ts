import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  METHOD_POLICIES,
  QbitRpcClient,
  requests,
  RpcCapabilityError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcUnknownOutcomeError,
  type Capability,
  type QbitRpcClientOptions,
} from '../src'
import { chainResults, CHECK, FakeNode, HASH_A } from './helpers/fake-node'

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
})
afterEach(async () => {
  await node.close()
})

function client(
  capabilities: Capability[] = ['wallet-read', 'wallet-write'],
  options: Partial<QbitRpcClientOptions> = {}
): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities,
    ...options,
  })
}

async function confirmed(options: Partial<QbitRpcClientOptions> = {}): Promise<QbitRpcClient> {
  const rpc = client(['wallet-read', 'wallet-write'], options)
  node.results(chainResults('regtest'))
  await rpc.confirmChain()
  node.requests.length = 0
  return rpc
}

function params(): unknown[] {
  return node.calls().at(-1)!.params
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e
  )
}

/** The call is side-effecting: an invalid reply is an unknown outcome caused by the validation error. */
async function invalidAfterSideEffect(promise: Promise<unknown>, path: string): Promise<void> {
  const error = await failure(promise)
  expect(RpcUnknownOutcomeError.is(error)).toBe(true)
  const cause = (error as Error).cause
  expect(RpcResponseError.is(cause)).toBe(true)
  expect(cause).toMatchObject({ reason: 'validation', path })
}

const PSBT = 'cHNidP8BAAoCAAAAAAAAAAAA'
/** A qbit Core v1.0.0 regtest reply for a payment bumped from 1 to 4 bits/vB. */
const BUMPED = { psbt: PSBT, origfee: '#0.00003861', fee: '#0.00015444', errors: [] as unknown[] }
type Reply = { [K in keyof typeof BUMPED]?: unknown }
/** Amounts as JSON number literals, as the node prints them: '#0.00003861' is the bare number. */
const json = (reply: Reply): string => JSON.stringify(reply).replace(/"#([^"]*)"/g, '$1')

describe('psbtBumpFee', () => {
  it('sends the txid, and the options under the names qbit Core reads, leaving out the rest', async () => {
    const rpc = await confirmed()
    node.results({ psbtbumpfee: json(BUMPED) })
    expect(await rpc.psbtBumpFee(HASH_A)).toStrictEqual({
      psbt: PSBT,
      originalFeeBits: 3861n,
      feeBits: 15444n,
      errors: [],
    })
    expect(params()).toEqual([HASH_A])
    await rpc.psbtBumpFee(HASH_A.toUpperCase(), {})
    expect(params()).toEqual([HASH_A])
    await rpc.psbtBumpFee(HASH_A, { feeRateBitsPerKvB: 1250n, replaceable: false, timeoutMs: 5000 })
    expect(node.requests.at(-1)!.body).toContain(`"params":["${HASH_A}",{"fee_rate":1.250,"replaceable":false}]`)
    await rpc.psbtBumpFee(HASH_A, { confTarget: 6, estimateMode: 'economical', originalChangeIndex: 1 })
    expect(params()).toEqual([HASH_A, { conf_target: 6, estimate_mode: 'economical', original_change_index: 1 }])
    await rpc.psbtBumpFee(HASH_A, {
      outputs: [{ address: 'rq1a', amountBits: 5n }, { data: 'cafe' }],
      feeRateBitsPerKvB: 1n,
    })
    expect(node.requests.at(-1)!.body).toContain(
      `"params":["${HASH_A}",{"fee_rate":0.001,"outputs":[{"rq1a":0.00000005},{"data":"cafe"}]}]`
    )
    // Options set to undefined are left out, and the bounds the node accepts pass.
    await rpc.psbtBumpFee(HASH_A, {
      feeRateBitsPerKvB: undefined,
      confTarget: 1008,
      originalChangeIndex: 4294967295,
    } as never)
    expect(params()).toEqual([HASH_A, { conf_target: 1008, original_change_index: 4294967295 }])
    await rpc.psbtBumpFee(HASH_A, { confTarget: 1, estimateMode: 'unset', replaceable: true })
    expect(params()).toEqual([HASH_A, { conf_target: 1, estimate_mode: 'unset', replaceable: true }])
    expect(requests.psbtBumpFee(HASH_A, { estimateMode: 'conservative' }).params).toEqual([
      HASH_A,
      { estimate_mode: 'conservative' },
    ])
  })

  it('parses fees above 2^53 exactly and passes the errors through', async () => {
    const rpc = await confirmed()
    node.results({
      psbtbumpfee: json({ ...BUMPED, origfee: '#90071992.54740993', fee: '#90071992.54740994', errors: ['note'] }),
    })
    expect(await rpc.psbtBumpFee(HASH_A)).toMatchObject({
      originalFeeBits: 9007199254740993n,
      feeBits: 9007199254740994n,
      errors: ['note'],
    })
    // qbit Core can return a replacement that pays less than the original (outputs, no fee rate): reported as is.
    node.results({ psbtbumpfee: json({ ...BUMPED, origfee: '#0.00166140', fee: '#0.00135159' }) })
    expect(await rpc.psbtBumpFee(HASH_A)).toMatchObject({ originalFeeBits: 166140n, feeBits: 135159n })
  })

  it('rejects each malformed field, and a missing fee never reads as 0', async () => {
    const rpc = await confirmed()
    const { fee: _fee, ...noFee } = BUMPED
    const { origfee: _origfee, ...noOrigfee } = BUMPED
    const { psbt: _psbt, ...noPsbt } = BUMPED
    const { errors: _errors, ...noErrors } = BUMPED
    const malformed: [string, string][] = [
      [json(noFee), 'result.fee'],
      [json({ ...BUMPED, fee: null }), 'result.fee'],
      [json({ ...BUMPED, fee: '0.00015444' }), 'result.fee'],
      [json({ ...BUMPED, fee: '#-0.00015444' }), 'result.fee'],
      [json({ ...BUMPED, fee: '#0.000154441' }), 'result.fee'],
      [json({ ...BUMPED, fee: '#1e-4' }), 'result.fee'],
      [json({ ...BUMPED, fee: '#210000000.00000001' }), 'result.fee'],
      [json(noOrigfee), 'result.origfee'],
      [json({ ...BUMPED, origfee: '#-1' }), 'result.origfee'],
      [json({ ...BUMPED, origfee: true }), 'result.origfee'],
      [json(noPsbt), 'result.psbt'],
      [json({ ...BUMPED, psbt: '' }), 'result.psbt'],
      [json({ ...BUMPED, psbt: 'cHNidP8' }), 'result.psbt'],
      [json({ ...BUMPED, psbt: 7 }), 'result.psbt'],
      [json(noErrors), 'result.errors'],
      [json({ ...BUMPED, errors: 'none' }), 'result.errors'],
      [json({ ...BUMPED, errors: [1] }), 'result.errors[0]'],
      ['null', 'result'],
      [`[${json(BUMPED)}]`, 'result'],
      [JSON.stringify(PSBT), 'result'],
    ]
    for (const [reply, path] of malformed) {
      node.results({ psbtbumpfee: reply })
      await invalidAfterSideEffect(rpc.psbtBumpFee(HASH_A), path)
    }
  })

  it('checks every argument before sending anything', async () => {
    const rpc = await confirmed()
    const output = { address: 'rq1a', amountBits: 1n }
    const cases: [unknown, unknown, ErrorConstructor, RegExp?][] = [
      [undefined, undefined, TypeError, /^txid must be 64 hex characters$/],
      ['zz'.repeat(32), undefined, TypeError],
      [`${HASH_A}a`, undefined, TypeError],
      ['', undefined, TypeError],
      [5, undefined, TypeError],
      [HASH_A, 5, TypeError, /options must be an object/],
      [HASH_A, null, TypeError, /options must be an object/],
      [HASH_A, [], TypeError, /options must be an object/],
      [HASH_A, { feeRateBitsPerKvB: 1000 }, TypeError, /must be a bigint/],
      [HASH_A, { feeRateBitsPerKvB: '1000' }, TypeError],
      [HASH_A, { feeRateBitsPerKvB: Number.NaN }, TypeError],
      [HASH_A, { feeRateBitsPerKvB: Infinity }, TypeError],
      [HASH_A, { feeRateBitsPerKvB: null }, TypeError],
      [HASH_A, { feeRateBitsPerKvB: -1n }, RangeError],
      [HASH_A, { feeRateBitsPerKvB: 21_000_000_000_000_001n }, RangeError],
      [HASH_A, { feeRateBitsPerKvB: 0n }, RangeError, /^options\.feeRateBitsPerKvB must be above 0$/],
      [HASH_A, { confTarget: 0 }, RangeError, /^options\.confTarget must be an integer from 1 to 1008$/],
      [HASH_A, { confTarget: 1009 }, RangeError],
      [HASH_A, { confTarget: 1.5 }, RangeError],
      [HASH_A, { confTarget: Number.NaN }, RangeError],
      [HASH_A, { confTarget: Infinity }, RangeError],
      [HASH_A, { confTarget: '6' }, RangeError],
      [HASH_A, { estimateMode: 'foo' }, RangeError, /must be one of unset, economical, conservative/],
      [HASH_A, { estimateMode: 'ECONOMICAL' }, RangeError],
      [HASH_A, { estimateMode: 1 }, RangeError],
      [HASH_A, { replaceable: 'yes' }, TypeError, /^options\.replaceable must be a boolean$/],
      [HASH_A, { replaceable: null }, TypeError],
      [HASH_A, { outputs: [] }, TypeError, /^options\.outputs must be a non-empty array$/],
      [HASH_A, { outputs: {} }, TypeError],
      [HASH_A, { outputs: 'rq1a' }, TypeError],
      [HASH_A, { outputs: [null] }, TypeError, /^options\.outputs\[0\] must be an object$/],
      [HASH_A, { outputs: [{ address: '', amountBits: 1n }] }, TypeError],
      [HASH_A, { outputs: [{ address: 'rq1a' }] }, TypeError, /options\.outputs\[0\]\.amountBits must be a bigint/],
      [HASH_A, { outputs: [{ address: 'rq1a', amountBits: 1 }] }, TypeError],
      [HASH_A, { outputs: [output, { address: 'rq1b', amountBits: -1n }] }, RangeError, /options\.outputs\[1\]/],
      [HASH_A, { outputs: [{ data: 'zz' }] }, TypeError],
      [HASH_A, { outputs: [{ data: '' }] }, TypeError],
      [HASH_A, { outputs: [{ data: 'aa', address: 'rq1a' }] }, TypeError, /either \{ address, amountBits \} or/],
      [HASH_A, { originalChangeIndex: -1 }, RangeError, /from 0 to 4294967295$/],
      [HASH_A, { originalChangeIndex: 2 ** 32 }, RangeError],
      [HASH_A, { originalChangeIndex: 0.5 }, RangeError],
      [HASH_A, { originalChangeIndex: Number.NaN }, RangeError],
      [HASH_A, { originalChangeIndex: '0' }, RangeError],
      // Exclusive options, refused before the node sees them (it answers -8).
      [
        HASH_A,
        { feeRateBitsPerKvB: 1000n, confTarget: 2 },
        TypeError,
        /^options\.feeRateBitsPerKvB excludes options\.confTarget and options\.estimateMode$/,
      ],
      [HASH_A, { feeRateBitsPerKvB: 1000n, estimateMode: 'unset' }, TypeError, /excludes/],
      [
        HASH_A,
        { outputs: [output], originalChangeIndex: 0 },
        TypeError,
        /^options\.outputs excludes options\.originalChangeIndex$/,
      ],
    ]
    for (const [txid, options, type, message] of cases) {
      const error = await failure(rpc.psbtBumpFee(txid as never, options as never))
      expect(error).toBeInstanceOf(type)
      if (message !== undefined) expect((error as Error).message).toMatch(message)
      if (options !== null && !Array.isArray(options)) {
        expect(() => requests.psbtBumpFee(txid as never, options as never)).toThrow(type)
      }
    }
    expect(node.requests).toHaveLength(0)
  })

  it('reads each option once, so a getter cannot pass the exclusivity check and then send both', () => {
    let reads = 0
    const options = {
      feeRateBitsPerKvB: 2500n,
      // undefined on the first read, a value on any later one
      get confTarget() {
        return reads++ === 0 ? undefined : 6
      },
    }
    const built = requests.psbtBumpFee(HASH_A, options as never)
    expect(built.params[1]).toEqual({ fee_rate: expect.anything() })
    expect(reads).toBe(1)
  })

  it('passes node errors through as definite answers, sent once', async () => {
    const rpc = await confirmed({ readRetries: 3, retryDelayMs: 1 })
    for (const [code, message] of [
      [-5, 'Invalid or non-wallet transaction id'],
      [
        -8,
        'Insufficient total fee 0.00001931, must be at least 0.00004827 (oldFee 0.00003861 + incrementalFee 0.00000966)',
      ],
      [-8, 'Transaction has descendants in the wallet'],
      [-1, `${HASH_A}:1 is already spent`],
      [-4, 'Unable to create transaction. Insufficient funds'],
      [-13, 'Error: Please enter the wallet passphrase with walletpassphrase first.'],
    ] as const) {
      node.rpc(() => ({ error: { code, message } }))
      const before = node.requests.length
      const error = await failure(rpc.psbtBumpFee(HASH_A))
      expect(RpcError.is(error)).toBe(true)
      expect(error).toMatchObject({ rpcCode: code, message, method: 'psbtbumpfee' })
      expect(node.requests).toHaveLength(before + 1)
    }
  })

  it('treats a dropped reply as an unknown outcome and never retries it, even under readRetries', async () => {
    const rpc = await confirmed({ readRetries: 3, retryDelayMs: 1 })
    node.handler = (_request, response) => response.socket?.destroy()
    const error = await failure(rpc.psbtBumpFee(HASH_A, { feeRateBitsPerKvB: 4000n }))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'psbtbumpfee' })
    expect(node.requests).toHaveLength(1)
    // An HTTP 5xx is not retried either. (The dropped connection made the chain stale: confirm it again.)
    node.results(chainResults('regtest'))
    await rpc.confirmChain()
    node.requests.length = 0
    node.handler = (_request, response) => {
      response.statusCode = 503
      response.end()
    }
    expect(RpcUnknownOutcomeError.is(await failure(rpc.psbtBumpFee(HASH_A)))).toBe(true)
    expect(node.requests).toHaveLength(1)
  })

  it('uses a fresh connection for every call, while reads share a keep-alive socket', async () => {
    const rpc = await confirmed()
    node.results({ getwalletinfo: 'null', psbtbumpfee: json(BUMPED), listlockunspent: '[]' })
    await rpc.listLockUnspent()
    await rpc.listLockUnspent()
    await rpc.psbtBumpFee(HASH_A)
    await rpc.psbtBumpFee(HASH_A)
    const [read1, read2, bump1, bump2] = node.requests
    expect(read1!.remotePort).toBe(read2!.remotePort)
    expect(new Set([read1!.remotePort, bump1!.remotePort, bump2!.remotePort]).size).toBe(3)
    expect(bump1!.headers.connection).toBe('close')
  })

  it('needs wallet-write, a confirmed chain on the expected chain, and is not batchable', async () => {
    node.results({ ...chainResults('regtest'), psbtbumpfee: json(BUMPED) })
    const refusal = async (promise: Promise<unknown>): Promise<RpcCapabilityError> => {
      const error = await failure(promise)
      expect(RpcCapabilityError.is(error)).toBe(true)
      return error as RpcCapabilityError
    }
    for (const capabilities of [[], ['wallet-read'], ['wallet-read', 'broadcast']] as Capability[][]) {
      const rpc = client(capabilities)
      for (const promise of [rpc.psbtBumpFee(HASH_A), rpc.call('psbtbumpfee', [HASH_A])]) {
        expect(await refusal(promise)).toMatchObject({ reason: 'not_enabled', required: 'wallet-write' })
      }
    }
    expect(node.requests).toHaveLength(0)

    // Unconfirmed: refused with nothing sent, the chain check included.
    const writer = client(['wallet-write'])
    for (const promise of [writer.psbtBumpFee(HASH_A), writer.call('psbtbumpfee', [HASH_A])]) {
      const error = await failure(promise)
      expect(RpcChainGuardError.is(error)).toBe(true)
      expect(error).toMatchObject({ reason: 'unconfirmed', method: 'psbtbumpfee' })
    }
    expect(node.requests).toHaveLength(0)
    await writer.confirmChain()
    expect((await writer.psbtBumpFee(HASH_A)).feeBits).toBe(15444n)
    expect(node.calls().map(call => call.method)).toEqual([...CHECK, 'psbtbumpfee'])

    // Another chain: refused, and nothing but the chain check is sent.
    node.results({ ...chainResults('main'), psbtbumpfee: json(BUMPED) })
    const elsewhere = client(['wallet-write'])
    await expect(elsewhere.confirmChain()).rejects.toSatisfy(RpcChainGuardError.is)
    node.requests.length = 0
    const mismatch = await failure(elsewhere.psbtBumpFee(HASH_A))
    expect(mismatch).toMatchObject({ reason: 'mismatch', expectedChain: 'regtest', actualChain: 'main' })
    expect(node.requests).toHaveLength(0)

    // A stale confirmation is checked again first, and the chain having changed refuses the bump.
    const stale = client(['wallet-write'], { chainCheckMaxAgeMs: 0 })
    node.results(chainResults('regtest'))
    await stale.confirmChain()
    node.results({ ...chainResults('main'), psbtbumpfee: json(BUMPED) })
    node.requests.length = 0
    expect(await failure(stale.psbtBumpFee(HASH_A))).toMatchObject({ reason: 'mismatch', actualChain: 'main' })
    expect(node.calls().map(call => call.method)).toEqual([...CHECK])

    const reader = client(['wallet-read', 'wallet-write'])
    expect((await refusal(reader.batch([requests.getBalances(), requests.psbtBumpFee(HASH_A)]))).reason).toBe(
      'not_batchable'
    )
    expect(METHOD_POLICIES['psbtbumpfee']).toEqual({ capability: 'wallet-write', sideEffects: true })
  })
})
