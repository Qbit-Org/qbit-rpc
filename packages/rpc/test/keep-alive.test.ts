import { getEventListeners } from 'node:events'
import { createServer, type ClientRequest, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire, syncBuiltinESMExports } from 'node:module'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  QbitRpcClient,
  requests,
  RpcAbortedError,
  RpcChainGuardError,
  RpcTimeoutError,
  RpcTransportError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
} from '../src'
import { ExchangeFailure, HttpTransport, STALE_SOCKET_WINDOW_MS, type Exchange } from '../src/transport'
import { blockchainInfoJson, FakeNode, HASH_A, TX_HEX, type RecordedRequest } from './helpers/fake-node'

let node: FakeNode

const results = (chain: string): Record<string, string> => ({
  getblockchaininfo: blockchainInfoJson(chain),
  getblockcount: '10',
  getbestblockhash: JSON.stringify(HASH_A),
  listunspent: '[]',
  testmempoolaccept: '[]',
  finalizepsbt: '{"psbt":"cHNidP8=","complete":false}',
  walletlock: 'null',
  lockunspent: 'true',
  sendrawtransaction: JSON.stringify(requests.raw('sendrawtransaction', [TX_HEX]).txid),
})

beforeEach(async () => {
  node = await FakeNode.start()
  node.results(results('regtest'))
})
afterEach(async () => {
  await node.close()
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function client(options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
    chainCheckMaxAgeMs: 86_400_000,
    retryDelayMs: 0,
    ...options,
  })
}

/** A client whose chain is confirmed, leaving one used socket in its pool; the node's request log is cleared. */
async function pooled(options: Partial<QbitRpcClientOptions> = {}): Promise<QbitRpcClient> {
  const rpc = client(options)
  await rpc.confirmChain()
  node.requests.length = 0
  return rpc
}

const methods = (): string[] => node.calls().map(call => call.method)

/** The request came on a connection that had served one before. */
const reused = (request: RecordedRequest): boolean => request.idleMs !== undefined

/**
 * Leave requests matching `drop` unanswered and destroy their connection, as
 * when qbitd's close of an idle connection crosses the client's request.
 */
function dropWhen(drop: (request: RecordedRequest) => boolean): void {
  const answer = node.handler
  node.handler = (request, response) => (drop(request) ? response.socket?.destroy() : answer(request, response))
}

/** Drop the next request on a reused connection, and no other. */
function dropNextReused(): void {
  let armed = true
  dropWhen(request => {
    if (!armed || !reused(request)) return false
    armed = false
    return true
  })
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e
  )
}

/** Run `body` with every request on a reused socket failing with `code`, as no loopback peer can make it fail. */
async function withReusedSocketsFailing(code: string, body: (made: () => number) => Promise<void>): Promise<void> {
  const http = createRequire(import.meta.url)('node:http') as { request: (...args: unknown[]) => ClientRequest }
  const request = http.request
  let made = 0
  http.request = (...args: unknown[]): ClientRequest => {
    made += 1
    const outgoing = request(...args)
    outgoing.once('socket', socket => {
      if (outgoing.reusedSocket) socket.destroy(Object.assign(new Error(code), { code }))
    })
    return outgoing
  }
  syncBuiltinESMExports()
  try {
    await body(() => made)
  } finally {
    http.request = request
    syncBuiltinESMExports()
  }
}

describe('a pooled connection the node closed', () => {
  const CLOSE_AFTER_MS = 200
  const GAPS = [150, 170, 190, 210, 230, 250]
  /** A request reaching a connection idle about that long is one the node's close crossed. */
  const crossesClose = (request: RecordedRequest): boolean =>
    request.idleMs !== undefined && request.idleMs >= CLOSE_AFTER_MS - 60

  it('loses no read when the node closes idle connections at N ms and calls come N ± 50 ms apart', async () => {
    node.closeIdleAfter(CLOSE_AFTER_MS)
    dropWhen(crossesClose)
    const rpc = client({ readRetries: 0 })
    await rpc.confirmChain()
    for (const gap of GAPS) {
      await sleep(gap)
      expect(await rpc.getBlockCount()).toBe(10)
    }
  })

  it('recovers every read that crosses the close, and the chain goes stale', async () => {
    // The node does not close first here, so a late timer only leaves a connection idle for longer: each call crosses.
    node.closeIdleAfter(60_000)
    dropWhen(crossesClose)
    const rpc = client({ readRetries: 0 })
    await rpc.confirmChain()
    for (const gap of GAPS) {
      await sleep(gap)
      expect(await rpc.getBlockCount()).toBe(10)
    }
    expect(node.requests.map(reused)).toEqual([false, ...GAPS.flatMap(() => [true, false])])
    // A reset can also be a qbitd restart, so the chain confirmation goes stale anyway.
    expect(rpc.chainStatus).toBe('stale')
  })

  it('keeps the chain confirmed while pooled connections keep working', async () => {
    const rpc = await pooled()
    for (let i = 0; i < 3; i += 1) expect(await rpc.getBlockCount()).toBe(10)
    expect(node.requests.map(reused)).toEqual([true, true, true])
    expect(rpc.chainStatus).toBe('confirmed')
  })

  it.each([
    ['a read', (rpc: QbitRpcClient) => rpc.getBlockCount(), ['getblockcount']],
    [
      'a batch',
      (rpc: QbitRpcClient) => rpc.batch([requests.getBlockCount(), requests.getBestBlockHash()]),
      ['getblockcount', 'getbestblockhash'],
    ],
    ['a wallet read', (rpc: QbitRpcClient) => rpc.listUnspent(), ['listunspent']],
  ])('sends %s again at once on a new pooled connection, with readRetries 0', async (_name, run, sent) => {
    // A backoff this long would fail the call against its deadline.
    const rpc = await pooled({ retryDelayMs: 60_000 })
    dropNextReused()
    await run(rpc)
    expect(methods()).toEqual([...sent, ...sent])
    const [stale, again] = node.requests
    expect(reused(stale!)).toBe(true)
    expect(reused(again!)).toBe(false)
    expect(again!.headers.connection).toBe('keep-alive')
    expect(rpc.chainStatus).toBe('stale')
  })

  const GUARDED: [string, (rpc: QbitRpcClient) => Promise<unknown>][] = [
    ['finalizepsbt', rpc => rpc.call('finalizepsbt', ['cHNidP8='])],
    ['testmempoolaccept', rpc => rpc.call('testmempoolaccept', [[TX_HEX]])],
  ]

  it.each(GUARDED)('re-checks the chain before sending %s again', async (method, run) => {
    const rpc = await pooled()
    dropNextReused()
    await run(rpc)
    expect(methods()).toEqual([method, 'getblockchaininfo', method])
    expect(rpc.chainStatus).toBe('confirmed')
  })

  it.each(GUARDED)('refuses %s with nothing re-sent when the node now reports another chain', async (method, run) => {
    const rpc = await pooled()
    node.results(results('main'))
    dropNextReused()
    const error = await failure(run(rpc))
    expect(RpcChainGuardError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'mismatch', method, expected: 'regtest', actual: 'main' })
    expect(methods()).toEqual([method, 'getblockchaininfo'])
    expect(rpc.chainStatus).toBe('mismatch')
  })

  it('tries a guarded call without side effects again when its chain re-check is what reset', async () => {
    const rpc = await pooled({ chainCheckMaxAgeMs: 0 })
    dropNextReused()
    await rpc.call('finalizepsbt', ['cHNidP8='])
    expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo', 'finalizepsbt'])
  })

  const SIDE_EFFECTS: [string, (rpc: QbitRpcClient) => Promise<unknown>][] = [
    ['walletlock', rpc => rpc.walletLock()],
    ['sendrawtransaction', rpc => rpc.sendRawTransaction(TX_HEX)],
    ['lockunspent', rpc => rpc.lockUnspent(false, [{ txid: HASH_A, vout: 0 }])],
  ]

  it.each(SIDE_EFFECTS)(
    'checks the chain again when the re-check before %s reset, then sends it once',
    async (method, run) => {
      const rpc = await pooled({ chainCheckMaxAgeMs: 0 })
      dropNextReused()
      await run(rpc)
      expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo', method])
      expect(node.requests[2]!.headers.connection).toBe('close')
    }
  )

  it.each(SIDE_EFFECTS)('does not send %s when the second re-check finds another chain', async (method, run) => {
    const rpc = await pooled({ chainCheckMaxAgeMs: 0 })
    node.results(results('main'))
    dropNextReused()
    const error = await failure(run(rpc))
    expect(RpcChainGuardError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'mismatch', method, actual: 'main' })
    expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo'])
  })

  it.each(SIDE_EFFECTS)('fails %s plainly, unsent, when the second re-check fails too', async (_method, run) => {
    // readRetries does not apply: this is the one extra attempt and no more.
    const rpc = await pooled({ chainCheckMaxAgeMs: 0, readRetries: 3 })
    dropWhen(() => true)
    const error = await failure(run(rpc))
    expect(RpcTransportError.is(error)).toBe(true)
    expect(RpcUnknownOutcomeError.is(error)).toBe(false)
    expect(error).toMatchObject({ reason: 'network', method: 'getblockchaininfo' })
    expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo'])
  })

  it('never sends a side-effecting request again, whatever marks its failure', async () => {
    const rpc = await pooled({ readRetries: 3 })
    const send = vi
      .spyOn(HttpTransport.prototype, 'send')
      .mockRejectedValue(new ExchangeFailure('network', true, 'ECONNRESET', true))
    try {
      const error = await failure(rpc.sendRawTransaction(TX_HEX))
      expect(RpcUnknownOutcomeError.is(error)).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      send.mockRestore()
    }
  })

  it('gives a reset long after the request was written no extra attempt: the node failed during it', async () => {
    const rpc = await pooled()
    node.handler = (_request, response) =>
      void setTimeout(() => response.socket?.destroy(), STALE_SOCKET_WINDOW_MS + 200)
    const error = await failure(rpc.getBlockCount())
    expect(RpcTransportError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'network', code: 'ECONNRESET' })
    expect(node.requests).toHaveLength(1)
    expect(rpc.chainStatus).toBe('stale')
  })

  it.each([
    [0, 2],
    [1, 3],
  ])(
    'with readRetries %i, fails with the network error after %i requests when the next attempt fails too',
    async (readRetries, sent) => {
      const rpc = await pooled({ readRetries })
      dropWhen(() => true)
      const error = await failure(rpc.getBlockCount())
      expect(RpcTransportError.is(error)).toBe(true)
      expect(error).toMatchObject({ reason: 'network', method: 'getblockcount' })
      // The extra attempt is the second; readRetries' attempts follow as before.
      expect(node.requests.map(reused)).toEqual([true, ...Array<boolean>(sent - 1).fill(false)])
      // A real connection failure still counts as one.
      expect(rpc.chainStatus).toBe('stale')
    }
  )

  it.each([
    [0, 2],
    [2, 4],
  ])(
    'gives an operation one extra attempt only: with readRetries %i, stale every time, %i sends',
    async (readRetries, sends) => {
      const rpc = await pooled({ readRetries })
      const send = vi
        .spyOn(HttpTransport.prototype, 'send')
        .mockRejectedValue(new ExchangeFailure('network', true, 'ECONNRESET', true))
      try {
        await expect(rpc.getBlockCount()).rejects.toMatchObject({ reason: 'network', code: 'ECONNRESET' })
        expect(send).toHaveBeenCalledTimes(sends)
      } finally {
        send.mockRestore()
      }
    }
  )

  it('does not count the extra attempt against readRetries', async () => {
    const rpc = await pooled({ readRetries: 1 })
    const answer = node.handler
    const script = ['drop', '503']
    node.handler = (request, response) => {
      const step = script.shift()
      if (step === 'drop') return response.socket?.destroy()
      if (step === '503') {
        response.statusCode = 503
        return response.end()
      }
      return answer(request, response)
    }
    expect(await rpc.getBlockCount()).toBe(10)
    expect(node.requests).toHaveLength(3)
  })

  it('closes the idle connections pooled with a reset one, so the next attempt does not find one dead', async () => {
    const rpc = client()
    await Promise.all([rpc.getBlockCount(), rpc.getBlockCount(), rpc.getBlockCount()])
    const idle = new Set(node.requests.map(request => request.remotePort))
    expect(idle.size).toBe(3)
    node.requests.length = 0
    // The three went idle together, and the node closed them all as the next read went out.
    dropWhen(request => idle.has(request.remotePort))
    expect(await rpc.getBlockCount()).toBe(10)
    await expect.poll(() => node.connections).toBe(1)
    expect(await rpc.getBlockCount()).toBe(10)
    expect(node.requests.map(request => idle.has(request.remotePort))).toEqual([true, false, false])
    expect(node.requests.map(reused)).toEqual([true, false, true])
  })

  it("does not retry a failure on a connection's first request", async () => {
    dropWhen(() => true)
    const rpc = client()
    const error = await failure(rpc.getBlockCount())
    expect(error).toMatchObject({ reason: 'network' })
    expect(node.requests).toHaveLength(1)
  })

  it.each([
    ['part of a status line', (response: ServerResponse) => response.socket?.end('HTTP/1.1 200')],
    // The HTTP parser fails on this first chunk before any listener added after it runs.
    ['bytes that are not HTTP', (response: ServerResponse) => response.socket?.write('not http\r\n\r\n')],
    [
      'the headers and part of the body',
      (response: ServerResponse) => {
        response.writeHead(200, { 'content-length': '100' })
        response.write('{"jsonrpc"')
        setTimeout(() => response.socket?.destroy(), 20)
      },
    ],
  ])('does not retry after %s arrived', async (_name, respond) => {
    const rpc = await pooled()
    node.handler = (_request, response) => respond(response)
    const error = await failure(rpc.getBlockCount())
    expect(RpcTransportError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'network' })
    expect(node.requests).toHaveLength(1)
  })

  it.each([
    ['EPIPE', 'answered', 2],
    ['ETIMEDOUT', 'ETIMEDOUT', 1],
  ])('on a reused socket, %s ends as %s after %i requests', async (code, outcome, sent) => {
    const rpc = await pooled()
    await withReusedSocketsFailing(code, async made => {
      const read = await rpc.getBlockCount().then(
        () => 'answered',
        (error: unknown) => (error as { code?: string }).code
      )
      expect(read).toBe(outcome)
      expect(made()).toBe(sent)
    })
  })

  it.each([
    ['sendrawtransaction', (rpc: QbitRpcClient) => rpc.sendRawTransaction(TX_HEX)],
    ['lockunspent', (rpc: QbitRpcClient) => rpc.lockUnspent(false, [{ txid: HASH_A, vout: 0 }])],
  ])('never retries %s: one request, on a new connection, and an unknown outcome', async (method, run) => {
    const rpc = await pooled({ readRetries: 3 })
    await rpc.getBlockCount()
    node.requests.length = 0
    dropWhen(() => true)
    const error = await failure(run(rpc))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(RpcTransportError.is((error as Error).cause)).toBe(true)
    expect(methods()).toEqual([method])
    expect(reused(node.requests[0]!)).toBe(false)
    expect(node.requests[0]!.headers.connection).toBe('close')
  })
})

describe('one deadline across the extra attempt', () => {
  it('times the extra attempt out with the rest of the operation and releases its connection', async () => {
    const rpc = await pooled()
    // The stale attempt fails after 500 ms, within the stale-socket window; the next is never answered.
    node.handler = (request, response) => {
      if (reused(request)) setTimeout(() => response.socket?.destroy(), 500)
    }
    const started = performance.now()
    const error = await failure(rpc.getBlockCount({ timeoutMs: 1000 }))
    expect(RpcTimeoutError.is(error)).toBe(true)
    expect(error).toMatchObject({ timeoutMs: 1000, method: 'getblockcount' })
    // A deadline per attempt could not end before 1500 ms.
    expect(performance.now() - started).toBeLessThan(1400)
    expect(node.requests.map(reused)).toEqual([true, false])
    // The node never closes the second connection: the client did.
    await expect.poll(() => node.connections).toBe(0)
  })

  it('aborts the extra attempt on the caller signal', async () => {
    const rpc = await pooled()
    node.handler = (request, response) => {
      if (reused(request)) response.socket?.destroy()
    }
    const controller = new AbortController()
    const pending = rpc.getBlockCount({ signal: controller.signal })
    await expect.poll(() => node.requests.length).toBe(2)
    controller.abort('user')
    const error = await failure(pending)
    expect(RpcAbortedError.is(error)).toBe(true)
    expect((error as Error).cause).toBe('user')
    await expect.poll(() => node.connections).toBe(0)
  })
})

describe('HttpTransport', () => {
  const exchange = (signal: AbortSignal = new AbortController().signal): Exchange => ({
    url: new URL(node.url),
    authorization: 'Basic dTpw',
    body: '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}',
    signal,
    maxResponseBytes: 1024,
    freshConnection: false,
  })

  it('flags a stale socket without sending again, and leaves no listener behind on any path', async () => {
    const transport = new HttpTransport()
    const warnings: Error[] = []
    const onWarning = (warning: Error): void => void warnings.push(warning)
    process.on('warning', onWarning)
    try {
      const controller = new AbortController()
      const send = (): Promise<unknown> => transport.send(exchange(controller.signal))
      // One listener left per request on a pooled socket would trip Node's leak warning.
      for (let i = 0; i < 20; i += 1) await send()
      expect(new Set(node.requests.map(request => request.remotePort)).size).toBe(1)
      dropWhen(() => true)
      await expect(send()).rejects.toMatchObject({ kind: 'network', code: 'ECONNRESET', staleSocket: true })
      await expect(send()).rejects.toMatchObject({ kind: 'network', code: 'ECONNRESET', staleSocket: false })
      expect(node.requests.slice(20).map(reused)).toEqual([true, false])
      await sleep(10)
      expect(warnings).toEqual([])
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    } finally {
      process.off('warning', onWarning)
      transport.close()
    }
  })

  it.each([
    [100, true],
    [STALE_SOCKET_WINDOW_MS + 200, false],
  ])(
    'times the window from when the request went out, not from when its body finished: reset after %i ms, stale %s',
    async (resetAfterMs, stale) => {
      let requests = 0
      const server = createServer((request, response) => {
        requests += 1
        if (requests === 1) return void request.resume().on('end', () => response.end('{}'))
        // Read none of this body, so it cannot finish going out, then reset.
        request.socket.pause()
        setTimeout(() => request.socket.destroy(), resetAfterMs)
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const http = createRequire(import.meta.url)('node:http') as { request: (...args: unknown[]) => ClientRequest }
      const request = http.request
      const outgoing: ClientRequest[] = []
      http.request = (...args: unknown[]): ClientRequest => {
        outgoing.push(request(...args))
        return outgoing.at(-1)!
      }
      syncBuiltinESMExports()
      const transport = new HttpTransport()
      try {
        const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
        const send = (body: string): Promise<unknown> => transport.send({ ...exchange(), url, body })
        await send('{}')
        // Far more than the loopback socket buffers hold.
        const error = await send('x'.repeat(32 * 1024 * 1024)).catch((e: unknown) => e)
        expect(outgoing[1]!.writableFinished).toBe(false)
        expect(error).toMatchObject({ kind: 'network', code: expect.stringMatching(/^(ECONNRESET|EPIPE)$/) })
        expect(error).toMatchObject({ staleSocket: stale })
        expect(requests).toBe(2)
      } finally {
        http.request = request
        syncBuiltinESMExports()
        transport.close()
        server.closeAllConnections()
        server.close()
      }
    }
  )

  it('closes a pooled socket left idle for the idle timeout, and not before', async () => {
    node.closeIdleAfter(60_000) // the node would keep it open
    const transport = new HttpTransport(150)
    try {
      await transport.send(exchange())
      const freed = performance.now()
      expect(node.connections).toBe(1)
      await expect.poll(() => node.connections).toBe(0)
      expect(performance.now() - freed).toBeGreaterThanOrEqual(140)
      await transport.send(exchange())
      expect(node.requests.map(reused)).toEqual([false, false])
    } finally {
      transport.close()
    }
  })

  it('does not cut a request that runs longer than the idle timeout', async () => {
    node.closeIdleAfter(60_000)
    const transport = new HttpTransport(300)
    try {
      const answer = node.handler
      node.handler = (request, response) => void setTimeout(() => answer(request, response), 700)
      // Slow on a new socket, then on the pooled one, then a quick one on the same socket.
      expect((await transport.send(exchange())).status).toBe(200)
      expect((await transport.send(exchange())).status).toBe(200)
      node.handler = answer
      expect((await transport.send(exchange())).status).toBe(200)
      expect(node.requests.map(reused)).toEqual([false, true, true])
      expect(node.closedEarly).toBe(0)
    } finally {
      transport.close()
    }
  })
})
