import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  QbitRpcClient,
  RpcChainGuardError,
  RpcTimeoutError,
  RpcUnknownOutcomeError,
  type QbitRpcClientOptions,
} from '../src'
import { blockchainInfoJson, FakeNode, HASH_A, TX_HEX } from './helpers/fake-node'

let node: FakeNode
let chain: string
let dropNextRead: boolean
let hangChainCheck: boolean

beforeEach(async () => {
  node = await FakeNode.start()
  chain = 'regtest'
  dropNextRead = false
  hangChainCheck = false
  node.handler = (request, response) => {
    const call = JSON.parse(request.body) as { id: number; method: string }
    if (call.method === 'getbestblockhash' && dropNextRead) {
      dropNextRead = false
      return void response.socket?.destroy()
    }
    if (call.method === 'getblockchaininfo' && hangChainCheck) return
    const result =
      call.method === 'getblockchaininfo'
        ? blockchainInfoJson(chain)
        : call.method === 'getbestblockhash'
          ? JSON.stringify(HASH_A)
          : call.method === 'sendrawtransaction'
            ? JSON.stringify(HASH_A)
            : 'null'
    response.end(`{"jsonrpc":"2.0","result":${result},"id":${call.id}}`)
  }
})
afterEach(async () => {
  await node.close()
})

function client(options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-write', 'broadcast'],
    ...options,
  })
}

const methods = (): string[] => node.calls().map(call => call.method)
const checks = (): number => methods().filter(method => method === 'getblockchaininfo').length

async function refusedAsMismatch(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => expect.fail('expected a refusal'),
    (e: unknown) => e
  )
  expect(RpcChainGuardError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason: 'mismatch', expected: 'regtest', actual: 'main' })
}

describe('chain guard freshness', () => {
  it('re-checks before a guarded call once the confirmation is older than chainCheckMaxAgeMs', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 50 })
    await rpc.confirmChain()
    await rpc.walletLock()
    expect(methods()).toEqual(['getblockchaininfo', 'walletlock'])
    expect(rpc.chainStatus).toBe('confirmed')

    await new Promise(resolve => setTimeout(resolve, 80))
    expect(rpc.chainStatus).toBe('stale')
    await rpc.walletLock()
    expect(methods()).toEqual(['getblockchaininfo', 'walletlock', 'getblockchaininfo', 'walletlock'])
    expect(rpc.chainStatus).toBe('confirmed')
  })

  it('refuses a broadcast, sending nothing, when the node behind the URL moved to another chain', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    chain = 'main' // the operator restarted qbitd on this port with another chain
    await refusedAsMismatch(rpc.sendRawTransaction(TX_HEX))
    expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo'])
    expect(rpc.chainStatus).toBe('mismatch')
    // It stays refused, without asking the node, until confirmChain() matches again.
    chain = 'regtest'
    await refusedAsMismatch(rpc.walletLock())
    expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo'])
    await rpc.confirmChain()
    await rpc.walletLock()
    expect(methods().at(-1)).toBe('walletlock')
  })

  it('goes stale on a connection error, so a restart onto another chain is caught', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 86_400_000 })
    await rpc.confirmChain()
    dropNextRead = true
    await expect(rpc.getBestBlockHash()).rejects.toMatchObject({ reason: 'network' })
    expect(rpc.chainStatus).toBe('stale')
    chain = 'main'
    await refusedAsMismatch(rpc.walletLock())
    expect(methods()).not.toContain('walletlock')
  })

  it('goes stale when the cookie changes, and re-checks before the next guarded call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-guard-'))
    try {
      const cookieFile = join(dir, '.cookie')
      await writeFile(cookieFile, '__cookie__:before-restart')
      const rpc = client({ auth: { cookieFile }, chainCheckMaxAgeMs: 86_400_000 })
      await rpc.confirmChain()
      await rpc.getBestBlockHash()
      expect(rpc.chainStatus).toBe('confirmed')
      await writeFile(cookieFile, '__cookie__:after-restart')
      await rpc.getBestBlockHash()
      expect(rpc.chainStatus).toBe('stale')
      await rpc.walletLock()
      expect(methods()).toEqual([
        'getblockchaininfo',
        'getbestblockhash',
        'getbestblockhash',
        'getblockchaininfo',
        'walletlock',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('re-checks when the cookie changed just before a guarded call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-guard-'))
    try {
      const cookieFile = join(dir, '.cookie')
      await writeFile(cookieFile, '__cookie__:before-restart')
      const rpc = client({ auth: { cookieFile }, chainCheckMaxAgeMs: 86_400_000 })
      await rpc.confirmChain()
      await writeFile(cookieFile, '__cookie__:after-restart')
      chain = 'main'
      await refusedAsMismatch(rpc.sendRawTransaction(TX_HEX))
      expect(methods()).toEqual(['getblockchaininfo', 'getblockchaininfo'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('goes stale after an HTTP 401', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 86_400_000 })
    await rpc.confirmChain()
    const handler = node.handler
    node.handler = (_request, response) => {
      response.statusCode = 401
      response.end()
    }
    await expect(rpc.getBestBlockHash()).rejects.toMatchObject({ status: 401 })
    expect(rpc.chainStatus).toBe('stale')
    node.handler = handler
    await rpc.walletLock()
    expect(checks()).toBe(2)
  })

  it('runs the re-check under the call deadline and reports its failure as definite', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    hangChainCheck = true
    const started = performance.now()
    const error = await rpc.sendRawTransaction(TX_HEX, { timeoutMs: 100 }).catch((e: unknown) => e)
    expect(performance.now() - started).toBeLessThan(600)
    expect(RpcTimeoutError.is(error)).toBe(true)
    expect(RpcUnknownOutcomeError.is(error)).toBe(false)
    expect(methods()).not.toContain('sendrawtransaction')
  })

  it('validates chainCheckMaxAgeMs', () => {
    for (const chainCheckMaxAgeMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => client({ chainCheckMaxAgeMs })).toThrow(RangeError)
    }
  })
})
