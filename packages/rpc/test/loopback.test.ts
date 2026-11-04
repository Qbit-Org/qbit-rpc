import type { LookupAddress, LookupOptions } from 'node:dns'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { QbitRpcClient, RpcTransportError, RpcUnknownOutcomeError, type RpcAuth } from '../src'
import { isLoopbackAddress } from '../src/endpoint'
import { testPki } from './helpers/certificates'
import { chainResults, CHECK, FakeNode, HASH_A, TX_HEX, TX_TXID } from './helpers/fake-node'

type Lookup = (hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void) => void

const dns = createRequire(import.meta.url)('node:dns') as { lookup: Lookup }
const realLookup = dns.lookup

/** What `localhost` resolves to, as a hosts file or container DNS would have it; `lookups` counts the queries. */
let answers: LookupAddress[] | undefined
let lookups = 0

beforeEach(() => {
  answers = undefined
  lookups = 0
  dns.lookup = (hostname, options, callback) => {
    if (hostname !== 'localhost' || answers === undefined) return realLookup(hostname, options, callback)
    lookups += 1
    const found =
      options.family === 4 || options.family === 6 ? answers.filter(a => a.family === options.family) : answers
    if (options.all === true) process.nextTick(callback, null, found)
    else process.nextTick(callback, null, found[0]?.address, found[0]?.family)
  }
  syncBuiltinESMExports()
})
afterEach(() => {
  dns.lookup = realLookup
  syncBuiltinESMExports()
})

const v4 = (address: string): LookupAddress => ({ address, family: 4 })
const v6 = (address: string): LookupAddress => ({ address, family: 6 })

const LOOPBACK = v4('127.0.0.1')
/**
 * Addresses that are not loopback, for a host elsewhere. They are multicast
 * and broadcast ones, to which the kernel refuses a TCP connection before
 * sending anything (ENETUNREACH): the client refuses them before connecting,
 * and a client that did not, such as this package's before the check, would
 * fail here with nothing leaving the machine.
 *
 * Never put a routable address here, private or documentation ranges
 * included. A first run of these tests against the old client used
 * 10.1.2.3, 192.0.2.7 and 2001:db8::7, and the old client sent TCP
 * connection attempts to them from the test host: exactly the leak this
 * check closes.
 */
const ELSEWHERE_V4 = v4('224.0.0.251')
const ELSEWHERE_V6 = v6('ff02::fb')
const ELSEWHERE: [string, LookupAddress[]][] = [
  ['elsewhere', [ELSEWHERE_V4]],
  ['loopback, then elsewhere', [LOOPBACK, ELSEWHERE_V4]],
  ['elsewhere, then loopback', [ELSEWHERE_V4, LOOPBACK]],
  ['::1, then elsewhere over IPv6', [v6('::1'), ELSEWHERE_V6]],
  ['an IPv4-mapped address elsewhere', [v6('::ffff:224.0.0.251')]],
  ['the broadcast address', [v4('255.255.255.255')]],
  ['the unspecified address', [v4('0.0.0.0')]],
]

let node: FakeNode
let dir: string
beforeEach(async () => {
  node = await FakeNode.start()
  node.results({
    ...chainResults('regtest'),
    getbestblockhash: JSON.stringify(HASH_A),
    sendrawtransaction: JSON.stringify(TX_TXID),
  })
  dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-loopback-'))
})
afterEach(async () => {
  await node.close()
  await rm(dir, { recursive: true, force: true })
})

async function cookie(): Promise<RpcAuth> {
  const cookieFile = join(dir, '.cookie')
  await writeFile(cookieFile, '__cookie__:secret')
  return { cookieFile }
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e
  )
}

function client(auth: RpcAuth, url = `http://localhost:${node.port}/`): QbitRpcClient {
  return new QbitRpcClient({ url, auth, expectedChain: 'regtest', capabilities: ['broadcast'], readRetries: 2 })
}

function expectNotLoopback(error: unknown, method: string): void {
  expect(RpcUnknownOutcomeError.is(error)).toBe(false)
  expect(RpcTransportError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason: 'not_loopback', method })
  expect((error as RpcTransportError).code).toBeUndefined()
}

const AUTH: [string, () => Promise<RpcAuth>][] = [
  ['Basic credentials', async () => ({ username: 'u', password: 'p' })],
  ['a cookie', cookie],
]

describe('isLoopbackAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.254', true],
    ['::1', true],
    ['0:0:0:0:0:0:0:1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['126.255.255.255', false],
    ['128.0.0.1', false],
    ['0.0.0.0', false],
    ['::', false],
    ['::2', false],
    ['::127.0.0.1', false],
    ['::ffff:10.0.0.1', false],
    ['fe80::1', false],
    ['localhost', false],
    ['127.0.0.1.example', false],
  ])('%s: %s', (address, loopback) => {
    expect(isLoopbackAddress(address)).toBe(loopback)
  })
})

describe('localhost, resolved on every connection', () => {
  it.each(AUTH)('reaches the node with %s when every address is loopback', async (_name, auth) => {
    for (const found of [[LOOPBACK], [LOOPBACK, v6('::1')], [v4('127.0.0.2'), LOOPBACK], [v6('::ffff:127.0.0.1')]]) {
      answers = found
      const rpc = client(await auth())
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
      rpc.close()
    }
    expect(lookups).toBe(4)
  })

  it.each(AUTH.flatMap(([name, auth]) => ELSEWHERE.map(([label, found]) => [name, label, auth, found] as const)))(
    'refuses %s when localhost resolves to %s, sending nothing and retrying nothing',
    async (_name, _label, auth, found) => {
      answers = found
      const error = await failure(client(await auth()).getBestBlockHash())
      expectNotLoopback(error, 'getbestblockhash')
      expect((error as Error).message).toBe(
        'RPC getbestblockhash not sent: the host name resolved to an address that is not loopback, and credentials in cleartext, or a cookie, go to loopback only'
      )
      expect(lookups).toBe(1)
      expect(node.accepted).toBe(0)
    }
  )

  it.each(AUTH)('refuses a side-effecting call with %s definitely, as the answer changes', async (_name, auth) => {
    answers = [LOOPBACK]
    const rpc = client(await auth())
    await rpc.confirmChain()
    // Each side-effecting call opens its own connection, and so resolves again.
    expect(await rpc.sendRawTransaction(TX_HEX)).toBe(TX_TXID)
    answers = [LOOPBACK, ELSEWHERE_V4]
    expectNotLoopback(await failure(rpc.sendRawTransaction(TX_HEX)), 'sendrawtransaction')
    expect(rpc.chainStatus).toBe('stale')
    expect(node.calls().map(call => call.method)).toEqual([...CHECK, 'sendrawtransaction'])
    expect(lookups).toBe(3)
  })

  it('refuses a cookie over https to localhost unless it resolves to loopback, as over http', async () => {
    const pki = testPki()
    const secure = await FakeNode.start({ tls: { key: pki.server.key, cert: pki.server.cert } })
    secure.results({ getbestblockhash: JSON.stringify(HASH_A) })
    try {
      const url = `https://localhost:${secure.port}/`
      const rpc = new QbitRpcClient({ url, auth: await cookie(), expectedChain: 'regtest', tls: { ca: pki.ca.cert } })
      answers = [LOOPBACK]
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
      rpc.close()
      answers = [ELSEWHERE_V4, LOOPBACK]
      expectNotLoopback(await failure(rpc.getBestBlockHash()), 'getbestblockhash')
      expect(secure.requests).toHaveLength(1)
    } finally {
      await secure.close()
    }
  })

  it('does not restrict Basic credentials over https, which TLS protects', async () => {
    const pki = testPki()
    const secure = await FakeNode.start({ tls: { key: pki.server.key, cert: pki.server.cert } })
    secure.results({ getbestblockhash: JSON.stringify(HASH_A) })
    try {
      const url = `https://localhost:${secure.port}/`
      const auth = { username: 'u', password: 'p' }
      const rpc = new QbitRpcClient({ url, auth, expectedChain: 'regtest', tls: { ca: pki.ca.cert } })
      // Loopback first: the connection to it succeeds, and no other address is tried.
      answers = [LOOPBACK, ELSEWHERE_V4]
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    } finally {
      await secure.close()
    }
  })

  it('looks nothing up for a loopback address in the URL', async () => {
    answers = [ELSEWHERE_V4]
    const rpc = client({ username: 'u', password: 'p' }, node.url)
    expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    expect(lookups).toBe(0)
  })
})
