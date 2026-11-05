import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createZeromqSocket, QbitZmqSubscriber, ZmqSetupError } from '../src'

const { peerDependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  peerDependencies: Record<string, string>
}
const RANGE = peerDependencies['zeromq']!

// `zeromq` loads at the first iteration, so a missing or broken addon shows up
// there, as a ZmqSetupError, and not as an endless run of reconnects.
describe('a zeromq module that cannot be loaded', () => {
  afterEach(() => {
    vi.doUnmock('zeromq')
  })

  it('ends the first iteration with module_load, wrapping the import failure', async () => {
    const addon = new Error('No compatible zeromq.js addon found')
    vi.doMock('zeromq', () => {
      throw addon
    })
    const subscriber = new QbitZmqSubscriber({ url: 'tcp://127.0.0.1:28332', topics: ['hashblock'] })
    expect(subscriber.health().status).toBe('unknown') // constructing did not load it
    const iterator = subscriber[Symbol.asyncIterator]()
    const error = await iterator.next().then(
      () => undefined,
      (error: unknown) => error
    )
    expect(error).toBeInstanceOf(ZmqSetupError)
    expect(error).toMatchObject({ code: 'module_load' })
    // Vitest may wrap the factory's error; the import failure is the cause either way.
    const cause = (error as ZmqSetupError).cause as Error
    expect(cause === addon || cause.cause === addon).toBe(true)
    expect((error as Error).message).toMatch(/^Could not load the zeromq module or its native addon \(.+\): /)
    // An optional peer: the application adds it, in the range package.json gives.
    expect((error as Error).message).toContain(
      `zeromq is an optional peer dependency of @qbit-oss/zmq, which the application adds itself (npm install zeromq@${RANGE})`
    )
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(subscriber.health()).toMatchObject({ status: 'closed', reconnects: 0 })
    await expect(createZeromqSocket()).rejects.toThrow(ZmqSetupError)
  })

  it('reports a zeromq without a Subscriber export as module_load', async () => {
    vi.doMock('zeromq', () => ({ Subscriber: undefined, Publisher: class {} }))
    await expect(createZeromqSocket()).rejects.toMatchObject({
      name: 'ZmqSetupError',
      code: 'module_load',
      message: `The zeromq module has no Subscriber export: install zeromq@${RANGE}, the optional peer dependency's range`,
    })
  })
})
