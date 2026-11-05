import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type * as httpsModule from 'node:https'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import {
  connect as netConnect,
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket,
} from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import type * as tlsModule from 'node:tls'
import { fileURLToPath } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

import { build } from 'tsup'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  QbitRpcClient,
  RpcTimeoutError,
  RpcTransportError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
  type RpcConnect,
} from '../src'
import { parseEndpoint, parseTls } from '../src/endpoint'
import { HttpTransport, type ExchangeResult } from '../src/transport'
import { issue, testPki } from './helpers/certificates'
import { chainResults, CHECK, FakeNode, HASH_A, TX_HEX, TX_TXID, type RecordedRequest } from './helpers/fake-node'
import { withoutCrash } from './helpers/prototype'

const pki = testPki()
/** The node's next certificate: the same CA and names, a new key. */
const rotated = issue({ name: 'node.test', issuer: pki.ca, altNames: ['node.test'] })
const untrusted = testPki('untrusted').server

/**
 * An HTTP CONNECT proxy on loopback that knows `node.test` as the node's
 * address. It counts the tunnels it opened and keeps them, to close them.
 */
class Proxy {
  readonly tunnels: string[] = []
  readonly #server: Server
  readonly #sockets = new Set<Socket>()

  private constructor(server: Server, nodePort: () => number) {
    this.#server = server
    server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
      this.tunnels.push(req.url ?? '')
      const [host, port] = (req.url ?? '').split(':')
      if (host !== 'node.test' || Number(port) !== nodePort()) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      const upstream = netConnect(nodePort(), '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      for (const [from, to] of [
        [client, upstream],
        [upstream, client],
      ] as const) {
        this.#sockets.add(from)
        from.on('error', () => to.destroy())
        from.on('close', () => to.destroy())
      }
    })
  }

  static async start(nodePort: () => number): Promise<Proxy> {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return new Proxy(server, nodePort)
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }
}

/** The README's connect function: a tunnel through an HTTP CONNECT proxy. */
function viaProxy(proxyHost: string, proxyPort: number): RpcConnect {
  return ({ host, port, signal }) =>
    new Promise((resolve, reject) => {
      const tunnel = request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${host}:${port}`,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
      tunnel.once('connect', (response, socket) => {
        if (response.statusCode === 200) return resolve(socket)
        socket.destroy()
        reject(new Error(`proxy answered HTTP ${response.statusCode}`))
      })
      tunnel.once('error', reject)
      tunnel.end()
    })
}

/** A stream that takes what is written and never answers. */
const silentStream = (): Duplex =>
  new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback()
    },
  })

let node: FakeNode
let proxy: Proxy
beforeEach(async () => {
  node = await FakeNode.start({ tls: { key: pki.server.key, cert: pki.server.cert } })
  node.results({
    ...chainResults('regtest'),
    getbestblockhash: JSON.stringify(HASH_A),
    sendrawtransaction: JSON.stringify(TX_TXID),
  })
  proxy = await Proxy.start(() => node.port)
})
afterEach(async () => {
  await proxy.close()
  await node.close()
})

function client(options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  return new QbitRpcClient({
    url: `https://node.test:${node.port}/`,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['broadcast'],
    tls: { ca: pki.ca.cert, pinSha256: pki.server.pin },
    connect: viaProxy('127.0.0.1', proxy.port),
    retryDelayMs: 0,
    ...options,
  })
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e
  )
}

const methods = (): string[] => node.calls().map(call => call.method)
/** The tunnel a request came through: the proxy's side of it, one port per tunnel. */
const tunnelOf = (request: RecordedRequest | undefined): number | undefined => request?.remotePort

describe('connect', () => {
  it('carries reads on pooled tunnels and opens a new one for each side-effecting call', async () => {
    const rpc = client()
    await rpc.confirmChain()
    for (let i = 0; i < 3; i += 1) expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    expect(proxy.tunnels).toEqual([`node.test:${node.port}`])
    expect(await rpc.sendRawTransaction(TX_HEX)).toBe(TX_TXID)
    expect(await rpc.call('sendrawtransaction', [TX_HEX])).toBe(TX_TXID)
    expect(proxy.tunnels).toHaveLength(3)
    const [check, ...rest] = node.requests
    const reads = rest.slice(0, 3)
    const writes = rest.slice(3)
    expect(new Set([check, ...reads].map(tunnelOf)).size).toBe(1)
    expect(new Set([check, ...writes].map(tunnelOf)).size).toBe(3)
    expect(writes.map(request => request.headers.connection)).toEqual(['close', 'close'])
    // TLS ran end to end over each tunnel: SNI names the node, and no session was resumed.
    expect(node.requests.map(request => request.tls?.servername)).toEqual(Array(6).fill('node.test'))
    expect(node.requests.every(request => request.tls?.resumed === false)).toBe(true)
    expect(node.handshakes).toBe(3)
  })

  it('checks the certificate and the pins over the tunnel, for side-effecting calls and reads', async () => {
    const rpc = client()
    await rpc.confirmChain()
    // A certificate from a CA the client does not trust.
    node.setSecureContext({ key: untrusted.key, cert: untrusted.cert })
    const write = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(RpcUnknownOutcomeError.is(write)).toBe(false)
    expect(write).toMatchObject({ name: 'RpcTransportError', reason: 'tls', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
    // The client's CA signed this one, for a key no pin names.
    node.setSecureContext({ key: rotated.key, cert: rotated.cert })
    rpc.close()
    expect(await failure(rpc.getBestBlockHash())).toMatchObject({ reason: 'tls', code: 'EPINMISMATCH' })
    expect(methods()).toEqual([...CHECK])
  })

  it('keeps the request limit: no more requests out, and no more tunnels, than maxConcurrentRequests', async () => {
    let open = 0
    let most = 0
    const answer = node.handler
    node.handler = async (recorded, response) => {
      open += 1
      most = Math.max(most, open)
      await new Promise(resolve => setTimeout(resolve, 30))
      open -= 1
      return answer(recorded, response)
    }
    const rpc = client({ maxConcurrentRequests: 2 })
    expect(await Promise.all(Array.from({ length: 8 }, () => rpc.getBestBlockHash()))).toEqual(Array(8).fill(HASH_A))
    expect(most).toBe(2)
    // The pool's spare covers a connection freed just after its slot was.
    expect(proxy.tunnels.length).toBeGreaterThanOrEqual(2)
    expect(proxy.tunnels.length).toBeLessThanOrEqual(3)
  })

  it('gives a read reset on a reused tunnel its extra attempt, on a new one', async () => {
    const rpc = client()
    await rpc.confirmChain()
    const answer = node.handler
    let armed = true
    node.handler = (recorded, response) => {
      if (armed && recorded.idleMs !== undefined) {
        armed = false
        response.socket?.destroy()
        return
      }
      return answer(recorded, response)
    }
    expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    expect(proxy.tunnels).toHaveLength(2)
    expect(rpc.chainStatus).toBe('stale')
  })

  it('fails as a connection error, with nothing sent, when connect fails, and retries reads', async () => {
    const failing: [RpcConnect, string][] = [
      [() => Promise.reject(Object.assign(new Error('no route'), { code: 'EHOSTUNREACH' })), 'EHOSTUNREACH'],
      [
        () => {
          throw Object.assign(new Error('no proxy'), { code: 'ECONNREFUSED' })
        },
        'ECONNREFUSED',
      ],
    ]
    for (const [connect, code] of failing) {
      let calls = 0
      const counted: RpcConnect = target => {
        calls += 1
        return connect(target)
      }
      const read = await failure(client({ connect: counted, readRetries: 1 }).getBestBlockHash())
      expect(read).toMatchObject({ name: 'RpcTransportError', reason: 'network', code })
      expect(calls).toBe(2)
    }
    // A proxy that refuses the tunnel: its error has no code, and none of its text is kept.
    const error = await failure(client({ url: 'https://node.test:1/' }).getBestBlockHash())
    expect(error).toMatchObject({ name: 'RpcTransportError', reason: 'network' })
    expect((error as RpcTransportError).code).toBeUndefined()
    expect((error as Error).message).toBe('RPC getbestblockhash failed: connection error')
    expect(proxy.tunnels).toEqual(['node.test:1'])
    expect(node.requests).toHaveLength(0)
  })

  it('refuses a stream returned twice, or none, with a TypeError and nothing sent', async () => {
    let shared: Socket | undefined
    const once: RpcConnect = async target => (shared ??= (await viaProxy('127.0.0.1', proxy.port)(target)) as Socket)
    const rpc = client({ connect: once })
    await rpc.confirmChain()
    const error = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/connect must return a new, open stream.Duplex/)
    expect(RpcUnknownOutcomeError.is(error)).toBe(false)
    for (const connect of [() => ({}) as Duplex, () => Duplex.from('x').destroy() as Duplex]) {
      expect(await failure(client({ connect }).getBestBlockHash())).toBeInstanceOf(TypeError)
    }
    expect(methods()).toEqual([...CHECK])
  })

  it('fails a call at its deadline while connect hangs, and tells connect through its signal', async () => {
    const signals: AbortSignal[] = []
    const hanging: RpcConnect = ({ signal }) => {
      signals.push(signal)
      return new Promise<Duplex>(() => {})
    }
    const rpc = client({ connect: hanging, timeoutMs: 100, maxConcurrentRequests: 8 })
    expect(await failure(rpc.getBestBlockHash())).toBeInstanceOf(RpcTimeoutError)
    // A read's pooled connection: the client's timeoutMs from when it started, just after the read's.
    await expect.poll(() => signals[0]!.aborted).toBe(true)
    const controller = new AbortController()
    const aborted = rpc.getBestBlockHash({ signal: controller.signal })
    await expect.poll(() => signals.length).toBe(2)
    expect(signals[1]!.aborted).toBe(false)
    controller.abort()
    expect(await failure(aborted)).toMatchObject({ name: 'RpcAbortedError' })
    // It outlives the read that gave up, until the client's timeoutMs.
    expect(signals[1]!.aborted).toBe(false)
    await expect.poll(() => signals[1]!.aborted).toBe(true)
    // close() gives up a pooled connection still being opened, before the call's deadline.
    const closing = rpc.getBestBlockHash({ timeoutMs: 5000 })
    await expect.poll(() => signals.length).toBe(3)
    expect(signals[2]!.aborted).toBe(false)
    rpc.close()
    expect(signals[2]!.aborted).toBe(true)
    expect(await failure(closing)).toMatchObject({ name: 'RpcTransportError', reason: 'network' })
    // A side-effecting call's connection: its deadline gives it up.
    let opened = 0
    const working = viaProxy('127.0.0.1', proxy.port)
    const fresh = client({ connect: target => (opened++ === 0 ? working(target) : hanging(target)), timeoutMs: 100 })
    await fresh.confirmChain()
    expect(await failure(fresh.sendRawTransaction(TX_HEX))).toBeInstanceOf(RpcTimeoutError)
    expect(signals).toHaveLength(4)
    expect(signals[3]!.aborted).toBe(true)
  })

  it('gives its turn back at the client’s timeoutMs, when connect honours its signal', async () => {
    let calls = 0
    let hang = true
    const working = viaProxy('127.0.0.1', proxy.port)
    // Never resolves while hanging, and has no timeout of its own.
    const connect: RpcConnect = target => {
      calls += 1
      if (!hang) return working(target)
      return new Promise<Duplex>((_resolve, reject) => {
        target.signal.addEventListener('abort', () => reject(new Error('gave up')), { once: true })
      })
    }
    // A pool of two: without the deadline, the third and later calls would wait for a turn for good.
    const rpc = client({ connect, maxConcurrentRequests: 1, timeoutMs: 50 })
    for (let i = 0; i < 5; i += 1) {
      const error = await failure(rpc.getBestBlockHash())
      expect(error).toBeInstanceOf(RpcTimeoutError)
      expect(RpcUnknownOutcomeError.is(error)).toBe(false)
    }
    expect(calls).toBe(5)
    hang = false
    expect(await rpc.getBestBlockHash({ timeoutMs: 5000 })).toBe(HASH_A)
    expect(calls).toBe(6)
    expect(methods()).toEqual(['getbestblockhash'])
  })

  it('gives its turn back at the client’s timeoutMs, when the TLS handshake hangs', async () => {
    const silent: Duplex[] = []
    let hang = true
    const working = viaProxy('127.0.0.1', proxy.port)
    const connect: RpcConnect = target => {
      if (!hang) return working(target)
      const stream = silentStream()
      silent.push(stream)
      return stream
    }
    const rpc = client({ connect, maxConcurrentRequests: 1, timeoutMs: 50 })
    for (let i = 0; i < 4; i += 1) expect(await failure(rpc.getBestBlockHash())).toBeInstanceOf(RpcTimeoutError)
    expect(silent).toHaveLength(4)
    await expect.poll(() => silent.every(stream => stream.destroyed)).toBe(true)
    hang = false
    expect(await rpc.getBestBlockHash({ timeoutMs: 5000 })).toBe(HASH_A)
  })

  it('keeps opening a read’s connection after the read gives up, and the next read takes it', async () => {
    const signals: AbortSignal[] = []
    const opening: (() => void)[] = []
    const working = viaProxy('127.0.0.1', proxy.port)
    const connect: RpcConnect = target => {
      signals.push(target.signal)
      return new Promise<Duplex>(resolve => opening.push(() => resolve(working(target))))
    }
    const rpc = client({ connect, timeoutMs: 5000 })
    const error = await failure(rpc.getBestBlockHash({ timeoutMs: 50 }))
    expect(error).toBeInstanceOf(RpcTimeoutError)
    expect(RpcUnknownOutcomeError.is(error)).toBe(false)
    expect(signals[0]!.aborted).toBe(false)
    // The proxy answers late: the connection is kept, with nothing sent on it.
    opening[0]!()
    await expect.poll(() => node.handshakes).toBe(1)
    expect(node.requests).toHaveLength(0)
    expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    expect(signals).toHaveLength(1)
    expect(proxy.tunnels).toHaveLength(1)
    rpc.close()
  })

  it('serves reads once a tunnel slower than their deadline is open', async () => {
    let calls = 0
    const working = viaProxy('127.0.0.1', proxy.port)
    // A proxy that takes 150 ms to open each tunnel; each read gives up after 100 ms.
    const slow: RpcConnect = target => {
      calls += 1
      return new Promise<Duplex>(resolve => setTimeout(() => resolve(working(target)), 150))
    }
    const rpc = client({ connect: slow })
    const outcomes: string[] = []
    for (let i = 0; i < 6; i += 1) {
      outcomes.push(
        await rpc.getBestBlockHash({ timeoutMs: 100 }).then(
          () => 'ok',
          (e: unknown) => (e as Error).name
        )
      )
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(outcomes).toEqual(['RpcTimeoutError', 'ok', 'ok', 'ok', 'ok', 'ok'])
    expect(calls).toBe(1)
    rpc.close()
  })

  it('gives the turn of a connect that honours its signal back at the client’s timeoutMs, not at its read’s deadline', async () => {
    const signals: AbortSignal[] = []
    const connect: RpcConnect = target => {
      signals.push(target.signal)
      return new Promise<Duplex>((_resolve, reject) => {
        target.signal.addEventListener('abort', () => reject(new Error('gave up')), { once: true })
      })
    }
    const rpc = client({ connect, timeoutMs: 300 })
    const started = performance.now()
    expect(await failure(rpc.getBestBlockHash({ timeoutMs: 30 }))).toBeInstanceOf(RpcTimeoutError)
    expect(signals[0]!.aborted).toBe(false)
    await expect.poll(() => signals[0]!.aborted, { timeout: 2000 }).toBe(true)
    expect(performance.now() - started).toBeGreaterThanOrEqual(250)
    rpc.close()
  })

  it('opens the tunnel of a request queued behind one that was given up, unaffected by its signal', async () => {
    // One socket: the second request waits in Node's agent while the first
    // holds it, and gets a new connection once that one closes.
    const url = `https://node.test:${node.port}/`
    const endpoint = parseEndpoint(url, undefined)
    const working = viaProxy('127.0.0.1', proxy.port)
    const signals: AbortSignal[] = []
    const transport = new HttpTransport(1, undefined, {
      loopbackOnly: false,
      tls: parseTls({ ca: pki.ca.cert, pinSha256: pki.server.pin }, endpoint),
      connect: target => {
        signals.push(target.signal)
        return working(target)
      },
      openTimeoutMs: 5000,
    })
    const answer = node.handler
    node.handler = (recorded, response) => (recorded.body.includes('"hang"') ? undefined : answer(recorded, response))
    const exchange = (method: string, signal: AbortSignal): ReturnType<HttpTransport['send']> =>
      transport.send({
        url: endpoint.url,
        authorization: 'Basic dTpw',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
        signal,
        maxResponseBytes: 1 << 20,
        freshConnection: false,
      })
    try {
      const first = new AbortController()
      const hung = exchange('hang', first.signal)
      await expect.poll(() => node.requests.length).toBe(1)
      const queued = exchange('getbestblockhash', AbortSignal.timeout(5000))
      first.abort()
      await expect(hung).rejects.toMatchObject({ kind: 'aborted', sent: true })
      const reply = await queued
      expect(reply.status).toBe(200)
      expect((JSON.parse(reply.body) as { result: unknown }).result).toBe(HASH_A)
      expect(proxy.tunnels).toHaveLength(2)
      // Node opened the second by itself, for the queued request: only close(), or openTimeoutMs, would give it up.
      expect(signals.map(signal => signal.aborted)).toEqual([false, false])
    } finally {
      transport.close()
    }
  })

  it('bounds a connection Node opens by itself by the later of openTimeoutMs and its request’s deadline', async () => {
    const url = `https://node.test:${node.port}/`
    const endpoint = parseEndpoint(url, undefined)
    const working = viaProxy('127.0.0.1', proxy.port)
    const signals: AbortSignal[] = []
    let calls = 0
    const transport = new HttpTransport(1, undefined, {
      loopbackOnly: false,
      tls: parseTls({ ca: pki.ca.cert, pinSha256: pki.server.pin }, endpoint),
      // The first works; the second, which Node opens by itself, never settles until told.
      connect: target => {
        calls += 1
        signals.push(target.signal)
        if (calls !== 2) return working(target)
        return new Promise<Duplex>((_resolve, reject) => {
          target.signal.addEventListener('abort', () => reject(new Error('gave up')), { once: true })
        })
      },
      openTimeoutMs: 100,
    })
    const answer = node.handler
    node.handler = (recorded, response) => (recorded.body.includes('"hang"') ? undefined : answer(recorded, response))
    const exchange = (method: string, signal: AbortSignal): ReturnType<HttpTransport['send']> =>
      transport.send({
        url: endpoint.url,
        authorization: 'Basic dTpw',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
        signal,
        maxResponseBytes: 1 << 20,
        freshConnection: false,
      })
    try {
      const first = new AbortController()
      const hung = exchange('hang', first.signal)
      await expect.poll(() => node.requests.length).toBe(1)
      const queued = exchange('getbestblockhash', AbortSignal.timeout(500))
      first.abort()
      await expect(hung).rejects.toMatchObject({ kind: 'aborted', sent: true })
      await expect.poll(() => signals.length).toBe(2)
      // openTimeoutMs has passed, and the request still waits for it.
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(signals[1]!.aborted).toBe(false)
      // Given up at the request's own deadline: nothing sent.
      await expect(queued).rejects.toMatchObject({ kind: 'aborted', sent: false })
      expect(signals[1]!.aborted).toBe(true)
      // Its turn is free: the next connection opens.
      const reply = await exchange('getbestblockhash', AbortSignal.timeout(5000))
      expect(reply.status).toBe(200)
      expect(calls).toBe(3)
    } finally {
      transport.close()
    }
  })

  it('opens at most the pool’s size of connections through connect at once, the rest waiting under their deadline', async () => {
    const working = viaProxy('127.0.0.1', proxy.port)
    const stuck: ((error: Error) => void)[] = []
    let calls = 0
    // The first two hang, ignoring their signal, until let go.
    const connect: RpcConnect = target => {
      calls += 1
      return calls <= 2 ? new Promise<Duplex>((_resolve, reject) => stuck.push(reject)) : working(target)
    }
    // A pool of two: maxConcurrentRequests and one spare.
    const rpc = client({ connect, maxConcurrentRequests: 1, timeoutMs: 100 })
    for (let i = 0; i < 4; i += 1) expect(await failure(rpc.getBestBlockHash())).toBeInstanceOf(RpcTimeoutError)
    expect(calls).toBe(2)
    const waiting = rpc.getBestBlockHash({ timeoutMs: 5000 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(calls).toBe(2)
    stuck[0]!(new Error('gave up at last'))
    expect(await waiting).toBe(HASH_A)
    expect(calls).toBe(3)
    expect(node.requests).toHaveLength(1)
  })

  describe('with connect hung, and tunnels that nobody waits for', () => {
    /**
     * A connect that hangs while `hung`, honouring its signal or, with
     * `ignoring`, until `letGo`, and works otherwise. `signals` has one for each call.
     */
    function hanging({ ignoring = false } = {}): {
      readonly connect: RpcConnect
      readonly signals: AbortSignal[]
      readonly letGo: ((error: Error) => void)[]
      unhang(): void
    } {
      const working = viaProxy('127.0.0.1', proxy.port)
      const signals: AbortSignal[] = []
      const letGo: ((error: Error) => void)[] = []
      let hung = true
      return {
        signals,
        letGo,
        unhang: () => (hung = false),
        connect: target => {
          signals.push(target.signal)
          if (!hung) return working(target)
          return new Promise<Duplex>((_resolve, reject) => {
            letGo.push(reject)
            if (!ignoring) target.signal.addEventListener('abort', () => reject(new Error('gave up')), { once: true })
          })
        },
      }
    }

    it.each([false, true])(
      'sends a side-effecting call at once, past reads that gave up (connect ignores its signal: %s)',
      async ignoring => {
        const opened = viaProxy('127.0.0.1', proxy.port)
        const proxied = hanging({ ignoring })
        let confirming = true
        const rpc = client({
          connect: target => (confirming ? opened(target) : proxied.connect(target)),
          maxConcurrentRequests: 1,
          timeoutMs: 30_000,
        })
        await rpc.confirmChain()
        rpc.close()
        confirming = false
        for (let i = 0; i < 2; i += 1) {
          expect(await failure(rpc.getBestBlockHash({ timeoutMs: 20 }))).toBeInstanceOf(RpcTimeoutError)
        }
        expect(proxied.signals).toHaveLength(2)
        proxied.unhang()
        const started = performance.now()
        expect(await rpc.sendRawTransaction(TX_HEX, {}, { timeoutMs: 1000 })).toBe(TX_TXID)
        expect(performance.now() - started).toBeLessThan(500)
        expect(proxied.signals).toHaveLength(3)
        expect(methods()).toEqual([...CHECK, 'sendrawtransaction'])
        rpc.close()
      }
    )

    it('sends a side-effecting call that needs a chain re-check at once, past reads that gave up', async () => {
      const opened = viaProxy('127.0.0.1', proxy.port)
      const proxied = hanging()
      let confirming = true
      const rpc = client({
        connect: target => (confirming ? opened(target) : proxied.connect(target)),
        maxConcurrentRequests: 1,
        timeoutMs: 30_000,
        chainCheckMaxAgeMs: 1,
      })
      await rpc.confirmChain()
      rpc.close()
      confirming = false
      for (let i = 0; i < 2; i += 1) {
        expect(await failure(rpc.getBestBlockHash({ timeoutMs: 20 }))).toBeInstanceOf(RpcTimeoutError)
      }
      proxied.unhang()
      const started = performance.now()
      expect(await rpc.sendRawTransaction(TX_HEX, {}, { timeoutMs: 2000 })).toBe(TX_TXID)
      expect(performance.now() - started).toBeLessThan(1000)
      expect(methods()).toEqual([...CHECK, ...CHECK, 'sendrawtransaction'])
      // The newest gave way for it, and the oldest, the nearest to opening, goes on.
      expect(proxied.signals.map(signal => signal.aborted)).toEqual([false, true, false, false])
      rpc.close()
    })

    it('holds the bound on each: the pool’s size for reads, and as many for side-effecting calls', async () => {
      const opened = viaProxy('127.0.0.1', proxy.port)
      const proxied = hanging({ ignoring: true })
      let confirming = true
      const rpc = client({
        connect: target => (confirming ? opened(target) : proxied.connect(target)),
        maxConcurrentRequests: 1,
        timeoutMs: 40,
      })
      await rpc.confirmChain()
      rpc.close()
      confirming = false
      for (let i = 0; i < 4; i += 1) expect(await failure(rpc.getBestBlockHash())).toBeInstanceOf(RpcTimeoutError)
      expect(proxied.signals).toHaveLength(2)
      for (let i = 0; i < 4; i += 1) {
        const error = await failure(rpc.sendRawTransaction(TX_HEX))
        expect(error).toBeInstanceOf(RpcTimeoutError)
        expect(RpcUnknownOutcomeError.is(error)).toBe(false)
      }
      expect(proxied.signals).toHaveLength(4)
      // A turn given back goes to the kind that gave it.
      const waiting = failure(rpc.sendRawTransaction(TX_HEX, {}, { timeoutMs: 200 }))
      proxied.letGo[0]!(new Error('a read’s, at last'))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(proxied.signals).toHaveLength(4)
      proxied.letGo[2]!(new Error('a side-effecting call’s, at last'))
      await expect.poll(() => proxied.signals.length).toBe(5)
      expect(await waiting).toBeInstanceOf(RpcTimeoutError)
      for (const reject of proxied.letGo) reject(new Error('at last'))
    })

    it('never dials for a read that gave up while it waited for its turn, and passes the turn on', async () => {
      const proxied = hanging({ ignoring: true })
      // A pool of two, both turns held by connect calls that ignore their signal.
      const rpc = client({ connect: proxied.connect, maxConcurrentRequests: 1, timeoutMs: 5000 })
      for (let i = 0; i < 3; i += 1) {
        expect(await failure(rpc.getBestBlockHash({ timeoutMs: 20 }))).toBeInstanceOf(RpcTimeoutError)
      }
      expect(proxied.signals).toHaveLength(2)
      proxied.unhang()
      proxied.letGo[0]!(new Error('gave up at last'))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(proxied.signals).toHaveLength(2)
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
      expect(proxied.signals).toHaveLength(3)
      proxied.letGo[1]!(new Error('gave up at last'))
      rpc.close()
    })

    it('serves a read waiting for its turn from a connection parked meanwhile, without dialling again', async () => {
      const working = viaProxy('127.0.0.1', proxy.port)
      const opening: (() => void)[] = []
      const signals: AbortSignal[] = []
      const connect: RpcConnect = target => {
        signals.push(target.signal)
        // These ignore their signal, so the newest keeps its turn.
        return new Promise<Duplex>(resolve => opening.push(() => resolve(working(target))))
      }
      const rpc = client({ connect, maxConcurrentRequests: 1, timeoutMs: 5000 })
      for (let i = 0; i < 2; i += 1) {
        expect(await failure(rpc.getBestBlockHash({ timeoutMs: 20 }))).toBeInstanceOf(RpcTimeoutError)
      }
      const waiting = rpc.getBestBlockHash({ timeoutMs: 2000 })
      await new Promise(resolve => setTimeout(resolve, 20))
      opening[0]!()
      expect(await waiting).toBe(HASH_A)
      expect(signals).toHaveLength(2)
      expect(signals[0]!.aborted).toBe(false)
      rpc.close()
    })
  })

  describe('a queued request and the connection Node opens for it', () => {
    const endpointOf = (): ReturnType<typeof parseEndpoint> =>
      parseEndpoint(`https://node.test:${node.port}/`, undefined)
    /** One socket, the first request holding it: later ones queue in Node's agent until it closes. */
    const setUp = (
      connect: RpcConnect,
      openTimeoutMs = 5000
    ): { readonly transport: HttpTransport; exchange(method: string, signal: AbortSignal): Promise<unknown> } => {
      const endpoint = endpointOf()
      const transport = new HttpTransport(1, undefined, {
        loopbackOnly: false,
        tls: parseTls({ ca: pki.ca.cert, pinSha256: pki.server.pin }, endpoint),
        connect,
        openTimeoutMs,
      })
      const answer = node.handler
      node.handler = (recorded, response) => (recorded.body.includes('"hang"') ? undefined : answer(recorded, response))
      return {
        transport,
        exchange: (method, signal) =>
          transport.send({
            url: endpoint.url,
            authorization: 'Basic dTpw',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
            signal,
            maxResponseBytes: 1 << 20,
            freshConnection: false,
          }),
      }
    }

    it('serves the next one queued when the one it was opened for gives up', async () => {
      const working = viaProxy('127.0.0.1', proxy.port)
      const opening: (() => void)[] = []
      let calls = 0
      const { transport, exchange } = setUp(target => {
        calls += 1
        return calls === 1
          ? working(target)
          : new Promise<Duplex>(resolve => opening.push(() => resolve(working(target))))
      })
      try {
        const first = new AbortController()
        const hung = exchange('hang', first.signal)
        await expect.poll(() => node.requests.length).toBe(1)
        const givesUp = new AbortController()
        const gaveUp = exchange('getbestblockhash', givesUp.signal)
        const served = exchange('getbestblockhash', AbortSignal.timeout(5000))
        first.abort()
        await expect(hung).rejects.toMatchObject({ kind: 'aborted', sent: true })
        await expect.poll(() => opening.length).toBe(1)
        givesUp.abort()
        await expect(gaveUp).rejects.toMatchObject({ kind: 'aborted', sent: false })
        opening[0]!()
        expect(await served).toMatchObject({ status: 200 })
        expect(calls).toBe(2)
      } finally {
        transport.close()
      }
    })

    it('does not dial for a read that gave up as soon as it was sent, holding a turn', async () => {
      let calls = 0
      const { transport, exchange } = setUp(() => {
        calls += 1
        return new Promise<Duplex>(() => {})
      })
      try {
        const gives = new AbortController()
        const gaveUp = exchange('getbestblockhash', gives.signal)
        gives.abort()
        await expect(gaveUp).rejects.toMatchObject({ kind: 'aborted', sent: false })
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(calls).toBe(0)
      } finally {
        transport.close()
      }
    })

    it('does not dial for a request queued that gave up, with none behind it', async () => {
      const working = viaProxy('127.0.0.1', proxy.port)
      let calls = 0
      const { transport, exchange } = setUp(target => {
        calls += 1
        return working(target)
      })
      try {
        const first = new AbortController()
        const hung = exchange('hang', first.signal)
        await expect.poll(() => node.requests.length).toBe(1)
        const givesUp = new AbortController()
        const gaveUp = exchange('getbestblockhash', givesUp.signal)
        givesUp.abort()
        await expect(gaveUp).rejects.toMatchObject({ kind: 'aborted', sent: false })
        first.abort()
        await expect(hung).rejects.toMatchObject({ kind: 'aborted', sent: true })
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(calls).toBe(1)
        expect(await exchange('getbestblockhash', AbortSignal.timeout(5000))).toMatchObject({ status: 200 })
        expect(calls).toBe(2)
      } finally {
        transport.close()
      }
    })
  })

  describe('a connection Node opens by itself that fails', () => {
    /** The error of the connection that fails: another connection's code, on a request it did not serve, would show. */
    const refused = (): Error => Object.assign(new Error('proxy refused'), { code: 'EPROXY' })
    /** A request no connection serves fails at this deadline, which none of these tests waits for. */
    const LONG = 2000

    /**
     * `size` sockets, the first `working` connections through the proxy and the
     * ones after waiting for `settle`. Requests for a `hold` method get no answer
     * until the test gives one.
     */
    const setUp = (
      size: number,
      working: number
    ): {
      readonly transport: HttpTransport
      readonly held: Map<string, ServerResponse>
      readonly dialled: () => number
      readonly settle: ((result: 'refuse' | 'open') => void)[]
      readonly seen: () => string[]
      exchange(method: string, signal?: AbortSignal): Promise<ExchangeResult>
    } => {
      const endpoint = parseEndpoint(`https://node.test:${node.port}/`, undefined)
      const through = viaProxy('127.0.0.1', proxy.port)
      const settle: ((result: 'refuse' | 'open') => void)[] = []
      const held = new Map<string, ServerResponse>()
      let calls = 0
      const transport = new HttpTransport(size, undefined, {
        loopbackOnly: false,
        tls: parseTls({ ca: pki.ca.cert, pinSha256: pki.server.pin }, endpoint),
        connect: target => {
          calls += 1
          if (calls <= working) return through(target)
          return new Promise<Duplex>((resolve, reject) => {
            target.signal.addEventListener('abort', () => reject(refused()), { once: true })
            settle.push(result => (result === 'open' ? resolve(through(target)) : reject(refused())))
          })
        },
        openTimeoutMs: 5000,
      })
      const answer = node.handler
      node.handler = (recorded, response) => {
        const { method } = JSON.parse(recorded.body) as { method: string }
        if (method.startsWith('hold')) held.set(method, response)
        else answer(recorded, response)
      }
      return {
        transport,
        held,
        settle,
        dialled: () => calls,
        seen: () => node.requests.map(request => (JSON.parse(request.body) as { method: string }).method),
        exchange: (method, signal = AbortSignal.timeout(LONG)) =>
          transport.send({
            url: endpoint.url,
            authorization: 'Basic dTpw',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
            signal,
            maxResponseBytes: 1 << 20,
            freshConnection: false,
          }),
      }
    }
    const outcome = (exchange: Promise<ExchangeResult>): Promise<unknown> =>
      exchange.then(
        reply => reply.status,
        (error: unknown) => error
      )
    const REFUSED = { kind: 'network', sent: false, code: 'EPROXY' }
    /** Lets what a failure would reach run: Node reports it on a later tick, and a socket's close comes later still. */
    const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50))

    it('leaves a read that went out on another socket to its own exchange: it is answered', async () => {
      const { transport, held, settle, dialled, seen, exchange } = setUp(2, 2)
      try {
        const first = outcome(exchange('hold-first'))
        const second = outcome(exchange('hold-second'))
        await expect.poll(() => held.size).toBe(2)
        const queued = outcome(exchange('hold-queued'))
        held.get('hold-first')!.socket!.destroy()
        await expect.poll(dialled).toBe(3)
        // The second socket comes free: the queued read goes out on it, not on the connection opening for it.
        held.get('hold-second')!.end('{}')
        await expect.poll(() => held.has('hold-queued')).toBe(true)
        settle[0]!('refuse')
        await settled()
        held.get('hold-queued')!.end('{}')
        expect(await queued).toBe(200)
        expect(await second).toBe(200)
        expect(await first).toMatchObject({ kind: 'network', sent: true })
        expect(seen().filter(method => method === 'hold-queued')).toHaveLength(1)
      } finally {
        transport.close()
      }
    })

    it('leaves a read that went out on another socket to its own exchange: its own connection fails it', async () => {
      const { transport, held, settle, dialled, exchange } = setUp(2, 2)
      try {
        const first = outcome(exchange('hold-first'))
        const second = outcome(exchange('hold-second'))
        await expect.poll(() => held.size).toBe(2)
        const queued = outcome(exchange('hold-queued'))
        held.get('hold-first')!.socket!.destroy()
        await expect.poll(dialled).toBe(3)
        held.get('hold-second')!.end('{}')
        await expect.poll(() => held.has('hold-queued')).toBe(true)
        settle[0]!('refuse')
        await settled()
        held.get('hold-queued')!.socket!.destroy()
        const failed = await queued
        expect(failed).toMatchObject({ kind: 'network', sent: true })
        expect(failed).not.toMatchObject({ code: 'EPROXY' })
        expect(await second).toBe(200)
        await first
      } finally {
        transport.close()
      }
    })

    it('goes to the read it serves by then, when the one Node picked went out on another socket', async () => {
      const { transport, held, settle, dialled, exchange } = setUp(2, 2)
      try {
        const first = outcome(exchange('hold-first'))
        const second = outcome(exchange('hold-second'))
        await expect.poll(() => held.size).toBe(2)
        const out = outcome(exchange('hold-out'))
        const served = outcome(exchange('hold-served'))
        held.get('hold-first')!.socket!.destroy()
        await expect.poll(dialled).toBe(3)
        held.get('hold-second')!.end('{}')
        await expect.poll(() => held.has('hold-out')).toBe(true)
        settle[0]!('refuse')
        expect(await served).toMatchObject(REFUSED)
        expect(held.has('hold-served')).toBe(false)
        held.get('hold-out')!.end('{}')
        expect(await out).toBe(200)
        expect(await second).toBe(200)
        await first
      } finally {
        transport.close()
      }
    })

    it('goes to the read it serves, when the one Node picked gave up', async () => {
      const { transport, held, settle, dialled, exchange } = setUp(1, 1)
      try {
        const first = outcome(exchange('hold-first'))
        await expect.poll(() => held.size).toBe(1)
        const gives = new AbortController()
        const gaveUp = outcome(exchange('hold-gave-up', gives.signal))
        const served = outcome(exchange('hold-served'))
        gives.abort()
        expect(await gaveUp).toMatchObject({ kind: 'aborted', sent: false })
        held.get('hold-first')!.socket!.destroy()
        await expect.poll(dialled).toBe(2)
        settle[0]!('refuse')
        expect(await served).toMatchObject(REFUSED)
        await first
      } finally {
        transport.close()
      }
    })

    it('fails a read it serves, which a later free socket then passes over', async () => {
      const { transport, held, settle, dialled, seen, exchange } = setUp(2, 2)
      try {
        const first = outcome(exchange('hold-first'))
        const second = outcome(exchange('hold-second'))
        await expect.poll(() => held.size).toBe(2)
        const served = outcome(exchange('hold-served'))
        const behind = outcome(exchange('hold-behind'))
        held.get('hold-first')!.socket!.destroy()
        await expect.poll(dialled).toBe(3)
        settle[0]!('refuse')
        expect(await served).toMatchObject(REFUSED)
        // The one behind it opens its own, which stays open: the free socket reaches it first.
        await expect.poll(dialled).toBe(4)
        held.get('hold-second')!.end('{}')
        await expect.poll(() => held.has('hold-behind')).toBe(true)
        expect(seen()).not.toContain('hold-served')
        held.get('hold-behind')!.end('{}')
        expect(await behind).toBe(200)
        expect(await second).toBe(200)
        await first
      } finally {
        transport.close()
      }
    })

    it('lets the next one queued open its own, so nothing is left to wait for its deadline', async () => {
      const { transport, held, settle, dialled, exchange } = setUp(1, 1)
      try {
        const first = outcome(exchange('hold-first'))
        await expect.poll(() => held.size).toBe(1)
        const served = outcome(exchange('hold-served'))
        const next = outcome(exchange('getbestblockhash'))
        held.get('hold-first')!.socket!.destroy()
        await expect.poll(dialled).toBe(2)
        settle[0]!('refuse')
        expect(await served).toMatchObject(REFUSED)
        await expect.poll(dialled).toBe(3)
        settle[1]!('open')
        expect(await next).toBe(200)
        await first
      } finally {
        transport.close()
      }
    })

    it('tells each one queued in turn when each connection fails', async () => {
      const { transport, held, settle, dialled, exchange } = setUp(1, 1)
      try {
        const first = outcome(exchange('hold-first'))
        await expect.poll(() => held.size).toBe(1)
        const queued = ['a', 'b', 'c'].map(name => outcome(exchange(`hold-${name}`)))
        held.get('hold-first')!.socket!.destroy()
        for (const [index, read] of queued.entries()) {
          await expect.poll(dialled).toBe(index + 2)
          settle[index]!('refuse')
          expect(await read).toMatchObject(REFUSED)
        }
        await settled()
        expect(dialled()).toBe(4)
        await first
      } finally {
        transport.close()
      }
    })

    it('tells no read when none waits for it', async () => {
      const { transport, held, settle, dialled, exchange } = setUp(2, 2)
      try {
        const first = outcome(exchange('hold-first'))
        const second = outcome(exchange('hold-second'))
        await expect.poll(() => held.size).toBe(2)
        const gives = new AbortController()
        const gaveUp = outcome(exchange('hold-gave-up', gives.signal))
        held.get('hold-first')!.socket!.destroy()
        await expect.poll(dialled).toBe(3)
        gives.abort()
        expect(await gaveUp).toMatchObject({ kind: 'aborted', sent: false })
        settle[0]!('refuse')
        await settled()
        expect(dialled()).toBe(3)
        held.get('hold-second')!.end('{}')
        expect(await second).toBe(200)
        await first
      } finally {
        transport.close()
      }
    })

    it('tells no read when one `send` asked for lost its read: the one queued takes the next free socket', async () => {
      const { transport, held, settle, dialled, seen, exchange } = setUp(2, 1)
      try {
        const first = outcome(exchange('hold-first'))
        await expect.poll(() => held.size).toBe(1)
        // The pool has room for both, and neither counts until it is open.
        const gives = new AbortController()
        const gaveUp = outcome(exchange('hold-gave-up', gives.signal))
        await expect.poll(dialled).toBe(2)
        const second = outcome(exchange('hold-second'))
        await expect.poll(dialled).toBe(3)
        settle[1]!('open')
        await expect.poll(() => held.size).toBe(2)
        // The pool is full now: this one queues, and is who the first connection serves once its read gives up.
        const queued = outcome(exchange('hold-queued'))
        gives.abort()
        expect(await gaveUp).toMatchObject({ kind: 'aborted', sent: false })
        settle[0]!('refuse')
        await settled()
        expect(dialled()).toBe(3)
        held.get('hold-second')!.end('{}')
        expect(await second).toBe(200)
        await expect.poll(() => held.has('hold-queued')).toBe(true)
        held.get('hold-queued')!.end('{}')
        expect(await queued).toBe(200)
        expect(seen().filter(method => method === 'hold-queued')).toHaveLength(1)
        held.get('hold-first')!.end('{}')
        expect(await first).toBe(200)
      } finally {
        transport.close()
      }
    })

    it('tells the read it serves on close(), and the next one queued opens its own', async () => {
      const { transport, held, settle, dialled, exchange } = setUp(1, 1)
      try {
        const first = outcome(exchange('hold-first'))
        await expect.poll(() => held.size).toBe(1)
        const served = outcome(exchange('hold-served'))
        const next = outcome(exchange('getbestblockhash'))
        held.get('hold-first')!.socket!.destroy()
        await expect.poll(dialled).toBe(2)
        transport.close()
        expect(await served).toMatchObject({ kind: 'network', sent: false })
        await expect.poll(dialled).toBe(3)
        settle[1]!('open')
        expect(await next).toBe(200)
        await first
      } finally {
        transport.close()
      }
    })
  })

  describe('a connection kept after its read gave up', () => {
    /** Opens each tunnel once let go, so that a read gives up first, and leaves a connection parked for the next call. */
    async function parked(options: Partial<QbitRpcClientOptions> = {}): Promise<{
      readonly rpc: QbitRpcClient
      readonly calls: () => number
    }> {
      const working = viaProxy('127.0.0.1', proxy.port)
      let calls = 0
      let delayed = false
      const rpc = client({
        connect: target => {
          calls += 1
          if (!delayed) return working(target)
          return new Promise<Duplex>(resolve => setTimeout(() => resolve(working(target)), 40))
        },
        ...options,
      })
      await rpc.confirmChain()
      rpc.close()
      delayed = true
      const opened = node.handshakes
      expect(await failure(rpc.getBestBlockHash({ timeoutMs: 10 }))).toBeInstanceOf(RpcTimeoutError)
      await expect.poll(() => node.handshakes).toBe(opened + 1)
      delayed = false
      return { rpc, calls: () => calls }
    }

    /** Resets the connection under the next request to arrive, once. */
    function resetNext(): void {
      const answer = node.handler
      let armed = true
      node.handler = (recorded, response) => {
        if (!armed) return answer(recorded, response)
        armed = false
        response.socket?.destroy()
        return undefined
      }
    }

    it('gives a read reset on it the extra attempt a free socket gets', async () => {
      const { rpc, calls } = await parked()
      const before = calls()
      resetNext()
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
      expect(calls()).toBe(before + 1)
      expect(rpc.chainStatus).toBe('stale')
      rpc.close()
    })

    it('lets a broadcast go out when the chain re-check before it is reset on it', async () => {
      const { rpc } = await parked({ chainCheckMaxAgeMs: 1 })
      resetNext()
      expect(await rpc.sendRawTransaction(TX_HEX)).toBe(TX_TXID)
      expect(methods().filter(method => method === 'sendrawtransaction')).toHaveLength(1)
      rpc.close()
    })

    it('never carries a side-effecting call', async () => {
      const { rpc, calls } = await parked()
      const before = calls()
      const seen = node.requests.length
      expect(await rpc.sendRawTransaction(TX_HEX)).toBe(TX_TXID)
      // The chain re-check takes it, if one is due; the call itself never does.
      const write = node.requests.slice(seen).find(request => request.body.includes('sendrawtransaction'))
      expect(write?.headers.connection).toBe('close')
      expect(calls()).toBe(before + 1)
      rpc.close()
    })

    it('closes with the other idle connections on such a reset, as they went idle together', async () => {
      const working = viaProxy('127.0.0.1', proxy.port)
      const opening: (() => void)[] = []
      let calls = 0
      const rpc = client({
        connect: target => {
          calls += 1
          return calls <= 2
            ? new Promise<Duplex>(resolve => opening.push(() => resolve(working(target))))
            : working(target)
        },
        retryDelayMs: 0,
      })
      for (let i = 0; i < 2; i += 1) {
        expect(await failure(rpc.getBestBlockHash({ timeoutMs: 10 }))).toBeInstanceOf(RpcTimeoutError)
      }
      for (const open of opening) open()
      await expect.poll(() => node.handshakes).toBe(2)
      resetNext()
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
      // Not the other parked one, stale as well: a new tunnel.
      expect(calls).toBe(3)
      await expect.poll(() => node.connections).toBe(1)
      rpc.close()
    })

    it.each(['end', 'destroy'] as const)(
      'is dropped when the node closes it (%s), and the next read opens a new one',
      async how => {
        const { rpc, calls } = await parked()
        const before = calls()
        expect(node.connections).toBeGreaterThan(0)
        node.eachConnection(socket => socket[how]())
        await expect.poll(() => node.connections).toBe(0)
        expect(await rpc.getBestBlockHash()).toBe(HASH_A)
        expect(calls()).toBe(before + 1)
        rpc.close()
      }
    )

    it.each(['end', 'destroy', 'resetAndDestroy'] as const)(
      'is dropped when the proxy closes the tunnel (%s), and the next read opens a new one',
      async how => {
        // A tunnel the test can close from the proxy's side, without the node.
        const relaySides: Socket[] = []
        const relay: TcpServer = createTcpServer(side => {
          relaySides.push(side)
          const upstream = netConnect(node.port, '127.0.0.1')
          side.pipe(upstream).pipe(side)
          side.on('error', () => upstream.destroy())
          upstream.on('error', () => side.destroy())
          side.on('close', () => upstream.destroy())
        })
        await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve))
        let delayed = true
        let calls = 0
        const rpc = client({
          connect: () =>
            new Promise<Socket>((resolve, reject) => {
              calls += 1
              setTimeout(
                () => {
                  const socket = netConnect((relay.address() as AddressInfo).port, '127.0.0.1', () => resolve(socket))
                  socket.once('error', reject)
                },
                delayed ? 40 : 0
              )
            }),
        })
        expect(await failure(rpc.getBestBlockHash({ timeoutMs: 10 }))).toBeInstanceOf(RpcTimeoutError)
        await expect.poll(() => node.handshakes).toBe(1)
        delayed = false
        relaySides[0]![how]()
        await new Promise(resolve => setTimeout(resolve, 30))
        expect(await rpc.getBestBlockHash()).toBe(HASH_A)
        expect(calls).toBe(2)
        rpc.close()
        for (const side of relaySides) side.destroy()
        await new Promise(resolve => relay.close(resolve))
      }
    )
  })

  describe('a short program, with a tunnel its read left behind', () => {
    let directory: string
    let silent: TcpServer
    const silentSockets = new Set<Socket>()

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'qbit-rpc-exit-'))
      await build({
        config: false,
        silent: true,
        format: ['esm'],
        outDir: directory,
        outExtension: () => ({ js: '.mjs' }),
        entry: { child: fileURLToPath(new URL('./helpers/exit-child.ts', import.meta.url)) },
        platform: 'node',
        target: 'node22',
        dts: false,
        clean: false,
      })
      // Accepts connections and never answers: a handshake over it hangs.
      silent = createTcpServer(socket => {
        silentSockets.add(socket)
        socket.on('error', () => {})
      })
      await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
    }, 30_000)
    afterAll(async () => {
      for (const socket of silentSockets) socket.destroy()
      await new Promise(resolve => silent.close(resolve))
      await rm(directory, { recursive: true })
    })

    /** Runs the program, and how long it took to exit, or the failure of being killed at 8 s. */
    function run(
      scenario: string,
      port: number
    ): Promise<{ readonly code: number; readonly ms: number; readonly stdout: string }> {
      return new Promise(resolve => {
        const started = performance.now()
        const argument = JSON.stringify({ port, ca: pki.ca.cert, scenario })
        const child = execFile(process.execPath, [join(directory, 'child.mjs'), argument], { timeout: 8000 })
        let stdout = ''
        child.stdout?.on('data', chunk => (stdout += String(chunk)))
        child.on('close', (code, signal) =>
          resolve({ code: signal === null ? (code ?? -1) : -1, ms: performance.now() - started, stdout })
        )
      })
    }

    it('exits once its work is done, with the connection parked', async () => {
      const { code, ms, stdout } = await run('parked', node.port)
      expect(node.handshakes).toBe(1)
      expect(stdout.trim()).toBe('parked: 0')
      expect(code).toBe(0)
      expect(ms).toBeLessThan(5000)
    }, 15_000)

    it.each(['in handshake', 'gave up in handshake'])(
      'exits once its work is done, with the connection still in its handshake (%s)',
      async scenario => {
        const { code, ms } = await run(scenario, (silent.address() as AddressInfo).port)
        expect(code).toBe(0)
        expect(ms).toBeLessThan(5000)
      },
      15_000
    )

    it('keeps the process alive for a request on a connection taken from the parked set', async () => {
      const answer = node.handler
      node.handler = async (recorded, response) => {
        await new Promise(resolve => setTimeout(resolve, 200))
        return answer(recorded, response)
      }
      const { code, stdout } = await run('taken', node.port)
      expect(code).toBe(0)
      expect(stdout.trim().split('\n')).toEqual(['parked: 0', 'in use: 1', HASH_A])
    }, 15_000)
  })

  it('keeps no request of a long-lived connection’s past reachable from that connection', async () => {
    const https = createRequire(import.meta.url)('node:https') as { request: typeof httpsModule.request }
    const openRequest = https.request
    const built: WeakRef<ClientRequest>[] = []
    https.request = ((...args: Parameters<typeof httpsModule.request>) => {
      const request = openRequest(...args)
      built.push(new WeakRef(request))
      return request
    }) as typeof https.request
    syncBuiltinESMExports()
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    const rpc = client()
    try {
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
      expect(built).toHaveLength(1)
      await expect
        .poll(async () => {
          gc()
          await new Promise(resolve => setImmediate(resolve))
          return built[0]!.deref() === undefined
        })
        .toBe(true)
      // The connection itself is alive, and carries the next read.
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
      expect(proxy.tunnels).toHaveLength(1)
    } finally {
      https.request = openRequest
      syncBuiltinESMExports()
      rpc.close()
    }
  })

  it('fails, with nothing sent and no crash, when connect returns a stream that is already failing', async () => {
    const stream = (when: 'now' | 'next tick'): Duplex => {
      const opened = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          callback()
        },
      })
      const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      if (when === 'now') opened.destroy(reset)
      else process.nextTick(() => opened.destroy(reset))
      return opened
    }
    // Returned at once, or through a promise, already destroyed: its error is still to come.
    for (const connect of [(): Duplex => stream('now'), async (): Promise<Duplex> => stream('now')]) {
      const destroyed = await failure(client({ connect }).getBestBlockHash())
      expect(destroyed).toMatchObject({ name: 'RpcTransportError', reason: 'network', code: 'ECONNRESET' })
    }
    const reset = await failure(client({ connect: () => stream('next tick') }).getBestBlockHash())
    expect(reset instanceof TypeError || RpcTransportError.is(reset)).toBe(true)
    expect(node.requests).toHaveLength(0)
  })

  describe('when a call waiting for a turn starts from an event callback, and connect resolves to a failed stream', () => {
    const url = (): URL => new URL(`https://node.test:${node.port}/`)
    /** A transport with one turn, where the first call takes `first` and every later one a stream already destroyed. */
    const withOneTurn = (first: RpcConnect): { readonly transport: HttpTransport; readonly calls: () => number } => {
      let calls = 0
      const endpoint = parseEndpoint(url().href, undefined)
      const transport = new HttpTransport(1, undefined, {
        loopbackOnly: false,
        tls: parseTls({ ca: pki.ca.cert, pinSha256: pki.server.pin }, endpoint),
        openTimeoutMs: 5000,
        connect: async target => {
          calls += 1
          if (calls === 1) return first(target)
          const failed = silentStream()
          failed.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
          return failed
        },
      })
      return { transport, calls: () => calls }
    }
    const send = (transport: HttpTransport, signal: AbortSignal, freshConnection: boolean): Promise<unknown> =>
      transport.send({
        url: url(),
        authorization: 'Basic dTpw',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getbestblockhash', params: [] }),
        signal,
        maxResponseBytes: 1 << 20,
        freshConnection,
      })

    /** Runs `run`, and fails if the process saw an uncaught error meanwhile, which a real process dies of. */
    const noCrash = async (run: () => Promise<void>): Promise<void> => {
      const crashes: unknown[] = []
      const onCrash = (error: unknown): void => void crashes.push(error)
      process.on('uncaughtException', onCrash)
      try {
        await run()
        await new Promise(resolve => setTimeout(resolve, 20))
      } finally {
        process.removeListener('uncaughtException', onCrash)
      }
      expect(crashes).toEqual([])
    }
    const failedStream = { kind: 'network', sent: false, code: 'ECONNRESET' }

    it.each([false, true])('a deadline timer starts it (fresh connection: %s)', async freshConnection => {
      // The handshake of the first hangs, holding the turn, until its call's deadline.
      const { transport, calls } = withOneTurn(() => silentStream())
      await noCrash(async () => {
        const first = send(transport, AbortSignal.timeout(30), freshConnection)
        const waiting = send(transport, AbortSignal.timeout(5000), freshConnection)
        await expect(first).rejects.toMatchObject({ kind: 'aborted', sent: false })
        await expect(waiting).rejects.toMatchObject(failedStream)
      })
      expect(calls()).toBe(2)
      transport.close()
    })

    it('a secureConnect callback starts it', async () => {
      const { transport, calls } = withOneTurn(viaProxy('127.0.0.1', proxy.port))
      await noCrash(async () => {
        const first = send(transport, AbortSignal.timeout(5000), true)
        const waiting = send(transport, AbortSignal.timeout(5000), true)
        await expect(waiting).rejects.toMatchObject(failedStream)
        expect(await first).toMatchObject({ status: 200 })
      })
      expect(calls()).toBe(2)
      transport.close()
    })

    it('an error handler starts it', async () => {
      // The first's stream fails during the handshake.
      const { transport, calls } = withOneTurn(() => {
        const stream = silentStream()
        setTimeout(() => stream.destroy(Object.assign(new Error('gone'), { code: 'EPIPE' })), 20)
        return stream
      })
      await noCrash(async () => {
        const first = send(transport, AbortSignal.timeout(5000), true)
        const waiting = send(transport, AbortSignal.timeout(5000), true)
        await expect(first).rejects.toMatchObject({ kind: 'network', sent: false, code: 'EPIPE' })
        await expect(waiting).rejects.toMatchObject(failedStream)
      })
      expect(calls()).toBe(2)
      transport.close()
    })
  })

  describe('when the stream closes, or Node cannot build TLS over it', () => {
    const tls = createRequire(import.meta.url)('node:tls') as { connect: typeof tlsModule.connect }
    const openTls = tls.connect

    /** Runs `run` while every tls.connect throws as Node does for a context that is none. */
    async function failingTls<T>(run: () => Promise<T>): Promise<T> {
      tls.connect = ((options: tlsModule.ConnectionOptions) =>
        openTls({ ...options, secureContext: {} as tlsModule.SecureContext })) as typeof tls.connect
      syncBuiltinESMExports()
      try {
        return await run()
      } finally {
        tls.connect = openTls
        syncBuiltinESMExports()
      }
    }

    it('fails a call fast, as network and unsent, when the stream closes in the handshake with no error', async () => {
      let closing = false
      const working = viaProxy('127.0.0.1', proxy.port)
      const connect: RpcConnect = target => {
        if (!closing) return working(target)
        const stream = silentStream()
        setTimeout(() => stream.destroy(), 50)
        return stream
      }
      const rpc = client({ connect, timeoutMs: 2000 })
      await rpc.confirmChain()
      rpc.close()
      closing = true
      // The write first: a failed read makes the chain check run before it.
      for (const call of [() => rpc.sendRawTransaction(TX_HEX), () => rpc.getBestBlockHash()]) {
        const started = performance.now()
        const error = await failure(call())
        expect(RpcUnknownOutcomeError.is(error)).toBe(false)
        expect(error).toMatchObject({ name: 'RpcTransportError', reason: 'network', code: 'ECONNRESET' })
        expect(performance.now() - started).toBeLessThan(1000)
      }
      expect(methods()).toEqual([...CHECK])
    })

    it('fails the call, with no crash, when the stream errors on its signal after Node failed to build TLS over it', async () => {
      // As the README asks: the stream is destroyed when the signal fires, here with an error.
      const connect: RpcConnect = ({ signal }) => {
        const socket = netConnect(node.port, '127.0.0.1')
        signal.addEventListener(
          'abort',
          () => socket.destroy(Object.assign(new Error('given up'), { code: 'ABORT_ERR' })),
          { once: true }
        )
        return socket
      }
      const rpc = client({ connect })
      await rpc.confirmChain()
      rpc.close()
      await withoutCrash(() =>
        failingTls(async () => {
          for (const call of [() => rpc.sendRawTransaction(TX_HEX), () => rpc.getBestBlockHash()]) {
            const error = await failure(call())
            expect(RpcUnknownOutcomeError.is(error)).toBe(false)
            expect(error).toMatchObject({ name: 'RpcTransportError', reason: 'tls', code: 'ERR_TLS_INVALID_CONTEXT' })
          }
        })
      )
      expect(methods()).toEqual([...CHECK])
    })

    it('keeps the caller’s own listeners on the stream, and drops those of the TLS socket Node could not build', async () => {
      let closes = 0
      const sockets: Socket[] = []
      const duplexes: Duplex[] = []
      const rpc = client({
        connect: () => {
          // A proxy library that tracks its sockets through close.
          const socket = netConnect(node.port, '127.0.0.1')
          socket.on('close', () => (closes += 1))
          sockets.push(socket)
          return socket
        },
      })
      const other = client({
        connect: () => {
          const duplex = silentStream()
          duplexes.push(duplex)
          return duplex
        },
      })
      await withoutCrash(async () => {
        await failingTls(async () => {
          expect(await failure(rpc.getBestBlockHash())).toMatchObject({ reason: 'tls' })
          expect(await failure(other.getBestBlockHash())).toMatchObject({ reason: 'tls' })
        })
        await expect.poll(() => closes).toBe(1)
        expect(sockets[0]!.destroyed).toBe(true)
        // A stream that is no net.Socket, erring later: nothing of the half-built socket is left to throw.
        duplexes[0]!.emit('error', Object.assign(new Error('late'), { code: 'ECONNRESET' }))
      })
    })
  })

  it('keeps a side-effecting call definite when its tunnel cannot be opened in time', async () => {
    let calls = 0
    const working = viaProxy('127.0.0.1', proxy.port)
    // The first tunnel opens; every later one hangs.
    const flaky: RpcConnect = target => (calls++ === 0 ? working(target) : new Promise<Duplex>(() => {}))
    const rpc = client({ connect: flaky, timeoutMs: 300 })
    await rpc.confirmChain()
    const error = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(error).toBeInstanceOf(RpcTimeoutError)
    expect(RpcUnknownOutcomeError.is(error)).toBe(false)
    expect(methods()).toEqual([...CHECK])
  })

  it('is the README’s example, word for word', () => {
    const source = (path: string): string => {
      const text = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
      const start = text.indexOf('function viaProxy(')
      return text.slice(start, text.indexOf('\n}\n', start))
    }
    expect(source('../README.md')).toBe(source('./connect.test.ts'))
  })

  it('needs an https url and Basic credentials, and a function', () => {
    const base = { auth: { username: 'u', password: 'p' }, expectedChain: 'main' as const }
    const connect = viaProxy('127.0.0.1', 1)
    expect(() => new QbitRpcClient({ ...base, url: 'http://127.0.0.1:8332/', connect })).toThrow(
      /connect needs an https url/
    )
    expect(
      () => new QbitRpcClient({ ...base, url: 'https://localhost:8332/', auth: { cookieFile: '/c/.cookie' }, connect })
    ).toThrow(/cookie authentication cannot use connect/)
    expect(() => new QbitRpcClient({ ...base, url: 'https://node.test/', connect: 'socks5://proxy' as never })).toThrow(
      /connect must be a function/
    )
    expect(
      JSON.parse(JSON.stringify(new QbitRpcClient({ ...base, url: 'https://node.test/', connect })))
    ).toMatchObject({ connect: 'custom' })
  })
})
