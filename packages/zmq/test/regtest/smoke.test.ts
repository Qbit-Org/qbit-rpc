import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { QbitZmqSubscriber, type ZmqEvent } from '../../src'

// Runs only under scripts/regtest-smoke.sh, which starts a throwaway regtest
// node on loopback with -zmqpubhashblock and -zmqpubsequence.
const env = process.env
const enabled = env['RUN_QBIT_REGTEST_SMOKE'] === '1'
const zmqUrl = env['QBIT_REGTEST_ZMQ_URL'] ?? ''
const [cliPath = '', ...cliArgs] = (env['QBIT_REGTEST_CLI'] ?? '').split(' ')
const cli = (...args: string[]): string => execFileSync(cliPath, [...cliArgs, ...args], { encoding: 'utf8' }).trim()

describe.runIf(enabled)('qbit Core v1.0.0 regtest ZMQ', () => {
  it('delivers hashblock and sequence notifications for mined blocks', async () => {
    const subscriber = new QbitZmqSubscriber({ url: zmqUrl, topics: ['hashblock', 'sequence'], reconnectDelayMs: 100 })
    const events: ZmqEvent[] = []
    const reading = (async () => {
      for await (const event of subscriber) events.push(event)
    })()
    try {
      expect(subscriber.health().status).toBe('unknown')
      const address = cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr')
      // PUB/SUB drops what is published before the subscription propagates: mine until one lands.
      const deadline = Date.now() + 20_000
      while (!events.some(event => event.kind === 'message') && Date.now() < deadline) {
        cli('generatetoaddress', '1', address)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const [last] = JSON.parse(cli('generatetoaddress', '1', address)) as string[]
      await expect
        .poll(
          () => events.some(e => e.kind === 'message' && e.message.topic === 'hashblock' && e.message.hash === last),
          {
            timeout: 10_000,
          }
        )
        .toBe(true)
      expect(
        events.some(
          e =>
            e.kind === 'message' &&
            e.message.topic === 'sequence' &&
            e.message.event === 'block_connected' &&
            e.message.hash === last
        )
      ).toBe(true)
      expect(events.filter(e => e.kind === 'malformed')).toEqual([])
      expect(events.filter(e => e.kind === 'gap')).toEqual([])
      expect(subscriber.health()).toMatchObject({ status: 'receiving', gaps: 0, malformed: 0 })
    } finally {
      subscriber.close()
      await reading
    }
  })
})
