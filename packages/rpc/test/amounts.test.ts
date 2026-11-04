import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BITS_PER_QBT, formatQbt, JsonNumber, MAX_MONEY_BITS, parseQbt, QbitRpcClient, RpcResponseError } from '../src'
import { chainResults, FakeNode, HASH_A } from './helpers/fake-node'

const TWO_53_PLUS_1 = 2n ** 53n + 1n // 9007199254740993 bits, not representable as a JS number

describe('parseQbt and formatQbt', () => {
  it.each([
    ['0', 0n],
    ['0.00000000', 0n],
    ['0.00000001', 1n],
    ['1', BITS_PER_QBT],
    ['1.5', 150_000_000n],
    ['90071992.54740993', TWO_53_PLUS_1],
    ['210000000.00000000', MAX_MONEY_BITS],
  ])('parses %s exactly', (text, bits) => {
    expect(parseQbt(text)).toBe(bits)
  })

  it.each([
    ['more than 8 decimals', '0.000000001'],
    ['a negative value', '-0.00000001'],
    ['above the cap', '210000000.00000001'],
    ['an exponent', '1e-8'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['an empty string', ''],
    ['whitespace', ' 1'],
    ['a leading zero', '01'],
    ['a bare point', '1.'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseQbt(text)).toThrow(RangeError)
  })

  it('allows signed amounts only on request', () => {
    expect(parseQbt('-0.50000000', { allowNegative: true })).toBe(-50_000_000n)
    expect(() => parseQbt('-210000000.00000001', { allowNegative: true })).toThrow(RangeError)
  })

  it.each(['-0', '-0.0', '-0.00000000'])('parses negative zero %s as zero, with or without allowNegative', text => {
    expect(parseQbt(text)).toBe(0n)
    expect(parseQbt(text, { allowNegative: true })).toBe(0n)
    expect(formatQbt(parseQbt(text))).toBe('0.00000000')
    expect(new JsonNumber(text).toBits()).toBe(0n)
  })

  it.each([
    [0n, '0.00000000'],
    [1n, '0.00000001'],
    [TWO_53_PLUS_1, '90071992.54740993'],
    [MAX_MONEY_BITS, '210000000.00000000'],
    [-150_000_000n, '-1.50000000'],
  ])('formats %s bits as %s', (bits, text) => {
    expect(formatQbt(bits)).toBe(text)
    expect(parseQbt(text, { allowNegative: true })).toBe(bits)
  })

  it('refuses numbers and out-of-range bits when formatting', () => {
    expect(() => formatQbt(1 as unknown as bigint)).toThrow(TypeError)
    expect(() => formatQbt(MAX_MONEY_BITS + 1n)).toThrow(RangeError)
  })
})

describe('JsonNumber', () => {
  it('keeps the source text and converts on request', () => {
    const n = new JsonNumber('90071992.54740993')
    expect(n.toBits()).toBe(TWO_53_PLUS_1)
    expect(String(n)).toBe('90071992.54740993')
    expect(JSON.stringify({ n })).toBe('{"n":90071992.54740993}')
    expect(new JsonNumber('9007199254740993').toBigInt()).toBe(TWO_53_PLUS_1)
    expect(() => new JsonNumber('9007199254740993').toSafeInteger()).toThrow(RangeError)
    expect(() => new JsonNumber('1e400').toNumber()).toThrow(RangeError)
    expect(() => new JsonNumber('1.5').toBigInt()).toThrow(RangeError)
    expect(() => (n as unknown as number) + 1).toThrow(TypeError)
    expect(() => new JsonNumber('NaN')).toThrow(TypeError)
  })
})

describe('amounts through a node', () => {
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
  })
  afterEach(async () => {
    await node.close()
  })

  const utxo = (amount: string): string =>
    `{"txid":"${HASH_A}","vout":0,"address":"rq1x","scriptPubKey":"5220${'00'.repeat(32)}","amount":${amount},"confirmations":1,"spendable":true,"solvable":true,"parent_descs":[],"safe":true}`

  it('parses result amounts from the reply text, without float loss', async () => {
    node.results({
      listunspent: `[${utxo('0.00000000')},${utxo('-0.00000000')},${utxo('0.00000001')},${utxo('90071992.54740993')},${utxo('210000000.00000000')}]`,
    })
    const amounts = (await rpc.listUnspent()).map(output => output.amountBits)
    expect(amounts).toEqual([0n, 0n, 1n, TWO_53_PLUS_1, MAX_MONEY_BITS])
    // The same text through JSON.parse would have rounded:
    expect(Number('90071992.54740993') * 1e8).not.toBe(Number(TWO_53_PLUS_1))
  })

  it.each([
    ['more than 8 decimals', '0.000000001'],
    ['a negative amount', '-0.00000001'],
    ['an amount above the cap', '210000000.00000001'],
    ['an exponent', '1e-8'],
    ['a string', '"0.1"'],
  ])('rejects %s in a result as a validation error', async (_label, amount) => {
    node.results({ listunspent: `[${utxo(amount)}]` })
    const error = await rpc.listUnspent().catch((e: unknown) => e)
    expect(RpcResponseError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'validation', path: 'result[0].amount' })
  })

  it('serializes outgoing amounts as exact decimal JSON numbers', async () => {
    node.results({
      ...chainResults('regtest'),
      walletcreatefundedpsbt: '{"psbt":"cHNidP8=","fee":0.00000141,"changepos":-1}',
    })
    await rpc.confirmChain()
    const funded = await rpc.walletCreateFundedPsbt({
      outputs: [
        { address: 'rq1zero', amountBits: 0n },
        { address: 'rq1one', amountBits: 1n },
        { address: 'rq1big', amountBits: TWO_53_PLUS_1 },
        { address: 'rq1cap', amountBits: MAX_MONEY_BITS },
      ],
      options: { feeRateBitsPerKvB: 250n },
    })
    expect(funded).toEqual({ psbt: 'cHNidP8=', feeBits: 141n, changePos: -1 })
    const body = node.requests.at(-1)!.body
    expect(body).toContain(
      '[{"rq1zero":0.00000000},{"rq1one":0.00000001},{"rq1big":90071992.54740993},{"rq1cap":210000000.00000000}]'
    )
    expect(body).toContain('"fee_rate":0.250')
  })

  it('serializes integer bits above 2^53 exactly', async () => {
    node.results({ getconfirmationtarget: '{}' })
    await rpc.getConfirmationTarget(TWO_53_PLUS_1).catch(() => undefined)
    expect(node.requests[0]!.body).toContain('"params":[9007199254740993]')
  })

  it.each([
    ['a number', 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative bigint', -1n],
    ['a bigint above the cap', MAX_MONEY_BITS + 1n],
    ['a decimal string', '0.1'],
  ])('refuses %s as an outgoing amount before sending', async (_label, amountBits) => {
    node.results(chainResults('regtest'))
    await rpc.confirmChain()
    const before = node.requests.length
    await expect(
      rpc.walletCreateFundedPsbt({ outputs: [{ address: 'rq1x', amountBits: amountBits as bigint }] })
    ).rejects.toThrow(/amountBits/)
    await expect(rpc.listUnspent({ minimumAmountBits: amountBits as bigint })).rejects.toThrow(/minimumAmountBits/)
    expect(node.requests).toHaveLength(before)
  })

  it('keeps signed wallet amounts signed', async () => {
    node.results({
      gettransaction: JSON.stringify({
        txid: HASH_A,
        wtxid: HASH_A,
        walletconflicts: [],
        mempoolconflicts: [],
        time: 1,
        timereceived: 1,
        'bip125-replaceable': 'no',
        details: [{ address: 'rq1x', category: 'send', vout: 0, abandoned: false, amount: 0, fee: 0 }],
        hex: '00',
        lastprocessedblock: { hash: HASH_A, height: 5 },
        confirmations: 0,
        trusted: true,
      })
        .replace('"amount":0', '"amount":-90071992.54740993')
        .replace('"fee":0', '"fee":-0.00000141')
        .replace('"confirmations":0', '"amount":-90071992.54740993,"fee":-0.00000141,"confirmations":0'),
    })
    const tx = await rpc.getTransaction(HASH_A)
    expect(tx.amountBits).toBe(-TWO_53_PLUS_1)
    expect(tx.feeBits).toBe(-141n)
    expect(tx.details[0]).toMatchObject({ amountBits: -TWO_53_PLUS_1, feeBits: -141n, category: 'send' })
  })
})
