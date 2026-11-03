import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

export interface RecordedRequest {
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
  /** The client side's port: equal for two requests on one keep-alive connection. */
  readonly remotePort: number | undefined
}

export interface RpcCall {
  readonly id: unknown
  readonly method: string
  readonly params: unknown[]
}

/** What a handler returns for one call: a raw JSON result text, an error, or nothing to send no item. */
export type CallReply = { result: string } | { error: { code: number; message: string } } | undefined

export type Handler = (request: RecordedRequest, response: ServerResponse) => unknown

/**
 * A loopback HTTP server standing in for qbitd. Tests install a handler per
 * scenario; every request body is recorded, so a test can assert that nothing
 * was sent.
 */
export class FakeNode {
  readonly requests: RecordedRequest[] = []
  /** Requests the server saw closed by the client before it replied. */
  closedEarly = 0
  handler: Handler = (_request, response) => {
    response.statusCode = 500
    response.end()
  }
  readonly #server: Server
  readonly #sockets = new Set<Socket>()

  private constructor(server: Server) {
    this.#server = server
    server.on('connection', socket => {
      this.#sockets.add(socket)
      socket.on('close', () => this.#sockets.delete(socket))
    })
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const recorded = {
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          remotePort: req.socket.remotePort,
        }
        this.requests.push(recorded)
        res.on('close', () => {
          if (!res.writableFinished) this.closedEarly += 1
        })
        void Promise.resolve(this.handler(recorded, res)).catch(() => res.destroy())
      })
    })
  }

  static async start(): Promise<FakeNode> {
    const server = createServer()
    // Keep Node's default: a 1 s Keep-Alive hint makes the client agent drop pooled sockets at once.
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return new FakeNode(server)
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/`
  }

  /** Answer JSON-RPC calls (single or batch) through `reply`, per call. */
  rpc(reply: (call: RpcCall) => CallReply): void {
    this.handler = (request, response) => {
      const parsed = JSON.parse(request.body) as unknown
      const one = (entry: unknown): string | undefined => {
        const call = entry as RpcCall
        const out = reply(call)
        if (out === undefined) return undefined
        const id = JSON.stringify(call.id)
        return 'result' in out
          ? `{"jsonrpc":"2.0","result":${out.result},"id":${id}}`
          : `{"jsonrpc":"2.0","error":${JSON.stringify(out.error)},"id":${id}}`
      }
      const body = Array.isArray(parsed)
        ? `[${parsed
            .map(one)
            .filter((item): item is string => item !== undefined)
            .join(',')}]`
        : (one(parsed) ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(`${body}\n`)
    }
  }

  /** Answer each method with a fixed raw JSON result text. */
  results(table: Record<string, string>): void {
    this.rpc(call =>
      Object.hasOwn(table, call.method)
        ? { result: table[call.method]! }
        : { error: { code: -32601, message: 'Method not found' } }
    )
  }

  calls(): RpcCall[] {
    return this.requests.flatMap(request => {
      const parsed = JSON.parse(request.body) as RpcCall | RpcCall[]
      return Array.isArray(parsed) ? parsed : [parsed]
    })
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }
}

/** The HTTP Basic Authorization header for `user:password`, as the client sends it. */
export const basicAuth = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)

/** A minimal valid getblockchaininfo result for `chain`. */
export function blockchainInfoJson(chain: string): string {
  return JSON.stringify({
    chain,
    blocks: 10,
    headers: 10,
    bestblockhash: HASH_A,
    bits: '207fffff',
    target: '7fffff0000000000000000000000000000000000000000000000000000000000',
    difficulty: 4.656542373906925e-10,
    time: 1700000000,
    mediantime: 1699999000,
    verificationprogress: 1,
    initialblockdownload: false,
    chainwork: '0000000000000000000000000000000000000000000000000000000000000016',
    size_on_disk: 3000,
    pruned: false,
    p2mr_validation_weight: {
      legacy_per_sigop: 3730,
      v2_per_sigop: 3683,
      activation_height: 0,
      active_for_tip: true,
      active_for_next_block: true,
      blocks_remaining: 0,
    },
    future_block_time: {
      legacy_limit_seconds: 7200,
      v2_limit_seconds: 600,
      activation_height: 0,
      active_for_tip: true,
      active_for_next_block: true,
      tip_limit_seconds: 600,
      next_block_limit_seconds: 600,
      blocks_remaining: 0,
      next_block_min_time: 1699999001,
      next_block_max_time: 1700000600,
      next_block_time_headroom_seconds: 1599,
    },
    warnings: [],
  })
}

/** A one-input, one-output non-witness transaction and its txid. */
export const TX_HEX =
  '0100000001' + 'aa'.repeat(32) + '00000000' + '00' + 'ffffffff' + '01' + '0100000000000000' + '00' + '00000000'
