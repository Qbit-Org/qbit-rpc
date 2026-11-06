import { isJsonObject, JsonNumber } from './json'
import { MAX_MONEY_BITS, qbtBits } from './amount'

/** A result value failed validation. The client turns it into an `RpcResponseError`. */
export class ResultIssue extends Error {
  readonly path: string
  readonly expected: string

  constructor(path: string, expected: string) {
    super(`${path}: expected ${expected}`)
    this.path = path
    this.expected = expected
  }
}

export type JsonObject = Readonly<Record<string, unknown>>

export function object(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) throw new ResultIssue(path, 'an object')
  return value
}

export function array<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new ResultIssue(path, 'an array')
  return value.map((entry, index) => item(entry, `${path}[${index}]`))
}

/** A required field. */
export function field<T>(source: JsonObject, key: string, path: string, parse: (value: unknown, path: string) => T): T {
  if (!Object.hasOwn(source, key)) throw new ResultIssue(`${path}.${key}`, 'a value (the field is missing)')
  return parse(source[key], `${path}.${key}`)
}

/** An optional field: absent gives undefined; present, including as null, must parse. */
export function optional<T>(
  source: JsonObject,
  key: string,
  path: string,
  parse: (value: unknown, path: string) => T
): T | undefined {
  if (!Object.hasOwn(source, key)) return undefined
  return parse(source[key], `${path}.${key}`)
}

/**
 * Copy the defined entries of `fields` onto a fresh object without a
 * prototype, so optional properties stay absent and an absent one reads as
 * undefined whatever Object.prototype holds. Every object of a typed result
 * is built here.
 */
export function compact<T extends object>(fields: { [K in keyof T]: T[K] | undefined }): T {
  const out = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value
  return out as T
}

export function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ResultIssue(path, 'a string')
  return value
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ResultIssue(path, 'a boolean')
  return value
}

export function oneOf<T extends string>(values: readonly T[]): (value: unknown, path: string) => T {
  return (value, path) => {
    if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
      throw new ResultIssue(path, `one of ${values.map(v => `'${v}'`).join(', ')}`)
    }
    return value as T
  }
}

/**
 * A value of an enum a later qbit Core may extend: one of `values`, or any
 * other non-empty string, returned as it is, never dropped or coerced. Which
 * enums are open, and why, is in
 * {@link https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/versions.md | Versions and compatibility}.
 */
export function openOneOf<T extends string>(values: readonly T[]): (value: unknown, path: string) => T | (string & {}) {
  const expected = `one of ${values.map(v => `'${v}'`).join(', ')}, or another non-empty string`
  return (value, path) => {
    if (typeof value !== 'string' || value === '') throw new ResultIssue(path, expected)
    return value
  }
}

const HASH = /^[0-9a-f]{64}$/
const HEX = /^(?:[0-9a-f]{2})*$/

/** A 32-byte hash or txid in the node's display (reversed) byte order: 64 lowercase hex characters. */
export function hash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new ResultIssue(path, '64 lowercase hex characters')
  return value
}

/** Lowercase hex of whole bytes, optionally of an exact byte length. */
export function hex(bytes?: number): (value: unknown, path: string) => string {
  return (value, path) => {
    if (typeof value !== 'string' || !HEX.test(value) || (bytes !== undefined && value.length !== bytes * 2)) {
      throw new ResultIssue(path, bytes === undefined ? 'lowercase hex' : `${bytes * 2} lowercase hex characters`)
    }
    return value
  }
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function base64(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '' || !BASE64.test(value)) {
    throw new ResultIssue(path, 'non-empty padded base64')
  }
  return value
}

function numberSource(value: unknown, path: string, expected: string): string {
  if (!(value instanceof JsonNumber)) throw new ResultIssue(path, expected)
  return value.source
}

const INTEGER = /^-?(?:0|[1-9][0-9]*)$/

/** An integer literal within [min, max], both inside the safe-integer range. */
export function integer(min: number, max: number): (value: unknown, path: string) => number {
  return (value, path) => {
    const expected = `an integer from ${min} to ${max}`
    const source = numberSource(value, path, expected)
    if (!INTEGER.test(source)) throw new ResultIssue(path, expected)
    const parsed = Number(source)
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ResultIssue(path, expected)
    return parsed === 0 ? 0 : parsed // A -0 literal is 0, as for arguments and parseQbt.
  }
}

export const nonNegativeInteger = integer(0, Number.MAX_SAFE_INTEGER)
export const anyInteger = integer(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
export const uint32 = integer(0, 0xffff_ffff)
export const int32 = integer(-0x8000_0000, 0x7fff_ffff)

/** A finite JSON number, optionally bounded. Not for amounts. */
export function finite(min = -Infinity, max = Infinity): (value: unknown, path: string) => number {
  return (value, path) => {
    const expected = Number.isFinite(min) || Number.isFinite(max) ? `a number from ${min} to ${max}` : 'a finite number'
    const parsed = Number(numberSource(value, path, expected))
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new ResultIssue(path, expected)
    return parsed === 0 ? 0 : parsed // A -0 or -0.0 literal is 0, as in integer().
  }
}

/** An integer literal of any size as a bigint, from 0 to `max`. */
export function bigUnsigned(max: bigint): (value: unknown, path: string) => bigint {
  return (value, path) => {
    const expected = `an integer from 0 to ${max}`
    const source = numberSource(value, path, expected)
    if (!INTEGER.test(source)) throw new ResultIssue(path, expected)
    const parsed = BigInt(source)
    if (parsed < 0n || parsed > max) throw new ResultIssue(path, expected)
    return parsed
  }
}

/** A non-negative QBT amount as qbit Core prints it, converted to bits from its source text. */
export function amount(value: unknown, path: string): bigint {
  const expected = 'a QBT amount from 0 to 210000000 with at most 8 decimals'
  try {
    return qbtBits(numberSource(value, path, expected), false)
  } catch (error) {
    if (error instanceof ResultIssue) throw error
    throw new ResultIssue(path, expected)
  }
}

/** A QBT amount that may be negative (wallet sends and fees), converted to bits. */
export function signedAmount(value: unknown, path: string): bigint {
  const expected = 'a QBT amount within ±210000000 with at most 8 decimals'
  try {
    return qbtBits(numberSource(value, path, expected), true)
  } catch (error) {
    if (error instanceof ResultIssue) throw error
    throw new ResultIssue(path, expected)
  }
}

/** An integer amount in bits (some fields, such as `listunspent.ancestorfees`, are printed in bits). */
export const bitsInteger = bigUnsigned(MAX_MONEY_BITS)

export function nullValue(value: unknown, path: string): null {
  if (value !== null) throw new ResultIssue(path, 'null')
  return null
}

/** A `warnings` field: an array of strings, or one string under `-deprecatedrpc=warnings` ("" for none). */
export function warnings(value: unknown, path: string): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  return array(value, path, string)
}
