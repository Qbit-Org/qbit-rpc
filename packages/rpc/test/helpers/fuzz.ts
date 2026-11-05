import type { Parameters } from 'fast-check'

/**
 * fast-check settings for the property tests. By default each property runs
 * its own fixed number of times from a fixed seed, so `pnpm test` is
 * deterministic and stays within its time budget. A manual fuzz sets
 * `QBIT_FUZZ_RUNS` to the number of runs for every property, from a random
 * seed that a failure prints; `QBIT_FUZZ_SEED` replays one.
 */
const SEED = 13

function integerEnv(name: string, pattern: RegExp, min: number, max: number): number | undefined {
  const text = process.env[name]
  if (text === undefined || text === '') return undefined
  const value = Number(text)
  if (!pattern.test(text) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}, not ${JSON.stringify(text)}`)
  }
  return value
}

const runs = integerEnv('QBIT_FUZZ_RUNS', /^[1-9][0-9]*$/, 1, 100_000_000)
// fast-check prints a failing run's seed, a signed 32-bit integer.
const seed = integerEnv('QBIT_FUZZ_SEED', /^-?(?:0|[1-9][0-9]*)$/, -0x8000_0000, 0x7fff_ffff)

/** Whether a manual fuzz is running: its properties may take far longer than the default budget. */
export const fuzzing = runs !== undefined

/** The parameters of one property, `defaultRuns` times unless a manual fuzz sets the count. */
export function fuzz<T>(defaultRuns: number): Parameters<T> {
  if (runs === undefined) return { numRuns: defaultRuns, seed: seed ?? SEED }
  return seed === undefined ? { numRuns: runs } : { numRuns: runs, seed }
}

/** A test timeout for a property: the default run counts fit well within it; a manual fuzz has an hour. */
export const FUZZ_TIMEOUT_MS = fuzzing ? 3_600_000 : 30_000
