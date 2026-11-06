import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  QbitRpcClient,
  requests,
  RpcAbortedError,
  RpcError,
  RpcResponseError,
  RpcResponseTooLargeError,
  RpcTimeoutError,
  RpcTransportError,
  RpcUnknownOutcomeError,
  type Capability,
} from '../src'
import { chainResults, FakeNode, HASH_A, TX_HEX, TX_TXID as TXID } from './helpers/fake-node'

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
})
afterEach(async () => {
  await node.close()
})

async function confirmed(
  options: { capabilities?: Capability[]; readRetries?: number; timeoutMs?: number; directNode?: boolean } = {}
): Promise<QbitRpcClient> {
  const previous = node.handler
  node.results(chainResults('regtest'))
  const rpc = new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: options.capabilities ?? ['wallet-read', 'wallet-write', 'broadcast'],
    retryDelayMs: 0,
    ...(options.readRetries === undefined ? {} : { readRetries: options.readRetries }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.directNode === undefined ? {} : { directNode: options.directNode }),
  })
  await rpc.confirmChain()
  node.requests.length = 0
  node.handler = previous
  return rpc
}

const reply = (body: string, id: unknown): string => `{"jsonrpc":"2.0","result":${body},"id":${JSON.stringify(id)}}`
const idOf = (body: string): unknown => (JSON.parse(body) as { id: unknown }).id

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e
  )
}

describe('unknown outcomes after a side effect may have happened', () => {
  it('reports a dropped connection after sendrawtransaction as unknown, with the txid, and never retries', async () => {
    const rpc = await confirmed({ readRetries: 5 })
    let broadcasts = 0
    node.handler = (_request, response) => {
      broadcasts += 1 // the node accepted and relayed it, then the reply was lost
      response.socket?.destroy()
    }
    const error = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect((error as RpcUnknownOutcomeError).txid).toBe(TXID)
    expect((error as RpcUnknownOutcomeError).method).toBe('sendrawtransaction')
    expect(RpcTransportError.is((error as Error).cause)).toBe(true)
    expect(broadcasts).toBe(1)
    expect(node.requests).toHaveLength(1)
  })

  it('reports a timeout after the node acted as unknown, and the caller can reconcile by txid', async () => {
    const rpc = await confirmed({ timeoutMs: 150 })
    const mempool = new Set<string>()
    node.handler = (request, response) => {
      const call = JSON.parse(request.body) as { id: number; method: string; params: unknown[] }
      if (call.method === 'sendrawtransaction') {
        mempool.add(TXID) // side effect happens; the reply never comes
        return
      }
      if (call.method === 'getrawtransaction') {
        const found = mempool.has(call.params[0] as string)
        response.end(
          found
            ? reply(JSON.stringify(TX_HEX), call.id)
            : `{"jsonrpc":"2.0","error":{"code":-5,"message":"No such mempool transaction"},"id":${call.id}}`
        )
      }
    }
    const started = performance.now()
    const error = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(performance.now() - started).toBeLessThan(1000)
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(RpcTimeoutError.is((error as Error).cause)).toBe(true)
    const txid = (error as RpcUnknownOutcomeError).txid!
    // Reconcile: the transaction is in the mempool, so it must not be rebuilt.
    expect(await rpc.getRawTransaction(txid)).toBe(TX_HEX)
    expect(node.calls().filter(call => call.method === 'sendrawtransaction')).toHaveLength(1)
    await expect.poll(() => node.closedEarly).toBe(1)
  })

  it.each([
    ['walletprocesspsbt', (rpc: QbitRpcClient) => rpc.walletProcessPsbt('cHNidP8=', { pqcCheck: false })],
    [
      'walletcreatefundedpsbt',
      (rpc: QbitRpcClient) => rpc.walletCreateFundedPsbt({ outputs: [{ address: 'tq1x', amountBits: 1n }] }),
    ],
    ['walletpassphrase', (rpc: QbitRpcClient) => rpc.walletPassphrase('pw', 10)],
    ['walletlock', (rpc: QbitRpcClient) => rpc.walletLock()],
    ['call(lockunspent)', (rpc: QbitRpcClient) => rpc.call('lockunspent', [false])],
    ['lockunspent', (rpc: QbitRpcClient) => rpc.lockUnspent([{ txid: HASH_A, vout: 0 }])],
    ['getrawchangeaddress', (rpc: QbitRpcClient) => rpc.getRawChangeAddress({ addressType: 'p2mr' })],
    ['psbtbumpfee', (rpc: QbitRpcClient) => rpc.psbtBumpFee(HASH_A, { feeRateBitsPerKvB: 4000n })],
  ])('treats a dropped reply to %s as unknown', async (_name, run) => {
    const rpc = await confirmed({ readRetries: 3 })
    node.handler = (_request, response) => response.socket?.destroy()
    const error = await failure(run(rpc))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(node.requests).toHaveLength(1)
  })

  type Respond = (response: ServerResponse, id: unknown) => void
  const cases: [string, Respond][] = [
    [
      'an HTTP 502 from a proxy',
      response => {
        response.statusCode = 502
        response.end('Bad Gateway')
      },
    ],
    [
      'a proxy 502 with its own JSON error',
      response => {
        response.statusCode = 502
        response.end('{"error":{"code":502,"message":"Bad Gateway"}}')
      },
    ],
    [
      'a 502 whose body claims both a result and a node error',
      (response, id) => {
        response.statusCode = 502
        response.end(`{"result":"${TXID}","error":{"code":-1,"message":"x"},"id":${JSON.stringify(id)}}`)
      },
    ],
    ['a malformed body', response => response.end('{"jsonrpc":"2.0","result":')],
    ['a reply with the wrong id', response => response.end(reply(`"${TXID}"`, 999))],
    ['a result that is not a txid', (response, id) => response.end(reply('"ok"', id))],
    ['a txid that is not the submitted one', (response, id) => response.end(reply(`"${HASH_A}"`, id))],
    ['an oversized reply', (response, id) => response.end(reply(`"${'0'.repeat(4096)}"`, id))],
  ]
  it.each(cases)('treats %s after sendrawtransaction as unknown', async (_name, respond) => {
    const rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      capabilities: ['broadcast'],
      maxResponseBytes: 2048,
    })
    node.results(chainResults('regtest'))
    await rpc.confirmChain()
    node.handler = (request, response) => respond(response, idOf(request.body))
    const error = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect((error as RpcUnknownOutcomeError).txid).toBe(TXID)
  })

  it('keeps definite answers definite: a node error, an auth rejection, a refused connection', async () => {
    const rpc = await confirmed()
    node.handler = (request, response) =>
      response.end(
        `{"jsonrpc":"2.0","error":{"code":-26,"message":"min relay fee not met"},"id":${idOf(request.body)}}`
      )
    const rejected = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(RpcError.is(rejected)).toBe(true)
    expect(rejected).toMatchObject({ rpcCode: -26, message: 'min relay fee not met', method: 'sendrawtransaction' })

    node.handler = (_request, response) => {
      response.statusCode = 401
      response.end()
    }
    const unauthorized = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(RpcTransportError.is(unauthorized)).toBe(true)
    expect(unauthorized).toMatchObject({ reason: 'http_status', status: 401 })

    // A port with nothing listening: the request never left this process.
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>(resolve => closed.close(() => resolve()))
    const offline = new QbitRpcClient({
      url: `http://127.0.0.1:${port}/`,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      capabilities: ['broadcast'],
    })
    node.results(chainResults('regtest'))
    await expect(offline.confirmChain()).rejects.toMatchObject({ reason: 'network', code: 'ECONNREFUSED' })
  })
})

describe('deadlines', () => {
  it('times out a read that gets no reply and releases the connection', async () => {
    node.handler = () => undefined
    const rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      timeoutMs: 100,
    })
    const started = performance.now()
    const error = await failure(rpc.getBestBlockHash())
    expect(RpcTimeoutError.is(error)).toBe(true)
    expect(error).toMatchObject({ timeoutMs: 100, method: 'getbestblockhash' })
    expect(performance.now() - started).toBeLessThan(600)
    await expect.poll(() => node.closedEarly).toBe(1)
  })

  it('applies one deadline to a whole batch, across retries and backoff', async () => {
    let attempts = 0
    node.handler = (_request, response) => {
      attempts += 1
      setTimeout(() => {
        response.statusCode = 503
        response.end()
      }, 60)
    }
    const rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      readRetries: 10,
      retryDelayMs: 20,
    })
    const started = performance.now()
    const error = await failure(
      rpc.batch([requests.getBlockHash(1), requests.getBlockHash(2), requests.getBestBlockHash()], { timeoutMs: 250 })
    )
    const elapsed = performance.now() - started
    // Ten retries at 60 ms each plus backoff would take well over a second.
    expect(elapsed).toBeLessThan(500)
    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(attempts).toBeLessThan(10)
    expect(RpcTimeoutError.is(error) || RpcTransportError.is(error)).toBe(true)
  })

  it('times out a batch whose reply never arrives', async () => {
    node.handler = () => undefined
    const rpc = new QbitRpcClient({ url: node.url, auth: { username: 'u', password: 'p' }, expectedChain: 'regtest' })
    const error = await failure(rpc.batch([requests.getBlockHash(1), requests.getBlockHash(2)], { timeoutMs: 80 }))
    expect(RpcTimeoutError.is(error)).toBe(true)
    expect((error as RpcTimeoutError).method).toBe('batch(2)')
  })

  it('aborts on the caller signal, before or during a call', async () => {
    node.handler = () => undefined
    const rpc = new QbitRpcClient({ url: node.url, auth: { username: 'u', password: 'p' }, expectedChain: 'regtest' })
    const before = new AbortController()
    before.abort(new Error('stop'))
    const early = await failure(rpc.getBestBlockHash({ signal: before.signal }))
    expect(RpcAbortedError.is(early)).toBe(true)
    expect(node.requests).toHaveLength(0)

    const during = new AbortController()
    const pending = rpc.getBestBlockHash({ signal: during.signal })
    await expect.poll(() => node.requests.length).toBe(1)
    during.abort('user')
    const late = await failure(pending)
    expect(RpcAbortedError.is(late)).toBe(true)
    expect((late as Error).cause).toBe('user')
  })

  it('validates timeoutMs', async () => {
    const rpc = new QbitRpcClient({ url: node.url, auth: { username: 'u', password: 'p' }, expectedChain: 'regtest' })
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(rpc.getBestBlockHash({ timeoutMs })).rejects.toThrow(RangeError)
    }
    expect(
      () =>
        new QbitRpcClient({
          url: node.url,
          auth: { username: 'u', password: 'p' },
          expectedChain: 'regtest',
          timeoutMs: Infinity,
        })
    ).toThrow(RangeError)
    expect(node.requests).toHaveLength(0)
  })
})

describe('read retries', () => {
  it('does not retry unless the caller opts in', async () => {
    node.handler = (_request, response) => {
      response.statusCode = 503
      response.end()
    }
    const rpc = new QbitRpcClient({ url: node.url, auth: { username: 'u', password: 'p' }, expectedChain: 'regtest' })
    await expect(rpc.getBestBlockHash()).rejects.toMatchObject({ reason: 'http_status', status: 503 })
    expect(node.requests).toHaveLength(1)
  })

  it('retries reads after transient failures and warm-up when enabled', async () => {
    const script = ['drop', '503', 'warmup', 'ok']
    node.handler = (request, response) => {
      const step = script.shift()
      if (step === 'drop') return void response.socket?.destroy()
      if (step === '503') {
        response.statusCode = 503
        return void response.end()
      }
      if (step === 'warmup') {
        return void response.end(
          `{"jsonrpc":"2.0","error":{"code":-28,"message":"Loading block index..."},"id":${idOf(request.body)}}`
        )
      }
      response.end(reply(JSON.stringify(HASH_A), idOf(request.body)))
    }
    const rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      readRetries: 3,
      retryDelayMs: 1,
    })
    expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    expect(node.requests).toHaveLength(4)
  })

  it('does not retry definite failures', async () => {
    node.handler = (request, response) =>
      response.end(
        `{"jsonrpc":"2.0","error":{"code":-8,"message":"Block height out of range"},"id":${idOf(request.body)}}`
      )
    const rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      readRetries: 3,
    })
    await expect(rpc.getBlockHash(99)).rejects.toMatchObject({ rpcCode: -8 })
    expect(node.requests).toHaveLength(1)
  })
})

describe('malformed and oversized responses', () => {
  const rpcWith = (maxResponseBytes?: number): QbitRpcClient =>
    new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    })

  it('stops reading a reply past maxResponseBytes, declared or streamed', async () => {
    node.handler = (_request, response) => {
      response.setHeader('content-length', 5000)
      response.end('x'.repeat(5000))
    }
    const declared = await failure(rpcWith(1024).getBestBlockHash())
    expect(RpcResponseTooLargeError.is(declared)).toBe(true)
    expect((declared as RpcResponseTooLargeError).limitBytes).toBe(1024)

    node.handler = (_request, response) => {
      const chunk = 'y'.repeat(512)
      const write = (left: number): void => {
        if (left === 0) return void response.end()
        response.write(chunk, () => setImmediate(() => write(left - 1)))
      }
      write(100)
    }
    const streamed = await failure(rpcWith(1024).getBestBlockHash())
    expect(RpcResponseTooLargeError.is(streamed)).toBe(true)
  })

  it.each([
    ['not JSON', 'Internal error'],
    ['an array for a single call', '[]'],
    ['a missing jsonrpc marker', `{"result":"${HASH_A}","id":1}`],
    ['the wrong id', `{"jsonrpc":"2.0","result":"${HASH_A}","id":2}`],
    ['a string id', `{"jsonrpc":"2.0","result":"${HASH_A}","id":"1"}`],
    ['both result and error', `{"jsonrpc":"2.0","result":null,"error":{"code":-1,"message":"x"},"id":1}`],
    ['neither result nor error', '{"jsonrpc":"2.0","id":1}'],
    ['an unexpected key', `{"jsonrpc":"2.0","result":"${HASH_A}","id":1,"extra":true}`],
    ['an error without a code', '{"jsonrpc":"2.0","error":{"message":"x"},"id":1}'],
    ['a fractional error code', '{"jsonrpc":"2.0","error":{"code":-1.5,"message":"x"},"id":1}'],
  ])('rejects a reply with %s as a protocol error', async (_label, body) => {
    node.handler = (_request, response) => response.end(body)
    const error = await failure(rpcWith().getBestBlockHash())
    expect(RpcResponseError.is(error)).toBe(true)
    expect((error as RpcResponseError).reason).toBe('protocol')
  })

  it('rejects a body that is not valid UTF-8', async () => {
    node.handler = (_request, response) => response.end(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))
    const error = await failure(rpcWith().getBestBlockHash())
    expect(error).toMatchObject({ reason: 'protocol' })
  })

  it('passes a JSON-RPC error carried by an HTTP error status through as RpcError', async () => {
    node.handler = (request, response) => {
      response.statusCode = 500
      response.end(`{"result":null,"error":{"code":-1,"message":"legacy"},"id":${idOf(request.body)}}`)
    }
    await expect(rpcWith().getBestBlockHash()).rejects.toSatisfy(error => RpcError.is(error) && error.rpcCode === -1)
  })
})

describe('a JSON-RPC error under an HTTP error status', () => {
  /** A JSON-RPC-aware gateway: it read the request's id, and may have forwarded the request first. */
  const answering = (status: number, id: (body: string) => unknown = idOf): void => {
    node.handler = (request, response) => {
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(
        `{"jsonrpc":"2.0","id":${JSON.stringify(id(request.body))},"error":{"code":-32603,"message":"upstream timeout"}}`
      )
    }
  }

  // JSONErrorReply in qbit Core v1.0.0's src/httprpc.cpp, the only place qbitd writes one.
  describe.each([[400], [404], [500]])('at %i, a status qbitd uses for one', status => {
    it.each([[false], [true]])('is the node’s answer for a side-effecting call, directNode %s', async directNode => {
      const rpc = await confirmed({ directNode })
      answering(status)
      const error = await failure(rpc.sendRawTransaction(TX_HEX))
      expect(RpcError.is(error)).toBe(true)
      expect(error).toMatchObject({ rpcCode: -32603, message: 'upstream timeout', method: 'sendrawtransaction' })
    })

    it('is the node’s answer for a read, with no retry', async () => {
      const rpc = await confirmed({ readRetries: 2 })
      answering(status)
      expect(RpcError.is(await failure(rpc.getBestBlockHash()))).toBe(true)
      expect(node.requests).toHaveLength(1)
    })
  })

  describe.each([[502], [503], [504], [501], [505], [599], [302], [401], [403], [405], [408], [429]])(
    'at %i, a status qbitd does not use for one',
    status => {
      it.each([[false], [true]])('is an unknown outcome for a side-effecting call, directNode %s', async directNode => {
        const rpc = await confirmed({ directNode })
        answering(status)
        const error = await failure(rpc.sendRawTransaction(TX_HEX))
        expect(RpcUnknownOutcomeError.is(error)).toBe(true)
        expect(error).toMatchObject({ method: 'sendrawtransaction', txid: TXID })
        expect((error as Error).cause).toMatchObject({ reason: 'http_status', status })
        expect(node.requests).toHaveLength(1)
      })

      it('is the HTTP error for a read, retried only as that status is', async () => {
        const rpc = await confirmed({ readRetries: 1 })
        answering(status)
        const error = await failure(rpc.getBestBlockHash())
        expect(RpcTransportError.is(error)).toBe(true)
        expect(error).toMatchObject({ reason: 'http_status', status, method: 'getbestblockhash' })
        expect(node.requests).toHaveLength(status >= 500 ? 2 : 1)
      })
    }
  )

  it('leaves a 4xx whose body names another request as a rejection, not an unknown outcome', async () => {
    const rpc = await confirmed()
    answering(429, () => 999)
    const error = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(RpcTransportError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'http_status', status: 429 })
  })
})

describe('side-effecting calls', () => {
  it('get no retry budget, even for failures that provably never reached the node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-retry-'))
    try {
      const cookieFile = join(dir, '.cookie')
      await writeFile(cookieFile, '__cookie__:x')
      const rpc = new QbitRpcClient({
        url: node.url,
        auth: { cookieFile },
        expectedChain: 'regtest',
        capabilities: ['broadcast'],
        readRetries: 3,
        retryDelayMs: 1,
      })
      node.results(chainResults('regtest'))
      await rpc.confirmChain()
      node.requests.length = 0
      // A cookie 401 is retryable for reads (the cookie may have rotated)...
      node.handler = (_request, response) => {
        response.statusCode = 401
        response.end()
      }
      await expect(rpc.call('getblockcount')).rejects.toMatchObject({ status: 401 })
      expect(node.requests).toHaveLength(4)
      // ...but a broadcast gets exactly one attempt.
      node.requests.length = 0
      // The 401 made the chain confirmation stale, so a chain check runs first and fails: the broadcast is not sent.
      await expect(rpc.sendRawTransaction(TX_HEX, {}, { timeoutMs: 5000 })).rejects.toMatchObject({
        reason: 'check_failed',
        cause: { status: 401 },
      })
      expect(node.calls().filter(call => call.method === 'sendrawtransaction')).toHaveLength(0)
      node.requests.length = 0
      node.results(chainResults('regtest'))
      await rpc.confirmChain()
      node.requests.length = 0
      node.handler = (_request, response) => {
        response.statusCode = 401
        response.end()
      }
      await expect(rpc.sendRawTransaction(TX_HEX)).rejects.toMatchObject({ status: 401 })
      expect(node.calls().map(call => call.method)).toEqual(['sendrawtransaction'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('are not retried after a refused connection', async () => {
    const rpc = await confirmed({ readRetries: 3 })
    const url = node.url
    await node.close()
    const read = new QbitRpcClient({
      url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      readRetries: 3,
      retryDelayMs: 150,
    })
    const readStarted = performance.now()
    await expect(read.getBestBlockHash()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(performance.now() - readStarted).toBeGreaterThanOrEqual(150)
    const sendStarted = performance.now()
    const error = await failure(rpc.call('lockunspent', [true]))
    expect(error).toMatchObject({ reason: 'network', code: 'ECONNREFUSED', method: 'lockunspent' })
    expect(RpcUnknownOutcomeError.is(error)).toBe(false)
    expect(performance.now() - sendStarted).toBeLessThan(140)
    node = await FakeNode.start() // for afterEach
  })

  it('use a new connection each time, while reads share a keep-alive socket', async () => {
    const rpc = await confirmed()
    node.rpc(call => ({ result: call.method === 'sendrawtransaction' ? JSON.stringify(TXID) : JSON.stringify(HASH_A) }))
    await rpc.getBestBlockHash()
    await rpc.getBestBlockHash()
    await rpc.sendRawTransaction(TX_HEX)
    await rpc.sendRawTransaction(TX_HEX)
    const [read1, read2, send1, send2] = node.requests
    expect(read1!.remotePort).toBe(read2!.remotePort)
    expect(new Set([read1!.remotePort, send1!.remotePort, send2!.remotePort]).size).toBe(3)
    expect(send1!.headers.connection).toBe('close')
    expect(read1!.headers.connection).toBe('keep-alive')
  })

  it('carry the computed txid through call("sendrawtransaction") as well', async () => {
    expect(requests.raw('sendrawtransaction', [TX_HEX]).txid).toBe(TXID)
    expect(requests.raw('sendrawtransaction', ['zz']).txid).toBeUndefined()
    expect(requests.raw('getblockcount').txid).toBeUndefined()
    const rpc = await confirmed()
    node.handler = (_request, response) => response.socket?.destroy()
    const error = await failure(rpc.call('sendrawtransaction', [TX_HEX]))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect((error as RpcUnknownOutcomeError).txid).toBe(TXID)
  })
})
