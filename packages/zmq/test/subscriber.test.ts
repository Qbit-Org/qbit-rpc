import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { Publisher } from 'zeromq'

import {
  createZeromqSocket,
  DEFAULT_MAX_MESSAGE_SIZE,
  DEFAULT_STALE_AFTER_MS,
  QbitZmqSubscriber,
  ZmqSetupError,
  type ZmqEvent,
  type ZmqSetupErrorCode,
  type ZmqSocket,
  type ZmqSocketFactory,
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
    expect(seen).toEqual([{ maxMessageSize: 3_000_000, ipv6: false }])
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
      ['ws://127.0.0.1:28332', 'EPROTONOSUPPORT', 'unsupported_protocol'],
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

  it('keeps waiting for a node that is down, receives once it binds, and reconnects when it stops', async () => {
    const probe = new Publisher()
    await probe.bind('tcp://127.0.0.1:0')
    const url = probe.lastEndpoint!
    probe.close() // nothing listens on the port now
    const subscriber = new QbitZmqSubscriber({ url, topics: ['hashblock'], reconnectDelayMs: 50 })
    const { events, stop } = collect(subscriber)
    let publisher: Publisher | undefined
    try {
      // libzmq retries the refused TCP connection itself; the subscriber neither fails nor gives up.
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(events).toEqual([])
      expect(subscriber.health()).toMatchObject({ status: 'unknown', reconnects: 0 })
      publisher = new Publisher()
      await publisher.bind(url)
      const next = await publishUntilReceived(publisher, events, 0)
      expect(subscriber.health().status).toBe('receiving')
      publisher.close() // the node stops again
      await expect
        .poll(() => events.some(e => e.kind === 'reconnect' && e.reason === 'disconnected'), { timeout: 5000 })
        .toBe(true)
      publisher = new Publisher()
      await publisher.bind(url)
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
