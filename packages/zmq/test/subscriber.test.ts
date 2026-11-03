import { describe, expect, it } from 'vitest'
import { Publisher } from 'zeromq'

import { QbitZmqSubscriber, type ZmqEvent, type ZmqSocket } from '../src'

const HASH = '12'.repeat(32)
const counter = (sequence: number): Buffer => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(sequence)
  return buffer
}
const hashblock = (sequence: number): Buffer[] => [
  Buffer.from('hashblock'),
  Buffer.from(HASH, 'hex'),
  counter(sequence),
]

class FakeSocket implements ZmqSocket {
  connectedTo: string | undefined
  readonly subscribed: string[] = []
  closed = false
  readonly #script: (readonly Uint8Array[] | Error)[]
  #pending: ((error: Error) => void) | undefined

  constructor(script: (readonly Uint8Array[] | Error)[]) {
    this.#script = script
  }
  connect(url: string): void {
    this.connectedTo = url
  }
  subscribe(topic: string): void {
    this.subscribed.push(topic)
  }
  receive(): Promise<readonly Uint8Array[]> {
    const next = this.#script.shift()
    if (next instanceof Error) return Promise.reject(next)
    if (next !== undefined) return Promise.resolve(next)
    // Like zeromq: a receive pending at close() rejects.
    return new Promise((_resolve, reject) => {
      this.#pending = reject
    })
  }
  close(): void {
    this.closed = true
    this.#pending?.(Object.assign(new Error('Socket is closed'), { code: 'EAGAIN' }))
  }
}

async function take(iterator: AsyncIterator<ZmqEvent>, count: number): Promise<ZmqEvent[]> {
  const events: ZmqEvent[] = []
  for (let i = 0; i < count; i += 1) {
    const next = await iterator.next()
    if (next.done) break
    events.push(next.value)
  }
  return events
}

describe('QbitZmqSubscriber with a fake socket', () => {
  it('reports unknown until a message arrives, yields gaps, and keeps counting across a reconnect', async () => {
    const first = new FakeSocket([
      hashblock(1),
      hashblock(2),
      hashblock(5),
      Object.assign(new Error('EFSM'), { code: 'EFSM' }),
    ])
    const second = new FakeSocket([
      hashblock(9),
      [Buffer.from('hashblock'), Buffer.alloc(3), counter(10)],
      hashblock(10),
    ])
    const sockets = [first, second]
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:28332',
      topics: ['hashblock', 'sequence'],
      reconnectDelayMs: 10,
      staleAfterMs: 60_000,
      socketFactory: () => sockets.shift()!,
    })
    expect(subscriber.health()).toMatchObject({ status: 'unknown', messages: 0 })
    expect(subscriber.health()).not.toHaveProperty('lastMessageAt')

    const iterator = subscriber[Symbol.asyncIterator]()
    const events = await take(iterator, 9)
    expect(events.map(event => event.kind)).toEqual([
      'message',
      'message',
      'gap',
      'message',
      'reconnect',
      'gap',
      'message',
      'malformed',
      'message',
    ])
    expect(events[2]).toEqual({ kind: 'gap', topic: 'hashblock', expected: 3, received: 5, missed: 2 })
    expect(events[4]).toEqual({ kind: 'reconnect', attempt: 1, code: 'EFSM' })
    // Messages lost while the socket was replaced show up as a gap.
    expect(events[5]).toEqual({ kind: 'gap', topic: 'hashblock', expected: 6, received: 9, missed: 3 })
    expect(events[7]).toMatchObject({ kind: 'malformed', error: { code: 'body_length' } })
    const message = events[0]
    expect(message?.kind === 'message' && message.message).toEqual({
      topic: 'hashblock',
      sequence: 1,
      hash: '12'.repeat(32),
    })
    expect(first).toMatchObject({
      connectedTo: 'tcp://127.0.0.1:28332',
      subscribed: ['hashblock', 'sequence'],
      closed: true,
    })

    const health = subscriber.health()
    expect(health).toMatchObject({ status: 'receiving', messages: 5, gaps: 2, malformed: 1, reconnects: 1 })
    expect(subscriber.health(health.lastMessageAt! + 60_001).status).toBe('stale')

    const done = iterator.next()
    subscriber.close()
    expect(await done).toEqual({ done: true, value: undefined })
    expect(second.closed).toBe(true)
    expect(subscriber.health().status).toBe('closed')
  })

  it('goes back to unknown after a socket fails, until the new one delivers', async () => {
    const sockets = [new FakeSocket([hashblock(1), new Error('lost')]), new FakeSocket([])]
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      reconnectDelayMs: 10,
      socketFactory: () => sockets.shift()!,
    })
    const iterator = subscriber[Symbol.asyncIterator]()
    await take(iterator, 1)
    expect(subscriber.health().status).toBe('receiving')
    expect((await take(iterator, 1))[0]).toEqual({ kind: 'reconnect', attempt: 1 })
    expect(subscriber.health().status).toBe('unknown')
    expect(subscriber.health().lastMessageAt).toBeTypeOf('number')
    const pending = iterator.next()
    subscriber.close()
    expect((await pending).done).toBe(true)
  })

  it('closes during the reconnect delay without waiting it out, and closes the socket on break', async () => {
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashtx'],
      reconnectDelayMs: 60_000,
      socketFactory: () => new FakeSocket([new Error('boom')]),
    })
    const iterator = subscriber[Symbol.asyncIterator]()
    expect((await take(iterator, 1))[0]?.kind).toBe('reconnect')
    const pending = iterator.next()
    const started = performance.now()
    subscriber.close()
    expect((await pending).done).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)

    const socket = new FakeSocket([hashblock(1), hashblock(2)])
    const other = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      socketFactory: () => socket,
    })
    for await (const event of other) {
      expect(event.kind).toBe('message')
      break
    }
    expect(socket.closed).toBe(true)
  })

  it('allows one consumer at a time and validates options', async () => {
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['rawtx'],
      socketFactory: () => new FakeSocket([]),
    })
    const first = subscriber[Symbol.asyncIterator]()
    const pending = first.next()
    await new Promise(resolve => setImmediate(resolve))
    await expect(subscriber[Symbol.asyncIterator]().next()).rejects.toThrow(/already has a consumer/)
    subscriber.close()
    await pending

    const base = { url: 'tcp://127.0.0.1:1', topics: ['hashtx'] as const }
    expect(() => new QbitZmqSubscriber({ ...base, url: 'http://x' })).toThrow(TypeError)
    expect(() => new QbitZmqSubscriber({ ...base, topics: [] })).toThrow(TypeError)
    expect(() => new QbitZmqSubscriber({ ...base, topics: ['pubhashtx' as never] })).toThrow(TypeError)
    expect(() => new QbitZmqSubscriber({ ...base, topics: ['hashtx', 'hashtx'] })).toThrow(TypeError)
    expect(() => new QbitZmqSubscriber({ ...base, reconnectDelayMs: 0 })).toThrow(RangeError)
    expect(() => new QbitZmqSubscriber({ ...base, staleAfterMs: Number.NaN })).toThrow(RangeError)
  })
})

describe('QbitZmqSubscriber over loopback with zeromq', () => {
  it('receives qbit-format messages from a real publisher and detects a gap', async () => {
    const publisher = new Publisher()
    await publisher.bind('tcp://127.0.0.1:0')
    const url = publisher.lastEndpoint!
    const subscriber = new QbitZmqSubscriber({ url, topics: ['hashblock', 'sequence'], reconnectDelayMs: 50 })
    const iterator = subscriber[Symbol.asyncIterator]()
    const received: ZmqEvent[] = []
    const reading = (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        received.push(next.value)
      }
    })()
    try {
      expect(subscriber.health().status).toBe('unknown')
      // PUB/SUB drops messages until the subscription has propagated: publish
      // consecutive counters until one lands, then let stragglers arrive.
      let next = 0
      const deadline = Date.now() + 5000
      while (!received.some(event => event.kind === 'message') && Date.now() < deadline) {
        await publisher.send(hashblock(next++))
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(subscriber.health().status).toBe('receiving')
      expect(received.some(event => event.kind === 'gap')).toBe(false)
      const before = received.length
      const body = Buffer.concat([Buffer.from(HASH, 'hex'), Buffer.from('A'), Buffer.alloc(8, 0)])
      await publisher.send([Buffer.from('sequence'), body, counter(0)])
      await publisher.send([Buffer.from('rawtx'), Buffer.alloc(20), counter(0)]) // not subscribed
      await publisher.send(hashblock(next))
      await publisher.send(hashblock(next + 3))
      await expect.poll(() => received.length - before, { timeout: 5000 }).toBe(4)
      const tail = received.slice(before)
      expect(tail[0]).toMatchObject({
        kind: 'message',
        message: { topic: 'sequence', event: 'mempool_added', mempoolSequence: 0n },
      })
      expect(tail[1]).toMatchObject({ kind: 'message', message: { topic: 'hashblock', sequence: next } })
      expect(tail[2]).toEqual({ kind: 'gap', topic: 'hashblock', expected: next + 1, received: next + 3, missed: 2 })
      expect(tail[3]).toMatchObject({ kind: 'message', message: { topic: 'hashblock', sequence: next + 3 } })
    } finally {
      subscriber.close()
      await reading
      publisher.close()
    }
    expect(subscriber.health().status).toBe('closed')
  })
})
