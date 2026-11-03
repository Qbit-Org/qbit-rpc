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
}

export type ZmqSocketFactory = () => ZmqSocket | Promise<ZmqSocket>

export interface QbitZmqSubscriberOptions {
  /** The publisher address, for example `tcp://127.0.0.1:28332` or `ipc:///run/qbitd/zmq.sock`. */
  readonly url: string
  /** Topics to subscribe to; each must be one qbitd publishes at `url`. */
  readonly topics: readonly ZmqTopic[]
  /** Wait before replacing a failed socket. Default 1,000 ms. */
  readonly reconnectDelayMs?: number
  /**
   * When set, `health()` reports `stale` once this long has passed since the
   * last message. Pick it from the topic's expected rate: blocks arrive about
   * once a minute, so `hashblock` alone needs several minutes.
   */
  readonly staleAfterMs?: number
  /** Socket source. Default: a `zeromq` `Subscriber`, loaded on first use. */
  readonly socketFactory?: ZmqSocketFactory
}

/** What the subscriber yields. */
export type ZmqEvent =
  | {
      readonly kind: 'message'
      readonly message: ZmqMessage
      /** Local receipt time (`Date.now()`), not a node timestamp. */
      readonly receivedAt: number
    }
  | ({ readonly kind: 'gap' } & SequenceGap)
  | { readonly kind: 'malformed'; readonly error: ZmqFrameError }
  | {
      readonly kind: 'reconnect'
      readonly attempt: number
      /** The failed socket's error code, such as `EFSM`, when it had one. */
      readonly code?: string
    }

/**
 * - `unknown`: no message has arrived since the subscriber (re)connected.
 *   Silence is not health: qbitd may be down, the address wrong, or the topic
 *   not enabled.
 * - `receiving`: a message arrived on the current socket, within
 *   `staleAfterMs` when that is set.
 * - `stale`: the last message is older than `staleAfterMs`.
 * - `closed`: `close()` was called.
 */
export type ZmqHealthStatus = 'unknown' | 'receiving' | 'stale' | 'closed'

export interface ZmqHealth {
  readonly status: ZmqHealthStatus
  /** Local receipt time of the last valid message, if any. */
  readonly lastMessageAt?: number
  readonly messages: number
  readonly gaps: number
  readonly malformed: number
  readonly reconnects: number
}

/** Load `zeromq` lazily, so the parser works without the native addon. */
export async function createZeromqSocket(): Promise<ZmqSocket> {
  const zeromq = (await import('zeromq')) as unknown as { Subscriber?: new () => ZmqSocket }
  if (typeof zeromq.Subscriber !== 'function') throw new Error('the zeromq module has no Subscriber export')
  return new zeromq.Subscriber()
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Subscribes to qbitd's ZMQ notifications and yields parsed messages, gaps in
 * each topic's sequence counter, malformed messages and socket replacements.
 * ZeroMQ reconnects the underlying connection by itself; this replaces the
 * socket only when it fails. Counters are tracked across replacements, so
 * messages lost meanwhile surface as a gap. A gap is the signal to reconcile
 * over RPC (for blocks, `getbestblockhash` and walk back with
 * `getblockheader`): ZMQ is a wake-up, not a ledger.
 *
 * One consumer at a time: iterate it with `for await`.
 */
export class QbitZmqSubscriber implements AsyncIterable<ZmqEvent> {
  readonly #url: string
  readonly #topics: readonly ZmqTopic[]
  readonly #reconnectDelayMs: number
  readonly #staleAfterMs: number | undefined
  readonly #socketFactory: ZmqSocketFactory
  readonly #tracker = new SequenceTracker()
  #socket: ZmqSocket | undefined
  #closed = false
  #running = false
  #wake: (() => void) | undefined
  #lastMessageAt: number | undefined
  #receivedOnSocket = false
  #counts = { messages: 0, gaps: 0, malformed: 0, reconnects: 0 }

  constructor(options: QbitZmqSubscriberOptions) {
    if (typeof options !== 'object' || options === null) throw new TypeError('options must be an object')
    if (typeof options.url !== 'string' || !/^(?:tcp|ipc):\/\/.+/.test(options.url)) {
      throw new TypeError('url must be a tcp:// or ipc:// ZeroMQ address')
    }
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
    const stale = options.staleAfterMs
    if (stale !== undefined && (!Number.isSafeInteger(stale) || stale < 1)) {
      throw new RangeError('staleAfterMs must be a positive integer')
    }
    this.#url = options.url
    this.#topics = [...topics]
    this.#reconnectDelayMs = delay
    this.#staleAfterMs = stale
    this.#socketFactory = options.socketFactory ?? createZeromqSocket
  }

  /** A snapshot of what the subscriber has observed. See {@link ZmqHealthStatus}. */
  health(now: number = Date.now()): ZmqHealth {
    let status: ZmqHealthStatus
    if (this.#closed) status = 'closed'
    else if (!this.#receivedOnSocket) status = 'unknown'
    else if (this.#staleAfterMs !== undefined && now - this.#lastMessageAt! > this.#staleAfterMs) status = 'stale'
    else status = 'receiving'
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
        try {
          socket = await this.#socketFactory()
          if (this.#closed) break
          this.#socket = socket
          this.#receivedOnSocket = false
          socket.connect(this.#url)
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
        attempt += 1
        this.#counts.reconnects += 1
        this.#receivedOnSocket = false
        const code = errorCode(failure)
        yield code === undefined ? { kind: 'reconnect', attempt } : { kind: 'reconnect', attempt, code }
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
