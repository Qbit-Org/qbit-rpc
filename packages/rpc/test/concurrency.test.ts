import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  QbitRpcClient,
  requests,
  RpcAbortedError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcResponseTooLargeError,
  RpcTimeoutError,
  RpcTransportError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
} from '../src'
import { Limiter } from '../src/limiter'
import { HttpTransport } from '../src/transport'
import { CHECK, chainResults, FakeNode, HASH_A, TX_HEX, type RecordedRequest, type RpcCall } from './helpers/fake-node'

const WORK_QUEUE_BODY = 'Work queue depth exceeded'
const ADDRESS = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'
const RESULTS: Record<string, string> = {
  ...chainResults('regtest'),
  getblockcount: '10',
  getbestblockhash: JSON.stringify(HASH_A),
  getrawchangeaddress: JSON.stringify(ADDRESS),
  finalizepsbt: '{"psbt":"cHNidP8=","complete":false}',
  walletlock: 'null',
}

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
})
afterEach(async () => {
  await node.close()
})

/** Answer a request from RESULTS, single or batch, with `results` in place of some methods' result texts. */
function answer(request: RecordedRequest, response: ServerResponse, results: Record<string, string> = {}): void {
  const parsed = JSON.parse(request.body) as RpcCall | RpcCall[]
  const one = (call: RpcCall): string =>
    `{"jsonrpc":"2.0","result":${results[call.method] ?? RESULTS[call.method]},"id":${String(call.id)}}`
  response.end(Array.isArray(parsed) ? `[${parsed.map(one).join(',')}]` : one(parsed))
}

/** qbitd's reply when its work queue is full, byte for byte (qbit Core v1.0.0). */
function rejectWorkQueueFull(response: ServerResponse): void {
  response.statusCode = 503
  response.setHeader('content-type', 'text/html; charset=ISO-8859-1')
  response.end(WORK_QUEUE_BODY)
}

/**
 * Stand in for qbitd's work queue: a request arriving with more than `capacity`
 * open gets the 503, and `peak` is the most open at once, rejected ones
 * included. Accepted requests are answered after a few milliseconds or, with
 * `holdUntilSeen`, once that many requests have arrived.
 */
function workQueue(capacity: number, holdUntilSeen?: number): { peak: number; rejected: number } {
  const stats = { peak: 0, rejected: 0 }
  let open = 0
  let seen = 0
  let held: (() => void)[] = []
  node.handler = (request, response) => {
    seen += 1
    open += 1
    stats.peak = Math.max(stats.peak, open)
    if (open > capacity) {
      open -= 1
      stats.rejected += 1
      rejectWorkQueueFull(response)
    } else {
      const reply = (): void => {
        open -= 1
        answer(request, response)
      }
      if (holdUntilSeen === undefined) setTimeout(reply, 5)
      else held.push(reply)
    }
    if (holdUntilSeen !== undefined && seen >= holdUntilSeen) {
      for (const reply of held) reply()
      held = []
    }
  }
  return stats
}

interface Held {
  /** The method, or `check` for a chain check and `batch` for another batch. */
  readonly method: string
  readonly response: ServerResponse
  /** Answer from RESULTS, with `results` in place of some methods' result texts. */
  answer(results?: Record<string, string>): void
}

/** Hold every request until the test answers it; the list is in arrival order. */
function holdRequests(): Held[] {
  const held: Held[] = []
  node.handler = (request, response) => {
    const parsed = JSON.parse(request.body) as RpcCall | RpcCall[]
    held.push({
      method: !Array.isArray(parsed) ? parsed.method : parsed[0]?.method === 'getblockchaininfo' ? 'check' : 'batch',
      response,
      answer: results => answer(request, response, results),
    })
  }
  return held
}

function client(options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
    retryDelayMs: 0,
    ...options,
  })
}

/** A client whose chain is confirmed, with the node's request log empty and no handler in place. */
async function confirmed(options: Partial<QbitRpcClientOptions> = {}): Promise<QbitRpcClient> {
  const rpc = client(options)
  node.handler = answer
  await rpc.confirmChain()
  node.requests.length = 0
  return rpc
}

const methods = (): string[] => node.calls().map(call => call.method)
const settle = (ms = 30): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e
  )
}

function expectWorkQueueRejection(error: unknown, method: string): void {
  expect(RpcUnknownOutcomeError.is(error)).toBe(false)
  expect(RpcTransportError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason: 'http_status', status: 503, method })
}

describe('maxConcurrentRequests', () => {
  it('keeps a burst of side-effecting calls within the node work queue', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 3 })
    const queue = workQueue(3)
    const addresses = await Promise.all(Array.from({ length: 20 }, () => rpc.getRawChangeAddress()))
    expect(addresses).toEqual(Array.from({ length: 20 }, () => ADDRESS))
    // A fourth request open at once would have been rejected.
    expect(queue.rejected).toBe(0)
    expect(queue.peak).toBeLessThanOrEqual(3)
    expect(node.requests).toHaveLength(20)
  })

  it('defaults to 8, fresh connections included', async () => {
    const rpc = await confirmed()
    const held = holdRequests()
    const locks = Promise.all(Array.from({ length: 20 }, () => rpc.walletLock()))
    for (const wave of [8, 8, 4]) {
      await expect.poll(() => held.length).toBe(wave)
      await settle()
      expect(held).toHaveLength(wave)
      for (const request of held.splice(0)) request.answer()
    }
    await locks
  })

  it('leaves the 503s to a higher limit, as unknown outcomes without directNode', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 20 })
    const queue = workQueue(3, 20)
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => rpc.getRawChangeAddress()))
    const errors = outcomes.flatMap(outcome => (outcome.status === 'rejected' ? [outcome.reason as unknown] : []))
    expect(queue).toEqual({ peak: 4, rejected: 17 })
    expect(errors).toHaveLength(17)
    for (const error of errors) {
      expect(RpcUnknownOutcomeError.is(error)).toBe(true)
      expect((error as Error).cause).toMatchObject({ reason: 'http_status', status: 503 })
    }
  })

  it('reports a timeout while queued as a plain RpcTimeoutError: nothing sent, no slot lost', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1 })
    const held = holdRequests()
    const running = rpc.walletLock()
    await expect.poll(() => held.length).toBe(1)

    const error = await failure(rpc.sendRawTransaction(TX_HEX, { timeoutMs: 30 }))
    expect(RpcTimeoutError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'sendrawtransaction', timeoutMs: 30 })
    expect(node.requests).toHaveLength(1)

    held[0]!.answer()
    await running
    node.handler = answer
    await rpc.walletLock()
    expect(methods()).toEqual(['walletlock', 'walletlock'])
  })

  it('reports an abort while queued as a plain RpcAbortedError, and the next in line goes ahead', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1 })
    const held = holdRequests()
    const running = rpc.walletLock()
    await expect.poll(() => held.length).toBe(1)

    const controller = new AbortController()
    const reason = new Error('changed my mind')
    const aborted = failure(rpc.getRawChangeAddress({ signal: controller.signal }))
    const next = rpc.getBlockCount()
    controller.abort(reason)
    const error = await aborted
    expect(RpcAbortedError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'getrawchangeaddress', cause: reason })
    expect(node.requests).toHaveLength(1)

    held[0]!.answer()
    await running
    await expect.poll(() => held.length).toBe(2)
    expect(held[1]!.method).toBe('getblockcount')
    held[1]!.answer()
    expect(await next).toBe(10)
    await settle()
    expect(methods()).toEqual(['walletlock', 'getblockcount'])
  })

  it('reports an abort between taking a free slot and starting as definite, and frees the slot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-limit-'))
    try {
      const cookieFile = join(dir, '.cookie')
      await writeFile(cookieFile, '__cookie__:secret')
      const rpc = await confirmed({ auth: { cookieFile }, maxConcurrentRequests: 1 })
      const controller = new AbortController()
      const aborted = failure(rpc.walletLock({ signal: controller.signal }))
      controller.abort()
      const error = await aborted
      expect(RpcAbortedError.is(error)).toBe(true)
      expect(node.requests).toHaveLength(0)
      await rpc.walletLock()
      expect(methods()).toEqual(['walletlock'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sends queued calls first in, first out, ahead of a newcomer', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1 })
    const held = holdRequests()
    const first = rpc.getBlockHash(0)
    await expect.poll(() => held.length).toBe(1)
    const queued = [1, 2, 3].map(height => rpc.getBlockHash(height))
    // A call made as soon as the first one finishes must not take its slot from the queue.
    const newcomer = first.then(() => rpc.getBlockHash(4))
    held[0]!.answer()
    for (let n = 2; n <= 5; n += 1) {
      await expect.poll(() => held.length).toBe(n)
      await settle(5)
      expect(held).toHaveLength(n)
      held[n - 1]!.answer()
    }
    await Promise.all([...queued, newcomer])
    expect(node.calls().map(call => call.params[0])).toEqual([0, 1, 2, 3, 4])
  })

  it('gives each released slot to exactly one waiter when calls finish out of order', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 2 })
    const held = holdRequests()
    const calls = [0, 1, 2, 3, 4].map(height => rpc.getBlockHash(height))
    await expect.poll(() => held.length).toBe(2)
    await settle()
    expect(held).toHaveLength(2)

    held[1]!.answer() // the second finishes first
    await expect.poll(() => held.length).toBe(3)
    await settle()
    expect(held).toHaveLength(3)
    held[0]!.answer()
    await expect.poll(() => held.length).toBe(4)
    held[3]!.answer()
    await expect.poll(() => held.length).toBe(5)
    held[2]!.answer()
    held[4]!.answer()
    await Promise.all(calls)
    expect(node.calls().map(call => call.params[0])).toEqual([0, 1, 2, 3, 4])
  })

  it('does not let an aborted waiter take a slot or free one', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1 })
    const held = holdRequests()
    const running = rpc.getBlockHash(0)
    await expect.poll(() => held.length).toBe(1)
    const controller = new AbortController()
    const aborted = failure(rpc.getBlockHash(1, { signal: controller.signal }))
    const next = [2, 3].map(height => rpc.getBlockHash(height))
    controller.abort()
    await aborted
    // Giving up frees nothing: the slot is still with the running call.
    await settle()
    expect(held).toHaveLength(1)

    held[0]!.answer()
    await running
    await expect.poll(() => held.length).toBe(2)
    await settle()
    expect(held).toHaveLength(2)
    held[1]!.answer()
    await expect.poll(() => held.length).toBe(3)
    held[2]!.answer()
    await Promise.all(next)
    expect(node.calls().map(call => call.params[0])).toEqual([0, 2, 3])
  })

  type Respond = (request: RecordedRequest, response: ServerResponse) => void
  const idOf = (request: RecordedRequest): number => (JSON.parse(request.body) as { id: number }).id
  const respondWith =
    (status: number, body = ''): Respond =>
    (_request, response) => {
      response.statusCode = status
      response.end(body)
    }
  const drop: Respond = (_request, response) => response.socket?.destroy()
  const hang: Respond = () => {}
  const walletLock = (rpc: QbitRpcClient): Promise<unknown> => rpc.walletLock()
  const getBlockCount = (rpc: QbitRpcClient): Promise<unknown> => rpc.getBlockCount()
  const failing: [
    name: string,
    run: (rpc: QbitRpcClient) => Promise<unknown>,
    respond: Respond,
    expected: { is(value: unknown): boolean },
  ][] = [
    [
      'a node error',
      walletLock,
      (request, response) => response.end(`{"jsonrpc":"2.0","error":{"code":-1,"message":"no"},"id":${idOf(request)}}`),
      RpcError,
    ],
    ['a dropped connection', walletLock, drop, RpcUnknownOutcomeError],
    ['a dropped read', getBlockCount, drop, RpcTransportError],
    ['an HTTP 500', walletLock, respondWith(500), RpcUnknownOutcomeError],
    ['an HTTP 401', walletLock, respondWith(401), RpcTransportError],
    ['a malformed reply', walletLock, respondWith(200, '{"jsonrpc"'), RpcUnknownOutcomeError],
    ['a malformed read', getBlockCount, respondWith(200, '{"jsonrpc"'), RpcResponseError],
    [
      'a reply that fails validation',
      getBlockCount,
      (request, response) => response.end(`{"jsonrpc":"2.0","result":"ten","id":${idOf(request)}}`),
      RpcResponseError,
    ],
    ['an oversized reply', getBlockCount, respondWith(200, 'x'.repeat(4096)), RpcResponseTooLargeError],
    ['a timeout after sending', rpc => rpc.walletLock({ timeoutMs: 150 }), hang, RpcUnknownOutcomeError],
    ['a read timeout after sending', rpc => rpc.getBlockCount({ timeoutMs: 30 }), hang, RpcTimeoutError],
    [
      'an abort after sending',
      rpc => rpc.walletLock({ signal: AbortSignal.timeout(150) }),
      hang,
      RpcUnknownOutcomeError,
    ],
    [
      'a read abort after sending',
      rpc => rpc.getBlockCount({ signal: AbortSignal.timeout(30) }),
      hang,
      RpcAbortedError,
    ],
    ['a failed batch', rpc => rpc.batch([requests.getBlockCount()]), respondWith(500), RpcTransportError],
  ]
  it.each(failing)('frees the slot after %s', async (_name, run, respond, expected) => {
    const rpc = await confirmed({ maxConcurrentRequests: 1, maxResponseBytes: 2048 })
    node.handler = respond
    expect(expected.is(await failure(run(rpc)))).toBe(true)
    node.handler = answer
    expect(await rpc.getBlockCount({ timeoutMs: 5000 })).toBe(10)
  })

  it('frees the slot after a cookie read failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-limit-'))
    try {
      const cookieFile = join(dir, '.cookie')
      const rpc = client({ auth: { cookieFile }, maxConcurrentRequests: 1 })
      node.handler = answer
      const error = await failure(rpc.getBlockCount())
      expect(error).toMatchObject({ reason: 'credentials', code: 'ENOENT' })
      await writeFile(cookieFile, '__cookie__:secret')
      expect(await rpc.getBlockCount({ timeoutMs: 5000 })).toBe(10)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('counts a batch once, and a batch can time out in the queue', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1 })
    const held = holdRequests()
    const batch = rpc.batch([requests.getBlockCount(), requests.getBestBlockHash(), requests.getBlockHash(1)])
    await expect.poll(() => held.length).toBe(1)
    expect(held[0]!.method).toBe('batch')

    const error = await failure(rpc.batch([requests.getBlockCount()], { timeoutMs: 30 }))
    expect(RpcTimeoutError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'batch(1)' })
    const next = rpc.getBlockCount()
    await settle()
    expect(held).toHaveLength(1)

    held[0]!.answer()
    expect((await batch).every(item => item.ok)).toBe(true)
    await expect.poll(() => held.length).toBe(2)
    held[1]!.answer()
    expect(await next).toBe(10)
  })

  it('runs a chain re-check in its call slot: a limit of 1 does not deadlock', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1, chainCheckMaxAgeMs: 0 })
    const queue = workQueue(1)
    await Promise.all([rpc.walletLock(), rpc.walletLock(), rpc.walletLock()])
    expect(methods()).toEqual([...CHECK, 'walletlock', ...CHECK, 'walletlock', ...CHECK, 'walletlock'])
    expect(queue).toEqual({ peak: 1, rejected: 0 })
  })

  it('holds one slot across a chain re-check and its call, so nothing queued gets in between', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1, chainCheckMaxAgeMs: 0 })
    const held = holdRequests()
    const guardedCall = rpc.walletLock()
    await expect.poll(() => held.length).toBe(1)
    const read = rpc.getBlockCount()
    expect(held[0]!.method).toBe('check')
    held[0]!.answer()
    await expect.poll(() => held.length).toBe(2)
    expect(held[1]!.method).toBe('walletlock')
    await settle()
    expect(held).toHaveLength(2)
    held[1]!.answer()
    await guardedCall
    await expect.poll(() => held.length).toBe(3)
    expect(held[2]!.method).toBe('getblockcount')
    held[2]!.answer()
    await read
  })

  it('refuses a queued guarded call when another call finds another chain during its wait', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1 })
    const held = holdRequests()
    const check = failure(rpc.confirmChain())
    await expect.poll(() => held.length).toBe(1)
    const queued = failure(rpc.sendRawTransaction(TX_HEX))
    held[0]!.answer(chainResults('main'))
    expect(RpcChainGuardError.is(await check)).toBe(true)

    const refused = await queued
    expect(RpcChainGuardError.is(refused)).toBe(true)
    expect(refused).toMatchObject({ reason: 'mismatch', method: 'sendrawtransaction', actual: 'main' })
    expect(methods()).toEqual([...CHECK])
  })

  it('re-checks a queued guarded call whose confirmation went stale during its wait', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1, chainCheckMaxAgeMs: 300 })
    const held = holdRequests()
    const read = rpc.getBlockCount()
    await expect.poll(() => held.length).toBe(1)
    const queued = rpc.walletLock()
    await settle(320)
    expect(rpc.chainStatus).toBe('stale')
    held[0]!.answer()
    await read
    node.handler = answer
    await queued
    expect(methods()).toEqual(['getblockcount', ...CHECK, 'walletlock'])
  })

  it('frees the slot during a retry backoff, and the retry queues again', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1, readRetries: 1, retryDelayMs: 300 })
    let attempts = 0
    node.handler = (request, response) => {
      const { method } = JSON.parse(request.body) as RpcCall
      if (method === 'getblockcount' && (attempts += 1) === 1) {
        response.statusCode = 500
        response.end()
        return
      }
      answer(request, response)
    }
    const retried = rpc.getBlockCount()
    await expect.poll(() => attempts).toBe(1)
    // The first attempt has failed, so the other call gets the slot long before the retry.
    await rpc.getBestBlockHash({ timeoutMs: 250 })
    expect(methods()).toEqual(['getblockcount', 'getbestblockhash'])
    expect(await retried).toBe(10)
    expect(methods()).toEqual(['getblockcount', 'getbestblockhash', 'getblockcount'])
  })

  it('keeps the slot for the extra attempt after a stale keep-alive connection, ahead of the queue', async () => {
    const rpc = await confirmed({ maxConcurrentRequests: 1 })
    let dropped = false
    node.handler = (request, response) => {
      if (!dropped && request.idleMs !== undefined) {
        dropped = true
        return void response.socket?.destroy()
      }
      answer(request, response)
    }
    const first = rpc.getBlockCount()
    const second = rpc.getBestBlockHash()
    expect(await first).toBe(10)
    expect(await second).toBe(HASH_A)
    expect(methods()).toEqual(['getblockcount', 'getblockcount', 'getbestblockhash'])
  })

  it('sizes the keep-alive pool to the limit', async () => {
    const wide = client({ maxConcurrentRequests: 12 })
    const held = holdRequests()
    const reads = Array.from({ length: 12 }, () => wide.getBlockCount())
    await expect.poll(() => held.length).toBe(12)
    for (const request of held) request.answer()
    await Promise.all(reads)
    wide.close()

    // And the pool without the limiter: a transport for 2 has 2 requests out at once.
    held.length = 0
    const transport = new HttpTransport(2)
    const fewer = Array.from({ length: 4 }, () =>
      transport.send({
        url: new URL(node.url),
        authorization: 'Basic dTpw',
        body: '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}',
        signal: new AbortController().signal,
        maxResponseBytes: 1024,
        freshConnection: false,
      })
    )
    await expect.poll(() => held.length).toBe(2)
    await settle()
    expect(held).toHaveLength(2)
    held[0]!.answer()
    held[1]!.answer()
    await expect.poll(() => held.length).toBe(4)
    held[2]!.answer()
    held[3]!.answer()
    await Promise.all(fewer)
    transport.close()
  })

  it.each([[0], [-1], [1025], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], ['8'], [null], [true], [8n]])(
    'rejects maxConcurrentRequests %o at construction',
    value => {
      expect(() => client({ maxConcurrentRequests: value as number })).toThrow(
        /maxConcurrentRequests must be an integer/
      )
    }
  )

  it.each([[1], [8], [1024], [undefined]])('accepts maxConcurrentRequests %s', value => {
    const rpc = client(value === undefined ? {} : { maxConcurrentRequests: value })
    rpc.close()
  })
})

describe('directNode', () => {
  it('reports the work-queue 503 on a side-effecting call as a plain RpcTransportError, never retried', async () => {
    const rpc = await confirmed({ directNode: true, readRetries: 5 })
    node.handler = (_request, response) => rejectWorkQueueFull(response)
    expectWorkQueueRejection(await failure(rpc.sendRawTransaction(TX_HEX)), 'sendrawtransaction')
    expectWorkQueueRejection(await failure(rpc.getRawChangeAddress()), 'getrawchangeaddress')
    expect(node.requests).toHaveLength(2)
  })

  it('reports the 503s of an over-limit burst as plain errors, with the others untouched', async () => {
    const rpc = await confirmed({ directNode: true, maxConcurrentRequests: 20 })
    const queue = workQueue(3, 20)
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => rpc.getRawChangeAddress()))
    expect(queue.rejected).toBe(17)
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(3)
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expectWorkQueueRejection(outcome.reason, 'getrawchangeaddress')
    }
  })

  function rejectTimes(times: number): void {
    let rejections = 0
    node.handler = (request, response) => {
      if ((rejections += 1) <= times) rejectWorkQueueFull(response)
      else answer(request, response)
    }
  }

  it('retries it under readRetries for a read', async () => {
    const rpc = client({ directNode: true, readRetries: 2 })
    rejectTimes(2)
    expect(await rpc.getBlockCount()).toBe(10)
    expect(node.requests).toHaveLength(3)
  })

  it('retries it under readRetries for a batch', async () => {
    const rpc = client({ directNode: true, readRetries: 1 })
    rejectTimes(1)
    const [count] = await rpc.batch([requests.getBlockCount()])
    expect(count).toEqual({ ok: true, value: 10 })
    expect(node.requests).toHaveLength(2)
  })

  it('retries it under readRetries for a guarded call without side effects', async () => {
    const rpc = await confirmed({ directNode: true, readRetries: 1 })
    rejectTimes(1)
    await expect(rpc.finalizePsbt('cHNidP8=')).resolves.toMatchObject({ complete: false })
    expect(node.requests).toHaveLength(2)
  })

  it('does not retry it for a read without readRetries', async () => {
    const rpc = client({ directNode: true })
    rejectTimes(1)
    expectWorkQueueRejection(await failure(rpc.getBlockCount()), 'getblockcount')
    expect(node.requests).toHaveLength(1)
  })

  const other: [name: string, status: number, body: string][] = [
    ['a 503 with another body', 503, 'Service Unavailable'],
    ['a 503 with an empty body', 503, ''],
    ['a 503 with a trailing newline', 503, `${WORK_QUEUE_BODY}\n`],
    ['a 503 in another case', 503, WORK_QUEUE_BODY.toLowerCase()],
    ['a 500 with the exact body', 500, WORK_QUEUE_BODY],
    ['a 502 with the exact body', 502, WORK_QUEUE_BODY],
    ['a 504 with the exact body', 504, WORK_QUEUE_BODY],
  ]
  it.each(other)('keeps %s unknown for a side-effecting call', async (_name, status, body) => {
    const rpc = await confirmed({ directNode: true })
    node.handler = (_request, response) => {
      response.statusCode = status
      response.end(body)
    }
    const error = await failure(rpc.walletLock())
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect((error as Error).cause).toMatchObject({ reason: 'http_status', status })
  })

  it('keeps the exact body under HTTP 200 a malformed reply', async () => {
    const rpc = await confirmed({ directNode: true })
    node.handler = (_request, response) => response.end(WORK_QUEUE_BODY)
    const error = await failure(rpc.walletLock())
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(RpcResponseError.is((error as Error).cause)).toBe(true)
  })

  it.each([[undefined], [false]])('keeps the exact 503 unknown with directNode %s', async directNode => {
    const rpc = await confirmed(directNode === undefined ? {} : { directNode })
    node.handler = (_request, response) => rejectWorkQueueFull(response)
    const error = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect((error as Error).cause).toMatchObject({ reason: 'http_status', status: 503 })
  })

  it.each([['true'], [1], [0], [null], [{}]])('rejects directNode %o at construction', value => {
    expect(() => client({ directNode: value as boolean })).toThrow(new TypeError('directNode must be a boolean'))
  })
})

describe('Limiter', () => {
  const live = new AbortController().signal

  it('passes a released slot to exactly one waiter, oldest first', async () => {
    const limiter = new Limiter(1)
    await limiter.acquire(live)
    const order: string[] = []
    const a = limiter.acquire(live).then(() => order.push('a'))
    const b = limiter.acquire(live).then(() => order.push('b'))
    limiter.release()
    await a
    await settle(5)
    expect(order).toEqual(['a'])
    limiter.release()
    await b
    expect(order).toEqual(['a', 'b'])
  })

  it('keeps the queue ahead of a newcomer after a release', async () => {
    const limiter = new Limiter(1)
    await limiter.acquire(live)
    const order: string[] = []
    const waiter = limiter.acquire(live).then(() => order.push('waiter'))
    limiter.release()
    const newcomer = limiter.acquire(live).then(() => order.push('newcomer'))
    await waiter
    await settle(5)
    expect(order).toEqual(['waiter'])
    limiter.release()
    await newcomer
    expect(order).toEqual(['waiter', 'newcomer'])
  })

  it('removes an aborted waiter without granting it or freeing a slot', async () => {
    const limiter = new Limiter(1)
    await limiter.acquire(live)
    const controller = new AbortController()
    const reason = new Error('stop')
    const aborted = limiter.acquire(controller.signal)
    let granted = false
    const next = limiter.acquire(live).then(() => {
      granted = true
    })
    controller.abort(reason)
    await expect(aborted).rejects.toBe(reason)
    await settle(5)
    expect(granted).toBe(false)
    limiter.release()
    await next
    expect(granted).toBe(true)
  })

  it('leaves a slot with a waiter granted before its signal fired', async () => {
    const limiter = new Limiter(1)
    await limiter.acquire(live)
    const controller = new AbortController()
    const granted = limiter.acquire(controller.signal)
    limiter.release()
    controller.abort() // too late: the slot is the waiter's, and it must release it
    await granted
    let next = false
    const after = limiter.acquire(live).then(() => {
      next = true
    })
    await settle(5)
    expect(next).toBe(false)
    limiter.release()
    await after
  })

  it('refuses an already aborted signal, holding nothing', async () => {
    const limiter = new Limiter(1)
    const reason = new Error('stop')
    await expect(limiter.acquire(AbortSignal.abort(reason))).rejects.toBe(reason)
    await limiter.acquire(live)
  })

  it('frees a slot when nobody waits', async () => {
    const limiter = new Limiter(2)
    await limiter.acquire(live)
    await limiter.acquire(live)
    limiter.release()
    limiter.release()
    await limiter.acquire(live)
    await limiter.acquire(live)
  })
})
