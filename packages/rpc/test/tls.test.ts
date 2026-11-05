import type { ServerOptions } from 'node:https'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type * as tlsModule from 'node:tls'
import { inspect } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  QbitRpcClient,
  RpcChainGuardError,
  RpcError,
  RpcTransportError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
  type RpcTlsOptions,
} from '../src'
import { encryptedKey, issue, testPki } from './helpers/certificates'
import { chainResults, CHECK, FakeNode, HASH_A, TX_HEX, TX_TXID } from './helpers/fake-node'
import { onPrototype } from './helpers/prototype'
import { ALERT, RefusingTerminator } from './helpers/refusing-terminator'

// A TLS terminator in front of qbitd: a CA of its own, a server certificate it
// signs, and a client certificate. `other` is a second CA and its certificates,
// trusted by nobody here.
const pki = testPki()
const other = testPki('other')
const NAMES = ['localhost', 'node.test', '127.0.0.1', '::1']
/** The terminator's next certificate: the same CA and names, a new key. */
const rotated = issue({ name: 'node.test', issuer: pki.ca, altNames: NAMES })

let node: FakeNode | undefined
afterEach(async () => {
  await node?.close()
  node = undefined
})

async function terminator(tls: ServerOptions = {}): Promise<FakeNode> {
  node = await FakeNode.start({ tls: { key: pki.server.key, cert: pki.server.cert, ...tls } })
  node.results({
    ...chainResults('regtest'),
    getbestblockhash: JSON.stringify(HASH_A),
    sendrawtransaction: JSON.stringify(TX_TXID),
  })
  return node
}

/** The terminator also requires a client certificate signed by `ca`. */
const requiringClients = (ca = pki.ca.cert, tls: ServerOptions = {}): ServerOptions => ({
  requestCert: true,
  rejectUnauthorized: true,
  ca,
  ...tls,
})

/** A client of the terminator, trusting its CA unless `tls` says otherwise (undefined: the system's CAs). */
function client(
  options: Partial<Omit<QbitRpcClientOptions, 'tls'>> & { readonly tls?: RpcTlsOptions | undefined } = {}
): QbitRpcClient {
  return new QbitRpcClient({
    url: node!.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['broadcast'],
    tls: { ca: pki.ca.cert },
    retryDelayMs: 0,
    ...options,
  } as QbitRpcClientOptions)
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e
  )
}

/** A side-effecting call refused by a TLS alert after it was written: an unknown outcome, the refusal its cause. */
function expectUnknownAfterAlert(error: unknown, code: RegExp): void {
  expect(RpcUnknownOutcomeError.is(error)).toBe(true)
  expect((error as RpcUnknownOutcomeError).txid).toBe(TX_TXID)
  const cause = (error as Error).cause
  expect(RpcTransportError.is(cause)).toBe(true)
  expect(cause).toMatchObject({ reason: 'tls' })
  expect((cause as RpcTransportError).code).toMatch(code)
}

/** A definite TLS refusal: an RpcTransportError, never an unknown outcome, and `code` as given. */
function expectRefused(error: unknown, code?: string | RegExp): void {
  expect(RpcUnknownOutcomeError.is(error)).toBe(false)
  expect(RpcTransportError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason: 'tls' })
  if (code !== undefined) expect((error as RpcTransportError).code).toMatch(code)
}

/** Refused by the client's check of Object.prototype: before any connection, never an unknown outcome. */
function expectPolluted(error: unknown): void {
  expect(RpcUnknownOutcomeError.is(error)).toBe(false)
  expect(RpcTransportError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason: 'prototype_polluted' })
}

const methods = (): string[] => node!.calls().map(call => call.method)

/** A TCP relay to `target`, a port on loopback, which can change between connections: an address whose server changes. */
class Relay {
  target: number
  readonly #server: Server
  readonly #sockets = new Set<Socket>()

  private constructor(server: Server, target: number) {
    this.#server = server
    this.target = target
    server.on('connection', socket => {
      const upstream = connect(this.target, '127.0.0.1')
      for (const [from, to] of [
        [socket, upstream],
        [upstream, socket],
      ] as const) {
        this.#sockets.add(from)
        from.on('error', () => to.destroy())
        from.on('close', () => to.destroy())
        from.pipe(to)
      }
    })
  }

  static async start(target: number): Promise<Relay> {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return new Relay(server, target)
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }
}

describe('a TLS terminator that answers a JSON-RPC error itself', () => {
  /** It read the request's id, and forwarded the request before its upstream timed out. */
  const answering = (status: number): void => {
    node!.handler = (request, response) => {
      const { id } = JSON.parse(request.body) as { id: unknown }
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'upstream timeout' } }))
    }
  }

  it.each([[502], [503], [504]])('at HTTP %i is an unknown outcome for a broadcast', async status => {
    await terminator()
    const rpc = client({ capabilities: ['broadcast'] })
    await rpc.confirmChain()
    answering(status)
    const error = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(error).toMatchObject({ txid: TX_TXID })
    expect((error as Error).cause).toMatchObject({ reason: 'http_status', status })
  })

  it.each([[502], [503], [504]])('at HTTP %i is the HTTP error for a read', async status => {
    await terminator()
    const rpc = client()
    answering(status)
    const error = await failure(rpc.getBestBlockHash())
    expect(RpcTransportError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'http_status', status })
  })

  it.each([[400], [404], [500]])(
    'at HTTP %i is taken for the node’s answer, as the client cannot tell',
    async status => {
      await terminator()
      const rpc = client({ capabilities: ['broadcast'] })
      await rpc.confirmChain()
      answering(status)
      const error = await failure(rpc.sendRawTransaction(TX_HEX))
      expect(RpcError.is(error)).toBe(true)
      expect(error).toMatchObject({ rpcCode: -32603 })
    }
  )
})

describe('a node behind a TLS terminator with a private CA', () => {
  it('is reached with tls.ca, and the address in the URL is checked against the certificate', async () => {
    await terminator()
    expect(await client().getBestBlockHash()).toBe(HASH_A)
    // No SNI for an address.
    expect(node!.requests[0]!.tls).toEqual({ servername: undefined, client: undefined, resumed: false })
  })

  it('is refused, with nothing sent, under the system’s CAs or another CA', async () => {
    await terminator()
    for (const tls of [undefined, { ca: other.ca.cert }]) {
      const error = await failure(client({ tls }).getBestBlockHash())
      expectRefused(error, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
      expect((error as Error).message).toBe(
        'RPC getbestblockhash failed: the TLS handshake failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)'
      )
    }
    expect(node!.requests).toHaveLength(0)
  })

  it('is refused for an expired certificate, or one for other names', async () => {
    const day = 86_400_000
    const expired = issue({
      name: 'node.test',
      issuer: pki.ca,
      altNames: NAMES,
      notBefore: new Date(Date.now() - 2 * day),
      notAfter: new Date(Date.now() - day),
    })
    await terminator({ key: expired.key, cert: expired.cert })
    expectRefused(await failure(client().getBestBlockHash()), 'CERT_HAS_EXPIRED')
    const elsewhere = issue({ name: 'other.test', issuer: pki.ca, altNames: ['other.test'] })
    node!.setSecureContext({ key: elsewhere.key, cert: elsewhere.cert })
    expectRefused(await failure(client().getBestBlockHash()), 'ERR_TLS_CERT_ALTNAME_INVALID')
    expect(node!.requests).toHaveLength(0)
  })

  it('trusts a self-signed certificate given as its own CA', async () => {
    const self = issue({ name: 'node.test', altNames: NAMES })
    await terminator({ key: self.key, cert: self.cert })
    expect(await client({ tls: { ca: self.cert, pinSha256: self.pin } }).getBestBlockHash()).toBe(HASH_A)
  })

  it('takes a CA bundle with text between certificates, a Buffer, or an array', async () => {
    await terminator()
    const bundle = `# another CA\n${other.ca.cert}\n# ours\n${pki.ca.cert}`
    for (const ca of [bundle, Buffer.from(bundle), [other.ca.cert, Buffer.from(pki.ca.cert)]]) {
      expect(await client({ tls: { ca } }).getBestBlockHash()).toBe(HASH_A)
    }
  })

  it('refuses a side-effecting call definitely, not as an unknown outcome, when the certificate changes', async () => {
    await terminator()
    const rpc = client()
    await rpc.confirmChain()
    node!.setSecureContext({ key: other.server.key, cert: other.server.cert })
    expectRefused(await failure(rpc.sendRawTransaction(TX_HEX)), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    // It made the confirmation stale. The next guarded call checks the chain
    // first, on the pooled connection made with the old certificate, and is
    // then refused on its own new connection.
    expect(rpc.chainStatus).toBe('stale')
    expectRefused(await failure(rpc.sendRawTransaction(TX_HEX)), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    // Without that connection, the check itself is refused.
    rpc.close()
    const guarded = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(RpcChainGuardError.is(guarded) && guarded.reason).toBe('check_failed')
    expectRefused((guarded as Error).cause, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    expect(methods()).not.toContain('sendrawtransaction')
  })

  it('does not retry a TLS refusal under readRetries', async () => {
    await terminator()
    const error = await failure(client({ tls: { ca: other.ca.cert }, readRetries: 3 }).getBestBlockHash())
    expectRefused(error)
    expect(node!.accepted).toBe(1)
  })
})

describe('client certificates', () => {
  it('sends one the terminator requires, with its key plain or encrypted', async () => {
    await terminator(requiringClients())
    const { cert, key } = pki.client
    expect(await client({ tls: { ca: pki.ca.cert, cert, key } }).getBestBlockHash()).toBe(HASH_A)
    const encrypted = {
      ca: pki.ca.cert,
      cert,
      key: encryptedKey(pki.client, 'correct horse'),
      passphrase: 'correct horse',
    }
    expect(await client({ tls: encrypted }).getBestBlockHash()).toBe(HASH_A)
    expect(node!.requests.map(request => request.tls?.client)).toEqual(['qbit-rpc test client', 'qbit-rpc test client'])
  })

  it.each([
    ['TLS 1.3', 'TLSv1.3', /^ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED$/],
    ['TLS 1.2', 'TLSv1.2', undefined],
  ] as const)('refuses a missing one under %s as a TLS failure, with nothing sent', async (_name, version, code) => {
    await terminator(requiringClients(pki.ca.cert, { minVersion: version, maxVersion: version }))
    const rpc = client()
    expectRefused(await failure(rpc.getBestBlockHash()), code)
    expect(node!.requests).toHaveLength(0)
    await expect.poll(() => node!.handshakeErrors).toEqual(['ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE'])
  })

  // Node's own TLS server, like the one here, checks a client certificate
  // after the handshake and drops the connection, with no alert. That is a
  // reset after the request went out, as when a node fails while running it.
  it('fails when the terminator drops the connection over an untrusted one, an unknown outcome if side-effecting', async () => {
    await terminator(requiringClients())
    const untrusted = client({ tls: { ca: pki.ca.cert, cert: other.client.cert, key: other.client.key } })
    const read = await failure(untrusted.getBestBlockHash())
    expect(read).toMatchObject({ name: 'RpcTransportError', reason: 'network', code: 'ECONNRESET' })

    const rpc = client({ tls: { ca: pki.ca.cert, cert: pki.client.cert, key: pki.client.key } })
    await rpc.confirmChain()
    node!.setSecureContext({ key: pki.server.key, cert: pki.server.cert, ca: other.ca.cert })
    const write = await failure(rpc.sendRawTransaction(TX_HEX))
    expect(RpcUnknownOutcomeError.is(write)).toBe(true)
    expect(methods()).toEqual([...CHECK])
  })

  // Under TLS 1.3 the client finishes its handshake first and writes the
  // request; a terminator that refuses the client certificate in the
  // handshake then sends an alert. Only the terminator says it read nothing
  // after the handshake, and one could have passed the request on first, so a
  // side-effecting call is an unknown outcome, with the refusal as cause.
  // Under TLS 1.2 the alert comes before the client has finished: definite.
  it('reports a side-effecting call refused by an alert after it was written as an unknown outcome', async () => {
    await terminator()
    const strict = await FakeNode.start({ tls: { key: pki.server.key, cert: pki.server.cert, ...requiringClients() } })
    const strict12 = await FakeNode.start({
      tls: {
        key: pki.server.key,
        cert: pki.server.cert,
        ...requiringClients(pki.ca.cert, { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }),
      },
    })
    const relay = await Relay.start(node!.port)
    try {
      const rpc = client({ url: `https://127.0.0.1:${relay.port}/` })
      await rpc.confirmChain()
      // The address now leads to a terminator that requires a client certificate.
      relay.target = strict.port
      expectUnknownAfterAlert(
        await failure(rpc.sendRawTransaction(TX_HEX)),
        /^ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED$/
      )
      // The refusal made the chain stale: this call checked it again, on the pooled connection.
      const raw = await failure(rpc.call('sendrawtransaction', [TX_HEX]))
      expectUnknownAfterAlert(raw, /^ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED$/)
      relay.target = strict12.port
      expectRefused(await failure(rpc.sendRawTransaction(TX_HEX)))
      expect(methods()).toEqual([...CHECK, ...CHECK, ...CHECK])
      expect(strict.requests).toHaveLength(0)
      expect(strict12.requests).toHaveLength(0)
      expect(strict.handshakeErrors).toEqual([
        'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE',
        'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE',
      ])
    } finally {
      await relay.close()
      await strict.close()
      await strict12.close()
    }
  })
})

// A terminator built on OpenSSL, such as nginx or HAProxy, refuses a client
// certificate it does not trust with an alert, bad_certificate or unknown_ca;
// under TLS 1.3 that alert comes once the client has written its request.
// OpenSSL 3 names it ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE, OpenSSL 1.1
// ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE.
describe('a terminator refusing the client certificate with bad_certificate under TLS 1.3', () => {
  const BAD_CERTIFICATE = /^ERR_SSL_(?:SSL\/TLS|SSLV3)_ALERT_BAD_CERTIFICATE$/
  const untrustedClient = { ca: pki.ca.cert, cert: other.client.cert, key: other.client.key }
  let refusing: RefusingTerminator | undefined
  afterEach(async () => {
    await refusing?.close()
    refusing = undefined
  })

  const start = async (): Promise<RefusingTerminator> =>
    (refusing = await RefusingTerminator.start({
      key: pki.server.key,
      cert: pki.server.cert,
      description: ALERT.badCertificate,
    }))

  it('fails a read with reason tls, and does not retry it', async () => {
    const terminator = await start()
    const rpc = new QbitRpcClient({
      url: `https://127.0.0.1:${terminator.port}/`,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      tls: untrustedClient,
      readRetries: 2,
      retryDelayMs: 0,
    })
    expectRefused(await failure(rpc.getBestBlockHash()), BAD_CERTIFICATE)
    expect(terminator.connections).toBe(1)
  })

  it('reports a side-effecting call as an unknown outcome, the refusal its cause', async () => {
    await terminator()
    const terminating = await start()
    const relay = await Relay.start(node!.port)
    try {
      const rpc = client({ url: `https://127.0.0.1:${relay.port}/`, tls: untrustedClient })
      await rpc.confirmChain()
      relay.target = terminating.port
      expectUnknownAfterAlert(await failure(rpc.sendRawTransaction(TX_HEX)), BAD_CERTIFICATE)
      expect(terminating.connections).toBe(1)
      expect(methods()).toEqual([...CHECK])
    } finally {
      await relay.close()
    }
  })
})

describe('servername', () => {
  const named = issue({ name: 'node.test', issuer: pki.ca, altNames: ['node.test'] })

  it('names the certificate to check and the SNI for a URL with an address, or another name', async () => {
    await terminator({ key: named.key, cert: named.cert })
    expectRefused(await failure(client().getBestBlockHash()), 'ERR_TLS_CERT_ALTNAME_INVALID')
    expect(await client({ tls: { ca: pki.ca.cert, servername: 'node.test' } }).getBestBlockHash()).toBe(HASH_A)
    const byName = client({
      url: `https://localhost:${node!.port}/`,
      tls: { ca: pki.ca.cert, servername: 'NODE.test' },
    })
    expect(await byName.getBestBlockHash()).toBe(HASH_A)
    expect(node!.requests.map(request => request.tls?.servername)).toEqual(['node.test', 'node.test'])
  })

  it('sends the URL’s name in SNI by default', async () => {
    await terminator()
    await client({ url: `https://localhost:${node!.port}/` }).getBestBlockHash()
    expect(node!.requests[0]!.tls?.servername).toBe('localhost')
  })
})

describe('pinSha256', () => {
  it('lets a connection through when the certificate’s key matches the pin', async () => {
    await terminator()
    expect(await client({ tls: { ca: pki.ca.cert, pinSha256: pki.server.pin } }).getBestBlockHash()).toBe(HASH_A)
  })

  it('refuses another key with EPINMISMATCH, with nothing sent, though the CA signed it', async () => {
    await terminator({ key: rotated.key, cert: rotated.cert })
    const rpc = client({ tls: { ca: pki.ca.cert, pinSha256: [pki.server.pin] }, readRetries: 2 })
    const error = await failure(rpc.getBestBlockHash())
    expectRefused(error, 'EPINMISMATCH')
    expect((error as Error).message).toBe(
      "RPC getbestblockhash failed: the node's certificate matches no pinned key (EPINMISMATCH)"
    )
    expect(node!.requests).toHaveLength(0)
  })

  it('pins the node’s key, not its CA’s', async () => {
    await terminator()
    expectRefused(await failure(client({ tls: { ca: pki.ca.cert, pinSha256: pki.ca.pin } }).getBestBlockHash()))
  })

  it('takes several pins, so a key can rotate', async () => {
    await terminator()
    const both = client({ tls: { ca: pki.ca.cert, pinSha256: [rotated.pin, pki.server.pin] } })
    const before = client({ tls: { ca: pki.ca.cert, pinSha256: [pki.server.pin] } })
    expect(await both.getBestBlockHash()).toBe(HASH_A)
    expect(await before.getBestBlockHash()).toBe(HASH_A)
    node!.setSecureContext({ key: rotated.key, cert: rotated.cert })
    both.close()
    before.close()
    expect(await both.getBestBlockHash()).toBe(HASH_A)
    expectRefused(await failure(before.getBestBlockHash()), 'EPINMISMATCH')
  })

  it('is checked on every new connection, pooled and fresh, with no session resumed', async () => {
    await terminator()
    const rpc = client({ tls: { ca: pki.ca.cert, pinSha256: pki.server.pin } })
    await rpc.confirmChain()
    await rpc.getBestBlockHash()
    rpc.close()
    await rpc.getBestBlockHash()
    await rpc.sendRawTransaction(TX_HEX)
    await rpc.sendRawTransaction(TX_HEX)
    // One handshake for each of the two pooled connections and each fresh one; none resumed.
    expect(node!.handshakes).toBe(4)
    expect(node!.requests.map(request => request.tls?.resumed)).toEqual([false, false, false, false, false])

    // The terminator's key changes to one the CA signed but no pin names.
    node!.setSecureContext({ key: rotated.key, cert: rotated.cert })
    node!.requests.length = 0
    expectRefused(await failure(rpc.sendRawTransaction(TX_HEX)), 'EPINMISMATCH')
    // The pooled connection made before the change is still the pinned server's.
    expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    rpc.close()
    expectRefused(await failure(rpc.getBestBlockHash()), 'EPINMISMATCH')
    expect(methods()).toEqual(['getbestblockhash'])
  })
})

describe('the TLS context', () => {
  it('is built once per client, not for every connection, when tls sets no CA or client certificate', async () => {
    await terminator()
    const tls = createRequire(import.meta.url)('node:tls') as typeof tlsModule
    const real = tls.createSecureContext
    let built = 0
    tls.createSecureContext = options => {
      built += 1
      return real(options)
    }
    syncBuiltinESMExports()
    try {
      for (const settings of [undefined, { servername: 'node.test' }, { pinSha256: pki.server.pin }]) {
        built = 0
        // The system's CAs: every connection is refused, once it has its context.
        const rpc = client({ tls: settings })
        for (let i = 0; i < 3; i += 1) {
          expectRefused(await failure(rpc.getBestBlockHash()), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
          rpc.close()
        }
        expect(built).toBe(1)
      }
    } finally {
      tls.createSecureContext = real
      syncBuiltinESMExports()
    }
  })
})

// Node's own default, rejectUnauthorized: !NODE_TLS_REJECT_UNAUTHORIZED, would
// let a handshake through that failed its checks, and skip the pins.
describe('NODE_TLS_REJECT_UNAUTHORIZED=0', () => {
  it('turns no check off: an untrusted certificate and an unpinned key are refused, pooled and fresh', async () => {
    const saved = process.env['NODE_TLS_REJECT_UNAUTHORIZED']
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
    try {
      await terminator()
      // What a machine in the middle could show: a self-signed certificate,
      // one from a CA the client does not trust, and one the client's CA
      // signed for a key no pin names.
      const self = issue({ name: 'node.test', altNames: NAMES })
      const cases = [
        [self, 'DEPTH_ZERO_SELF_SIGNED_CERT'],
        [other.server, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
        [rotated, 'EPINMISMATCH'],
      ] as const
      for (const [{ key, cert }, code] of cases) {
        node!.setSecureContext({ key: pki.server.key, cert: pki.server.cert })
        const rpc = client({ tls: { ca: pki.ca.cert, pinSha256: pki.server.pin } })
        await rpc.confirmChain()
        node!.setSecureContext({ key, cert })
        expectRefused(await failure(rpc.sendRawTransaction(TX_HEX)), code)
        rpc.close()
        expectRefused(await failure(rpc.getBestBlockHash()), code)
      }
      expect(methods()).toEqual([...CHECK, ...CHECK, ...CHECK])
    } finally {
      if (saved === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED']
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = saved
    }
  })
})

describe('a polluted Object.prototype', () => {
  const polluted = onPrototype

  /** A client of the terminator whose options hold no tls or connect key at all, unless `extra` sets one. */
  const bare = (extra: Partial<QbitRpcClientOptions> = {}): QbitRpcClient =>
    new QbitRpcClient({ url: node!.url, auth: { username: 'u', password: 'p' }, expectedChain: 'regtest', ...extra })

  it('lends the client no tls, CA or servername: naming them is a TypeError, and leaving tls out trusts no CA there', async () => {
    await terminator()
    // The terminator's CA is private: the system's CAs do not trust it.
    await expect(polluted({ tls: { ca: pki.ca.cert } }, async () => bare())).rejects.toThrow(
      /^options\.tls is not an own enumerable property/
    )
    // A tls option that sets none of them does not take the prototype's.
    for (const tls of [
      { pinSha256: pki.server.pin },
      { servername: 'node.test' },
      { cert: pki.client.cert, key: pki.client.key },
    ]) {
      await expect(polluted({ ca: pki.ca.cert }, async () => bare({ tls }))).rejects.toThrow(
        /^tls\.ca is not an own enumerable property/
      )
    }
    await expect(
      polluted({ servername: 'other.test' }, async () => bare({ tls: { ca: pki.ca.cert } }))
    ).rejects.toThrow(/^tls\.servername is not an own enumerable property/)
    // With no tls option at all, nor does Node's context, or Node at each
    // connection: a call is refused before either reads anything, and with the
    // CA past that check (not enumerable) it is not trusted.
    expectPolluted(await polluted({ ca: pki.ca.cert }, () => failure(bare().getBestBlockHash())))
    const error = await polluted({ ca: pki.ca.cert }, () => failure(bare().getBestBlockHash()), { enumerable: false })
    expectRefused(error, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    expect(node!.requests).toHaveLength(0)
  })

  it('lends a call no servername: with tls.ca trusted, a certificate for that name is refused, and none is sent', async () => {
    await terminator()
    const rpc = bare({ tls: { ca: pki.ca.cert } })
    expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    rpc.close()
    // The CA signed it, for another name, which is on the prototype during the call.
    const elsewhere = issue({ name: 'other.test', issuer: pki.ca, altNames: ['other.test'] })
    node!.setSecureContext({ key: elsewhere.key, cert: elsewhere.cert })
    node!.requests.length = 0
    expectPolluted(await polluted({ servername: 'other.test' }, () => failure(rpc.getBestBlockHash())))
    expectRefused(
      await polluted({ servername: 'other.test' }, () => failure(rpc.getBestBlockHash()), { enumerable: false }),
      'ERR_TLS_CERT_ALTNAME_INVALID'
    )
    expect(node!.requests).toHaveLength(0)
  })

  it('lends the client no connect function: naming it is a TypeError', async () => {
    await terminator()
    const connect = (): never => {
      throw new Error('not the caller’s')
    }
    await expect(
      polluted({ connect }, async () => bare({ tls: { ca: pki.ca.cert, pinSha256: pki.server.pin } }))
    ).rejects.toThrow(/^options\.connect is not an own enumerable property/)
  })
})

describe('the name check, with Object.prototype polluted throughout the call', () => {
  // Signed by the CA the client trusts, for another identity, with no
  // subjectAltName, as a client certificate from the same private CA can be.
  // Node 22 leaves subjectaltname unset on such a certificate, and its name
  // check read the prototype's: with a matching one there, the client sent
  // the credentials to the holder of this key.
  const sanless = issue({ name: 'someone-else.example', issuer: pki.ca })
  /** The same, its subject an organization with no common name. */
  const nameless = issue({ name: 'someone-else.example', issuer: pki.ca, subject: 'organization' })

  /** A client of the terminator by address, confirmed while it shows its own certificate; then it shows `impostor`. */
  async function confirmedThen(impostor: { key: string; cert: string }, tls: RpcTlsOptions): Promise<QbitRpcClient> {
    const rpc = client({ url: `https://127.0.0.1:${node!.port}/`, tls })
    await rpc.confirmChain()
    rpc.close()
    node!.setSecureContext({ key: impostor.key, cert: impostor.cert })
    node!.requests.length = 0
    return rpc
  }

  /** A fresh connection's call, then a pooled one's, with `values` on the prototype, not enumerable: past the client's check, as pollution during a call is. */
  async function bothRefused(rpc: QbitRpcClient, values: Record<string, unknown>): Promise<void> {
    await onPrototype(
      values,
      async () => {
        expectRefused(await failure(rpc.sendRawTransaction(TX_HEX)), 'ERR_TLS_CERT_ALTNAME_INVALID')
        expectRefused(await failure(rpc.getBestBlockHash()), 'ERR_TLS_CERT_ALTNAME_INVALID')
      },
      { enumerable: false }
    )
  }

  it.each([
    ['servername', { ca: pki.ca.cert, servername: 'node.test' }, 'DNS:node.test'],
    ['an address', { ca: pki.ca.cert }, 'IP Address:127.0.0.1'],
  ] as const)(
    'refuses a certificate without subjectAltName with one on the prototype, checking %s, pooled and fresh',
    async (_checking, tls, subjectaltname) => {
      await terminator()
      await bothRefused(await confirmedThen(sanless, tls), { subjectaltname })
      expect(node!.requests).toHaveLength(0)
    }
  )

  it('refuses a certificate whose subject has no common name with one on the prototype, pooled and fresh', async () => {
    await terminator()
    await bothRefused(await confirmedThen(nameless, { ca: pki.ca.cert, servername: 'node.test' }), {
      CN: 'node.test',
    })
    expect(node!.requests).toHaveLength(0)
  })

  it('refuses such a call before any connection, with the prototype polluted as JSON does', async () => {
    await terminator()
    const rpc = await confirmedThen(sanless, { ca: pki.ca.cert, servername: 'node.test' })
    const handshakes = node!.handshakes
    await onPrototype({ subjectaltname: 'DNS:node.test' }, async () => {
      expectPolluted(await failure(rpc.sendRawTransaction(TX_HEX)))
      expectPolluted(await failure(rpc.getBestBlockHash()))
    })
    expect(node!.handshakes).toBe(handshakes)
    expect(node!.requests).toHaveLength(0)
  })
})

describe('tls options at construction', () => {
  const okKey = pki.client.key
  const okCert = pki.client.cert

  it.each<[string, unknown, RegExp]>([
    ['not an object', 'yes', /tls must be an object/],
    ['rejectUnauthorized', { rejectUnauthorized: false }, /always verified/],
    ['an unknown key', { checkServerIdentity: () => undefined }, /tls.checkServerIdentity is not a known key/],
    ['an empty CA', { ca: '' }, /tls.ca must hold at least one PEM certificate/],
    ['a CA that is no PEM', { ca: 'garbage' }, /tls.ca must hold at least one PEM certificate/],
    ['a key as CA', { ca: okKey }, /tls.ca must hold at least one PEM certificate/],
    [
      'a CA that does not parse',
      { ca: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' },
      /does not parse/,
    ],
    ['an empty CA array', { ca: [] }, /must not be an empty array/],
    ['a bad CA in an array', { ca: [pki.ca.cert, 'garbage'] }, /tls.ca\[1\] must hold/],
    ['a CA that is a number', { ca: 42 }, /tls.ca must be PEM text/],
    ['a certificate without its key', { cert: okCert }, /go together/],
    ['a key without its certificate', { key: okKey }, /go together/],
    ['another certificate’s key', { cert: okCert, key: other.client.key }, /tls.key is not the key of tls.cert/],
    ['a certificate that is no PEM', { cert: 'x', key: okKey }, /tls.cert must hold at least one PEM certificate/],
    ['a key that is no PEM', { cert: okCert, key: 'x' }, /tls.key must be a PEM private key/],
    ['a certificate as key', { cert: okCert, key: okCert }, /tls.key must be a PEM private key/],
    [
      'an encrypted key without passphrase',
      { cert: okCert, key: encryptedKey(pki.client, 'pw') },
      /give its tls.passphrase/,
    ],
    [
      'the wrong passphrase',
      { cert: okCert, key: encryptedKey(pki.client, 'pw'), passphrase: 'no' },
      /does not decrypt/,
    ],
    ['a passphrase without key', { passphrase: 'pw' }, /tls.passphrase must be a string, with tls.key/],
    ['a passphrase that is no string', { cert: okCert, key: okKey, passphrase: 1 }, /tls.passphrase must be a string/],
    ['an empty servername', { servername: '' }, /tls.servername must be a DNS host name/],
    ['an address as servername', { servername: '127.0.0.1' }, /not an address/],
    ['an IPv6 address as servername', { servername: '::1' }, /not an address/],
    ['a servername with a space', { servername: 'node test' }, /DNS host name/],
    ['a servername over 253 characters', { servername: `${'a'.repeat(63)}.`.repeat(4) + 'aa' }, /DNS host name/],
    ['an empty pin list', { pinSha256: [] }, /a pin or a non-empty array of pins/],
    ['an empty pin', { pinSha256: '' }, /tls.pinSha256 must be the base64 SHA-256/],
    ['a short pin', { pinSha256: 'abc=' }, /tls.pinSha256 must be the base64 SHA-256/],
    ['a base64url pin', { pinSha256: `${'-'.repeat(43)}=` }, /tls.pinSha256 must be the base64 SHA-256/],
    ['an unpadded pin', { pinSha256: pki.server.pin.slice(0, 43) }, /tls.pinSha256 must be/],
    ['a pin of 33 bytes', { pinSha256: Buffer.alloc(33).toString('base64') }, /tls.pinSha256 must be/],
    ['a pin not in canonical form', { pinSha256: `${'A'.repeat(42)}B=` }, /tls.pinSha256 must be/],
    ['a sha256/ prefix', { pinSha256: `sha256/${pki.server.pin}` }, /tls.pinSha256 must be/],
    ['a pin that is no string', { pinSha256: [pki.server.pin, 1] }, /tls.pinSha256\[1\] must be/],
  ])('refuses %s with a TypeError', (_name, tls, message) => {
    const create = (): QbitRpcClient =>
      new QbitRpcClient({
        url: 'https://node.test/',
        auth: { username: 'u', password: 'p' },
        expectedChain: 'main',
        tls: tls as never,
      })
    expect(create).toThrow(TypeError)
    expect(create).toThrow(message)
  })

  it('refuses tls for an http url', () => {
    expect(
      () =>
        new QbitRpcClient({
          url: 'http://127.0.0.1:8332/',
          auth: { username: 'u', password: 'p' },
          expectedChain: 'main',
          tls: { ca: pki.ca.cert },
        })
    ).toThrow(/tls needs an https url/)
  })

  it('returns copies from toJSON, so changing one changes no later toJSON or inspect', async () => {
    await terminator()
    const rpc = client({
      capabilities: ['broadcast'],
      tls: { ca: pki.ca.cert, pinSha256: pki.server.pin, servername: 'node.test' },
    })
    const before = JSON.stringify(rpc.toJSON())
    const inspected = inspect(rpc)
    const changed = rpc.toJSON() as {
      capabilities: string[]
      tls: { ca: string; clientCertificate: boolean; pinSha256?: string[]; servername?: string }
    }
    expect(changed.tls.pinSha256).toEqual([pki.server.pin])
    changed.tls.pinSha256!.push('another')
    changed.tls.pinSha256![0] = 'another'
    changed.tls.ca = 'system'
    changed.tls.clientCertificate = true
    delete changed.tls.servername
    changed.capabilities.push('wallet-write')
    expect(JSON.stringify(rpc.toJSON())).toBe(before)
    expect(inspect(rpc)).toBe(inspected)
    delete (rpc.toJSON() as { tls?: unknown }).tls
    expect(JSON.stringify(rpc.toJSON())).toBe(before)
  })

  it('shows what is set in toJSON and inspect, and no key material or passphrase anywhere', async () => {
    await terminator(requiringClients())
    const passphrase = 'passphrase-7f3e9a'
    const key = encryptedKey(pki.client, passphrase)
    const rpc = client({
      tls: {
        ca: pki.ca.cert,
        cert: pki.client.cert,
        key,
        passphrase,
        pinSha256: pki.server.pin,
        servername: 'node.test',
      },
    })
    expect(JSON.parse(JSON.stringify(rpc)).tls).toEqual({
      ca: 'custom',
      clientCertificate: true,
      servername: 'node.test',
      pinSha256: [pki.server.pin],
    })
    expect(JSON.parse(JSON.stringify(client())).tls).toEqual({ ca: 'custom', clientCertificate: false })
    expect(JSON.parse(JSON.stringify(client({ tls: undefined })))).not.toHaveProperty('tls')
    const plainKey = pki.client.key.split('\n')[1]!
    const encryptedPart = key.split('\n')[1]!
    const wrong = (() => {
      try {
        return client({ tls: { ca: pki.ca.cert, cert: pki.client.cert, key, passphrase: 'not-it-0c4d' } })
      } catch (error) {
        return error
      }
    })()
    expect(wrong).toBeInstanceOf(TypeError)
    node!.setSecureContext({ key: rotated.key, cert: rotated.cert, ca: pki.ca.cert })
    const refused = await failure(rpc.getBestBlockHash())
    for (const value of [rpc, wrong, refused]) {
      for (const text of [
        inspect(value, { showHidden: true, depth: Infinity, getters: true }),
        JSON.stringify(value) ?? '',
        String(value),
      ]) {
        for (const secret of [passphrase, 'not-it-0c4d', plainKey, encryptedPart]) expect(text).not.toContain(secret)
      }
    }
  })
})
