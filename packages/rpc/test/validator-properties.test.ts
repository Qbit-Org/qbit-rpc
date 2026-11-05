import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { JsonNumber, MAX_MONEY_BITS, parseQbt } from '../src'
import {
  amount,
  array,
  base64,
  bigUnsigned,
  bitsInteger,
  boolean,
  field,
  finite,
  hash,
  hex,
  int32,
  integer,
  nonNegativeInteger,
  nullValue,
  object,
  oneOf,
  optional,
  ResultIssue,
  signedAmount,
  string,
  uint32,
  warnings,
} from '../src/validate'
import { fuzz, FUZZ_TIMEOUT_MS } from './helpers/fuzz'
import { replyValue } from './helpers/replies'

// Each primitive validator against a predicate written from what it promises:
// for any reply value it either returns what the predicate accepts, or throws
// a ResultIssue at the path it was given. The method validators are built
// from these and are tested on captured replies in fixtures.test.ts.

type Validator = (value: unknown, path: string) => unknown

/** Run `validate`; its value, or 'refused' for a ResultIssue at its path. Anything else fails the test. */
function run(validate: Validator, value: unknown): { value: unknown } | 'refused' {
  try {
    return { value: validate(value, 'result.x') }
  } catch (error) {
    expect(error).toBeInstanceOf(ResultIssue)
    // At the path given, or an item under it.
    expect((error as ResultIssue).path).toMatch(/^result\.x(?:\[[0-9]+\])?$/)
    return 'refused'
  }
}

const source = (value: unknown): string | undefined => (value instanceof JsonNumber ? value.source : undefined)
const integerText = (text: string | undefined): boolean => text !== undefined && /^-?(?:0|[1-9][0-9]*)$/.test(text)
const isHex = (value: unknown): value is string =>
  typeof value === 'string' && value.length % 2 === 0 && [...value].every(c => '0123456789abcdef'.includes(c))
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function isPaddedBase64(value: unknown): boolean {
  if (typeof value !== 'string' || value === '' || value.length % 4 !== 0) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return [...value.slice(0, value.length - padding)].every(c => BASE64.includes(c))
}
const qbt = (text: string | undefined, allowNegative: boolean): bigint | undefined => {
  if (text === undefined) return undefined
  try {
    return parseQbt(text, { allowNegative })
  } catch {
    return undefined
  }
}

/** Each validator, with what it must return for a value, or undefined where it must refuse. */
const CASES: readonly [string, Validator, (value: unknown) => { value: unknown } | undefined][] = [
  ['string', string, v => (typeof v === 'string' ? { value: v } : undefined)],
  ['boolean', boolean, v => (typeof v === 'boolean' ? { value: v } : undefined)],
  ['nullValue', nullValue, v => (v === null ? { value: null } : undefined)],
  ['hash', hash, v => (isHex(v) && v.length === 64 ? { value: v } : undefined)],
  ['hex()', hex(), v => (isHex(v) ? { value: v } : undefined)],
  ['hex(32)', hex(32), v => (isHex(v) && v.length === 64 ? { value: v } : undefined)],
  ['hex(1)', hex(1), v => (isHex(v) && v.length === 2 ? { value: v } : undefined)],
  ['base64', base64, v => (isPaddedBase64(v) ? { value: v } : undefined)],
  ['oneOf', oneOf(['send', 'receive'] as const), v => (v === 'send' || v === 'receive' ? { value: v } : undefined)],
  ...(
    [
      ['uint32', uint32, 0, 0xffff_ffff],
      ['int32', int32, -0x8000_0000, 0x7fff_ffff],
      ['nonNegativeInteger', nonNegativeInteger, 0, Number.MAX_SAFE_INTEGER],
      ['integer(-1, 3)', integer(-1, 3), -1, 3],
    ] as const
  ).map(([name, validate, min, max]): (typeof CASES)[number] => [
    name,
    validate,
    v => {
      const text = source(v)
      if (!integerText(text)) return undefined
      const n = BigInt(text!)
      return n >= BigInt(min) && n <= BigInt(max) ? { value: Number(n) } : undefined
    },
  ]),
  [
    'finite()',
    finite(),
    v => {
      const n = Number(source(v))
      // -0 comes back as 0: toEqual tells them apart.
      return source(v) !== undefined && Number.isFinite(n) ? { value: n === 0 ? 0 : n } : undefined
    },
  ],
  [
    'finite(0, 1)',
    finite(0, 1),
    v => {
      const n = Number(source(v))
      return source(v) !== undefined && n >= 0 && n <= 1 ? { value: n === 0 ? 0 : n } : undefined
    },
  ],
  ...(
    [
      ['bitsInteger', bitsInteger, MAX_MONEY_BITS],
      ['bigUnsigned(2^64 - 1)', bigUnsigned(2n ** 64n - 1n), 2n ** 64n - 1n],
    ] as const
  ).map(([name, validate, max]): (typeof CASES)[number] => [
    name,
    validate,
    v => {
      const text = source(v)
      if (!integerText(text)) return undefined
      const n = BigInt(text!)
      return n >= 0n && n <= max ? { value: n } : undefined
    },
  ]),
  [
    'amount',
    amount,
    v => {
      const bits = qbt(source(v), false)
      return bits === undefined ? undefined : { value: bits }
    },
  ],
  [
    'signedAmount',
    signedAmount,
    v => {
      const bits = qbt(source(v), true)
      return bits === undefined ? undefined : { value: bits }
    },
  ],
  [
    'warnings',
    warnings,
    v => {
      if (typeof v === 'string') return { value: v === '' ? [] : [v] }
      return Array.isArray(v) && v.every(item => typeof item === 'string') ? { value: v } : undefined
    },
  ],
  [
    'object',
    object,
    v =>
      typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof JsonNumber) ? { value: v } : undefined,
  ],
]

/** Values aimed at each validator's edges, mixed with any reply value. */
const edgeValue = fc.oneof(
  replyValue,
  fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }).map(n => new JsonNumber(n.toString())),
  fc.bigInt({ min: -MAX_MONEY_BITS - 2n, max: MAX_MONEY_BITS + 2n }).map(n => {
    const magnitude = n < 0n ? -n : n
    const fraction = (magnitude % 100_000_000n).toString().padStart(8, '0')
    return new JsonNumber(`${n < 0n ? '-' : ''}${magnitude / 100_000_000n}.${fraction}`)
  }),
  fc
    .constantFrom(
      ...[
        '0',
        '-0',
        '-0.0',
        '-0e5',
        '1',
        '0.0',
        '1.00000000',
        '-1',
        '0.999',
        '1e0',
        '1.0e0',
        '4294967295',
        '4294967296',
        '-2147483649',
      ]
    )
    .map(text => new JsonNumber(text)),
  fc.constantFrom(undefined, 'send', 'receive', 'SEND', [], [''], ['a', 1], {}, new JsonNumber('0'))
)

describe('primitive validators', () => {
  it('finite() reads a number written -0, -0.0 or -0e3 as 0, bounded at 0 or not', () => {
    for (const text of ['-0', '-0.0', '-0e3']) {
      expect(Object.is(finite()(new JsonNumber(text), 'result'), 0)).toBe(true)
      expect(Object.is(finite(0)(new JsonNumber(text), 'result'), 0)).toBe(true)
    }
  })

  it.each(CASES.map(([name, validate, expected]) => [name, validate, expected] as const))(
    '%s returns exactly what it promises, or throws a ResultIssue at its path',
    (_name, validate, expected) => {
      fc.assert(
        fc.property(edgeValue, value => {
          const outcome = run(validate, value)
          const wanted = expected(value)
          expect(outcome).toEqual(wanted ?? 'refused')
        }),
        fuzz(1000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'array validates each item at its index, and field and optional at their key',
    () => {
      fc.assert(
        fc.property(edgeValue, value => {
          const outcome = run((v, p) => array(v, p, uint32), value)
          if (outcome === 'refused') {
            if (Array.isArray(value)) {
              const bad = value.findIndex(item => run(uint32, item) === 'refused')
              expect(bad).toBeGreaterThanOrEqual(0)
            }
          } else {
            expect(Array.isArray(value)).toBe(true)
          }
        }),
        fuzz(1000)
      )
      fc.assert(
        fc.property(
          fc.dictionary(fc.string({ maxLength: 3 }), edgeValue, { maxKeys: 4 }),
          fc.string({ maxLength: 3 }),
          (o, key) => {
            const present = Object.hasOwn(o, key)
            const required = (() => {
              try {
                return { value: field(o, key, 'result', uint32) }
              } catch (error) {
                expect(error).toBeInstanceOf(ResultIssue)
                expect((error as ResultIssue).path).toBe(`result.${key}`)
                return 'refused'
              }
            })()
            if (!present) expect(required).toBe('refused')
            const maybe = (() => {
              try {
                return { value: optional(o, key, 'result', uint32) }
              } catch (error) {
                expect(error).toBeInstanceOf(ResultIssue)
                return 'refused'
              }
            })()
            expect(maybe).toEqual(present ? required : { value: undefined })
          }
        ),
        fuzz(1000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it('reads only own fields: an inherited one is missing', () => {
    const inherited = Object.create({ txid: 'a'.repeat(64) }) as Record<string, unknown>
    expect(() => field(inherited, 'txid', 'result', hash)).toThrow(ResultIssue)
    expect(optional(inherited, 'txid', 'result', hash)).toBeUndefined()
    expect(() => field({}, 'constructor', 'result', string)).toThrow(ResultIssue)
    expect(() => field({}, '__proto__', 'result', object)).toThrow(ResultIssue)
  })
})
