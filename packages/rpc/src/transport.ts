import * as http from 'node:http'
import * as https from 'node:https'
import type { Socket } from 'node:net'

/** Why one HTTP exchange failed, and whether the request could have reached the server. */
export class ExchangeFailure extends Error {
  readonly kind: 'network' | 'too_large' | 'aborted' | 'bad_body'
  /** False only when the request provably never left this process (no connection was made). */
  readonly sent: boolean
  readonly code?: string
  /**
   * A reset on a reused pooled socket before any reply byte, within
   * `STALE_SOCKET_WINDOW_MS` of the request going out on it: the server closed
   * the idle connection just as the request went out.
   */
  readonly staleSocket: boolean

  constructor(
    kind: 'network' | 'too_large' | 'aborted' | 'bad_body',
    sent: boolean,
    code?: string,
    staleSocket = false
  ) {
    super(`HTTP exchange failed: ${kind}`)
    this.kind = kind
    this.sent = sent
    if (code !== undefined) this.code = code
    this.staleSocket = staleSocket
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

/** POSTs JSON-RPC bodies with Node's http/https modules. */
export class HttpTransport {
  readonly #httpAgent: http.Agent
  readonly #httpsAgent: https.Agent

  /** `idleSocketTimeoutMs` closes pooled sockets idle that long; tests pass a short one. */
  constructor(idleSocketTimeoutMs = IDLE_SOCKET_TIMEOUT_MS) {
    // Node's agent destroys a socket on this timeout only while it sits in the
    // pool unused, so a slow reply is never cut (test/keep-alive.test.ts).
    const pool = { keepAlive: true, maxSockets: 8, timeout: idleSocketTimeoutMs }
    this.#httpAgent = new http.Agent(pool)
    this.#httpsAgent = new https.Agent(pool)
  }

  send(exchange: Exchange): Promise<ExchangeResult> {
    const secure = exchange.url.protocol === 'https:'
    const module = secure ? https : http
    const agent = exchange.freshConnection ? false : secure ? this.#httpsAgent : this.#httpAgent

    return new Promise<ExchangeResult>((resolve, reject) => {
      let sent = false
      let settled = false
      let reusedSocket: Socket | undefined
      /** A reply byte arrived on a reused socket: a failure from here on is not a stale socket. */
      let replied = false
      /** When the request went out on the reused socket: writing starts then, however long the body takes to flush. */
      let reusedAt = Number.POSITIVE_INFINITY
      const onData = (): void => {
        replied = true
      }
      const finish = (error: ExchangeFailure | undefined, result?: ExchangeResult): void => {
        if (settled) return
        settled = true
        exchange.signal.removeEventListener('abort', onAbort)
        reusedSocket?.removeListener('data', onData)
        if (error) reject(error)
        else resolve(result!)
      }
      const onAbort = (): void => {
        const failure = new ExchangeFailure('aborted', sent)
        finish(failure)
        request.destroy(failure)
      }

      const request = module.request(exchange.url, {
        method: 'POST',
        agent,
        headers: {
          accept: 'application/json',
          authorization: exchange.authorization,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(exchange.body),
        },
      })
      // The request counts as sent once a connection exists: a reused socket,
      // a completed TCP connect, or for TLS a completed handshake. Failures
      // before that point (refused, DNS, TLS) never reached the server.
      request.on('socket', socket => {
        if (request.reusedSocket && !settled) {
          // Notes that a reply byte came before the HTTP parser reads it: a
          // malformed first chunk makes the parser fail at once, and part of
          // a status line fails like no reply at all.
          reusedSocket = socket
          reusedAt = performance.now()
          socket.prependOnceListener('data', onData)
        }
        if (request.reusedSocket || !socket.connecting) {
          sent = true
          return
        }
        socket.once(secure ? 'secureConnect' : 'connect', () => {
          sent = true
        })
      })
      request.on('error', error => {
        if (error instanceof ExchangeFailure) {
          finish(error)
          return
        }
        // Node's "socket hang up" is ECONNRESET too. Sockets that went idle
        // together go stale together, so the rest of the pool goes as well.
        const code = (error as { code?: string }).code
        const stale =
          agent !== false &&
          reusedSocket !== undefined &&
          !replied &&
          (code === 'ECONNRESET' || code === 'EPIPE') &&
          performance.now() - reusedAt <= STALE_SOCKET_WINDOW_MS
        if (stale) closeFreeSockets(agent)
        finish(new ExchangeFailure('network', sent, code, stale))
      })
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
        response.on('error', error => finish(new ExchangeFailure('network', true, (error as { code?: string }).code)))
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
    this.#httpAgent.destroy()
    this.#httpsAgent.destroy()
  }
}

/** Each client has its own transport and one endpoint, so these are all that endpoint's idle sockets. */
function closeFreeSockets(agent: http.Agent): void {
  for (const sockets of Object.values(agent.freeSockets)) {
    for (const socket of sockets ?? []) socket.destroy()
  }
}
