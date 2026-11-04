import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { QbitRpcClient, RpcUnknownOutcomeError } from '../src'
import { rpcErrorCode, RPC_INVALID_PARAMETER, RPC_NOT_FOUND, type CoreRpc } from './helpers/core-rpc'
import { chainResults, FakeNode, HASH_A, TX_HEX } from './helpers/fake-node'

// The compile-time proof, checked by `pnpm typecheck:test`: a QbitRpcClient
// is a CoreRpc as it stands, with no wrapper or cast.
const asCoreRpc = (rpc: QbitRpcClient): CoreRpc => rpc

// Every CoreRpc method; the type below fails to compile when one is missing.
const CORE_RPC_METHODS = [
  'getBlockchainInfo',
  'getBlockCount',
  'getBestBlockHash',
  'getMempoolEntry',
  'getTxOut',
  'getConfirmationTarget',
  'testMempoolAccept',
  'sendRawTransaction',
  'getWalletInfo',
  'getTransaction',
  'getAddressInfo',
  'getRawChangeAddress',
  'lockUnspent',
  'unlockUnspent',
  'listLockUnspent',
  'walletCreateFundedPsbt',
  'walletProcessPsbt',
  'finalizePsbt',
  'walletPassphrase',
  'walletLock',
] as const satisfies readonly (keyof CoreRpc)[]
const listsEveryMethod: [Exclude<keyof CoreRpc, (typeof CORE_RPC_METHODS)[number]>] extends [never] ? true : false =
  true

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
})
afterEach(async () => {
  await node.close()
})

async function core(): Promise<CoreRpc> {
  node.results(chainResults('regtest'))
  const rpc = new QbitRpcClient({
    url: node.url,
    wallet: 'treasury',
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
  })
  // The adapter's wiring: wallet-write and broadcast calls need a confirmed chain.
  await rpc.confirmChain()
  return asCoreRpc(rpc)
}

describe('CoreRpc from qbit-payments core-wallet', () => {
  it('is implemented by QbitRpcClient, method for method', async () => {
    expect(listsEveryMethod).toBe(true)
    const rpc = await core()
    // The adapter checks these at construction with `typeof rpc[method] === 'function'`.
    for (const method of CORE_RPC_METHODS) expect(typeof rpc[method]).toBe('function')
  })

  it('reaches the adapter with node error codes as rpcCode numbers, and unknown outcomes without one', async () => {
    const rpc = await core()
    node.rpc(call =>
      call.method === 'getmempoolentry'
        ? { error: { code: -5, message: 'Transaction not in mempool' } }
        : { error: { code: -8, message: 'Invalid parameter, output already locked' } }
    )
    const notFound = await rpc.getMempoolEntry(HASH_A).catch((e: unknown) => e)
    expect(rpcErrorCode(notFound)).toBe(RPC_NOT_FOUND)
    const locked = await rpc.lockUnspent([{ txid: HASH_A, vout: 0 }]).catch((e: unknown) => e)
    expect(rpcErrorCode(locked)).toBe(RPC_INVALID_PARAMETER)

    node.handler = (_request, response) => response.socket?.destroy()
    const dropped = await rpc.unlockUnspent([{ txid: HASH_A, vout: 0 }]).catch((e: unknown) => e)
    expect(RpcUnknownOutcomeError.is(dropped)).toBe(true)
    expect(rpcErrorCode(dropped)).toBeUndefined()
    expect(node.requests.at(-1)!.url).toBe('/wallet/treasury')
  })

  it("takes the adapter's call options as the last argument, apart from a method's own options", async () => {
    const rpc = await core()
    node.results({ gettxout: 'null' })
    expect(await rpc.getTxOut(HASH_A, 1, { includeMempool: true }, { timeoutMs: 1000 })).toBeNull()
    expect(node.calls().at(-1)!.params).toEqual([HASH_A, 1, true])
    const stopped = AbortSignal.abort('stop')
    await expect(rpc.getTxOut(HASH_A, 1, undefined, { signal: stopped })).rejects.toMatchObject({
      name: 'RpcAbortedError',
    })
    await expect(rpc.testMempoolAccept([TX_HEX], undefined, { signal: stopped })).rejects.toMatchObject({
      name: 'RpcAbortedError',
    })
  })

  it('reaches the adapter without a code when a transport error has a string one', async () => {
    const rpc = await core()
    await node.close()
    const refused = await rpc.getBlockCount().catch((e: unknown) => e)
    expect(refused).toMatchObject({ name: 'RpcTransportError', code: 'ECONNREFUSED' })
    expect(rpcErrorCode(refused)).toBeUndefined()
    node = await FakeNode.start() // for afterEach
  })

  it('reaches the adapter without a code when the node fails the chain re-check, not the call', async () => {
    node.results(chainResults('regtest'))
    const rpc = new QbitRpcClient({
      url: node.url,
      wallet: 'treasury',
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
      chainCheckMaxAgeMs: 0,
    })
    await rpc.confirmChain()
    node.rpc(() => ({ error: { code: -28, message: 'Loading block index' } }))
    const error = await asCoreRpc(rpc)
      .sendRawTransaction(TX_HEX)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'RpcChainGuardError', reason: 'check_failed', cause: { rpcCode: -28 } })
    expect(rpcErrorCode(error)).toBeUndefined()
  })
})
