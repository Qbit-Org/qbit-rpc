import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QbitRpcClient, requests } from '../src'
import { argOptions } from '../src/own'
import type * as Own from '../src/own'
import { chainResults, FakeNode } from './helpers/fake-node'

// Counts the client's reads of its call options, which go through argOptions.
vi.mock('../src/own', async importOriginal => {
  const own = await importOriginal<typeof Own>()
  return { ...own, argOptions: vi.fn(own.argOptions) }
})

let node: FakeNode
let rpc: QbitRpcClient

beforeEach(async () => {
  node = await FakeNode.start()
  node.results({ ...chainResults('regtest'), getblockcount: '7' })
  rpc = new QbitRpcClient({ url: node.url, auth: { username: 'u', password: 'p' }, expectedChain: 'regtest' })
  vi.mocked(argOptions).mockClear()
})
afterEach(async () => {
  await node.close()
})

const reads = (): number => vi.mocked(argOptions).mock.calls.filter(([, name]) => name === 'callOptions').length

describe('call options', () => {
  it.each([
    ['a client method', (c: QbitRpcClient): Promise<unknown> => c.getBlockCount({ timeoutMs: 5_000 })],
    ['call()', (c: QbitRpcClient): Promise<unknown> => c.call('getblockcount', [], { timeoutMs: 5_000 })],
    ['batch()', (c: QbitRpcClient): Promise<unknown> => c.batch([requests.getBlockCount()], { timeoutMs: 5_000 })],
    ['confirmChain()', (c: QbitRpcClient): Promise<unknown> => c.confirmChain({ timeoutMs: 5_000 })],
  ])('are read and checked once by %s', async (_name, run) => {
    await run(rpc)
    expect(reads()).toBe(1)
    expect(node.requests).toHaveLength(1)
  })
})
