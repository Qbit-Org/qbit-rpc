import { describe, expect, it } from 'vitest'
import { Publisher } from 'zeromq'

import {
  createZeromqSocket,
  DEFAULT_MAX_MESSAGE_SIZE,
  DEFAULT_STALE_AFTER_MS,
  QbitZmqSubscriber,
  type ZmqEvent,
  type ZmqSocket,
  type ZmqSocketSettings,
} from '../src'

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

/** A fake socket with zeromq's `events.on('disconnect')`. */
class EventfulFakeSocket extends FakeSocket {
  readonly #listeners: (() => void)[] = []
  readonly events = {
    on: (_type: 'disconnect', listener: () => void): void => {
      this.#listeners.push(listener)
    },
  }
  disconnect(): void {
    for (const listener of this.#listeners) listener()
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
    expect(events[4]).toEqual({ kind: 'reconnect', attempt: 1, reason: 'failed', code: 'EFSM' })
    // Messages lost while the socket was replaced show up as a gap. How many is
    // unknown: the publisher may have restarted meanwhile.
    expect(events[5]).toEqual({ kind: 'gap', topic: 'hashblock', expected: 6, received: 9 })
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
    expect((await take(iterator, 1))[0]).toEqual({ kind: 'reconnect', attempt: 1, reason: 'failed' })
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

describe('QbitZmqSubscriber connection loss and limits', () => {
  it('reports unknown at once when the connection drops, replaces the socket, and flags the next message as a gap', async () => {
    const first = new EventfulFakeSocket([hashblock(7)])
    const second = new EventfulFakeSocket([hashblock(8)])
    const sockets = [first, second]
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      reconnectDelayMs: 10,
      socketFactory: () => sockets.shift()!,
    })
    const iterator = subscriber[Symbol.asyncIterator]()
    await take(iterator, 1)
    expect(subscriber.health().status).toBe('receiving')
    const pending = iterator.next()
    first.disconnect() // qbitd stopped: zeromq would otherwise reconnect silently
    expect(subscriber.health().status).toBe('unknown')
    expect((await pending).value).toEqual({ kind: 'reconnect', attempt: 1, reason: 'disconnected' })
    expect(first.closed).toBe(true)
    // The counter follows on, but messages may have been lost: still a gap.
    expect(await take(iterator, 2)).toEqual([
      { kind: 'gap', topic: 'hashblock', expected: 8, received: 8 },
      expect.objectContaining({ kind: 'message' }),
    ])
    const done = iterator.next()
    subscriber.close()
    await done
  })

  it('goes stale by default, without staleAfterMs', async () => {
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      socketFactory: () => new FakeSocket([hashblock(1)]),
    })
    const iterator = subscriber[Symbol.asyncIterator]()
    await take(iterator, 1)
    const at = subscriber.health().lastMessageAt!
    expect(subscriber.health(at + DEFAULT_STALE_AFTER_MS).status).toBe('receiving')
    expect(subscriber.health(at + DEFAULT_STALE_AFTER_MS + 1).status).toBe('stale')
    const done = iterator.next()
    subscriber.close()
    await done
  })

  it('caps the inbound message size: default, configured, and passed to a custom factory', async () => {
    expect(DEFAULT_MAX_MESSAGE_SIZE).toBe(2_065_536)
    const defaults = (await createZeromqSocket()) as ZmqSocket & { maxMessageSize: number }
    expect(defaults.maxMessageSize).toBe(DEFAULT_MAX_MESSAGE_SIZE)
    defaults.close()
    const custom = (await createZeromqSocket({ maxMessageSize: 4096 })) as ZmqSocket & { maxMessageSize: number }
    expect(custom.maxMessageSize).toBe(4096)
    custom.close()

    const seen: ZmqSocketSettings[] = []
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['rawblock'],
      maxMessageSize: 3_000_000,
      socketFactory: settings => {
        seen.push(settings)
        return new FakeSocket([])
      },
    })
    const pending = subscriber[Symbol.asyncIterator]().next()
    await new Promise(resolve => setImmediate(resolve))
    expect(seen).toEqual([{ maxMessageSize: 3_000_000 }])
    subscriber.close()
    await pending
    const base = { url: 'tcp://127.0.0.1:1', topics: ['rawtx'] as const }
    for (const maxMessageSize of [0, 1023, 1.5, Number.NaN, 2 ** 31]) {
      expect(() => new QbitZmqSubscriber({ ...base, maxMessageSize })).toThrow(RangeError)
    }
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

  /** Collect events in the background; returns the list and a stop function. */
  function collect(subscriber: QbitZmqSubscriber): { events: ZmqEvent[]; stop: () => Promise<void> } {
    const events: ZmqEvent[] = []
    const iterator = subscriber[Symbol.asyncIterator]()
    const reading = (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        events.push(next.value)
      }
    })()
    return {
      events,
      stop: async () => {
        subscriber.close()
        await reading
      },
    }
  }

  async function publishUntilReceived(publisher: Publisher, events: ZmqEvent[], first: number): Promise<number> {
    let next = first
    const start = events.length
    const deadline = Date.now() + 5000
    while (!events.slice(start).some(event => event.kind === 'message') && Date.now() < deadline) {
      await publisher.send(hashblock(next++))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    return next
  }

  it('reports unknown when the publisher dies, and a gap after it restarts with a counter that lines up', async () => {
    let publisher = new Publisher()
    await publisher.bind('tcp://127.0.0.1:0')
    const url = publisher.lastEndpoint!
    const subscriber = new QbitZmqSubscriber({ url, topics: ['hashblock'], reconnectDelayMs: 50 })
    const { events, stop } = collect(subscriber)
    try {
      const next = await publishUntilReceived(publisher, events, 0)
      expect(subscriber.health().status).toBe('receiving')
      publisher.close() // qbitd stops
      await expect.poll(() => subscriber.health().status, { timeout: 5000 }).toBe('unknown')
      expect(events.some(e => e.kind === 'reconnect' && e.reason === 'disconnected')).toBe(true)
      // qbitd restarts; its counter happens to continue where the old one stopped.
      publisher = new Publisher()
      await publisher.bind(url)
      const before = events.length
      await publishUntilReceived(publisher, events, next)
      const gaps = events.slice(before).filter(e => e.kind === 'gap')
      expect(gaps[0]).toMatchObject({ kind: 'gap', topic: 'hashblock' })
      expect(gaps[0]).not.toHaveProperty('missed')
      expect(subscriber.health().status).toBe('receiving')
    } finally {
      await stop()
      publisher.close()
    }
  })

  it('drops an oversized message instead of buffering it, and recovers', async () => {
    const publisher = new Publisher()
    await publisher.bind('tcp://127.0.0.1:0')
    const subscriber = new QbitZmqSubscriber({
      url: publisher.lastEndpoint!,
      topics: ['hashblock', 'rawtx'],
      reconnectDelayMs: 50,
      maxMessageSize: 4096,
    })
    const { events, stop } = collect(subscriber)
    try {
      const next = await publishUntilReceived(publisher, events, 0)
      await publisher.send([Buffer.from('rawtx'), Buffer.alloc(8192, 1), counter(0)])
      await expect
        .poll(() => events.some(e => e.kind === 'reconnect' && e.reason === 'disconnected'), { timeout: 5000 })
        .toBe(true)
      const before = events.length
      await publishUntilReceived(publisher, events, next)
      expect(events.some(e => e.kind === 'message' && e.message.topic === 'rawtx')).toBe(false)
      expect(events.slice(before).some(e => e.kind === 'message' && e.message.topic === 'hashblock')).toBe(true)
    } finally {
      await stop()
      publisher.close()
    }
  })
})
