import type { ServerResponse } from 'node:http'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QbitRpcClient, requests, RpcTimeoutError, RpcUnknownOutcomeError, type QbitRpcClientOptions } from '../src'
import { chainResults, FakeNode, HASH_A } from './helpers/fake-node'

// Taken before any test fakes the timers: waits for the fake node's real I/O.
const realSetTimeout = setTimeout
const settle = (ms = 20): Promise<void> => new Promise(resolve => realSetTimeout(resolve, ms))

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
})
afterEach(async () => {
  vi.useRealTimers()
  await node.close()
})

async function confirmed(options: Partial<QbitRpcClientOptions> = {}): Promise<QbitRpcClient> {
  node.results(chainResults('regtest'))
  const rpc = new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-read', 'wallet-write'],
    // The confirmation stays fresh however far the fake clock moves.
    chainCheckMaxAgeMs: 86_400_000,
    ...options,
  })
  await rpc.confirmChain()
  node.requests.length = 0
  return rpc
}

/** Fake setTimeout only: the client's deadline timers follow it, the sockets and `performance.now()` do not. */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

/** A call's outcome, and whether it has settled yet. */
function track(promise: Promise<unknown>): { settled: boolean; readonly outcome: Promise<unknown> } {
  const tracked = {
    settled: false,
    outcome: promise.then(
      value => ({ value }),
      (error: unknown) => error
    ),
  }
  void tracked.outcome.then(() => (tracked.settled = true))
  return tracked
}

/** Wait (in real time) until the node has seen `count` requests. */
async function sent(count: number): Promise<void> {
  for (let waited = 0; node.requests.length < count; waited += 5) {
    if (waited > 5_000) throw new Error(`the node saw ${node.requests.length} requests, not ${count}`)
    await settle(5)
  }
}

const unknownAfter = (timeoutMs: number, method = 'walletpassphrase') => ({
  name: 'RpcUnknownOutcomeError',
  method,
  cause: { name: 'RpcTimeoutError', method, timeoutMs },
})

describe('the default deadline of walletPassphrase and walletLock', () => {
  it('is 120 s, typed or through call(), while every other method keeps 30 s', async () => {
    const rpc = await confirmed()
    node.handler = () => {} // the node never answers
    fakeClock()
    const unlock = track(rpc.walletPassphrase('pw', 60))
    const raw = track(rpc.call('walletpassphrase', ['pw', 60]))
    const lock = track(rpc.walletLock())
    const others = [
      track(rpc.getNewAddress()),
      track(rpc.getWalletInfo()),
      track(rpc.call('getblockcount')),
      track(rpc.batch([requests.getBlockCount()])),
      track(rpc.confirmChain()),
    ]
    await sent(8)

    await vi.advanceTimersByTimeAsync(29_999)
    await settle()
    expect(others.some(call => call.settled)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await Promise.all(others.map(call => call.outcome))).toMatchObject([
      unknownAfter(30_000, 'getnewaddress'),
      { name: 'RpcTimeoutError', method: 'getwalletinfo', timeoutMs: 30_000 },
      { name: 'RpcTimeoutError', method: 'getblockcount', timeoutMs: 30_000 },
      { name: 'RpcTimeoutError', method: 'batch(1)', timeoutMs: 30_000 },
      { name: 'RpcTimeoutError', method: 'getblockchaininfo', timeoutMs: 30_000 },
    ])

    await vi.advanceTimersByTimeAsync(89_999)
    await settle()
    expect(unlock.settled || raw.settled || lock.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await unlock.outcome).toMatchObject(unknownAfter(120_000))
    expect(await raw.outcome).toMatchObject(unknownAfter(120_000))
    expect(await lock.outcome).toMatchObject(unknownAfter(120_000, 'walletlock'))
    expect(RpcUnknownOutcomeError.is(await unlock.outcome)).toBe(true)
  })

  it('keeps 120 s under a shorter client timeoutMs, and takes a longer one', async () => {
    const short = await confirmed({ timeoutMs: 100 })
    node.handler = () => {}
    fakeClock()
    const kept = track(short.walletPassphrase('pw', 60))
    const keptLock = track(short.walletLock())
    const rawLock = track(short.call('walletlock'))
    await sent(3)
    await vi.advanceTimersByTimeAsync(119_999)
    await settle()
    expect(kept.settled || keptLock.settled || rawLock.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await kept.outcome).toMatchObject(unknownAfter(120_000))
    expect(await keptLock.outcome).toMatchObject(unknownAfter(120_000, 'walletlock'))
    expect(await rawLock.outcome).toMatchObject(unknownAfter(120_000, 'walletlock'))
    vi.useRealTimers()
    // Every other method takes the client's.
    expect(await track(short.getBlockCount()).outcome).toMatchObject({ timeoutMs: 100 })

    const long = await confirmed({ timeoutMs: 200_000 })
    node.handler = () => {}
    fakeClock()
    const unlock = track(long.walletPassphrase('pw', 60))
    const lock = track(long.walletLock())
    await sent(2)
    await vi.advanceTimersByTimeAsync(199_999)
    await settle()
    expect(unlock.settled || lock.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await unlock.outcome).toMatchObject(unknownAfter(200_000))
    expect(await lock.outcome).toMatchObject(unknownAfter(200_000, 'walletlock'))
  })

  it("gives way to the call's timeoutMs, which also beats the client's", async () => {
    const rpc = await confirmed()
    node.handler = () => {}
    expect(await track(rpc.walletPassphrase('pw', 60, { timeoutMs: 80 })).outcome).toMatchObject(unknownAfter(80))

    const client = await confirmed({ timeoutMs: 5_000 })
    node.handler = () => {}
    expect(await track(client.walletPassphrase('pw', 60, { timeoutMs: 50 })).outcome).toMatchObject(unknownAfter(50))
    expect(await track(client.walletLock({ timeoutMs: 50 })).outcome).toMatchObject(unknownAfter(50, 'walletlock'))
    expect(await track(client.getBlockCount({ timeoutMs: 60 })).outcome).toMatchObject({ timeoutMs: 60 })
  })

  it('still refuses an invalid call timeoutMs before sending anything', async () => {
    const rpc = await confirmed()
    await expect(rpc.walletPassphrase('pw', 60, { timeoutMs: 0 })).rejects.toThrow(RangeError)
    await expect(rpc.walletPassphrase('pw', 60, { timeoutMs: 3_600_001 })).rejects.toThrow(RangeError)
    await expect(rpc.walletLock({ timeoutMs: 0 })).rejects.toThrow(RangeError)
    expect(node.requests).toHaveLength(0)
  })
})

describe("the README's unlock examples", () => {
  /** qbit Core's reply to `call`, a single JSON-RPC request. */
  const reply = (response: ServerResponse, id: unknown, result: string): void => {
    response.setHeader('content-type', 'application/json')
    response.end(`{"jsonrpc":"2.0","result":${result},"id":${JSON.stringify(id)}}`)
  }
  const walletInfo = (unlockedUntil: number | undefined): string =>
    JSON.stringify({
      walletname: 'w',
      walletversion: 169900,
      format: 'sqlite',
      txcount: 0,
      keypoolsize: 1000,
      keypoolsize_hd_internal: 1000,
      unlocked_until: unlockedUntil,
      paytxfee: 0,
      private_keys_enabled: true,
      avoid_reuse: false,
      scanning: false,
      descriptors: true,
      pqc_key_validation: {
        status: 'complete',
        progress: 1,
        plaintext_records: 0,
        pending_records: 0,
        validated_records: 2,
        failed_records: 0,
        signing_blocked: false,
        encryption_recommended: false,
      },
      external_signer: false,
      blank: false,
      birthtime: 1700000000,
      flags: ['descriptor_wallet'],
      lastprocessedblock: { hash: HASH_A, height: 10 },
    })

  /**
   * A new encrypted wallet whose first walletpassphrase takes `unlockMs` (on
   * the fake clock), as its deferred keypool top-up runs. Every other call
   * on the wallet waits for it, as getwalletinfo waits for qbit Core's
   * cs_wallet, then sees the wallet unlocked.
   */
  function firstUnlockTaking(unlockMs: number): void {
    let unlocked = false
    const waiting: (() => void)[] = []
    node.handler = (request, response) => {
      const { id, method } = JSON.parse(request.body) as { id: unknown; method: string }
      if (method === 'walletpassphrase') {
        setTimeout(() => {
          unlocked = true
          if (!response.destroyed) reply(response, id, 'null')
          for (const answer of waiting.splice(0)) answer()
        }, unlockMs)
      } else if (method === 'getwalletinfo') {
        const answer = (): void => reply(response, id, walletInfo(unlocked ? 1_800_000_000 : 0))
        if (unlocked) answer()
        else waiting.push(answer)
      } else if (method === 'walletlock') {
        const answer = (): void => reply(response, id, 'null')
        if (unlocked) answer()
        else waiting.push(answer)
      }
    }
  }

  it('keeps 120 s for the first unlock under a short client timeoutMs, unless the call sets its own', async () => {
    const rpc = await confirmed({ timeoutMs: 10_000 }) // every call; these two keep 120 s
    firstUnlockTaking(49_000)
    fakeClock()
    const unlock = track(rpc.walletPassphrase('pw', 60)) // 120 s
    const lock = track(rpc.walletLock()) // 120 s, and waits for the unlock
    const read = track(rpc.getWalletInfo()) // the client's 10 s
    await sent(3)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await read.outcome).toMatchObject({ name: 'RpcTimeoutError', method: 'getwalletinfo', timeoutMs: 10_000 })
    expect(unlock.settled || lock.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(39_000)
    expect(await unlock.outcome).toEqual({ value: undefined })
    expect(await lock.outcome).toEqual({ value: undefined })

    // The call's own timeoutMs wins, even a shorter one.
    const again = await confirmed({ timeoutMs: 10_000 })
    firstUnlockTaking(49_000)
    const failed = track(again.walletPassphrase('pw', 60, { timeoutMs: 10_000 }))
    await sent(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await failed.outcome).toMatchObject(unknownAfter(10_000))
  })

  /** The README's example, as written, returning what it knows at its last comment. */
  async function resolveUnlock(rpc: QbitRpcClient): Promise<unknown> {
    try {
      await rpc.walletPassphrase('pw', 60)
    } catch (error) {
      if (!RpcUnknownOutcomeError.is(error)) throw error
      // getwalletinfo waits for an unlock still running.
      const info = await rpc.getWalletInfo({ timeoutMs: 120_000 }).catch(() => undefined)
      if (!info?.unlockedUntil) throw error // locked, or no answer: still not unlocked for sure
      return { error, unlockedUntil: info.unlockedUntil } // unlocked, until info.unlockedUntil
    }
    return 'unlocked in time'
  }

  it('tells from getWalletInfo whether an unlock that missed its deadline unlocked the wallet', async () => {
    const rpc = await confirmed()
    firstUnlockTaking(150_000) // past the 120 s default
    fakeClock()
    const example = track(resolveUnlock(rpc))
    await sent(1)
    await vi.advanceTimersByTimeAsync(120_000)
    await sent(2) // getwalletinfo, waiting for the unlock
    await settle()
    expect(example.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    const { value } = (await example.outcome) as { value: { error: unknown; unlockedUntil: number } }
    expect(value.error).toMatchObject(unknownAfter(120_000))
    expect(RpcTimeoutError.is((value.error as Error).cause)).toBe(true)
    expect(value.unlockedUntil).toBe(1_800_000_000)
  })

  it.each([
    ['0, the wallet locked', 0],
    ['absent', undefined],
  ])('rethrows the original error when getWalletInfo answers unlockedUntil %s', async (_, unlockedUntil) => {
    const rpc = await confirmed()
    node.handler = (request, response) => {
      const { id, method } = JSON.parse(request.body) as { id: unknown; method: string }
      if (method === 'getwalletinfo') reply(response, id, walletInfo(unlockedUntil))
    }
    fakeClock()
    const example = track(resolveUnlock(rpc))
    await sent(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await example.outcome).toMatchObject(unknownAfter(120_000))
  })

  it('rethrows the original error when getWalletInfo fails too', async () => {
    const rpc = await confirmed()
    node.handler = () => {} // answers nothing
    fakeClock()
    const example = track(resolveUnlock(rpc))
    await sent(1)
    await vi.advanceTimersByTimeAsync(120_000)
    await sent(2)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await example.outcome).toMatchObject(unknownAfter(120_000))
  })
})
