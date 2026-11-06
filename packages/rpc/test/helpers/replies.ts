import { readdirSync, readFileSync } from 'node:fs'

import fc from 'fast-check'

import { JsonNumber } from '../../src'
import { parseJsonLossless } from '../../src/json'

/** Number texts a misbehaving node or proxy could send: boundaries, decimals, exponents, huge and negative values. */
export const numberText: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '0',
    '-0',
    '1',
    '-1',
    '0.5',
    '1.0',
    '1e3',
    '1E-8',
    '0.00000001',
    '0.000000001',
    '-0.00000001',
    '210000000',
    '210000000.00000001',
    '2147483647',
    '2147483648',
    '4294967295',
    '4294967296',
    '9007199254740991',
    '9007199254740992',
    '-9007199254740992',
    '18446744073709551616',
    '1e400',
    '123456789012345678901234567890'
  ),
  fc.integer().map(String),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map(value => JSON.stringify(value))
)

/** Strings a validator meets: hashes and hex in either case, base64, addresses and junk. */
export const replyString: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('', ' ', 'a'.repeat(64), 'A'.repeat(64), 'g'.repeat(64), 'ab', 'abc', 'AA==', 'AAA=', 'AAAA', 'A==='),
  fc.uint8Array({ maxLength: 40 }).map(b => Buffer.from(b).toString('hex')),
  fc.uint8Array({ minLength: 32, maxLength: 32 }).map(b => Buffer.from(b).toString('hex')),
  fc.uint8Array({ maxLength: 30 }).map(b => Buffer.from(b).toString('base64')),
  fc.string({ maxLength: 20 })
)

/** Any value a JSON reply can hold, as the client hands it to a validator: every number a JsonNumber. */
export const replyValue: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>(tie => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    numberText.map(text => new JsonNumber(text)),
    replyString,
    fc.array(tie('value'), { maxLength: 3 }),
    fc.dictionary(fc.oneof(replyString, fc.constantFrom('__proto__', 'constructor', 'toString')), tie('value'), {
      maxKeys: 3,
    })
  ),
})).value

/** A fixture argument as JSON: a bigint is written { "$bigint": "<digits>" }. */
function decodeArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeArgs)
  if (value instanceof JsonNumber) return value.toNumber()
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    if (entries.length === 1 && entries[0]![0] === '$bigint') return BigInt(entries[0]![1] as string)
    return Object.fromEntries(entries.map(([k, v]) => [k, decodeArgs(v)]))
  }
  return value
}

/** A reply captured from qbit Core v1.0.0 on regtest by scripts/capture-rpc-fixtures.mjs. */
export interface Fixture {
  readonly name: string
  readonly description: string
  /** The `requests` builder, and the client method, of the same name. */
  readonly builder: string
  readonly args: readonly unknown[]
  readonly method: string
  /** The params as sent, numbers as JsonNumber. */
  readonly params: readonly unknown[]
  /** The result, numbers as JsonNumber, as the client hands it to the validator. */
  readonly result: unknown
}

const DIR = new URL('../fixtures/regtest/', import.meta.url)

export function loadFixtures(): Fixture[] {
  return readdirSync(DIR)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => {
      const parsed = parseJsonLossless(readFileSync(new URL(file, DIR), 'utf8')) as Omit<Fixture, 'name'>
      return { ...parsed, name: file.slice(0, -'.json'.length), args: decodeArgs(parsed.args) as unknown[] }
    })
}

/** A deep copy of a reply value: JsonNumbers are immutable and shared. */
/**
 * The client method's arguments for a fixture: its builder's, and for
 * `walletProcessPsbt` with `pqcCheck: false`, since a node answering only the
 * captured call answers none of the PQC check's.
 */
export function clientArgs(f: Fixture): unknown[] {
  if (f.builder !== 'walletProcessPsbt') return [...f.args]
  const [psbt, options] = f.args
  return [psbt, { ...(options as object | undefined), pqcCheck: false }]
}

export function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone)
  if (typeof value === 'object' && value !== null && !(value instanceof JsonNumber)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]))
  }
  return value
}

/** A location in a reply: the keys and indices from the result down. */
export type Path = readonly (string | number)[]

/** Every path in `value`, the root first. Long arrays contribute their first and last items only. */
export function paths(value: unknown, at: Path = []): Path[] {
  const out: Path[] = [at]
  if (Array.isArray(value)) {
    const indices = value.length <= 2 ? value.map((_, i) => i) : [0, value.length - 1]
    for (const i of indices) out.push(...paths(value[i], [...at, i]))
  } else if (typeof value === 'object' && value !== null && !(value instanceof JsonNumber)) {
    for (const [key, item] of Object.entries(value)) out.push(...paths(item, [...at, key]))
  }
  return out
}

export function get(value: unknown, path: Path): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], value)
}

/** The validator's name for `path`, as `ResultIssue.path` and `RpcResponseError.path` give it. */
export function pathName(path: Path): string {
  return path.reduce<string>((name, key) => (typeof key === 'number' ? `${name}[${key}]` : `${name}.${key}`), 'result')
}

/** A copy of `root` with the value at `path` replaced, or removed when `replacement` is the REMOVE marker. */
export const REMOVE: unique symbol = Symbol('remove')
export function mutate(root: unknown, path: Path, replacement: unknown): unknown {
  if (path.length === 0) return replacement
  const copy = clone(root)
  const parent = get(copy, path.slice(0, -1)) as Record<string | number, unknown> | unknown[]
  const key = path[path.length - 1]!
  if (replacement !== REMOVE) (parent as Record<string | number, unknown>)[key] = replacement
  else if (Array.isArray(parent)) parent.splice(key as number, 1)
  else delete (parent as Record<string, unknown>)[key]
  return copy
}

function isJsonNumber(text: string): boolean {
  try {
    return new JsonNumber(text).source === text
  } catch {
    return false
  }
}

/** Replacements for the value at a path, each a plausible mistake by a node, proxy or attacker. */
export function replacements(value: unknown): unknown[] {
  const out: unknown[] = [
    REMOVE,
    null,
    true,
    '',
    'x',
    new JsonNumber('0'),
    new JsonNumber('-1'),
    new JsonNumber('1.5'),
    new JsonNumber('1e3'),
    new JsonNumber('-0'),
    new JsonNumber('0.000000001'),
    new JsonNumber('210000000.00000001'),
    new JsonNumber('9007199254740993'),
    new JsonNumber('123456789012345678901234567890'),
    [],
    {},
    [clone(value)],
    { value: clone(value) },
  ]
  if (typeof value === 'string') {
    out.push(value.toUpperCase(), `${value}0`, value.slice(0, -1), `${value}==`, ` ${value}`)
    out.push(new JsonNumber(/^-?(?:0|[1-9][0-9]*)$/.test(value) ? value : '1'))
  }
  if (value instanceof JsonNumber) {
    const source = value.source
    const negated = source.startsWith('-') ? source.slice(1) : `-${source}`
    for (const text of [negated, `${source}0`, `${source}e1`, `${source}.5`, `${source}.0`, `${source}00000000`]) {
      if (isJsonNumber(text)) out.push(new JsonNumber(text))
    }
    out.push(source)
  }
  if (typeof value === 'boolean') out.push(!value, value ? new JsonNumber('1') : new JsonNumber('0'), String(value))
  if (Array.isArray(value)) out.push([...value.map(clone), ...value.map(clone)], value.slice(1).map(clone))
  return out
}
