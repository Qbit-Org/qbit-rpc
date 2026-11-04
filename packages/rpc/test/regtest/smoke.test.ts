import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import {
  JsonNumber,
  QbitRpcClient,
  requests,
  RpcChainGuardError,
  RpcError,
  type Outpoint,
  type QbitRpcClientOptions,
} from '../../src'
import type { CoreRpc } from '../helpers/core-rpc'

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

  // Every option name the client sends must change what the node does: qbit
  // Core's option type check accepts some aliases (subtract_fee_from_outputs)
  // that it then ignores. Runs before the payment test, while every coin in
  // the smoke wallet is confirmed.
  it('sends walletcreatefundedpsbt and listunspent options under names the node acts on', async () => {
    const wallet = client({ wallet: 'smoke', capabilities: ['wallet-read', 'wallet-write', 'broadcast'] })
    await wallet.confirmChain()
    const own = async (): Promise<string> => (await wallet.call('getnewaddress', ['', 'p2mr'])) as string
    type Decoded = {
      tx: {
        version: JsonNumber
        locktime: JsonNumber
        vin: { txid: string; sequence: JsonNumber }[]
        vout: { value: JsonNumber; scriptPubKey: { address?: string } }[]
      }
    }
    const decode = async (psbt: string): Promise<Decoded['tx']> =>
      ((await wallet.call('decodepsbt', [psbt])) as Decoded).tx
    const nodeError = (code?: number) => (error: unknown) =>
      RpcError.is(error) && (code === undefined || error.code === code)
    const amountTo = (tx: Decoded['tx'], address: string): bigint =>
      tx.vout.find(output => output.scriptPubKey.address === address)!.value.toBits()

    // listunspent query options.
    const all = await wallet.listUnspent()
    expect(all.length).toBeGreaterThan(1)
    expect(await wallet.listUnspent({ maximumCount: 1 })).toHaveLength(1)
    expect(await wallet.listUnspent({ minimumAmountBits: 21_000_000_000_000_000n })).toEqual([])
    expect(await wallet.listUnspent({ maximumAmountBits: 1n })).toEqual([])
    expect(await wallet.listUnspent({ minimumSumAmountBits: 1n })).toHaveLength(1)
    expect((await wallet.listUnspent({ includeImmatureCoinbase: true })).length).toBeGreaterThan(all.length)

    // Coin selection limits: all coins are confirmed, and none has 2,000 confirmations.
    const target = await own()
    const small = { outputs: [{ address: target, amountBits: 10_000_000n }] }
    await expect(wallet.walletCreateFundedPsbt({ ...small, options: { maxConf: 0 } })).rejects.toSatisfy(nodeError())
    await expect(wallet.walletCreateFundedPsbt({ ...small, options: { minConf: 2000 } })).rejects.toSatisfy(nodeError())
    await expect(wallet.walletCreateFundedPsbt({ ...small, options: { maxTxWeight: 1000 } })).rejects.toSatisfy(
      nodeError()
    )
    await expect(wallet.walletCreateFundedPsbt({ ...small, options: { changeType: 'not-a-type' } })).rejects.toSatisfy(
      nodeError()
    )

    // add_inputs: one coin pinned, and more needed than it holds.
    const [coin] = all
    const pinned = {
      inputs: [{ txid: coin!.txid, vout: coin!.vout }],
      outputs: [{ address: target, amountBits: coin!.amountBits + 100_000_000n }],
    }
    await expect(wallet.walletCreateFundedPsbt({ ...pinned, options: { addInputs: false } })).rejects.toSatisfy(
      nodeError()
    )
    const added = await decode((await wallet.walletCreateFundedPsbt({ ...pinned, options: { addInputs: true } })).psbt)
    expect(added.vin.length).toBeGreaterThan(1)

    // Input sequence, locktime, version, replaceable, change address and position.
    const change = await own()
    const shaped = await wallet.walletCreateFundedPsbt({
      inputs: [{ txid: coin!.txid, vout: coin!.vout, sequence: 4_294_967_293 }],
      outputs: [{ address: target, amountBits: 10_000_000n }],
      locktime: 5,
      version: 1,
      options: { changeAddress: change, changePosition: 0 },
    })
    expect(shaped.changePos).toBe(0)
    const shapedTx = await decode(shaped.psbt)
    expect(shapedTx.vin[0]!.sequence.toSafeInteger()).toBe(4_294_967_293)
    expect(shapedTx.locktime.toSafeInteger()).toBe(5)
    expect(shapedTx.version.toSafeInteger()).toBe(1)
    expect(shapedTx.vout[0]!.scriptPubKey.address).toBe(change)
    for (const replaceable of [true, false]) {
      const tx = await decode((await wallet.walletCreateFundedPsbt({ ...small, options: { replaceable } })).psbt)
      expect(tx.vin.every(input => input.sequence.toSafeInteger() === (replaceable ? 0xfffffffd : 0xfffffffe))).toBe(
        true
      )
    }

    // fee_rate scales the fee.
    const cheap = await wallet.walletCreateFundedPsbt({ ...small, options: { feeRateBitsPerKvB: 1000n } })
    const dear = await wallet.walletCreateFundedPsbt({ ...small, options: { feeRateBitsPerKvB: 4000n } })
    expect(dear.feeBits).toBeGreaterThan(3n * cheap.feeBits)

    // conf_target and estimate_mode: the node rejects each next to fee_rate, so it reads them.
    for (const key of ['conf_target', 'estimate_mode']) {
      const options = { fee_rate: 1, [key]: key === 'conf_target' ? 2 : 'economical' }
      await expect(wallet.call('walletcreatefundedpsbt', [[], [{ [target]: 0.1 }], 0, options])).rejects.toSatisfy(
        error => RpcError.is(error) && error.message.includes(`Cannot specify both ${key}`)
      )
    }
    expect(
      (await wallet.walletCreateFundedPsbt({ ...small, options: { confTarget: 2, estimateMode: 'economical' } }))
        .feeBits
    ).toBeGreaterThan(0n)

    // lock_unspents.
    const locked = await decode(
      (await wallet.walletCreateFundedPsbt({ ...small, options: { lockUnspents: true } })).psbt
    )
    const lockedList = (await wallet.call('listlockunspent')) as { txid: string }[]
    expect(locked.vin.every(input => lockedList.some(entry => entry.txid === input.txid))).toBe(true)
    await wallet.call('lockunspent', [true])

    // subtractFeeFromOutputs: without it the wallet pays the fee; with it the
    // recipient does. Broadcast the second to prove it end to end. The
    // recipient is another wallet, whose coin is then unconfirmed and foreign.
    execFileSync(cliPath, [...cliArgs, '-named', 'createwallet', 'wallet_name=other', 'descriptors=true'])
    const recipient = cli('-rpcwallet=other', 'getnewaddress', '', 'p2mr')
    const payment = {
      outputs: [{ address: recipient, amountBits: 50_000_000n }],
      options: { feeRateBitsPerKvB: 2500n },
    }
    const walletPays = await wallet.walletCreateFundedPsbt(payment)
    expect(amountTo(await decode(walletPays.psbt), recipient)).toBe(50_000_000n)
    const recipientPays = await wallet.walletCreateFundedPsbt({
      ...payment,
      options: { ...payment.options, subtractFeeFromOutputs: [0] },
    })
    expect(recipientPays.feeBits).toBeGreaterThan(0n)
    expect(amountTo(await decode(recipientPays.psbt), recipient)).toBe(50_000_000n - recipientPays.feeBits)
    // The node accepts subtract_fee_from_outputs and then ignores it, so the
    // wallet pays; call() refuses it, and the typed method rejects the key.
    const ignored = JSON.parse(
      cli(
        '-rpcwallet=smoke',
        'walletcreatefundedpsbt',
        '[]',
        JSON.stringify([{ [recipient]: 0.5 }]),
        '0',
        JSON.stringify({ subtract_fee_from_outputs: [0], fee_rate: 2.5 })
      )
    ) as { psbt: string }
    expect(amountTo(await decode(ignored.psbt), recipient)).toBe(50_000_000n)
    await expect(
      wallet.call('walletcreatefundedpsbt', [[], [{ [recipient]: '0.5' }], 0, { subtract_fee_from_outputs: [0] }])
    ).rejects.toThrow(/accepted and then ignored/)
    await expect(
      wallet.walletCreateFundedPsbt({ ...payment, options: { subtract_fee_from_outputs: [0] } } as never)
    ).rejects.toThrow(/use args\.options\.subtractFeeFromOutputs/)
    const signed = await wallet.walletProcessPsbt(recipientPays.psbt)
    const txid = await wallet.sendRawTransaction(signed.hex!)
    const sent = await wallet.getRawTransactionVerbose(txid)
    expect(sent.vout.find(output => output.scriptPubKey.address === recipient)!.valueBits).toBe(
      50_000_000n - recipientPays.feeBits
    )

    // include_unsafe: the other wallet's only coin is unconfirmed and came from outside keys.
    const other = client({ wallet: 'other', capabilities: ['wallet-write'] })
    await other.confirmChain()
    const spendUnsafe = { outputs: [{ address: target, amountBits: 10_000_000n }] }
    await expect(other.walletCreateFundedPsbt({ ...spendUnsafe, options: { includeUnsafe: false } })).rejects.toSatisfy(
      nodeError()
    )
    expect(
      (await other.walletCreateFundedPsbt({ ...spendUnsafe, options: { includeUnsafe: true } })).feeBits
    ).toBeGreaterThan(0n)
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

  // Every method qbit-payments' core-wallet adapter reaches, through its own
  // CoreRpc interface, on the client it is wired with.
  it('serves the payout adapter: chain tip, outputs, mempool, addresses, change and coin locks', async () => {
    const wallet = client({ wallet: 'smoke', capabilities: ['wallet-read', 'wallet-write', 'broadcast'] })
    await wallet.confirmChain()
    const core: CoreRpc = wallet
    const nodeError = (code: number) => (error: unknown) => RpcError.is(error) && error.code === code
    const sorted = (outpoints: Outpoint[]): Outpoint[] =>
      [...outpoints].sort((a, b) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`))
    cli('-named', 'createwallet', 'wallet_name=adapter-foreign', 'descriptors=true')
    const foreign = cli('-rpcwallet=adapter-foreign', 'getnewaddress', '', 'p2mr')

    // getblockcount.
    const height = await core.getBlockCount()
    expect(height).toBe((await wallet.getBlockchainInfo()).blocks)

    // getrawchangeaddress, and getaddressinfo with the PQC signature budget.
    const change = await core.getRawChangeAddress({ addressType: 'p2mr' })
    const changeInfo = await wallet.getAddressInfo(change)
    expect(changeInfo).toMatchObject({
      address: change,
      isMine: true,
      solvable: true,
      isChange: true,
      witnessVersion: 2,
    })
    expect(changeInfo.pqcKeyStates).toHaveLength(1)
    const [changeKey] = changeInfo.pqcKeyStates!
    expect(changeKey).toMatchObject({ pqcSignatureCount: 0, pqcSignatureLimit: 2 ** 30, pqcLimitState: 'normal' })
    expect(changeInfo).toMatchObject({
      pqcOverallLimitState: 'normal',
      pqcSignatureCount: 0,
      pqcSignatureLimit: 2 ** 30,
      pqcSignaturesRemaining: 2 ** 30,
      pqcLimitState: 'normal',
    })
    expect(await wallet.getRawChangeAddress()).toMatch(/^qbrt1z/)
    await expect(wallet.getRawChangeAddress({ addressType: 'bogus' })).rejects.toSatisfy(nodeError(-5))
    const locked = client({ wallet: 'locked', capabilities: ['wallet-write'] })
    await locked.confirmChain()
    expect(await locked.getRawChangeAddress({ addressType: 'p2mr' })).toMatch(/^qbrt1z/)
    const receive = (await wallet.call('getnewaddress', ['', 'p2mr'])) as string
    expect(await wallet.getAddressInfo(receive.toUpperCase())).toMatchObject({ address: receive, isChange: false })
    const foreignInfo = await core.getAddressInfo(foreign)
    expect(foreignInfo).toMatchObject({ address: foreign, isMine: false, solvable: false })
    expect(foreignInfo).not.toHaveProperty('pqcKeyStates')
    await expect(
      wallet.getAddressInfo('qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw')
    ).rejects.toSatisfy(nodeError(-5))

    // gettxout of a confirmed coin.
    const [coin, second] = await wallet.listUnspent()
    const outpoint = { txid: coin!.txid, vout: coin!.vout }
    const other = { txid: second!.txid, vout: second!.vout }
    const unspent = await core.getTxOut(coin!.txid, coin!.vout)
    expect(unspent).toMatchObject({
      confirmations: coin!.confirmations,
      valueBits: coin!.amountBits,
      scriptPubKey: { hex: coin!.scriptPubKey, address: coin!.address, type: 'witness_v2_p2mr' },
    })
    expect(unspent!.bestBlock).toBe(await wallet.getBestBlockHash())
    expect(unspent!.coinbase).toBe('coinbase' in (await wallet.getRawTransactionVerbose(coin!.txid)).vin[0]!)
    expect(await wallet.getTxOut(coin!.txid, 999)).toBeNull()

    // lockunspent and listlockunspent.
    await wallet.call('lockunspent', [true])
    expect(await core.listLockUnspent()).toEqual([])
    expect(await core.lockUnspent(false, [outpoint])).toBe(true)
    expect(await core.listLockUnspent()).toEqual([outpoint])
    expect((await wallet.listUnspent()).some(u => u.txid === coin!.txid && u.vout === coin!.vout)).toBe(false)
    await expect(wallet.lockUnspent(false, [outpoint])).rejects.toSatisfy(nodeError(-8))
    // One bad output and the node changes nothing.
    await expect(wallet.lockUnspent(false, [other, { txid: '00'.repeat(32), vout: 0 }])).rejects.toSatisfy(
      nodeError(-8)
    )
    await expect(wallet.lockUnspent(false, [{ txid: coin!.txid, vout: 999 }])).rejects.toSatisfy(nodeError(-8))
    await expect(wallet.lockUnspent(true, [outpoint, other])).rejects.toSatisfy(nodeError(-8))
    expect(await wallet.listLockUnspent()).toEqual([outpoint])
    expect(await wallet.lockUnspent(false, [other], { persistent: true })).toBe(true)
    expect(sorted(await wallet.listLockUnspent())).toEqual(sorted([outpoint, other]))
    expect(await wallet.lockUnspent(true, [outpoint, other])).toBe(true)
    expect(await wallet.listLockUnspent()).toEqual([])
    await expect(wallet.lockUnspent(true, [outpoint])).rejects.toSatisfy(nodeError(-8))

    // Spend the coin: signing uses one signature of its key, which getaddressinfo reports.
    const before = await wallet.getAddressInfo(coin!.address!)
    const funded = await wallet.walletCreateFundedPsbt({
      inputs: [outpoint],
      outputs: [{ address: foreign, amountBits: 100_000_000n }],
      options: { addInputs: false, changeAddress: change, feeRateBitsPerKvB: 2000n },
    })
    const signed = await wallet.walletProcessPsbt(funded.psbt)
    const after = await wallet.getAddressInfo(coin!.address!)
    expect(after.pqcKeyStates![0]!.pqcSignatureCount).toBe(before.pqcKeyStates![0]!.pqcSignatureCount + 1)
    expect(after.pqcSignaturesRemaining).toBe(before.pqcSignaturesRemaining! - 1)
    expect(signed.pqcKeyStates![0]!.pqcSignatureCount).toBe(after.pqcSignatureCount)
    const txid = await wallet.sendRawTransaction(signed.hex!)
    const decoded = await wallet.getRawTransactionVerbose(txid)
    expect(decoded.vout[funded.changePos]!.scriptPubKey.address).toBe(change)
    const paid = decoded.vout.findIndex(output => output.scriptPubKey.address === foreign)

    // getmempoolentry, and gettxout with and without the mempool.
    const entry = await wallet.getMempoolEntry(txid)
    expect(entry).toMatchObject({ height, ancestorCount: 1, descendantCount: 1, depends: [], spentBy: [] })
    expect(entry.fees.baseBits).toBe(funded.feeBits)
    expect(entry.vsize).toBe(entry.weight)
    expect(entry.wtxid).toBe(decoded.hash)
    expect(typeof (await core.getMempoolEntry(txid))).toBe('object')
    expect(await core.getTxOut(coin!.txid, coin!.vout, { includeMempool: true })).toBeNull()
    expect(await wallet.getTxOut(coin!.txid, coin!.vout, { includeMempool: false })).toMatchObject({
      valueBits: coin!.amountBits,
    })
    expect(await wallet.getTxOut(txid, paid)).toMatchObject({
      confirmations: 0,
      valueBits: 100_000_000n,
      coinbase: false,
      scriptPubKey: { address: foreign },
    })
    expect(await wallet.getTxOut(txid, paid, { includeMempool: false })).toBeNull()

    // A child spending the change: the two entries name each other.
    const childFunded = await wallet.walletCreateFundedPsbt({
      inputs: [{ txid, vout: funded.changePos }],
      outputs: [{ address: foreign, amountBits: 100_000_000n }],
      options: { addInputs: false, feeRateBitsPerKvB: 2000n },
    })
    const child = await wallet.sendRawTransaction((await wallet.walletProcessPsbt(childFunded.psbt)).hex!)
    expect((await wallet.getMempoolEntry(txid)).spentBy).toEqual([child])
    expect(await wallet.getMempoolEntry(child)).toMatchObject({ depends: [txid], ancestorCount: 2 })

    // Mined: out of the mempool, and confirmed in the UTXO set.
    cli('generatetoaddress', '1', foreign)
    expect(await core.getBlockCount()).toBe(height + 1)
    await expect(core.getMempoolEntry(txid)).rejects.toSatisfy(nodeError(-5))
    expect(await wallet.getTxOut(txid, paid, { includeMempool: false })).toMatchObject({ confirmations: 1 })

    // The read and wallet-read methods in one batch.
    const [count, spent, info, locks, gone] = await wallet.batch([
      requests.getBlockCount(),
      requests.getTxOut(coin!.txid, coin!.vout),
      requests.getAddressInfo(change),
      requests.listLockUnspent(),
      requests.getMempoolEntry(txid),
    ])
    expect(count).toEqual({ ok: true, value: height + 1 })
    expect(spent).toEqual({ ok: true, value: null })
    expect(info.ok && info.value.isChange).toBe(true)
    expect(locks).toEqual({ ok: true, value: [] })
    expect(!gone.ok && RpcError.is(gone.error) && gone.error.code).toBe(-5)
  })

  // listsinceblock, listtransactions, getbalances and getnewaddress on wallets
  // this case creates, funded from the script's smoke wallet, with a payout
  // made the adapter's way and a reorg made through the CLI. It ends on the
  // most-work chain with no block marked invalid.
  it('lists wallet history and balances, follows a reorg through listSinceBlock, and labels new addresses', async () => {
    cli('-named', 'createwallet', 'wallet_name=history', 'descriptors=true')
    cli('-named', 'createwallet', 'wallet_name=history-peer', 'descriptors=true')
    cli('-named', 'createwallet', 'wallet_name=history-reuse', 'descriptors=true', 'avoid_reuse=true')
    cli('-named', 'createwallet', 'wallet_name=history-locked', 'descriptors=true', 'passphrase=history-passphrase')
    const wallet = client({ wallet: 'history', capabilities: ['wallet-read', 'wallet-write', 'broadcast'] })
    const peer = client({ wallet: 'history-peer', capabilities: ['wallet-read', 'wallet-write'] })
    await wallet.confirmChain()
    await peer.confirmChain()
    const nodeError = (code: number) => (error: unknown) => RpcError.is(error) && error.code === code
    const mineTo = await peer.getNewAddress({ addressType: 'p2mr' })
    const mine = (blocks = 1, to = mineTo): string[] =>
      JSON.parse(cli('generatetoaddress', String(blocks), to)) as string[]

    // A new wallet: nothing listed, and zero balances; avoid_reuse adds a used balance.
    const tip = await wallet.getBestBlockHash()
    expect(await wallet.listSinceBlock()).toEqual({ transactions: [], removed: [], lastBlock: tip })
    expect(await wallet.listTransactions()).toEqual([])
    expect(await wallet.getBalances()).toEqual({
      mine: { trustedBits: 0n, untrustedPendingBits: 0n, immatureBits: 0n },
      lastProcessedBlock: { hash: tip, height: await wallet.getBlockCount() },
    })
    const reuse = client({ wallet: 'history-reuse', capabilities: ['wallet-read'] })
    expect((await reuse.getBalances()).mine).toEqual({
      trustedBits: 0n,
      untrustedPendingBits: 0n,
      immatureBits: 0n,
      usedBits: 0n,
    })

    // getnewaddress: a label, the default label, and errors the node answers.
    const label = 'deposit-alice'
    const deposit = await wallet.getNewAddress({ label, addressType: 'p2mr' })
    expect((await wallet.getAddressInfo(deposit)).labels).toEqual([label])
    expect((await wallet.getAddressInfo(await wallet.getNewAddress())).labels).toEqual([''])
    await expect(wallet.getNewAddress({ addressType: 'bogus' })).rejects.toSatisfy(nodeError(-5))
    await expect(wallet.getNewAddress({ label: '*' })).rejects.toThrow(RangeError)
    await expect(wallet.call('getnewaddress', ['*'])).rejects.toSatisfy(nodeError(-11))
    // A wallet encrypted at creation, still locked.
    const locked = client({ wallet: 'history-locked', capabilities: ['wallet-write'] })
    await locked.confirmChain()
    await expect(locked.getNewAddress()).rejects.toSatisfy(nodeError(-12))
    expect(await locked.getNewAddress({ label, addressType: 'p2mr' })).toMatch(/^qbrt1z/)

    // A deposit from another wallet: unconfirmed and untrusted, then mined.
    // sendrawtransaction returns once the wallets have seen the transaction;
    // the CLI's sendtoaddress does not wait for that.
    const funder = client({ wallet: 'smoke', capabilities: ['wallet-write', 'broadcast'] })
    await funder.confirmChain()
    const funding = await funder.walletCreateFundedPsbt({ outputs: [{ address: deposit, amountBits: 2_000_000_000n }] })
    const fundTxid = await funder.sendRawTransaction((await funder.walletProcessPsbt(funding.psbt)).hex!)
    const pending = await wallet.listSinceBlock({ blockHash: tip })
    expect(pending.transactions).toEqual([
      expect.objectContaining({
        category: 'receive',
        address: deposit,
        label,
        amountBits: 2_000_000_000n,
        txid: fundTxid,
        confirmations: 0,
        trusted: false,
        abandoned: false,
      }),
    ])
    expect(pending.transactions[0]).not.toHaveProperty('blockHash')
    expect((await wallet.getBalances()).mine).toMatchObject({ trustedBits: 0n, untrustedPendingBits: 2_000_000_000n })
    expect(await wallet.listTransactions({ label })).toEqual(pending.transactions)
    expect(await wallet.listTransactions({ label: 'nobody' })).toEqual([])
    const [funded] = mine()
    const fundedHeader = await wallet.getBlockHeader(funded!)
    const [deposited] = (await wallet.listSinceBlock({ blockHash: tip })).transactions
    expect(deposited).toMatchObject({
      txid: fundTxid,
      confirmations: 1,
      blockHash: funded,
      blockHeight: fundedHeader.height,
      blockTime: fundedHeader.time,
    })
    expect(deposited!.blockIndex).toBeGreaterThan(0)
    expect(deposited).not.toHaveProperty('trusted')
    expect(await wallet.getBalances()).toEqual({
      mine: { trustedBits: 2_000_000_000n, untrustedPendingBits: 0n, immatureBits: 0n },
      lastProcessedBlock: { hash: funded, height: fundedHeader.height },
    })

    // A payout made as the adapter makes one, then its listsinceblock call
    // (listsinceblock(blockHash, 1, false, false, true)): the wallet's sends,
    // by txid. With change included, the change output is a send and a
    // receive entry too.
    const cursor = funded!
    const payee = await peer.getNewAddress({ label: 'payee', addressType: 'p2mr' })
    const built = await wallet.walletCreateFundedPsbt({
      outputs: [{ address: payee, amountBits: 500_000_000n }],
      options: { feeRateBitsPerKvB: 2000n, changeType: 'p2mr' },
    })
    const payout = await wallet.sendRawTransaction((await wallet.walletProcessPsbt(built.psbt)).hex!)
    const decoded = await wallet.getRawTransactionVerbose(payout)
    const paidVout = decoded.vout.findIndex(output => output.scriptPubKey.address === payee)
    const adapterCall = await wallet.listSinceBlock({
      blockHash: cursor,
      targetConfirmations: 1,
      includeWatchOnly: false,
      includeRemoved: false,
      includeChange: true,
    })
    expect(adapterCall).not.toHaveProperty('removed')
    expect(adapterCall.lastBlock).toBe(cursor)
    const sends = adapterCall.transactions.filter(entry => entry.category === 'send')
    expect(sends.map(entry => entry.txid)).toEqual([payout, payout])
    expect(sends.map(entry => entry.vout).sort()).toEqual([0, 1])
    expect(adapterCall.transactions.filter(entry => entry.category === 'receive')).toHaveLength(1)
    const withChange = await wallet.listSinceBlock({ blockHash: cursor, targetConfirmations: 1, includeChange: true })
    expect(withChange).toEqual({ ...adapterCall, removed: [] })
    // Without change: one send entry, the payment, in exact bits.
    const [sent] = (await wallet.listSinceBlock({ blockHash: cursor })).transactions
    expect(sent).toMatchObject({
      category: 'send',
      address: payee,
      amountBits: -500_000_000n,
      feeBits: -built.feeBits,
      vout: paidVout,
      confirmations: 0,
      trusted: true,
      abandoned: false,
      wtxid: decoded.hash,
    })
    expect(sent).not.toHaveProperty('label')
    expect((await wallet.getTransaction(payout)).feeBits).toBe(sent!.feeBits)
    // The change is the wallet's own, so it stays trusted.
    expect((await wallet.getBalances()).mine).toEqual({
      trustedBits: 2_000_000_000n - 500_000_000n - built.feeBits,
      untrustedPendingBits: 0n,
      immatureBits: 0n,
    })
    expect(await peer.listTransactions({ label: 'payee' })).toEqual([
      expect.objectContaining({ category: 'receive', txid: payout, amountBits: 500_000_000n, vout: paidVout }),
    ])
    expect((await peer.getBalances()).mine.untrustedPendingBits).toBe(500_000_000n)

    // listtransactions: oldest first, count and skip from the newest.
    const recent = await wallet.listTransactions()
    expect(recent.map(entry => [entry.category, entry.txid])).toEqual([
      ['receive', fundTxid],
      ['send', payout],
    ])
    expect(await wallet.listTransactions({ count: 1 })).toEqual([recent[1]])
    expect(await wallet.listTransactions({ count: 1, skip: 1 })).toEqual([recent[0]])
    expect(await wallet.listTransactions({ count: 0 })).toEqual([])
    await expect(wallet.call('listtransactions', [''])).rejects.toSatisfy(nodeError(-8))

    // Mined in block B; lastBlock follows targetConfirmations.
    const blockB = mine()[0]!
    const minedB = await wallet.listSinceBlock({ blockHash: cursor })
    expect(minedB.lastBlock).toBe(blockB)
    expect(minedB.transactions).toEqual([
      expect.objectContaining({ txid: payout, confirmations: 1, blockHash: blockB }),
    ])
    expect((await wallet.listSinceBlock({ blockHash: cursor, targetConfirmations: 2 })).lastBlock).toBe(cursor)
    expect((await wallet.listSinceBlock({ blockHash: cursor, targetConfirmations: 2_147_483_647 })).lastBlock).toBe(
      await wallet.getBlockHash(0)
    )
    await expect(wallet.listSinceBlock({ blockHash: 'ab'.repeat(32) })).rejects.toSatisfy(nodeError(-5))
    await expect(wallet.call('listsinceblock', [cursor, 0])).rejects.toSatisfy(nodeError(-8))

    // Reorg: invalidate B. A cursor at B gets the payout back in removed, and
    // in transactions as unconfirmed; the peer's coinbase from B is orphaned.
    try {
      cli('invalidateblock', blockB)
      const reorged = await wallet.listSinceBlock({ blockHash: blockB })
      expect(reorged.lastBlock).toBe(cursor)
      expect(reorged.removed).toEqual([
        expect.objectContaining({ txid: payout, category: 'send', amountBits: -500_000_000n, confirmations: 0 }),
      ])
      expect(reorged.removed![0]).not.toHaveProperty('blockHash')
      expect(reorged.transactions).toContainEqual(reorged.removed![0])
      expect(await wallet.listSinceBlock({ blockHash: blockB, includeRemoved: false })).not.toHaveProperty('removed')
      expect((await peer.listSinceBlock({ blockHash: blockB })).removed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ txid: payout, category: 'receive', label: 'payee' }),
          expect.objectContaining({ category: 'orphan', abandoned: true, generated: true, confirmations: 0 }),
        ])
      )
      expect((await wallet.getBalances()).lastProcessedBlock).toEqual({ hash: cursor, height: fundedHeader.height })

      // reconsiderblock brings B back: nothing removed since it.
      cli('reconsiderblock', blockB)
      expect(await wallet.listSinceBlock({ blockHash: blockB })).toEqual({
        transactions: [],
        removed: [],
        lastBlock: blockB,
      })

      // A competing branch instead: the payout is mined again, and removed
      // reports it as it is now, in its new block. Another coinbase address
      // keeps the first block from repeating B, which the node holds invalid.
      cli('invalidateblock', blockB)
      const [blockC, blockD] = mine(2, await peer.getNewAddress())
      const remined = await wallet.listSinceBlock({ blockHash: blockB })
      expect(remined.lastBlock).toBe(blockD)
      expect(remined.removed).toEqual([expect.objectContaining({ txid: payout, confirmations: 2, blockHash: blockC })])
      expect(remined.transactions).toEqual(remined.removed)

      // The reads in one batch.
      const [since, list, balances] = await wallet.batch([
        requests.listSinceBlock({ blockHash: cursor }),
        requests.listTransactions({ count: 1 }),
        requests.getBalances(),
      ])
      expect(since.ok && since.value.transactions.map(entry => entry.txid)).toEqual([payout])
      expect(list.ok && list.value).toEqual([expect.objectContaining({ txid: payout, blockHash: blockC })])
      expect(balances.ok && balances.value.lastProcessedBlock.hash).toBe(blockD)
    } finally {
      // Whatever happened, no block stays marked invalid: B is a shorter valid
      // fork again, or the tip.
      cli('reconsiderblock', blockB)
    }
    const tips = JSON.parse(cli('getchaintips')) as { hash: string; status: string }[]
    expect(tips.find(tip => tip.hash === blockB)?.status).toBe('valid-fork')
    expect(tips.filter(tip => tip.status === 'invalid')).toEqual([])
  })
})
