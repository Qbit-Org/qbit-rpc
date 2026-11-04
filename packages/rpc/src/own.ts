// Reading a caller's objects and arrays by their own data only. A polluted
// Object.prototype (a JSON merge of attacker input is the usual way) puts a key
// on every object, and Array.prototype an element at every hole: neither may
// supply a value to a request, a client setting or a credential. Every input
// boundary reads through these: builder and call options, the client's options,
// auth and tls, batch entries and call() params. A reply's envelope and error are
// read with ownValue too: parseJsonLossless makes objects without a prototype,
// but the arrays and JsonNumbers it makes keep theirs. The transport reads what
// it takes from the objects Node builds (connection options, a certificate's
// subject) with ownProperties.

/** An omitted options object: an empty object without a prototype, so every key reads as undefined. */
export const NO_OPTIONS: Readonly<Record<string, never>> = Object.freeze(Object.create(null) as Record<string, never>)

/** The keys of `T`, listed in full: the compiler refuses a missing or an extra one. */
export function keysOf<T>(keys: { readonly [K in keyof Required<T>]: true }): readonly string[] {
  return Object.keys(keys)
}

/**
 * The values of `keys` in `value`, each read once from its own enumerable
 * properties (a getter on the object itself runs once), in an object without a
 * prototype: a key left out reads as undefined whatever Object.prototype holds.
 * Other keys are not read. A key of `keys` that `value` holds any other way
 * (inherited, a class's getter, not enumerable, on a polluted Object.prototype,
 * left out of a Proxy's own keys, or answered only by its `get` trap) is a
 * `TypeError` naming it: read, its value would not be the caller's own;
 * ignored, the call would do less than the caller asked for, such as trusting
 * the system's CAs where `tls.ca` was given.
 */
export function plainOptions<K extends string>(
  value: object,
  name: string,
  keys: readonly K[]
): Readonly<Partial<Record<K, unknown>>> {
  const own = Object.create(null) as Partial<Record<K, unknown>>
  for (const key of Object.keys(value)) {
    if ((keys as readonly string[]).includes(key)) own[key as K] = (value as Record<string, unknown>)[key]
  }
  for (const key of keys) {
    // A Proxy can answer for a key it neither lists nor says it has: only a `get` trap.
    if ((key in value || (value as Record<string, unknown>)[key] !== undefined) && !Object.hasOwn(own, key)) {
      throw new TypeError(
        `${name}.${key} is not an own enumerable property (it is inherited, a class getter or on a polluted Object.prototype): pass a plain object`
      )
    }
  }
  return own
}

/**
 * `value`'s own elements, read once each, in a new array. A hole (an index
 * below `length` that is not the array's own) is a `TypeError` naming it,
 * rather than whatever Array.prototype or Object.prototype holds at that index.
 */
export function ownElements(value: readonly unknown[], name: string): unknown[] {
  const length = value.length
  const elements: unknown[] = []
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${name}[${index}] is a hole, not an own element: pass an array without holes`)
    }
    elements.push(value[index])
  }
  return elements
}

/**
 * `value`'s own enumerable properties, as `{ ...value }` copies them, in an
 * object without a prototype: a key it leaves out reads as undefined. For an
 * object Node builds, whose keys are Node's (connection options, a
 * certificate's subject), where {@link plainOptions} would refuse what Node
 * leaves out.
 */
export function ownProperties(value: object): Readonly<Record<string, unknown>> {
  const own = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value)) own[key] = (value as Record<string, unknown>)[key]
  return own
}

/** `value[key]` when it is `value`'s own property, else undefined: for an object whose inherited keys are simply absent. */
export function ownValue<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined
}

/** Whether `value` inherits `key` from Object.prototype: a key a polluted prototype puts on every object, which no caller set. */
export function fromObjectPrototype(value: object, key: string): boolean {
  if (Object.hasOwn(value, key)) return false
  for (let o: object | null = Object.getPrototypeOf(value); o !== null; o = Object.getPrototypeOf(o)) {
    if (Object.hasOwn(o, key)) return o === Object.prototype
  }
  return false
}

/** The call options a client method or `batch()` takes as its last argument; never a request's own option. */
export const CALL_OPTION_KEYS = ['signal', 'timeoutMs'] as const
const CALL_OPTIONS_PLACE = 'the call options, the last argument of the client method or of batch()'

/**
 * An options or arguments object that may hold only `keys` and `ignored`
 * keys, which are allowed and not read. Any other enumerable key throws a
 * `TypeError` naming it, with the key it most likely meant: a key read
 * nowhere would be dropped silently, and TypeScript's excess-property check
 * misses spread objects, JavaScript callers and options built from
 * configuration. With `callOptions`, a call option, or a key that most likely
 * meant one, is pointed to the client method's call options instead.
 *
 * Returns the values of `keys` as {@link plainOptions} reads them, a key
 * held other than as the object's own enumerable property being a
 * `TypeError`; an omitted object reads as empty.
 */
export function argOptions(
  value: unknown,
  name: string,
  keys: readonly string[],
  settings: { readonly ignored?: readonly string[]; readonly callOptions?: boolean } = NO_OPTIONS
): Readonly<Record<string, unknown>> {
  const ignored = ownValue(settings, 'ignored') ?? []
  const callOptions = ownValue(settings, 'callOptions') === true
  if (value === undefined) return NO_OPTIONS
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be an object`)
  for (const key in value) {
    if (keys.includes(key) || ignored.includes(key) || fromObjectPrototype(value, key)) continue
    throw new TypeError(unknownKey(name, key, keys, callOptions))
  }
  return plainOptions(value, name, keys)
}

/** An array argument's own elements; see {@link ownElements}. */
export function argArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`)
  return ownElements(value, name)
}

/** Case, `_` and `-` aside: `subtract_fee_from_outputs` matches `subtractFeeFromOutputs`. */
const looseKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, '')

/** What a key gains with its unit suffix: the node's `fee_rate` is bits/vB, `feeRateBitsPerKvB` bits per 1,000 vB. */
const UNIT_NOTES: Readonly<Record<string, string>> = {
  bits: ', a bigint in bits (1 QBT is 100,000,000 bits)',
  bitsperkvb: ', a bigint in bits per 1,000 vbytes (1000n is 1 bit/vB)',
  ms: ', in milliseconds',
}

/**
 * Keys this package names in a message: a near-miss of a known key, or a
 * short identifier in an options object, as option names are. The keys of an
 * array entry (`outputs[0]`) are never named otherwise: there the node's own
 * format puts data in keys (`{ "<address>": amount }`), and messages never
 * include request parameters.
 */
const NAMEABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/

/** The key among `keys` that `key` most likely meant, with what its unit suffix adds. */
function meantKey(key: string, keys: readonly string[]): { readonly key: string; readonly note: string } | undefined {
  // The node's spelling, or this package's without its unit or plural (fee_rate, minimumAmount, timeout).
  const loose = looseKey(key)
  for (const suffix of ['', 's', 'bits', 'bitsperkvb', 'ms']) {
    const meant = keys.find(known => looseKey(known) === `${loose}${suffix}`)
    if (meant !== undefined) return { key: meant, note: Object.hasOwn(UNIT_NOTES, suffix) ? UNIT_NOTES[suffix]! : '' }
  }
  return undefined
}

function unknownKey(name: string, key: string, keys: readonly string[], callOptions: boolean): string {
  if (callOptions && (CALL_OPTION_KEYS as readonly string[]).includes(key)) {
    return `${name}.${key} is a call option: pass it in ${CALL_OPTIONS_PLACE}`
  }
  const meant = meantKey(key, keys)
  if (meant !== undefined) return `${name}.${key} is not a known key: use ${name}.${meant.key}${meant.note}`
  const call = callOptions ? meantKey(key, CALL_OPTION_KEYS) : undefined
  if (call !== undefined)
    return `${name}.${key} is not a known key: use ${call.key}${call.note}, in ${CALL_OPTIONS_PLACE}`
  if (name.endsWith(']') || !NAMEABLE_KEY.test(key)) {
    return `${name} has an unknown key (not shown); the known keys are ${keys.join(', ')}`
  }
  return `${name}.${key} is not a known key; the known keys are ${keys.join(', ')}`
}
