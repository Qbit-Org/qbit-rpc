import { createHash, X509Certificate } from 'node:crypto'
import * as dns from 'node:dns'
import type { EventEmitter } from 'node:events'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import { Duplex } from 'node:stream'
import * as tls from 'node:tls'

import { codeOf, isLoopbackAddress, type RpcConnect, type TlsSettings } from './endpoint'
import { ownProperties, ownValue } from './own'

/**
 * Why one HTTP exchange failed, and whether the request could have reached the server.
 * `not_loopback` and `prototype_polluted` are refusals before a connection was
 * made: never sent. `tls` is one too, unless a TLS alert came once the request
 * was written.
 */
export type ExchangeFailureKind =
  'network' | 'tls' | 'not_loopback' | 'prototype_polluted' | 'too_large' | 'aborted' | 'bad_body'

/** Why one HTTP exchange failed, and whether the request could have reached the server. */
export class ExchangeFailure extends Error {
  readonly kind: ExchangeFailureKind
  /** False only when the request provably never left this process (no connection was made). */
  readonly sent: boolean
  readonly code?: string
  /**
   * A reset on a reused pooled socket before any reply byte, within
   * `STALE_SOCKET_WINDOW_MS` of the request going out on it: the server closed
   * the idle connection just as the request went out.
   */
  readonly staleSocket: boolean
  /** For `prototype_polluted`: how many enumerable properties Object.prototype had. */
  readonly pollutedKeys?: number

  constructor(kind: ExchangeFailureKind, sent: boolean, code?: string, staleSocket = false, pollutedKeys?: number) {
    super(`HTTP exchange failed: ${kind}`)
    this.kind = kind
    this.sent = sent
    if (code !== undefined) this.code = code
    this.staleSocket = staleSocket
    if (pollutedKeys !== undefined) this.pollutedKeys = pollutedKeys
  }
}

export interface Exchange {
  readonly url: URL
  readonly authorization: string
  readonly body: string
  readonly signal: AbortSignal
  readonly maxResponseBytes: number
  /** Use a new connection that closes after the reply, instead of a pooled keep-alive socket. */
  readonly freshConnection: boolean
}

export interface ExchangeResult {
  readonly status: number
  readonly body: string
}

/** How the transport opens its connections, pooled and fresh alike. */
export interface Connection {
  /**
   * Connect to loopback addresses only: a host name must resolve to loopback
   * addresses alone, checked on every connection, so the address checked is
   * the one connected to. An address in the URL was checked at construction.
   */
  readonly loopbackOnly: boolean
  /** For https: what the handshake trusts and checks. Undefined: Node's defaults. */
  readonly tls: TlsSettings | undefined
  /** Opens the stream TLS runs over, for https only; undefined to connect to the URL's host directly. */
  readonly connect: RpcConnect | undefined
  /**
   * How long a pooled connection through `connect` may go on opening, from
   * when it started, once no request waits for it: the client's `timeoutMs`.
   */
  readonly openTimeoutMs: number
}

const DIRECT: Connection = { loopbackOnly: false, tls: undefined, connect: undefined, openTimeoutMs: 30_000 }

const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * How long a pooled keep-alive socket may stay idle before the client closes
 * it: half of qbitd's default `-rpcservertimeout` (30 s), so qbitd rarely
 * closes one first.
 */
const IDLE_SOCKET_TIMEOUT_MS = 15_000

/**
 * How long after a request went out on a reused socket a reset still counts
 * as the server's idle close crossing it. That reset comes back within a round
 * trip, so a second also allows for a busy event loop here; a later one is the
 * node failing during the request, such as a crash in a heavy read. Too short
 * a bound only costs a plain connection error, as if this did not exist.
 */
export const STALE_SOCKET_WINDOW_MS = 1_000

/**
 * TLS alerts a server sends when it refuses the handshake, such as a client
 * certificate missing or not trusted, as Node names OpenSSL's reasons:
 * `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`, and the SSL 3.0 alerts with
 * `SSL/TLS` under OpenSSL 3 (`ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE`) where
 * OpenSSL 1.1 said `SSLV3`. Under TLS 1.3 the server checks the client's
 * certificate after the client has finished its side, so the alert can
 * arrive once the request was written.
 */
const HANDSHAKE_REFUSAL =
  /^ERR_SSL_(?:SSLV3|SSL\/TLS|TLSV1|TLSV13)_ALERT_(?:HANDSHAKE_FAILURE|BAD_CERTIFICATE|UNSUPPORTED_CERTIFICATE|CERTIFICATE_(?:REVOKED|EXPIRED|UNKNOWN|REQUIRED)|UNKNOWN_CA|ACCESS_DENIED|DECRYPT_ERROR)$/

/** Socket errors during a TLS handshake that are the connection failing, not TLS refusing it. */
const SOCKET_ERRORS: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
])

/** `keys`, each an own property holding undefined. */
function unset(keys: readonly string[]): object {
  return Object.fromEntries(keys.map(key => [key, undefined]))
}

/**
 * The options Node reads when it opens a connection and the client leaves
 * unset, own and undefined. Node copies the options into an object that
 * inherits from Object.prototype, so a key left out, or an object without a
 * prototype, would read what a polluted Object.prototype holds: a session to
 * resume, or a path, a lookup or a stream to connect through. `tls.connect` has
 * defaults of its own for `minDHSize` and `ciphers`, so they are not listed.
 * This is every key Node 22.13 and 24 read through Object.prototype from these
 * options and the copies Node makes of them, in lib/_tls_wrap.js
 * (`tls.connect` and `TLSSocket`), lib/net.js (`Socket`, `connect` and
 * `lookupAndConnect`), lib/events.js and lib/internal/streams, found by
 * watching every name their source uses on Object.prototype while connections
 * open, carry requests and fail. The objects Node builds itself (the options
 * of the socket under a TLS socket, the socket and its stream state, the peer
 * certificate) still read Object.prototype, which this cannot reach: see
 * {@link prototypePollution}.
 */
const UNSET_CONNECTION_OPTIONS = unset([
  // tls.connect, and the options it gives TLSSocket.
  'ALPNProtocols',
  'allowHalfOpen',
  'enableTrace',
  'highWaterMark',
  'isServer',
  'keepAlive',
  'keepAliveInitialDelay',
  'noDelay',
  'onread',
  'path',
  'pskCallback',
  'requestOCSP',
  'session',
  'signal',
  'socket',
  'timeout',
  // Socket.prototype.connect and lookupAndConnect.
  'autoSelectFamily',
  'autoSelectFamilyAttemptTimeout',
  'family',
  'hints',
  'host',
  'localAddress',
  'localPort',
  'lookup',
  'port',
  // net.connect's new Socket, the Duplex under it, and its EventEmitter.
  'blockList',
  'captureRejections',
  'construct',
  'defaultEncoding',
  'destroy',
  'destroyOnReturn',
  'encoding',
  'fd',
  'final',
  'handle',
  'manualStart',
  'objectMode',
  'pauseOnCreate',
  'read',
  'readable',
  'readableHighWaterMark',
  'readableObjectMode',
  'typeOfService',
  'writable',
  'writableHighWaterMark',
  'writableObjectMode',
  'write',
  'writev',
])

/**
 * The same for `http.request` and `https.request`: Node 22 copies an https
 * request's options into an object that inherits from Object.prototype, where
 * `agent: false` alone would replace the client's connections with Node's own.
 * `send` sets `timeout` itself.
 */
const UNSET_REQUEST_OPTIONS = unset([
  'auth',
  'defaultPort',
  'highWaterMark',
  'httpValidation',
  'insecureHTTPParser',
  'joinDuplicateHeaders',
  'maxHeaderSize',
  'setDefaultHeaders',
  'setHost',
  'signal',
  'socketPath',
  'uniqueHeaders',
])

/** The same for `dns.lookup`, which `loopbackLookup` calls with Node's options and `all`. */
const UNSET_LOOKUP_OPTIONS = unset(['family', 'hints', 'order', 'verbatim'])

/**
 * How many enumerable properties Object.prototype has of its own: none, unless
 * something polluted it. JSON parsed into a deep merge that follows
 * `__proto__`, and an assignment through a path such as `a.__proto__.b`, add
 * enumerable ones; a polyfill defines its methods non-enumerable, as the
 * language's own are. With one there, every object reads it where it has no
 * key of its own, and Node reads options, stream state and certificate fields
 * from objects it builds itself, so the client refuses to open a connection or
 * send a request (`prototype_polluted`). The own-key lists above, and the
 * certificate copy in `tlsOptions`, still hold for pollution that comes later,
 * during a handshake, or non-enumerable.
 */
export function prototypePollution(): number {
  let count = 0
  for (const key of Reflect.ownKeys(Object.prototype)) {
    if (Object.getOwnPropertyDescriptor(Object.prototype, key)?.enumerable === true) count += 1
  }
  return count
}

/** What a connection being opened knows of the request it serves. */
interface Served {
  /** Fires when the request needs a connection no more. */
  readonly signal: AbortSignal
  /** Tells the request that the connection failed: it has no other, so nothing of it was sent. */
  fail(error: Error): void
}

/** What `send` hands Node for one request, read while Node opens a connection for it, before `request` returns. */
interface Handing {
  /**
   * Aborted once no connection is needed for this request: it has one, its
   * exchange ended or gave up, or Node threw before returning it. Its signal is
   * what a connection being opened knows of the request (see #tunnel).
   */
  readonly waiting: AbortController
  /** The request, to a pooled connection being opened: `waiting`'s signal, and what fails it. */
  readonly served: Served
  /** The request Node built, from the agent's `addRequest`. */
  request: http.ClientRequest | undefined
  /** The connections opened for it directly, before `request` returned. */
  readonly opened: Duplex[]
}

/** What makes an object an agent to Node's request: its request is handed to `addRequest`. */
type AddRequest = (request: http.ClientRequest, options: http.ClientRequestArgs) => void

/** POSTs JSON-RPC bodies with Node's http/https modules. */
export class HttpTransport {
  readonly #httpAgent: http.Agent
  readonly #httpsAgent: https.Agent
  readonly #connection: Connection
  readonly #poolSize: number
  /** The pool's connections being opened through `connect`: at most the pool's size at once. */
  readonly #pooledTurns: Turns
  /**
   * Side-effecting calls' connections being opened through `connect`, as many
   * again: such a call never waits behind the pool's connections.
   */
  readonly #freshTurns: Turns
  /** What gives up each pooled connection still opening that no request waits for, oldest first. */
  readonly #abandoned = new Set<() => void>()
  /** Each pooled request's `Handing.served`, for a connection Node opens by itself for a queued one. */
  readonly #served = new WeakMap<object, Served>()
  /** Aborted by `close()`: gives up the pool's connections still being opened. */
  #lifetime = new AbortController()
  /** While `send` hands a request to Node: see {@link Handing}. */
  #handing: Handing | undefined
  /**
   * Connections opened through `connect` for a read that gave up before they
   * were ready, each with what takes it out: the pool's next connection is one
   * of them, oldest first.
   */
  readonly #parked = new Map<tls.TLSSocket, () => void>()
  /** Taken from the parked set, and on no request yet: it sat idle as a free socket does, which Node does not know. */
  readonly #unparked = new WeakSet<Duplex>()
  readonly #idleSocketTimeoutMs: number
  /** The TLS context of a connection without `tls.ca` or `tls.cert`: Node's defaults, built once rather than per connection. */
  #defaultContext: tls.SecureContext | undefined

  /**
   * `maxSockets` caps each pool (the client passes its `maxConcurrentRequests` plus one spare),
   * and the connections being opened through `connect`, the pool's and fresh ones each;
   * `idleSocketTimeoutMs` closes pooled sockets idle that long, and tests pass a short one.
   * `connection` says how every connection is opened and checked.
   */
  constructor(maxSockets: number, idleSocketTimeoutMs = IDLE_SOCKET_TIMEOUT_MS, connection: Connection = DIRECT) {
    // Node's agent destroys a socket on this timeout only while it sits in the
    // pool unused, so a slow reply is never cut (test/keep-alive.test.ts).
    const pool = { keepAlive: true, maxSockets, timeout: idleSocketTimeoutMs }
    this.#connection = connection
    this.#poolSize = maxSockets
    this.#pooledTurns = new Turns(maxSockets)
    this.#freshTurns = new Turns(maxSockets)
    this.#idleSocketTimeoutMs = idleSocketTimeoutMs
    this.#httpAgent = new http.Agent(pool)
    this.#httpsAgent = new https.Agent(pool)
    // Every pooled connection is opened as a fresh one is, with the same
    // checks, and the https agent caches no TLS session: Node skips the
    // certificate checks on a resumed one. Nothing of one exchange travels in
    // the options: Node opens a connection for a request queued behind a
    // closed one with the closed one's options.
    this.#httpAgent.createConnection = (options, callback) => this.#open(false, options, undefined, callback!)
    this.#httpsAgent.createConnection = (options, callback) => this.#open(true, options, undefined, callback!)
    // The request Node is building, which `send` has not got yet: if building
    // it throws, `send` discards it (see Handing).
    for (const agent of [this.#httpAgent, this.#httpsAgent] as (http.Agent & { addRequest: AddRequest })[]) {
      const addRequest = agent.addRequest.bind(agent)
      agent.addRequest = (request, options) => {
        if (this.#handing !== undefined) {
          this.#handing.request = request
          this.#served.set(request, this.#handing.served)
        }
        addRequest(request, options)
      }
    }
  }

  send(exchange: Exchange): Promise<ExchangeResult> {
    // Before Node reads anything: with Object.prototype polluted, it would read options from it.
    const polluted = prototypePollution()
    if (polluted > 0)
      return Promise.reject(new ExchangeFailure('prototype_polluted', false, undefined, false, polluted))
    if (exchange.signal.aborted) return Promise.reject(new ExchangeFailure('aborted', false))
    const secure = exchange.url.protocol === 'https:'
    const module = secure ? https : http
    const agent = exchange.freshConnection ? undefined : secure ? this.#httpsAgent : this.#httpAgent
    // Without an agent, Node opens the connection through createConnection,
    // sends `Connection: close`, and closes it after the reply: it is this
    // exchange's own, opened under its signal.
    const connection =
      agent === undefined
        ? {
            agent: undefined,
            defaultPort: secure ? 443 : 80,
            createConnection: (options: http.ClientRequestArgs, callback: Callback) =>
              this.#open(secure, options, exchange.signal, callback),
          }
        : { agent }

    return new Promise<ExchangeResult>((resolve, reject) => {
      const waiting = new AbortController()
      const handing: Handing = {
        waiting,
        served: {
          signal: waiting.signal,
          // No socket reports this to a queued request; destroyed, a free socket passes it over, so it is never written.
          fail: error => {
            onError(error)
            request.destroy(error)
          },
        },
        request: undefined,
        opened: [],
      }
      let sent = false
      let settled = false
      /** A new TLS connection is connected and in its handshake: a failure now is TLS's, unless the socket's. */
      let handshaking = false
      let socket: Duplex | undefined
      let reusedSocket: Duplex | undefined
      /** A reply byte arrived: a failure from here on is neither a stale socket nor a refused handshake. */
      let replied = false
      /** When the request went out on the reused socket: writing starts then, however long the body takes to flush. */
      let reusedAt = Number.POSITIVE_INFINITY
      const onData = (): void => {
        replied = true
      }
      const finish = (error: Error | undefined, result?: ExchangeResult): void => {
        if (settled) return
        settled = true
        handing.waiting.abort()
        exchange.signal.removeEventListener('abort', onAbort)
        socket?.removeListener('data', onData)
        if (error) reject(error)
        else resolve(result!)
      }
      const onAbort = (): void => {
        const failure = new ExchangeFailure('aborted', sent)
        finish(failure)
        request.destroy(failure)
      }

      // The agent opens a connection for the request before `request`
      // returns, or queues the request.
      this.#handing = handing
      let request: http.ClientRequest
      try {
        request = module.request(exchange.url, {
          ...UNSET_REQUEST_OPTIONS,
          // Over the URL's own, so only when it names none.
          port: exchange.url.port === '' ? undefined : Number(exchange.url.port),
          method: 'POST',
          // Own, so Node's request and agent read none from Object.prototype:
          // the pool's idle timeout, which its agent applies anyway, or none.
          timeout: agent === undefined ? 0 : this.#idleSocketTimeoutMs,
          ...connection,
          headers: {
            accept: 'application/json',
            authorization: exchange.authorization,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(exchange.body),
          },
        })
      } catch (error) {
        // Nothing was written: a request is written by `end` below. What Node
        // opened for it is discarded, and a connection being opened through
        // `connect` goes to the pool (see #tunnel).
        handing.waiting.abort()
        if (handing.request !== undefined) discard(handing.request)
        handing.opened.forEach(discard)
        reject(new ExchangeFailure(thrownKind(error), false, codeOf(error)))
        return
      } finally {
        this.#handing = undefined
      }
      // The request counts as sent once a connection exists: a reused socket,
      // a completed TCP connect, or for TLS a completed handshake with every
      // check passed. One through `connect` arrives that far already. Failures
      // before that point (refused, DNS, the loopback check, TLS) never
      // reached the server.
      request.on('socket', assigned => {
        handing.waiting.abort()
        const idled = this.#unparked.delete(assigned) || request.reusedSocket
        if (!settled) {
          // Notes that a reply byte came before the HTTP parser reads it: a
          // malformed first chunk makes the parser fail at once, and part of
          // a status line fails like no reply at all.
          socket = assigned
          assigned.prependOnceListener('data', onData)
          if (idled) {
            reusedSocket = assigned
            reusedAt = performance.now()
          }
        }
        const connecting = (assigned as net.Socket).connecting === true
        if (request.reusedSocket || !connecting) {
          sent = true
          return
        }
        if (secure) {
          assigned.once('connect', () => {
            handshaking = true
          })
        }
        assigned.once(secure ? 'secureConnect' : 'connect', () => {
          // Not when the session check just refused it: nothing was written.
          if (!assigned.destroyed) sent = true
        })
      })
      const onError = (error: Error): void => {
        if (error instanceof ExchangeFailure || error instanceof ConnectMisuse) {
          finish(error)
          return
        }
        if (error instanceof ConnectFailure) {
          finish(new ExchangeFailure(error.kind, false, error.code))
          return
        }
        if (error instanceof NotLoopback) {
          finish(new ExchangeFailure('not_loopback', false))
          return
        }
        if (error instanceof PrototypePolluted) {
          finish(new ExchangeFailure('prototype_polluted', false, undefined, false, error.keys))
          return
        }
        const code = codeOf(error)
        // The handshake or a check failed before anything was written.
        if (
          !sent &&
          (error instanceof PinMismatch || error instanceof SessionResumed || (handshaking && !isSocketError(code)))
        ) {
          finish(new ExchangeFailure('tls', false, code))
          return
        }
        // An alert refusing the handshake once the request was written, as
        // under TLS 1.3 for a client certificate. Only the peer says it read
        // nothing, and it may have passed the request on: still sent.
        if (secure && !request.reusedSocket && !replied && code !== undefined && HANDSHAKE_REFUSAL.test(code)) {
          finish(new ExchangeFailure('tls', sent, code))
          return
        }
        // Node's "socket hang up" is ECONNRESET too. Sockets that went idle
        // together go stale together, so the rest of the pool goes as well.
        const stale =
          agent !== undefined &&
          reusedSocket !== undefined &&
          !replied &&
          (code === 'ECONNRESET' || code === 'EPIPE') &&
          performance.now() - reusedAt <= STALE_SOCKET_WINDOW_MS
        if (stale) {
          closeFreeSockets(agent)
          this.#dropParked()
        }
        finish(new ExchangeFailure('network', sent, code, stale))
      }
      request.on('error', onError)
      request.on('response', response => {
        sent = true
        const declared = Number(response.headers['content-length'])
        if (Number.isFinite(declared) && declared > exchange.maxResponseBytes) {
          finish(new ExchangeFailure('too_large', true))
          request.destroy()
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        response.on('data', (chunk: Buffer) => {
          received += chunk.byteLength
          if (received > exchange.maxResponseBytes) {
            finish(new ExchangeFailure('too_large', true))
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('error', error => finish(new ExchangeFailure('network', true, codeOf(error))))
        response.on('close', () => {
          if (!response.complete) finish(new ExchangeFailure('network', true, 'ECONNRESET'))
        })
        response.on('end', () => {
          if (!response.complete) {
            finish(new ExchangeFailure('network', true, 'ECONNRESET'))
            return
          }
          let body: string
          try {
            body = decoder.decode(Buffer.concat(chunks, received))
          } catch {
            finish(new ExchangeFailure('bad_body', true))
            return
          }
          finish(undefined, { status: response.statusCode ?? 0, body })
        })
      })

      if (exchange.signal.aborted) {
        onAbort()
        return
      }
      exchange.signal.addEventListener('abort', onAbort, { once: true })
      request.end(exchange.body)
    })
  }

  close(): void {
    // Replaced first: a read queued behind one this gives up opens a connection under the new one.
    const lifetime = this.#lifetime
    this.#lifetime = new AbortController()
    lifetime.abort()
    this.#dropParked()
    this.#httpAgent.destroy()
    this.#httpsAgent.destroy()
  }

  /**
   * Open one connection for Node's request `options` (its host and port). A
   * direct one is returned at once, as Node's own agent does, so the pool
   * counts it while it connects: Node holds the request until it is
   * connected and, for https, past the handshake, the certificate and name
   * checks and the pins, and `send` sorts out what failed. One through
   * `connect` goes to `callback` once it is that far; see `#tunnel`.
   * `signal` is a fresh connection's exchange's; undefined for the pool's.
   * Node's agent and request call this in places that do not expect a throw,
   * so what Node refuses to open fails the connection instead.
   */
  #open(
    secure: boolean,
    options: http.ClientRequestArgs,
    signal: AbortSignal | undefined,
    callback: Callback
  ): Duplex | undefined {
    const fail = callback as (error: Error) => void
    // Also for one Node opens by itself, for a request queued behind a full pool.
    const polluted = prototypePollution()
    if (polluted > 0) {
      fail(new PrototypePolluted(polluted))
      return undefined
    }
    // Own keys only. Node's agent passes the pool's idle timeout and TCP keep-alive on to its own connect.
    const own = ownProperties(options) as {
      host?: string
      port?: number | string
      timeout?: number
      keepAlive?: boolean
      keepAliveInitialDelay?: number
    }
    const { timeout, keepAlive, keepAliveInitialDelay } = own
    const host = own.host ?? 'localhost'
    const port = Number(own.port)
    const { connect, loopbackOnly } = this.#connection
    if (connect !== undefined) {
      if (signal !== undefined) {
        this.#tunnel(connect, host, port, false, { signal, fail }, callback)
        return undefined
      }
      // Node opens one by itself for the oldest request queued, which may have given up.
      const serves = this.#handing?.served ?? this.#oldestQueued()
      if (serves === undefined) {
        fail(new ConnectFailure('network', undefined))
        return undefined
      }
      const parked = this.#unpark()
      if (parked !== undefined) {
        this.#handing?.opened.push(parked)
        return parked
      }
      // A pooled one outlives the read it is opened for: see #tunnel.
      this.#tunnel(connect, host, port, true, serves, callback)
      return undefined
    }
    const base = {
      ...UNSET_CONNECTION_OPTIONS,
      host,
      port,
      ...(loopbackOnly && net.isIP(host) === 0 ? { lookup: loopbackLookup } : {}),
      ...(timeout === undefined ? {} : { timeout }),
      ...(keepAlive === undefined ? {} : { keepAlive }),
      ...(keepAliveInitialDelay === undefined ? {} : { keepAliveInitialDelay }),
    }
    let opened: Duplex
    try {
      opened = secure ? secureConnection({ ...base, ...this.#tlsOptions(host) }) : net.connect(base)
    } catch (error) {
      fail(new ConnectFailure(thrownKind(error), codeOf(error)))
      return undefined
    }
    this.#handing?.opened.push(opened)
    return opened
  }

  /** The options of a TLS connection to `host`. */
  #tlsOptions(host: string): tls.ConnectionOptions {
    const settings = this.#connection.tls
    // No prototype: Node reads every option it knows from this object, `ca` among them.
    const secureContext =
      settings?.secureContext ??
      (this.#defaultContext ??= tls.createSecureContext(Object.create(null) as tls.SecureContextOptions))
    return tlsOptions(settings, secureContext, host)
  }

  /**
   * Open a connection over the stream `connect` returns, and hand it to
   * `callback` once it can carry a request: past the TLS handshake and its
   * checks. Nothing is written to it before. A failure before that point is a
   * ConnectFailure, or a ConnectMisuse for a stream that breaks the contract.
   *
   * Node's agent counts such a connection only once it is handed over, so at
   * most the pool's size of them are opened at once, from the `connect` call
   * until it has returned or settled and the connection is handed over or
   * given up; another one waits for its turn. Fresh connections take their
   * turns apart from the pool's, so a side-effecting call waits behind no
   * pooled connection. A fresh connection is given up when its exchange's
   * signal, `serves.signal`, fires: waiting, opening or in its handshake, and
   * `connect` is told through its own signal.
   *
   * A pooled connection outlives the read it is opened for. `serves` is that
   * read's `Handing.served`, set synchronously in `send`, never through the
   * agent's options, or, for one Node opens by itself, that of the oldest
   * request queued behind a full pool, as Node does not say which it is for.
   * When that request needs it no more, it serves the next one queued, which
   * Node gives it to, and when there is none, no request waits for it: the one
   * thing all of what follows turns on. Not yet dialled, it is dropped. Else it
   * goes on opening, so that a proxy slower than a read's deadline still serves
   * later reads, keeps no process alive, and once ready waits, idle, for the
   * pool's next connection (see #park). It is given up on `close()`, once the
   * client's `timeoutMs` from when it started has passed, and as soon as a
   * connection that a request waits for needs its turn: the newest goes first,
   * as the oldest is the nearest to opening.
   *
   * Its failure goes to the request it serves by then, or to none, and never
   * through `callback`: Node's agent fails the request it picked when it opened
   * the connection, which by now may be in flight on another socket or gone. One
   * `send` asked for tells only the read it was opened for: once that one gave
   * up, the one queued it serves waits for any socket, and Node never counted
   * this one, so it takes the next free one instead. One Node opened by itself
   * stood in for a socket that closed, so when it fails, the next one queued
   * opens its own, as after a socket that fails: nothing else may ever wake
   * that one.
   */
  #tunnel(connect: RpcConnect, host: string, port: number, pooled: boolean, serves: Served, callback: Callback): void {
    const turns = pooled ? this.#pooledTurns : this.#freshTurns
    const stop = pooled ? this.#lifetime.signal : serves.signal
    /** Node opened it by itself: `send` is not handing it a request. */
    const unasked = pooled && this.#handing === undefined
    const started = performance.now()
    /** Cleared once it is used, like `serving`: the connection's listeners keep this scope alive, and these reach the request. */
    let deliver: Callback | undefined = callback
    /** The request this connection serves. Undefined: no request waits for it. */
    let serving: Served | undefined = serves
    /** The request it was opened for gave up. A flag, not a comparison with `serves`: this scope must not keep it. */
    let moved = false
    let settled = false
    /** This connection holds one of the turns. */
    let holding = false
    /** `connect` has been called. */
    let dialled = false
    /** `connect` has been called and has not returned or settled. */
    let calling = false
    let secured: tls.TLSSocket | undefined
    /** The stream, once a TLS socket runs over it. */
    let stream: Duplex | undefined
    /** An error the stream emitted before it was taken. */
    let early: Error | undefined
    let withdraw = (): void => {}
    let timer: NodeJS.Timeout | undefined
    const given = new AbortController()
    const onError = (error: Error): void => finish(classify(error))
    const onReady = (): void => {
      // Refused by the session check, in the same event: its error comes next.
      if (!secured!.destroyed) finish(undefined)
    }
    const giveUp = (): void => finish(new ConnectFailure('network', undefined))
    // Closed in the handshake, with no error to say so.
    const onClose = (): void => finish(new ConnectFailure('network', 'ECONNRESET'))
    const onServedGone = (): void => {
      moved = true
      serving = this.#oldestQueued()
      if (serving !== undefined) {
        serving.signal.addEventListener('abort', onServedGone, { once: true })
        return
      }
      const left = started + this.#connection.openTimeoutMs - performance.now()
      if (!dialled || turns.contended || left <= 0) {
        giveUp()
        return
      }
      secured?.unref()
      this.#abandoned.add(giveUp)
      // Unref'd: it bounds this connection, and keeps no process alive.
      timer = setTimeout(giveUp, left).unref()
    }
    const release = (): void => {
      if (!holding || calling || !settled) return
      holding = false
      turns.release()
    }
    const finish = (error: Error | undefined): void => {
      if (settled) return
      settled = true
      stop.removeEventListener('abort', giveUp)
      clearTimeout(timer)
      this.#abandoned.delete(giveUp)
      serving?.signal.removeEventListener('abort', onServedGone)
      withdraw()
      secured
        ?.removeListener('error', onError)
        .removeListener('secureConnect', onReady)
        .removeListener('close', onClose)
      stream?.removeListener('close', onClose)
      const served = serving
      const delivering = deliver!
      deliver = undefined
      serving = undefined
      if (error === undefined) {
        if (served !== undefined) hand(delivering, secured!)
        else this.#park(secured!)
      } else {
        given.abort()
        if (secured !== undefined) discard(secured)
        stream?.destroy()
      }
      release()
      if (error === undefined || served === undefined) return
      // Not its own read's: one queued, which a free socket serves as well.
      if (!unasked && moved) return
      served.fail(error)
      if (!unasked) return
      const next = this.#oldestQueued()
      if (next !== undefined) this.#tunnel(connect, host, port, true, next, delivering)
    }
    /**
     * Hands the connection over. Node's agent runs its own code in `callback`:
     * a throw there fails the connection, still unwritten, as Node writes to it
     * in a later tick.
     */
    const hand = (delivering: Callback, connection: tls.TLSSocket): void => {
      try {
        delivering(null, connection)
      } catch (error) {
        connection.destroy(new ConnectFailure(thrownKind(error), codeOf(error)))
      }
    }
    // The stream failing is the connection failing, before hand-over and
    // after, when it reaches the request through the TLS socket.
    const onStreamError = (error: Error): void => {
      if (stream === undefined) early ??= error
      else if (settled) secured?.destroy(error)
      else finish(new ConnectFailure('network', codeOf(error)))
    }
    const take = (opened: unknown): void => {
      calling = false
      const fresh = opened instanceof Duplex && !returned.has(opened)
      // Before anything else: a stream that is failing would throw its error.
      if (fresh && !opened.listeners('error').includes(onStreamError)) opened.on('error', onStreamError)
      // Failing, with its error still to come or come already: the connection failed.
      const failed = fresh ? (early ?? opened.errored ?? undefined) : undefined
      if (!fresh || (opened.destroyed && failed === undefined)) {
        finish(new ConnectMisuse('connect must return a new, open stream.Duplex for every connection'))
        release()
        return
      }
      returned.add(opened)
      if (settled) {
        opened.destroy()
        release()
        return
      }
      if (failed !== undefined) {
        opened.destroy()
        finish(new ConnectFailure('network', codeOf(failed)))
        return
      }
      const polluted = prototypePollution()
      if (polluted > 0) {
        opened.destroy()
        finish(new PrototypePolluted(polluted))
        return
      }
      // Node's TLS socket listens to the stream as it is built. If building it
      // throws, the half-built one's listeners are removed, as they would throw
      // on the stream's next event, and the caller's and onStreamError stay.
      const before = listenersOf(opened)
      try {
        secured = secureConnection({ ...UNSET_CONNECTION_OPTIONS, socket: opened, ...this.#tlsOptions(host) })
      } catch (error) {
        removeAdded(opened, before)
        opened.destroy()
        finish(new ConnectFailure(thrownKind(error), codeOf(error)))
        return
      }
      stream = opened
      if (serving === undefined) secured.unref()
      secured.once('close', () => opened.destroy())
      secured.on('error', onError)
      secured.once('secureConnect', onReady)
      secured.once('close', onClose)
      opened.once('close', onClose)
    }
    const dial = (): void => {
      holding = true
      // Always in a microtask, wherever the turn came from. An async `connect`
      // can return a stream already failing, whose error comes in a tick, and
      // after an event callback Node runs ticks before microtasks: the error
      // would come before `take` listens. From a microtask, `take` comes first.
      queueMicrotask(() => {
        if (settled) {
          release()
          return
        }
        // One parked while this one waited for its turn: no need to open another.
        const parked = pooled ? this.#unpark() : undefined
        if (parked !== undefined) {
          secured = parked
          finish(undefined)
          return
        }
        dialled = true
        calling = true
        let opening: Duplex | Promise<Duplex>
        try {
          opening = connect({ host, port, signal: given.signal })
        } catch (error) {
          calling = false
          finish(new ConnectFailure('network', codeOf(error)))
          return
        }
        // A stream returned at once can fail before the promise below settles:
        // without a listener now, its error would be thrown.
        if (opening instanceof Duplex && !returned.has(opening)) opening.on('error', onStreamError)
        Promise.resolve(opening).then(take, (error: unknown) => {
          calling = false
          finish(new ConnectFailure('network', codeOf(error)))
          release()
        })
      })
    }
    if (stop.aborted) {
      process.nextTick(giveUp)
      return
    }
    stop.addEventListener('abort', giveUp, { once: true })
    withdraw = turns.take(dial)
    if (pooled) {
      serves.signal.addEventListener('abort', onServedGone, { once: true })
      if (!holding) [...this.#abandoned].at(-1)?.()
    }
  }

  /** The oldest request queued in Node's pool that still waits; Node passes a connection over any that gave up. */
  #oldestQueued(): Served | undefined {
    for (const queue of Object.values(this.#httpsAgent.requests)) {
      for (const request of queue ?? []) {
        const served = this.#served.get(request)
        if (served?.signal.aborted === false) return served
      }
    }
    return undefined
  }

  /**
   * Keep a connection whose read gave up for the pool's next connection, for as
   * long as a pooled one may stay idle. At most the pool's size are kept. It is
   * unref'd already, since no request waits for it, as Node's agent does for its
   * free sockets, and `#unpark` refs it. This is
   * a second pool because Node's agent takes a socket only from a request it
   * has carried: a connection handed to a request that gave up is destroyed on
   * Node 22, and no documented API puts one in the agent's free list.
   */
  #park(secured: tls.TLSSocket): void {
    if (this.#parked.size >= this.#poolSize) {
      discard(secured)
      return
    }
    const drop = (): void => {
      take()
      discard(secured)
    }
    const take = (): void => {
      this.#parked.delete(secured)
      secured.setTimeout(0).removeListener('timeout', drop).removeListener('error', drop).removeListener('close', drop)
    }
    secured.setTimeout(this.#idleSocketTimeoutMs).on('timeout', drop).on('error', drop).on('close', drop)
    this.#parked.set(secured, take)
  }

  /** The oldest parked connection that can still carry a request, taken out; undefined when there is none. */
  #unpark(): tls.TLSSocket | undefined {
    for (const [secured, take] of this.#parked) {
      take()
      if (secured.writable) {
        this.#unparked.add(secured)
        return secured.ref()
      }
      discard(secured)
    }
    return undefined
  }

  #dropParked(): void {
    for (const [parked, take] of this.#parked) {
      take()
      discard(parked)
    }
  }
}

/**
 * Connections being opened through `connect`, each from the call until it has
 * returned or settled and the connection is handed over or given up: at most
 * `max` at once, and the rest wait for their turn, oldest first.
 */
class Turns {
  readonly #max: number
  #taken = 0
  readonly #waiting = new Set<() => void>()

  constructor(max: number) {
    this.#max = max
  }

  /** Something waits for a turn. */
  get contended(): boolean {
    return this.#waiting.size > 0
  }

  /** Run `start` once a turn is free; the function returned withdraws from the wait. */
  take(start: () => void): () => void {
    const next = (): void => {
      this.#taken += 1
      start()
    }
    if (this.#taken < this.#max) {
      next()
      return () => {}
    }
    this.#waiting.add(next)
    return () => this.#waiting.delete(next)
  }

  /** One connection is no longer being opened: the oldest one waiting goes next. */
  release(): void {
    this.#taken -= 1
    const [next] = this.#waiting
    if (next === undefined) return
    this.#waiting.delete(next)
    next()
  }
}

/** Node's `createConnection` callback: an error alone, or the connection. */
type Callback = (error: Error | null, socket: Duplex) => void

/** A connection failed before it was handed over: nothing was sent on it. */
class ConnectFailure extends Error {
  constructor(
    readonly kind: 'network' | 'tls',
    readonly code: string | undefined
  ) {
    super(`connection failed: ${kind}`)
  }
}

/** A `connect` function returned no new stream: a programming error, a TypeError for the caller, and nothing sent. */
class ConnectMisuse extends TypeError {}

/** The lookup found an address that is not loopback for a host that may only be loopback. */
class NotLoopback extends Error {}

/** Object.prototype has enumerable properties: no connection is opened (see prototypePollution). */
class PrototypePolluted extends Error {
  constructor(readonly keys: number) {
    super(`Object.prototype has ${keys} enumerable properties`)
  }
}

/** The certificate's public key matches no pin. */
class PinMismatch extends Error {
  readonly code = 'EPINMISMATCH'
}

/** A handshake resumed a TLS session, which the client never offers. */
class SessionResumed extends Error {
  readonly code = 'ESESSIONRESUMED'
}

/** Streams a `connect` function has returned: every connection needs a new one. */
const returned = new WeakSet<Duplex>()

/** What a failure of the TLS socket over a `connect` stream, before hand-over, was. */
function classify(error: Error): ConnectFailure {
  const code = codeOf(error)
  return new ConnectFailure(
    error instanceof PinMismatch || error instanceof SessionResumed || !isSocketError(code) ? 'tls' : 'network',
    code
  )
}

/** A socket error during a TLS handshake is the connection failing, not TLS refusing it. */
function isSocketError(code: string | undefined): boolean {
  return code !== undefined && SOCKET_ERRORS.has(code)
}

/**
 * What a synchronous throw from Node, as it opens a connection, was: TLS's for
 * Node's TLS and SSL errors and OpenSSL's, and else the socket's, such as an
 * option Node's socket refuses.
 */
function thrownKind(error: unknown): 'tls' | 'network' {
  const code = codeOf(error)
  return code !== undefined && /^ERR_(?:TLS|SSL|OSSL)_/.test(code) ? 'tls' : 'network'
}

/** Discards what was opened or built: whatever it still reports changes nothing. */
function discard(target: EventEmitter & { destroy(): unknown }): void {
  target.on('error', () => {})
  target.destroy()
}

/** Each event's listeners on `emitter`, once-wrappers as they are. */
function listenersOf(emitter: EventEmitter): Map<string | symbol, unknown[]> {
  return new Map(emitter.eventNames().map(name => [name, emitter.rawListeners(name)]))
}

/** Removes the listeners added to `emitter` since `before` was taken, and only those. */
function removeAdded(emitter: EventEmitter, before: ReadonlyMap<string | symbol, unknown[]>): void {
  for (const name of emitter.eventNames()) {
    const kept = [...(before.get(name) ?? [])]
    for (const listener of emitter.rawListeners(name)) {
      const index = kept.indexOf(listener)
      if (index === -1) emitter.removeListener(name, listener as (...args: unknown[]) => void)
      else kept.splice(index, 1)
    }
  }
}

/**
 * A TLS connection that fails if it resumes a session. Node skips the identity
 * check, the pins with it, on a resumed session, and takes the CA check's result
 * from the session. This listener comes first, and the request is not written
 * until after the event.
 */
function secureConnection(options: tls.ConnectionOptions): tls.TLSSocket {
  const secured = tls.connect(options)
  secured.once('secureConnect', () => {
    if (secured.isSessionReused()) secured.destroy(new SessionResumed('the handshake resumed a TLS session'))
  })
  return secured
}

/**
 * The options every TLS connection takes. Verification stays on, set here
 * rather than left to Node's default, which `NODE_TLS_REJECT_UNAUTHORIZED=0`
 * turns off, and with it the identity check and the pins. SNI carries a name
 * only, and the identity check and the pins run on every connection: none
 * resumes a session.
 */
function tlsOptions(
  settings: TlsSettings | undefined,
  secureContext: tls.SecureContext,
  host: string
): tls.ConnectionOptions {
  const name = settings?.servername ?? host
  const pins = settings?.pins
  return {
    secureContext,
    rejectUnauthorized: true,
    // Empty for an address, which SNI does not carry.
    servername: net.isIP(name) === 0 ? name : '',
    checkServerIdentity: (_hostname, certificate) => {
      const error = tls.checkServerIdentity(name, identityOf(certificate))
      if (error !== undefined || pins === undefined) return error
      const raw = ownValue(certificate, 'raw')
      const pin = Buffer.isBuffer(raw) ? spkiSha256(raw) : undefined
      return pin !== undefined && pins.has(pin) ? undefined : new PinMismatch('the certificate matches no pin')
    },
  }
}

/**
 * What `tls.checkServerIdentity` reads of the node's certificate, from its own
 * properties only, in objects without a prototype: Node 22 leaves
 * `subjectaltname` unset on a certificate without one, where it would read a
 * polluted Object.prototype's. Node's matching rules (wildcards, the common
 * name when there is no DNS name, addresses) apply as they are.
 */
function identityOf(certificate: tls.PeerCertificate): tls.PeerCertificate {
  const subject = ownValue(certificate, 'subject')
  return Object.assign(Object.create(null) as tls.PeerCertificate, {
    subject: typeof subject === 'object' && subject !== null ? ownProperties(subject) : undefined,
    subjectaltname: ownValue(certificate, 'subjectaltname'),
  })
}

/** The base64 SHA-256 of a DER certificate's SubjectPublicKeyInfo, or undefined if it does not parse. */
function spkiSha256(der: Buffer): string | undefined {
  try {
    const spki = new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(spki).digest('base64')
  } catch {
    return undefined
  }
}

/**
 * A `lookup` for a host that may only be loopback: it resolves the name as
 * Node would, and fails unless every address is loopback, so a name that
 * resolves partly elsewhere is refused whole. Node connects to the addresses
 * it returns, with no second lookup.
 */
const loopbackLookup: net.LookupFunction = (hostname, options, callback) => {
  // Node's `all` is own when it wants every address, in an object of its own that inherits from Object.prototype.
  const all = ownValue(options, 'all') === true
  dns.lookup(hostname, { ...UNSET_LOOKUP_OPTIONS, ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '')
      return
    }
    if (addresses.length === 0 || !addresses.every(({ address }) => isLoopbackAddress(address))) {
      callback(new NotLoopback(`${hostname} resolved to an address that is not loopback`), '')
      return
    }
    if (all) callback(null, addresses)
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  })
}

/** Each client has its own transport and one endpoint, so these are all that endpoint's idle sockets. */
function closeFreeSockets(agent: http.Agent): void {
  for (const sockets of Object.values(agent.freeSockets)) {
    for (const socket of sockets ?? []) socket.destroy()
  }
}
