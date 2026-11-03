import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { QbitRpcClient, RpcUnknownOutcomeError } from '../src'
import { rpcErrorCode, RPC_INVALID_PARAMETER, RPC_NOT_FOUND, type CoreRpc } from './helpers/core-rpc'
import { blockchainInfoJson, FakeNode, HASH_A } from './helpers/fake-node'

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
  node.results({ getblockchaininfo: blockchainInfoJson('regtest') })
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

  it('reaches the adapter with node error codes as numbers, and unknown outcomes without one', async () => {
    const rpc = await core()
    node.rpc(call =>
      call.method === 'getmempoolentry'
        ? { error: { code: -5, message: 'Transaction not in mempool' } }
        : { error: { code: -8, message: 'Invalid parameter, output already locked' } }
    )
    const notFound = await rpc.getMempoolEntry(HASH_A).catch((e: unknown) => e)
    expect(rpcErrorCode(notFound)).toBe(RPC_NOT_FOUND)
    const locked = await rpc.lockUnspent(false, [{ txid: HASH_A, vout: 0 }]).catch((e: unknown) => e)
    expect(rpcErrorCode(locked)).toBe(RPC_INVALID_PARAMETER)

    node.handler = (_request, response) => response.socket?.destroy()
    const dropped = await rpc.lockUnspent(true, [{ txid: HASH_A, vout: 0 }]).catch((e: unknown) => e)
    expect(RpcUnknownOutcomeError.is(dropped)).toBe(true)
    expect(rpcErrorCode(dropped)).toBeUndefined()
    expect(node.requests.at(-1)!.url).toBe('/wallet/treasury')
  })
})
