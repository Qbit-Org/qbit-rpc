import { NO_OPTIONS, plainOptions } from './own'

/** Bits per QBT: 1 QBT = 100,000,000 bits. */
export const BITS_PER_QBT = 100_000_000n

/** qbit Core's `MAX_MONEY`: 210,000,000 QBT, which is 2.1e16 bits and above 2^53. */
export const MAX_MONEY_BITS = 210_000_000n * BITS_PER_QBT

const DECIMAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/

/**
 * Parse a decimal QBT amount, such as qbit Core prints (`"1.00000000"`), into
 * bits. At most 8 decimals, no exponent, no sign other than a leading `-`
 * when `allowNegative` is set, and at most {@link MAX_MONEY_BITS} in
 * magnitude. Negative zero (`"-0"`, `"-0.00000000"`) is zero: `0n`, with or
 * without `allowNegative`. Throws a `RangeError` otherwise. `options` is read
 * by its own properties: an inherited `allowNegative` is a `TypeError`.
 */
export function parseQbt(text: string, options: { allowNegative?: boolean } = NO_OPTIONS): bigint {
  if (typeof text !== 'string') throw new TypeError('QBT amount must be a decimal string')
  if (typeof options !== 'object' || options === null) throw new TypeError('options must be an object')
  return qbtBits(text, plainOptions(options, 'options', ['allowNegative']).allowNegative === true)
}

/** {@link parseQbt} of a string, for this package's reply readers: no options object to read. */
export function qbtBits(text: string, allowNegative: boolean): bigint {
  const match = DECIMAL.exec(text)
  if (match === null) {
    throw new RangeError('QBT amount must be a plain decimal with at most 8 decimals')
  }
  const [, sign, whole, fraction = ''] = match
  const magnitude = BigInt(whole!) * BITS_PER_QBT + BigInt(fraction.padEnd(8, '0'))
  if (magnitude > MAX_MONEY_BITS) throw new RangeError('QBT amount exceeds 210,000,000 QBT')
  if (magnitude === 0n) return 0n
  if (sign === '-' && !allowNegative) {
    throw new RangeError('QBT amount must not be negative')
  }
  return sign === '-' ? -magnitude : magnitude
}

/**
 * Format bits as a decimal QBT string with exactly 8 decimals, the form qbit
 * Core prints: `formatQbt(1n)` is `"0.00000001"`. Negative values keep their
 * sign. Throws a `RangeError` beyond ±{@link MAX_MONEY_BITS}.
 */
export function formatQbt(bits: bigint): string {
  if (typeof bits !== 'bigint') throw new TypeError('bits must be a bigint')
  const magnitude = bits < 0n ? -bits : bits
  if (magnitude > MAX_MONEY_BITS) throw new RangeError('amount exceeds 210,000,000 QBT')
  const fraction = (magnitude % BITS_PER_QBT).toString().padStart(8, '0')
  return `${bits < 0n ? '-' : ''}${magnitude / BITS_PER_QBT}.${fraction}`
}

/** Check an outgoing amount: a `bigint` from 0 to {@link MAX_MONEY_BITS} bits. */
export function assertBits(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${name} must be a bigint number of bits, not ${typeof value}`)
  }
  if (value < 0n || value > MAX_MONEY_BITS) {
    throw new RangeError(`${name} must be between 0 and ${MAX_MONEY_BITS} bits`)
  }
  return value
}

/**
 * Format a fee rate in bits per 1,000 vbytes (qbit Core's `CFeeRate` unit) as
 * the decimal bits-per-vbyte string the wallet's `fee_rate` option takes,
 * which allows 3 decimals: `250n` (0.25 bits/vB) is `"0.250"`.
 */
export function formatBitsPerVbyte(bitsPerKvB: bigint): string {
  return `${bitsPerKvB / 1000n}.${(bitsPerKvB % 1000n).toString().padStart(3, '0')}`
}
