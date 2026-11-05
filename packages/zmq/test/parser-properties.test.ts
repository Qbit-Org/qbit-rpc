import { runInNewContext } from 'node:vm'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { parseZmqMessage, ZmqFrameError, type ZmqFrameErrorCode, type ZmqMessage } from '../src'
import { SequenceTracker, ZMQ_TOPICS, type SequenceGap } from '../src/parser'
import { fuzz, FUZZ_TIMEOUT_MS } from './helpers/fuzz'

// Property tests of the parser and the tracker against a model written from
// qbit Core's message format (src/zmq/zmqpublishnotifier.cpp): three frames,
// topic, body and a 4-byte little-endian counter. See helpers/fuzz.ts for
// the run counts and QBIT_FUZZ_RUNS.

const LABELS: Record<number, 'block_connected' | 'block_disconnected' | 'mempool_added' | 'mempool_removed'> = {
  0x43: 'block_connected',
  0x44: 'block_disconnected',
  0x41: 'mempool_added',
  0x52: 'mempool_removed',
}

/** What the parser must return for three `Uint8Array` frames, or the code it must throw. */
function model(topicFrame: Uint8Array, body: Uint8Array, counter: Uint8Array): ZmqMessage | ZmqFrameErrorCode {
  const name = Buffer.from(topicFrame).toString('latin1')
  if (!(ZMQ_TOPICS as readonly string[]).includes(name)) return 'topic'
  if (counter.length !== 4) return 'sequence_length'
  const sequence = counter[0]! + counter[1]! * 2 ** 8 + counter[2]! * 2 ** 16 + counter[3]! * 2 ** 24
  const hex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  switch (name) {
    case 'hashblock':
      return body.length === 32 ? { topic: 'hashblock', sequence, hash: hex(body) } : 'body_length'
    case 'hashtx':
      return body.length === 32 ? { topic: 'hashtx', sequence, txid: hex(body) } : 'body_length'
    case 'rawblock':
    case 'rawtx': {
      const min = name === 'rawblock' ? 81 : 10
      if (body.length < min || body.length > 2_000_000) return 'body_length'
      return { topic: name, sequence, bytes: Uint8Array.from(body) }
    }
    default: {
      if (body.length < 33) return 'body_length'
      const event = LABELS[body[32]!]
      if (event === undefined) return 'label'
      const mempool = event === 'mempool_added' || event === 'mempool_removed'
      if (body.length !== (mempool ? 41 : 33)) return 'body_length'
      const hash = hex(body.subarray(0, 32))
      if (!mempool) return { topic: 'sequence', sequence, event, hash }
      let mempoolSequence = 0n
      for (let i = 40; i >= 33; i--) mempoolSequence = mempoolSequence * 256n + BigInt(body[i]!)
      return { topic: 'sequence', sequence, event, hash, mempoolSequence }
    }
  }
}

/** The frame as a view into a larger buffer, at an offset, as a socket may hand it over. */
const framed = (bytes: Uint8Array, offset: number): Uint8Array => {
  const backing = new Uint8Array(offset + bytes.length + 3).fill(0xee)
  backing.set(bytes, offset)
  return backing.subarray(offset, offset + bytes.length)
}

const bytes = (min: number, max: number): fc.Arbitrary<Uint8Array> => fc.uint8Array({ minLength: min, maxLength: max })
const view = (inner: fc.Arbitrary<Uint8Array>): fc.Arbitrary<Uint8Array> =>
  fc.tuple(inner, fc.nat(7), fc.boolean()).map(([b, offset, asBuffer]) => {
    const v = framed(b, offset)
    return asBuffer ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v
  })

const topicName = fc.oneof(
  fc.constantFrom(...ZMQ_TOPICS),
  fc.constantFrom('', 'hashBlock', 'rawtx\0', 'sequenc', 'pubhashtx'),
  fc.string({ maxLength: 12 })
)
const topicFrame = topicName.map(name => Buffer.from(name, 'latin1'))
const counterFrame = fc.oneof({ weight: 4, arbitrary: bytes(4, 4) }, { weight: 1, arbitrary: bytes(0, 6) })
/** Bodies near every length boundary, with a label that is often valid. */
const bodyFrame = fc.oneof(
  bytes(0, 45),
  fc
    .tuple(bytes(32, 32), fc.constantFrom(0x43, 0x44, 0x41, 0x52, 0x00, 0x63), fc.constantFrom(0, 7, 8, 9))
    .map(([hash, label, extra]) => Buffer.concat([hash, Buffer.from([label]), Buffer.alloc(extra, 0x5a)])),
  fc.integer({ min: 75, max: 90 }).map(length => new Uint8Array(length).fill(3))
)
const notFrame = fc.oneof(
  fc.constantFrom(null, undefined, 0, '', 'hashtx', [104, 97, 115, 104, 116, 120], {}),
  fc.constant(new ArrayBuffer(4)),
  fc.constant(new DataView(new ArrayBuffer(4))),
  fc.constant(new Uint16Array(2)),
  fc.constant(new Int8Array(4)),
  fc.constant(new Uint8ClampedArray(4))
)

const describeOutcome = (frames: readonly unknown[]): ZmqMessage | ZmqFrameErrorCode => {
  try {
    return parseZmqMessage(frames as Uint8Array[])
  } catch (error) {
    if (error instanceof ZmqFrameError) return error.code
    throw error
  }
}

describe('parseZmqMessage properties', () => {
  it(
    'throws only ZmqFrameError for any array of frames, of any type',
    () => {
      const anyFrame = fc.oneof(view(topicFrame), view(bodyFrame), view(counterFrame), bytes(0, 64), notFrame)
      // Sparse too: a hole is no frame.
      const frameArrays = fc.oneof(fc.array(anyFrame, { maxLength: 5 }), fc.sparseArray(anyFrame, { maxLength: 5 }))
      fc.assert(
        fc.property(frameArrays, frames => {
          const outcome = describeOutcome(frames)
          if (frames.length !== 3) expect(outcome).toBe('frame_count')
          else if (![0, 1, 2].every(i => frames[i] instanceof Uint8Array)) expect(outcome).toBe('frame_type')
        }),
        fuzz(2000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'agrees with the model on three Uint8Array frames, wherever they sit in their buffers',
    () => {
      fc.assert(
        fc.property(view(topicFrame), view(bodyFrame), view(counterFrame), (topic, body, counter) => {
          expect(describeOutcome([topic, body, counter])).toEqual(model(topic, body, counter))
        }),
        fuzz(3000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'parses every message qbitd can publish, and copies raw bodies',
    () => {
      const counter = (n: number): Buffer => {
        const b = Buffer.alloc(4)
        b.writeUInt32LE(n)
        return b
      }
      const message = fc.oneof(
        fc.tuple(fc.constantFrom('hashblock', 'hashtx'), bytes(32, 32)),
        fc.tuple(fc.constant('rawblock'), bytes(81, 400)),
        fc.tuple(fc.constant('rawtx'), bytes(10, 400)),
        fc.tuple(
          fc.constant('sequence'),
          fc.tuple(bytes(32, 32), fc.constantFrom(0x43, 0x44)).map(([h, l]) => Buffer.concat([h, Buffer.from([l])]))
        ),
        fc.tuple(
          fc.constant('sequence'),
          fc
            .tuple(bytes(32, 32), fc.constantFrom(0x41, 0x52), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }))
            .map(([h, l, n]) => {
              const seq = Buffer.alloc(8)
              seq.writeBigUInt64LE(n)
              return Buffer.concat([h, Buffer.from([l]), seq])
            })
        )
      )
      fc.assert(
        fc.property(message, fc.integer({ min: 0, max: 0xffff_ffff }), fc.nat(7), ([topic, body], sequence, offset) => {
          const frames = [Buffer.from(topic), framed(body, offset), framed(counter(sequence), offset)]
          const parsed = parseZmqMessage(frames)
          expect(typeof parsed).toBe('object')
          expect(parsed).toEqual(model(frames[0]!, frames[1]!, frames[2]!))
          expect(parsed.sequence).toBe(sequence)
          if (parsed.topic === 'rawblock' || parsed.topic === 'rawtx') {
            expect(parsed.bytes.byteLength).toBe(body.length)
            expect(parsed.bytes.buffer).not.toBe(frames[1]!.buffer)
            frames[1]!.fill(0)
            expect(Buffer.from(parsed.bytes).equals(Buffer.from(body))).toBe(true)
          }
        }),
        fuzz(2000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it('refuses a frame that is not a Uint8Array as frame_type, in any position', () => {
    const valid = [Buffer.from('hashtx'), Buffer.alloc(32, 1), Buffer.alloc(4)]
    expect(describeOutcome(valid)).toMatchObject({ topic: 'hashtx' })
    for (const bad of [null, undefined, 'hashtx', [1, 2, 3, 4], new ArrayBuffer(4), new Uint16Array(2), {}]) {
      for (let position = 0; position < 3; position++) {
        const frames: unknown[] = [...valid]
        frames[position] = bad
        const error = (() => {
          try {
            return parseZmqMessage(frames as Uint8Array[])
          } catch (e) {
            return e
          }
        })()
        expect(ZmqFrameError.is(error)).toBe(true)
        expect(error).toMatchObject({ code: 'frame_type' })
        expect((error as ZmqFrameError).topic).toBeUndefined()
      }
    }
    // A hole is not a frame, wherever it is.
    for (let position = 0; position < 3; position++) {
      const sparse: Uint8Array[] = [...valid]
      delete sparse[position]
      expect(sparse).toHaveLength(3)
      expect(() => parseZmqMessage(sparse)).toThrow(
        expect.objectContaining({ name: 'ZmqFrameError', code: 'frame_type' })
      )
    }
    // A Uint8Array from another realm is one: instanceof would refuse it.
    const foreign = runInNewContext('[new Uint8Array(Buffer.from("hashtx")), new Uint8Array(32), new Uint8Array(4)]', {
      Buffer,
    }) as Uint8Array[]
    expect(foreign[0]).not.toBeInstanceOf(Uint8Array)
    expect(parseZmqMessage(foreign)).toMatchObject({ topic: 'hashtx', sequence: 0 })
    // frames itself must be an array: a caller's mistake, never a publisher's.
    expect(() => parseZmqMessage(null as unknown as Uint8Array[])).toThrow(TypeError)
    expect(() => parseZmqMessage('abc' as unknown as Uint8Array[])).toThrow(TypeError)
  })

  it('takes raw bodies up to 2,000,000 bytes and no more', () => {
    for (const [topic, length, ok] of [
      ['rawblock', 2_000_000, true],
      ['rawblock', 2_000_001, false],
      ['rawtx', 2_000_000, true],
      ['rawtx', 2_000_001, false],
    ] as const) {
      expect(describeOutcome([Buffer.from(topic), new Uint8Array(length), Buffer.alloc(4)])).toEqual(
        ok ? expect.objectContaining({ topic }) : 'body_length'
      )
    }
  })
})

type Op =
  | { readonly kind: 'observe'; readonly topic: (typeof ZMQ_TOPICS)[number]; readonly step: Step }
  | { readonly kind: 'uncertain' }
  | { readonly kind: 'reset' }
type Step =
  | { readonly kind: 'next' }
  | { readonly kind: 'repeat' }
  | { readonly kind: 'skip'; readonly by: number }
  | { readonly kind: 'value'; readonly value: number }

/** The tracker's contract, written with plain modular arithmetic. */
class ModelTracker {
  readonly last = new Map<string, number>()
  readonly uncertain = new Set<string>()

  observe(topic: (typeof ZMQ_TOPICS)[number], sequence: number): SequenceGap | undefined {
    const last = this.last.get(topic)
    this.last.set(topic, sequence)
    if (last === undefined) return undefined
    const expected = (last + 1) % 2 ** 32
    const wasUncertain = this.uncertain.delete(topic)
    if (wasUncertain) return { topic, expected, received: sequence }
    if (sequence === expected) return undefined
    const forward = (((sequence - expected) % 2 ** 32) + 2 ** 32) % 2 ** 32
    return forward < 2 ** 31
      ? { topic, expected, received: sequence, missed: forward }
      : { topic, expected, received: sequence }
  }
}

describe('SequenceTracker properties', () => {
  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 6, arbitrary: fc.constant({ kind: 'next' as const }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'repeat' as const }) },
    { weight: 2, arbitrary: fc.integer({ min: 1, max: 0xffff_ffff }).map(by => ({ kind: 'skip' as const, by })) },
    {
      weight: 2,
      arbitrary: fc
        .oneof(fc.integer({ min: 0, max: 0xffff_ffff }), fc.constantFrom(0, 1, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff))
        .map(value => ({ kind: 'value' as const, value })),
    }
  )
  const op: fc.Arbitrary<Op> = fc.oneof(
    {
      weight: 12,
      arbitrary: fc.record({ kind: fc.constant('observe' as const), topic: fc.constantFrom(...ZMQ_TOPICS), step }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: 'uncertain' as const }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'reset' as const }) }
  )

  it(
    'reports exactly the gaps the model reports, across wraps, restarts and reconnects',
    () => {
      fc.assert(
        fc.property(fc.array(op, { maxLength: 60 }), ops => {
          const tracker = new SequenceTracker()
          let reference = new ModelTracker()
          for (const o of ops) {
            if (o.kind === 'reset') {
              tracker.reset()
              reference = new ModelTracker()
              continue
            }
            if (o.kind === 'uncertain') {
              tracker.markUncertain()
              for (const topic of reference.last.keys()) reference.uncertain.add(topic)
              continue
            }
            const last = reference.last.get(o.topic) ?? 0
            const sequence =
              o.step.kind === 'next'
                ? (last + 1) % 2 ** 32
                : o.step.kind === 'repeat'
                  ? last
                  : o.step.kind === 'skip'
                    ? (last + 1 + o.step.by) % 2 ** 32
                    : o.step.value
            expect(tracker.observe(o.topic, sequence)).toEqual(reference.observe(o.topic, sequence))
          }
        }),
        fuzz(1000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'refuses any sequence outside 0 to 2^32 - 1 with a RangeError, and keeps its baseline',
    () => {
      const bad = fc.oneof(
        fc.integer({ max: -1 }),
        fc.integer({ min: 2 ** 32, max: Number.MAX_SAFE_INTEGER }),
        fc.double().filter(value => !Number.isInteger(value)),
        fc.constantFrom(-0.5, 2 ** 32, Infinity, -Infinity, NaN)
      )
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 0xfffffffe }), bad, (start, value) => {
          const tracker = new SequenceTracker()
          tracker.observe('hashtx', start)
          expect(() => tracker.observe('hashtx', value)).toThrow(RangeError)
          expect(tracker.observe('hashtx', start + 1)).toBeUndefined()
        }),
        fuzz(500)
      )
    },
    FUZZ_TIMEOUT_MS
  )
})
