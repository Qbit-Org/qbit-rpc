import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { BITS_PER_QBT, formatQbt, JsonNumber, MAX_MONEY_BITS, parseQbt, requests } from '../src'
import { parseJsonLossless, stringifyRequest } from '../src/json'
import { fuzz, FUZZ_TIMEOUT_MS } from './helpers/fuzz'

// Amounts and JSON numbers are where a reply's text becomes a value: a float
// or a lost digit here pays the wrong amount. Each property states what the
// value must be in terms of the text, independently of the regular
// expressions the code uses.

const bits = fc.bigInt({ min: -MAX_MONEY_BITS, max: MAX_MONEY_BITS })
const digits = (min: number, max: number): fc.Arbitrary<string> =>
  fc.string({ unit: fc.constantFrom(...'0123456789'), minLength: min, maxLength: max })

/** Decimal-looking text: a sign, digits (leading zeros too), a fraction of 0 to 10 digits, maybe an exponent. */
const decimalText = fc
  .record({
    sign: fc.constantFrom('', '', '-', '+'),
    whole: fc.oneof(digits(1, 3), digits(8, 11), fc.constant('0')),
    dot: fc.boolean(),
    fraction: digits(0, 10),
    exponent: fc.oneof(
      { weight: 6, arbitrary: fc.constant('') },
      { weight: 1, arbitrary: fc.constantFrom('e3', 'E-2', 'e+0') }
    ),
  })
  .map(({ sign, whole, dot, fraction, exponent }) => `${sign}${whole}${dot ? `.${fraction}` : ''}${exponent}`)

/** What parseQbt must give for `text`, from its parts: bits, or 'range' for a RangeError. */
function expectedBits(text: string, allowNegative: boolean): bigint | 'range' {
  const negative = text.startsWith('-')
  const body = negative ? text.slice(1) : text
  const [whole = '', fraction, ...more] = body.split('.')
  if (more.length > 0 || whole === '' || ![...whole].every(c => c >= '0' && c <= '9')) return 'range'
  if (whole.length > 1 && whole.startsWith('0')) return 'range'
  if (
    fraction !== undefined &&
    (fraction.length < 1 || fraction.length > 8 || ![...fraction].every(c => c >= '0' && c <= '9'))
  ) {
    return 'range'
  }
  const magnitude = BigInt(whole) * BITS_PER_QBT + BigInt((fraction ?? '').padEnd(8, '0') || '0')
  if (magnitude > MAX_MONEY_BITS) return 'range'
  if (magnitude === 0n) return 0n
  if (negative && !allowNegative) return 'range'
  return negative ? -magnitude : magnitude
}

function outcome<T>(f: () => T): T | 'range' {
  try {
    return f()
  } catch (error) {
    if (error instanceof RangeError) return 'range'
    throw error
  }
}

describe('parseQbt and formatQbt properties', () => {
  it(
    'round-trips every amount within ±MAX_MONEY_BITS through 8-decimal text',
    () => {
      fc.assert(
        fc.property(bits, value => {
          const text = formatQbt(value)
          expect(text).toMatch(/^-?(?:0|[1-9][0-9]*)\.[0-9]{8}$/)
          expect(parseQbt(text, { allowNegative: true })).toBe(value)
          if (value > 0n) expect(formatQbt(-value)).toBe(`-${text}`)
          if (value >= 0n) expect(parseQbt(text)).toBe(value)
        }),
        fuzz(2000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'parses decimal text to exactly the bits its digits name, or throws RangeError',
    () => {
      fc.assert(
        fc.property(decimalText, fc.boolean(), (text, allowNegative) => {
          expect(outcome(() => parseQbt(text, { allowNegative }))).toBe(expectedBits(text, allowNegative))
        }),
        fuzz(3000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'throws only RangeError for any string, and TypeError for anything else',
    () => {
      fc.assert(
        fc.property(fc.string(), fc.boolean(), (text, allowNegative) => {
          const parsed = outcome(() => parseQbt(text, { allowNegative }))
          if (parsed !== 'range') {
            expect(parsed <= MAX_MONEY_BITS && parsed >= (allowNegative ? -MAX_MONEY_BITS : 0n)).toBe(true)
          }
        }),
        fuzz(1000)
      )
      fc.assert(
        fc.property(
          fc.anything().filter(value => typeof value !== 'string'),
          value => {
            expect(() => parseQbt(value as string)).toThrow(TypeError)
          }
        ),
        fuzz(300)
      )
      fc.assert(
        fc.property(
          fc.anything().filter(value => typeof value !== 'bigint'),
          value => {
            expect(() => formatQbt(value as bigint)).toThrow(TypeError)
          }
        ),
        fuzz(300)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'refuses amounts beyond ±MAX_MONEY_BITS in both directions',
    () => {
      const beyond = fc.oneof(
        fc.bigInt({ min: MAX_MONEY_BITS + 1n, max: MAX_MONEY_BITS * 1000n }),
        fc.bigInt({ min: -MAX_MONEY_BITS * 1000n, max: -MAX_MONEY_BITS - 1n })
      )
      fc.assert(
        fc.property(beyond, value => {
          expect(() => formatQbt(value)).toThrow(RangeError)
          const magnitude = value < 0n ? -value : value
          const text = `${value < 0n ? '-' : ''}${magnitude / BITS_PER_QBT}.${(magnitude % BITS_PER_QBT).toString().padStart(8, '0')}`
          expect(() => parseQbt(text, { allowNegative: true })).toThrow(RangeError)
        }),
        fuzz(500)
      )
      expect(parseQbt('210000000')).toBe(MAX_MONEY_BITS)
      expect(parseQbt('-210000000.00000000', { allowNegative: true })).toBe(-MAX_MONEY_BITS)
      expect(() => parseQbt('210000000.00000001')).toThrow(RangeError)
    },
    FUZZ_TIMEOUT_MS
  )

  it('reads every form of negative zero as 0n, with or without allowNegative', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), fc.boolean(), (zeros, allowNegative) => {
        const text = zeros === 0 ? '-0' : `-0.${'0'.repeat(zeros)}`
        expect(parseQbt(text, { allowNegative })).toBe(0n)
        expect(new JsonNumber(text).toBits()).toBe(0n)
      }),
      fuzz(50)
    )
    expect(formatQbt(-0n)).toBe('0.00000000')
    // A JS -0 is a number, not bits.
    expect(() => formatQbt(-0 as unknown as bigint)).toThrow(TypeError)
    expect(() => requests.getConfirmationTarget(-0 as unknown as bigint)).toThrow(TypeError)
    // Numeric arguments send -0 as 0.
    expect(Object.is(requests.getBlockHash(-0).params[0], 0)).toBe(true)
    expect(Object.is(requests.getTxOut('a'.repeat(64), -0).params[1], 0)).toBe(true)
    expect(stringifyRequest([-0])).toBe('[0]')
  })
})

/** JSON number grammar (RFC 8259 section 6), as text. */
const jsonNumberText = fc
  .record({
    sign: fc.constantFrom('', '-'),
    whole: fc.oneof(
      fc.constant('0'),
      fc.tuple(fc.constantFrom(...'123456789'), digits(0, 30)).map(([a, b]) => a + b)
    ),
    fraction: fc.oneof(
      fc.constant(''),
      digits(1, 20).map(d => `.${d}`)
    ),
    exponent: fc.oneof(
      { weight: 3, arbitrary: fc.constant('') },
      {
        weight: 1,
        arbitrary: fc
          .tuple(fc.constantFrom('e', 'E'), fc.constantFrom('', '+', '-'), digits(1, 4))
          .map(p => p.join('')),
      }
    ),
  })
  .map(({ sign, whole, fraction, exponent }) => `${sign}${whole}${fraction}${exponent}`)

/** Whether `text`, as a whole, is a JSON number: what JSON.parse reads as one, with no surrounding whitespace. */
function isJsonNumberText(text: string): boolean {
  if (text.trim() !== text) return false
  try {
    return typeof JSON.parse(text) === 'number'
  } catch {
    return false
  }
}

describe('JsonNumber properties', () => {
  it(
    'takes exactly the JSON number texts, and keeps each as written',
    () => {
      const nearNumber = fc.string({ unit: fc.constantFrom(...'-+0123456789.eE x'), maxLength: 12 })
      fc.assert(
        fc.property(fc.oneof(jsonNumberText, nearNumber, fc.string()), text => {
          const accepted = (() => {
            try {
              return new JsonNumber(text)
            } catch (error) {
              expect(error).toBeInstanceOf(TypeError)
              return undefined
            }
          })()
          expect(accepted !== undefined).toBe(isJsonNumberText(text))
          if (accepted !== undefined) {
            expect(accepted.source).toBe(text)
            expect(String(accepted)).toBe(text)
            expect(JSON.stringify({ n: accepted })).toBe(`{"n":${text}}`)
          }
        }),
        fuzz(3000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'converts only as asked: exact bigints, safe integers, finite numbers, and bits',
    () => {
      fc.assert(
        fc.property(jsonNumberText, text => {
          const n = new JsonNumber(text)
          const integer = /^-?[0-9]+$/.test(text)
          expect(outcome(() => n.toBigInt())).toBe(integer ? BigInt(text) : 'range')
          const safe =
            integer &&
            BigInt(text) <= BigInt(Number.MAX_SAFE_INTEGER) &&
            BigInt(text) >= BigInt(Number.MIN_SAFE_INTEGER)
          expect(outcome(() => n.toSafeInteger())).toBe(safe ? Number(BigInt(text)) : 'range')
          expect(outcome(() => n.toNumber())).toBe(Number.isFinite(Number(text)) ? Number(text) : 'range')
          expect(outcome(() => n.toBits())).toBe(expectedBits(text, true))
          expect(() => +(n as unknown as number)).toThrow(TypeError)
        }),
        fuzz(2000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'parses replies losslessly: every number keeps its text, and the rest is JSON.parse',
    () => {
      fc.assert(
        fc.property(fc.json(), text => {
          const parsed = parseJsonLossless(text)
          expect(JSON.stringify(parsed)).toBe(JSON.stringify(JSON.parse(text)))
        }),
        fuzz(1000)
      )
      fc.assert(
        fc.property(fc.array(jsonNumberText, { maxLength: 5 }), texts => {
          const text = `{"a":[${texts.join(',')}],"b":${texts[0] ?? 'null'}}`
          const parsed = parseJsonLossless(text) as { a: JsonNumber[] }
          expect(parsed.a.map(n => n.source)).toEqual(texts)
          expect(JSON.stringify(parsed)).toBe(text)
        }),
        fuzz(1000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'writes bigints as integer literals and refuses NaN and Infinity in a request',
    () => {
      fc.assert(
        fc.property(fc.bigInt({ min: -(2n ** 80n), max: 2n ** 80n }), value => {
          expect(stringifyRequest({ v: value })).toBe(`{"v":${value}}`)
        }),
        fuzz(500)
      )
      for (const bad of [NaN, Infinity, -Infinity]) expect(() => stringifyRequest([bad])).toThrow(TypeError)
    },
    FUZZ_TIMEOUT_MS
  )
})
