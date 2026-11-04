import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  QBIT_CHAINS,
  QBIT_DEFAULT_SIGNET_CHALLENGE,
  QBIT_GENESIS_HASHES,
  QbitRpcClient,
  RpcAbortedError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcTimeoutError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
} from '../src'
import {
  basicAuth,
  blockchainInfoJson,
  CHECK,
  FakeNode,
  GENESIS,
  HASH_A,
  HASH_B,
  TX_HEX,
  type RpcCall,
} from './helpers/fake-node'

// The cookie is read through fs/promises' open: wrap it so a test can count
// reads, hold one, or rotate the cookie right after one.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

let node: FakeNode
let chain: string
/** The node's genesis block hash, for getblockhash 0. */
let genesis: string
/** The signet_challenge a signet node reports; null for none. */
let challenge: string | null
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
  genesis = GENESIS['regtest']!
  challenge = '51'
  dropReads = 0
  hangChainCheck = false
  holdChainChecks = false
  heldChainChecks = []
  validCookie = undefined
  executed = []
  node.handler = (request, response) => {
    const parsed = JSON.parse(request.body) as RpcCall | RpcCall[]
    const calls = Array.isArray(parsed) ? parsed : [parsed]
    // A chain check is a batch whose first call is getblockchaininfo.
    const method = calls[0]!.method
    if (
      validCookie !== undefined &&
      request.headers.authorization !== basicAuth(...(validCookie.split(':') as [string, string]))
    ) {
      response.statusCode = 401
      return void response.end()
    }
    if (method === 'getbestblockhash' && dropReads > 0) {
      dropReads -= 1
      return void response.socket?.destroy()
    }
    if (method === 'getblockchaininfo' && hangChainCheck) return
    const result = (call: RpcCall): string =>
      call.method === 'getblockchaininfo'
        ? blockchainInfoJson(chain, chain === 'signet' ? challenge : null)
        : call.method === 'getblockhash'
          ? JSON.stringify(genesis)
          : call.method === 'getbestblockhash'
            ? JSON.stringify(HASH_A)
            : call.method === 'sendrawtransaction'
              ? JSON.stringify(HASH_A)
              : 'null'
    const replies = calls.map(call => `{"jsonrpc":"2.0","result":${result(call)},"id":${JSON.stringify(call.id)}}`)
    const answer = (): void => {
      executed.push(...calls.map(call => call.method))
      response.end(Array.isArray(parsed) ? `[${replies.join(',')}]` : replies[0])
    }
    if (method === 'getblockchaininfo' && holdChainChecks) return void heldChainChecks.push(answer)
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
    expect(methods()).toEqual([...CHECK, 'walletlock'])
    expect(rpc.chainStatus).toBe('confirmed')

    await new Promise(resolve => setTimeout(resolve, 80))
    expect(rpc.chainStatus).toBe('stale')
    await rpc.walletLock()
    expect(methods()).toEqual([...CHECK, 'walletlock', ...CHECK, 'walletlock'])
    expect(rpc.chainStatus).toBe('confirmed')
  })

  it('refuses a broadcast, sending nothing, when the node behind the URL moved to another chain', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    chain = 'main' // the operator restarted qbitd on this port with another chain
    await refusedAsMismatch(rpc.sendRawTransaction(TX_HEX))
    expect(methods()).toEqual([...CHECK, ...CHECK])
    expect(rpc.chainStatus).toBe('mismatch')
    // It stays refused, without asking the node, until confirmChain() matches again.
    chain = 'regtest'
    await refusedAsMismatch(rpc.walletLock())
    expect(methods()).toEqual([...CHECK, ...CHECK])
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
      expect(methods()).toEqual([...CHECK, 'getbestblockhash', 'getbestblockhash', ...CHECK])
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
      expect(methods()).toEqual([...CHECK, 'getbestblockhash', 'getbestblockhash', ...CHECK, 'walletlock'])
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
      expect(methods()).toEqual([...CHECK, ...CHECK])
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
    expect(methods()).toEqual([...CHECK, ...CHECK])
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
    expect(methods()).toEqual([...CHECK])
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
    // The call decided again after its wait, without another check.
    expect(checks()).toBe(3)
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
    // confirmChain decided again after its wait, without another check.
    expect(checks()).toBe(2)
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
    expect(methods()).toEqual([...CHECK, ...CHECK, 'walletlock'])
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
    expect(executed).toEqual([...CHECK, ...CHECK])
  })
})

describe('chain identity: genesis block and signet challenge', () => {
  /** A signet challenge other than the default: a 1-of-1 multisig. */
  const OTHER_CHALLENGE = `5121${'02'.repeat(33)}51ae`

  async function refusal(promise: Promise<unknown>): Promise<RpcChainGuardError> {
    const error = await promise.then(
      () => expect.fail('expected a refusal'),
      (e: unknown) => e
    )
    expect(RpcChainGuardError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'mismatch' })
    return error as RpcChainGuardError
  }

  async function failure(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => expect.fail('expected the call to fail'),
      (e: unknown) => e
    )
  }

  it('pins every chain to the genesis block qbit Core v1.0.0 asserts', () => {
    expect(QBIT_GENESIS_HASHES).toEqual(GENESIS)
    expect(Object.keys(QBIT_GENESIS_HASHES).sort()).toEqual([...QBIT_CHAINS].sort())
    expect(Object.isFrozen(QBIT_GENESIS_HASHES)).toBe(true)
    expect(QBIT_DEFAULT_SIGNET_CHALLENGE).toBe('51')
  })

  it.each(QBIT_CHAINS)('confirms a %s node reporting its default genesis block, in one batched request', async name => {
    chain = name
    genesis = GENESIS[name]!
    const rpc = client({ expectedChain: name })
    const info = await rpc.confirmChain()
    expect(info.chain).toBe(name)
    expect(rpc.chainStatus).toBe('confirmed')
    expect(node.requests).toHaveLength(1)
    const sent = JSON.parse(node.requests[0]!.body) as RpcCall[]
    expect(sent.map(call => [call.method, call.params])).toEqual([
      ['getblockchaininfo', []],
      ['getblockhash', [0]],
    ])
    expect(new Set(sent.map(call => call.id)).size).toBe(2)
  })

  it('refuses a node of another chain that reports the expected name, on confirmChain', async () => {
    chain = 'main'
    genesis = HASH_B // a custom chain calling itself main
    const rpc = client({ expectedChain: 'main' })
    const error = await refusal(rpc.confirmChain())
    expect(error).toMatchObject({
      method: 'getblockchaininfo',
      expected: 'main',
      actual: 'main',
      differs: ['genesis_hash'],
      expectedGenesisHash: GENESIS['main'],
      actualGenesisHash: HASH_B,
    })
    expect(error.expectedSignetChallenge).toBeUndefined()
    expect(error.message).toContain(`genesis block ${HASH_B}, expected ${GENESIS['main']}`)
    expect(rpc.chainStatus).toBe('mismatch')
    // Every later guarded call is refused the same way without asking the node.
    const later = await refusal(rpc.walletLock())
    expect(later).toMatchObject({ method: 'walletlock', differs: ['genesis_hash'], actualGenesisHash: HASH_B })
    expect(methods()).toEqual([...CHECK])
  })

  it.each([
    ['walletlock', (rpc: QbitRpcClient) => rpc.walletLock()],
    ['sendrawtransaction', (rpc: QbitRpcClient) => rpc.sendRawTransaction(TX_HEX)],
  ])('refuses %s, sending nothing, when its re-check finds another genesis block', async (method, run) => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    genesis = HASH_B // another regtest-named chain behind the same URL
    const error = await refusal(run(rpc))
    expect(error).toMatchObject({ method, actual: 'regtest', differs: ['genesis_hash'], actualGenesisHash: HASH_B })
    expect(methods()).toEqual([...CHECK, ...CHECK])
    expect(rpc.chainStatus).toBe('mismatch')
  })

  it('names every difference: another chain has another genesis block', async () => {
    chain = 'main'
    genesis = GENESIS['main']!
    const error = await refusal(client().confirmChain())
    expect(error).toMatchObject({
      actual: 'main',
      differs: ['chain', 'genesis_hash'],
      actualGenesisHash: GENESIS['main'],
    })
    expect(error.message).toBe(
      `RPC method getblockchaininfo refused: the node reports chain 'main', expected 'regtest'; ` +
        `genesis block ${GENESIS['main']}, expected ${GENESIS['regtest']}`
    )
  })

  it('takes an explicit expectedGenesisHash in either case, and refuses the default genesis block then', async () => {
    genesis = HASH_B
    const rpc = client({ expectedGenesisHash: HASH_B.toUpperCase() })
    expect(rpc.toJSON()).toMatchObject({ expectedChain: 'regtest', expectedGenesisHash: HASH_B })
    await rpc.confirmChain()
    expect(rpc.chainStatus).toBe('confirmed')
    genesis = GENESIS['regtest']!
    const error = await refusal(rpc.confirmChain())
    expect(error).toMatchObject({
      differs: ['genesis_hash'],
      expectedGenesisHash: HASH_B,
      actualGenesisHash: GENESIS['regtest'],
    })
  })

  describe('on signet', () => {
    beforeEach(() => {
      chain = 'signet'
      genesis = GENESIS['signet']!
    })

    it('confirms the default signet and reports its challenge in toJSON', async () => {
      const rpc = client({ expectedChain: 'signet' })
      expect(rpc.toJSON()).toMatchObject({ expectedGenesisHash: GENESIS['signet'], expectedSignetChallenge: '51' })
      expect((await rpc.confirmChain()).signetChallenge).toBe('51')
      expect(rpc.chainStatus).toBe('confirmed')
      expect(client().toJSON()).not.toHaveProperty('expectedSignetChallenge')
    })

    it('refuses another signet: same genesis block, another challenge', async () => {
      challenge = OTHER_CHALLENGE
      const rpc = client({ expectedChain: 'signet', chainCheckMaxAgeMs: 0 })
      const error = await refusal(rpc.confirmChain())
      expect(error).toMatchObject({
        expected: 'signet',
        actual: 'signet',
        differs: ['signet_challenge'],
        expectedGenesisHash: GENESIS['signet'],
        actualGenesisHash: GENESIS['signet'],
        expectedSignetChallenge: '51',
        actualSignetChallenge: OTHER_CHALLENGE,
      })
      expect(error.message).toContain(`signet challenge ${OTHER_CHALLENGE}, expected 51`)
      expect(rpc.chainStatus).toBe('mismatch')
    })

    it('refuses a guarded call when the re-check finds another signet', async () => {
      const rpc = client({ expectedChain: 'signet', chainCheckMaxAgeMs: 0 })
      await rpc.confirmChain()
      challenge = OTHER_CHALLENGE
      const error = await refusal(rpc.sendRawTransaction(TX_HEX))
      expect(error).toMatchObject({ method: 'sendrawtransaction', differs: ['signet_challenge'] })
      expect(methods()).toEqual([...CHECK, ...CHECK])
    })

    it('refuses a signet node that reports no challenge', async () => {
      challenge = null
      const error = await refusal(client({ expectedChain: 'signet' }).confirmChain())
      expect(error).toMatchObject({ differs: ['signet_challenge'], expectedSignetChallenge: '51' })
      expect(error.actualSignetChallenge).toBeUndefined()
      expect(error.message).toContain('signet challenge none, expected 51')
    })

    it('confirms a custom expectedSignetChallenge, in either case, and refuses the default signet then', async () => {
      challenge = OTHER_CHALLENGE
      const rpc = client({ expectedChain: 'signet', expectedSignetChallenge: OTHER_CHALLENGE.toUpperCase() })
      await rpc.confirmChain()
      expect(rpc.chainStatus).toBe('confirmed')
      challenge = '51'
      const error = await refusal(rpc.confirmChain())
      expect(error).toMatchObject({
        differs: ['signet_challenge'],
        expectedSignetChallenge: OTHER_CHALLENGE,
        actualSignetChallenge: '51',
      })
    })

    it('shortens a long challenge in the message, but not in the error fields', async () => {
      challenge = `6a${'00'.repeat(200)}`
      const error = await refusal(client({ expectedChain: 'signet' }).confirmChain())
      expect(error.actualSignetChallenge).toBe(challenge)
      expect(error.message).toContain(`signet challenge ${challenge.slice(0, 80)}... (201 bytes), expected 51`)
    })

    it('expects a challenge from a node of another chain too', async () => {
      chain = 'regtest'
      genesis = GENESIS['regtest']!
      const error = await refusal(client({ expectedChain: 'signet' }).confirmChain())
      expect(error.differs).toEqual(['chain', 'genesis_hash', 'signet_challenge'])
    })
  })

  it('validates expectedGenesisHash and expectedSignetChallenge at construction', () => {
    for (const expectedGenesisHash of [
      '',
      'g'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      'a'.repeat(66),
      `0x${'a'.repeat(62)}`,
      ` ${'a'.repeat(63)}`,
      42,
      null,
      Buffer.alloc(32),
    ]) {
      expect(() => client({ expectedGenesisHash: expectedGenesisHash as string })).toThrow(
        new TypeError('expectedGenesisHash must be 64 hex characters')
      )
    }
    for (const expectedSignetChallenge of ['', '5', 'abc', 'zz', '0x51', ' 51', 51, null, ['51']]) {
      expect(() =>
        client({ expectedChain: 'signet', expectedSignetChallenge: expectedSignetChallenge as string })
      ).toThrow(new TypeError('expectedSignetChallenge must be non-empty hex of whole bytes'))
    }
    for (const expectedChain of ['main', 'test', 'testnet4', 'regtest'] as const) {
      expect(() => client({ expectedChain, expectedSignetChallenge: '51' })).toThrow(
        new TypeError("expectedSignetChallenge needs expectedChain: 'signet'")
      )
      // Left undefined, as a caller without exactOptionalPropertyTypes may pass it.
      const unset: Record<string, unknown> = { expectedChain, expectedSignetChallenge: undefined }
      expect(() => client(unset as Partial<QbitRpcClientOptions>)).not.toThrow()
    }
    expect(() => client({ expectedChain: 'signet', expectedSignetChallenge: '51' })).not.toThrow()
  })

  it('runs the batched check under confirmChain’s deadline, as one request, and reports a timeout or abort typed', async () => {
    hangChainCheck = true
    const rpc = client()
    const started = performance.now()
    const timeout = await failure(rpc.confirmChain({ timeoutMs: 100 }))
    expect(performance.now() - started).toBeLessThan(600)
    expect(RpcTimeoutError.is(timeout)).toBe(true)
    expect(timeout).toMatchObject({ method: 'getblockchaininfo', timeoutMs: 100 })
    const controller = new AbortController()
    const aborted = failure(rpc.confirmChain({ signal: controller.signal }))
    await expect.poll(() => node.requests.length).toBe(2)
    controller.abort('user')
    expect(RpcAbortedError.is(await aborted)).toBe(true)
    expect(node.requests).toHaveLength(2)
    expect(rpc.chainStatus).toBe('unconfirmed')
  })

  it('counts the check against the guarded call’s one deadline, not a second one', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    // The check is answered after 300 ms; then the call itself gets no reply.
    holdChainChecks = true
    const answerLate = setInterval(() => heldChainChecks.shift()?.(), 300)
    const handler = node.handler
    node.handler = (request, response) =>
      request.body.includes('"walletlock"') ? undefined : handler(request, response)
    try {
      const started = performance.now()
      const error = await failure(rpc.walletLock({ timeoutMs: 500 }))
      const elapsed = performance.now() - started
      // One 500 ms deadline over the check and the call; two would take at least 800 ms.
      expect(elapsed).toBeGreaterThanOrEqual(490)
      expect(elapsed).toBeLessThan(780)
      expect(RpcUnknownOutcomeError.is(error)).toBe(true)
      expect((error as Error).cause).toMatchObject({ name: 'RpcTimeoutError', timeoutMs: 500 })
      expect(methods()).toEqual([...CHECK, ...CHECK, 'walletlock'])
    } finally {
      clearInterval(answerLate)
    }
  })

  it('reads the cookie once for confirmChain, and sends both checks with it in one request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-genesis-'))
    try {
      const cookieFile = join(dir, '.cookie')
      await writeFile(cookieFile, '__cookie__:one')
      const rpc = client({ auth: { cookieFile } })
      vi.mocked(open).mockClear()
      await rpc.confirmChain()
      expect(vi.mocked(open)).toHaveBeenCalledTimes(1)
      expect(node.requests).toHaveLength(1)
      expect(node.requests[0]!.headers.authorization).toBe(basicAuth('__cookie__', 'one'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not let a re-check that matched clear a genesis mismatch recorded before its reply', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    holdChainChecks = true
    const broadcast = rpc.sendRawTransaction(TX_HEX)
    await expect.poll(() => heldChainChecks.length).toBe(1)
    const answerRecheck = heldChainChecks.shift()!
    holdChainChecks = false
    genesis = HASH_B
    await refusal(rpc.confirmChain())
    // The re-check matched the genesis block, but its reply arrives after the mismatch.
    answerRecheck()
    expect(await refusal(broadcast)).toMatchObject({ differs: ['genesis_hash'], actualGenesisHash: HASH_B })
    expect(methods()).not.toContain('sendrawtransaction')
    expect(rpc.chainStatus).toBe('mismatch')
    // Only a confirmChain begun after it, on a matching node, clears it.
    genesis = GENESIS['regtest']!
    await rpc.confirmChain()
    await rpc.walletLock()
    expect(methods().at(-1)).toBe('walletlock')
  })

  it('makes a confirmChain in flight throw a genesis mismatch another check records, though its own answer matched', async () => {
    const rpc = client()
    holdChainChecks = true
    const confirming = failure(rpc.confirmChain())
    await expect.poll(() => heldChainChecks.length).toBe(1)
    const answer = heldChainChecks.shift()!
    holdChainChecks = false
    genesis = HASH_B
    await refusal(rpc.confirmChain())
    answer()
    expect(await confirming).toMatchObject({ name: 'RpcChainGuardError', differs: ['genesis_hash'] })
    expect(rpc.chainStatus).toBe('mismatch')
  })

  describe('a malformed or failed reply to the batched check', () => {
    const ok = (id: unknown, result: string): string =>
      `{"jsonrpc":"2.0","result":${result},"id":${JSON.stringify(id)}}`
    const info = blockchainInfoJson('regtest')
    const hash = JSON.stringify(GENESIS['regtest'])

    /** Answer chain checks with `body(info call, genesis call)`; other requests as before. */
    function answerChecksWith(body: (infoCall: RpcCall, genesisCall: RpcCall) => string): void {
      const handler = node.handler
      node.handler = (request, response) => {
        const parsed = JSON.parse(request.body) as RpcCall | RpcCall[]
        if (!Array.isArray(parsed)) return handler(request, response)
        return void response.end(body(parsed[0]!, parsed[1]!))
      }
    }

    const cases: [
      name: string,
      body: (infoCall: RpcCall, genesisCall: RpcCall) => string,
      expected: { is(value: unknown): boolean },
      fields: Record<string, unknown>,
    ][] = [
      [
        'an uppercase genesis hash',
        (i, g) => `[${ok(i.id, info)},${ok(g.id, hash.toUpperCase())}]`,
        RpcResponseError,
        { method: 'getblockhash', reason: 'validation', path: 'result' },
      ],
      [
        'a 63-character genesis hash',
        (i, g) => `[${ok(i.id, info)},${ok(g.id, JSON.stringify(GENESIS['regtest']!.slice(1)))}]`,
        RpcResponseError,
        { method: 'getblockhash', reason: 'validation' },
      ],
      [
        'a number for the genesis hash',
        (i, g) => `[${ok(i.id, info)},${ok(g.id, '0')}]`,
        RpcResponseError,
        { method: 'getblockhash', reason: 'validation' },
      ],
      [
        'a null genesis hash',
        (i, g) => `[${ok(i.id, info)},${ok(g.id, 'null')}]`,
        RpcResponseError,
        { method: 'getblockhash', reason: 'validation' },
      ],
      [
        'an error for getblockhash',
        (i, g) =>
          `[${ok(i.id, info)},{"jsonrpc":"2.0","error":{"code":-8,"message":"Block height out of range"},"id":${g.id}}]`,
        RpcError,
        { method: 'getblockhash', code: -8 },
      ],
      [
        'no reply for getblockhash',
        i => `[${ok(i.id, info)}]`,
        RpcResponseError,
        { method: 'getblockhash', reason: 'protocol' },
      ],
      ['an empty array', () => '[]', RpcResponseError, { method: 'getblockchaininfo', reason: 'protocol' }],
      [
        'a reply with an id not sent',
        (i, g) => `[${ok(i.id, info)},${ok(g.id, hash)},${ok(999_999, hash)}]`,
        RpcResponseError,
        { method: 'getblockchaininfo', reason: 'protocol', path: 'response[2].id' },
      ],
      [
        'one id answered twice',
        i => `[${ok(i.id, info)},${ok(i.id, hash)}]`,
        RpcResponseError,
        { method: 'getblockchaininfo', reason: 'protocol', path: 'response[1].id' },
      ],
      [
        'the replies swapped between the ids',
        (i, g) => `[${ok(i.id, hash)},${ok(g.id, info)}]`,
        RpcResponseError,
        { method: 'getblockchaininfo', reason: 'validation' },
      ],
      [
        'a single reply object instead of an array',
        i => ok(i.id, info),
        RpcResponseError,
        { method: 'getblockchaininfo', reason: 'protocol', path: 'response' },
      ],
      [
        'a signet challenge that is not hex',
        (i, g) => `[${ok(i.id, blockchainInfoJson('signet', 'zz'))},${ok(g.id, JSON.stringify(GENESIS['signet']))}]`,
        RpcResponseError,
        { method: 'getblockchaininfo', reason: 'validation', path: 'result.signet_challenge' },
      ],
    ]

    it.each(cases)('fails confirmChain on %s, typed, and records nothing', async (_name, body, expected, fields) => {
      answerChecksWith(body)
      const rpc = client()
      const error = await failure(rpc.confirmChain())
      expect(expected.is(error)).toBe(true)
      expect(RpcChainGuardError.is(error)).toBe(false)
      expect(error).toMatchObject(fields)
      expect(rpc.chainStatus).toBe('unconfirmed')
    })

    it.each(cases)('fails a guarded call on %s, typed and unsent', async (_name, body, expected, fields) => {
      const rpc = client({ chainCheckMaxAgeMs: 0 })
      await rpc.confirmChain()
      answerChecksWith(body)
      const error = await failure(rpc.sendRawTransaction(TX_HEX))
      expect(expected.is(error)).toBe(true)
      expect(RpcUnknownOutcomeError.is(error)).toBe(false)
      expect(error).toMatchObject(fields)
      expect(methods()).not.toContain('sendrawtransaction')
      expect(rpc.chainStatus).toBe('stale')
    })

    const genesisFailures: [name: string, reply: ((genesisCall: RpcCall) => string) | undefined][] = [
      [
        'getblockhash answers an error',
        g => `{"jsonrpc":"2.0","error":{"code":-8,"message":"Block height out of range"},"id":${g.id}}`,
      ],
      ['the genesis hash is malformed', g => ok(g.id, '0')],
      ['getblockhash has no reply', undefined],
    ]

    it.each(genesisFailures)(
      'records a mismatch from another chain name though %s, and refuses guarded calls',
      async (_name, genesisReply) => {
        const rpc = client()
        await rpc.confirmChain()
        expect(rpc.chainStatus).toBe('confirmed')
        const other = blockchainInfoJson('main')
        answerChecksWith((i, g) => `[${ok(i.id, other)}${genesisReply === undefined ? '' : `,${genesisReply(g)}`}]`)
        const error = await refusal(rpc.confirmChain())
        expect(error).toMatchObject({ differs: ['chain'], actual: 'main' })
        expect(error.actualGenesisHash).toBeUndefined()
        expect(error.message).toContain("chain 'main', expected 'regtest'")
        expect(rpc.chainStatus).toBe('mismatch')
        await refusal(rpc.sendRawTransaction(TX_HEX))
        expect(methods()).not.toContain('sendrawtransaction')
      }
    )

    it('refuses a guarded call, unsent, when its re-check finds another chain though getblockhash fails', async () => {
      const rpc = client({ chainCheckMaxAgeMs: 0 })
      await rpc.confirmChain()
      answerChecksWith(i => `[${ok(i.id, blockchainInfoJson('main'))}]`)
      const error = await refusal(rpc.sendRawTransaction(TX_HEX))
      expect(error).toMatchObject({ method: 'sendrawtransaction', differs: ['chain'], actual: 'main' })
      expect(methods()).not.toContain('sendrawtransaction')
      expect(rpc.chainStatus).toBe('mismatch')
    })

    it('records a mismatch from another signet challenge though getblockhash fails', async () => {
      let first = true
      answerChecksWith((i, g) => {
        if (!first) return `[${ok(i.id, blockchainInfoJson('signet', OTHER_CHALLENGE))}]`
        first = false
        return `[${ok(i.id, blockchainInfoJson('signet'))},${ok(g.id, JSON.stringify(GENESIS['signet']))}]`
      })
      const rpc = client({ expectedChain: 'signet' })
      await rpc.confirmChain()
      const error = await refusal(rpc.confirmChain())
      expect(error).toMatchObject({ differs: ['signet_challenge'], actualSignetChallenge: OTHER_CHALLENGE })
      expect(error.actualGenesisHash).toBeUndefined()
      expect(rpc.chainStatus).toBe('mismatch')
    })

    it('retries the check under readRetries when getblockhash answers -28, warming up', async () => {
      let warming = true
      answerChecksWith((i, g) =>
        warming
          ? ((warming = false),
            `[${ok(i.id, info)},{"jsonrpc":"2.0","error":{"code":-28,"message":"Loading block index…"},"id":${g.id}}]`)
          : `[${ok(i.id, info)},${ok(g.id, hash)}]`
      )
      const rpc = client({ readRetries: 1, retryDelayMs: 0 })
      await rpc.confirmChain()
      expect(rpc.chainStatus).toBe('confirmed')
      expect(node.requests).toHaveLength(2)
      warming = true
      const error = await failure(client().confirmChain())
      expect(error).toMatchObject({ name: 'RpcError', method: 'getblockhash', code: -28 })
    })
  })
})
