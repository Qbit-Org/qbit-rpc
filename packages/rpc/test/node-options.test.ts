import type * as httpModule from 'node:http'
import type * as httpsModule from 'node:https'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { createServer, type AddressInfo } from 'node:net'
import type * as netModule from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import type * as tlsModule from 'node:tls'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  QbitRpcClient,
  requests as requests_,
  RpcTransportError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
} from '../src'
import { parseEndpoint } from '../src/endpoint'
import { HttpTransport } from '../src/transport'
import { testPki } from './helpers/certificates'
import { chainResults, FakeNode, HASH_A, TX_HEX, TX_TXID } from './helpers/fake-node'
import { onPrototype, withoutCrash } from './helpers/prototype'

const require = createRequire(import.meta.url)
const http = require('node:http') as { request: typeof httpModule.request }
const https = require('node:https') as { request: typeof httpsModule.request }
const net = require('node:net') as { connect: typeof netModule.connect }
const tls = require('node:tls') as { connect: typeof tlsModule.connect }
const openSocket = net.connect
const openTls = tls.connect

const pki = testPki()
/** A CA and certificates the client does not trust. */
const other = testPki('other')

let node: FakeNode
afterEach(async () => {
  await node.close()
})

const RESULTS = {
  ...chainResults('regtest'),
  getbestblockhash: JSON.stringify(HASH_A),
  sendrawtransaction: JSON.stringify(TX_TXID),
}

async function start(secure: boolean): Promise<void> {
  node = await FakeNode.start(secure ? { tls: { key: pki.server.key, cert: pki.server.cert } } : {})
  node.results(RESULTS)
}

function client(options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  const secure = node.url.startsWith('https:')
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['broadcast'],
    ...(secure ? { tls: { ca: pki.ca.cert, servername: 'node.test', pinSha256: pki.server.pin } } : {}),
    retryDelayMs: 0,
    timeoutMs: 3000,
    ...options,
  })
}

/** A stream to the node for `connect`, opened with Node's own connect, not the one the tests wrap. */
const toNode = (): netModule.Socket => openSocket(node.port, '127.0.0.1')

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e
  )
}

/** A definite TLS refusal with `code`, never an unknown outcome. */
function expectRefused(error: unknown, code: string): void {
  expectNotSent(error, 'tls', code)
}

/** A definite RpcTransportError with `reason` and `code`, never an unknown outcome. */
function expectNotSent(error: unknown, reason: string, code?: string): void {
  expect(RpcUnknownOutcomeError.is(error)).toBe(false)
  expect(RpcTransportError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason, code })
}

/** A session from the node for `node.test`, as a client trusting `ca` holds it. */
function sessionFrom(ca: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = openTls({ host: '127.0.0.1', port: node.port, servername: 'node.test', ca })
    socket.once('session', session => {
      resolve(session)
      socket.destroy()
    })
    socket.once('error', reject)
    socket.resume()
  })
}

/** The options the wrapped functions below were called with: what the client gives Node. */
interface Seen {
  readonly requests: object[]
  readonly connections: object[]
}

/**
 * Runs `run` with `values` on Object.prototype only while the client calls
 * `net.connect` or `tls.connect`, or with `requests` from `http.request` and
 * `https.request` on: Node reads the connection's options there, and a whole
 * test under them would also reach the fake node in this process, the test
 * runner, and Node's own listeners, which keep event names in plain objects.
 * They are enumerable, as a pollution sets them, unless `enumerable` is false:
 * the client checks Object.prototype before Node builds a request, and
 * refuses the call, so `requests` takes them not enumerable.
 */
async function whileConnecting<T>(
  values: Readonly<Record<string, unknown>>,
  run: (seen: Seen) => Promise<T>,
  { requests = false, enumerable = !requests }: { readonly requests?: boolean; readonly enumerable?: boolean } = {}
): Promise<T> {
  const proto = Object.prototype as Record<string, unknown>
  const seen: Seen = { requests: [], connections: [] }
  let depth = 0
  const pollute = (): void => {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(proto, key, { value, enumerable, writable: true, configurable: true })
    }
  }
  const wrap = <F extends (...args: never[]) => unknown>(real: F, into: object[], polluting: boolean): F =>
    ((...args: unknown[]) => {
      into.push(args.find(arg => typeof arg === 'object' && arg !== null && !(arg instanceof URL)) as object)
      if (polluting && depth++ === 0) pollute()
      try {
        return real(...(args as never[]))
      } finally {
        if (polluting && --depth === 0) for (const key of Object.keys(values)) delete proto[key]
      }
    }) as unknown as F
  const realHttp = http.request
  const realHttps = https.request
  http.request = wrap(realHttp, seen.requests, requests)
  https.request = wrap(realHttps, seen.requests, requests)
  net.connect = wrap(openSocket, seen.connections, true)
  tls.connect = wrap(openTls, seen.connections, true)
  syncBuiltinESMExports()
  try {
    return await run(seen)
  } finally {
    http.request = realHttp
    https.request = realHttps
    net.connect = openSocket
    tls.connect = openTls
    syncBuiltinESMExports()
  }
}

const notTheClients = (): never => {
  throw new Error('not the client’s')
}
const onread = { buffer: Buffer.alloc(16), callback: () => true }

/** What `tls.connect` reads, with values that would change what it does: an own undefined key stops each. */
const TLS_OPTIONS: Readonly<Record<string, unknown>> = {
  ALPNProtocols: ['not-http'],
  allowHalfOpen: true,
  autoSelectFamily: 'x',
  autoSelectFamilyAttemptTimeout: 'x',
  enableTrace: true,
  family: 6,
  highWaterMark: 1,
  hints: 'x',
  isServer: true,
  // A number: Node 22 checks the type of the one the socket under a TLS socket reads, from the prototype.
  keepAliveInitialDelay: 1,
  localAddress: '127.0.0.9',
  localPort: 1,
  lookup: notTheClients,
  noDelay: true,
  onread,
  path: '/nonexistent/qbit-rpc-test.sock',
  pskCallback: notTheClients,
  requestOCSP: true,
  signal: AbortSignal.abort(),
  timeout: 1,
}

/** What `net.connect` reads besides, through `new Socket` and the Duplex under it. */
const SOCKET_OPTIONS: Readonly<Record<string, unknown>> = {
  ...Object.fromEntries(
    Object.entries(TLS_OPTIONS).filter(
      ([key]) => !['ALPNProtocols', 'enableTrace', 'pskCallback', 'requestOCSP'].includes(key)
    )
  ),
  blockList: 'x',
  construct: notTheClients,
  defaultEncoding: 'x',
  destroy: notTheClients,
  destroyOnReturn: false,
  encoding: 'latin1',
  fd: 99_999,
  final: notTheClients,
  handle: {},
  manualStart: true,
  objectMode: true,
  pauseOnCreate: true,
  read: notTheClients,
  // Not false: Node's stream state also reads that through Object.prototype, where no option reaches.
  readable: true,
  readableHighWaterMark: 1,
  readableObjectMode: true,
  typeOfService: 'x',
  writable: true,
  writableHighWaterMark: 1,
  writableObjectMode: true,
  write: notTheClients,
  writev: notTheClients,
}

describe('over TLS, Object.prototype lends a connection nothing', () => {
  beforeEach(() => start(true))

  it.each(Object.entries(TLS_OPTIONS))('%s: the option is the client’s own, directly', async (key, value) => {
    const rpc = client()
    const seen = await whileConnecting({ [key]: value }, async seen => {
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
      return seen
    })
    expect(seen.connections).toHaveLength(1)
    expect(Object.hasOwn(seen.connections[0]!, key)).toBe(true)
    expect(node.requests.at(-1)?.tls?.resumed).toBe(false)
    rpc.close()
  })

  it.each(Object.entries({ ...TLS_OPTIONS, host: 'other.test', port: 1 }))(
    '%s: the option is the client’s own, through connect',
    async (key, value) => {
      const rpc = client({ connect: toNode })
      const seen = await whileConnecting({ [key]: value }, async seen => {
        expect(await rpc.getBestBlockHash()).toBe(HASH_A)
        return seen
      })
      expect(seen.connections).toHaveLength(1)
      expect(Object.hasOwn(seen.connections[0]!, key)).toBe(true)
      expect(node.requests.at(-1)?.tls?.resumed).toBe(false)
      rpc.close()
    }
  )

  it('socket: the connection is to the URL, not over a stream on the prototype', async () => {
    const rpc = client()
    const stream = new PassThrough()
    expect(await whileConnecting({ socket: stream }, () => rpc.getBestBlockHash())).toBe(HASH_A)
    expect(stream.readableLength).toBe(0)
    rpc.close()
  })

  it('lookup: a name is resolved by the system, not by a function on the prototype', async () => {
    let lookups = 0
    const lookup = (): void => {
      lookups += 1
    }
    const rpc = client({ url: `https://localhost:${node.port}/`, tls: { ca: pki.ca.cert } })
    expect(await whileConnecting({ lookup }, () => rpc.getBestBlockHash())).toBe(HASH_A)
    expect(lookups).toBe(0)
    rpc.close()
  })

  it('gives every option of http.request and https.request itself, pooled and fresh', async () => {
    const rpc = client()
    const seen = await whileConnecting({}, async seen => {
      await rpc.confirmChain()
      await rpc.sendRawTransaction(TX_HEX)
      return seen
    })
    expect(seen.requests.length).toBeGreaterThanOrEqual(2)
    for (const options of seen.requests) {
      // Node 22 reads these through Object.prototype for an https request. `agent: false` above all would
      // use Node's connections, with none of the client's checks.
      for (const key of ['agent', 'auth', 'defaultPort', 'port', 'setHost', 'signal', 'socketPath', 'timeout']) {
        expect(Object.hasOwn(options, key)).toBe(true)
      }
    }
    rpc.close()
  })

  it('reads the keep-alive and timeout options of a fresh connection from Node’s own keys only', async () => {
    const rpc = client()
    await rpc.confirmChain()
    const seen = await whileConnecting(
      { keepAlive: true, keepAliveInitialDelay: 1 },
      async seen => {
        expect(await rpc.sendRawTransaction(TX_HEX)).toBe(TX_TXID)
        return seen
      },
      { requests: true }
    )
    expect(seen.connections).toHaveLength(1)
    expect(seen.connections[0]).toMatchObject({ keepAlive: undefined, keepAliveInitialDelay: undefined })
    rpc.close()
  })

  it('keeps the port a URL leaves out, and the port a URL names', async () => {
    const ports: number[] = []
    const noPort = client({
      url: 'https://node.test/',
      connect: ({ port }) => {
        ports.push(port)
        throw new Error('no proxy')
      },
    })
    await failure(noPort.getBestBlockHash())
    expect(ports).toEqual([443])
    const rpc = client({ url: `https://node.test:${node.port}/`, connect: toNode })
    expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    rpc.close()
  })

  it('fails a call with nothing sent, and no crash, when Node will not open the connection', async () => {
    // Node's own socket options, which a client cannot set: objectMode is refused by name, by the socket, so network.
    const direct = client()
    await direct.confirmChain()
    const tunnel = client({ connect: toNode })
    await tunnel.confirmChain()
    node.requests.length = 0
    await withoutCrash(async () => {
      for (const rpc of [direct, tunnel]) {
        const write = await whileConnecting({ objectMode: true }, () => failure(rpc.sendRawTransaction(TX_HEX)))
        expectNotSent(write, 'network', 'ERR_INVALID_ARG_VALUE')
        rpc.close()
        const read = await whileConnecting({ objectMode: true }, () => failure(rpc.getBestBlockHash()))
        expectNotSent(read, 'network', 'ERR_INVALID_ARG_VALUE')
        rpc.close()
      }
      // A stream that is no net.Socket takes another path through Node.
      const duplex = client({
        connect: () =>
          new Duplex({
            read() {},
            write(_chunk, _encoding, callback) {
              callback()
            },
          }),
      })
      const read = await whileConnecting({ objectMode: true }, () => failure(duplex.getBestBlockHash()))
      expectNotSent(read, 'network', 'ERR_INVALID_ARG_VALUE')
    })
    expect(node.requests).toHaveLength(0)
  })

  it('reports a TLS error Node throws as it opens the connection as tls, with nothing sent, and no crash', async () => {
    const direct = client()
    await direct.confirmChain()
    const tunnel = client({ connect: toNode })
    await tunnel.confirmChain()
    node.requests.length = 0
    // A context that is none: Node refuses it with its TLS code.
    tls.connect = ((options: tlsModule.ConnectionOptions) =>
      openTls({ ...options, secureContext: {} as tlsModule.SecureContext })) as typeof tls.connect
    syncBuiltinESMExports()
    try {
      await withoutCrash(async () => {
        for (const rpc of [direct, tunnel]) {
          expectRefused(await failure(rpc.sendRawTransaction(TX_HEX)), 'ERR_TLS_INVALID_CONTEXT')
          rpc.close()
          expectRefused(await failure(rpc.getBestBlockHash()), 'ERR_TLS_INVALID_CONTEXT')
        }
      })
    } finally {
      tls.connect = openTls
      syncBuiltinESMExports()
    }
    expect(node.requests).toHaveLength(0)
  })
})

describe('a throw from inside Node as it hands the request a connection', () => {
  beforeEach(() => start(true))

  // The request's timeout is the client's own. Node read it from
  // Object.prototype, after its agent had opened the connection, and threw
  // out of https.request; the request Node had built then took the
  // connection, and its TLS error or reset was thrown later, uncaught.
  it.each([false, true, 'x'])(
    'timeout %j on the prototype, not enumerable, throughout: a reply or a failure with nothing sent, never a crash',
    async value => {
      const direct = client()
      const tunnel = client({ connect: toNode })
      for (const rpc of [direct, tunnel]) await rpc.confirmChain()
      await withoutCrash(() =>
        onPrototype(
          { timeout: value },
          async () => {
            for (const rpc of [direct, tunnel]) {
              rpc.close()
              // The write first: a failed read would make the chain check run before it.
              for (const call of [() => rpc.sendRawTransaction(TX_HEX), () => rpc.getBestBlockHash()]) {
                const outcome = await call().then(
                  () => undefined,
                  (e: unknown) => e
                )
                if (outcome !== undefined) expectNotSent(outcome, 'network', 'ERR_INVALID_ARG_TYPE')
              }
            }
          },
          { enumerable: false }
        )
      )
      for (const rpc of [direct, tunnel]) rpc.close()
    }
  )

  it('timeout on the prototype, as JSON puts it there: refused before Node reads it', async () => {
    const direct = client()
    const tunnel = client({ connect: toNode })
    for (const rpc of [direct, tunnel]) await rpc.confirmChain()
    node.requests.length = 0
    await withoutCrash(() =>
      onPrototype({ timeout: false }, async () => {
        for (const rpc of [direct, tunnel]) {
          rpc.close()
          expectNotSent(await failure(rpc.getBestBlockHash()), 'prototype_polluted')
          expectNotSent(await failure(rpc.sendRawTransaction(TX_HEX)), 'prototype_polluted')
        }
      })
    )
    expect(node.requests).toHaveLength(0)
  })

  it('fails the call with nothing sent when Node throws after opening the connection, which throws nothing later', async () => {
    // Node's agent listens to the socket it opened for agentRemove last, in
    // an object of the socket's that inherits from Object.prototype: a value
    // there makes that throw out of http.request, with the socket connecting.
    // Nothing listens on this port, so its connection fails, and nothing may
    // be listening for that either.
    const closed = await new Promise<number>(resolve => {
      const server = createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        server.close(() => resolve(port))
      })
    })
    const rpc = new QbitRpcClient({
      url: `http://127.0.0.1:${closed}/`,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
    })
    await withoutCrash(async () => {
      const read = await whileConnecting({ agentRemove: 1 }, () => failure(rpc.getBestBlockHash()), {
        requests: true,
      })
      expectNotSent(read, 'network')
    }, 100)
    rpc.close()
  })
})

describe('Object.prototype with enumerable properties', () => {
  // As JSON parsed into a deep merge leaves it. Nothing in the language or in
  // Node puts an enumerable property there.
  const polluted = { pollutedByMerge: true, isAdmin: 'yes' }

  it('refuses a call that needs a chain re-check as itself, not as a failed check', async () => {
    await start(false)
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    const accepted = node.accepted
    const requests = node.requests.length
    for (const [method, call] of [
      ['sendrawtransaction', () => rpc.sendRawTransaction(TX_HEX)],
      ['getblockchaininfo', () => rpc.confirmChain()],
      ['getbestblockhash', () => rpc.getBestBlockHash()],
      ['batch(1)', () => rpc.batch([requests_.getBestBlockHash()])],
      ['batch(0)', () => rpc.batch([])],
    ] as const) {
      const error = await onPrototype(polluted, () => failure(call()))
      expectNotSent(error, 'prototype_polluted')
      expect(error).toMatchObject({ method })
      expect((error as Error).cause).toBeUndefined()
    }
    expect(node.requests).toHaveLength(requests)
    expect(node.accepted).toBe(accepted)
    expect(rpc.chainStatus).toBe('stale')
    await expect(rpc.sendRawTransaction(TX_HEX)).resolves.toBe(TX_TXID)
  })

  it('refuses it before a chain refusal, a capability refusal or a cookie read', async () => {
    await start(false)
    // Unconfirmed, and with no capability for the call.
    const rpc = client({ capabilities: [] })
    expectNotSent(await onPrototype(polluted, () => failure(rpc.sendRawTransaction(TX_HEX))), 'prototype_polluted')
    expect(node.accepted).toBe(0)
  })

  it('reports pollution that comes after the call began, during its chain re-check, the same way', async () => {
    await start(false)
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    const requests = node.requests.length
    const error = await onPrototype({}, async () => {
      const call = failure(rpc.sendRawTransaction(TX_HEX))
      ;(Object.prototype as Record<string, unknown>)['lateKey'] = 1
      try {
        return await call
      } finally {
        delete (Object.prototype as Record<string, unknown>)['lateKey']
      }
    })
    expectNotSent(error, 'prototype_polluted')
    expect(node.requests).toHaveLength(requests)
  })

  /** Refused before a connection: no TCP connection, no request, never an unknown outcome. */
  async function refused(call: () => Promise<unknown>): Promise<void> {
    const accepted = node.accepted
    const error = await onPrototype(polluted, () => failure(call()))
    expectNotSent(error, 'prototype_polluted')
    expect((error as Error).message).toBe(
      `RPC ${(error as RpcTransportError).method} not sent: Object.prototype has 2 enumerable properties, which every object inherits and Node would read as connection options; find what polluted it and remove that`
    )
    // The count, never the names, which are whatever polluted it.
    expect(JSON.stringify(error)).not.toMatch(/pollutedByMerge|isAdmin/)
    expect(node.accepted).toBe(accepted)
  }

  it.each([
    ['http', false],
    ['https', true],
  ] as const)(
    'refuses every call over %s, pooled and fresh, direct and through connect, with nothing sent',
    async (_scheme, secure) => {
      await start(secure)
      const clients = secure ? [client(), client({ connect: toNode })] : [client()]
      for (const rpc of clients) {
        // A pooled connection is open: the read would take it.
        await rpc.confirmChain()
        node.requests.length = 0
        await refused(() => rpc.getBestBlockHash())
        await refused(() => rpc.sendRawTransaction(TX_HEX))
        rpc.close()
        await refused(() => rpc.getBestBlockHash())
        expect(node.requests).toHaveLength(0)
        // Once it is gone, calls go out again.
        expect(await rpc.getBestBlockHash()).toBe(HASH_A)
        rpc.close()
      }
    }
  )

  it('does not retry the refusal, nor make the chain confirmation stale', async () => {
    await start(true)
    let calls = 0
    const rpc = client({
      readRetries: 3,
      connect: () => {
        calls += 1
        return toNode()
      },
    })
    await rpc.confirmChain()
    rpc.close()
    calls = 0
    await refused(() => rpc.getBestBlockHash())
    expect(calls).toBe(0)
    expect(rpc.chainStatus).toBe('confirmed')
  })

  it('refuses a connection that starts while it is so, through connect, before TLS runs over the stream', async () => {
    await start(true)
    let open: (() => void) | undefined
    const rpc = client({
      connect: () =>
        new Promise<Duplex>(resolve => {
          open = () => resolve(toNode())
        }),
    })
    const read = failure(rpc.getBestBlockHash())
    await expect.poll(() => open).toBeDefined()
    const error = await onPrototype(polluted, async () => {
      open!()
      return await read
    })
    expectNotSent(error, 'prototype_polluted')
    expect(node.handshakes).toBe(0)
    rpc.close()
  })

  it('refuses a connection Node opens by itself, for a request queued behind a full pool', async () => {
    await start(false)
    const answer = node.handler
    node.handler = (recorded, response) => (recorded.body.includes('"hang"') ? undefined : answer(recorded, response))
    const endpoint = parseEndpoint(node.url, undefined)
    const transport = new HttpTransport(1, undefined, {
      loopbackOnly: true,
      tls: undefined,
      connect: undefined,
      openTimeoutMs: 5000,
    })
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
      const accepted = node.accepted
      // The first gives up and its socket closes: Node opens one for the queued request.
      await onPrototype(polluted, async () => {
        first.abort()
        await expect(hung).rejects.toMatchObject({ kind: 'aborted' })
        await expect(queued).rejects.toMatchObject({ kind: 'prototype_polluted', sent: false, pollutedKeys: 2 })
      })
      expect(node.accepted).toBe(accepted)
    } finally {
      transport.close()
    }
  })

  it.each([false, true])(
    'refuses blockList and timeout before Node reads them, with no crash (https: %s)',
    async secure => {
      await start(secure)
      const rpc = client()
      // A value Node 24 takes for a socket's block list throws from every connection, uncaught.
      await withoutCrash(async () => {
        for (const values of [{ blockList: true }, { blockList: {} }, { timeout: 'x' }]) {
          expectNotSent(await onPrototype(values, () => failure(rpc.getBestBlockHash())), 'prototype_polluted')
        }
      })
      rpc.close()
    }
  )

  it('leaves a property defined not enumerable, as a polyfill does, to the calls', async () => {
    await start(true)
    const rpc = client()
    await rpc.confirmChain()
    const polyfilled = await onPrototype(
      { polyfilled: () => 'from a polyfill' },
      async () => [await rpc.getBestBlockHash(), await rpc.sendRawTransaction(TX_HEX)],
      { enumerable: false }
    )
    expect(polyfilled).toEqual([HASH_A, TX_TXID])
    rpc.close()
  })
})

describe('over http, Object.prototype lends a connection nothing', () => {
  beforeEach(() => start(false))

  it.each(Object.entries(SOCKET_OPTIONS))('%s: the option is the client’s own', async (key, value) => {
    const rpc = client()
    const seen = await whileConnecting({ [key]: value }, async seen => {
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
      return seen
    })
    expect(seen.connections).toHaveLength(1)
    expect(Object.hasOwn(seen.connections[0]!, key)).toBe(true)
    rpc.close()
  })
})

describe('a TLS session', () => {
  beforeEach(() => start(true))

  /**
   * Runs `run` with `session` on Object.prototype throughout. Node's TLS
   * server does not read it. Not enumerable, past the client's check of
   * Object.prototype, which refuses the call otherwise (see the test below).
   */
  async function withSession<T>(session: Buffer, run: () => Promise<T>): Promise<T> {
    return onPrototype({ session }, run, { enumerable: false })
  }

  it('on the prototype, as JSON puts it there, refuses the call before any connection', async () => {
    const session = await sessionFrom(pki.ca.cert)
    const rpc = client()
    const accepted = node.accepted
    const error = await onPrototype({ session }, () => failure(rpc.getBestBlockHash()))
    expectNotSent(error, 'prototype_polluted')
    expect(node.accepted).toBe(accepted)
    rpc.close()
  })

  it('on the prototype is not resumed: the handshake is verified in full, and nothing goes to an untrusted node', async () => {
    const direct = client()
    const tunnel = client({ connect: toNode })
    await direct.confirmChain()
    await tunnel.confirmChain()
    // The node now shows a certificate the client does not trust, and this session is from it.
    node.setSecureContext({ key: other.server.key, cert: other.server.cert })
    const session = await sessionFrom(other.ca.cert)
    direct.close()
    tunnel.close()
    node.requests.length = 0
    for (const rpc of [direct, tunnel]) {
      const write = await withSession(session, () => failure(rpc.sendRawTransaction(TX_HEX)))
      expectRefused(write, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
      const read = await withSession(session, () => failure(rpc.getBestBlockHash()))
      expectRefused(read, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
      rpc.close()
    }
    expect(node.requests).toHaveLength(0)
  })

  it('on the prototype changes nothing for a node the client trusts: a new session, and the checks run', async () => {
    const session = await sessionFrom(pki.ca.cert)
    const rpc = client()
    expect(await withSession(session, () => rpc.getBestBlockHash())).toBe(HASH_A)
    expect(node.requests.map(request => request.tls?.resumed)).toEqual([false])
    rpc.close()
  })

  it('that a handshake resumes, however it was offered, fails the connection before anything is sent', async () => {
    const session = await sessionFrom(pki.ca.cert)
    const direct = client()
    const tunnel = client({ connect: toNode })
    await direct.confirmChain()
    await tunnel.confirmChain()
    direct.close()
    tunnel.close()
    node.requests.length = 0
    // Below the client's options: tls.connect itself offers the session.
    tls.connect = ((options: tlsModule.ConnectionOptions) => openTls({ ...options, session })) as typeof tls.connect
    syncBuiltinESMExports()
    try {
      for (const rpc of [direct, tunnel]) {
        const write = await failure(rpc.sendRawTransaction(TX_HEX))
        expectRefused(write, 'ESESSIONRESUMED')
        const read = await failure(rpc.getBestBlockHash())
        expectRefused(read, 'ESESSIONRESUMED')
        expect(rpc.chainStatus).toBe('stale')
      }
    } finally {
      tls.connect = openTls
      syncBuiltinESMExports()
    }
    // The handshakes resumed, and no request followed them.
    expect(node.requests).toHaveLength(0)
    expect(await direct.getBestBlockHash()).toBe(HASH_A)
    expect(node.requests.map(request => request.tls?.resumed)).toEqual([false])
    direct.close()
    tunnel.close()
  })
})
