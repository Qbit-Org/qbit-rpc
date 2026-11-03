import * as http from 'node:http'
import * as https from 'node:https'

/** Why one HTTP exchange failed, and whether the request could have reached the server. */
export class ExchangeFailure extends Error {
  readonly kind: 'network' | 'too_large' | 'aborted' | 'bad_body'
  /** False only when the request provably never left this process (no connection was made). */
  readonly sent: boolean
  readonly code?: string

  constructor(kind: 'network' | 'too_large' | 'aborted' | 'bad_body', sent: boolean, code?: string) {
    super(`HTTP exchange failed: ${kind}`)
    this.kind = kind
    this.sent = sent
    if (code !== undefined) this.code = code
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

/** POSTs JSON-RPC bodies with Node's http/https modules. */
export class HttpTransport {
  readonly #httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 })
  readonly #httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 })

  send(exchange: Exchange): Promise<ExchangeResult> {
    const secure = exchange.url.protocol === 'https:'
    const module = secure ? https : http
    const agent = exchange.freshConnection ? false : secure ? this.#httpsAgent : this.#httpAgent

    return new Promise<ExchangeResult>((resolve, reject) => {
      let sent = false
      let settled = false
      const finish = (error: ExchangeFailure | undefined, result?: ExchangeResult): void => {
        if (settled) return
        settled = true
        exchange.signal.removeEventListener('abort', onAbort)
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
        if (request.reusedSocket || !socket.connecting) {
          sent = true
          return
        }
        socket.once(secure ? 'secureConnect' : 'connect', () => {
          sent = true
        })
      })
      request.on('error', error => {
        finish(
          error instanceof ExchangeFailure
            ? error
            : new ExchangeFailure('network', sent, (error as { code?: string }).code)
        )
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
