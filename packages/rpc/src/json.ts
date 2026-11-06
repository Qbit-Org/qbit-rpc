import { inspect, types } from 'node:util'

import { qbtBits } from './amount'

// JSON.parse source-text access (the reviver's third argument) and
// JSON.rawJSON ship in Node.js 21 and later; TypeScript 5.9 does not type them.
type Reviver = (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown
interface JsonWithSource {
  parse(text: string, reviver: Reviver): unknown
  rawJSON(text: string): unknown
  isRawJSON(value: unknown): value is { readonly rawJSON: string }
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
  /** The number's text, as the node wrote it. */
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
    return qbtBits(this.source, true)
  }

  /** The number's text, as the node wrote it. */
  toString(): string {
    return this.source
  }

  /** Lets `JSON.stringify` write the number's text as it is, without loss. */
  toJSON(): unknown {
    return json.rawJSON(this.source)
  }

  /** Throws a `TypeError`: arithmetic and comparisons need an explicit conversion. */
  valueOf(): never {
    throw new TypeError('JsonNumber has no implicit numeric value: use toNumber(), toBigInt() or toBits()')
  }

  /** What `util.inspect` and `console.log` show: `JsonNumber(<text>)`. */
  [inspect.custom](): string {
    return `JsonNumber(${this.source})`
  }
}

/**
 * Parse JSON, turning every number into a {@link JsonNumber} holding its
 * source text. Every object is made without a prototype, so a key the text
 * leaves out reads as undefined whatever Object.prototype holds, now or later.
 */
export function parseJsonLossless(text: string): unknown {
  return json.parse(text, (_key, value, context) => {
    if (typeof value === 'number') {
      if (typeof context?.source !== 'string') throw new TypeError('JSON source text is unavailable')
      return new JsonNumber(context.source)
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) Object.setPrototypeOf(value, null)
    return value
  })
}

/**
 * Whether a value from {@link parseJsonLossless} is one of its objects. An array
 * or a `JsonNumber` keeps its prototype, so a key it lacks reads through to
 * Object.prototype: a reply field is read from an object this accepts, with
 * `ownValue`.
 */
export function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof JsonNumber)
}

/**
 * Arrays and objects a request body may nest, its envelope included: as deep
 * as qbit Core v1.0.0 parses (it answers a deeper body with HTTP 500 `Parse
 * error`), and a fixed bound on the serializer's recursion, whatever the
 * caller's stack holds.
 */
const MAX_REQUEST_DEPTH = 512

/**
 * Serialize a request from own data only, writing what `JSON.stringify`
 * writes for it: an object's own enumerable string keys, each read once, and
 * an array's own elements, a hole being a TypeError rather than what a
 * prototype holds at that index. A `toJSON` applies when the value or its
 * class defines it (a `JsonNumber`, a `Date`), never one on Object.prototype
 * or Array.prototype, and a bigint is always an integer literal, whatever
 * BigInt.prototype holds. `JsonNumber`s and `JSON.rawJSON` values are written
 * as their text; NaN and Infinity are refused, and so is nesting deeper than
 * {@link MAX_REQUEST_DEPTH}, where `JSON.stringify` would go on; `nestedIn`
 * counts the arrays and objects `value` will be written inside (a request
 * envelope around its params, a batch's array around an envelope).
 */
export function stringifyRequest(value: unknown, nestedIn = 0): string {
  const text = serialize(value, '', new Set(), MAX_REQUEST_DEPTH - nestedIn)
  if (text === undefined) throw new TypeError('an RPC request must be a JSON value')
  return text
}

function serialize(value: unknown, key: string, open: Set<object>, maxDepth: number): string | undefined {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    if (json.isRawJSON(value)) return value.rawJSON
    const toJSON = classToJSON(value)
    if (toJSON !== undefined) value = toJSON.call(value, key)
  }
  if (types.isBoxedPrimitive(value)) value = unbox(value)
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('RPC parameters must not contain NaN or Infinity')
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'bigint':
      return value.toString()
    case 'object':
      break
    default:
      // undefined, a function or a symbol: left out of an object, null in an array.
      return undefined
  }
  if (value === null) return 'null'
  if (json.isRawJSON(value)) return value.rawJSON
  if (open.has(value)) throw new TypeError('RPC parameters must not contain a circular structure')
  // `open` holds the arrays and objects this one is nested in.
  if (open.size >= maxDepth) {
    throw new TypeError(
      `RPC parameters must not nest deeper than ${MAX_REQUEST_DEPTH} arrays and objects, the request envelope included`
    )
  }
  open.add(value)
  try {
    if (Array.isArray(value)) {
      const items: string[] = []
      const length = value.length
      for (let index = 0; index < length; index++) {
        if (!Object.hasOwn(value, index)) throw new TypeError('RPC parameters must not contain an array hole')
        items.push(serialize(value[index], String(index), open, maxDepth) ?? 'null')
      }
      return `[${items.join(',')}]`
    }
    const members: string[] = []
    for (const name of Object.keys(value)) {
      const item = serialize((value as Record<string, unknown>)[name], name, open, maxDepth)
      if (item !== undefined) members.push(`${JSON.stringify(name)}:${item}`)
    }
    return `{${members.join(',')}}`
  } finally {
    open.delete(value)
  }
}

/** The `toJSON` of `value` or its class, if it has one: a polluted Object.prototype's or Array.prototype's never applies. */
function classToJSON(value: object): ((key: string) => unknown) | undefined {
  for (let holder: object | null = value; holder !== null; holder = Object.getPrototypeOf(holder)) {
    if (!Object.hasOwn(holder, 'toJSON')) continue
    if (holder === Object.prototype || holder === Array.prototype) return undefined
    const toJSON: unknown = Reflect.get(holder, 'toJSON', value)
    return typeof toJSON === 'function' ? (toJSON as (key: string) => unknown) : undefined
  }
  return undefined
}

/** A `new Number(1)`, `new String('a')`, `new Boolean(true)` or `Object(1n)` as its primitive, as JSON.stringify writes it. */
function unbox(value: object): unknown {
  if (types.isNumberObject(value)) return Number.prototype.valueOf.call(value)
  if (types.isStringObject(value)) return String.prototype.valueOf.call(value)
  if (types.isBooleanObject(value)) return Boolean.prototype.valueOf.call(value)
  if (types.isBigIntObject(value)) return BigInt.prototype.valueOf.call(value)
  return value
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
  if (source !== '1.10' || typeof json.rawJSON !== 'function' || typeof json.isRawJSON !== 'function') {
    throw new Error('@qbit-oss/rpc needs JSON.parse source text access and JSON.rawJSON (Node.js 22 or later)')
  }
}
