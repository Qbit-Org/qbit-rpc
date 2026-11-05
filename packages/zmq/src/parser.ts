import { types } from 'node:util'

/** The topics qbit Core v1.0.0 publishes (`-zmqpub<topic>=<address>`). */
export type ZmqTopic = 'hashblock' | 'hashtx' | 'rawblock' | 'rawtx' | 'sequence'

export const ZMQ_TOPICS: readonly ZmqTopic[] = ['hashblock', 'hashtx', 'rawblock', 'rawtx', 'sequence']

/**
 * A parsed notification. Hashes are hex in the byte order RPC and explorers
 * show; qbit Core already puts them on the wire in that order.
 */
export type ZmqMessage = {
  /** The publisher's per-topic message counter, an unsigned 32-bit value that wraps. */
  readonly sequence: number
} & (
  | { readonly topic: 'hashblock'; readonly hash: string }
  | { readonly topic: 'hashtx'; readonly txid: string }
  | {
      readonly topic: 'rawblock'
      /** The serialized block, as qbit Core stores it: a copy of the frame, not decoded here. */
      readonly bytes: Uint8Array
    }
  | {
      readonly topic: 'rawtx'
      /** The serialized transaction: a copy of the frame, not decoded here. */
      readonly bytes: Uint8Array
    }
  | {
      readonly topic: 'sequence'
      /** Block connected (`C`) or disconnected (`D`), or a transaction added to (`A`) or removed from (`R`) the mempool. */
      readonly event: 'block_connected' | 'block_disconnected' | 'mempool_added' | 'mempool_removed'
      /** Block hash for block events, txid for mempool events. */
      readonly hash: string
      /** The mempool sequence number, an unsigned 64-bit value, for mempool events only. */
      readonly mempoolSequence?: bigint
    }
)

export type ZmqFrameErrorCode = 'frame_count' | 'frame_type' | 'topic' | 'body_length' | 'label' | 'sequence_length'

/**
 * A message did not match qbit Core's three-part format. The `code`, one of
 * {@link ZmqFrameErrorCode}, says how: not three frames (`frame_count`), a
 * frame that is not a `Uint8Array` (`frame_type`), a topic
 * qbit Core does not publish (`topic`), a body of the wrong length for its topic
 * (`body_length`), an unknown label on a `sequence` message (`label`), or a
 * counter that is not 4 bytes (`sequence_length`).
 */
export class ZmqFrameError extends Error {
  readonly code: ZmqFrameErrorCode
  /** The topic, when the first frame named a known one. */
  readonly topic?: ZmqTopic

  constructor(code: ZmqFrameErrorCode, topic?: ZmqTopic) {
    super(`Malformed qbit ZMQ message (${code}${topic ? ` on ${topic}` : ''})`)
    this.name = 'ZmqFrameError'
    this.code = code
    if (topic !== undefined) this.topic = topic
  }

  /**
   * Whether `value` is a `ZmqFrameError` from any copy of this package. A
   * `Symbol.for` brand is shared across the CommonJS and ESM builds, where
   * `instanceof` sees two classes.
   */
  static is(value: unknown): value is ZmqFrameError {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[FRAME_ERROR_BRAND] === true
  }
}
const FRAME_ERROR_BRAND = Symbol.for('qbit-zmq.ZmqFrameError')
Object.defineProperty(ZmqFrameError.prototype, FRAME_ERROR_BRAND, { value: true })

// The smallest serializations: an 80-byte header plus a transaction count,
// and version, input count, output count and locktime. Neither can exceed
// qbit Core's MAX_BLOCK_SERIALIZED_SIZE.
const MIN_RAW_BLOCK = 81
const MIN_RAW_TX = 10
const MAX_RAW_BODY = 2_000_000

const LABELS = {
  0x43: 'block_connected',
  0x44: 'block_disconnected',
  0x41: 'mempool_added',
  0x52: 'mempool_removed',
} as const

function displayHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')
}

/**
 * Parse one multipart message: topic, body, and a 4-byte little-endian
 * sequence number, each a `Uint8Array` (a `Buffer` is one). Throws
 * {@link ZmqFrameError} for anything else, including a frame of another type,
 * an unknown topic and a body of the wrong length for its topic, and a
 * `TypeError` when `frames` is not an array.
 */
export function parseZmqMessage(frames: readonly Uint8Array[]): ZmqMessage {
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array of Uint8Array')
  if (frames.length !== 3) throw new ZmqFrameError('frame_count')
  // Checked across realms: a Uint8Array from another context fails instanceof.
  // By index, as every() skips the holes of a sparse array.
  for (let i = 0; i < 3; i++) if (!types.isUint8Array(frames[i])) throw new ZmqFrameError('frame_type')
  const [topicFrame, body, counter] = frames as [Uint8Array, Uint8Array, Uint8Array]
  const name = Buffer.from(topicFrame).toString('latin1')
  if (!(ZMQ_TOPICS as readonly string[]).includes(name)) throw new ZmqFrameError('topic')
  const topic = name as ZmqTopic
  if (counter.byteLength !== 4) throw new ZmqFrameError('sequence_length', topic)
  const sequence = Buffer.from(counter.buffer, counter.byteOffset, 4).readUInt32LE(0)

  switch (topic) {
    case 'hashblock':
    case 'hashtx': {
      if (body.byteLength !== 32) throw new ZmqFrameError('body_length', topic)
      const hex = displayHex(body)
      return topic === 'hashblock' ? { topic, sequence, hash: hex } : { topic, sequence, txid: hex }
    }
    case 'rawblock':
    case 'rawtx': {
      if (body.byteLength < (topic === 'rawblock' ? MIN_RAW_BLOCK : MIN_RAW_TX) || body.byteLength > MAX_RAW_BODY) {
        throw new ZmqFrameError('body_length', topic)
      }
      // A copy, so the bytes do not alias the socket's buffer. The constructor
      // copies a typed array in one go; Uint8Array.from iterates it.
      return { topic, sequence, bytes: new Uint8Array(body) }
    }
    case 'sequence': {
      if (body.byteLength < 33) throw new ZmqFrameError('body_length', topic)
      const label = body[32] as keyof typeof LABELS
      const event = LABELS[label]
      if (event === undefined) throw new ZmqFrameError('label', topic)
      const mempool = event === 'mempool_added' || event === 'mempool_removed'
      if (body.byteLength !== (mempool ? 41 : 33)) throw new ZmqFrameError('body_length', topic)
      const hash = displayHex(body.subarray(0, 32))
      if (!mempool) return { topic, sequence, event, hash }
      const mempoolSequence = Buffer.from(body.buffer, body.byteOffset + 33, 8).readBigUInt64LE(0)
      return { topic, sequence, event, hash, mempoolSequence }
    }
  }
}

/**
 * A break in one topic's message counter. Messages were lost, or the
 * publisher restarted: either way, reconcile over RPC.
 */
export interface SequenceGap {
  readonly topic: ZmqTopic
  readonly expected: number
  readonly received: number
  /**
   * Messages skipped, when the counter jumped forward (by less than 2^31,
   * modulo 2^32). Absent when it went backwards or repeated, which usually
   * means qbitd restarted and its counter began again: how many messages were
   * lost is then unknown.
   */
  readonly missed?: number
}

/**
 * Tracks each topic's counter. The first message on a topic sets the
 * baseline; after that, any value other than the previous one plus one (mod
 * 2^32) is a gap. A repeated value is a gap too: qbit Core never resends.
 */
export class SequenceTracker {
  readonly #last = new Map<ZmqTopic, number>()
  readonly #uncertain = new Set<ZmqTopic>()

  observe(topic: ZmqTopic, sequence: number): SequenceGap | undefined {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) {
      throw new RangeError('ZMQ sequence must be an unsigned 32-bit integer')
    }
    const last = this.#last.get(topic)
    this.#last.set(topic, sequence)
    if (last === undefined) return undefined
    const expected = (last + 1) >>> 0
    if (this.#uncertain.delete(topic)) return { topic, expected, received: sequence }
    if (sequence === expected) return undefined
    const forward = (sequence - expected) >>> 0
    return forward < 0x8000_0000
      ? { topic, expected, received: sequence, missed: forward }
      : { topic, expected, received: sequence }
  }

  /**
   * Messages may have been lost on every tracked topic (the connection
   * dropped): the next message on each is a gap without `missed`, even if its
   * counter follows on, since a restarted publisher's counter can line up.
   */
  markUncertain(): void {
    for (const topic of this.#last.keys()) this.#uncertain.add(topic)
  }

  /** Forget every baseline, so the next message on each topic starts afresh. */
  reset(): void {
    this.#last.clear()
    this.#uncertain.clear()
  }
}
