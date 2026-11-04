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
  /** How long the connection sat idle before this request; undefined for its first. */
  readonly idleMs: number | undefined
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
  /** When each keep-alive connection went idle, and its idle-close timer. */
  readonly #idle = new Map<Socket, { readonly since: number; readonly timer: NodeJS.Timeout | undefined }>()
  #idleCloseMs: number | undefined

  private constructor(server: Server) {
    this.#server = server
    server.on('connection', socket => {
      this.#sockets.add(socket)
      socket.on('close', () => {
        this.#sockets.delete(socket)
        clearTimeout(this.#idle.get(socket)?.timer)
        this.#idle.delete(socket)
      })
    })
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const idle = this.#idle.get(req.socket)
      clearTimeout(idle?.timer)
      this.#idle.delete(req.socket)
      const idleMs = idle === undefined ? undefined : performance.now() - idle.since
      res.on('finish', () => this.#markIdle(req.socket))
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const recorded = {
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          remotePort: req.socket.remotePort,
          idleMs,
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

  /** Connections open now. */
  get connections(): number {
    return this.#sockets.size
  }

  /**
   * Close a keep-alive connection once it has been idle for `ms`, as qbitd
   * does after `-rpcservertimeout`, and drop the Keep-Alive hint Node's server
   * adds: qbitd sends none, and the client's agent would act on it.
   */
  closeIdleAfter(ms: number): void {
    this.#idleCloseMs = ms
    this.#server.keepAliveTimeout = 0
  }

  #markIdle(socket: Socket): void {
    if (socket.destroyed) return
    const ms = this.#idleCloseMs
    const timer = ms === undefined ? undefined : setTimeout(() => socket.destroy(), ms)
    this.#idle.set(socket, { since: performance.now(), timer })
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

/**
 * Each chain's genesis block hash, as `getblockhash 0` reports it: the hashes
 * qbit Core v1.0.0 asserts in src/kernel/chainparams.cpp. Written out here
 * rather than taken from the client, so the tests check its table.
 */
export const GENESIS: Readonly<Record<string, string>> = {
  main: '0000000000004d60aa5d46013991d0a0e2995d89ee98e53068ae196d763e79f2',
  test: '0000c20791706c6940a43d75db44d1ae9dadeb637cedfbaa5cf293435eeaab3c',
  testnet4: '000000000000796fe86bbc0bf1b66a07e4b4c0676f74b54cf7e5ce8b3f1a0090',
  signet: '0000000a5698c727f05cbdaeaff3e48b48ab187aeb03414e783ea81fed14d65c',
  regtest: '0ee96aa77c4b600850e349344fa21b107e805f5370ddc7a6189db12cf69acce6',
}

/** The calls of one chain check, in the order the client batches them. */
export const CHECK = ['getblockchaininfo', 'getblockhash'] as const

/** `FakeNode.results()` entries that answer a chain check as a node on `chain` with that chain's genesis block. */
export function chainResults(chain: string, genesis = GENESIS[chain]!): Record<string, string> {
  return { getblockchaininfo: blockchainInfoJson(chain), getblockhash: JSON.stringify(genesis) }
}

/**
 * A minimal valid getblockchaininfo result for `chain`. A signet reports
 * `signetChallenge`, by default the default signet's `51`; null leaves it out.
 */
export function blockchainInfoJson(
  chain: string,
  signetChallenge: string | null = chain === 'signet' ? '51' : null
): string {
  return JSON.stringify({
    ...(signetChallenge === null ? {} : { signet_challenge: signetChallenge }),
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
