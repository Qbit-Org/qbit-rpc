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
   * Socket events (`zeromq`'s observer). When present, the subscriber replaces
   * the socket on a `disconnect` (the connection dropped) or a `close` (a
   * connection attempt failed), and when no `handshake` (a connection is
   * ready) has come within its handshake deadline of `connect()`: a
   * {@link createZeromqSocket} socket does not reconnect by itself, and
   * messages published meanwhile are lost anyway. A custom socket with
   * `events` emits all three, as `zeromq`'s does; for one that never emits
   * `handshake`, the first message counts as one.
   */
  readonly events?: { on(type: 'disconnect' | 'close' | 'handshake', listener: () => void): unknown }
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
  /**
   * libzmq's `ZMQ_HEARTBEAT_IVL`: send a ZMTP PING every this many ms; 0 sends
   * none. The subscriber always passes it; left out, libzmq's default (0) stays.
   */
  readonly heartbeatIntervalMs?: number
  /**
   * `ZMQ_HEARTBEAT_TIMEOUT`: drop the connection when nothing arrives within
   * this many ms of a PING. The subscriber always passes it.
   */
  readonly heartbeatTimeoutMs?: number
  /**
   * `ZMQ_HEARTBEAT_TTL`: ask the publisher to drop the connection when nothing
   * arrives from this socket within this many ms; 0 asks nothing. The
   * subscriber always passes it.
   */
  readonly heartbeatTtlMs?: number
  /**
   * `ZMQ_HANDSHAKE_IVL`: drop a connection whose ZMTP handshake has not
   * completed within this many ms. The subscriber always passes it:
   * `heartbeatIntervalMs + heartbeatTimeoutMs`, or 30,000 without heartbeats.
   */
  readonly handshakeIntervalMs?: number
  /**
   * `ZMQ_TCP_KEEPALIVE`: true turns TCP keepalive on, false off. Passed only
   * when set; left out, the operating system's default stays (off on Linux).
   */
  readonly tcpKeepalive?: boolean
  /** `ZMQ_TCP_KEEPALIVE_IDLE`, in seconds. Passed only when set. */
  readonly tcpKeepaliveIdleSeconds?: number
  /** `ZMQ_TCP_KEEPALIVE_INTVL`, in seconds. Passed only when set. */
  readonly tcpKeepaliveIntervalSeconds?: number
  /** `ZMQ_TCP_KEEPALIVE_CNT`. Passed only when set. */
  readonly tcpKeepaliveCount?: number
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

/** The default `heartbeatIntervalMs`. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000

/**
 * The default `heartbeatTimeoutMs`. With the default interval, a publisher
 * that stops answering is dropped within 30 s.
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20_000

/** The largest `heartbeatTtlMs`: libzmq sends the TTL in deciseconds, in 16 bits. */
const MAX_HEARTBEAT_TTL_MS = 6_553_500

/** libzmq keeps the TTL in deciseconds, rounding down: 310 ms is sent as 300. */
const HEARTBEAT_TTL_UNIT_MS = 100

/**
 * The default `heartbeatTtlMs`, or twice `heartbeatIntervalMs` rounded up to a
 * multiple of 100 when that is longer: qbitd then drops a subscriber whose
 * process stops for that long, and frees its queue.
 */
export const DEFAULT_HEARTBEAT_TTL_MS = 30_000

/**
 * The handshake deadline without heartbeats: libzmq's own default
 * `ZMQ_HANDSHAKE_IVL`. With heartbeats it is `heartbeatIntervalMs +
 * heartbeatTimeoutMs`.
 */
const HANDSHAKE_WITHOUT_HEARTBEATS_MS = 30_000

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
   * Send a ZMTP heartbeat (PING) to the publisher every this many ms, an
   * integer from 100 to 3,600,000, or 0 for none. qbitd's libzmq answers each
   * one. Default 10,000.
   */
  readonly heartbeatIntervalMs?: number
  /**
   * Drop the connection when nothing, a PONG or a message, arrives within this
   * many ms of a heartbeat, an integer from 100 to 3,600,000; the subscriber
   * then yields a `reconnect` with `reason: 'disconnected'` and replaces the
   * socket. A publisher that stops answering without closing the connection
   * (qbitd hung or paused, its host gone) is so dropped within
   * `heartbeatIntervalMs + heartbeatTimeoutMs`, long before `staleAfterMs`, and
   * a new connection whose handshake has not completed within that time is
   * dropped too. So is a healthy publisher when the consumer falls behind:
   * libzmq stops reading a connection whose receive queue (1,000 messages) is
   * full, PONGs included. Default 20,000. Unused when `heartbeatIntervalMs` is
   * 0, and then 0 is accepted too.
   */
  readonly heartbeatTimeoutMs?: number
  /**
   * Ask the publisher to drop the connection when it hears nothing from this
   * subscriber for this many ms, so a subscriber that hangs does not hold
   * qbitd's queue: 0 for no limit, or an integer up to 6,553,500 that is at
   * least twice `heartbeatIntervalMs` once libzmq has rounded it down to a
   * multiple of 100. qbitd restarts the limit at each heartbeat, so one shorter
   * than the interval drops a healthy subscriber. Default 30,000, or twice the
   * interval rounded up to a multiple of 100 when that is longer. Unused when
   * `heartbeatIntervalMs` is 0, and then 0 (the default) or from 100.
   */
  readonly heartbeatTtlMs?: number
  /**
   * TCP keepalive on the connection: true to turn it on, false to turn it off.
   * Default: the operating system's (off on Linux). It detects a peer host
   * that is gone, not a process that hangs, and only on an idle connection,
   * which heartbeats keep busy: it is for a publisher that does not answer
   * heartbeats, with `heartbeatIntervalMs: 0`. A `TypeError` with an `ipc://` url.
   */
  readonly tcpKeepalive?: boolean
  /**
   * Idle seconds before the first keepalive probe, an integer from 1 to
   * 32,767. Needs `tcpKeepalive: true`. Default: the OS's (7,200 on Linux).
   */
  readonly tcpKeepaliveIdleSeconds?: number
  /**
   * Seconds between keepalive probes, an integer from 1 to 32,767. Needs
   * `tcpKeepalive: true`. Default: the OS's (75 on Linux).
   */
  readonly tcpKeepaliveIntervalSeconds?: number
  /**
   * Unanswered probes before the connection drops, an integer from 1 to 127.
   * Needs `tcpKeepalive: true`. Default: the OS's (9 on Linux).
   */
  readonly tcpKeepaliveCount?: number
  /**
   * Socket source. Default: {@link createZeromqSocket}, loaded on first use.
   * It receives `{ maxMessageSize, ipv6, heartbeatIntervalMs,
   * heartbeatTimeoutMs, heartbeatTtlMs, handshakeIntervalMs }`, with `ipv6`
   * true when the url's host is an IPv6 address, and the `tcpKeepalive`
   * options that are set, and should apply them all, and turn off libzmq's own
   * reconnect as {@link createZeromqSocket} does. A factory can throw a
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
       * `disconnected`: a connection to the publisher dropped after its
       * handshake: qbitd stopped or restarted, sent a message over
       * `maxMessageSize`, or missed a heartbeat, which also happens when the
       * consumer falls behind long enough to fill the receive queue.
       * `failed`: no connection was made (qbitd down, the host name did not
       * resolve, or no handshake within the deadline), or making, connecting
       * or receiving on the socket failed, other than with a
       * {@link ZmqSetupError}.
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

/** The `zeromq` range of package.json's `peerDependencies`, for messages; a test keeps the two equal. */
const ZEROMQ_RANGE = '^6.5.0'

/**
 * A `zeromq` `Subscriber` with `settings` applied, which libzmq does not
 * reconnect by itself (`ZMQ_RECONNECT_IVL` -1): the subscriber replaces it
 * instead. Code that reads one itself must replace it on a `disconnect` or
 * `close` event. `zeromq` loads lazily, so the parser works without the native
 * addon; a failure to load it is a {@link ZmqSetupError}.
 */
export async function createZeromqSocket(
  settings: ZmqSocketSettings = { maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE }
): Promise<ZmqSocket> {
  let zeromq: { Subscriber?: new () => ZeromqSubscriber }
  try {
    zeromq = (await import('zeromq')) as unknown as typeof zeromq
  } catch (error) {
    throw new ZmqSetupError(
      'module_load',
      `Could not load the zeromq module or its native addon (${errorSummary(error)}): zeromq is an optional peer dependency of @qbit-oss/zmq, which the application adds itself (npm install zeromq@${ZEROMQ_RANGE}), with the prebuilt addon for this platform or one built from source`,
      { cause: error }
    )
  }
  if (typeof zeromq.Subscriber !== 'function') {
    throw new ZmqSetupError(
      'module_load',
      `The zeromq module has no Subscriber export: install zeromq@${ZEROMQ_RANGE}, the optional peer dependency's range`
    )
  }
  const socket = new zeromq.Subscriber()
  // Once libzmq has reconnected a socket by itself, reading it can abort the
  // process: libzmq 4.3.5 asserts (`_input_stopped`, stream_engine_base.cpp)
  // when the new connection is told to resume reading, which a read does once
  // the old connection had filled the receive queue (libzmq #3596 and #4841,
  // #41). Its heartbeats drop exactly such a connection, and a receive already
  // pending when the event loop is blocked reads it before the subscriber can
  // close the socket. A socket that never reconnects by itself never meets
  // that, and the subscriber replaces it on `disconnect` and `close`.
  socket.reconnectInterval = -1
  socket.maxMessageSize = settings.maxMessageSize
  if (settings.ipv6 === true) socket.ipv6 = true
  if (settings.heartbeatIntervalMs !== undefined) socket.heartbeatInterval = settings.heartbeatIntervalMs
  if (settings.heartbeatTimeoutMs !== undefined) socket.heartbeatTimeout = settings.heartbeatTimeoutMs
  if (settings.heartbeatTtlMs !== undefined) socket.heartbeatTimeToLive = settings.heartbeatTtlMs
  if (settings.handshakeIntervalMs !== undefined) socket.handshakeInterval = settings.handshakeIntervalMs
  if (settings.tcpKeepalive !== undefined) socket.tcpKeepalive = settings.tcpKeepalive ? 1 : 0
  if (settings.tcpKeepaliveIdleSeconds !== undefined) socket.tcpKeepaliveIdle = settings.tcpKeepaliveIdleSeconds
  if (settings.tcpKeepaliveIntervalSeconds !== undefined) {
    socket.tcpKeepaliveInterval = settings.tcpKeepaliveIntervalSeconds
  }
  if (settings.tcpKeepaliveCount !== undefined) socket.tcpKeepaliveCount = settings.tcpKeepaliveCount
  return socket
}

/** The options of `zeromq`'s `Subscriber` that {@link createZeromqSocket} sets. */
type ZeromqSubscriber = ZmqSocket & {
  reconnectInterval: number
  maxMessageSize: number
  ipv6: boolean
  heartbeatInterval: number
  heartbeatTimeout: number
  heartbeatTimeToLive: number
  handshakeInterval: number
  tcpKeepalive: number
  tcpKeepaliveIdle: number
  tcpKeepaliveInterval: number
  tcpKeepaliveCount: number
}

/** `value` if it is an integer from `min` to `max`, or `zero` and it is 0; else a RangeError. */
function integerOption(name: string, value: number, min: number, max: number, zero = false): number {
  if (Number.isSafeInteger(value) && ((zero && value === 0) || (value >= min && value <= max))) return value
  const range = `an integer from ${min} to ${max}`
  throw new RangeError(`${name} must be ${zero ? `0 or ${range}` : range}`)
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
  readonly #socketSettings: ZmqSocketSettings
  /** How long after `connect()` a socket's first handshake may take before it is replaced. */
  readonly #handshakeDeadlineMs: number
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
    const heartbeatIntervalMs = integerOption(
      'heartbeatIntervalMs',
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      100,
      3_600_000,
      true
    )
    const heartbeats = heartbeatIntervalMs > 0
    // Unused without heartbeats, the timeout may then be 0, as the TTL may.
    const heartbeatTimeoutMs = integerOption(
      'heartbeatTimeoutMs',
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      100,
      3_600_000,
      !heartbeats
    )
    // Without heartbeats no PING carries a TTL; a TTL must also allow a missed
    // PING once libzmq has rounded it down to whole deciseconds.
    const minimumTtl = Math.ceil((2 * heartbeatIntervalMs) / HEARTBEAT_TTL_UNIT_MS) * HEARTBEAT_TTL_UNIT_MS
    const defaultTtl =
      !heartbeats || minimumTtl > MAX_HEARTBEAT_TTL_MS ? 0 : Math.max(DEFAULT_HEARTBEAT_TTL_MS, minimumTtl)
    const heartbeatTtlMs = integerOption(
      'heartbeatTtlMs',
      options.heartbeatTtlMs ?? defaultTtl,
      100,
      MAX_HEARTBEAT_TTL_MS,
      true
    )
    const sentTtl = heartbeatTtlMs - (heartbeatTtlMs % HEARTBEAT_TTL_UNIT_MS)
    if (heartbeats && heartbeatTtlMs > 0 && sentTtl < 2 * heartbeatIntervalMs) {
      throw new RangeError(
        `heartbeatTtlMs must be 0 or, rounded down to a multiple of 100 as libzmq sends it, at least twice heartbeatIntervalMs: at least ${minimumTtl}`
      )
    }
    const handshakeIntervalMs = heartbeats ? heartbeatIntervalMs + heartbeatTimeoutMs : HANDSHAKE_WITHOUT_HEARTBEATS_MS
    const keepalive = options.tcpKeepalive
    if (keepalive !== undefined && typeof keepalive !== 'boolean') throw new TypeError('tcpKeepalive must be a boolean')
    if (keepalive !== undefined && options.url.startsWith('ipc://')) {
      throw new TypeError('tcpKeepalive is for a tcp:// url: an ipc:// connection has no TCP keepalive')
    }
    const keepaliveSettings: {
      tcpKeepalive?: boolean
      tcpKeepaliveIdleSeconds?: number
      tcpKeepaliveIntervalSeconds?: number
      tcpKeepaliveCount?: number
    } = keepalive === undefined ? {} : { tcpKeepalive: keepalive }
    for (const [name, max] of [
      ['tcpKeepaliveIdleSeconds', 32_767],
      ['tcpKeepaliveIntervalSeconds', 32_767],
      ['tcpKeepaliveCount', 127],
    ] as const) {
      const value = options[name]
      if (value === undefined) continue
      if (keepalive !== true) throw new TypeError(`${name} needs tcpKeepalive: true`)
      keepaliveSettings[name] = integerOption(name, value, 1, max)
    }
    this.#url = options.url
    this.#topics = [...topics]
    this.#reconnectDelayMs = delay
    this.#staleAfterMs = stale
    this.#socketSettings = {
      maxMessageSize,
      ipv6,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      heartbeatTtlMs,
      handshakeIntervalMs,
      ...keepaliveSettings,
    }
    this.#handshakeDeadlineMs = handshakeIntervalMs
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
        let dropped: 'disconnected' | 'failed' | undefined
        let handshakeTimer: ReturnType<typeof setTimeout> | undefined
        let step: 'create' | 'connect' | 'receive' = 'create'
        try {
          socket = await this.#socketFactory({ ...this.#socketSettings })
          if (this.#closed) break
          const current = socket
          this.#socket = current
          this.#receivedOnSocket = false
          let handshaken = false
          if (current.events !== undefined) {
            // libzmq does not reconnect the socket by itself (see createZeromqSocket):
            // a dropped connection, a failed attempt (`close`: refused, say) and an
            // attempt that never finishes (a host name that does not resolve emits
            // nothing; a publisher that accepts but never greets) each end the
            // socket, and the loop replaces it after reconnectDelayMs.
            const drop = (): void => {
              if (this.#socket !== current || this.#closed || dropped !== undefined) return
              dropped = handshaken ? 'disconnected' : 'failed'
              this.#receivedOnSocket = false
              current.close() // the pending receive rejects, and the loop replaces the socket
            }
            current.events.on('disconnect', drop)
            current.events.on('close', drop)
            current.events.on('handshake', () => {
              handshaken = true
              clearTimeout(handshakeTimer)
            })
            // A timer that expired while the event loop was blocked runs before that
            // turn's I/O: look again after it, once a handshake waiting there has counted.
            handshakeTimer = setTimeout(
              () =>
                setImmediate(() => {
                  if (!handshaken) drop()
                }),
              this.#handshakeDeadlineMs
            )
          }
          step = 'connect'
          socket.connect(this.#url)
          step = 'receive'
          for (const topic of this.#topics) socket.subscribe(topic)
          while (!this.#closed && dropped === undefined) {
            const frames = await socket.receive()
            // A message proves the handshake, also for a socket whose events emit no `handshake`.
            if (!handshaken) {
              handshaken = true
              clearTimeout(handshakeTimer)
            }
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
          clearTimeout(handshakeTimer)
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
        const reason = dropped ?? 'failed'
        const code = dropped === undefined ? errorCode(failure) : undefined
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
