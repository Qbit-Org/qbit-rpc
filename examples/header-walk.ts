// Follow a testnet4 node's active chain header by header, a batch of heights
// per round trip, and notice reorgs: when a block the walk has passed leaves
// the active chain, walk back to the fork and on along the new branch. Between
// walks, a long poll waits for the next block.
//
//   QBIT_COOKIE_FILE=<the node's .cookie> node header-walk.ts
//
// See docs/rpc/methods.md#batches. CI type-checks this file against the packed packages.
import { QbitRpcClient, requests, RpcError, type BatchItem, type BlockHeader } from '@qbit-oss/rpc'

/** Heights per batch: two round trips each, one for the hashes and one for the headers. */
const BATCH = 100

/** The active chain as the walk has seen it, by height: kept in memory here, in your database in a service. */
class HeaderChain {
  readonly #hashes: string[] = []

  /** The height of the last block walked, -1 before the genesis block. */
  get height(): number {
    return this.#hashes.length - 1
  }

  hashAt(height: number): string | undefined {
    return this.#hashes[height]
  }

  append(header: BlockHeader): void {
    if (header.height !== this.#hashes.length) throw new Error(`header ${header.height} out of order`)
    this.#hashes.push(header.hash)
  }

  /** Forget the blocks above `height`: they left the active chain. */
  truncate(height: number): void {
    this.#hashes.length = height + 1
  }
}

/** A batch entry's value, or its error thrown. */
function value<T>(item: BatchItem<T> | undefined): T {
  if (item === undefined) throw new Error('a batch reply without every entry')
  if (!item.ok) throw item.error
  return item.value
}

function heights(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)
}

/** The highest height whose block the walk and the node's active chain share, or -1 for none. */
async function forkHeight(rpc: QbitRpcClient, chain: HeaderChain, signal: AbortSignal): Promise<number> {
  for (let top = chain.height; top >= 0; top -= BATCH) {
    const window = heights(Math.max(0, top - BATCH + 1), top)
    // A height past the node's tip is an RpcError -8 for that entry alone: not shared either.
    const hashes = await rpc.batch(
      window.map(height => requests.getBlockHash(height)),
      { signal }
    )
    for (let i = window.length - 1; i >= 0; i -= 1) {
      const item = hashes[i]
      if (item === undefined) throw new Error('a batch reply without every entry')
      if (item.ok) {
        if (item.value === chain.hashAt(window[i]!)) return window[i]!
        continue
      }
      // Only -8 means the height is past the node's tip; any other failure says nothing about a fork.
      if (!RpcError.is(item.error) || item.error.rpcCode !== -8) throw item.error
    }
  }
  return -1
}

/** Walk from the last block walked to the node's tip. Returns once caught up. */
async function walk(rpc: QbitRpcClient, chain: HeaderChain, signal: AbortSignal): Promise<void> {
  for (;;) {
    const fork = await forkHeight(rpc, chain, signal)
    if (fork < chain.height) {
      console.log(`reorg: blocks ${fork + 1} to ${chain.height} left the active chain`)
      chain.truncate(fork)
    }
    const tip = await rpc.getBlockCount({ signal })
    let reorged = false
    for (let from = chain.height + 1; from <= tip && !reorged; from += BATCH) {
      const window = heights(from, Math.min(tip, from + BATCH - 1))
      const hashes = await rpc.batch(
        window.map(height => requests.getBlockHash(height)),
        { signal }
      )
      const failed = hashes.find(item => !item.ok)
      if (failed !== undefined && !failed.ok) {
        // -8: past the tip, as the chain got shorter since getBlockCount.
        if (!RpcError.is(failed.error) || failed.error.rpcCode !== -8) throw failed.error
        reorged = true
        break
      }
      const headers = await rpc.batch(
        hashes.map(item => requests.getBlockHeader(value(item))),
        { signal }
      )
      for (const item of headers) {
        const header = value(item)
        // The chain can change between the two batches, or since the last one:
        // a block off the active chain, or one not built on the last block walked.
        if (header.confirmations === -1 || header.previousBlockHash !== chain.hashAt(header.height - 1)) {
          reorged = true
          break
        }
        chain.append(header)
      }
    }
    if (!reorged) return
  }
}

const cookieFile = process.env.QBIT_COOKIE_FILE
if (cookieFile === undefined) throw new Error('usage: QBIT_COOKIE_FILE=<the node .cookie> node header-walk.ts')
const rpc = new QbitRpcClient({
  url: 'http://127.0.0.1:48352/', // testnet4's RPC port
  auth: { cookieFile },
  expectedChain: 'testnet4',
})
const chain = new HeaderChain()
const stop = new AbortController()
process.once('SIGINT', () => stop.abort())

try {
  // Walk nothing from another chain: reads need no chain check, but this one is cheap.
  await rpc.confirmChain({ signal: stop.signal })
  while (!stop.signal.aborted) {
    await walk(rpc, chain, stop.signal)
    const tip = chain.hashAt(chain.height)!
    console.log(`at ${chain.height}: ${tip}`)
    // Returns at a new tip, or after a minute with the same one.
    await rpc.waitForNewBlock(60_000, { currentTip: tip }, { signal: stop.signal })
  }
} catch (error) {
  if (!stop.signal.aborted) throw error
} finally {
  rpc.close()
}
