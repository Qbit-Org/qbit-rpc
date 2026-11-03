import { inspect } from 'node:util'

import { parseQbt } from './amount'

// JSON.parse source-text access (the reviver's third argument) and
// JSON.rawJSON ship in Node.js 21 and later; TypeScript 5.9 does not type them.
type Reviver = (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown
interface JsonWithSource {
  parse(text: string, reviver: Reviver): unknown
  rawJSON(text: string): unknown
}
const json = JSON as unknown as JsonWithSource

const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/
const JSON_INTEGER = /^-?(?:0|[1-9][0-9]*)$/

/**
 * A JSON number as it appeared in a node reply, kept as its source text so no
 * precision is lost. `call()` and `batch()` with `requests.raw()` return every
 * number in this form; convert with the method that matches what the field
 * holds. Arithmetic on it throws (`valueOf` refuses), so it cannot silently
 * become a float. `JSON.stringify` writes the original text back.
 */
export class JsonNumber {
  readonly source: string

  constructor(source: string) {
    if (typeof source !== 'string' || !JSON_NUMBER.test(source)) {
      throw new TypeError('JsonNumber needs JSON number text')
    }
    this.source = source
  }

  /** The value as a finite JS number. May round: never use it for amounts. */
  toNumber(): number {
    const value = Number(this.source)
    if (!Number.isFinite(value)) throw new RangeError(`JSON number ${this.source} is not finite`)
    return value
  }

  /** An integer literal as an exact `bigint`. */
  toBigInt(): bigint {
    if (!JSON_INTEGER.test(this.source)) throw new RangeError(`JSON number ${this.source} is not an integer`)
    return BigInt(this.source)
  }

  /** An integer literal within the safe-integer range as a JS number. */
  toSafeInteger(): number {
    const value = this.toBigInt()
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`JSON number ${this.source} is outside the safe-integer range`)
    }
    return Number(value)
  }

  /**
   * A QBT amount (as qbit Core prints them, for example `0.00000001`) as
   * bits. Negative amounts, which wallet replies use for sends and fees, are
   * allowed; magnitudes above 210,000,000 QBT and more than 8 decimals throw.
   */
  toBits(): bigint {
    return parseQbt(this.source, { allowNegative: true })
  }

  toString(): string {
    return this.source
  }

  toJSON(): unknown {
    return json.rawJSON(this.source)
  }

  valueOf(): never {
    throw new TypeError('JsonNumber has no implicit numeric value: use toNumber(), toBigInt() or toBits()')
  }

  [inspect.custom](): string {
    return `JsonNumber(${this.source})`
  }
}

/** Parse JSON, turning every number into a {@link JsonNumber} holding its source text. */
export function parseJsonLossless(text: string): unknown {
  return json.parse(text, (_key, value, context) => {
    if (typeof value !== 'number') return value
    if (typeof context?.source !== 'string') throw new TypeError('JSON source text is unavailable')
    return new JsonNumber(context.source)
  })
}

/** Serialize a request, writing bigints as integer literals and JsonNumbers as their source text. */
export function stringifyRequest(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return json.rawJSON(item.toString())
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new TypeError('RPC parameters must not contain NaN or Infinity')
    }
    return item
  })
}

/** A decimal amount literal for an outgoing parameter, written without quotes or float rounding. */
export function rawDecimal(text: string): unknown {
  return json.rawJSON(text)
}

/** Fail fast on a runtime without JSON source-text access, which lossless parsing depends on. */
export function assertLosslessJsonSupport(): void {
  let source: unknown
  try {
    source = json.parse('1.10', (_key, value, context) => (typeof value === 'number' ? context?.source : value))
  } catch {
    source = undefined
  }
  if (source !== '1.10' || typeof json.rawJSON !== 'function') {
    throw new Error('@qbit-oss/rpc needs JSON.parse source text access and JSON.rawJSON (Node.js 22 or later)')
  }
}
