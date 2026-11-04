import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createZeromqSocket,
  QbitZmqSubscriber,
  ZMQ_TOPICS,
  type QbitZmqSubscriberOptions,
  type ZmqEvent,
  type ZmqMessage,
  type ZmqSocket,
  type ZmqSocketSettings,
  type ZmqTopic,
} from '../../src'

// Runs only under scripts/regtest-smoke.sh, which starts a throwaway regtest
// node on loopback with every -zmqpub<topic> on one address, and passes the
// command that started it so the restart case can start it again.
const env = process.env
const enabled = env['RUN_QBIT_REGTEST_SMOKE'] === '1'
const zmqUrl = env['QBIT_REGTEST_ZMQ_URL'] ?? ''
const datadir = env['QBIT_REGTEST_DATADIR'] ?? ''
const [qbitd = '', ...qbitdArgs] = JSON.parse(env['QBIT_REGTEST_QBITD'] ?? '[]') as string[]
const [cliPath = '', ...cliArgs] = (env['QBIT_REGTEST_CLI'] ?? '').split(' ')
const cli = (...args: string[]): string => execFileSync(cliPath, [...cliArgs, ...args], { encoding: 'utf8' }).trim()
const mine = (address: string): string => (JSON.parse(cli('generatetoaddress', '1', address)) as [string])[0]

type Message<T extends ZmqTopic> = Extract<ZmqMessage, { topic: T }>
type Gap = Extract<ZmqEvent, { kind: 'gap' }>

const hash256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest().reverse().toString('hex')
const blockHash = (block: Uint8Array): string => hash256(block.subarray(0, 80))

/** A txid: the hash of the transaction without its witness data (BIP 144's marker, flag and witnesses). */
function txid(bytes: Uint8Array): string {
  const tx = Buffer.from(bytes)
  if (tx[4] !== 0 || tx[5] !== 1) return hash256(tx)
  let offset = 6
  const compactSize = (): number => {
    const first = tx[offset]!
    offset += 1
    if (first < 0xfd) return first
    const value =
      first === 0xfd
        ? tx.readUInt16LE(offset)
        : first === 0xfe
          ? tx.readUInt32LE(offset)
          : Number(tx.readBigUInt64LE(offset))
    offset += first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    return value
  }
  const skip = (length: number): void => {
    offset += length
  }
  const inputs = compactSize()
  for (let i = 0; i < inputs; i += 1) {
    skip(36) // prevout
    skip(compactSize()) // scriptSig
    skip(4) // nSequence
  }
  const outputs = compactSize()
  for (let i = 0; i < outputs; i += 1) {
    skip(8) // nValue
    skip(compactSize()) // scriptPubKey
  }
  const body = tx.subarray(6, offset)
  for (let i = 0; i < inputs; i += 1) {
    const items = compactSize()
    for (let j = 0; j < items; j += 1) skip(compactSize())
  }
  expect(tx.length).toBe(offset + 4)
  return hash256(Buffer.concat([tx.subarray(0, 4), body, tx.subarray(offset)]))
}

/** Poll `done` every 100 ms, running `step` (say, mining a block) before each wait, until a deadline. */
async function until(what: string, done: () => boolean, step?: () => void, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    step?.()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** A subscriber whose events are collected in `events` until `close()`. */
function subscribe(options: Omit<QbitZmqSubscriberOptions, 'url' | 'reconnectDelayMs'>) {
  const subscriber = new QbitZmqSubscriber({ url: zmqUrl, reconnectDelayMs: 100, ...options })
  const events: ZmqEvent[] = []
  const reading = (async () => {
    for await (const event of subscriber) events.push(event)
  })()
  const messages = <T extends ZmqTopic>(topic: T, from = 0): Message<T>[] =>
    events
      .slice(from)
      .flatMap(event =>
        event.kind === 'message' && event.message.topic === topic ? [event.message as Message<T>] : []
      )
  const close = async (): Promise<void> => {
    subscriber.close()
    await reading
  }
  return { subscriber, events, messages, close }
}

/** The events from `from` on that are not messages, in order. */
const nonMessages = (events: readonly ZmqEvent[], from = 0): ZmqEvent[] =>
  events.slice(from).filter(event => event.kind !== 'message')

/** Expect one gap without `missed` on each of `topics` after `from`, each just before that topic's first message. */
function expectOneGapPerTopic(events: readonly ZmqEvent[], from: number, topics: readonly ZmqTopic[]): void {
  const gaps = events.slice(from).filter((event): event is Gap => event.kind === 'gap')
  expect(gaps.map(gap => gap.topic).sort()).toEqual([...topics].sort())
  for (const gap of gaps) {
    expect(gap).not.toHaveProperty('missed')
    const index = events.indexOf(gap)
    const first = events.slice(from).find(event => event.kind === 'message' && event.message.topic === gap.topic)
    expect(events[index + 1]).toBe(first)
    expect(first?.kind === 'message' && first.message.sequence).toBe(gap.received)
  }
}

describe.runIf(enabled)('qbit Core regtest ZMQ', () => {
  it('publishes every topic for a payment, its RBF replacement and a block', async () => {
    // Taps the socket to keep each message's frames as the node sent them.
    const frames: (readonly Uint8Array[])[] = []
    const tap = async (settings: ZmqSocketSettings): Promise<ZmqSocket> => {
      const socket = await createZeromqSocket(settings)
      return {
        connect: url => socket.connect(url),
        subscribe: topic => socket.subscribe(topic),
        close: () => socket.close(),
        receive: async () => {
          const parts = await socket.receive()
          frames.push(parts)
          return parts
        },
        ...(socket.events === undefined ? {} : { events: socket.events }),
      }
    }
    const { subscriber, events, messages, close } = subscribe({ topics: ZMQ_TOPICS, socketFactory: tap })
    try {
      expect(subscriber.health().status).toBe('unknown')
      const address = cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr')
      // PUB/SUB drops what is published before a subscription reaches qbitd: mine until every topic has delivered.
      await until(
        'a message on every topic',
        () => ZMQ_TOPICS.every(topic => messages(topic).length > 0),
        () => mine(address)
      )
      // Then one more block, which every topic sees whole. qbitd publishes a
      // block's transactions, then its sequence C, hashblock and rawblock.
      const fence = mine(address)
      await until('the fence block on rawblock', () => messages('rawblock').some(m => blockHash(m.bytes) === fence))
      const start = events.length

      const payee = cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr')
      const original = cli(
        '-rpcwallet=smoke',
        '-named',
        'sendtoaddress',
        `address=${payee}`,
        'amount=1',
        'replaceable=true'
      )
      const { txid: replacement } = JSON.parse(cli('-rpcwallet=smoke', 'bumpfee', original)) as { txid: string }
      const mempool = JSON.parse(cli('getrawmempool', 'false', 'true')) as { mempool_sequence: number }
      const block = mine(address)
      await until('the block on rawblock', () => messages('rawblock', start).some(m => blockHash(m.bytes) === block))
      const { tx: blockTxids } = JSON.parse(cli('getblock', block, '1')) as { tx: string[] }

      // Every rawtx is the transaction hashtx names, and every rawblock the block hashblock names.
      const hashtx = messages('hashtx', start).map(m => m.txid)
      expect(messages('rawtx', start).map(m => txid(m.bytes))).toEqual(hashtx)
      expect(hashtx).toEqual([original, replacement, ...blockTxids])
      expect(blockTxids).toEqual([expect.any(String), replacement])
      expect(Buffer.from(messages('rawtx', start)[1]!.bytes).toString('hex')).toBe(
        cli('getrawtransaction', replacement)
      )
      expect(messages('hashblock', start).map(m => m.hash)).toEqual([block])
      expect(messages('rawblock', start).map(m => blockHash(m.bytes))).toEqual([block])
      expect(Buffer.from(messages('rawblock', start)[0]!.bytes).toString('hex')).toBe(cli('getblock', block, '0'))
      expect(messages('hashblock').at(-1)?.hash).toBe(cli('getbestblockhash'))

      // The mempool events carry consecutive mempool sequence numbers, up to the one RPC reports next.
      const next = BigInt(mempool.mempool_sequence)
      expect(messages('sequence', start)).toEqual([
        expect.objectContaining({ event: 'mempool_added', hash: original, mempoolSequence: next - 3n }),
        expect.objectContaining({ event: 'mempool_removed', hash: original, mempoolSequence: next - 2n }),
        expect.objectContaining({ event: 'mempool_added', hash: replacement, mempoolSequence: next - 1n }),
        { topic: 'sequence', sequence: expect.any(Number), event: 'block_connected', hash: block },
      ])
      // On the wire: a 33-byte body for C (and D), 41 bytes for A and R.
      const sequenceBodies = frames
        .filter(([topic]) => Buffer.from(topic!).toString() === 'sequence')
        .map(([, body]) => `${String.fromCharCode(body![32]!)}:${body!.byteLength}`)
      expect(new Set(sequenceBodies)).toEqual(new Set(['C:33', 'A:41', 'R:41']))

      expect(frames).toHaveLength(events.length)
      expect(nonMessages(events)).toEqual([])
      expect(subscriber.health()).toMatchObject({ status: 'receiving', gaps: 0, malformed: 0, reconnects: 0 })
    } finally {
      await close()
    }
  })

  it('drops a connection that sends a message over maxMessageSize, then reports a gap on each topic', async () => {
    const { subscriber, events, messages, close } = subscribe({
      topics: ['hashblock', 'rawblock'],
      maxMessageSize: 1024,
    })
    try {
      const address = cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr')
      // Blocks with only a coinbase are 262 bytes.
      await until(
        'a message on both topics',
        () => messages('hashblock').length > 0 && messages('rawblock').length > 0,
        () => mine(address)
      )
      expect(nonMessages(events)).toEqual([])

      // One P2MR payment makes a block of about 4 KB.
      cli('-rpcwallet=smoke', 'sendtoaddress', cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr'), '1')
      const large = mine(address)
      expect(cli('getblock', large, '0').length / 2).toBeGreaterThan(1024)
      await until('a reconnect', () => events.some(event => event.kind === 'reconnect'))
      const after = events.length
      expect(nonMessages(events)).toEqual([{ kind: 'reconnect', attempt: 1, reason: 'disconnected' }])
      expect(subscriber.health().status).toBe('unknown')

      await until(
        'a message on both topics after the reconnect',
        () => messages('hashblock', after).length > 0 && messages('rawblock', after).length > 0,
        () => mine(address)
      )
      expect(messages('rawblock').map(m => blockHash(m.bytes))).not.toContain(large)
      expectOneGapPerTopic(events, after, ['hashblock', 'rawblock'])
      expect(nonMessages(events, after).filter(event => event.kind !== 'gap')).toEqual([])
      expect(subscriber.health()).toMatchObject({ status: 'receiving', gaps: 2, malformed: 0, reconnects: 1 })
    } finally {
      await close()
    }
  })

  it('reports a restart of qbitd: a reconnect, unknown health while down, then one gap per topic', async () => {
    const { subscriber, events, messages, close } = subscribe({ topics: ZMQ_TOPICS })
    let restarted = false
    try {
      const address = cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr')
      await until(
        'a message on every topic',
        () => ZMQ_TOPICS.every(topic => messages(topic).length > 0),
        () => mine(address)
      )
      expect(nonMessages(events)).toEqual([])

      const pid = Number(readFileSync(join(datadir, 'regtest', 'qbitd.pid'), 'utf8'))
      const running = (): boolean => {
        try {
          process.kill(pid, 0)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
          throw error
        }
      }
      cli('stop')
      await until('a reconnect', () => events.some(event => event.kind === 'reconnect'))
      await until('qbitd to exit', () => !running(), undefined, 60_000)
      const after = events.length
      expect(nonMessages(events)).toEqual([{ kind: 'reconnect', attempt: 1, reason: 'disconnected' }])
      expect(subscriber.health().status).toBe('unknown')

      // The same command, ports and data directory.
      execFileSync(qbitd, qbitdArgs, { stdio: 'ignore' })
      restarted = true
      cli('-rpcwait', 'getblockchaininfo')
      expect(subscriber.health().status).toBe('unknown')
      await until(
        'a message on every topic after the restart',
        () => ZMQ_TOPICS.every(topic => messages(topic, after).length > 0),
        () => mine(address),
        30_000
      )
      expectOneGapPerTopic(events, after, ZMQ_TOPICS)
      expect(nonMessages(events, after).filter(event => event.kind !== 'gap')).toEqual([])
      expect(subscriber.health()).toMatchObject({ status: 'receiving', gaps: 5, malformed: 0, reconnects: 1 })
    } finally {
      await close()
      // Leave the node as the script made it: qbitd does not load the wallets at startup.
      if (restarted) {
        try {
          const loaded = JSON.parse(cli('listwallets')) as string[]
          for (const wallet of ['smoke', 'locked']) if (!loaded.includes(wallet)) cli('loadwallet', wallet)
        } catch {
          // The node is not answering; the test's own failure says why.
        }
      }
    }
  }, 120_000)
})
