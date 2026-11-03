import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { JsonNumber, QbitRpcClient, requests, RpcChainGuardError, RpcError, type QbitRpcClientOptions } from '../../src'

// Runs only under scripts/regtest-smoke.sh, which starts a throwaway regtest
// node on loopback and sets these variables.
const env = process.env
const enabled = env['RUN_QBIT_REGTEST_SMOKE'] === '1'
const url = env['QBIT_REGTEST_RPC_URL'] ?? ''
const cookieFile = env['QBIT_REGTEST_COOKIE_FILE'] ?? ''
const [cliPath = '', ...cliArgs] = (env['QBIT_REGTEST_CLI'] ?? '').split(' ')

function cli(...args: string[]): string {
  return execFileSync(cliPath, [...cliArgs, ...args], { encoding: 'utf8' }).trim()
}

function client(options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  return new QbitRpcClient({ url, auth: { cookieFile }, expectedChain: 'regtest', ...options })
}

describe.runIf(enabled)('qbit Core v1.0.0 regtest', () => {
  it('reads and validates chain state', async () => {
    const rpc = client()
    const info = await rpc.getBlockchainInfo()
    expect(info.chain).toBe('regtest')
    expect(info.blocks).toBeGreaterThanOrEqual(101)
    const network = await rpc.getNetworkInfo()
    expect(network.subversion).toMatch(/qbit/i)
    const genesis = await rpc.getBlockHash(0)
    const tip = await rpc.getBestBlockHash()
    const tipHeader = await rpc.getBlockHeader(tip)
    expect(tipHeader.height).toBe(info.blocks)
    const genesisHeader = await rpc.getBlockHeader(genesis)
    expect(genesisHeader).not.toHaveProperty('previousBlockHash')
    const target = await rpc.getConfirmationTarget(100_000_000n, { securityLevel: 'high' })
    expect(target.requiredConfirmations).toBeGreaterThan(0)
    const fee = await rpc.estimateSmartFee(6)
    expect(fee.blocks).toBeGreaterThanOrEqual(0)
    const [hash1, header1, count] = await rpc.batch([
      requests.getBlockHash(1),
      requests.getBlockHeader(genesis),
      requests.raw('getblockcount'),
    ])
    expect(hash1.ok).toBe(true)
    expect(header1.ok && header1.value.hash).toBe(genesis)
    expect(count.ok && (count.value as JsonNumber).toSafeInteger()).toBe(info.blocks)
    const [missing] = await rpc.batch([requests.getBlockHash(1_000_000)])
    expect(!missing.ok && RpcError.is(missing.error) && missing.error.code).toBe(-8)
  })

  it('funds, signs, preflights and broadcasts a P2MR payment through the capability-gated client', async () => {
    const wallet = client({ wallet: 'smoke', capabilities: ['wallet-read', 'wallet-write', 'broadcast'] })
    await expect(wallet.walletCreateFundedPsbt({ outputs: [{ address: 'x', amountBits: 1n }] })).rejects.toSatisfy(
      RpcChainGuardError.is
    )
    await wallet.confirmChain()

    const info = await wallet.getWalletInfo()
    expect(info.walletName).toBe('smoke')
    expect(info.pqcKeyValidation.status).toBeTypeOf('string')
    const unspent = await wallet.listUnspent()
    expect(unspent.length).toBeGreaterThan(0)
    expect(typeof unspent[0]!.amountBits).toBe('bigint')

    const destination = (await wallet.call('getnewaddress', ['', 'p2mr'])) as string
    const validation = await wallet.validateAddress(destination)
    expect(validation).toMatchObject({ isValid: true, isWitness: true, witnessVersion: 2 })

    const funded = await wallet.walletCreateFundedPsbt({
      outputs: [{ address: destination, amountBits: 123_456_789n }],
      options: { feeRateBitsPerKvB: 1000n, changeType: 'p2mr' },
    })
    expect(funded.feeBits).toBeGreaterThan(0n)
    const processed = await wallet.walletProcessPsbt(funded.psbt)
    expect(processed.complete).toBe(true)
    expect(processed.pqcKeyStates?.length).toBeGreaterThan(0)
    expect(processed.pqcOverallLimitState).toBe('normal')
    const finalized = await wallet.finalizePsbt(processed.psbt)
    expect(finalized.hex).toBe(processed.hex)

    const [accepted] = await wallet.testMempoolAccept([processed.hex!])
    expect(accepted).toMatchObject({ allowed: true })
    const txid = await wallet.sendRawTransaction(processed.hex!)
    expect(txid).toBe(accepted!.txid)

    const tx = await wallet.getTransaction(txid)
    expect(tx.confirmations).toBe(0)
    expect(tx.feeBits).toBe(-funded.feeBits)
    const decoded = await wallet.getRawTransactionVerbose(txid)
    expect(decoded.vout.some(output => output.valueBits === 123_456_789n)).toBe(true)
    expect(await wallet.getRawTransaction(txid)).toBe(processed.hex)
  })

  it('locks and unlocks an encrypted wallet', async () => {
    const locked = client({ wallet: 'locked', capabilities: ['wallet-read', 'wallet-write'] })
    await locked.confirmChain()
    expect((await locked.getWalletInfo()).unlockedUntil).toBe(0)
    await expect(locked.walletPassphrase('wrong', 30)).rejects.toSatisfy(
      error => RpcError.is(error) && error.code === -14
    )
    await locked.walletPassphrase('smoke-passphrase', 30)
    expect((await locked.getWalletInfo()).unlockedUntil).toBeGreaterThan(0)
    await locked.walletLock()
    expect((await locked.getWalletInfo()).unlockedUntil).toBe(0)
  })

  it('verifies a data-hash PQC proof', async () => {
    const address = cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr')
    const messageHash = '11'.repeat(32)
    const proof = JSON.parse(cli('-rpcwallet=smoke', 'signdatapqchash', address, messageHash)) as Record<
      string,
      unknown
    >
    const rpc = client()
    const verified = await rpc.verifyDataPqcHash({
      address: proof['address'] as string,
      messageHash: proof['message_hash'] as string,
      signature: proof['signature'] as string,
      pubkey: proof['pubkey'] as string,
      leafScript: proof['leaf_script'] as string,
      controlBlock: proof['control_block'] as string,
      leafVersion: proof['leaf_version'] as number,
      proofMode: 'p2mr-pubkey',
    })
    expect(verified).toMatchObject({ valid: true, address, messageHash })
  })
})
