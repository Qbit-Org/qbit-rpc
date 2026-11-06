import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect as netConnect, type AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { createServer as createTlsServer } from 'node:tls'

import { describe, expect, it } from 'vitest'

import {
  formatQbt,
  JsonNumber,
  QbitRpcClient,
  requests,
  RpcCapabilityError,
  RpcChainGuardError,
  RpcError,
  RpcResponseTooLargeError,
  RpcTimeoutError,
  type Outpoint,
  type QbitRpcClientOptions,
} from '../../src'
import { QBIT_GENESIS_HASHES } from '../../src/capabilities'
import { HIDDEN_METHOD_CLASSES, METHOD_CLASSES } from '../../src/method-classes'
import { testPki } from '../helpers/certificates'
import type { CoreRpc } from '../helpers/core-rpc'

// Runs only under scripts/regtest-smoke.sh, which starts a throwaway regtest
// node on loopback and sets these variables.
const env = process.env
const enabled = env['RUN_QBIT_REGTEST_SMOKE'] === '1'
const url = env['QBIT_REGTEST_RPC_URL'] ?? ''
const cookieFile = env['QBIT_REGTEST_COOKIE_FILE'] ?? ''
const [cliPath = '', ...cliArgs] = (env['QBIT_REGTEST_CLI'] ?? '').split(' ')
/** qbit Core v1.0.0's regtest genesis block (src/kernel/chainparams.cpp). */
const REGTEST_GENESIS = '0ee96aa77c4b600850e349344fa21b107e805f5370ddc7a6189db12cf69acce6'
/** A case with a first unlock: past walletPassphrase's 120 s deadline, so a slow one fails as the client's error. */
const FIRST_UNLOCK_TEST_MS = 180_000

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
    expect(!missing.ok && RpcError.is(missing.error) && missing.error.rpcCode).toBe(-8)
  })

  it('confirms the chain by its genesis block, and refuses another expectedGenesisHash', async () => {
    const rpc = client()
    expect(await rpc.getBlockHash(0)).toBe(REGTEST_GENESIS)
    expect(QBIT_GENESIS_HASHES.regtest).toBe(REGTEST_GENESIS)
    const info = await rpc.confirmChain()
    expect(info.chain).toBe('regtest')
    expect(info.signetChallenge).toBeUndefined()
    expect(rpc.chainStatus).toBe('confirmed')
    // Through a wallet endpoint too: the batch reaches the node's chain methods there.
    const wallet = client({ wallet: 'smoke' })
    await wallet.confirmChain()
    expect(wallet.chainStatus).toBe('confirmed')

    const other = client({ expectedGenesisHash: 'ab'.repeat(32) })
    const error = await other.confirmChain().catch((e: unknown) => e)
    expect(RpcChainGuardError.is(error)).toBe(true)
    expect(error).toMatchObject({
      reason: 'mismatch',
      expectedChain: 'regtest',
      actualChain: 'regtest',
      differs: ['genesis_hash'],
      expectedGenesisHash: 'ab'.repeat(32),
      actualGenesisHash: REGTEST_GENESIS,
    })
    expect(other.chainStatus).toBe('mismatch')
  })

  it('reads the node’s qbit Core version with every chain check, and supports it', async () => {
    const rpc = client({ wallet: 'locked', capabilities: ['wallet-write'], chainCheckMaxAgeMs: 0 })
    expect(rpc.nodeVersion).toBeUndefined()
    await rpc.confirmChain()
    const { version, subversion } = await rpc.getNetworkInfo()
    expect(subversion).toMatch(/^\/qbit:1\.0\.[0-9]+\//)
    const parts = { major: Math.trunc(version / 10000), minor: Math.trunc(version / 100) % 100, patch: version % 100 }
    expect(subversion.startsWith(`/qbit:${parts.major}.${parts.minor}.${parts.patch}`)).toBe(true)
    expect(rpc.nodeVersion).toEqual({ version, subversion, ...parts, supported: true })
    expect(rpc.toJSON()).toMatchObject({ chainStatus: 'stale', nodeVersion: { version, supported: true } })
    // The re-check before a guarded call reads it again, and lets the call through.
    await rpc.walletLock()
    expect(rpc.nodeVersion).toEqual({ version, subversion, ...parts, supported: true })
  })

  // qbitd serves plain HTTP; a remote node sits behind a TLS terminator. This
  // one, on loopback, requires a client certificate and relays each TLS
  // connection to the node's RPC port, so the cookie goes over it as Basic
  // credentials.
  it('reaches the node through a TLS terminator with a private CA, a client certificate and a pin', async () => {
    const pki = testPki()
    const relayed: number[] = []
    const terminator = createTlsServer(
      { key: pki.server.key, cert: pki.server.cert, ca: pki.ca.cert, requestCert: true, rejectUnauthorized: true },
      socket => {
        relayed.push(socket.remotePort ?? 0)
        const upstream = netConnect(Number(new URL(url).port), '127.0.0.1')
        socket.pipe(upstream).pipe(socket)
        socket.on('error', () => upstream.destroy())
        upstream.on('error', () => socket.destroy())
      }
    )
    await new Promise<void>(resolve => terminator.listen(0, '127.0.0.1', resolve))
    try {
      const port = (terminator.address() as AddressInfo).port
      const [username = '', password = ''] = readFileSync(cookieFile, 'utf8').trim().split(':')
      const tls = { ca: pki.ca.cert, cert: pki.client.cert, key: pki.client.key, pinSha256: pki.server.pin }
      const remote = (options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient =>
        new QbitRpcClient({
          url: `https://127.0.0.1:${port}/`,
          wallet: 'locked',
          auth: { username, password },
          expectedChain: 'regtest',
          capabilities: ['wallet-write'],
          tls,
          ...options,
        })
      const rpc = remote()
      await rpc.confirmChain()
      expect(await rpc.getBlockCount()).toBeGreaterThanOrEqual(101)
      // A side-effecting call gets a connection of its own, pinned like the pooled one.
      await rpc.walletLock()
      expect(relayed).toHaveLength(2)
      expect(rpc.toJSON()).toMatchObject({ chainStatus: 'confirmed', tls: { ca: 'custom', clientCertificate: true } })

      // Through a connect function, as through a proxy: the name is the certificate's, the tunnel loopback.
      const tunnelled = remote({
        url: `https://node.test:${port}/`,
        connect: ({ port: target }) => netConnect(target, '127.0.0.1'),
      })
      await tunnelled.confirmChain()
      await tunnelled.walletLock()
      expect(relayed).toHaveLength(4)

      const otherPin = testPki('other').server.pin
      await expect(remote({ tls: { ...tls, pinSha256: otherPin } }).confirmChain()).rejects.toMatchObject({
        name: 'RpcTransportError',
        reason: 'tls',
        code: 'EPINMISMATCH',
      })
      await expect(remote({ tls: { ca: pki.ca.cert } }).confirmChain()).rejects.toMatchObject({
        name: 'RpcTransportError',
        reason: 'tls',
        code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
      })
    } finally {
      await new Promise<void>(resolve => terminator.close(() => resolve()))
    }
  })

  it('resolves localhost to loopback and reaches the node by that name, with the cookie', async () => {
    const rpc = client({ url: url.replace('127.0.0.1', 'localhost') })
    expect(new URL(url).hostname).toBe('127.0.0.1')
    await rpc.confirmChain()
    expect(rpc.chainStatus).toBe('confirmed')
  })

  it('opens a method the package does not allowlist through extraMethods', async () => {
    const policy = { capability: 'read', sideEffects: false } as const
    const closed = await client()
      .call('getchaintxstats', [10])
      .catch((e: unknown) => e)
    expect(RpcCapabilityError.is(closed) && closed.reason).toBe('unknown_method')
    const rpc = client({ extraMethods: { getchaintxstats: policy } })
    expect(rpc.toJSON()).toMatchObject({ capabilities: [], extraMethods: { getchaintxstats: policy } })
    type Stats = {
      txcount: JsonNumber
      window_block_count: JsonNumber
      window_final_block_height: JsonNumber
      window_final_block_hash: string
    }
    const stats = (await rpc.call('getchaintxstats', [10])) as Stats
    const height = stats.window_final_block_height.toSafeInteger()
    expect(height).toBeGreaterThanOrEqual(101)
    expect(stats.window_block_count.toSafeInteger()).toBe(10)
    expect(stats.window_final_block_hash).toBe(await rpc.getBlockHash(height))
    // At least one coinbase per block after the genesis block.
    expect(stats.txcount.toSafeInteger()).toBeGreaterThan(height)
    // A read: it goes in a batch, and the node's refusal is that entry's RpcError.
    const [batched, tooLong] = await rpc.batch([
      requests.raw('getchaintxstats', [10]),
      requests.raw('getchaintxstats', [1_000_000]),
    ])
    expect(batched.ok && (batched.value as Stats).window_block_count.toSafeInteger()).toBe(10)
    expect(!tooLong.ok && RpcError.is(tooLong.error) && tooLong.error.rpcCode).toBe(-8)
  })

  it('administers the node through extraMethods under node-admin only, behind the chain guard', async () => {
    const broadcast = { capability: 'broadcast', sideEffects: true } as const
    expect(() => client({ capabilities: ['broadcast'], extraMethods: { ping: broadcast } })).toThrow(
      "extraMethods.ping: qbit Core v1.0.0's ping changes what the node stores, follows or connects to, or stops it, so it needs { capability: 'node-admin', sideEffects: true }"
    )
    const admin: Partial<QbitRpcClientOptions> = {
      capabilities: ['node-admin'],
      extraMethods: { ping: { capability: 'node-admin', sideEffects: true } },
    }
    const rpc = client(admin)
    // Refused until confirmChain(), as wallet-write and broadcast calls are.
    await expect(rpc.call('ping')).rejects.toMatchObject({ name: 'RpcChainGuardError', reason: 'unconfirmed' })
    await rpc.confirmChain()
    expect(await rpc.call('ping')).toBeNull()
    // A client that expects another chain never sends it here.
    const elsewhere = client({ ...admin, expectedChain: 'main' })
    await expect(elsewhere.confirmChain()).rejects.toMatchObject({ reason: 'mismatch' })
    await expect(elsewhere.call('ping')).rejects.toMatchObject({ reason: 'mismatch', method: 'ping' })
  })

  it("classifies exactly the methods the node's help lists", async () => {
    // help is in the table, as a read: extraMethods opens it as one.
    const rpc = client({ extraMethods: { help: { capability: 'read', sideEffects: false } } })
    const help = (await rpc.call('help')) as string
    // One line per method under each "== Category ==" heading: its name, then its arguments.
    const listed = help
      .split('\n')
      .filter(line => /^[a-z]/.test(line))
      .map(line => line.split(' ')[0]!)
      .sort()
    expect(listed).toHaveLength(161)
    expect(Object.keys(METHOD_CLASSES).sort()).toEqual(listed)
    // Each hidden method in the other table is one this node has: help describes it by name.
    for (const name of Object.keys(HIDDEN_METHOD_CLASSES)) {
      expect(listed, name).not.toContain(name)
      expect(((await rpc.call('help', [name])) as string).split(/\s/)[0], name).toBe(name)
    }
    // Each category heading is one the table's comments use.
    expect(help.split('\n').filter(line => line.startsWith('=='))).toEqual([
      '== Blockchain ==',
      '== Control ==',
      '== Mining ==',
      '== Network ==',
      '== Rawtransactions ==',
      '== Signer ==',
      '== Util ==',
      '== Wallet ==',
      '== Zmq ==',
    ])
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
      RpcError.is(error) && (code === undefined || error.rpcCode === code)
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
    // A type qbit Core parses, which a P2MR-only chain refuses.
    await expect(wallet.walletCreateFundedPsbt({ ...small, options: { changeType: 'bech32' } })).rejects.toSatisfy(
      nodeError(-5)
    )
    expect(
      (await decode((await wallet.walletCreateFundedPsbt({ ...small, options: { changeType: 'p2mr' } })).psbt)).vout
    ).toHaveLength(2)

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

  // The script creates `locked` and never unlocks it, so this is its first
  // unlock too, with the default deadline (see the next case).
  it('locks and unlocks an encrypted wallet', { timeout: FIRST_UNLOCK_TEST_MS }, async () => {
    const locked = client({ wallet: 'locked', capabilities: ['wallet-read', 'wallet-write'] })
    await locked.confirmChain()
    expect((await locked.getWalletInfo()).unlockedUntil).toBe(0)
    await expect(locked.walletPassphrase('wrong', 30)).rejects.toSatisfy(
      error => RpcError.is(error) && error.rpcCode === -14
    )
    await locked.walletPassphrase('smoke-passphrase', 30)
    expect((await locked.getWalletInfo()).unlockedUntil).toBeGreaterThan(0)
    await locked.walletLock()
    expect((await locked.getWalletInfo()).unlockedUntil).toBe(0)
  })

  // qbit Core v1.0.0 creates a wallet with a passphrase with 16 keys per
  // descriptor and derives the rest of its keypool inside its first unlock:
  // 25 to 31 s on a shared host, 49 s on a GitHub-hosted runner, past the
  // client's 30 s. walletPassphrase's own default deadline, 120 s, covers it.
  it(
    'unlocks a newly created encrypted wallet the first time, within the default deadline',
    { timeout: FIRST_UNLOCK_TEST_MS },
    async () => {
      cli('-named', 'createwallet', 'wallet_name=first-unlock', 'descriptors=true', 'passphrase=first-passphrase')
      const wallet = client({ wallet: 'first-unlock', capabilities: ['wallet-read', 'wallet-write'] })
      await wallet.confirmChain()
      expect(await wallet.getWalletInfo()).toMatchObject({ unlockedUntil: 0, keypoolSize: 16 })
      await wallet.walletPassphrase('first-passphrase', 60)
      // The deferred top-up ran inside that call.
      const unlocked = await wallet.getWalletInfo()
      expect(unlocked.unlockedUntil).toBeGreaterThan(0)
      expect(unlocked.keypoolSize).toBe(1000)
      await wallet.walletLock()
      expect((await wallet.getWalletInfo()).unlockedUntil).toBe(0)
    }
  )

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
    const nodeError = (code: number) => (error: unknown) => RpcError.is(error) && error.rpcCode === code
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
    await expect(wallet.getRawChangeAddress({ addressType: 'bech32' })).rejects.toSatisfy(nodeError(-5))
    await expect(wallet.call('getrawchangeaddress', ['bogus'])).rejects.toSatisfy(nodeError(-5))
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

    // lockunspent (lockUnspent and unlockUnspent) and listlockunspent.
    await wallet.call('lockunspent', [true])
    expect(await core.listLockUnspent()).toEqual([])
    expect(await core.lockUnspent([outpoint])).toBeUndefined()
    expect(await core.listLockUnspent()).toEqual([outpoint])
    expect((await wallet.listUnspent()).some(u => u.txid === coin!.txid && u.vout === coin!.vout)).toBe(false)
    await expect(wallet.lockUnspent([outpoint])).rejects.toSatisfy(nodeError(-8))
    // One bad output and the node changes nothing.
    await expect(wallet.lockUnspent([other, { txid: '00'.repeat(32), vout: 0 }])).rejects.toSatisfy(nodeError(-8))
    await expect(wallet.lockUnspent([{ txid: coin!.txid, vout: 999 }])).rejects.toSatisfy(nodeError(-8))
    await expect(wallet.unlockUnspent([outpoint, other])).rejects.toSatisfy(nodeError(-8))
    expect(await wallet.listLockUnspent()).toEqual([outpoint])
    expect(await wallet.lockUnspent([other], { persistent: true })).toBeUndefined()
    expect(sorted(await wallet.listLockUnspent())).toEqual(sorted([outpoint, other]))
    // persistent locks an output locked in memory only again, where locking it again in memory is refused.
    expect(await wallet.lockUnspent([outpoint], { persistent: true })).toBeUndefined()
    // An empty list: qbit Core unlocks nothing (and the client refuses it), leaving it out unlocks everything.
    expect(await wallet.call('lockunspent', [true, []])).toBe(true)
    expect(sorted(await wallet.listLockUnspent())).toEqual(sorted([outpoint, other]))
    await expect(wallet.unlockUnspent([])).rejects.toThrow(RangeError)
    // One unlock clears persistent and in-memory locks alike.
    expect(await core.unlockUnspent([outpoint, other])).toBeUndefined()
    expect(await wallet.listLockUnspent()).toEqual([])
    await expect(wallet.unlockUnspent([outpoint])).rejects.toSatisfy(nodeError(-8))

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
    expect(!gone.ok && RpcError.is(gone.error) && gone.error.rpcCode).toBe(-5)
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
    const nodeError = (code: number) => (error: unknown) => RpcError.is(error) && error.rpcCode === code
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
    await expect(wallet.getNewAddress({ addressType: 'bech32m' })).rejects.toSatisfy(nodeError(-5))
    await expect(wallet.call('getnewaddress', ['', 'bogus'])).rejects.toSatisfy(nodeError(-5))
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

  // psbtbumpfee on wallets this case creates, funded from the script's smoke
  // wallet: a stuck payment bumped and replaced through the typed methods, the
  // option names the node reads, what each path leaves in the wallet, and a
  // bump that loses the race with the original's confirmation. It mines what
  // it leaves in the mempool.
  it('bumps a stuck payment with psbtBumpFee and broadcasts the replacement', async () => {
    cli('-named', 'createwallet', 'wallet_name=bump', 'descriptors=true')
    cli('-named', 'createwallet', 'wallet_name=bump-peer', 'descriptors=true')
    const wallet = client({ wallet: 'bump', capabilities: ['wallet-read', 'wallet-write', 'broadcast'] })
    const peer = client({ wallet: 'bump-peer', capabilities: ['wallet-write'] })
    await expect(wallet.psbtBumpFee('00'.repeat(32))).rejects.toSatisfy(RpcChainGuardError.is)
    await expect(
      client({ wallet: 'bump', capabilities: ['wallet-read'] }).psbtBumpFee('00'.repeat(32))
    ).rejects.toSatisfy(RpcCapabilityError.is)
    await wallet.confirmChain()
    await peer.confirmChain()
    const nodeError = (code: number, message?: RegExp) => (error: unknown) =>
      RpcError.is(error) && error.rpcCode === code && (message === undefined || message.test(error.message))
    const payee = (): Promise<string> => peer.getNewAddress({ addressType: 'p2mr' })
    const mine = async (): Promise<void> => {
      cli('generatetoaddress', '1', await payee())
    }
    type DecodedPsbt = {
      tx: {
        txid: string
        vin: { txid: string; vout: JsonNumber; sequence: JsonNumber }[]
        vout: { value: JsonNumber; scriptPubKey: { address?: string } }[]
      }
      fee: JsonNumber
    }
    const decode = async (psbt: string): Promise<DecodedPsbt> =>
      (await wallet.call('decodepsbt', [psbt])) as DecodedPsbt
    const spends = ({ tx }: DecodedPsbt): string[] =>
      tx.vin.map(input => `${input.txid}:${input.vout.toSafeInteger()}`).sort()
    const amountTo = ({ tx }: DecodedPsbt, address: string): bigint =>
      tx.vout.find(output => output.scriptPubKey.address === address)!.value.toBits()

    // Six confirmed coins of 10 QBT.
    const funder = client({ wallet: 'smoke', capabilities: ['wallet-write', 'broadcast'] })
    await funder.confirmChain()
    const coins: { address: string; amountBits: bigint }[] = []
    for (let i = 0; i < 6; i++) {
      coins.push({ address: await wallet.getNewAddress({ addressType: 'p2mr' }), amountBits: 1_000_000_000n })
    }
    const funding = await funder.walletCreateFundedPsbt({ outputs: coins })
    await funder.sendRawTransaction((await funder.walletProcessPsbt(funding.psbt)).hex!)
    await mine()

    // Everything a bump could change: keys, coins, locks, balances, history
    // and the original. The public descriptor listing leaves P2MR out.
    const state = async (txid: string) => ({
      info: await wallet.getWalletInfo(),
      balances: await wallet.getBalances(),
      locks: await wallet.listLockUnspent(),
      unspent: await wallet.listUnspent({ minConf: 0 }),
      history: await wallet.listTransactions({ count: 1000 }),
      original: await wallet.getTransaction(txid),
      changeIndex: (
        JSON.parse(cli('-rpcwallet=bump', 'listdescriptors', 'true')) as {
          descriptors: { internal: boolean; next_index: number }[]
        }
      ).descriptors
        .filter(descriptor => descriptor.internal)
        .reduce((sum, descriptor) => sum + descriptor.next_index, 0),
    })
    type State = Awaited<ReturnType<typeof state>>
    /** Change keys taken between two states, by the descriptor's next index and the change keypool. */
    const taken = (a: State, b: State) => ({
      nextIndex: b.changeIndex - a.changeIndex,
      keypool: a.info.keypoolSizeHdInternal! - b.info.keypoolSizeHdInternal!,
    })
    const rest = (s: State) => ({ ...s, info: { ...s.info, keypoolSizeHdInternal: 0 }, changeIndex: 0 })

    // A payment with change, replaceable, stuck at 1 bit/vB.
    const recipient = await payee()
    const built = await wallet.walletCreateFundedPsbt({
      outputs: [{ address: recipient, amountBits: 100_000_000n }],
      options: { feeRateBitsPerKvB: 1000n, replaceable: true, changeType: 'p2mr' },
    })
    expect(built.changePos).toBeGreaterThanOrEqual(0)
    const originalHex = (await wallet.walletProcessPsbt(built.psbt)).hex!
    const original = await wallet.sendRawTransaction(originalHex)
    const originalTx = await decode(built.psbt)
    const changeAddress = originalTx.tx.vout[built.changePos]!.scriptPubKey.address!

    // With change: the bump spends the same inputs, pays the recipient the
    // same, and takes nothing from the wallet, however often it is called.
    const before = await state(original)
    const bumped = await wallet.psbtBumpFee(original, { feeRateBitsPerKvB: 4000n })
    expect(bumped.originalFeeBits).toBe(built.feeBits)
    expect(bumped.feeBits).toBeGreaterThan(bumped.originalFeeBits)
    expect(bumped.errors).toEqual([])
    const bumpTx = await decode(bumped.psbt)
    expect(bumpTx.fee.toBits()).toBe(bumped.feeBits)
    expect(spends(bumpTx)).toEqual(spends(originalTx))
    expect(amountTo(bumpTx, recipient)).toBe(100_000_000n)
    await wallet.psbtBumpFee(original, { feeRateBitsPerKvB: 4000n })
    await wallet.psbtBumpFee(original)
    await wallet.psbtBumpFee(original, { originalChangeIndex: built.changePos, feeRateBitsPerKvB: 3000n })
    await wallet.psbtBumpFee(original, {
      outputs: [
        { address: recipient, amountBits: 100_000_000n },
        { address: changeAddress, amountBits: 500_000_000n },
      ],
      feeRateBitsPerKvB: 3000n,
    })
    await expect(wallet.psbtBumpFee(original, { feeRateBitsPerKvB: 1100n })).rejects.toSatisfy(
      nodeError(-8, /Insufficient total fee/)
    )
    await expect(wallet.psbtBumpFee('ab'.repeat(32))).rejects.toSatisfy(nodeError(-5))
    expect(await state(original)).toEqual(before)

    // Every option name the client sends changes what the node does.
    expect((await wallet.psbtBumpFee(original, { feeRateBitsPerKvB: 8000n })).feeBits).toBeGreaterThan(bumped.feeBits)
    expect((await wallet.psbtBumpFee(original, { confTarget: 2, estimateMode: 'economical' })).feeBits).toBeGreaterThan(
      bumped.originalFeeBits
    )
    for (const key of ['conf_target', 'estimate_mode']) {
      const options = { fee_rate: 4, [key]: key === 'conf_target' ? 2 : 'economical' }
      await expect(wallet.call('psbtbumpfee', [original, options])).rejects.toSatisfy(
        nodeError(-8, new RegExp(`Cannot specify both ${key}`))
      )
    }
    for (const replaceable of [true, false]) {
      const { tx } = await decode((await wallet.psbtBumpFee(original, { feeRateBitsPerKvB: 4000n, replaceable })).psbt)
      expect(tx.vin.every(input => input.sequence.toSafeInteger() === (replaceable ? 0xfffffffd : 0xfffffffe))).toBe(
        true
      )
    }
    // original_change_index pointed at the payment: the payment pays the extra fee.
    const fromPayment = await wallet.psbtBumpFee(original, {
      originalChangeIndex: 1 - built.changePos,
      feeRateBitsPerKvB: 4000n,
    })
    expect(amountTo(await decode(fromPayment.psbt), recipient)).toBe(
      100_000_000n - (fromPayment.feeBits - fromPayment.originalFeeBits)
    )
    // outputs replace the original's; with its change address among them, that output takes the rest.
    const otherPayee = await payee()
    const redirected = await decode(
      (
        await wallet.psbtBumpFee(original, {
          outputs: [
            { address: otherPayee, amountBits: 100_000_000n },
            { address: changeAddress, amountBits: 100_000_000n },
          ],
        })
      ).psbt
    )
    expect(amountTo(redirected, otherPayee)).toBe(100_000_000n)
    expect(redirected.tx.vout.some(output => output.scriptPubKey.address === recipient)).toBe(false)
    // The node refuses the exclusive pair, and any key it does not read: none is accepted and then ignored.
    await expect(
      wallet.call('psbtbumpfee', [original, { outputs: [{ [recipient]: 1 }], original_change_index: 0 }])
    ).rejects.toSatisfy(nodeError(-8))
    for (const key of [
      'subtract_fee_from_outputs',
      'feeRate',
      'estimateMode',
      'originalChangeIndex',
      'change_address',
    ]) {
      await expect(wallet.call('psbtbumpfee', [original, { [key]: 0 }])).rejects.toSatisfy(
        nodeError(-3, new RegExp(`Unexpected key ${key}`))
      )
    }
    await expect(wallet.psbtBumpFee(original, { fee_rate: 4 } as never)).rejects.toThrow(
      /use options\.feeRateBitsPerKvB/
    )
    expect(await state(original)).toEqual(before)

    // Outputs without the original's change address: the rest goes to a new
    // change key, taken for good.
    await wallet.psbtBumpFee(original, {
      outputs: [{ address: recipient, amountBits: 100_000_000n }],
      feeRateBitsPerKvB: 4000n,
    })
    const afterOutputs = await state(original)
    expect(taken(before, afterOutputs)).toEqual({ nextIndex: 1, keypool: 1 })
    expect(rest(afterOutputs)).toEqual(rest(before))

    // Sign, store the hex, broadcast: the replacement takes the original's place.
    const signed = await wallet.walletProcessPsbt(bumped.psbt)
    expect(signed.complete).toBe(true)
    const [accepted] = await wallet.testMempoolAccept([signed.hex!])
    expect(accepted).toMatchObject({ allowed: true, fees: { baseBits: bumped.feeBits } })
    const replacement = await wallet.sendRawTransaction(signed.hex!)
    expect(replacement).toBe(accepted!.txid)
    await expect(wallet.getMempoolEntry(original)).rejects.toSatisfy(nodeError(-5))
    expect((await wallet.getMempoolEntry(replacement)).fees.baseBits).toBe(bumped.feeBits)
    // Only bumpfee names the replacement; the wallet sees it as a conflict.
    const replaced = await wallet.getTransaction(original)
    expect(replaced).toMatchObject({
      feeBits: -bumped.originalFeeBits,
      confirmations: 0,
      trusted: false,
      walletConflicts: [replacement],
      mempoolConflicts: [replacement],
    })
    expect(replaced).not.toHaveProperty('replacedByTxid')
    const replacing = await wallet.getTransaction(replacement)
    expect(replacing).toMatchObject({
      feeBits: -bumped.feeBits,
      amountBits: -100_000_000n,
      confirmations: 0,
      trusted: true,
      walletConflicts: [original],
      mempoolConflicts: [],
    })
    expect(replacing).not.toHaveProperty('replacesTxid')
    // Sending the stored hex again is harmless; the original is refused.
    expect(await wallet.sendRawTransaction(signed.hex!)).toBe(replacement)
    await expect(wallet.sendRawTransaction(originalHex)).rejects.toSatisfy(nodeError(-26))
    // Mined: the original is conflicted and can no longer be bumped or sent.
    await mine()
    expect((await wallet.getTransaction(original)).confirmations).toBe(-1)
    expect((await wallet.getTransaction(replacement)).confirmations).toBe(1)
    await expect(wallet.psbtBumpFee(original)).rejects.toSatisfy(nodeError(-1, /is already spent/))
    await expect(wallet.sendRawTransaction(originalHex)).rejects.toSatisfy(nodeError(-25))

    // A bump signed while the original was stuck, then the original confirms first.
    const racedBuilt = await wallet.walletCreateFundedPsbt({
      outputs: [{ address: await payee(), amountBits: 100_000_000n }],
      options: { feeRateBitsPerKvB: 1000n, replaceable: true },
    })
    const raced = await wallet.sendRawTransaction((await wallet.walletProcessPsbt(racedBuilt.psbt)).hex!)
    const late = await wallet.walletProcessPsbt((await wallet.psbtBumpFee(raced, { feeRateBitsPerKvB: 4000n })).psbt)
    await mine()
    expect((await wallet.getTransaction(raced)).confirmations).toBe(1)
    await expect(wallet.psbtBumpFee(raced)).rejects.toSatisfy(nodeError(-1, /is already spent/))
    expect((await wallet.testMempoolAccept([late.hex!]))[0]).toMatchObject({
      allowed: false,
      rejectReason: 'missing-inputs',
    })
    await expect(wallet.sendRawTransaction(late.hex!)).rejects.toSatisfy(nodeError(-25))

    // No change: the wallet adds an input and a change output, and each call
    // takes a change key for good, for a different transaction. A failed call
    // takes none.
    const [coin] = (await wallet.listUnspent()).filter(unspent => unspent.amountBits === 1_000_000_000n)
    const whole = await wallet.walletCreateFundedPsbt({
      inputs: [coin!],
      outputs: [{ address: await payee(), amountBits: coin!.amountBits }],
      options: { addInputs: false, subtractFeeFromOutputs: [0], feeRateBitsPerKvB: 1000n, replaceable: true },
    })
    expect(whole.changePos).toBe(-1)
    const wholeTxid = await wallet.sendRawTransaction((await wallet.walletProcessPsbt(whole.psbt)).hex!)
    const s0 = await state(wholeTxid)
    const first = await decode((await wallet.psbtBumpFee(wholeTxid, { feeRateBitsPerKvB: 4000n })).psbt)
    const s1 = await state(wholeTxid)
    expect(taken(s0, s1)).toEqual({ nextIndex: 1, keypool: 1 })
    expect(rest(s1)).toEqual(rest(s0))
    expect([first.tx.vin.length, first.tx.vout.length]).toEqual([2, 2])
    const second = await decode((await wallet.psbtBumpFee(wholeTxid, { feeRateBitsPerKvB: 4000n })).psbt)
    const s2 = await state(wholeTxid)
    expect(taken(s1, s2)).toEqual({ nextIndex: 1, keypool: 1 })
    expect(second.tx.txid).not.toBe(first.tx.txid)
    await expect(
      wallet.psbtBumpFee(wholeTxid, {
        outputs: [{ address: recipient, amountBits: 100_000_000_000n }],
        feeRateBitsPerKvB: 4000n,
      })
    ).rejects.toSatisfy(nodeError(-4, /Insufficient funds/))
    expect(await state(wholeTxid)).toEqual(s2)

    // A non-replaceable original: the node bumps it, and its mempool takes the replacement.
    const pinned = await wallet.walletCreateFundedPsbt({
      outputs: [{ address: await payee(), amountBits: 100_000_000n }],
      options: { feeRateBitsPerKvB: 1000n, replaceable: false },
    })
    const pinnedTxid = await wallet.sendRawTransaction((await wallet.walletProcessPsbt(pinned.psbt)).hex!)
    expect((await wallet.getTransaction(pinnedTxid)).bip125Replaceable).toBe('no')
    const pinnedBump = await wallet.walletProcessPsbt(
      (await wallet.psbtBumpFee(pinnedTxid, { feeRateBitsPerKvB: 4000n })).psbt
    )
    expect((await wallet.testMempoolAccept([pinnedBump.hex!]))[0]).toMatchObject({ allowed: true })

    await mine()
    expect(await wallet.call('getrawmempool')).toEqual([])
  })

  // Each range below is the one qbit Core v1.0.0 accepts: its largest value
  // reaches the node, and the next is refused before anything is sent, where
  // call() shows the node refusing it too.
  it('takes each argument up to the bound qbit Core takes, and refuses a fee-rate cap of 0n', async () => {
    const wallet = client({ wallet: 'smoke', capabilities: ['wallet-read', 'wallet-write', 'broadcast'] })
    await wallet.confirmChain()
    const nodeError =
      (code: number, message?: RegExp) =>
      (error: unknown): boolean =>
        RpcError.is(error) && error.rpcCode === code && (message === undefined || message.test(error.message))
    const [coin] = await wallet.listUnspent()
    const to = await wallet.getNewAddress({ addressType: 'p2mr' })
    const outputs = [{ address: to, amountBits: 10_000_000n }]
    const fee = { feeRateBitsPerKvB: 2000n }
    const sent = { [to]: 0.1 }

    // gettxout reads vout as an unsigned 32-bit integer.
    expect(await wallet.getTxOut(coin!.txid, 0x8000_0000)).toBeNull()
    expect(await wallet.getTxOut(coin!.txid, 0xffff_ffff)).toBeNull()
    await expect(wallet.getTxOut(coin!.txid, 0x1_0000_0000)).rejects.toThrow(RangeError)
    await expect(wallet.call('gettxout', [coin!.txid, 0x1_0000_0000])).rejects.toSatisfy(nodeError(-1, /out of range/))

    // walletcreatefundedpsbt's inputs and lockunspent read it as a signed one.
    const far = { txid: coin!.txid, vout: 0x7fff_ffff }
    const beyond = { txid: coin!.txid, vout: 0x8000_0000 }
    await expect(wallet.walletCreateFundedPsbt({ inputs: [far], outputs, options: fee })).rejects.toSatisfy(
      nodeError(-4, /Unable to find UTXO/)
    )
    await expect(wallet.walletCreateFundedPsbt({ inputs: [beyond], outputs, options: fee })).rejects.toThrow(RangeError)
    await expect(wallet.call('walletcreatefundedpsbt', [[beyond], [sent]])).rejects.toSatisfy(
      nodeError(-1, /out of range/)
    )
    await expect(wallet.lockUnspent([far])).rejects.toSatisfy(nodeError(-8, /vout index out of bounds/))
    await expect(wallet.lockUnspent([beyond])).rejects.toThrow(RangeError)
    await expect(wallet.unlockUnspent([beyond])).rejects.toThrow(RangeError)
    await expect(wallet.call('lockunspent', [false, [beyond]])).rejects.toSatisfy(nodeError(-1, /out of range/))

    // version: TX_MIN_STANDARD_VERSION to TX_MAX_STANDARD_VERSION.
    for (const version of [1, 3]) {
      const funded = await wallet.walletCreateFundedPsbt({ outputs, version, options: fee })
      const tx = ((await wallet.call('decodepsbt', [funded.psbt])) as { tx: { version: JsonNumber } }).tx
      expect(tx.version.toSafeInteger()).toBe(version)
    }
    await expect(wallet.walletCreateFundedPsbt({ outputs, version: 4, options: fee })).rejects.toThrow(RangeError)
    await expect(wallet.call('walletcreatefundedpsbt', [[], [sent], 0, { fee_rate: 2 }, false, 4])).rejects.toSatisfy(
      nodeError(-8, /version out of range\(1~3\)/)
    )

    // max_tx_weight: 65 to 400,000. At 65 the range check passes and coin selection fails.
    expect(
      (await wallet.walletCreateFundedPsbt({ outputs, options: { ...fee, maxTxWeight: 400_000 } })).psbt
    ).toBeTruthy()
    const lightest = await wallet
      .walletCreateFundedPsbt({ outputs, options: { ...fee, maxTxWeight: 65 } })
      .catch(e => e)
    expect(nodeError(-4)(lightest) && !/must be between/.test((lightest as Error).message)).toBe(true)
    for (const weight of [64, 400_001]) {
      await expect(
        wallet.walletCreateFundedPsbt({ outputs, options: { ...fee, maxTxWeight: weight } })
      ).rejects.toThrow(RangeError)
      await expect(
        wallet.call('walletcreatefundedpsbt', [[], [sent], 0, { fee_rate: 2, max_tx_weight: weight }])
      ).rejects.toSatisfy(nodeError(-4, /must be between 65 and 400000/))
    }

    // maxfeerate: 1 bit/kvB is a cap, and 0 none at all; left out, the node's default of 0.10 QBT/kvB applies.
    const funded = await wallet.walletCreateFundedPsbt({ outputs, options: fee })
    const hex = (await wallet.walletProcessPsbt(funded.psbt)).hex!
    expect(await wallet.testMempoolAccept([hex], { maxFeeRateBitsPerKvB: 1n })).toMatchObject([
      { allowed: false, rejectReason: 'max-fee-exceeded' },
    ])
    expect(await wallet.testMempoolAccept([hex], { maxFeeRateBitsPerKvB: 99_999_999n })).toMatchObject([
      { allowed: true },
    ])
    expect(await wallet.testMempoolAccept([hex])).toMatchObject([{ allowed: true }])
    expect(cli('help', 'testmempoolaccept')).toMatch(/maxfeerate +\(numeric or string, optional, default="0\.10"\)/)
    expect(cli('help', 'sendrawtransaction')).toMatch(/maxfeerate +\(numeric or string, optional, default="0\.10"\)/)
    await expect(wallet.testMempoolAccept([hex], { maxFeeRateBitsPerKvB: 0n })).rejects.toThrow(RangeError)
    await expect(wallet.sendRawTransaction(hex, { maxFeeRateBitsPerKvB: 0n })).rejects.toThrow(RangeError)
    expect(await wallet.call('testmempoolaccept', [[hex], 0])).toMatchObject([{ allowed: true }])
    await expect(wallet.testMempoolAccept([hex], { maxFeeRateBitsPerKvB: 100_000_000n })).rejects.toThrow(RangeError)
    await expect(wallet.call('testmempoolaccept', [[hex], 1])).rejects.toSatisfy(nodeError(-8))
    expect(await wallet.call('getrawmempool')).toEqual([])
  })

  // rawTransactionTxid names a broadcast in an RpcUnknownOutcomeError: it must
  // be the txid the node gives the same bytes. Generated witness and
  // non-witness transactions, from a fixed seed. Imported here, so the case
  // stands alone.
  it('computes the txid decoderawtransaction reports, for witness and non-witness transactions', async () => {
    const { default: fc } = await import('fast-check')
    const { rawTransactionTxid } = await import('../../src/raw-tx')
    const { serialize, transaction, txidOf } = await import('../helpers/raw-tx')
    const txs = fc.sample(transaction, { seed: 13, numRuns: 400 })
    expect(txs.some(tx => tx.witness !== undefined) && txs.some(tx => tx.witness === undefined)).toBe(true)
    const hexes = txs.map(tx => serialize(tx).toString('hex'))
    const rpc = client()
    await rpc.confirmChain()
    const decoded = await rpc.batch(
      hexes.map((hex, i) => requests.raw('decoderawtransaction', [hex, txs[i]!.witness !== undefined]))
    )
    decoded.forEach((item, i) => {
      expect(item.ok, hexes[i]).toBe(true)
      const { txid } = (item as { value: { txid: string } }).value
      expect(rawTransactionTxid(hexes[i]!), hexes[i]).toBe(txid)
      expect(txidOf(txs[i]!)).toBe(txid)
    })
  })

  // qbit Core v1.0.0 has no option to lower a PQC key's 2^30 signature limit,
  // so this case raises keys' counts instead. A count is kept in the key's
  // walletdescriptorpqckey record (src/wallet/walletdb.cpp), after the secret
  // and a double SHA-256 of the pubkey, the secret and the count (LE32). With
  // the wallet unloaded, it writes each key a count just below a threshold,
  // loads the wallet once, and signs a spend of each key's coins.
  it('reports each PQC signature-budget state, and leaves an exhausted key unsigned without an error', async () => {
    const LIMIT = 2 ** 30
    const WARNING_FROM = 2 ** 28
    const CRITICAL_FROM = LIMIT - 2 ** 24
    type State = 'normal' | 'warning' | 'critical' | 'exhausted'
    const stateOf = (count: number): State =>
      count >= LIMIT ? 'exhausted' : count >= CRITICAL_FROM ? 'critical' : count >= WARNING_FROM ? 'warning' : 'normal'

    // The record layout written below is qbit Core v1.0.0's. On any other version this fails, on
    // purpose, until the rewrite is checked against that version's src/wallet/walletdb.cpp.
    const { version, subversion } = await client().getNetworkInfo()
    expect(
      { version, subversion },
      'the PQC record rewrite is written for qbit Core v1.0.0 only: check it against the new version'
    ).toEqual({ version: 10000, subversion: '/qbit:1.0.0/' })

    const name = 'pqc-budget'
    cli('-named', 'createwallet', `wallet_name=${name}`)
    const wallet = client({ wallet: name, capabilities: ['wallet-read', 'wallet-write'] })
    await wallet.confirmChain()
    // One key per address: each is written the count before a step.
    const written = {
      warning: WARNING_FROM - 1,
      warningReminder: WARNING_FROM + 2 ** 24 - 1,
      critical: CRITICAL_FROM - 1,
      criticalReminder: CRITICAL_FROM + 2 ** 20 - 1,
      last: LIMIT - 1,
    }
    type Key = keyof typeof written | 'normal'
    const keys = {} as Record<Key, { address: string; pubkey: string; coins: Outpoint[] }>
    for (const key of [...Object.keys(written), 'normal'] as Key[]) {
      const address = await wallet.getNewAddress({ addressType: 'p2mr' })
      const pubkey = (await wallet.getAddressInfo(address)).pqcKeyStates![0]!.pubkey
      keys[key] = { address, pubkey, coins: [] }
    }
    const amounts = Object.fromEntries(Object.values(keys).map(({ address }) => [address, 1]))
    cli('-rpcwallet=smoke', 'sendmany', '', JSON.stringify(amounts))
    cli('-rpcwallet=smoke', 'sendtoaddress', keys.last.address, '1')
    const destination = cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr')
    cli('generatetoaddress', '1', destination)
    for (const { address, txid, vout } of await wallet.listUnspent()) {
      Object.values(keys)
        .find(key => key.address === address)
        ?.coins.push({ txid, vout })
    }
    expect(keys.last.coins).toHaveLength(2)

    // A Bitcoin CompactSize at the start of `bytes`: its value, and how many bytes it takes.
    const compactSize = (bytes: Buffer): [value: number, size: number] => {
      const first = bytes[0]!
      if (first < 0xfd) return [first, 1]
      if (first === 0xfd) return [bytes.readUInt16LE(1), 3]
      if (first === 0xfe) return [bytes.readUInt32LE(1), 5]
      return [Number(bytes.readBigUInt64LE(1)), 9]
    }

    cli('unloadwallet', name)
    // From here the wallet is unloaded, rewritten, loaded and used: whatever
    // fails, the rewrite is all or nothing, and the wallet ends unloaded.
    let loaded = false
    let finished = false
    try {
      const db = new DatabaseSync(`${env['QBIT_REGTEST_DATADIR']}/regtest/wallets/${name}/wallet.dat`)
      try {
        db.exec('BEGIN')
        const type = Buffer.from('\x16walletdescriptorpqckey', 'latin1')
        const records = db
          .prepare('SELECT key, value FROM main')
          .all()
          .map(row => ({ key: Buffer.from(row['key'] as Uint8Array), value: Buffer.from(row['value'] as Uint8Array) }))
          .filter(({ key }) => key.subarray(0, type.length).equals(type))
        const sha256 = (data: Buffer) => createHash('sha256').update(data).digest()
        for (const [key, count] of Object.entries(written) as [Key, number][]) {
          const { pubkey } = keys[key]
          const matching = records.filter(record => record.key.toString('hex').endsWith(pubkey))
          expect(matching).toHaveLength(1)
          const { key: dbKey, value } = matching[0]!
          const [secretLength, prefix] = compactSize(value)
          const secret = value.subarray(prefix, prefix + secretLength)
          expect(value.length).toBe(prefix + secret.length + 32 + 4)
          const counter = Buffer.alloc(4)
          counter.writeUInt32LE(count)
          const hash = sha256(sha256(Buffer.concat([Buffer.from(pubkey, 'hex'), secret, counter])))
          db.prepare('UPDATE main SET value = ? WHERE key = ?').run(
            Buffer.concat([value.subarray(0, prefix + secret.length), hash, counter]),
            dbKey
          )
        }
        db.exec('COMMIT')
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // No transaction open: BEGIN itself failed. The first error is the one to see.
        }
        throw error
      } finally {
        db.close()
      }
      cli('loadwallet', name)
      loaded = true
      // The node checks a loaded wallet's plaintext PQC keys before it signs with
      // them, on its scheduler thread, which other wallets' keypool top-ups share.
      // Wait for that check to have run on this load: complete, with every
      // plaintext record validated and none failed. Not being blocked alone can
      // hold before the check is even scheduled.
      for (let i = 0; ; i++) {
        const validation = (await wallet.getWalletInfo()).pqcKeyValidation
        const { status, plaintextRecords, validatedRecords, pendingRecords, failedRecords, signingBlocked } = validation
        if (
          status === 'complete' &&
          plaintextRecords > 0 &&
          validatedRecords === plaintextRecords &&
          pendingRecords === 0 &&
          failedRecords === 0 &&
          !signingBlocked
        ) {
          break
        }
        expect(status, 'PQC key validation after loadwallet').not.toBe('failed')
        expect(i, `PQC key validation after loadwallet: ${JSON.stringify(validation)}`).toBeLessThan(2400)
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      const oneKey = (key: Key, count: number) => {
        const state = stateOf(count)
        const fields = { pqcSignatureCount: count, pqcSignatureLimit: LIMIT, pqcSignaturesRemaining: LIMIT - count }
        return {
          pqcKeyStates: [{ pubkey: keys[key].pubkey, ...fields, pqcLimitState: state }],
          pqcOverallLimitState: state,
          ...fields,
          pqcLimitState: state,
        }
      }
      // getaddressinfo reads each count back, in the state it falls in, without warnings.
      for (const [key, count] of Object.entries(written) as [Key, number][]) {
        const info = await wallet.getAddressInfo(keys[key].address)
        expect(info).toMatchObject(oneKey(key, count))
        expect(info).not.toHaveProperty('warnings')
      }

      const line = (key: Key, text: string, count: number) =>
        `PQC key ${keys[key].pubkey} ${text} (${count} of ${LIMIT} signatures used, ${LIMIT - count} remaining)`
      const sign = async (key: Key, inputs = keys[key].coins.slice(0, 1)) => {
        const funded = await wallet.walletCreateFundedPsbt({
          inputs,
          outputs: [{ address: destination, amountBits: 10_000_000n }],
          options: { addInputs: false, feeRateBitsPerKvB: 2000n },
        })
        return wallet.walletProcessPsbt(funded.psbt)
      }
      // [key, the count after one more signature, its warning lines]
      const steps: [Key, number, string[] | undefined][] = [
        ['warning', WARNING_FROM, [line('warning', 'entered warning usage range', WARNING_FROM)]],
        ['warning', WARNING_FROM + 1, undefined],
        [
          'warningReminder',
          WARNING_FROM + 2 ** 24,
          [line('warningReminder', 'remains in warning usage range', WARNING_FROM + 2 ** 24)],
        ],
        ['critical', CRITICAL_FROM, [line('critical', 'entered critical usage range', CRITICAL_FROM)]],
        [
          'criticalReminder',
          CRITICAL_FROM + 2 ** 20,
          [line('criticalReminder', 'remains in critical usage range', CRITICAL_FROM + 2 ** 20)],
        ],
      ]
      for (const [key, after, warnings] of steps) {
        const processed = await sign(key)
        expect(processed).toMatchObject({ complete: true, ...oneKey(key, after) })
        expect(processed.warnings).toEqual(warnings)
        expect(processed.hex).toMatch(/^[0-9a-f]+$/)
      }

      // One signature left and two inputs of the key: the first input is signed,
      // the second is not, and the node answers without an error.
      const last = await sign('last', keys.last.coins)
      expect(last).toMatchObject({
        complete: false,
        ...oneKey('last', LIMIT),
        warnings: [`${line('last', 'reached the signature limit', LIMIT)}. Rotate to a new key/address.`],
      })
      expect(last).not.toHaveProperty('hex')
      expect(await wallet.getAddressInfo(keys.last.address)).toMatchObject(oneKey('last', LIMIT))
      // Exhausted: the key no longer signs, so it takes no part in the response.
      expect(await sign('last')).toEqual({ psbt: expect.any(String), complete: false })
      // Beside a key that can sign, only that one is reported, and as normal.
      const mixed = await sign('last', [keys.last.coins[0]!, keys.normal.coins[0]!])
      expect(mixed).toMatchObject({ complete: false, ...oneKey('normal', 1) })
      expect(mixed).not.toHaveProperty('warnings')

      // What the root README's quick start reads before signing: decodepsbt
      // gives each input's address, and getaddressinfo in one batch its key's state.
      const funded = await wallet.walletCreateFundedPsbt({
        inputs: [keys.last.coins[1]!, keys.critical.coins[0]!, keys.normal.coins[0]!],
        outputs: [{ address: destination, amountBits: 10_000_000n }],
        options: { addInputs: false, feeRateBitsPerKvB: 2000n },
      })
      const { inputs } = (await wallet.call('decodepsbt', [funded.psbt])) as {
        inputs: { witness_utxo?: { scriptPubKey: { address?: string } } }[]
      }
      const spent = inputs.map(input => input.witness_utxo?.scriptPubKey.address)
      expect(new Set(spent)).toEqual(new Set([keys.last.address, keys.critical.address, keys.normal.address]))
      const budgets = await wallet.batch(spent.map(address => requests.getAddressInfo(address!)))
      expect(
        Object.fromEntries(budgets.map((info, i) => [spent[i], info.ok ? info.value.pqcOverallLimitState : info.error]))
      ).toEqual({
        [keys.last.address]: 'exhausted',
        [keys.critical.address]: 'critical',
        [keys.normal.address]: 'normal',
      })
      // And each key's signatures left, which it compares with the inputs it signs.
      const left = (info: (typeof budgets)[number]) =>
        info.ok ? Math.min(...(info.value.pqcKeyStates ?? []).map(key => key.pqcSignaturesRemaining)) : -1
      expect(left(budgets[spent.indexOf(keys.last.address)]!)).toBe(0)
      expect(left(budgets[spent.indexOf(keys.critical.address)]!)).toBeGreaterThan(0)
      finished = true
    } finally {
      // An unload that fails after the test already failed does not hide that failure.
      if (loaded) {
        try {
          cli('unloadwallet', name)
        } catch (error) {
          if (finished) throw error
        }
      }
    }
  }, 600_000)

  describe('chain scanner, mempool and package methods', () => {
    const mineOne = (): string => {
      const to = cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr')
      return (JSON.parse(cli('generatetoaddress', '1', to)) as string[])[0]!
    }
    const pay = (): string =>
      cli('-rpcwallet=smoke', 'sendtoaddress', cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr'), '0.1')

    it('reads a block at each verbosity, checked against getblockheader and the transaction', async () => {
      const rpc = client({ maxResponseBytes: 16 * 1024 * 1024 })
      const txid = pay()
      const blockHash = mineOne()
      const header = await rpc.getBlockHeader(blockHash)
      const block = await rpc.getBlock(blockHash)
      expect(block).toMatchObject(header)
      expect(block.nTx).toBe(2)
      expect(block.tx[1]).toBe(txid)
      expect(block.size).toBeGreaterThan(block.strippedSize)

      const full = await rpc.getBlockWithTransactions(blockHash)
      const { tx: _txids, ...fields } = block
      expect(full).toMatchObject(fields)
      expect(full.tx.map(tx => tx.txid)).toEqual(block.tx)
      expect(full.tx[0]!.vin[0]).toHaveProperty('coinbase')
      expect(full.tx[0]).not.toHaveProperty('feeBits')
      const decoded = await rpc.getRawTransactionVerbose(txid, { blockHash })
      expect(full.tx[1]).toMatchObject({
        txid,
        hash: decoded.hash,
        vin: decoded.vin,
        vout: decoded.vout,
        hex: decoded.hex,
      })
      const fee = (JSON.parse(cli('-rpcwallet=smoke', 'gettransaction', txid)) as { fee: number }).fee
      expect(full.tx[1]!.feeBits).toBe(BigInt(Math.round(-fee * 1e8)))

      const blockHex = await rpc.getBlockHex(blockHash)
      expect(blockHex).toBe(cli('getblock', blockHash, '0'))
      expect(blockHex).toContain(decoded.hex)

      // The genesis block at each verbosity: no parent, no undo data, an output with no address.
      const genesis = await rpc.getBlockWithTransactions(REGTEST_GENESIS)
      expect(genesis).not.toHaveProperty('previousBlockHash')
      expect(genesis.tx[0]).not.toHaveProperty('feeBits')
      expect((await rpc.getBlock(REGTEST_GENESIS)).tx).toEqual([genesis.tx[0]!.txid])
      expect(await rpc.getBlockHex(REGTEST_GENESIS)).toContain(genesis.tx[0]!.hex)

      // As reads they go in a batch, and an unknown block is that entry's -5.
      const [one, two, zero, missing] = await rpc.batch([
        requests.getBlock(blockHash),
        requests.getBlockWithTransactions(blockHash),
        requests.getBlockHex(blockHash),
        requests.getBlock('00'.repeat(32)),
      ])
      expect(one.ok && one.value.hash).toBe(blockHash)
      expect(two.ok && two.value.tx[1]!.txid).toBe(txid)
      expect(zero.ok && zero.value).toBe(blockHex)
      expect(!missing.ok && RpcError.is(missing.error) && missing.error.rpcCode).toBe(-5)
      await expect(rpc.getBlock('00'.repeat(32))).rejects.toSatisfy(
        (error: unknown) => RpcError.is(error) && error.rpcCode === -5
      )

      // One P2MR spend's signature already passes a small cap; the short form still fits it.
      const small = client({ maxResponseBytes: 4096 })
      await expect(small.getBlockWithTransactions(blockHash)).rejects.toSatisfy(RpcResponseTooLargeError.is)
      expect((await small.getBlock(blockHash)).hash).toBe(blockHash)
    })

    it('follows a reorg through getChainTips', async () => {
      const rpc = client()
      const stale = mineOne()
      const staleHeight = (await rpc.getBlockHeader(stale)).height
      const tipOf = async (hash: string) => (await rpc.getChainTips()).find(tip => tip.hash === hash)
      expect(await tipOf(stale)).toEqual({ height: staleHeight, hash: stale, branchLen: 0, status: 'active' })

      cli('invalidateblock', stale)
      expect(await tipOf(stale)).toEqual({ height: staleHeight, hash: stale, branchLen: 1, status: 'invalid' })
      const previous = await rpc.getBestBlockHash()
      expect(await tipOf(previous)).toMatchObject({ height: staleHeight - 1, branchLen: 0, status: 'active' })

      // Two blocks on the other branch: more work than the stale one, which a tie would leave active.
      expect(mineOne()).not.toBe(stale)
      const replacement = mineOne()
      expect(await tipOf(replacement)).toMatchObject({ height: staleHeight + 1, branchLen: 0, status: 'active' })

      cli('reconsiderblock', stale)
      expect(await tipOf(stale)).toEqual({ height: staleHeight, hash: stale, branchLen: 1, status: 'valid-fork' })
      expect(await rpc.getBestBlockHash()).toBe(replacement)
      expect((await rpc.getChainTips()).filter(tip => tip.status === 'active')).toHaveLength(1)
      expect((await rpc.getBlock(stale)).confirmations).toBe(-1)
      expect((await rpc.getBlock(stale)).hash).toBe(stale)
    })

    it('reads the fee floor and the mempool with a transaction in it', async () => {
      const rpc = client()
      const before = await rpc.getMempoolInfo()
      expect(before.size).toBe(0)
      expect(before.minRelayTxFeeBitsPerKvB).toBe(250n)
      expect(before.mempoolMinFeeBitsPerKvB).toBe(250n)
      expect(before.fullRbf).toBe(true)
      const start = await rpc.getRawMempoolSequence()
      expect(start.txids).toEqual([])

      const txid = pay()
      const entry = await rpc.getMempoolEntry(txid)
      const info = await rpc.getMempoolInfo()
      expect(info).toMatchObject({ size: 1, bytes: entry.vsize, totalFeeBits: entry.fees.baseBits })
      expect(await rpc.getRawMempool()).toEqual([txid])
      expect(await rpc.getRawMempoolVerbose()).toEqual({ [txid]: entry })
      const snapshot = await rpc.getRawMempoolSequence()
      expect(snapshot.txids).toEqual([txid])
      expect(snapshot.mempoolSequence).toBe(start.mempoolSequence + 1n)

      mineOne()
      expect(await rpc.getRawMempool()).toEqual([])
      expect(await rpc.getRawMempoolVerbose()).toEqual({})
      expect((await rpc.getMempoolInfo()).size).toBe(0)
    })

    it('finds the mempool spender of a spent output, and none for an unspent one', async () => {
      const rpc = client()
      const txid = pay()
      const { vin } = await rpc.getRawTransactionVerbose(txid)
      const spent = vin[0] as Outpoint
      const unspent = { txid, vout: 0 }
      expect(await rpc.getTxSpendingPrevout([spent, unspent])).toEqual([
        { txid: spent.txid, vout: spent.vout, spendingTxid: txid },
        unspent,
      ])
      // Further than the transaction has outputs, up to the bound qbit Core reads.
      const far = { txid, vout: 0x7fff_ffff }
      expect(await rpc.getTxSpendingPrevout([far])).toEqual([far])
      await expect(rpc.getTxSpendingPrevout([{ txid, vout: 0x8000_0000 }])).rejects.toThrow(RangeError)
      await expect(rpc.call('gettxspendingprevout', [[{ txid, vout: 0x8000_0000 }]])).rejects.toSatisfy(RpcError.is)
      await expect(rpc.getTxSpendingPrevout([])).rejects.toThrow(RangeError)
      await expect(rpc.call('gettxspendingprevout', [[]])).rejects.toSatisfy(
        (error: unknown) => RpcError.is(error) && error.rpcCode === -8
      )

      mineOne()
      expect(await rpc.getTxSpendingPrevout([spent])).toEqual([{ txid: spent.txid, vout: spent.vout }])
    })

    it('long-polls for a block past the client’s deadline, beside other calls', { timeout: 60_000 }, async () => {
      // The client's own deadline is shorter than these waits, which set their own.
      const rpc = client({ timeoutMs: 2_000 })
      const start = await rpc.getBlockchainInfo()
      const tip = { hash: start.bestBlockHash, height: start.blocks }

      // The wait ran out: the tip as it stands, below the height asked for, and not an error.
      expect(await rpc.waitForBlockHeight(tip.height + 1000, 100)).toEqual(tip)
      expect(await rpc.waitForNewBlock(100, { currentTip: tip.hash })).toEqual(tip)
      // Already there, or a tip that is not the node's: at once.
      // A call's own deadline must outlast the wait by the 10 s margin.
      expect(await rpc.waitForBlockHeight(tip.height, 30_000, { timeoutMs: 40_000 })).toEqual(tip)
      await expect(rpc.waitForBlockHeight(tip.height, 30_000, { timeoutMs: 39_999 })).rejects.toThrow(RangeError)
      expect(await rpc.waitForNewBlock(30_000, { currentTip: '00'.repeat(32) })).toEqual(tip)

      // Past the transport's 15 s idle timer, with another call beside it, and a block ends it early.
      const waited = performance.now()
      const byHeight = rpc.waitForBlockHeight(tip.height + 1, 40_000)
      const byTip = rpc.waitForNewBlock(40_000, { currentTip: tip.hash })
      await new Promise(resolve => setTimeout(resolve, 16_000))
      expect(await rpc.getBlockCount()).toBe(tip.height)
      const hash = mineOne()
      const next = { hash, height: tip.height + 1 }
      expect(await byHeight).toEqual(next)
      expect(await byTip).toEqual(next)
      expect(performance.now() - waited).toBeLessThan(35_000)

      // A deadline that cannot outlast the wait is refused, and a slot held by a wait queues other calls.
      await expect(rpc.waitForNewBlock(1000, undefined, { timeoutMs: 1000 })).rejects.toThrow(RangeError)
      const one = client({ maxConcurrentRequests: 1 })
      const holding = one.waitForNewBlock(1000, { currentTip: hash })
      await expect(one.getBlockCount({ timeoutMs: 100 })).rejects.toSatisfy(RpcTimeoutError.is)
      expect(await holding).toEqual(next)
      expect(await one.getBlockCount()).toBe(next.height)

      await expect(rpc.batch([requests.waitForNewBlock(100)])).rejects.toMatchObject({ reason: 'not_batchable' })
    })

    it('submits a parent and a CPFP child as a package', async () => {
      const wallet = client({ wallet: 'smoke', capabilities: ['wallet-read', 'broadcast'] })
      const coins = (await wallet.listUnspent()).filter(coin => coin.amountBits > 100_000_000n)
      const address = (): string => cli('-rpcwallet=smoke', 'getnewaddress', '', 'p2mr')
      type Signed = { hex: string; complete: boolean }
      /** A signed transaction spending `input` to one new address; `scriptPubKey` for an input not yet in the mempool. */
      const spend = (
        input: { txid: string; vout: number; amountBits: bigint; scriptPubKey?: string },
        feeBits: bigint,
        amountBits = input.amountBits - feeBits
      ): {
        hex: string
        txid: string
        output: { txid: string; vout: number; amountBits: bigint; scriptPubKey: string }
      } => {
        const raw = cli(
          'createrawtransaction',
          JSON.stringify([{ txid: input.txid, vout: input.vout }]),
          `[{"${address()}":${formatQbt(amountBits)}}]`
        )
        const prev =
          input.scriptPubKey === undefined
            ? []
            : [
                JSON.stringify([
                  {
                    txid: input.txid,
                    vout: input.vout,
                    scriptPubKey: input.scriptPubKey,
                    amount: Number(formatQbt(input.amountBits)),
                  },
                ]),
              ]
        const signed = JSON.parse(cli('-rpcwallet=smoke', 'signrawtransactionwithwallet', raw, ...prev)) as Signed
        expect(signed.complete).toBe(true)
        const decoded = JSON.parse(cli('decoderawtransaction', signed.hex)) as {
          txid: string
          vout: { scriptPubKey: { hex: string } }[]
        }
        return {
          hex: signed.hex,
          txid: decoded.txid,
          output: { txid: decoded.txid, vout: 0, amountBits, scriptPubKey: decoded.vout[0]!.scriptPubKey.hex },
        }
      }

      // A parent at the fee floor (about 3,817 vB at 250 bits/kvB), and a child paying for both.
      const parent = spend(coins[0]!, 1_000n)
      const child = spend(parent.output, 10_000_000n)
      const pair = [parent.hex, child.hex]

      await expect(client({ capabilities: [] }).submitPackage(pair)).rejects.toSatisfy(RpcCapabilityError.is)
      await expect(wallet.submitPackage(pair)).rejects.toSatisfy(RpcChainGuardError.is)
      await wallet.confirmChain()
      await expect(wallet.submitPackage(pair, { maxFeeRateBitsPerKvB: 0n })).rejects.toThrow(RangeError)
      await expect(wallet.submitPackage([])).rejects.toThrow(RangeError)

      // The child first: the node's own refusal, before anything is accepted, so
      // a definite RpcError with the text the client tells such a refusal by.
      const refused = (code: number, message: string) => (error: unknown) =>
        RpcError.is(error) && error.rpcCode === code && error.message === message
      await expect(wallet.submitPackage([child.hex, parent.hex])).rejects.toSatisfy(
        refused(-25, 'package topology disallowed. not child-with-parents or parents depend on each other.')
      )
      await expect(wallet.call('submitpackage', [['aabb']])).rejects.toSatisfy(
        refused(-22, 'TX decode failed: aabb Make sure the tx has at least one input.')
      )
      await expect(wallet.call('submitpackage', [[]])).rejects.toSatisfy(
        refused(-8, 'Array must contain between 1 and 25 transactions.')
      )
      expect(await wallet.getRawMempool()).toEqual([])

      // A cap between the two fee rates: a partial result, the parent in the mempool and the child refused.
      const capped = await wallet.submitPackage(pair, { maxFeeRateBitsPerKvB: 5_000n })
      expect(capped.packageMsg).toBe('transaction failed')
      const cappedResults = Object.values(capped.txResults)
      expect(cappedResults.map(result => result.txid)).toEqual([parent.txid, child.txid])
      expect(cappedResults[0]!.error).toBeUndefined()
      expect(cappedResults[1]!.error).toBe('max feerate exceeded')
      expect(await wallet.getRawMempool()).toEqual([parent.txid])

      const accepted = await wallet.submitPackage(pair, { maxFeeRateBitsPerKvB: 99_999_999n })
      expect(accepted.packageMsg).toBe('success')
      expect(accepted.replacedTransactions).toEqual([])
      const [parentResult, childResult] = Object.values(accepted.txResults)
      expect(parentResult).toMatchObject({ txid: parent.txid, fees: { baseBits: 1_000n } })
      expect(parentResult!.fees).not.toHaveProperty('effectiveFeeRateBitsPerKvB')
      expect(childResult).toMatchObject({ txid: child.txid, fees: { baseBits: 10_000_000n } })
      expect(childResult!.fees!.effectiveFeeRateBitsPerKvB).toBeGreaterThan(0n)
      const entry = await wallet.getMempoolEntry(child.txid)
      expect(entry).toMatchObject({ ancestorCount: 2, depends: [parent.txid], fees: { ancestorBits: 10_001_000n } })
      expect(await wallet.getTxSpendingPrevout([parent.output])).toEqual([
        { txid: parent.txid, vout: 0, spendingTxid: child.txid },
      ])

      // Sent again: nothing changes, and it is still a success, which is how to reconcile an unknown outcome.
      const again = await wallet.submitPackage(pair)
      expect(again.packageMsg).toBe('success')
      expect(Object.values(again.txResults).map(result => result.txid)).toEqual([parent.txid, child.txid])

      // A parent below the relay floor is refused even with a child paying for it, in a result and not as an error.
      const lowParent = spend(coins[1]!, 100n)
      const lowChild = spend(lowParent.output, 10_000_000n)
      const low = await wallet.submitPackage([lowParent.hex, lowChild.hex])
      expect(low.packageMsg).toBe('transaction failed')
      expect(Object.values(low.txResults)[0]!.error).toMatch(/min relay fee not met/)
      expect(await wallet.getRawMempool()).not.toContain(lowParent.txid)

      // maxburnamount: the check runs when the hex is decoded, so this needs no signature or coin.
      const burn = `0200000001${'00'.repeat(32)}0000000000ffffffff01e803000000000000016a00000000`
      await expect(wallet.submitPackage([burn])).rejects.toSatisfy(
        refused(-25, 'Unspendable output exceeds maximum configured by user (maxburnamount)')
      )
      const allowed = await wallet.submitPackage([burn], { maxBurnAmountBits: 1000n })
      expect(allowed.packageMsg).not.toBe('success')

      // Through call(), and with the node's reply unvalidated.
      const raw = (await wallet.call('submitpackage', [pair])) as { package_msg: string }
      expect(raw.package_msg).toBe('success')

      mineOne()
      expect(await wallet.getRawMempool()).toEqual([])
    })
  })
})
