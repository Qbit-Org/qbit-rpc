import { checkZmqAddress } from './address'
import {
  parseZmqMessage,
  SequenceTracker,
  ZMQ_TOPICS,
  ZmqFrameError,
  type SequenceGap,
  type ZmqMessage,
  type ZmqTopic,
} from './parser'

/** The part of a ZeroMQ SUB socket the subscriber uses. `zeromq`'s `Subscriber` satisfies it. */
export interface ZmqSocket {
  connect(url: string): void
  subscribe(topic: string): void
  receive(): Promise<readonly Uint8Array[]>
  close(): void
  /**
   * Socket events (`zeromq`'s observer). When present, a `disconnect` makes
   * the subscriber replace the socket: libzmq does not reconnect after it
   * drops a peer for an oversized message, and messages published while
   * disconnected are lost.
   */
  readonly events?: { on(type: 'disconnect', listener: () => void): unknown }
}

export interface ZmqSocketSettings {
  /** Largest inbound message part, in bytes; libzmq disconnects a peer that sends more. */
  readonly maxMessageSize: number
  /**
   * Enable IPv6. libzmq cannot reach an IPv6 address without it, and with it
   * resolves a host name to IPv6 first, so `localhost` would miss a publisher
   * on 127.0.0.1. The subscriber sets it only for an IPv6 address, as qbitd
   * does for its publisher. Default false.
   */
  readonly ipv6?: boolean
}

/** Makes a socket; a custom factory should apply `settings` itself. */
export type ZmqSocketFactory = (settings: ZmqSocketSettings) => ZmqSocket | Promise<ZmqSocket>

/** qbit Core's `MAX_BLOCK_SERIALIZED_SIZE` (equal to `MAX_BLOCK_WEIGHT`, as there is no witness discount). */
const MAX_BLOCK_BYTES = 2_000_000

/**
 * The default `maxMessageSize`: the largest block qbitd can publish on
 * `rawblock`, plus 64 KiB of headroom.
 */
export const DEFAULT_MAX_MESSAGE_SIZE = MAX_BLOCK_BYTES + 65_536

/** The default `staleAfterMs`: ten minutes, about ten block intervals. */
export const DEFAULT_STALE_AFTER_MS = 600_000

export interface QbitZmqSubscriberOptions {
  /**
   * The publisher address: `tcp://<host>:<port>`, with an IPv4 address, a
   * bracketed IPv6 address or a host name and a port from 1 to 65535 (for
   * example `tcp://127.0.0.1:28332` or `tcp://[::1]:28332`), or
   * `ipc://<path>` (for example `ipc:///run/qbitd/zmq.sock`). The constructor
   * throws a `TypeError` for anything else.
   */
  readonly url: string
  /** Topics to subscribe to; each must be one qbitd publishes at `url`. */
  readonly topics: readonly ZmqTopic[]
  /** Wait before replacing a failed or disconnected socket. Default 1,000 ms. */
  readonly reconnectDelayMs?: number
  /**
   * `health()` reports `stale` once this long has passed since the last
   * message, on the monotonic clock (`performance.now()`). Pick it from the
   * topic's expected rate: blocks arrive about once a minute, so `hashblock`
   * alone needs several minutes. Default 600,000 ms.
   */
  readonly staleAfterMs?: number
  /**
   * Largest inbound message part, in bytes. A larger one makes libzmq drop the
   * connection, which the subscriber reports as a `reconnect`. Default
   * 2,065,536: qbit Core's 2,000,000-byte block limit plus 64 KiB, enough for
   * `rawblock`.
   */
  readonly maxMessageSize?: number
  /**
   * Socket source. Default: {@link createZeromqSocket}, loaded on first use.
   * It receives `{ maxMessageSize, ipv6 }`, with `ipv6` true when the url's
   * host is an IPv6 address, and should apply both. A factory can throw a
   * {@link ZmqSetupError} to end the iteration instead of being retried.
   */
  readonly socketFactory?: ZmqSocketFactory
}

/**
 * The `code` of a `reconnect` event: the code of the error that a socket call
 * failed with, passed on as it is. The subscriber adds none of its own, so this
 * lists what `zeromq` and libzmq raise from the calls it makes on a SUB socket,
 * and stays open for anything else, such as a custom `socketFactory`'s error.
 * The package README says what each means.
 */
export type ZmqReconnectCode =
  | 'EAGAIN'
  | 'EBADF'
  | 'EBUSY'
  | 'EFAULT'
  | 'EINTR'
  | 'EINVAL'
  | 'EMFILE'
  | 'EMTHREAD'
  | 'ENOTSOCK'
  | 'ETERM'
  | (string & {})

/** What the subscriber yields. */
export type ZmqEvent =
  | {
      readonly kind: 'message'
      readonly message: ZmqMessage
      /**
       * Local receipt time (`Date.now()`), not a node timestamp: a wall-clock
       * time for display. `health()` measures age on the monotonic clock.
       */
      readonly receivedAt: number
    }
  | ({ readonly kind: 'gap' } & SequenceGap)
  | { readonly kind: 'malformed'; readonly error: ZmqFrameError }
  | {
      readonly kind: 'reconnect'
      readonly attempt: number
      /**
       * `disconnected`: the connection to the publisher dropped (qbitd stopped
       * or restarted, or sent a message over `maxMessageSize`). `failed`:
       * making, connecting or receiving on the socket failed, other than with
       * a {@link ZmqSetupError}.
       */
      readonly reason: 'disconnected' | 'failed'
      /** For `failed`, the code of the error the socket call failed with, when it had one. */
      readonly code?: ZmqReconnectCode
    }

/**
 * - `unknown`: no message has arrived since the subscriber (re)connected, or
 *   the connection has just dropped. Silence is not health: qbitd may be down,
 *   the address wrong, or the topic not enabled.
 * - `receiving`: a message arrived on the current socket within
 *   `staleAfterMs`.
 * - `stale`: the last message is older than `staleAfterMs`, on the monotonic
 *   clock.
 * - `closed`: `close()` was called, or the iteration ended with a
 *   {@link ZmqSetupError}.
 */
export type ZmqHealthStatus = 'unknown' | 'receiving' | 'stale' | 'closed'

export interface ZmqHealth {
  readonly status: ZmqHealthStatus
  /**
   * Local receipt time (`Date.now()`) of the last valid message, if any: a
   * wall-clock time for display. Staleness is measured on the monotonic clock
   * instead, so after a step in the wall clock `Date.now() - lastMessageAt`
   * is not the message's age.
   */
  readonly lastMessageAt?: number
  readonly messages: number
  readonly gaps: number
  readonly malformed: number
  readonly reconnects: number
}

/**
 * Why a {@link ZmqSetupError} was thrown:
 *
 * - `module_load`: the `zeromq` module or its native addon could not be
 *   loaded, or a custom `socketFactory` threw one of Node's module-load errors
 *   (`MODULE_NOT_FOUND`, `ERR_MODULE_NOT_FOUND`, `ERR_DLOPEN_FAILED`).
 * - `invalid_address`: the socket's `connect()` refused the url with `EINVAL`,
 *   or with `ENAMETOOLONG` for an `ipc://` path too long for a Unix socket.
 * - `unsupported_protocol`: `connect()` failed with `EPROTONOSUPPORT`: this
 *   libzmq does not support the url's transport.
 */
export type ZmqSetupErrorCode = 'module_load' | 'invalid_address' | 'unsupported_protocol'

/**
 * The subscriber cannot work as configured, and retrying will not help. The
 * iteration throws it instead of yielding a `reconnect`, and the subscriber is
 * closed. `cause` is the original error, when there was one.
 */
export class ZmqSetupError extends Error {
  readonly code: ZmqSetupErrorCode

  constructor(code: ZmqSetupErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ZmqSetupError'
    this.code = code
  }

  /**
   * Whether `value` is a `ZmqSetupError` from any copy of this package. A
   * `Symbol.for` brand is shared across the CommonJS and ESM builds, where
   * `instanceof` sees two classes.
   */
  static is(value: unknown): value is ZmqSetupError {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SETUP_ERROR_BRAND] === true
  }
}
const SETUP_ERROR_BRAND = Symbol.for('qbit-zmq.ZmqSetupError')
Object.defineProperty(ZmqSetupError.prototype, SETUP_ERROR_BRAND, { value: true })

/**
 * A `zeromq` `Subscriber` with `settings` applied. `zeromq` loads lazily, so
 * the parser works without the native addon; a failure to load it is a
 * {@link ZmqSetupError}.
 */
export async function createZeromqSocket(
  settings: ZmqSocketSettings = { maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE }
): Promise<ZmqSocket> {
  let zeromq: { Subscriber?: new () => ZmqSocket & { maxMessageSize: number; ipv6: boolean } }
  try {
    zeromq = (await import('zeromq')) as unknown as typeof zeromq
  } catch (error) {
    throw new ZmqSetupError(
      'module_load',
      `Could not load the zeromq module or its native addon (${errorSummary(error)}): install the zeromq dependency with the prebuilt addon for this platform, or build it from source`,
      { cause: error }
    )
  }
  if (typeof zeromq.Subscriber !== 'function') {
    throw new ZmqSetupError('module_load', 'The zeromq module has no Subscriber export: install zeromq 6')
  }
  const socket = new zeromq.Subscriber()
  socket.maxMessageSize = settings.maxMessageSize
  if (settings.ipv6 === true) socket.ipv6 = true
  return socket
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function errorSummary(error: unknown): string {
  const code = errorCode(error)
  const message = error instanceof Error ? error.message : String(error)
  return code === undefined ? message : `${code}: ${message}`
}

/** Node's errors for a module, or a native addon, that cannot be found or loaded. */
const MODULE_LOAD_CODES: ReadonlySet<string> = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_DLOPEN_FAILED',
])

/** The failure as a {@link ZmqSetupError} if retrying cannot fix it, else `undefined`. */
function setupError(error: unknown, step: 'create' | 'connect' | 'receive', url: string): ZmqSetupError | undefined {
  if (ZmqSetupError.is(error)) return error
  const code = errorCode(error)
  if (step === 'create' && code !== undefined && MODULE_LOAD_CODES.has(code)) {
    return new ZmqSetupError(
      'module_load',
      `The socket factory could not load a module (${errorSummary(error)}): install it, with its native addon for this platform`,
      { cause: error }
    )
  }
  if (step !== 'connect') return undefined
  if (code === 'EINVAL' || code === 'ENAMETOOLONG') {
    const fix = code === 'EINVAL' ? 'fix the url' : 'use a shorter ipc:// path'
    return new ZmqSetupError('invalid_address', `connect() refused ${url} (${errorSummary(error)}): ${fix}`, {
      cause: error,
    })
  }
  if (code === 'EPROTONOSUPPORT') {
    return new ZmqSetupError(
      'unsupported_protocol',
      `connect() does not support the transport of ${url} (${errorSummary(error)}): use one this libzmq supports, such as tcp://`,
      { cause: error }
    )
  }
  return undefined
}

/**
 * Subscribes to qbitd's ZMQ notifications and yields parsed messages, gaps in
 * each topic's sequence counter, malformed messages and socket replacements.
 * The socket is replaced when a receive fails or the connection drops.
 * Counters are tracked across replacements, and the first message on each
 * topic after one is always reported as a gap, since messages published
 * meanwhile are lost and a restarted qbitd's counter can happen to line up.
 * A gap is the signal to reconcile over RPC (for blocks, `getbestblockhash`
 * and walk back with `getblockheader`): ZMQ is a wake-up, not a ledger.
 * A failure that retrying cannot fix (a `zeromq` module that does not load,
 * an address `connect()` refuses) ends the iteration with a
 * {@link ZmqSetupError} instead.
 *
 * One consumer at a time: iterate it with `for await`.
 */
export class QbitZmqSubscriber implements AsyncIterable<ZmqEvent> {
  readonly #url: string
  readonly #topics: readonly ZmqTopic[]
  readonly #reconnectDelayMs: number
  readonly #staleAfterMs: number
  readonly #maxMessageSize: number
  readonly #ipv6: boolean
  readonly #socketFactory: ZmqSocketFactory
  readonly #tracker = new SequenceTracker()
  #socket: ZmqSocket | undefined
  #closed = false
  #running = false
  #wake: (() => void) | undefined
  #lastMessageAt: number | undefined
  /** `performance.now()` at the last valid message: the age `health()` compares with `staleAfterMs`. */
  #lastMessageTick: number | undefined
  #receivedOnSocket = false
  #counts = { messages: 0, gaps: 0, malformed: 0, reconnects: 0 }

  constructor(options: QbitZmqSubscriberOptions) {
    if (typeof options !== 'object' || options === null) throw new TypeError('options must be an object')
    const { ipv6 } = checkZmqAddress(options.url)
    const topics = options.topics
    if (!Array.isArray(topics) || topics.length === 0) throw new TypeError('topics must be a non-empty array')
    for (const topic of topics) {
      if (!(ZMQ_TOPICS as readonly unknown[]).includes(topic)) {
        throw new TypeError(`unknown topic ${String(topic)}: use ${ZMQ_TOPICS.join(', ')}`)
      }
    }
    if (new Set(topics).size !== topics.length) throw new TypeError('topics must not repeat')
    const delay = options.reconnectDelayMs ?? 1000
    if (!Number.isSafeInteger(delay) || delay < 10 || delay > 60_000) {
      throw new RangeError('reconnectDelayMs must be an integer from 10 to 60000')
    }
    const stale = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    if (!Number.isSafeInteger(stale) || stale < 1) throw new RangeError('staleAfterMs must be a positive integer')
    const maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE
    if (!Number.isSafeInteger(maxMessageSize) || maxMessageSize < 1024 || maxMessageSize > 0x7fff_ffff) {
      throw new RangeError('maxMessageSize must be an integer from 1024 to 2147483647')
    }
    this.#url = options.url
    this.#topics = [...topics]
    this.#reconnectDelayMs = delay
    this.#staleAfterMs = stale
    this.#maxMessageSize = maxMessageSize
    this.#ipv6 = ipv6
    this.#socketFactory = options.socketFactory ?? createZeromqSocket
  }

  /**
   * A snapshot of what the subscriber has observed. See {@link ZmqHealthStatus}.
   *
   * The last message's age is measured on the monotonic clock
   * (`performance.now()`), so a step in the wall clock makes a fresh
   * subscriber neither `stale` nor an old one `receiving`. `now` is the
   * wall-clock time (`Date.now()` units) to report the status at, by default
   * the present: the age is shifted by `now - Date.now()`, so
   * `health(Date.now() + 60_000)` tells whether the subscriber will be stale
   * in a minute if no message arrives meanwhile.
   */
  health(now?: number): ZmqHealth {
    let status: ZmqHealthStatus
    if (this.#closed) status = 'closed'
    else if (!this.#receivedOnSocket) status = 'unknown'
    else {
      const ageMs = performance.now() - this.#lastMessageTick! + (now === undefined ? 0 : now - Date.now())
      status = ageMs > this.#staleAfterMs ? 'stale' : 'receiving'
    }
    return {
      status,
      ...(this.#lastMessageAt === undefined ? {} : { lastMessageAt: this.#lastMessageAt }),
      ...this.#counts,
    }
  }

  /** Stop: closes the socket and ends the iteration. */
  close(): void {
    this.#closed = true
    this.#socket?.close()
    this.#wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ZmqEvent, void, undefined> {
    if (this.#running) throw new Error('QbitZmqSubscriber already has a consumer')
    this.#running = true
    let attempt = 0
    try {
      while (!this.#closed) {
        let socket: ZmqSocket | undefined
        let failure: unknown
        let disconnected = false
        let step: 'create' | 'connect' | 'receive' = 'create'
        try {
          socket = await this.#socketFactory({ maxMessageSize: this.#maxMessageSize, ipv6: this.#ipv6 })
          if (this.#closed) break
          const current = socket
          this.#socket = current
          this.#receivedOnSocket = false
          current.events?.on('disconnect', () => {
            if (this.#socket !== current || this.#closed) return
            disconnected = true
            this.#receivedOnSocket = false
            current.close() // the pending receive rejects, and the loop replaces the socket
          })
          step = 'connect'
          socket.connect(this.#url)
          step = 'receive'
          for (const topic of this.#topics) socket.subscribe(topic)
          while (!this.#closed) {
            const frames = await socket.receive()
            let message: ZmqMessage
            try {
              message = parseZmqMessage(frames)
            } catch (error) {
              if (!(error instanceof ZmqFrameError)) throw error
              this.#counts.malformed += 1
              yield { kind: 'malformed', error }
              continue
            }
            const receivedAt = Date.now()
            this.#lastMessageAt = receivedAt
            this.#lastMessageTick = performance.now()
            this.#receivedOnSocket = true
            this.#counts.messages += 1
            const gap = this.#tracker.observe(message.topic, message.sequence)
            if (gap !== undefined) {
              this.#counts.gaps += 1
              yield { kind: 'gap', ...gap }
            }
            yield { kind: 'message', message, receivedAt }
          }
        } catch (error) {
          failure = error
        } finally {
          socket?.close()
          if (this.#socket === socket) this.#socket = undefined
        }
        if (this.#closed) break
        const fatal = setupError(failure, step, this.#url)
        if (fatal !== undefined) {
          this.#closed = true // health() reports closed; the socket is already closed
          throw fatal
        }
        attempt += 1
        this.#counts.reconnects += 1
        this.#receivedOnSocket = false
        this.#tracker.markUncertain()
        const reason = disconnected ? 'disconnected' : 'failed'
        const code = disconnected ? undefined : errorCode(failure)
        yield code === undefined ? { kind: 'reconnect', attempt, reason } : { kind: 'reconnect', attempt, reason, code }
        await this.#pause()
      }
    } finally {
      this.#running = false
    }
  }

  /** Wait `reconnectDelayMs`, or less if `close()` is called meanwhile. */
  #pause(): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        this.#wake = undefined
        resolve()
      }
      const timer = setTimeout(done, this.#reconnectDelayMs)
      this.#wake = done
    })
  }
}
