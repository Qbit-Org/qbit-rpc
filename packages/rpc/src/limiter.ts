/**
 * A FIFO counting semaphore. A released slot passes straight to the oldest
 * waiter, so a newcomer cannot overtake the queue, and a waiter that gives up
 * leaves the queue holding nothing.
 */
export class Limiter {
  readonly #max: number
  /** Slots in use. While anyone waits, this equals `#max`. */
  #held = 0
  /** In insertion order, with removal from the middle when a waiter gives up. */
  readonly #waiters = new Set<() => void>()

  constructor(max: number) {
    this.#max = max
  }

  /**
   * Take a slot, waiting for one if need be; the caller then owes one
   * `release()`. Rejects with the signal's reason if it fires first, and then
   * no slot is held.
   */
  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (this.#held < this.#max) {
      this.#held += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        this.#waiters.delete(grant)
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#waiters.add(grant)
    })
  }

  release(): void {
    const [next] = this.#waiters
    if (next === undefined) {
      this.#held -= 1
      return
    }
    this.#waiters.delete(next)
    next()
  }
}
