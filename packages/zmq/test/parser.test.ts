import { describe, expect, it } from 'vitest'

import { parseZmqMessage, SequenceTracker, ZmqFrameError, type ZmqFrameErrorCode } from '../src'

// qbit Core writes hashes byte-reversed from their internal order, which is
// the display order RPC uses: the wire bytes read as hex are the RPC hash
// (contrib/zmq/zmq_sub.py prints body.hex()). An asymmetric hash catches a
// stray reversal.
const HASH = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('')
const wire = (hash: string): Buffer => Buffer.from(hash, 'hex')

function counter(sequence: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(sequence)
  return buffer
}

function sequenceBody(label: string, mempoolSequence?: bigint): Buffer {
  const parts = [wire(HASH), Buffer.from(label, 'latin1')]
  if (mempoolSequence !== undefined) {
    const seq = Buffer.alloc(8)
    seq.writeBigUInt64LE(mempoolSequence)
    parts.push(seq)
  }
  return Buffer.concat(parts)
}

const msg = (topic: string, body: Uint8Array, sequence = 7): Buffer[] => [
  Buffer.from(topic),
  Buffer.from(body),
  counter(sequence),
]

describe('parseZmqMessage', () => {
  it('parses hashblock and hashtx in wire (display) byte order with a little-endian counter', () => {
    expect(parseZmqMessage(msg('hashblock', wire(HASH), 0x7856_3412))).toEqual({
      topic: 'hashblock',
      sequence: 0x7856_3412,
      hash: HASH,
    })
    expect(parseZmqMessage(msg('hashtx', wire(HASH), 0xffff_ffff))).toEqual({
      topic: 'hashtx',
      sequence: 0xffff_ffff,
      txid: HASH,
    })
  })

  it('passes raw blocks and transactions through as copied bytes', () => {
    const block = Buffer.alloc(81, 1)
    const frames = msg('rawblock', block)
    const parsed = parseZmqMessage(frames)
    expect(parsed).toMatchObject({ topic: 'rawblock', sequence: 7 })
    expect(parsed.topic === 'rawblock' && Buffer.from(parsed.bytes).equals(block)).toBe(true)
    frames[1]![0] = 9
    expect(parsed.topic === 'rawblock' && parsed.bytes[0]).toBe(1)
    expect(parseZmqMessage(msg('rawtx', Buffer.alloc(10)))).toMatchObject({ topic: 'rawtx' })
  })

  it.each(['rawblock', 'rawtx'] as const)('copies a %s body that is a view into a larger buffer', topic => {
    // A receive buffer can hold more than the frame, which is a view into it.
    const received = Buffer.alloc(4096, 0xee)
    const body = received.subarray(100, 2100).fill(1)
    const parsed = parseZmqMessage([Buffer.from(topic), body, counter(7)])
    if (parsed.topic !== 'rawblock' && parsed.topic !== 'rawtx') throw new Error(`parsed as ${parsed.topic}`)
    expect(parsed.bytes).toEqual(new Uint8Array(2000).fill(1))
    expect(parsed.bytes.buffer).not.toBe(received.buffer)
    // Changing the frame, or the buffer around it, afterwards changes nothing parsed.
    received.fill(9)
    expect(parsed.bytes).toEqual(new Uint8Array(2000).fill(1))
  })

  it.each([
    ['C', 'block_connected'],
    ['D', 'block_disconnected'],
  ] as const)('parses sequence %s (33-byte body)', (label, event) => {
    expect(parseZmqMessage(msg('sequence', sequenceBody(label)))).toEqual({
      topic: 'sequence',
      sequence: 7,
      event,
      hash: HASH,
    })
  })

  it.each([
    ['A', 'mempool_added'],
    ['R', 'mempool_removed'],
  ] as const)('parses sequence %s with its 8-byte mempool sequence (41-byte body)', (label, event) => {
    expect(parseZmqMessage(msg('sequence', sequenceBody(label, 2n ** 63n + 5n)))).toEqual({
      topic: 'sequence',
      sequence: 7,
      event,
      hash: HASH,
      mempoolSequence: 2n ** 63n + 5n,
    })
  })

  const malformed: [string, Uint8Array[], ZmqFrameErrorCode][] = [
    ['no frames', [], 'frame_count'],
    ['two frames', [Buffer.from('hashtx'), wire(HASH)], 'frame_count'],
    ['four frames', [...msg('hashtx', wire(HASH)), Buffer.alloc(0)], 'frame_count'],
    ['an unknown topic', msg('hashblocks', wire(HASH)), 'topic'],
    ['an empty topic', msg('', wire(HASH)), 'topic'],
    ['a 3-byte counter', [Buffer.from('hashtx'), wire(HASH), Buffer.alloc(3)], 'sequence_length'],
    ['a 5-byte counter', [Buffer.from('hashtx'), wire(HASH), Buffer.alloc(5)], 'sequence_length'],
    ['a short hash', msg('hashblock', Buffer.alloc(31)), 'body_length'],
    ['a long hash', msg('hashtx', Buffer.alloc(33)), 'body_length'],
    ['a truncated raw block', msg('rawblock', Buffer.alloc(80)), 'body_length'],
    ['a truncated raw tx', msg('rawtx', Buffer.alloc(9)), 'body_length'],
    ['a sequence body without a label', msg('sequence', wire(HASH)), 'body_length'],
    ['an unknown sequence label', msg('sequence', sequenceBody('X')), 'label'],
    ['a block event with a mempool sequence', msg('sequence', sequenceBody('C', 1n)), 'body_length'],
    ['a mempool event without one', msg('sequence', sequenceBody('A')), 'body_length'],
    [
      'a mempool event with a short one',
      msg('sequence', Buffer.concat([sequenceBody('R'), Buffer.alloc(7)])),
      'body_length',
    ],
  ]
  it.each(malformed)('rejects %s', (_label, frames, code) => {
    const error = (() => {
      try {
        parseZmqMessage(frames)
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(ZmqFrameError)
    expect((error as ZmqFrameError).code).toBe(code)
  })
})

describe('SequenceTracker', () => {
  it('detects forward gaps per topic, across the 2^32 wrap', () => {
    const tracker = new SequenceTracker()
    expect(tracker.observe('hashblock', 0xffff_fffe)).toBeUndefined()
    expect(tracker.observe('hashblock', 0xffff_ffff)).toBeUndefined()
    expect(tracker.observe('hashblock', 0)).toBeUndefined()
    expect(tracker.observe('hashtx', 50)).toBeUndefined()
    expect(tracker.observe('hashblock', 3)).toEqual({ topic: 'hashblock', expected: 1, received: 3, missed: 2 })
    expect(tracker.observe('hashtx', 51)).toBeUndefined()
    expect(tracker.observe('hashblock', 1)).toEqual({ topic: 'hashblock', expected: 4, received: 1 })
  })

  it('reports a repeat or a restart without inventing a missed count', () => {
    const tracker = new SequenceTracker()
    tracker.observe('sequence', 900)
    expect(tracker.observe('sequence', 900)).toEqual({ topic: 'sequence', expected: 901, received: 900 })
    expect(tracker.observe('sequence', 0)).toEqual({ topic: 'sequence', expected: 901, received: 0 })
    tracker.reset()
    expect(tracker.observe('sequence', 12345)).toBeUndefined()
  })

  it('rejects values outside uint32', () => {
    const tracker = new SequenceTracker()
    expect(() => tracker.observe('hashtx', -1)).toThrow(RangeError)
    expect(() => tracker.observe('hashtx', 2 ** 32)).toThrow(RangeError)
    expect(() => tracker.observe('hashtx', 1.5)).toThrow(RangeError)
  })
})

describe('size and uncertainty bounds', () => {
  it('rejects raw bodies above qbit Core MAX_BLOCK_SERIALIZED_SIZE', () => {
    expect(parseZmqMessage(msg('rawblock', Buffer.alloc(2_000_000)))).toMatchObject({ topic: 'rawblock' })
    for (const topic of ['rawblock', 'rawtx']) {
      expect(() => parseZmqMessage(msg(topic, Buffer.alloc(2_000_001)))).toThrow(
        expect.objectContaining({ code: 'body_length', topic })
      )
    }
  })

  it('reports the next message on every tracked topic as a gap after markUncertain, even if consecutive', () => {
    const tracker = new SequenceTracker()
    tracker.observe('hashblock', 4)
    tracker.observe('hashtx', 10)
    tracker.markUncertain()
    expect(tracker.observe('hashblock', 5)).toEqual({ topic: 'hashblock', expected: 5, received: 5 })
    expect(tracker.observe('hashblock', 6)).toBeUndefined()
    expect(tracker.observe('hashtx', 15)).toEqual({ topic: 'hashtx', expected: 11, received: 15 })
    // A topic first seen after the mark only sets its baseline.
    expect(tracker.observe('sequence', 0)).toBeUndefined()
  })
})
