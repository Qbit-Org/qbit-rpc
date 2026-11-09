import { execFileSync, spawn } from 'node:child_process'
import { stat } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'
import { Publisher, Subscriber } from 'zeromq'

import {
  createZeromqSocket,
  QbitZmqSubscriber,
  ZmqSetupError,
  type QbitZmqSubscriberOptions,
  type ZmqEvent,
  type ZmqReconnectCode,
  type ZmqSetupErrorCode,
  type ZmqSocket,
  type ZmqSocketFactory,
  type ZmqSocketSettings,
} from '../src'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_TTL_MS,
  DEFAULT_MAX_MESSAGE_SIZE,
  DEFAULT_STALE_AFTER_MS,
} from '../src/subscriber'

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

type SocketEvent = 'disconnect' | 'close' | 'handshake'

/** A fake socket with zeromq's `events`: its handshake completes at `connect()`, unless `handshakes` is false. */
class EventfulFakeSocket extends FakeSocket {
  readonly #listeners = new Map<SocketEvent, (() => void)[]>()
  readonly #handshakes: boolean
  readonly events = {
    on: (type: SocketEvent, listener: () => void): void => {
      this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
    },
  }
  constructor(script: (readonly Uint8Array[] | Error)[], handshakes = true) {
    super(script)
    this.#handshakes = handshakes
  }
  override connect(url: string): void {
    super.connect(url)
    if (this.#handshakes) this.emit('handshake')
  }
  emit(type: SocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener()
  }
  disconnect(): void {
    this.emit('disconnect')
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

  it('replaces a socket whose connection attempt fails or never completes its handshake, as failed', async () => {
    // libzmq does not reconnect a createZeromqSocket socket by itself: a refused
    // attempt emits `close`, a stalled greeting `disconnect` before any
    // `handshake`, and a host name that does not resolve nothing at all.
    const refused = new EventfulFakeSocket([], false)
    const unresolved = new EventfulFakeSocket([], false)
    const ungreeted = new EventfulFakeSocket([], false)
    const working = new EventfulFakeSocket([hashblock(1)])
    const sockets = [refused, unresolved, ungreeted, working]
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      reconnectDelayMs: 10,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 150,
      socketFactory: () => sockets.shift()!,
    })
    const iterator = subscriber[Symbol.asyncIterator]()
    let pending = iterator.next()
    await new Promise(resolve => setImmediate(resolve))
    refused.emit('close')
    expect((await pending).value).toEqual({ kind: 'reconnect', attempt: 1, reason: 'failed' })
    expect(refused.closed).toBe(true)
    // No event at all: replaced after heartbeatIntervalMs + heartbeatTimeoutMs.
    const started = performance.now()
    expect((await iterator.next()).value).toEqual({ kind: 'reconnect', attempt: 2, reason: 'failed' })
    expect(performance.now() - started).toBeGreaterThanOrEqual(250 - 5)
    expect(unresolved.closed).toBe(true)
    pending = iterator.next()
    await new Promise(resolve => setImmediate(resolve))
    ungreeted.disconnect()
    expect((await pending).value).toEqual({ kind: 'reconnect', attempt: 3, reason: 'failed' })
    // Once the handshake is done the deadline no longer applies.
    expect((await take(iterator, 1)).map(event => event.kind)).toEqual(['message'])
    pending = iterator.next()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(subscriber.health()).toMatchObject({ status: 'receiving', reconnects: 3 })
    expect(working.closed).toBe(false)
    working.disconnect()
    expect((await pending).value).toEqual({ kind: 'reconnect', attempt: 4, reason: 'disconnected' })
    const done = iterator.next()
    subscriber.close()
    await done
  })

  it('counts the first message as the handshake of a socket whose events emit none', async () => {
    // Its events emit only disconnect and close: without the message, it would be given up at 200 ms.
    const quiet = new EventfulFakeSocket([hashblock(1)], false)
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      reconnectDelayMs: 10,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 100,
      socketFactory: () => quiet,
    })
    const iterator = subscriber[Symbol.asyncIterator]()
    expect((await take(iterator, 1)).map(event => event.kind)).toEqual(['message'])
    const pending = iterator.next()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(quiet.closed).toBe(false)
    quiet.disconnect()
    expect((await pending).value).toEqual({ kind: 'reconnect', attempt: 1, reason: 'disconnected' })
    const done = iterator.next()
    subscriber.close()
    await done
  })

  it('counts a handshake that waited behind a blocked event loop, and gives the socket up only after it', async () => {
    const late = new EventfulFakeSocket([], false)
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      reconnectDelayMs: 10,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 100,
      socketFactory: () => late,
    })
    const iterator = subscriber[Symbol.asyncIterator]()
    const pending = iterator.next()
    await new Promise(resolve => setImmediate(resolve))
    // The handshake's I/O completes while the loop is blocked past the 200 ms deadline,
    // so the expired timer runs first in the next turn, before that I/O callback.
    stat(fileURLToPath(import.meta.url), () => late.emit('handshake'))
    const until = performance.now() + 300
    while (performance.now() < until) {
      // blocked
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(late.closed).toBe(false)
    subscriber.close()
    expect((await pending).done).toBe(true)
  })

  it('goes stale by default, without staleAfterMs', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] })
    try {
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
      vi.advanceTimersByTime(DEFAULT_STALE_AFTER_MS)
      expect(subscriber.health().status).toBe('receiving')
      vi.advanceTimersByTime(1)
      expect(subscriber.health().status).toBe('stale')
      const done = iterator.next()
      subscriber.close()
      await done
    } finally {
      vi.useRealTimers()
    }
  })

  it('measures staleness on the monotonic clock: a step in the wall clock does not change it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] })
    try {
      const subscriber = new QbitZmqSubscriber({
        url: 'tcp://127.0.0.1:1',
        topics: ['hashblock'],
        staleAfterMs: 60_000,
        socketFactory: () => new FakeSocket([hashblock(1)]),
      })
      const iterator = subscriber[Symbol.asyncIterator]()
      const at = Date.now()
      expect(await take(iterator, 1)).toEqual([expect.objectContaining({ kind: 'message', receivedAt: at })])

      // The wall clock jumps an hour ahead (an NTP step, a resumed VM): the
      // message is still fresh, and lastMessageAt is still its receipt time.
      vi.setSystemTime(at + 3_600_000)
      expect(subscriber.health()).toMatchObject({ status: 'receiving', lastMessageAt: at })
      expect(subscriber.health(Date.now()).status).toBe('receiving')
      expect(subscriber.health(Date.now() + 60_000).status).toBe('receiving')
      expect(subscriber.health(Date.now() + 60_001).status).toBe('stale')

      // A minute later it is stale, and a jump back in the wall clock does not
      // make it fresh again.
      vi.advanceTimersByTime(60_001)
      expect(subscriber.health().status).toBe('stale')
      vi.setSystemTime(at - 3_600_000)
      expect(subscriber.health()).toMatchObject({ status: 'stale', lastMessageAt: at })
      expect(subscriber.health(Date.now()).status).toBe('stale')

      const done = iterator.next()
      subscriber.close()
      await done
    } finally {
      vi.useRealTimers()
    }
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
    expect(seen).toEqual([
      {
        maxMessageSize: 3_000_000,
        ipv6: false,
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 20_000,
        heartbeatTtlMs: 30_000,
        handshakeIntervalMs: 30_000,
      },
    ])
    subscriber.close()
    await pending
    const base = { url: 'tcp://127.0.0.1:1', topics: ['rawtx'] as const }
    for (const maxMessageSize of [0, 1023, 1.5, Number.NaN, 2 ** 31]) {
      expect(() => new QbitZmqSubscriber({ ...base, maxMessageSize })).toThrow(RangeError)
    }
  })
})

/** The error the iteration rejects with. */
async function failure(iterator: AsyncIterator<ZmqEvent>): Promise<unknown> {
  return iterator.next().then(
    next => expect.unreachable(`resolved with ${JSON.stringify(next)}`),
    (error: unknown) => error
  )
}

function expectSetupError(error: unknown, code: ZmqSetupErrorCode, cause: unknown): asserts error is ZmqSetupError {
  expect(error).toBeInstanceOf(ZmqSetupError)
  expect(error).toMatchObject({ name: 'ZmqSetupError', code })
  expect((error as ZmqSetupError).cause).toBe(cause)
}

/** Calls the error's thrower, and returns what it throws. */
function thrown(thrower: () => unknown): Error & { code?: string } {
  try {
    thrower()
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('did not throw')
}

describe('QbitZmqSubscriber heartbeat and TCP keepalive options', () => {
  /** The settings the subscriber passes its factory for `options`. */
  async function settingsFor(options: Partial<QbitZmqSubscriberOptions>): Promise<ZmqSocketSettings> {
    const seen: ZmqSocketSettings[] = []
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      ...options,
      socketFactory: settings => {
        seen.push(settings)
        return new FakeSocket([])
      },
    })
    const pending = subscriber[Symbol.asyncIterator]().next()
    await new Promise(resolve => setImmediate(resolve))
    subscriber.close()
    await pending
    return seen[0]!
  }

  it('heartbeats every 10 s with a 20 s timeout by default, and passes what is set to a custom factory', async () => {
    expect([DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_TIMEOUT_MS, DEFAULT_HEARTBEAT_TTL_MS]).toEqual([
      10_000, 20_000, 30_000,
    ])
    expect(await settingsFor({})).toEqual({
      maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
      ipv6: false,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 20_000,
      heartbeatTtlMs: 30_000,
      handshakeIntervalMs: 30_000,
    })
    // The default TTL allows a missed PING, after libzmq rounds it down to a
    // multiple of 100, and is off without heartbeats.
    expect(await settingsFor({ heartbeatIntervalMs: 20_000 })).toMatchObject({ heartbeatTtlMs: 40_000 })
    expect(await settingsFor({ heartbeatIntervalMs: 15_050 })).toMatchObject({ heartbeatTtlMs: 30_100 })
    expect(await settingsFor({ heartbeatIntervalMs: 15_055 })).toMatchObject({ heartbeatTtlMs: 30_200 })
    expect(await settingsFor({ heartbeatIntervalMs: 0 })).toMatchObject({ heartbeatTtlMs: 0 })
    expect(await settingsFor({ heartbeatIntervalMs: 3_600_000 })).toMatchObject({ heartbeatTtlMs: 0 })
    expect(
      await settingsFor({
        heartbeatIntervalMs: 0,
        heartbeatTimeoutMs: 100,
        heartbeatTtlMs: 100,
        tcpKeepalive: false,
      })
    ).toEqual({
      maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
      ipv6: false,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 100,
      heartbeatTtlMs: 100,
      // libzmq's default: without heartbeats there is no shorter bound to keep.
      handshakeIntervalMs: 30_000,
      tcpKeepalive: false,
    })
    // Unused without heartbeats, the timeout and the TTL may both be 0.
    expect(await settingsFor({ heartbeatIntervalMs: 0, heartbeatTimeoutMs: 0, heartbeatTtlMs: 0 })).toMatchObject({
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
      heartbeatTtlMs: 0,
    })
    expect(
      await settingsFor({
        heartbeatIntervalMs: 3_600_000,
        heartbeatTimeoutMs: 3_600_000,
        heartbeatTtlMs: 0,
        tcpKeepalive: true,
        tcpKeepaliveIdleSeconds: 32_767,
        tcpKeepaliveIntervalSeconds: 1,
        tcpKeepaliveCount: 127,
      })
    ).toMatchObject({
      heartbeatIntervalMs: 3_600_000,
      heartbeatTimeoutMs: 3_600_000,
      heartbeatTtlMs: 0,
      handshakeIntervalMs: 7_200_000,
      tcpKeepalive: true,
      tcpKeepaliveIdleSeconds: 32_767,
      tcpKeepaliveIntervalSeconds: 1,
      tcpKeepaliveCount: 127,
    })
    expect(await settingsFor({ heartbeatIntervalMs: 100, heartbeatTtlMs: 200 })).toMatchObject({
      heartbeatIntervalMs: 100,
      heartbeatTtlMs: 200,
      handshakeIntervalMs: 20_100,
    })
    // libzmq sends 30,150 as 30,100: still twice 15,050.
    expect(await settingsFor({ heartbeatIntervalMs: 15_050, heartbeatTtlMs: 30_150 })).toMatchObject({
      heartbeatTtlMs: 30_150,
    })
    expect(await settingsFor({ heartbeatTtlMs: 6_553_500 })).toMatchObject({ heartbeatTtlMs: 6_553_500 })
  })

  it('refuses out-of-range values, a TTL under twice the interval, keepalive settings without keepalive, and keepalive over ipc', () => {
    const base = { url: 'tcp://127.0.0.1:1', topics: ['hashblock'] as const }
    const refused: [Partial<QbitZmqSubscriberOptions>, ErrorConstructor | RangeErrorConstructor, string][] = []
    for (const value of [-1, 1, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      refused.push([{ heartbeatIntervalMs: value }, RangeError, 'heartbeatIntervalMs must be 0 or an integer from 100'])
      refused.push([{ heartbeatTtlMs: value }, RangeError, 'heartbeatTtlMs must be 0 or an integer from 100'])
    }
    refused.push([{ heartbeatIntervalMs: 3_600_001 }, RangeError, 'heartbeatIntervalMs must be 0 or an integer'])
    for (const value of [0, 99, 1.5, Number.NaN, 3_600_001]) {
      refused.push([{ heartbeatTimeoutMs: value }, RangeError, 'heartbeatTimeoutMs must be an integer from 100'])
    }
    refused.push([{ heartbeatTtlMs: 6_553_600 }, RangeError, 'heartbeatTtlMs must be 0 or an integer'])
    // Unused without heartbeats, the timeout may be 0, but not out of range.
    refused.push([
      { heartbeatIntervalMs: 0, heartbeatTimeoutMs: 99 },
      RangeError,
      'heartbeatTimeoutMs must be 0 or an integer from 100',
    ])
    // qbitd drops a healthy subscriber whose TTL runs out before its next heartbeat.
    refused.push([{ heartbeatTtlMs: 19_999 }, RangeError, 'at least twice heartbeatIntervalMs: at least 20000'])
    refused.push([{ heartbeatIntervalMs: 1000, heartbeatTtlMs: 1000 }, RangeError, 'at least twice'])
    // libzmq rounds the TTL down to whole deciseconds: 310 is sent as 300, under twice 155.
    refused.push([{ heartbeatIntervalMs: 155, heartbeatTtlMs: 310 }, RangeError, 'rounded down to a multiple of 100'])
    refused.push([{ heartbeatIntervalMs: 155, heartbeatTtlMs: 399 }, RangeError, 'at least 400'])
    refused.push([{ heartbeatIntervalMs: 15_055, heartbeatTtlMs: 30_150 }, RangeError, 'at least 30200'])
    refused.push([{ tcpKeepalive: 1 as unknown as boolean }, TypeError, 'tcpKeepalive must be a boolean'])
    for (const tcpKeepalive of [true, false]) {
      refused.push([{ url: 'ipc:///run/qbitd/zmq.sock', tcpKeepalive }, TypeError, 'tcpKeepalive is for a tcp:// url'])
    }
    for (const name of ['tcpKeepaliveIdleSeconds', 'tcpKeepaliveIntervalSeconds', 'tcpKeepaliveCount'] as const) {
      refused.push([{ [name]: 10 }, TypeError, `${name} needs tcpKeepalive: true`])
      refused.push([{ tcpKeepalive: false, [name]: 10 }, TypeError, `${name} needs tcpKeepalive: true`])
      for (const value of [0, -1, 1.5, Number.NaN, name === 'tcpKeepaliveCount' ? 128 : 32_768]) {
        refused.push([{ tcpKeepalive: true, [name]: value }, RangeError, `${name} must be an integer from 1 to`])
      }
    }
    for (const [options, type, message] of refused) {
      expect(() => new QbitZmqSubscriber({ ...base, ...options }), JSON.stringify(options)).toThrow(type)
      expect(() => new QbitZmqSubscriber({ ...base, ...options }), JSON.stringify(options)).toThrow(message)
    }
    // Without heartbeats, the TTL and timeout are unused, and only their ranges are checked.
    expect(() => new QbitZmqSubscriber({ ...base, heartbeatIntervalMs: 0, heartbeatTtlMs: 100 })).not.toThrow()
    expect(() => new QbitZmqSubscriber({ ...base, heartbeatIntervalMs: 0, heartbeatTimeoutMs: 0 })).not.toThrow()
    expect(() => new QbitZmqSubscriber({ ...base, heartbeatIntervalMs: 155, heartbeatTtlMs: 400 })).not.toThrow()
  })

  it("createZeromqSocket applies each setting, and leaves libzmq's defaults for those left out", async () => {
    type Options = ZmqSocket & Record<string, number>
    const defaults = (await createZeromqSocket({ maxMessageSize: 4096 })) as Options
    expect(defaults).toMatchObject({
      // Never set by a setting: libzmq does not reconnect it by itself.
      reconnectInterval: -1,
      handshakeInterval: 30_000,
      heartbeatInterval: 0,
      heartbeatTimeToLive: 0,
      tcpKeepalive: -1,
      tcpKeepaliveIdle: -1,
      tcpKeepaliveInterval: -1,
      tcpKeepaliveCount: -1,
    })
    defaults.close()
    const set = (await createZeromqSocket({
      maxMessageSize: 4096,
      heartbeatIntervalMs: 1500,
      heartbeatTimeoutMs: 2500,
      heartbeatTtlMs: 4000,
      handshakeIntervalMs: 4000,
      tcpKeepalive: true,
      tcpKeepaliveIdleSeconds: 42,
      tcpKeepaliveIntervalSeconds: 7,
      tcpKeepaliveCount: 3,
    })) as Options
    expect(set).toMatchObject({
      reconnectInterval: -1,
      handshakeInterval: 4000,
      heartbeatInterval: 1500,
      heartbeatTimeout: 2500,
      heartbeatTimeToLive: 4000,
      tcpKeepalive: 1,
      tcpKeepaliveIdle: 42,
      tcpKeepaliveInterval: 7,
      tcpKeepaliveCount: 3,
    })
    set.close()
    const off = (await createZeromqSocket({ maxMessageSize: 4096, tcpKeepalive: false })) as Options
    expect(off).toMatchObject({ tcpKeepalive: 0 })
    off.close()
  })

  it.runIf(process.platform === 'linux')('turns keepalive on for the TCP connection itself', async () => {
    const publisher = new Publisher()
    await publisher.bind('tcp://127.0.0.1:0')
    const url = publisher.lastEndpoint!
    const timers = async (settings: ZmqSocketSettings): Promise<string> => {
      const socket = await createZeromqSocket(settings)
      try {
        socket.connect(url)
        await new Promise(resolve => setTimeout(resolve, 200))
        // ss lists a keepalive timer, counting down from the idle time, only on a socket with SO_KEEPALIVE.
        return execFileSync('ss', ['-tno', 'state', 'established', 'dst', url.slice('tcp://'.length)], {
          encoding: 'utf8',
        })
      } finally {
        socket.close()
      }
    }
    try {
      expect(await timers({ maxMessageSize: 4096 })).not.toContain('keepalive')
      expect(
        await timers({ maxMessageSize: 4096, tcpKeepalive: true, tcpKeepaliveIdleSeconds: 42, tcpKeepaliveCount: 3 })
      ).toMatch(/timer:\(keepalive,4[12]sec,0\)/)
    } finally {
      publisher.close()
    }
  })
})

describe('QbitZmqSubscriber setup failures', () => {
  // What Node throws for a module that is missing, or a native addon it cannot load.
  const requireHere = createRequire(import.meta.url)
  const moduleLoadErrors = [
    thrown(() => requireHere('zeromq-not-installed')),
    thrown(() => process.dlopen({ exports: {} }, fileURLToPath(import.meta.url))),
    Object.assign(new Error("Cannot find package 'zeromq'"), { code: 'ERR_MODULE_NOT_FOUND' }),
  ]

  it('pins the codes Node throws for a missing module and an unloadable addon', () => {
    expect(moduleLoadErrors.map(error => error.code)).toEqual([
      'MODULE_NOT_FOUND',
      'ERR_DLOPEN_FAILED',
      'ERR_MODULE_NOT_FOUND',
    ])
  })

  it.each(moduleLoadErrors.map(error => [error.code, error] as const))(
    'ends the iteration when the factory throws %s, without a reconnect',
    async (_code, cause) => {
      let calls = 0
      const subscriber = new QbitZmqSubscriber({
        url: 'tcp://127.0.0.1:1',
        topics: ['hashblock'],
        reconnectDelayMs: 10,
        socketFactory: () => {
          calls += 1
          throw cause
        },
      })
      const events: ZmqEvent[] = []
      const error = await (async () => {
        try {
          for await (const event of subscriber) events.push(event)
        } catch (error) {
          return error
        }
        return undefined
      })()
      expectSetupError(error, 'module_load', cause)
      expect(error.message).toContain(`could not load a module (${cause.code}: `)
      expect(events).toEqual([])
      await new Promise(resolve => setTimeout(resolve, 50)) // nothing retries meanwhile
      expect(calls).toBe(1)
      expect(subscriber.health()).toEqual({ status: 'closed', messages: 0, gaps: 0, malformed: 0, reconnects: 0 })
    }
  )

  it('ends the iteration when connect() refuses the address or the transport, and closes the socket', async () => {
    // Real addon errors: a socket that connects somewhere other than the (valid) url.
    const cases: [string, string, ZmqSetupErrorCode][] = [
      ['tcp://127.0.0.1', 'EINVAL', 'invalid_address'],
      ['tcp://*:28332', 'EINVAL', 'invalid_address'],
      // A scheme libzmq knows no transport for: zeromq 6.8.0's build supports ws://, so that one connects.
      ['foo://127.0.0.1:28332', 'EPROTONOSUPPORT', 'unsupported_protocol'],
      [`ipc:///${'a'.repeat(107)}`, 'ENAMETOOLONG', 'invalid_address'],
    ]
    for (const [target, errno, code] of cases) {
      const closed: boolean[] = []
      const thrownByConnect: unknown[] = []
      let calls = 0
      const factory: ZmqSocketFactory = async settings => {
        calls += 1
        const real = await createZeromqSocket(settings)
        const index = closed.push(false) - 1
        return {
          connect: () => {
            try {
              real.connect(target)
            } catch (error) {
              thrownByConnect.push(error)
              throw error
            }
          },
          subscribe: topic => real.subscribe(topic),
          receive: () => real.receive(),
          close: () => {
            closed[index] = true
            real.close()
          },
        }
      }
      const subscriber = new QbitZmqSubscriber({
        url: 'tcp://127.0.0.1:28332',
        topics: ['hashblock'],
        reconnectDelayMs: 10,
        socketFactory: factory,
      })
      const iterator = subscriber[Symbol.asyncIterator]()
      const error = await failure(iterator)
      expect(thrownByConnect).toEqual([expect.objectContaining({ code: errno })])
      expectSetupError(error, code, thrownByConnect[0])
      expect(error.message).toContain(`tcp://127.0.0.1:28332 (${errno}: `)
      expect(await iterator.next()).toEqual({ done: true, value: undefined })
      expect(calls).toBe(1)
      expect(closed).toEqual([true])
      expect(subscriber.health().status).toBe('closed')
    }
  })

  it('ends the iteration for an ipc:// path too long for a Unix socket, with the default factory', async () => {
    const subscriber = new QbitZmqSubscriber({ url: `ipc:///${'a'.repeat(107)}`, topics: ['hashblock'] })
    const error = await failure(subscriber[Symbol.asyncIterator]())
    expect(error).toMatchObject({ code: 'invalid_address', cause: { code: 'ENAMETOOLONG' } })
    expect((error as Error).message).toMatch(/use a shorter ipc:\/\/ path$/)
    expect(subscriber.health().status).toBe('closed')
  })

  it('passes ipv6 to the factory for an IPv6 address only, and createZeromqSocket applies it', async () => {
    const seen: ZmqSocketSettings[] = []
    for (const url of ['tcp://[::1]:1', 'tcp://127.0.0.1:0;[::1]:1', 'tcp://localhost:1', 'ipc:///run/x']) {
      const subscriber = new QbitZmqSubscriber({
        url,
        topics: ['hashblock'],
        socketFactory: settings => {
          seen.push(settings)
          return new FakeSocket([])
        },
      })
      const pending = subscriber[Symbol.asyncIterator]().next()
      await new Promise(resolve => setImmediate(resolve))
      subscriber.close()
      await pending
    }
    expect(seen.map(settings => settings.ipv6)).toEqual([true, true, false, false])
    for (const settings of [
      { maxMessageSize: 4096, ipv6: true },
      { maxMessageSize: 4096, ipv6: false },
      { maxMessageSize: 4096 },
    ]) {
      const socket = (await createZeromqSocket(settings)) as ZmqSocket & { ipv6: boolean }
      expect(socket.ipv6).toBe(settings.ipv6 === true)
      socket.close()
    }
  })

  it("ends the iteration on a ZmqSetupError from the package's other build", async () => {
    // What instanceof cannot see: the class of the ESM build thrown into the CommonJS one, or the reverse.
    class OtherBuild extends Error {
      readonly code = 'module_load'
    }
    Object.defineProperty(OtherBuild.prototype, Symbol.for('qbit-zmq.ZmqSetupError'), { value: true })
    const foreign = new OtherBuild('no zeromq here')
    expect(foreign).not.toBeInstanceOf(ZmqSetupError)
    expect(ZmqSetupError.is(foreign)).toBe(true)
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      socketFactory: () => Promise.reject(foreign),
    })
    expect(await failure(subscriber[Symbol.asyncIterator]())).toBe(foreign)
    expect(subscriber.health().status).toBe('closed')
    // A look-alike without the brand is retried like any other failure.
    const unknown = Object.assign(new Error('odd'), { name: 'ZmqSetupError', code: 'module_load' })
    expect(ZmqSetupError.is(unknown)).toBe(false)
    const retried = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      reconnectDelayMs: 10,
      socketFactory: () => Promise.reject(unknown),
    })
    const iterator = retried[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ kind: 'reconnect', reason: 'failed' })
    retried.close()
    await iterator.return?.()
  })

  it('passes a ZmqSetupError from a custom factory or socket through', async () => {
    const thrownByFactory = new ZmqSetupError('module_load', 'no zeromq here')
    const first = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      socketFactory: () => Promise.reject(thrownByFactory),
    })
    expect(await failure(first[Symbol.asyncIterator]())).toBe(thrownByFactory)
    expect(thrownByFactory.cause).toBeUndefined()

    const thrownByReceive = new ZmqSetupError('unsupported_protocol', 'not here')
    const socket = new FakeSocket([hashblock(1), thrownByReceive])
    const second = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      socketFactory: () => socket,
    })
    const iterator = second[Symbol.asyncIterator]()
    expect((await take(iterator, 1))[0]?.kind).toBe('message')
    expect(await failure(iterator)).toBe(thrownByReceive)
    expect(socket.closed).toBe(true)
    // The counters are kept.
    expect(second.health()).toMatchObject({ status: 'closed', messages: 1, reconnects: 0 })
    expect(second.health().lastMessageAt).toBeTypeOf('number')
  })

  it('retries every other failure of the factory, connect() or a receive', async () => {
    const coded = (code: string): Error => Object.assign(new Error(code), { code })
    const steps: (() => ZmqSocket)[] = [
      () => {
        throw new Error('no socket') // no code
      },
      () => {
        throw coded('EMFILE')
      },
      () => {
        throw coded('EINVAL') // fatal only from connect()
      },
      () => Object.assign(new FakeSocket([]), { connect: (): void => thrown(coded('EAGAIN')) }),
      () => Object.assign(new FakeSocket([]), { connect: (): void => thrown(coded('MODULE_NOT_FOUND')) }),
      () => Object.assign(new FakeSocket([]), { connect: (): void => thrown(new Error('refused')) }),
      () => new FakeSocket([coded('EINVAL')]),
      () => new FakeSocket([hashblock(1)]),
    ]
    function thrown(error: Error): never {
      throw error
    }
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      reconnectDelayMs: 10,
      socketFactory: () => steps.shift()!(),
    })
    const iterator = subscriber[Symbol.asyncIterator]()
    const events = await take(iterator, 8)
    expect(events.slice(0, 7)).toEqual([
      { kind: 'reconnect', attempt: 1, reason: 'failed' },
      { kind: 'reconnect', attempt: 2, reason: 'failed', code: 'EMFILE' },
      { kind: 'reconnect', attempt: 3, reason: 'failed', code: 'EINVAL' },
      { kind: 'reconnect', attempt: 4, reason: 'failed', code: 'EAGAIN' },
      { kind: 'reconnect', attempt: 5, reason: 'failed', code: 'MODULE_NOT_FOUND' },
      { kind: 'reconnect', attempt: 6, reason: 'failed' },
      { kind: 'reconnect', attempt: 7, reason: 'failed', code: 'EINVAL' },
    ])
    expect(events[7]?.kind).toBe('message')
    // Known or not, a code passes through as it is: the type lists libzmq's and stays open.
    const codes: (ZmqReconnectCode | undefined)[] = events.flatMap(event =>
      event.kind === 'reconnect' ? [event.code] : []
    )
    expect(codes).toEqual([undefined, 'EMFILE', 'EINVAL', 'EAGAIN', 'MODULE_NOT_FOUND', undefined, 'EINVAL'])
    expect(subscriber.health()).toMatchObject({ status: 'receiving', reconnects: 7 })
    const done = iterator.next()
    subscriber.close()
    expect(await done).toEqual({ done: true, value: undefined })
  })

  it('ends quietly when close() comes before a fatal failure, and close() after one is harmless', async () => {
    let reject!: (error: unknown) => void
    const subscriber = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      socketFactory: () =>
        new Promise<ZmqSocket>((_resolve, rejectFactory) => {
          reject = rejectFactory
        }),
    })
    const iterator = subscriber[Symbol.asyncIterator]()
    const pending = iterator.next()
    await new Promise(resolve => setImmediate(resolve))
    subscriber.close()
    reject(Object.assign(new Error('gone'), { code: 'MODULE_NOT_FOUND' }))
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(subscriber.health().status).toBe('closed')

    const socket = new FakeSocket([])
    socket.connect = () => {
      throw Object.assign(new Error('Invalid argument'), { code: 'EINVAL' })
    }
    const failing = new QbitZmqSubscriber({
      url: 'tcp://127.0.0.1:1',
      topics: ['hashblock'],
      socketFactory: () => socket,
    })
    const failed = failing[Symbol.asyncIterator]()
    expect(await failure(failed)).toMatchObject({ code: 'invalid_address' })
    expect(socket.closed).toBe(true)
    failing.close()
    expect(await failed.next()).toEqual({ done: true, value: undefined })
    // A new iteration of a subscriber closed by a fatal failure ends at once.
    expect(await failing[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
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

  /** A loopback port that was free a moment ago: bound by a Node.js server, closed before this returns. */
  async function unusedPort(): Promise<number> {
    const server = createServer()
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    return port
  }

  /**
   * A Publisher bound to `url`, which a closed one may still hold: libzmq
   * releases the port asynchronously after close(), so bind again while the
   * port is in use, for up to 2 s. That is well inside the test's timeout, so
   * a port that stays held fails with EADDRINUSE, not a generic timeout.
   */
  async function bindWhenFree(url: string): Promise<Publisher> {
    const deadline = Date.now() + 2000
    for (;;) {
      const publisher = new Publisher()
      try {
        await publisher.bind(url)
        return publisher
      } catch (error) {
        publisher.close()
        if ((error as { code?: unknown }).code !== 'EADDRINUSE' || Date.now() > deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 10))
      }
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
      publisher = await bindWhenFree(url)
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

  it('drops a publisher that accepts the TCP connection but never greets, within the heartbeat bound', async () => {
    // As a qbitd stopped with SIGSTOP after a drop: its kernel accepts, nothing answers.
    const held: Socket[] = []
    const server = createServer(socket => {
      socket.on('error', () => undefined)
      held.push(socket)
    })
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    const url = `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`
    const subscriber = new QbitZmqSubscriber({
      url,
      topics: ['hashblock'],
      reconnectDelayMs: 50,
      heartbeatIntervalMs: 200,
      heartbeatTimeoutMs: 300,
    })
    const startedAt = performance.now()
    const { events, stop } = collect(subscriber)
    try {
      await expect.poll(() => events.length, { timeout: 5000, interval: 10 }).toBeGreaterThanOrEqual(1)
      const detectedMs = performance.now() - startedAt
      expect(detectedMs).toBeGreaterThanOrEqual(500 - 50)
      expect(detectedMs).toBeLessThanOrEqual(500 + 250)
      expect(events[0]).toEqual({ kind: 'reconnect', attempt: 1, reason: 'failed' })
      expect(held.length).toBeGreaterThanOrEqual(1)
      expect(subscriber.health().status).toBe('unknown')
    } finally {
      await stop()
      for (const socket of held) socket.destroy()
      server.close()
    }
  })

  it('never reconnects a createZeromqSocket socket by itself', async () => {
    // So libzmq never attaches a new connection to a full receive queue, which
    // libzmq 4.3.5 asserts on (_input_stopped) when the queue is next read.
    let publisher = new Publisher()
    await publisher.bind('tcp://127.0.0.1:0')
    const url = publisher.lastEndpoint!
    const socket = (await createZeromqSocket({ maxMessageSize: 4096 })) as unknown as Subscriber
    const seen: string[] = []
    for (const type of ['connect', 'handshake', 'disconnect', 'close'] as const) {
      socket.events.on(type, () => seen.push(type))
    }
    try {
      socket.connect(url)
      await expect.poll(() => seen, { timeout: 5000 }).toEqual(['connect', 'handshake'])
      publisher.close()
      await expect.poll(() => seen, { timeout: 5000 }).toEqual(['connect', 'handshake', 'disconnect'])
      publisher = await bindWhenFree(url)
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(seen).toEqual(['connect', 'handshake', 'disconnect'])
    } finally {
      socket.close()
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

  /**
   * A TCP relay to a publisher that can freeze: frozen, it forwards nothing
   * either way and holds new connections unanswered, as a qbitd stopped with
   * SIGSTOP does, whose kernel keeps its connections open and accepts new ones.
   */
  async function freezableRelay(target: string) {
    const { port: targetPort } = new URL(target.replace('tcp://', 'http://'))
    const pairs: [Socket, Socket][] = []
    const waiting: Socket[] = []
    let frozen = false
    const link = (client: Socket): void => {
      const upstream = connect(Number(targetPort), '127.0.0.1')
      upstream.on('error', () => client.destroy())
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
      client.pipe(upstream)
      upstream.pipe(client)
      pairs.push([client, upstream])
    }
    const server = createServer(client => {
      client.on('error', () => undefined)
      if (frozen) {
        client.pause()
        waiting.push(client)
      } else link(client)
    })
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    return {
      url: `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`,
      freeze: (): void => {
        frozen = true
        for (const [client, upstream] of pairs) {
          client.unpipe(upstream)
          upstream.unpipe(client)
          client.pause()
          upstream.pause()
        }
      },
      thaw: (): void => {
        frozen = false
        for (const [client, upstream] of pairs) {
          client.pipe(upstream)
          upstream.pipe(client)
        }
        for (const client of waiting.splice(0)) link(client)
      },
      close: (): void => {
        for (const socket of [...pairs.flat(), ...waiting]) socket.destroy()
        server.close()
      },
    }
  }

  /** Publish consecutive counters until every list in `events` has a message after its current length. */
  async function publishUntilAllReceived(publisher: Publisher, events: ZmqEvent[][], first: number): Promise<number> {
    let next = first
    const starts = events.map(list => list.length)
    const deadline = Date.now() + 5000
    const received = (): boolean =>
      events.every((list, i) => list.slice(starts[i]).some(event => event.kind === 'message'))
    while (!received() && Date.now() < deadline) {
      await publisher.send(hashblock(next++))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    return next
  }

  it('drops a publisher that stops answering within heartbeatIntervalMs + heartbeatTimeoutMs, and reconnects', async () => {
    const publisher = new Publisher()
    await publisher.bind('tcp://127.0.0.1:0')
    const relay = await freezableRelay(publisher.lastEndpoint!)
    const intervalMs = 200
    const timeoutMs = 400
    const subscriber = new QbitZmqSubscriber({
      url: relay.url,
      topics: ['hashblock'],
      reconnectDelayMs: 50,
      heartbeatIntervalMs: intervalMs,
      heartbeatTimeoutMs: timeoutMs,
    })
    // Without heartbeats, the same hang goes unnoticed until staleAfterMs.
    const control = new QbitZmqSubscriber({
      url: relay.url,
      topics: ['hashblock'],
      reconnectDelayMs: 50,
      heartbeatIntervalMs: 0,
    })
    const watched = collect(subscriber)
    const unwatched = collect(control)
    try {
      const next = await publishUntilAllReceived(publisher, [watched.events, unwatched.events], 0)
      expect(subscriber.health().status).toBe('receiving')
      const before = watched.events.length

      relay.freeze()
      const frozenAt = performance.now()
      await expect
        .poll(() => watched.events.some(event => event.kind === 'reconnect'), { timeout: 5000, interval: 10 })
        .toBe(true)
      const detectedMs = performance.now() - frozenAt
      expect(detectedMs).toBeGreaterThanOrEqual(timeoutMs - 50)
      expect(detectedMs).toBeLessThanOrEqual(intervalMs + timeoutMs + 250)
      expect(watched.events.slice(before)).toEqual([{ kind: 'reconnect', attempt: 1, reason: 'disconnected' }])
      expect(subscriber.health().status).toBe('unknown')
      // The replacement reaches the frozen publisher's kernel but gets no
      // greeting: it is dropped within the same bound, not libzmq's 30 s.
      const replacedAt = performance.now()
      await expect
        .poll(() => watched.events.filter(event => event.kind === 'reconnect').length, { timeout: 5000, interval: 10 })
        .toBe(2)
      expect(performance.now() - replacedAt).toBeLessThanOrEqual(50 + intervalMs + timeoutMs + 250)
      expect(watched.events.at(-1)).toEqual({ kind: 'reconnect', attempt: 2, reason: 'failed' })
      expect(unwatched.events.filter(event => event.kind !== 'message')).toEqual([])
      expect(control.health()).toMatchObject({ status: 'receiving', reconnects: 0 })

      // The publisher answers again: the replacement socket completes its handshake.
      relay.thaw()
      const after = watched.events.length
      await publishUntilAllReceived(publisher, [watched.events], next)
      const resumed = watched.events.slice(after)
      expect(resumed.find(event => event.kind !== 'reconnect')).toMatchObject({ kind: 'gap', topic: 'hashblock' })
      expect(resumed.find(event => event.kind === 'gap')).not.toHaveProperty('missed')
      expect(subscriber.health().status).toBe('receiving')
    } finally {
      await watched.stop()
      await unwatched.stop()
      relay.close()
      publisher.close()
    }
  })

  it('survives a missed heartbeat while the consumer blocks the event loop with a full receive queue', async () => {
    // libzmq 4.3.5 aborts the process when such a socket is read after it has
    // reconnected by itself; the subscriber must close it first.
    const publisher = new Publisher({ sendHighWaterMark: 100_000 })
    await publisher.bind('tcp://127.0.0.1:0')
    const subscriber = new QbitZmqSubscriber({
      url: publisher.lastEndpoint!,
      topics: ['hashblock'],
      reconnectDelayMs: 50,
      heartbeatIntervalMs: 200,
      heartbeatTimeoutMs: 400,
    })
    const events: ZmqEvent[] = []
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    const reading = (async () => {
      let blocked = false
      for await (const event of subscriber) {
        events.push(event)
        if (event.kind === 'message' && !blocked) {
          blocked = true
          await released
          // Longer than a heartbeat timeout and libzmq's own 100 ms reconnect.
          const end = Date.now() + 1500
          while (Date.now() < end);
        }
      }
    })()
    try {
      let next = 0
      while (!events.some(event => event.kind === 'message')) {
        await publisher.send(hashblock(next++))
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      // More than the receive queue's 1,000 messages, while the consumer waits.
      for (let i = 0; i < 5000; i += 1) await publisher.send(hashblock(next++))
      release()
      await expect.poll(() => events.some(event => event.kind === 'reconnect'), { timeout: 5000 }).toBe(true)
      expect(events.filter(event => event.kind === 'reconnect')).toEqual([
        { kind: 'reconnect', attempt: 1, reason: 'disconnected' },
      ])
      const after = events.length
      await publishUntilAllReceived(publisher, [events], next)
      expect(events.slice(after)[0]).toMatchObject({ kind: 'gap', topic: 'hashblock' })
      expect(subscriber.health().status).toBe('receiving')
    } finally {
      subscriber.close()
      await reading
      publisher.close()
    }
  })

  /**
   * A Publisher in a child process, bound to a loopback port: it keeps sending
   * while this process blocks its event loop, and nothing it does can bring
   * this process down. `send(count)` publishes that many hashblock messages
   * with consecutive counters; `close()` stops it.
   */
  async function childPublisher(): Promise<{ url: string; send(count: number): void; close(): Promise<void> }> {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
        const { Publisher } = require(process.argv[1])
        const hash = Buffer.from(process.argv[2], 'hex')
        const publisher = new Publisher({ sendHighWaterMark: 100000, linger: 0 })
        let next = 0
        publisher.bind('tcp://127.0.0.1:0').then(() => process.send(publisher.lastEndpoint))
        process.on('message', async count => {
          if (count === 0) {
            publisher.close()
            process.disconnect()
            return
          }
          for (let i = 0; i < count; i += 1) {
            const counter = Buffer.alloc(4)
            counter.writeUInt32LE(next++)
            await publisher.send([Buffer.from('hashblock'), hash, counter])
          }
        })
        `,
        createRequire(import.meta.url).resolve('zeromq'),
        HASH,
      ],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }
    )
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    const close = async (): Promise<void> => {
      if (child.connected) child.send(0)
      const killer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(killer)
    }
    try {
      const url = await new Promise<string>((resolve, reject) => {
        child.once('message', message => resolve(String(message)))
        child.once('error', reject)
        child.once('exit', code => reject(new Error(`the publisher exited with ${code}`)))
      })
      return { url, send: count => child.send(count), close }
    } catch (error) {
      await close()
      throw error
    }
  }

  it("cannot reach libzmq's _input_stopped abort: a createZeromqSocket socket read after a missed heartbeat while the loop was blocked", async () => {
    // libzmq 4.3.5 aborts the process when a socket it has reconnected by itself
    // is read after the old connection filled the receive queue. With libzmq's
    // own reconnect this aborts at the reads below, every time.
    const publisher = await childPublisher()
    const socket = (await createZeromqSocket({
      maxMessageSize: 4096,
      heartbeatIntervalMs: 200,
      heartbeatTimeoutMs: 400,
      heartbeatTtlMs: 0,
    })) as unknown as Subscriber
    const seen: string[] = []
    for (const type of ['connect', 'handshake', 'disconnect', 'close'] as const) {
      socket.events.on(type, () => seen.push(type))
    }
    // One receive at a time, as zeromq allows: one that ran out of time stays pending for the next.
    let inFlight: Promise<boolean> | undefined
    const receive = (ms: number): Promise<boolean> => {
      inFlight ??= socket.receive().then(
        () => {
          inFlight = undefined
          return true
        },
        () => {
          inFlight = undefined
          return false
        }
      )
      return Promise.race([inFlight, new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))])
    }
    try {
      socket.connect(publisher.url)
      socket.subscribe('hashblock')
      let first = false
      for (let i = 0; i < 250 && !first; i += 1) {
        publisher.send(1)
        first = await receive(20)
      }
      expect(first).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 100))
      while (await receive(20));
      // A receive waits on an empty queue while the loop blocks, the queue fills
      // and libzmq drops the connection for the PONGs it did not read.
      const pending = receive(2000)
      publisher.send(5000)
      const end = Date.now() + 1500
      while (Date.now() < end);
      await pending
      let reads = 0
      while (reads < 1100 && (await receive(200))) reads += 1
      expect(reads).toBeLessThan(1100)
      // Dropped once, and never connected again by libzmq.
      await expect.poll(() => seen, { timeout: 5000 }).toEqual(['connect', 'handshake', 'disconnect'])
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(seen).toEqual(['connect', 'handshake', 'disconnect'])
    } finally {
      socket.close()
      await publisher.close()
    }
  }, 20_000)

  it('survives a missed heartbeat while the event loop is blocked with a receive pending', async () => {
    // As above, through the subscriber, which then replaces the socket.
    const publisher = await childPublisher()
    const subscriber = new QbitZmqSubscriber({
      url: publisher.url,
      topics: ['hashblock'],
      reconnectDelayMs: 50,
      heartbeatIntervalMs: 200,
      heartbeatTimeoutMs: 400,
    })
    const { events, stop } = collect(subscriber)
    /** Publish one message every 20 ms until one arrives after `start`. */
    const publishUntilReceived = async (start: number): Promise<void> => {
      const deadline = Date.now() + 5000
      while (!events.slice(start).some(event => event.kind === 'message') && Date.now() < deadline) {
        publisher.send(1)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    try {
      await publishUntilReceived(0)
      // The consumer keeps up: the subscriber waits in receive() on an empty queue.
      const before = events.length
      expect(before).toBeGreaterThan(0)
      publisher.send(5000)
      const end = Date.now() + 1500
      while (Date.now() < end);
      expect(events.length).toBe(before)
      await expect.poll(() => events.some(event => event.kind === 'reconnect'), { timeout: 5000 }).toBe(true)
      expect(events.filter(event => event.kind === 'reconnect')).toEqual([
        { kind: 'reconnect', attempt: 1, reason: 'disconnected' },
      ])
      expect(events.filter(event => event.kind === 'message').length).toBeLessThan(before + 5000)
      const after = events.length
      await publishUntilReceived(after)
      expect(events.slice(after).find(event => event.kind !== 'message')).toMatchObject({
        kind: 'gap',
        topic: 'hashblock',
      })
      expect(subscriber.health().status).toBe('receiving')
    } finally {
      await stop()
      await publisher.close()
    }
  }, 20_000)

  it('reads queued messages without an event-loop turn per message', async () => {
    // A yield to the event loop before each receive held the subscriber to one
    // message per turn, about a third less throughput on loopback.
    const publisher = new Publisher({ sendHighWaterMark: 100_000, linger: 0 })
    await publisher.bind('tcp://127.0.0.1:0')
    const subscriber = new QbitZmqSubscriber({ url: publisher.lastEndpoint!, topics: ['hashblock'] })
    const { events, stop } = collect(subscriber)
    try {
      let next = await publishUntilReceived(publisher, events, 0)
      const messages = (): number => events.filter(event => event.kind === 'message').length
      const received = messages()
      const queued = 900 // below the receive queue's 1,000, so libzmq keeps reading
      for (let i = 0; i < queued; i += 1) await publisher.send(hashblock(next++))
      // Let libzmq's I/O thread fill the receive queue while this thread is busy.
      const end = Date.now() + 300
      while (Date.now() < end);
      // The most messages delivered between two turns of the event loop.
      let most = 0
      let last = messages()
      let ticking = true
      const tick = (): void => {
        most = Math.max(most, messages() - last)
        last = messages()
        if (ticking) setImmediate(tick)
      }
      setImmediate(tick)
      await expect.poll(messages, { timeout: 5000 }).toBe(received + queued)
      ticking = false
      // Measured here: 390 without the yield, and 1 with it.
      expect(most).toBeGreaterThanOrEqual(100)
    } finally {
      await stop()
      publisher.close()
    }
  })

  it('retries a node that is down every reconnectDelayMs, receives once it binds, and reconnects when it stops', async () => {
    // A port nothing listens on. A zeromq socket would not do: libzmq unbinds
    // it asynchronously after close(), so the subscriber could still reach it.
    const url = `tcp://127.0.0.1:${await unusedPort()}`
    const subscriber = new QbitZmqSubscriber({ url, topics: ['hashblock'], reconnectDelayMs: 100 })
    const { events, stop } = collect(subscriber)
    let publisher: Publisher | undefined
    try {
      // libzmq does not retry the refused connection itself: the subscriber
      // replaces the socket, after each reconnectDelayMs, and never gives up.
      await new Promise(resolve => setTimeout(resolve, 550))
      expect(events.length).toBeGreaterThanOrEqual(3)
      expect(events.length).toBeLessThanOrEqual(6)
      expect(events).toEqual(events.map((_event, i) => ({ kind: 'reconnect', attempt: i + 1, reason: 'failed' })))
      expect(subscriber.health()).toMatchObject({ status: 'unknown', reconnects: events.length })
      publisher = await bindWhenFree(url)
      const next = await publishUntilReceived(publisher, events, 0)
      expect(subscriber.health().status).toBe('receiving')
      publisher.close() // the node stops again
      await expect
        .poll(() => events.some(e => e.kind === 'reconnect' && e.reason === 'disconnected'), { timeout: 5000 })
        .toBe(true)
      publisher = await bindWhenFree(url)
      const before = events.length
      await publishUntilReceived(publisher, events, next)
      expect(events.slice(before).some(e => e.kind === 'message')).toBe(true)
      expect(subscriber.health().status).toBe('receiving')
    } finally {
      await stop()
      publisher?.close()
    }
  })
})
