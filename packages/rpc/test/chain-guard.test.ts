import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  QbitRpcClient,
  RpcAbortedError,
  RpcChainGuardError,
  RpcTimeoutError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
} from '../src'
import { basicAuth, blockchainInfoJson, FakeNode, HASH_A, TX_HEX } from './helpers/fake-node'

// The cookie is read through fs/promises' open: wrap it so a test can count
// reads, hold one, or rotate the cookie right after one.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

let node: FakeNode
let chain: string
/** getbestblockhash requests to leave unanswered, their connection destroyed. */
let dropReads: number
let hangChainCheck: boolean
/** While set, chain checks are answered (with the chain at the time they arrived) only when released. */
let holdChainChecks: boolean
let heldChainChecks: (() => void)[]
/** When set, the node accepts only this cookie, as a restarted qbitd would. */
let validCookie: string | undefined
/** Methods the node executed: accepted credentials, then answered. */
let executed: string[]

beforeEach(async () => {
  node = await FakeNode.start()
  chain = 'regtest'
  dropReads = 0
  hangChainCheck = false
  holdChainChecks = false
  heldChainChecks = []
  validCookie = undefined
  executed = []
  node.handler = (request, response) => {
    const call = JSON.parse(request.body) as { id: number; method: string }
    if (
      validCookie !== undefined &&
      request.headers.authorization !== basicAuth(...(validCookie.split(':') as [string, string]))
    ) {
      response.statusCode = 401
      return void response.end()
    }
    if (call.method === 'getbestblockhash' && dropReads > 0) {
      dropReads -= 1
      return void response.socket?.destroy()
    }
    if (call.method === 'getblockchaininfo' && hangChainCheck) return
    const result =
      call.method === 'getblockchaininfo'
        ? blockchainInfoJson(chain)
        : call.method === 'getbestblockhash'
          ? JSON.stringify(HASH_A)
          : call.method === 'sendrawtransaction'
            ? JSON.stringify(HASH_A)
            : 'null'
    const answer = (): void => {
      executed.push(call.method)
      response.end(`{"jsonrpc":"2.0","result":${result},"id":${call.id}}`)
    }
    if (call.method === 'getblockchaininfo' && holdChainChecks) return void heldChainChecks.push(answer)
    answer()
  }
})
afterEach(async () => {
  await node.close()
  vi.mocked(open).mockReset()
  vi.mocked(open).mockImplementation(actualFs.open)
})

function client(options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-write', 'broadcast'],
    ...options,
  })
}

const methods = (): string[] => node.calls().map(call => call.method)
const checks = (): number => methods().filter(method => method === 'getblockchaininfo').length

async function refusedAsMismatch(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => expect.fail('expected a refusal'),
    (e: unknown) => e
  )
  expect(RpcChainGuardError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason: 'mismatch', expected: 'regtest', actual: 'main' })
}

describe('chain guard freshness', () => {
  it('re-checks before a guarded call once the confirmation is older than chainCheckMaxAgeMs', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 50 })
    await rpc.confirmChain()
    await rpc.walletLock()
    expect(methods()).toEqual(['getblockchaininfo', 'walletlock'])
    expect(rpc.chainStatus).toBe('confirmed')

    await new Promise(resolve => setTimeout(resolve, 80))
    expect(rpc.chainStatus).toBe('stale')
    await rpc.walletLock()
    expect(methods()).toEqual(['getblockchaininfo', 'walletlock', 'getblockchaininfo', 'walletlock'])
    expect(rpc.chainStatus).toBe('confirmed')
  })

  it('refuses a broadcast, sending nothing, when the node behind the URL moved to another chain', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    chain = 'main' // the operator restarted qbitd on this port with another chain
    await refusedAsMismatch(rpc.sendRawTransaction(TX_HEX))
    expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo'])
    expect(rpc.chainStatus).toBe('mismatch')
    // It stays refused, without asking the node, until confirmChain() matches again.
    chain = 'regtest'
    await refusedAsMismatch(rpc.walletLock())
    expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo'])
    await rpc.confirmChain()
    await rpc.walletLock()
    expect(methods().at(-1)).toBe('walletlock')
  })

  it.each([
    ['answered on a new connection', 1, 'answered'],
    ['dropped there too', 2, 'network'],
  ])(
    'goes stale when a pooled connection resets and the read sent again is %s, so a restart onto another chain is caught',
    async (_name, drops, outcome) => {
      const rpc = client({ chainCheckMaxAgeMs: 86_400_000 })
      await rpc.confirmChain()
      // The read goes out on the pooled connection confirmChain() used.
      dropReads = drops
      const read = await rpc.getBestBlockHash().then(
        () => 'answered',
        (error: unknown) => (error as { reason?: string }).reason
      )
      expect(read).toBe(outcome)
      expect(rpc.chainStatus).toBe('stale')
      chain = 'main'
      await refusedAsMismatch(rpc.walletLock())
      expect(methods()).toEqual(['getblockchaininfo', 'getbestblockhash', 'getbestblockhash', 'getblockchaininfo'])
    }
  )

  it('goes stale when the cookie changes, and re-checks before the next guarded call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-guard-'))
    try {
      const cookieFile = join(dir, '.cookie')
      await writeFile(cookieFile, '__cookie__:before-restart')
      const rpc = client({ auth: { cookieFile }, chainCheckMaxAgeMs: 86_400_000 })
      await rpc.confirmChain()
      await rpc.getBestBlockHash()
      expect(rpc.chainStatus).toBe('confirmed')
      await writeFile(cookieFile, '__cookie__:after-restart')
      await rpc.getBestBlockHash()
      expect(rpc.chainStatus).toBe('stale')
      await rpc.walletLock()
      expect(methods()).toEqual([
        'getblockchaininfo',
        'getbestblockhash',
        'getbestblockhash',
        'getblockchaininfo',
        'walletlock',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('re-checks when the cookie changed just before a guarded call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-guard-'))
    try {
      const cookieFile = join(dir, '.cookie')
      await writeFile(cookieFile, '__cookie__:before-restart')
      const rpc = client({ auth: { cookieFile }, chainCheckMaxAgeMs: 86_400_000 })
      await rpc.confirmChain()
      await writeFile(cookieFile, '__cookie__:after-restart')
      chain = 'main'
      await refusedAsMismatch(rpc.sendRawTransaction(TX_HEX))
      expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('goes stale after an HTTP 401', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 86_400_000 })
    await rpc.confirmChain()
    const handler = node.handler
    node.handler = (_request, response) => {
      response.statusCode = 401
      response.end()
    }
    await expect(rpc.getBestBlockHash()).rejects.toMatchObject({ status: 401 })
    expect(rpc.chainStatus).toBe('stale')
    node.handler = handler
    await rpc.walletLock()
    expect(checks()).toBe(2)
  })

  it('runs the re-check under the call deadline and reports its failure as definite', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    hangChainCheck = true
    const started = performance.now()
    const error = await rpc.sendRawTransaction(TX_HEX, { timeoutMs: 100 }).catch((e: unknown) => e)
    expect(performance.now() - started).toBeLessThan(600)
    expect(RpcTimeoutError.is(error)).toBe(true)
    expect(RpcUnknownOutcomeError.is(error)).toBe(false)
    expect(methods()).not.toContain('sendrawtransaction')
  })

  it('validates chainCheckMaxAgeMs', () => {
    for (const chainCheckMaxAgeMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => client({ chainCheckMaxAgeMs })).toThrow(RangeError)
    }
  })
})

describe('chain guard races', () => {
  let dir: string
  let cookieFile: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-guard-race-'))
    cookieFile = join(dir, '.cookie')
    await writeFile(cookieFile, '__cookie__:before-restart')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** Hold the next cookie read before it opens the file. */
  function holdNextCookieRead(): { readonly started: Promise<void>; readonly release: () => void } {
    let started!: () => void
    let release!: () => void
    const startedPromise = new Promise<void>(resolve => (started = resolve))
    const gate = new Promise<void>(resolve => (release = resolve))
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      started()
      await gate
      return actualFs.open(...args)
    })
    return { started: startedPromise, release }
  }

  it('refuses a guarded call, sending nothing, when a mismatch is recorded while it reads its cookie', async () => {
    const rpc = client({ auth: { cookieFile }, chainCheckMaxAgeMs: 86_400_000 })
    await rpc.confirmChain()
    const read = holdNextCookieRead()
    const broadcast = rpc.sendRawTransaction(TX_HEX)
    await read.started
    chain = 'main' // the operator restarted qbitd on this port with another chain
    await refusedAsMismatch(rpc.confirmChain())
    read.release()
    await refusedAsMismatch(broadcast)
    expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo'])
  })

  it('rejects with a typed error, sending nothing, when a guarded call times out or is aborted while it reads its cookie', async () => {
    const rpc = client({ auth: { cookieFile }, chainCheckMaxAgeMs: 86_400_000 })
    await rpc.confirmChain()
    // Each read is released once its call has given up, so a call that did not would go on and send.
    const timed = holdNextCookieRead()
    const timeout = rpc.sendRawTransaction(TX_HEX, { timeoutMs: 50 }).catch((e: unknown) => e)
    await timed.started
    await new Promise(resolve => setTimeout(resolve, 100))
    timed.release()
    expect(RpcTimeoutError.is(await timeout)).toBe(true)
    const aborted = holdNextCookieRead()
    const controller = new AbortController()
    const abort = rpc.sendRawTransaction(TX_HEX, { signal: controller.signal }).catch((e: unknown) => e)
    await aborted.started
    controller.abort('user')
    aborted.release()
    expect(RpcAbortedError.is(await abort)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(methods()).toEqual(['getblockchaininfo'])
  })

  it('does not let a re-check answered before a mismatch clear it', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    holdChainChecks = true
    const broadcast = rpc.sendRawTransaction(TX_HEX)
    await expect.poll(() => heldChainChecks.length).toBe(1)
    const answerRecheck = heldChainChecks.shift()!
    holdChainChecks = false
    chain = 'main'
    await refusedAsMismatch(rpc.confirmChain())
    // The re-check was answered on regtest, but its reply arrives after the mismatch.
    answerRecheck()
    await refusedAsMismatch(broadcast)
    expect(methods()).not.toContain('sendrawtransaction')
    expect(rpc.chainStatus).toBe('mismatch')
  })

  it('checks again when a connection error happens while confirmChain is in flight', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 86_400_000 })
    holdChainChecks = true
    const confirming = rpc.confirmChain()
    await expect.poll(() => heldChainChecks.length).toBe(1)
    const answer = heldChainChecks.shift()!
    holdChainChecks = false
    // A dropped connection on this client hints at a restart; the answer may predate it.
    dropReads = 2 // the read, and its one extra attempt if it went out on a pooled socket
    await expect(rpc.getBestBlockHash()).rejects.toMatchObject({ reason: 'network' })
    dropReads = 0
    answer()
    expect((await confirming).chain).toBe('regtest')
    expect(rpc.chainStatus).toBe('confirmed')
    expect(checks()).toBe(2)
  })

  it('refuses a guarded call as stale, sending nothing, when every chain check it runs is doubted', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    holdChainChecks = true
    const broadcast = rpc.sendRawTransaction(TX_HEX).catch((e: unknown) => e)
    for (let i = 0; i < 3; i += 1) {
      await expect.poll(() => heldChainChecks.length).toBe(1)
      const answer = heldChainChecks.shift()!
      dropReads = 2 // the read, and its one extra attempt if it went out on a pooled socket
      await expect(rpc.getBestBlockHash()).rejects.toMatchObject({ reason: 'network' })
      dropReads = 0
      answer()
    }
    const error = await broadcast
    expect(RpcChainGuardError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'stale', method: 'sendrawtransaction' })
    expect(checks()).toBe(4)
    expect(methods()).not.toContain('sendrawtransaction')
    // Once the doubts stop, the next call goes through.
    holdChainChecks = false
    await rpc.walletLock()
    expect(methods().at(-1)).toBe('walletlock')
  })

  it('keeps an unconfirmed client refusing when every check confirmChain runs is doubted', async () => {
    const rpc = client({ retryDelayMs: 0 })
    holdChainChecks = true
    const confirming = rpc.confirmChain().catch((e: unknown) => e)
    for (let i = 0; i < 3; i += 1) {
      await expect.poll(() => heldChainChecks.length).toBe(1)
      const answer = heldChainChecks.shift()!
      dropReads = 2 // the read, and its one extra attempt if it went out on a pooled socket
      await expect(rpc.getBestBlockHash()).rejects.toMatchObject({ reason: 'network' })
      dropReads = 0
      answer()
    }
    expect(await confirming).toMatchObject({ name: 'RpcChainGuardError', reason: 'stale' })
    expect(rpc.chainStatus).toBe('unconfirmed')
    await expect(rpc.sendRawTransaction(TX_HEX)).rejects.toMatchObject({ reason: 'unconfirmed' })
    expect(methods()).not.toContain('sendrawtransaction')
  })

  /** Answer the held chain check after a dropped read on `rpc` cast doubt on it. */
  async function answerDoubted(rpc: QbitRpcClient): Promise<void> {
    await expect.poll(() => heldChainChecks.length).toBe(1)
    const answer = heldChainChecks.shift()!
    dropReads = 2 // the read, and its one extra attempt if it went out on a pooled socket
    await expect(rpc.getBestBlockHash()).rejects.toMatchObject({ reason: 'network' })
    dropReads = 0
    holdChainChecks = false
    answer()
  }

  it('refuses a guarded call when a mismatch is recorded while it waits to check again', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0, retryDelayMs: 400 })
    await rpc.confirmChain()
    holdChainChecks = true
    const lock = rpc.walletLock().catch((e: unknown) => e)
    await answerDoubted(rpc)
    await new Promise(resolve => setTimeout(resolve, 100)) // the call is now waiting to check again
    // During the wait, another check finds main; then the node answers regtest again.
    chain = 'main'
    await refusedAsMismatch(rpc.confirmChain())
    chain = 'regtest'
    expect(await lock).toMatchObject({ name: 'RpcChainGuardError', reason: 'mismatch', actual: 'main' })
    expect(methods()).not.toContain('walletlock')
    expect(rpc.chainStatus).toBe('mismatch')
  })

  it('makes confirmChain throw when another check finds a mismatch while it waits to check again', async () => {
    const rpc = client({ retryDelayMs: 400 })
    holdChainChecks = true
    const confirming = rpc.confirmChain().catch((e: unknown) => e)
    await answerDoubted(rpc)
    await new Promise(resolve => setTimeout(resolve, 100))
    chain = 'main'
    await refusedAsMismatch(rpc.confirmChain())
    chain = 'regtest'
    expect(await confirming).toMatchObject({ name: 'RpcChainGuardError', reason: 'mismatch', actual: 'main' })
    expect(rpc.chainStatus).toBe('mismatch')
  })

  it('fails as stale at once, nothing sent, when the wait before checking again would pass the deadline', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0, retryDelayMs: 60_000 })
    await rpc.confirmChain()
    holdChainChecks = true
    const started = performance.now()
    const lock = rpc.walletLock({ timeoutMs: 5000 }).catch((e: unknown) => e)
    await answerDoubted(rpc)
    expect(await lock).toMatchObject({ name: 'RpcChainGuardError', reason: 'stale' })
    expect(performance.now() - started).toBeLessThan(2000)
    expect(methods()).not.toContain('walletlock')
  })

  it('makes confirmChain throw when another check finds a mismatch while it reads its cookie', async () => {
    const rpc = client({ auth: { cookieFile } })
    const read = holdNextCookieRead()
    const confirming = rpc.confirmChain().catch((e: unknown) => e)
    await read.started
    chain = 'main'
    await refusedAsMismatch(rpc.confirmChain())
    chain = 'regtest'
    read.release()
    expect(await confirming).toMatchObject({ name: 'RpcChainGuardError', reason: 'mismatch', actual: 'main' })
    expect(rpc.chainStatus).toBe('mismatch')
    // A confirmChain begun after the mismatch clears it.
    await rpc.confirmChain()
    expect(rpc.chainStatus).toBe('confirmed')
  })

  it('does not let a cookie read that finishes late roll the cookie back', async () => {
    const rpc = client({ auth: { cookieFile }, chainCheckMaxAgeMs: 86_400_000 })
    await rpc.confirmChain()
    // A read starts with the old cookie on disk and finishes after a newer read.
    let read!: () => void
    let release!: () => void
    const done = new Promise<void>(resolve => (read = resolve))
    const gate = new Promise<void>(resolve => (release = resolve))
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args)
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        read()
        await gate
      }
      return handle
    })
    const late = rpc.getBestBlockHash()
    await done
    await writeFile(cookieFile, '__cookie__:after-restart')
    await rpc.confirmChain()
    expect(rpc.chainStatus).toBe('confirmed')
    release()
    await late
    expect(rpc.chainStatus).toBe('confirmed')
    await rpc.walletLock()
    expect(methods().slice(-2)).toEqual(['getbestblockhash', 'walletlock'])
  })

  it('reads the cookie once per guarded attempt, and sends the re-check and the call with it', async () => {
    const rpc = client({ auth: { cookieFile }, chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    vi.mocked(open).mockClear()
    await rpc.walletLock()
    expect(vi.mocked(open)).toHaveBeenCalledTimes(1)
    expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo', 'walletlock'])
    const [check, call] = node.requests.slice(-2)
    expect(call!.headers.authorization).toBe(check!.headers.authorization)
  })

  it('sends a guarded call with the cookie it read, so a restart after that read rejects it unexecuted', async () => {
    validCookie = '__cookie__:before-restart'
    const rpc = client({ auth: { cookieFile }, chainCheckMaxAgeMs: 86_400_000 })
    await rpc.confirmChain()
    // qbitd restarts onto another chain just after the call has read the cookie.
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args)
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        await writeFile(cookieFile, '__cookie__:after-restart')
        validCookie = '__cookie__:after-restart'
        chain = 'main'
      }
      return handle
    })
    const error = await rpc.walletLock().catch((e: unknown) => e)
    expect(error).toMatchObject({ reason: 'http_status', status: 401 })
    expect(RpcUnknownOutcomeError.is(error)).toBe(false)
    expect(rpc.chainStatus).toBe('stale')
    // The next call reads the new cookie and checks the chain first.
    await refusedAsMismatch(rpc.walletLock())
    expect(executed).toEqual(['getblockchaininfo', 'getblockchaininfo'])
  })
})
