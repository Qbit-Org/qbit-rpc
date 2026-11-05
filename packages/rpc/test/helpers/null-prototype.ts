/**
 * `value` with every plain object in it rebuilt without a prototype, as the
 * client returns results and replies: compare one with
 * `toStrictEqual(bare({ ... }))`, which also checks the prototypes.
 */
export function bare<T>(value: T): T {
  if (Array.isArray(value)) return value.map(bare) as T
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = Object.create(null) as Record<string, unknown>
    for (const [key, item] of Object.entries(value)) out[key] = bare(item)
    return out as T
  }
  return value
}

/** The paths of the objects in `value` (arrays and class instances such as JsonNumber aside) that have a prototype. */
export function withPrototype(value: unknown, path = 'result'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => withPrototype(item, `${path}[${index}]`))
  if (value === null || typeof value !== 'object') return []
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return []
  return [
    ...(prototype === null ? [] : [path]),
    ...Object.entries(value).flatMap(([key, item]) => withPrototype(item, `${path}.${key}`)),
  ]
}
