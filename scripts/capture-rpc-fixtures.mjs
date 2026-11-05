#!/usr/bin/env node
// Capture real qbit Core replies as the seeds of the rpc package's validator
// tests (packages/rpc/test/fixtures.test.ts).
//
// Usage: corepack pnpm build && QBIT_BIN_DIR=/path/to/qbit-1.0.0/bin node scripts/capture-rpc-fixtures.mjs
//
// Starts a throwaway node of the release named in scripts/qbit-core-release.mjs
// with -regtest only, in a temporary data directory, RPC bound to 127.0.0.1
// on a free port and no network, as scripts/regtest-smoke.sh does. Every
// request is built with the built package's `requests` builders, so a
// fixture holds the builder, its arguments, the method and params it sent,
// and the result exactly as the node wrote it: numbers keep their source
// text. Each result must pass its builder's validator, and a fixture holding
// the data directory, the host name or a home directory is refused. The
// fixtures directory is emptied of earlier .json files and written afresh;
// on exit, a failure, SIGINT or SIGTERM, the node is stopped (killed if it
// does not stop within 60 s) and its data directory removed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { hostDetailsIn, stopNode } from './regtest-node.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(repoRoot, 'packages/rpc/test/fixtures/regtest')
const { requests, JsonNumber } = await import(pathToFileURL(join(repoRoot, 'packages/rpc/lib/index.mjs')).href)
const { QBIT_CORE_VERSION } = await import(pathToFileURL(join(repoRoot, 'scripts/qbit-core-release.mjs')).href)

const binDir = process.env.QBIT_BIN_DIR
if (!binDir) throw new Error('set QBIT_BIN_DIR to the directory holding qbitd and qbit-cli')
const qbitd = join(binDir, 'qbitd')
const version = execFileSync(qbitd, ['-version'], { encoding: 'utf8' }).split('\n')[0]
if (!version.includes(` v${QBIT_CORE_VERSION}`))
  throw new Error(`QBIT_BIN_DIR holds '${version}', not v${QBIT_CORE_VERSION}`)

// JSON.parse source-text access keeps each number as the node wrote it.
const lossless = text =>
  JSON.parse(text, (_key, value, context) => (typeof value === 'number' ? JSON.rawJSON(context.source) : value))
// The fixture form of a builder argument: a bigint as { "$bigint": "<digits>" }.
const encodeArgs = args =>
  JSON.parse(JSON.stringify(args, (_key, value) => (typeof value === 'bigint' ? { $bigint: value.toString() } : value)))
// The params as the client sends them: bigints and raw decimals as JSON numbers.
const sentParams = params =>
  lossless(
    JSON.stringify(params, (_key, value) => (typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value))
  )
// What the validators take: numbers as the built package's JsonNumber.
const asValidatorInput = text =>
  JSON.parse(text, (_key, value, context) => (typeof value === 'number' ? new JsonNumber(context.source) : value))

const freePort = () =>
  new Promise(resolve => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

const rpcPort = await freePort()
/** Set once the data directory exists: from then on, cleanup() stops the node and removes it. */
let datadir
const cli = (...args) =>
  execFileSync(join(binDir, 'qbit-cli'), ['-regtest', `-datadir=${datadir}`, `-rpcport=${rpcPort}`, ...args], {
    encoding: 'utf8',
  }).trim()

let cleaned = false
function cleanup() {
  if (datadir === undefined || cleaned) return
  cleaned = true
  stopNode({
    datadir,
    pidFile: join(datadir, 'regtest/qbitd.pid'),
    stop: () =>
      execFileSync(join(binDir, 'qbit-cli'), ['-regtest', `-datadir=${datadir}`, `-rpcport=${rpcPort}`, 'stop'], {
        stdio: 'ignore',
        timeout: 30_000,
      }),
  })
}
// An interrupt stops the node too. A signal that arrives during a synchronous
// call is handled once it returns; Ctrl-C also ends the qbit-cli it waits for.
process.once('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.once('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

const fixtures = []
try {
  datadir = mkdtempSync(join(tmpdir(), 'qbit-rpc-fixtures-'))
  execFileSync(qbitd, [
    '-regtest',
    '-daemonwait',
    `-datadir=${datadir}`,
    '-server=1',
    '-rpcbind=127.0.0.1',
    '-rpcallowip=127.0.0.1',
    `-rpcport=${rpcPort}`,
    '-listen=0',
    '-connect=0',
    '-dnsseed=0',
    '-fixedseeds=0',
    '-fallbackfee=0.0001',
    '-txindex=1',
  ])
  cli('-rpcwait', '-rpcwaittimeout=60', 'getblockchaininfo')
  const cookie = readFileSync(join(datadir, 'regtest/.cookie'), 'utf8').trim()
  let id = 0

  /** Send a built request; returns the result's source text, or throws the node's error. */
  async function send(request, wallet) {
    const response = await fetch(`http://127.0.0.1:${rpcPort}/${wallet === undefined ? '' : `wallet/${wallet}`}`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        { jsonrpc: '2.0', id: ++id, method: request.method, params: request.params },
        (_key, value) => (typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value)
      ),
    })
    const reply = lossless(await response.text())
    if (reply.error !== null && reply.error !== undefined) {
      throw new Error(`${request.method}: ${reply.error.code} ${reply.error.message}`)
    }
    return JSON.stringify(reply.result, null, 2)
  }

  /** Build, send and validate `builder(...args)`, record it as fixture `name`, and return the parsed value. */
  async function capture(name, description, builder, args, wallet) {
    const request = requests[builder](...args)
    const text = await send(request, wallet)
    const value = request.parse(asValidatorInput(text))
    fixtures.push({
      name,
      text: `{\n  "description": ${JSON.stringify(description)},\n  "builder": ${JSON.stringify(builder)},\n  "args": ${JSON.stringify(encodeArgs(args))},\n  "method": ${JSON.stringify(request.method)},\n  "params": ${JSON.stringify(sentParams(request.params))},\n  "result": ${text.replaceAll('\n', '\n  ')}\n}\n`,
    })
    return value
  }
  const raw = (method, params, wallet) => send(requests.raw(method, params), wallet).then(text => JSON.parse(text))

  cli('-named', 'createwallet', 'wallet_name=fixtures', 'descriptors=true')
  cli('-named', 'createwallet', 'wallet_name=payee', 'descriptors=true')
  const W = 'fixtures'
  const mineTo = cli('-rpcwallet=fixtures', 'getnewaddress', '', 'p2mr')
  // qbit Core matures coinbase outputs after 1,000 blocks.
  cli('generatetoaddress', '1010', mineTo)
  const payee = () => cli('-rpcwallet=payee', 'getnewaddress', '', 'p2mr')

  // Chain and utility reads.
  await capture('getblockchaininfo', 'getblockchaininfo on regtest', 'getBlockchainInfo', [])
  await capture('getnetworkinfo', 'getnetworkinfo, no network', 'getNetworkInfo', [])
  const tip = await capture('getbestblockhash', 'getbestblockhash', 'getBestBlockHash', [])
  await capture('getblockcount', 'getblockcount', 'getBlockCount', [])
  const genesis = await capture('getblockhash', 'getblockhash 0, the genesis block', 'getBlockHash', [0])
  await capture(
    'getblockheader-genesis',
    'getblockheader of the genesis block (no previousblockhash)',
    'getBlockHeader',
    [genesis]
  )
  await capture('getblockheader-tip', 'getblockheader of the tip (no nextblockhash)', 'getBlockHeader', [tip])
  const middle = await send(requests.getBlockHash(500)).then(text => JSON.parse(text))
  await capture('getblockheader-middle', 'getblockheader of block 500', 'getBlockHeader', [middle])
  await capture('getconfirmationtarget', 'getconfirmationtarget for 1 QBT at high security', 'getConfirmationTarget', [
    100_000_000n,
    { securityLevel: 'high' },
  ])
  await capture('estimatesmartfee', 'estimatesmartfee 6 with no fee data (errors, no feerate)', 'estimateSmartFee', [6])
  await capture('validateaddress-p2mr', 'validateaddress of a P2MR address', 'validateAddress', [mineTo])
  await capture('validateaddress-invalid', 'validateaddress of a string that is no address', 'validateAddress', [
    'not-an-address',
  ])
  const proofAddress = cli('-rpcwallet=fixtures', 'getnewaddress', '', 'p2mr')
  const proof = await raw('signdatapqchash', [proofAddress, '11'.repeat(32)], W)
  await capture('verifydatapqchash', 'verifydatapqchash of a proof signdatapqchash made', 'verifyDataPqcHash', [
    {
      address: proof.address,
      messageHash: proof.message_hash,
      signature: proof.signature,
      pubkey: proof.pubkey,
      leafScript: proof.leaf_script,
      controlBlock: proof.control_block,
      leafVersion: Number(proof.leaf_version),
      proofMode: 'p2mr-pubkey',
    },
  ])

  // Wallet reads and keys.
  await capture('getwalletinfo', 'getwalletinfo of an unencrypted descriptor wallet', 'getWalletInfo', [], W)
  await capture('getbalances', 'getbalances with mature and immature coinbase', 'getBalances', [], W)
  await capture('listunspent', 'listunspent with at most 3 outputs', 'listUnspent', [{ maximumCount: 3 }], W)
  await capture('getaddressinfo', 'getaddressinfo of an own P2MR address', 'getAddressInfo', [mineTo], W)
  await capture('getnewaddress', 'getnewaddress p2mr', 'getNewAddress', [{ addressType: 'p2mr' }], W)
  await capture('getrawchangeaddress', 'getrawchangeaddress p2mr', 'getRawChangeAddress', [{ addressType: 'p2mr' }], W)
  const [coin] = await requests
    .listUnspent({ maximumCount: 1 })
    .parse(asValidatorInput(await send(requests.listUnspent({ maximumCount: 1 }), W)))
  const outpoint = { txid: coin.txid, vout: coin.vout }
  await capture('lockunspent', 'lockunspent of one output', 'lockUnspent', [[outpoint]], W)
  await capture('listlockunspent', 'listlockunspent with one locked output', 'listLockUnspent', [], W)
  await capture('unlockunspent', 'lockunspent true (unlock) of that output', 'unlockUnspent', [[outpoint]], W)

  // An encrypted wallet. Its first unlock tops its keypool up, which can take 30 s.
  cli('-named', 'createwallet', 'wallet_name=locked', 'descriptors=true', 'passphrase=fixtures-passphrase')
  await capture('getwalletinfo-locked', 'getwalletinfo of a locked encrypted wallet', 'getWalletInfo', [], 'locked')
  await capture(
    'walletpassphrase',
    'walletpassphrase for 60 s',
    'walletPassphrase',
    ['fixtures-passphrase', 60],
    'locked'
  )
  await capture('walletlock', 'walletlock', 'walletLock', [], 'locked')

  // A replaceable payment, built, signed and broadcast.
  const funded = await capture(
    'walletcreatefundedpsbt',
    'walletcreatefundedpsbt of a replaceable payment with change',
    'walletCreateFundedPsbt',
    [
      {
        outputs: [{ address: payee(), amountBits: 123_456_789n }],
        options: { feeRateBitsPerKvB: 1000n, changeType: 'p2mr', replaceable: true },
      },
    ],
    W
  )
  const processed = await capture(
    'walletprocesspsbt',
    'walletprocesspsbt: signed and complete',
    'walletProcessPsbt',
    [funded.psbt],
    W
  )
  await capture(
    'walletprocesspsbt-unsigned',
    'walletprocesspsbt sign=false: incomplete, no hex',
    'walletProcessPsbt',
    [funded.psbt, { sign: false }],
    W
  )
  await capture('finalizepsbt', 'finalizepsbt of the signed PSBT', 'finalizePsbt', [processed.psbt], W)
  await capture(
    'finalizepsbt-incomplete',
    'finalizepsbt of the unsigned PSBT: incomplete',
    'finalizePsbt',
    [funded.psbt],
    W
  )
  await capture('testmempoolaccept', 'testmempoolaccept of the signed payment: allowed', 'testMempoolAccept', [
    [processed.hex],
  ])
  const sent = await capture('sendrawtransaction', 'sendrawtransaction of the signed payment', 'sendRawTransaction', [
    processed.hex,
  ])
  await capture(
    'testmempoolaccept-rejected',
    'testmempoolaccept of the payment already in the mempool: rejected',
    'testMempoolAccept',
    [[processed.hex]]
  )
  await capture(
    'gettransaction-send-unconfirmed',
    'gettransaction of the payment in the mempool',
    'getTransaction',
    [sent],
    W
  )
  await capture('getmempoolentry', 'getmempoolentry of the payment', 'getMempoolEntry', [sent])
  await capture('getrawtransaction', 'getrawtransaction of the payment', 'getRawTransaction', [sent])
  await capture('getrawtransaction-verbose', 'getrawtransaction verbose of the payment', 'getRawTransactionVerbose', [
    sent,
  ])
  await capture('gettxout-mempool', 'gettxout of the payment output 0 in the mempool', 'getTxOut', [sent, 0])

  // Replaced by a fee bump, then the replacement mined.
  const bumped = await capture(
    'psbtbumpfee',
    'psbtbumpfee of the payment at 5 bits/vB',
    'psbtBumpFee',
    [sent, { feeRateBitsPerKvB: 5000n }],
    W
  )
  const replacementHex = (
    await requests
      .walletProcessPsbt(bumped.psbt)
      .parse(asValidatorInput(await send(requests.walletProcessPsbt(bumped.psbt), W)))
  ).hex
  const replacement = await send(requests.sendRawTransaction(replacementHex)).then(text => JSON.parse(text))
  await capture(
    'gettransaction-replaced',
    'gettransaction of the payment the bump replaced',
    'getTransaction',
    [sent],
    W
  )
  const since = await send(requests.getBestBlockHash()).then(text => JSON.parse(text))
  cli('generatetoaddress', '1', mineTo)
  await capture(
    'gettransaction-send',
    'gettransaction of the mined replacement, a send',
    'getTransaction',
    [replacement],
    W
  )
  await capture('gettxout-confirmed', 'gettxout of a confirmed output', 'getTxOut', [replacement, 0])
  await capture('gettxout-replaced', 'gettxout of the replaced payment, in no UTXO set: null', 'getTxOut', [sent, 0])

  // Coinbase transactions, immature at the tip and mature at height 1.
  const block = height => send(requests.getBlockHash(height)).then(text => raw('getblock', [JSON.parse(text)]))
  const tipHeight = Number(await send(requests.getBlockCount()))
  await capture(
    'gettransaction-immature',
    'gettransaction of the tip coinbase: immature',
    'getTransaction',
    [(await block(tipHeight)).tx[0]],
    W
  )
  await capture(
    'gettransaction-generate',
    'gettransaction of the block 1 coinbase: mature',
    'getTransaction',
    [(await block(1)).tx[0]],
    W
  )

  // History since the block before the replacement was mined.
  await capture(
    'listsinceblock',
    'listsinceblock since the block before the replacement, with removed',
    'listSinceBlock',
    [{ blockHash: since, includeRemoved: true }],
    W
  )
  await capture('listtransactions', 'listtransactions, the 10 newest entries', 'listTransactions', [{ count: 10 }], W)

  const host = { datadir, home: homedir(), host: hostname() }
  for (const { name, text } of fixtures) {
    const [found] = hostDetailsIn(text, host)
    if (found !== undefined) throw new Error(`fixture ${name} holds '${found}'; scrub it before committing`)
  }
  mkdirSync(outDir, { recursive: true })
  for (const file of readdirSync(outDir)) if (file.endsWith('.json')) unlinkSync(join(outDir, file))
  for (const { name, text } of fixtures) writeFileSync(join(outDir, `${name}.json`), text)
  console.log(`wrote ${fixtures.length} fixtures to packages/rpc/test/fixtures/regtest/`)
} finally {
  cleanup()
}
