import { expect } from 'vitest'

/**
 * Puts `values` on Object.prototype while `run` runs, and removes them after.
 * Enumerable by default, as JSON parsed into a deep merge puts them there: the
 * client then refuses every call, `prototype_polluted`. Not enumerable, as a
 * polyfill defines its methods, they pass that check, and test what lies
 * behind it: the own options the client sets and the certificate fields it
 * reads.
 */
export async function onPrototype<T>(
  values: Readonly<Record<string, unknown>>,
  run: () => Promise<T>,
  { enumerable = true }: { readonly enumerable?: boolean } = {}
): Promise<T> {
  const proto = Object.prototype as Record<string, unknown>
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(proto, key, { value, enumerable, writable: true, configurable: true })
  }
  try {
    return await run()
  } finally {
    for (const key of Object.keys(values)) delete proto[key]
  }
}

/** Runs `run`, and fails if the process saw an uncaught error meanwhile, which a real process dies of. */
export async function withoutCrash<T>(run: () => Promise<T>, settleMs = 20): Promise<T> {
  const crashes: unknown[] = []
  const onCrash = (error: unknown): void => void crashes.push(error)
  process.on('uncaughtException', onCrash)
  try {
    const result = await run()
    await new Promise(resolve => setTimeout(resolve, settleMs))
    expect(crashes).toEqual([])
    return result
  } finally {
    process.removeListener('uncaughtException', onCrash)
  }
}
