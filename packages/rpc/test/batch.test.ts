import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { JsonNumber, QbitRpcClient, requests, RpcError, RpcResponseError, type RpcRequest } from '../src'
import { FakeNode, HASH_A, HASH_B } from './helpers/fake-node'

let node: FakeNode
let rpc: QbitRpcClient

beforeEach(async () => {
  node = await FakeNode.start()
  rpc = new QbitRpcClient({ url: node.url, auth: { username: 'u', password: 'p' }, expectedChain: 'regtest' })
})
afterEach(async () => {
  await node.close()
})

type Call = { id: number; method: string; params: unknown[] }
const item = (id: number, result: string): string => `{"jsonrpc":"2.0","result":${result},"id":${id}}`
const errorItem = (id: number, code: number, message: string): string =>
  `{"jsonrpc":"2.0","error":{"code":${code},"message":"${message}"},"id":${id}}`

describe('batch', () => {
  it('refuses an entry without a parse function as a TypeError, sending nothing', async () => {
    const entry = { method: 'getblockcount', params: [] } as unknown as RpcRequest<number>
    await expect(rpc.batch([requests.getBlockCount(), entry])).rejects.toThrow(
      new TypeError('batch() entry 1 has no parse function')
    )
    expect(node.calls()).toEqual([])
  })

  it.each([
    [
      'a String object',
      (): unknown => Object.assign(new String('sendrawtransaction'), { toString: (): string => 'getblockcount' }),
    ],
    [
      'an object with toJSON',
      (): unknown => ({ toString: (): string => 'getblockcount', toJSON: (): string => 'sendrawtransaction' }),
    ],
    ['an empty string', (): unknown => ''],
  ])('refuses a method name that is %s, so the method checked is the one sent', async (_name, method) => {
    const entry = { method: method(), params: ['00'], parse: (x: unknown) => x } as unknown as RpcRequest<unknown>
    await expect(rpc.batch([entry])).rejects.toThrow(
      new TypeError('batch() entry 0 has no method name: method must be a non-empty string')
    )
    expect(node.calls()).toEqual([])
  })

  it('refuses an oversized batch from its length, before reading its entries', async () => {
    await expect(rpc.batch(new Array(2000) as RpcRequest<unknown>[])).rejects.toThrow(
      new RangeError('a batch holds at most 1000 requests')
    )
    expect(node.calls()).toEqual([])
  })

  it('sends one request and matches replies by id, whatever their order', async () => {
    node.handler = (request, response) => {
      const calls = JSON.parse(request.body) as Call[]
      const replies = calls.map(call =>
        call.method === 'getblockhash'
          ? item(call.id, JSON.stringify((call.params[0] as number) === 1 ? HASH_A : HASH_B))
          : item(call.id, '7')
      )
      response.end(`[${replies.reverse().join(',')}]`)
    }
    const [first, second, count] = await rpc.batch([
      requests.getBlockHash(1),
      requests.getBlockHash(2),
      requests.raw('getblockcount'),
    ])
    expect(first).toEqual({ ok: true, value: HASH_A })
    expect(second).toEqual({ ok: true, value: HASH_B })
    expect(count.ok && count.value instanceof JsonNumber && count.value.toSafeInteger()).toBe(7)
    expect(node.requests).toHaveLength(1)
    const sent = JSON.parse(node.requests[0]!.body) as Call[]
    expect(sent.map(call => call.method)).toEqual(['getblockhash', 'getblockhash', 'getblockcount'])
    expect(new Set(sent.map(call => call.id)).size).toBe(3)
  })

  it('reports node errors, invalid results and missing replies per item', async () => {
    node.handler = (request, response) => {
      // The fourth request gets no reply item at all.
      const [a, b, c] = JSON.parse(request.body) as Call[]
      response.end(
        `[${item(a!.id, JSON.stringify(HASH_A))},${errorItem(b!.id, -8, 'Block height out of range')},${item(c!.id, '"NOT-A-HASH"')}]`
      )
    }
    const results = await rpc.batch([
      requests.getBlockHash(1),
      requests.getBlockHash(999),
      requests.getBlockHash(3),
      requests.getBlockHash(4),
    ])
    expect(results[0]).toEqual({ ok: true, value: HASH_A })
    expect(results[1].ok).toBe(false)
    const nodeError = !results[1].ok ? results[1].error : undefined
    expect(RpcError.is(nodeError) && nodeError.rpcCode).toBe(-8)
    const invalid = !results[2].ok ? results[2].error : undefined
    expect(RpcResponseError.is(invalid) && invalid.reason).toBe('validation')
    const missing = !results[3].ok ? results[3].error : undefined
    expect(RpcResponseError.is(missing) && missing.reason).toBe('protocol')
  })

  it.each([
    ['not an array', (calls: Call[]) => item(calls[0]!.id, '1')],
    [
      'an unknown id',
      (calls: Call[]) => `[${item(calls[0]!.id, JSON.stringify(HASH_A))},${item(424242, JSON.stringify(HASH_A))}]`,
    ],
    [
      'a duplicated id',
      (calls: Call[]) =>
        `[${item(calls[0]!.id, JSON.stringify(HASH_A))},${item(calls[0]!.id, JSON.stringify(HASH_A))}]`,
    ],
    ['a string id', (calls: Call[]) => `[{"jsonrpc":"2.0","result":"${HASH_A}","id":"${calls[0]!.id}"}]`],
  ])('rejects the whole batch for %s', async (_label, body) => {
    node.handler = (request, response) => response.end(body(JSON.parse(request.body) as Call[]))
    const error = await rpc.batch([requests.getBlockHash(1), requests.getBlockHash(2)]).catch((e: unknown) => e)
    expect(RpcResponseError.is(error)).toBe(true)
    expect((error as RpcResponseError).reason).toBe('protocol')
  })

  it('sends nothing for an empty batch and refuses oversized ones', async () => {
    expect(await rpc.batch([])).toEqual([])
    await expect(rpc.batch(Array.from({ length: 1001 }, () => requests.getBestBlockHash()))).rejects.toThrow(RangeError)
    expect(node.requests).toHaveLength(0)
  })

  it('validates request arguments when they are built', () => {
    expect(() => requests.getBlockHash(-1)).toThrow(RangeError)
    expect(() => requests.getBlockHash(1.5)).toThrow(RangeError)
    expect(() => requests.getBlockHeader('xyz')).toThrow(TypeError)
    expect(() => requests.raw('')).toThrow(TypeError)
  })
})
