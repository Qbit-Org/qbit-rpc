#!/usr/bin/env node
// Verify both packages against a live qbit Core node, as
// docs/network-verification.md plans, and write a report to commit.
//
//   corepack pnpm verify:network <mode> [--flag value ...]
//
// Modes (the doc gives the flags and their defaults):
//   read     Read-only sweep, with no capability: the last --blocks blocks,
//            each transaction of each, then a sample of the mempool, outputs,
//            fee estimates and confirmation targets every --interval for
//            --duration.
//   zmq      ZMQ soak for --duration, every topic: messages, gaps, malformed
//            messages and reconnects, each hashblock checked over RPC, and
//            the blocks no hashblock announced.
//   send     One send of --send-amount QBT to a new address of the same
//            wallet, at most 0.001 QBT with a fee of at most 0.001 QBT:
//            funded, signed, preflighted, broadcast and reconciled. Without
//            --send-amount no wallet-write call is made, on any chain.
//   faults   Regtest only, on a throwaway node it starts from QBIT_BIN_DIR:
//            a wrong chain, a proxy answering 502 and 504, an abort, qbitd
//            killed after accepting a transaction, and a restart that rotates
//            the cookie. Each outcome is checked and reconciled by its txid.
//   regtest  Regtest only, on its own throwaway node: read, send, a ZMQ soak
//            across a restart, and faults, to rehearse the plan.
//
// The node comes from the environment only, never the command line:
// QBIT_RPC_URL, QBIT_RPC_COOKIE_FILE or QBIT_RPC_USER and QBIT_RPC_PASSWORD,
// QBIT_EXPECTED_CHAIN, and QBIT_ZMQ_URL, QBIT_RPC_WALLET and QBIT_RPC_CA_FILE
// where a mode needs them. faults and regtest need QBIT_BIN_DIR instead: a
// verified qbit Core release (`node scripts/qbit-release.mjs fetch <dir>`).
// Their node listens on 127.0.0.1 only, in a temporary data directory, and is
// stopped, by its pid, and removed on exit.
//
// The report (default docs/network-reports/<date>-<chain>-<mode>.md) holds no
// credential and no host of a remote node. Exits 1 when any check failed.
// Runs the built packages: `verify:network` builds them first.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  describeEndpoint,
  formatBits,
  MAX_FEE_BITS,
  MODES,
  parseArgs,
  preview,
  readNodeEnv,
  defaultReportPath,
  renderReport,
  sendPolicy,
  utcDate,
  valueAtPath,
  hideAll,
  hostOf,
  soakFailures,
} from './network-verification.mjs'
import { ownsDatadir, stopNode } from './regtest-node.mjs'
import { QBIT_CORE_VERSION } from './qbit-core-release.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const libUrl = name => pathToFileURL(join(repoRoot, 'packages', name, 'lib', 'index.mjs')).href
for (const name of ['rpc', 'zmq']) {
  if (!existsSync(fileURLToPath(libUrl(name))))
    throw new Error(`packages/${name}/lib is missing: run corepack pnpm build`)
}
const rpcLib = await import(libUrl('rpc'))
const zmqLib = await import(libUrl('zmq'))
const { QbitRpcClient, requests, parseQbt, RpcError, RpcResponseError, RpcUnknownOutcomeError } = rpcLib

const TOPICS = ['hashblock', 'hashtx', 'rawblock', 'rawtx', 'sequence']
const SECURITY_LEVELS = ['low', 'medium', 'high', 'maximum']
const BATCH = 25 // verbose transactions per batch, so a batch of large PQC witnesses stays far below 16 MiB
const MEMPOOL_SAMPLE = 200
const TXOUT_SAMPLE = 20

const log = message => console.error(`verify-network: ${message}`)

// ---------------------------------------------------------------- the record

/** Everything a run finds, with the failures that decide its exit code. */
class Record {
  failures = []
  sections = []
  data = {}
  errors = new Map() // `${method} ${path}` -> { method, path, reason, message, count, sample }

  hidden = new Set() // a remote node's URLs and host names, never written to a report

  /** Never write these into the report: a node's URLs and host names. */
  hide(...values) {
    for (const value of values) if (typeof value === 'string' && value !== '') this.hidden.add(value)
  }

  fail(message) {
    const text = hideAll(message, this.hidden)
    this.failures.push(text)
    log(`FAIL ${text}`)
  }

  /** Count a failed call, keeping one sample of each method and path. */
  callError(method, error, raw) {
    const path = RpcResponseError.is(error) ? error.path : ''
    const key = `${method} ${path} ${error?.name}`
    const seen = this.errors.get(key)
    if (seen) {
      seen.count++
      return
    }
    const entry = {
      method,
      error: error?.name ?? typeof error,
      reason: error?.reason ?? '',
      path,
      message: hideAll(String(error?.message ?? error), this.hidden).slice(0, 300),
      count: 1,
      value: raw === undefined ? '' : preview(valueAtPath(raw, path)),
    }
    this.errors.set(key, entry)
    this.fail(
      `${method}: ${entry.error}${entry.reason ? ` (${entry.reason})` : ''}${path ? ` at ${path}` : ''}: ${entry.message}`
    )
  }
}

/** A typed read, recording its failure; on a validation failure, the raw value at the path. */
async function typed(record, method, run, raw) {
  try {
    return await run()
  } catch (error) {
    let reply
    if (RpcResponseError.is(error) && error.reason === 'validation' && raw !== undefined) {
      reply = await raw().catch(() => undefined)
    }
    record.callError(method, error, reply)
    return undefined
  }
}

// --------------------------------------------------------------- the clients

function clientFor(node, { capabilities = [], url = node.url, expectedChain = node.expectedChain, ...rest } = {}) {
  return new QbitRpcClient({
    url,
    auth: node.auth,
    expectedChain,
    capabilities,
    ...(node.wallet ? { wallet: node.wallet } : {}),
    ...(node.caFile ? { tls: { ca: readFileSync(node.caFile, 'utf8') } } : {}),
    maxConcurrentRequests: 4,
    readRetries: 2,
    ...rest,
  })
}

async function describeNode(rpc, record, node) {
  const chain = await rpc.confirmChain()
  const net = await rpc.getNetworkInfo()
  const facts = {
    endpoint: describeEndpoint(node.url),
    'node version': `${net.subversion} (${net.version})`,
    'supported by @qbit-oss/rpc': rpc.nodeVersion?.supported ?? 'unknown',
    chain: chain.chain,
    blocks: chain.blocks,
    headers: chain.headers,
    'initial block download': chain.initialBlockDownload,
    pruned: chain.pruned,
    'verification progress': chain.verificationProgress,
    connections: net.connections ?? 'not reported',
    'reachable networks':
      net.networks
        .filter(n => n.reachable)
        .map(n => n.name)
        .join(', ') || 'none',
    warnings: [...chain.warnings, ...net.warnings].join('; ') || 'none',
  }
  record.data.node = facts
  return facts
}

// ------------------------------------------------------------------ read

async function readSweep(rpc, record, { blocks, durationMs, intervalMs }) {
  const tip = await rpc.getBlockCount()
  const from = Math.max(0, tip - blocks + 1)
  const walk = {
    blocks: 0,
    transactions: 0,
    auxpowVersionBlocks: 0,
    amountChecks: 0,
    amountMismatches: 0,
    maxBlockTx: 0,
  }
  const outputs = []
  log(`walking blocks ${from} to ${tip}`)
  for (let height = blocks > 0 ? from : tip + 1; height <= tip; height++) {
    const hash = await typed(record, 'getblockhash', () => rpc.getBlockHash(height))
    if (hash === undefined) continue
    const header = await typed(
      record,
      'getblockheader',
      () => rpc.getBlockHeader(hash),
      () => rpc.call('getblockheader', [hash, true])
    )
    const block = await typed(
      record,
      'getblock',
      () => rpc.getBlock(hash),
      () => rpc.call('getblock', [hash, 1])
    )
    if (header === undefined || block === undefined) continue
    walk.blocks++
    // The AuxPoW version bit (0x100), as merge-mined blocks set it.
    if ((header.version & 0x100) !== 0) walk.auxpowVersionBlocks++
    walk.maxBlockTx = Math.max(walk.maxBlockTx, block.tx.length)
    for (let i = 0; i < block.tx.length; i += BATCH) {
      const txids = block.tx.slice(i, i + BATCH)
      let results
      try {
        results = await rpc.batch(txids.map(txid => requests.getRawTransactionVerbose(txid, { blockHash: hash })))
      } catch (error) {
        record.callError('batch getrawtransaction', error)
        continue
      }
      for (const [j, result] of results.entries()) {
        walk.transactions++
        if (!result.ok) {
          const raw = await rpc.call('getrawtransaction', [txids[j], true, hash]).catch(() => undefined)
          record.callError('getrawtransaction', result.error, raw)
          continue
        }
        for (const output of result.value.vout) {
          if (outputs.length < 2_000) outputs.push({ txid: txids[j], vout: output.n })
        }
      }
    }
    // Amounts: one transaction a block, typed against call()'s JsonNumbers.
    const sample = block.tx[block.tx.length - 1]
    const [typedTx, rawTx] = await Promise.all([
      rpc.getRawTransactionVerbose(sample, { blockHash: hash }).catch(() => undefined),
      rpc.call('getrawtransaction', [sample, true, hash]).catch(() => undefined),
    ])
    if (typedTx !== undefined && rawTx !== undefined) {
      walk.amountChecks++
      const same = typedTx.vout.every((output, n) => rawTx.vout[n]?.value?.toBits() === output.valueBits)
      if (!same) {
        walk.amountMismatches++
        record.fail(`getrawtransaction ${sample}: valueBits differ from call()'s JsonNumber values`)
      }
    }
    if (walk.blocks % 100 === 0) log(`walked ${walk.blocks} blocks, ${walk.transactions} transactions`)
  }
  record.data.walk = { from, to: tip, ...walk }

  // --duration is the sampling time, after the walk.
  const samples = []
  const deadline = Date.now() + durationMs
  do {
    samples.push(await sampleOnce(rpc, record, outputs))
    if (Date.now() + intervalMs > deadline) break
    await sleep(intervalMs)
  } while (Date.now() < deadline)
  record.data.samples = samples
  record.sections.push({
    title: 'Block walk',
    text: `Blocks ${from} to ${tip}: \`getblockhash\`, \`getblockheader\`, \`getblock\` and \`getrawtransaction\` (verbose) for every transaction, and one transaction a block compared with \`call()\`'s amounts.`,
    rows: [
      {
        blocks: walk.blocks,
        transactions: walk.transactions,
        'largest block (tx)': walk.maxBlockTx,
        'AuxPoW-version blocks': walk.auxpowVersionBlocks,
        'amount checks': walk.amountChecks,
        'amount mismatches': walk.amountMismatches,
      },
    ],
  })
  record.sections.push({
    title: 'Samples',
    text: `Every ${intervalMs / 1000} s: the mempool (up to ${MEMPOOL_SAMPLE} entries), up to ${TXOUT_SAMPLE} outputs from the walk, \`estimatesmartfee\` 1 to 1008, and \`getconfirmationtarget\` at each security level for 1 QBT.`,
    rows: samples.map(s => ({
      at: s.at,
      mempool: s.mempoolSize,
      'entries read': s.entries,
      'entries gone': s.entriesGone,
      'outputs read': s.txOuts,
      'fee estimates with a rate': s.feeRates,
      'fee estimates without': s.feeErrors,
      'distinct fee rates': s.distinctFeeRates,
      'confirmation targets (low/medium/high/maximum)': s.targets,
      'hashrate source': s.hashrateSource,
    })),
  })
}

async function sampleOnce(rpc, record, outputs) {
  const sample = { at: new Date().toISOString(), entries: 0, entriesGone: 0, txOuts: 0, feeRates: 0, feeErrors: 0 }
  for (const [method, run] of [
    ['getblockchaininfo', () => rpc.getBlockchainInfo()],
    ['getnetworkinfo', () => rpc.getNetworkInfo()],
    ['getchaintips', () => rpc.getChainTips()],
    ['getmininginfo', () => rpc.getMiningInfo()],
    ['getmempoolinfo', () => rpc.getMempoolInfo()],
    ['getrawmempool (sequence)', () => rpc.getRawMempoolSequence()],
  ]) {
    await typed(record, method, run)
  }
  const mempool = (await typed(record, 'getrawmempool', () => rpc.getRawMempool())) ?? []
  sample.mempoolSize = mempool.length
  const picked = mempool.slice(0, MEMPOOL_SAMPLE)
  for (let i = 0; i < picked.length; i += 100) {
    const results = await rpc
      .batch(picked.slice(i, i + 100).map(txid => requests.getMempoolEntry(txid)))
      .catch(error => {
        record.callError('batch getmempoolentry', error)
        return []
      })
    for (const result of results) {
      if (result.ok) sample.entries++
      else if (result.error?.rpcCode === -5)
        sample.entriesGone++ // left the mempool since getrawmempool
      else record.callError('getmempoolentry', result.error)
    }
  }
  const step = Math.max(1, Math.floor(outputs.length / TXOUT_SAMPLE))
  const txOuts = outputs.filter((_, i) => i % step === 0).slice(0, TXOUT_SAMPLE)
  if (txOuts.length > 0) {
    const results = await rpc
      .batch(txOuts.map(o => requests.getTxOut(o.txid, o.vout, { includeMempool: true })))
      .catch(error => (record.callError('batch gettxout', error), []))
    for (const result of results) {
      if (result.ok) sample.txOuts++
      else record.callError('gettxout', result.error)
    }
  }
  const rates = new Set()
  for (const first of [1, 501]) {
    const targets = Array.from({ length: first === 1 ? 500 : 508 }, (_, i) => first + i)
    const results = await rpc
      .batch(targets.map(target => requests.estimateSmartFee(target)))
      .catch(error => (record.callError('batch estimatesmartfee', error), []))
    for (const [i, result] of results.entries()) {
      if (!result.ok) {
        const raw = await rpc.call('estimatesmartfee', [targets[i]]).catch(() => undefined)
        record.callError('estimatesmartfee', result.error, raw)
      } else if (result.value.feeRateBitsPerKvB !== undefined) {
        sample.feeRates++
        rates.add(result.value.feeRateBitsPerKvB)
      } else sample.feeErrors++
    }
  }
  sample.distinctFeeRates = rates.size
  const targets = []
  for (const securityLevel of SECURITY_LEVELS) {
    const target = await typed(
      record,
      `getconfirmationtarget ${securityLevel}`,
      () => rpc.getConfirmationTarget(100_000_000n, { securityLevel }),
      () => rpc.call('getconfirmationtarget', ['1.00000000', securityLevel])
    )
    targets.push(target?.requiredConfirmations ?? '-')
    sample.hashrateSource = target?.model.hashrateSource ?? sample.hashrateSource
  }
  sample.targets = targets.join('/')
  log(`sample: mempool ${sample.mempoolSize}, ${sample.feeRates} fee rates, targets ${sample.targets}`)
  return sample
}

// ------------------------------------------------------------------- zmq

/** `run`, again after 1 s for up to 15 s while the node is unreachable, as during a restart. */
async function retrying(run) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= 15 || error?.name !== 'RpcTransportError') throw error
      await sleep(1_000)
    }
  }
}

async function zmqSoak(rpc, record, { zmqUrl, durationMs, intervalMs, during }) {
  const subscriber = new zmqLib.QbitZmqSubscriber({ url: zmqUrl, topics: TOPICS })
  const counts = Object.fromEntries(TOPICS.map(topic => [topic, 0]))
  const result = {
    gaps: 0,
    missed: 0,
    hashblockMissed: 0,
    hashblockUnsizedGaps: 0,
    malformed: {},
    reconnects: { disconnected: 0, failed: 0 },
    maxRawBlock: 0,
    sequence: {},
  }
  const announced = new Set()
  const checks = { confirmed: 0, unknown: 0, tipAtOnce: 0 }
  const health = {}
  // The walk at the end covers only the blocks the subscriber could have been told of: from the tip
  // once the first message shows it connected, to the tip just before it closes.
  let startTip
  let startHeight
  let endTip
  const pending = []
  const timer = setTimeout(async () => {
    endTip = await rpc.getBestBlockHash().catch(() => undefined)
    // A notification of that tip still on its way gets a moment to arrive.
    await sleep(2_000)
    subscriber.close()
  }, durationMs)
  const healthTimer = setInterval(() => {
    const status = subscriber.health().status
    health[status] = (health[status] ?? 0) + 1
  }, intervalMs)
  const background = during?.().catch(error => record.fail(`while soaking: ${error.message}`))
  try {
    for await (const event of subscriber) {
      if (event.kind === 'message') {
        const { message } = event
        if (startTip === undefined) {
          startTip = await retrying(() => rpc.getBestBlockHash())
          startHeight = (await retrying(() => rpc.getBlockHeader(startTip))).height
        }
        counts[message.topic]++
        if (message.topic === 'rawblock') result.maxRawBlock = Math.max(result.maxRawBlock, message.bytes.length)
        if (message.topic === 'sequence') result.sequence[message.event] = (result.sequence[message.event] ?? 0) + 1
        if (message.topic === 'hashblock') {
          announced.add(message.hash)
          pending.push(
            retrying(() => Promise.all([rpc.getBlockHeader(message.hash), rpc.getBestBlockHash()])).then(
              ([, best]) => {
                checks.confirmed++
                if (best === message.hash) checks.tipAtOnce++
              },
              error => {
                checks.unknown++
                record.callError('getblockheader (hashblock)', error)
              }
            )
          )
        }
      } else if (event.kind === 'gap') {
        result.gaps++
        result.missed += event.missed ?? 0
        if (event.topic === 'hashblock') {
          if (event.missed === undefined) result.hashblockUnsizedGaps++
          else result.hashblockMissed += event.missed
        }
      } else if (event.kind === 'malformed') {
        result.malformed[event.error.code] = (result.malformed[event.error.code] ?? 0) + 1
      } else if (event.kind === 'reconnect') {
        result.reconnects[event.reason]++
        // Before any hashblock there is no baseline, so the reconnect marks no hashblock gap: count it as
        // one of unknown size, since blocks found while it was down were never announced.
        if (startTip !== undefined && announced.size === 0) result.hashblockUnsizedGaps++
      }
    }
  } catch (error) {
    record.fail(`the subscriber ended with ${error?.name}: ${error?.message}`)
  } finally {
    clearTimeout(timer)
    clearInterval(healthTimer)
  }
  await Promise.all(pending)
  await background
  // Every block on the active chain since the start, against the hashblocks.
  let unannounced = 0
  let walked = 0
  const lastTip = startTip === undefined ? undefined : (endTip ?? (await rpc.getBestBlockHash()))
  for (let hash = lastTip; hash !== undefined && hash !== startTip; walked++) {
    const header = await rpc.getBlockHeader(hash)
    if (header.height <= startHeight || header.previousBlockHash === undefined) break
    if (!announced.has(hash)) unannounced++
    hash = header.previousBlockHash
  }
  const malformed = Object.values(result.malformed).reduce((a, b) => a + b, 0)
  const messages = Object.values(counts).reduce((a, b) => a + b, 0)
  for (const failure of soakFailures({
    messages,
    malformed,
    unknown: checks.unknown,
    unannounced,
    hashblockMissed: result.hashblockMissed,
    hashblockUnsizedGaps: result.hashblockUnsizedGaps,
    counts,
    blocksSeen: announced.size,
  }))
    record.fail(
      malformed > 0 && failure.endsWith('malformed ZMQ messages')
        ? `${failure}: ${JSON.stringify(result.malformed)}`
        : failure
    )
  record.data.zmq = { counts, ...result, checks, blocksSinceStart: walked, unannounced, health }
  record.sections.push({
    title: 'ZMQ soak',
    text: `${durationMs / 1000} s on every topic. Each \`hashblock\` is looked up with \`getblockheader\`; at the end, every block since the start is walked back from the tip and matched against the \`hashblock\`s received. Health is sampled every ${intervalMs / 1000} s.`,
    rows: [
      {
        ...counts,
        gaps: result.gaps,
        'messages missed': result.missed,
        malformed,
        'reconnects (disconnected/failed)': `${result.reconnects.disconnected}/${result.reconnects.failed}`,
        'largest rawblock (bytes)': result.maxRawBlock,
        'hashblocks found over RPC': checks.confirmed,
        'new blocks': walked,
        'blocks without hashblock': unannounced,
        health: Object.entries(health)
          .map(([k, v]) => `${k} ${v}`)
          .join(', '),
      },
    ],
  })
  return record.data.zmq
}

// ------------------------------------------------------------------ send

/**
 * Wait, up to `timeoutMs`, until the wallet signs: after qbitd starts, it
 * validates a wallet's plaintext PQC keys in the background, and refuses to
 * sign until that ends (`getwalletinfo`'s `pqc_key_validation.signing_blocked`).
 */
async function untilSigning(rpc, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { pqcKeyValidation } = await rpc.getWalletInfo()
    if (!pqcKeyValidation.signingBlocked) return
    if (Date.now() > deadline) {
      throw new Error(
        `the wallet still blocks signing after ${timeoutMs / 1000} s: PQC key validation ${pqcKeyValidation.status}`
      )
    }
    await sleep(500)
  }
}

/** Fund, sign and finalize a payment of `bits` to a new address of the wallet. */
async function buildSelfPayment(rpc, bits, label) {
  const address = await rpc.getNewAddress({ label })
  const funded = await rpc.walletCreateFundedPsbt({ outputs: [{ address, amountBits: bits }] })
  if (funded.feeBits > MAX_FEE_BITS) {
    throw new Error(`the fee would be ${formatBits(funded.feeBits)} QBT, above the cap of ${formatBits(MAX_FEE_BITS)}`)
  }
  const processed = await rpc.walletProcessPsbt(funded.psbt)
  const finalized = await rpc.finalizePsbt(processed.psbt)
  if (!finalized.complete || finalized.hex === undefined) throw new Error('the wallet could not sign every input')
  const [accept] = await rpc.testMempoolAccept([finalized.hex])
  if (accept.allowed !== true) throw new Error(`testmempoolaccept refused it: ${accept.rejectReason}`)
  return { address, hex: finalized.hex, txid: accept.txid, feeBits: funded.feeBits, processed }
}

async function selfSend(rpc, record, { sendBits, confirmations, reportPath }) {
  const info = await rpc.getWalletInfo()
  if (info.unlockedUntil === 0) {
    throw new Error('the wallet is locked: unlock it for the run with qbit-cli walletpassphrase, outside this script')
  }
  await untilSigning(rpc)
  const balances = await rpc.getBalances()
  if (balances.mine.trustedBits < sendBits + MAX_FEE_BITS) {
    throw new Error(
      `the wallet has ${formatBits(balances.mine.trustedBits)} QBT trusted, below the amount and the fee cap`
    )
  }
  const payment = await buildSelfPayment(rpc, sendBits, 'qbit-rpc network verification')
  // Written down before it is broadcast, so a lost reply can be reconciled by its txid.
  // The file goes once the report, which names the txid, is written.
  const pendingPath = `${reportPath}.pending-txid`
  mkdirSync(dirname(pendingPath), { recursive: true })
  writeFileSync(pendingPath, `${payment.txid}\n`)
  record.data.pendingTxid = payment.txid
  log(
    `broadcasting ${payment.txid}: ${formatBits(sendBits)} QBT to ${payment.address}, fee ${formatBits(payment.feeBits)} QBT`
  )
  let outcome = 'sent'
  try {
    await rpc.sendRawTransaction(payment.hex)
  } catch (error) {
    if (!RpcUnknownOutcomeError.is(error)) throw error
    outcome = `unknown outcome (${error.cause?.name})`
    await sleep(2_000)
  }
  // The node's "not found" is an answer; anything else (the node unreachable) leaves it unknown.
  let lookupFailed = false
  const lookUp = (method, run) =>
    retrying(run).catch(error => {
      if (RpcError.is(error)) return undefined
      lookupFailed = true
      record.callError(method, error)
      return undefined
    })
  const entry = await lookUp('getmempoolentry', () => rpc.getMempoolEntry(payment.txid))
  const walletTx = await lookUp('gettransaction', () => rpc.getTransaction(payment.txid))
  const found = entry !== undefined || walletTx !== undefined
  if (outcome !== 'sent') outcome += found ? ', found by its txid' : lookupFailed ? ', not looked up' : ', not found'
  if (!found) {
    record.fail(
      lookupFailed
        ? `${payment.txid} could not be looked up after sending: reconcile it by its txid`
        : `${payment.txid} is neither in the mempool nor in the wallet after sending`
    )
  }
  let confirmed = walletTx?.confirmations ?? 0
  const waitUntil = Date.now() + 2 * 3_600_000
  while (confirmed < confirmations && Date.now() < waitUntil) {
    const waited = await rpc.waitForNewBlock(600_000).then(
      () => true,
      error => (record.callError('waitfornewblock', error), false)
    )
    // Without the long poll, look again a minute later rather than at once.
    if (!waited) await sleep(60_000)
    // A lookup that fails ends the wait; the send was found, and the report keeps it.
    const now = await retrying(() => rpc.getTransaction(payment.txid)).catch(error => {
      record.callError('gettransaction (confirmations)', error)
      return undefined
    })
    if (now === undefined) break
    confirmed = now.confirmations
  }
  if (confirmed < confirmations)
    record.fail(`${payment.txid} has ${confirmed} confirmations after 2 h, not ${confirmations}`)
  const pqc = payment.processed.pqcOverallLimitState ?? 'not reported'
  record.data.send = {
    found,
    txid: payment.txid,
    amount: formatBits(sendBits),
    fee: formatBits(payment.feeBits),
    outcome,
    inMempool: entry !== undefined,
    confirmations: confirmed,
    pqcOverallLimitState: pqc,
    warnings: payment.processed.warnings ?? [],
  }
  record.sections.push({
    title: 'Self-send',
    text: 'Funded with `walletcreatefundedpsbt`, signed with `walletprocesspsbt`, finalized, preflighted with `testmempoolaccept`, broadcast with `sendrawtransaction` to a new address of the same wallet, and looked up by its txid.',
    rows: [
      {
        txid: payment.txid,
        amount: formatBits(sendBits),
        fee: formatBits(payment.feeBits),
        outcome,
        'in mempool': entry !== undefined,
        confirmations: confirmed,
        'PQC state': pqc,
      },
    ],
  })
  return payment.txid
}

// ------------------------------------------------- a throwaway regtest node

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })

async function startRegtestNode(binDir) {
  const qbitd = join(binDir, 'qbitd')
  const version = execFileSync(qbitd, ['-version'], { encoding: 'utf8' }).split('\n')[0]
  if (!version.includes(` v${QBIT_CORE_VERSION}`)) {
    throw new Error(`QBIT_BIN_DIR holds '${version}', not qbit Core v${QBIT_CORE_VERSION}`)
  }
  const datadir = mkdtempSync(join(tmpdir(), 'qbit-rpc-verify-network-'))
  const rpcPort = await freePort()
  const zmqPort = await freePort()
  const command = [
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
    ...TOPICS.map(topic => `-zmqpub${topic}=tcp://127.0.0.1:${zmqPort}`),
  ]
  const cliArgs = ['-regtest', `-datadir=${datadir}`, `-rpcport=${rpcPort}`]
  const cli = (...args) => execFileSync(join(binDir, 'qbit-cli'), [...cliArgs, ...args], { encoding: 'utf8' }).trim()
  const pidFile = join(datadir, 'regtest', 'qbitd.pid')
  const readPid = () => Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
  const start = () => {
    execFileSync(qbitd, command, { stdio: 'ignore' })
    cli('-rpcwait', '-rpcwaittimeout=60', 'getblockcount')
  }
  const waitGone = async pid => {
    for (let i = 0; i < 600 && ownsDatadir(pid, datadir); i++) await sleep(100)
    if (ownsDatadir(pid, datadir)) throw new Error(`qbitd ${pid} did not exit`)
  }
  // Stops this data directory's qbitd, by its pid, killing it after 60 s, and
  // removes the directory: on exit, on a failed start, and on Ctrl-C or SIGTERM.
  const signals = { SIGINT: 130, SIGTERM: 143 }
  const onSignal = signal => {
    log(`${signal}: stopping the regtest node`)
    try {
      remove()
    } finally {
      process.exit(signals[signal])
    }
  }
  const remove = () => {
    for (const signal of Object.keys(signals)) process.off(signal, onSignal)
    stopNode({
      datadir,
      pidFile,
      stop: () => spawnSync(join(binDir, 'qbit-cli'), [...cliArgs, 'stop'], { timeout: 30_000 }),
    })
  }
  for (const signal of Object.keys(signals)) process.on(signal, onSignal)
  try {
    start()
  } catch (error) {
    remove()
    throw error
  }
  log(`regtest node on 127.0.0.1:${rpcPort} (ZMQ ${zmqPort}), data in ${datadir}`)
  return {
    url: `http://127.0.0.1:${rpcPort}/`,
    cookieFile: join(datadir, 'regtest', '.cookie'),
    zmqUrl: `tcp://127.0.0.1:${zmqPort}`,
    version,
    cli,
    start,
    async stop() {
      const pid = readPid()
      cli('stop')
      await waitGone(pid)
    },
    /** SIGKILL, only a qbitd of this data directory: as if the host lost power. */
    async kill() {
      const pid = readPid()
      if (!ownsDatadir(pid, datadir)) throw new Error(`pid ${pid} is not this node's qbitd`)
      process.kill(pid, 'SIGKILL')
      await waitGone(pid)
    },
    remove,
  }
}

/**
 * An HTTP proxy on 127.0.0.1 in front of qbitd, as a gateway or load balancer
 * would be. `rule(method)` picks what happens to a request by its JSON-RPC
 * method: forward it (`pass`), answer a status without forwarding
 * (`{ status }`), forward it and answer a status instead of the reply
 * (`{ status, afterForward: true }`), forward it and hold the reply
 * (`{ delayMs }`), or forward it, then run `onForwarded` and reset the
 * client's connection (`{ reset: true }`).
 */
async function startProxy(targetPort, rule) {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      let method = 'batch'
      try {
        method = JSON.parse(body.toString('utf8')).method ?? 'batch'
      } catch {}
      const action = rule(method)
      if (action.status && !action.afterForward) {
        res.writeHead(action.status, { 'content-type': 'text/plain' }).end('gateway error\n')
        return
      }
      const upstream = httpRequest(
        { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers },
        reply => {
          const replyChunks = []
          reply.on('data', chunk => replyChunks.push(chunk))
          reply.on('end', async () => {
            if (action.status) {
              res.writeHead(action.status, { 'content-type': 'text/plain' }).end('gateway timeout\n')
              return
            }
            if (action.reset) {
              // Thrown here it would be an unhandled rejection, ending the run before its cleanup.
              try {
                await action.onForwarded?.()
              } catch (error) {
                log(`after forwarding: ${error?.message ?? error}`)
              }
              req.socket.destroy()
              return
            }
            if (action.delayMs) await sleep(action.delayMs)
            if (res.destroyed) return
            res.writeHead(reply.statusCode, reply.headers).end(Buffer.concat(replyChunks))
          })
        }
      )
      upstream.on('error', () => req.socket.destroy())
      upstream.end(body)
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }
}

// ----------------------------------------------------------------- faults

async function faults(node, record) {
  const rows = []
  const scenario = async (name, expected, run) => {
    log(`fault: ${name}`)
    let observed
    let ok = false
    try {
      ;({ observed, ok } = await run())
    } catch (error) {
      observed = `${error?.name}: ${error?.message}`
    }
    rows.push({ fault: name, expected, observed, result: ok ? 'as expected' : 'FAIL' })
    if (!ok) record.fail(`fault "${name}": expected ${expected}; observed ${observed}`)
    node.cli('generatetoaddress', '1', node.miningAddress)
  }
  const cfg = { url: node.url, auth: { cookieFile: node.cookieFile }, expectedChain: 'regtest', wallet: 'verify' }
  const capabilities = ['wallet-read', 'wallet-write', 'broadcast']
  const direct = clientFor(cfg, { capabilities, readRetries: 0 })
  await direct.confirmChain()
  await untilSigning(direct)
  const known = async txid =>
    (await direct
      .getMempoolEntry(txid)
      .then(() => 'mempool')
      .catch(() => undefined)) ??
    (await direct
      .getRawTransaction(txid)
      .then(() => 'chain')
      .catch(() => undefined))
  const describe = error =>
    `${error?.name}${error?.reason ? ` ${error.reason}` : ''}${error?.status ? ` ${error.status}` : ''}${error?.code ? ` ${error.code}` : ''}`
  let rule = () => ({})
  const proxy = await startProxy(Number(new URL(node.url).port), method => rule(method))
  const proxied = clientFor({ ...cfg, url: proxy.url }, { capabilities, readRetries: 0 })
  await proxied.confirmChain()
  try {
    await scenario(
      'a node of another chain',
      'confirmChain() and the broadcast refused with RpcChainGuardError, nothing sent',
      async () => {
        const wrong = clientFor({ ...cfg, expectedChain: 'main' }, { capabilities, readRetries: 0 })
        const confirm = await wrong.confirmChain().then(() => 'confirmed', describe)
        const payment = await buildSelfPayment(direct, 10_000n, 'fault')
        const send = await wrong.sendRawTransaction(payment.hex).then(() => 'sent', describe)
        const where = await known(payment.txid)
        return {
          observed: `confirmChain: ${confirm} (${wrong.chainStatus}); send: ${send}; the transaction is ${where ?? 'unknown to the node'}`,
          ok: confirm.startsWith('RpcChainGuardError') && send.startsWith('RpcChainGuardError') && where === undefined,
        }
      }
    )

    await scenario('a gateway answering 502 to a read', 'RpcTransportError http_status 502', async () => {
      rule = method => (method === 'getblockcount' ? { status: 502 } : {})
      const observed = await proxied.getBlockCount().then(() => 'answered', describe)
      return { observed, ok: observed === 'RpcTransportError http_status 502' }
    })

    await scenario(
      'a gateway answering 504 after forwarding sendrawtransaction',
      'RpcUnknownOutcomeError with the txid; reconciled: in the mempool',
      async () => {
        const payment = await buildSelfPayment(direct, 10_000n, 'fault')
        rule = method => (method === 'sendrawtransaction' ? { status: 504, afterForward: true } : {})
        const error = await proxied.sendRawTransaction(payment.hex).then(
          () => undefined,
          e => e
        )
        const where = await known(payment.txid)
        return {
          observed: `${describe(error)} (cause ${describe(error?.cause)}), txid ${error?.txid === payment.txid ? 'matches' : 'differs'}; the transaction is in the ${where}`,
          ok:
            RpcUnknownOutcomeError.is(error) &&
            error.cause?.status === 504 &&
            error.txid === payment.txid &&
            where === 'mempool',
        }
      }
    )

    await scenario(
      'a gateway answering 502 without forwarding sendrawtransaction',
      'RpcUnknownOutcomeError; reconciled: unknown to the node, sent again by the same hex',
      async () => {
        const payment = await buildSelfPayment(direct, 10_000n, 'fault')
        rule = method => (method === 'sendrawtransaction' ? { status: 502 } : {})
        const error = await proxied.sendRawTransaction(payment.hex).then(
          () => undefined,
          e => e
        )
        const before = await known(payment.txid)
        const again = before === undefined ? await direct.sendRawTransaction(payment.hex) : undefined
        return {
          observed: `${describe(error)}; the node ${before === undefined ? 'did not have it, and took the same hex again' : `had it in the ${before}`}`,
          ok:
            RpcUnknownOutcomeError.is(error) &&
            error.txid === payment.txid &&
            before === undefined &&
            again === payment.txid,
        }
      }
    )

    await scenario('an abort during a read', 'RpcAbortedError', async () => {
      rule = () => ({})
      const observed = await direct
        .waitForNewBlock(30_000, {}, { signal: AbortSignal.timeout(500) })
        .then(() => 'answered', describe)
      return { observed, ok: observed === 'RpcAbortedError' }
    })

    await scenario(
      'an abort after sendrawtransaction was forwarded',
      'RpcUnknownOutcomeError (cause RpcAbortedError) with the txid; reconciled: in the mempool',
      async () => {
        const payment = await buildSelfPayment(direct, 10_000n, 'fault')
        rule = method => (method === 'sendrawtransaction' ? { delayMs: 3_000 } : {})
        const error = await proxied
          .sendRawTransaction(payment.hex, undefined, { signal: AbortSignal.timeout(1_000) })
          .then(
            () => undefined,
            e => e
          )
        await sleep(2_500)
        const where = await known(payment.txid)
        return {
          observed: `${describe(error)} (cause ${describe(error?.cause)}); the transaction is in the ${where}`,
          ok:
            RpcUnknownOutcomeError.is(error) &&
            error.cause?.name === 'RpcAbortedError' &&
            error.txid === payment.txid &&
            where === 'mempool',
        }
      }
    )

    await scenario(
      'qbitd killed (SIGKILL) just after accepting sendrawtransaction',
      'RpcUnknownOutcomeError with the txid; after a restart, reconciled by the txid, sent again if lost',
      async () => {
        // A SIGKILL loses what qbitd has not flushed, the last blocks included,
        // and with them this payment's inputs. gettxoutsetinfo flushes the
        // chain state first, so this tests the client's reconciliation, not
        // qbitd's crash recovery.
        node.cli('gettxoutsetinfo', 'none')
        const payment = await buildSelfPayment(direct, 10_000n, 'fault')
        rule = method => (method === 'sendrawtransaction' ? { reset: true, onForwarded: () => node.kill() } : {})
        const error = await proxied.sendRawTransaction(payment.hex).then(
          () => undefined,
          e => e
        )
        rule = () => ({})
        node.start()
        await direct.confirmChain()
        await sleep(1_000)
        const after = await known(payment.txid)
        const again = after === undefined ? await direct.sendRawTransaction(payment.hex) : undefined
        return {
          observed: `${describe(error)} (cause ${describe(error?.cause)}); after the restart the node ${after === undefined ? 'had lost it, and took the same hex again' : `had it in the ${after}`}`,
          ok:
            RpcUnknownOutcomeError.is(error) &&
            error.txid === payment.txid &&
            (after !== undefined || again === payment.txid),
        }
      }
    )

    await scenario(
      'a qbitd restart, which rotates the cookie',
      'a read fails while it is down; afterwards the same client reads, re-checks the chain and broadcasts',
      async () => {
        const cookieHash = () => createHash('sha256').update(readFileSync(node.cookieFile)).digest('hex')
        const before = cookieHash()
        await node.stop()
        const down = await direct.getBlockCount().then(() => 'answered', describe)
        node.start()
        const rotated = cookieHash() !== before
        const height = await direct.getBlockCount()
        await untilSigning(direct)
        const payment = await buildSelfPayment(direct, 10_000n, 'fault')
        const txid = await direct.sendRawTransaction(payment.hex)
        return {
          observed: `while down: ${down}; cookie ${rotated ? 'rotated' : 'unchanged'}; then height ${height}, chain ${direct.chainStatus}, broadcast ${txid === payment.txid ? 'accepted' : 'differs'}`,
          ok: down.startsWith('RpcTransportError') && rotated && txid === payment.txid,
        }
      }
    )
  } finally {
    proxy.close()
    direct.close()
    proxied.close()
  }
  record.sections.push({
    title: 'Fault injection (regtest)',
    text: 'Each against a throwaway regtest node on 127.0.0.1, through an HTTP proxy in front of qbitd where a gateway is simulated. A block is mined after each.',
    rows,
  })
  record.data.faults = rows
}

// ------------------------------------------------------------------- main

function gitDescription() {
  try {
    const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
    return `${head}${dirty ? ' with uncommitted changes' : ''}`
  } catch {
    return 'unknown'
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const own = MODES[options.mode].ownNode
  const binDir = own ? process.env.QBIT_BIN_DIR : undefined
  if (own && !binDir) throw new TypeError(`the ${options.mode} mode starts its own regtest node: set QBIT_BIN_DIR`)
  const env = own ? undefined : readNodeEnv(process.env, options.mode)
  const chain = own ? 'regtest' : env.expectedChain
  const sendAmount = options.mode === 'regtest' ? (options.sendAmount ?? '0.0001') : options.sendAmount
  const policy = sendPolicy({ mode: options.mode, chain, sendAmount }, parseQbt)
  const startedAt = new Date()
  const reportPath = resolve(repoRoot, options.report ?? defaultReportPath(startedAt, chain, options.mode))
  // Never overwrite an earlier run's report, or the txid of a send it may not have finished.
  for (const path of [reportPath, `${reportPath}.pending-txid`]) {
    if (existsSync(path)) {
      throw new TypeError(
        `${relative(repoRoot, path)} exists: reconcile and keep it, and pass --report <path> to write this run elsewhere`
      )
    }
  }
  // Claimed atomically before anything is sent, so two runs never share a report or its pending txid.
  const claim = `${reportPath}.lock`
  mkdirSync(dirname(reportPath), { recursive: true })
  try {
    closeSync(openSync(claim, 'wx'))
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    throw new TypeError(
      `${relative(repoRoot, claim)} exists: another run writes that report. Pass --report <path>, or remove the file once no run is left`
    )
  }
  const record = new Record()
  if (!own) record.hide(env.url, env.zmqUrl, hostOf(env.url), hostOf(env.zmqUrl))
  const manifest = name => JSON.parse(readFileSync(join(repoRoot, 'packages', name, 'package.json'), 'utf8'))
  const summary = {
    date: utcDate(startedAt),
    mode: options.mode,
    'qbit-rpc commit': gitDescription(),
    '@qbit-oss/rpc': manifest('rpc').version,
    '@qbit-oss/zmq': manifest('zmq').version,
    'Node.js': process.version,
    capabilities: policy.capabilities.join(', ') || 'none (reads only)',
  }

  let node
  try {
    if (own) {
      node = await startRegtestNode(binDir)
      // Loaded on startup, so it is there again after each restart.
      node.cli('-named', 'createwallet', 'wallet_name=verify', 'descriptors=true', 'load_on_startup=true')
      node.miningAddress = node.cli('-rpcwallet=verify', 'getnewaddress', '', 'p2mr')
      // qbit Core matures coinbase outputs after 1,000 blocks: 20 to spend.
      node.cli('generatetoaddress', '1020', node.miningAddress)
    }
    const target = own
      ? {
          url: node.url,
          auth: { cookieFile: node.cookieFile },
          expectedChain: 'regtest',
          zmqUrl: node.zmqUrl,
          wallet: 'verify',
        }
      : env
    const reader = clientFor({ ...target, wallet: undefined })
    Object.assign(summary, await describeNode(reader, record, target))

    if (options.mode === 'read') await readSweep(reader, record, options)
    // On its own regtest node one sample is enough: nothing changes between samples.
    if (options.mode === 'regtest') await readSweep(reader, record, { ...options, durationMs: 0 })
    if (options.mode === 'send' || options.mode === 'regtest') {
      const sender = clientFor(target, { capabilities: policy.capabilities })
      await sender.confirmChain()
      await selfSend(sender, record, { sendBits: policy.sendBits, confirmations: options.confirmations, reportPath })
    }
    if (options.mode === 'zmq' || options.mode === 'regtest') {
      // On regtest: a block every few seconds, and one restart a third of the way in.
      const during = own
        ? async () => {
            const end = Date.now() + options.durationMs - 5_000
            let restarted = false
            while (Date.now() < end) {
              await sleep(3_000)
              if (!restarted && Date.now() > end - (options.durationMs * 2) / 3) {
                await node.stop()
                node.start()
                restarted = true
                record.data.zmqRestart = new Date().toISOString()
              }
              node.cli('generatetoaddress', '1', node.miningAddress)
            }
          }
        : undefined
      const zmq = await zmqSoak(reader, record, {
        zmqUrl: target.zmqUrl,
        durationMs: options.durationMs,
        intervalMs: options.intervalMs,
        during,
      })
      if (own && (zmq.reconnects.disconnected + zmq.reconnects.failed === 0 || zmq.gaps === 0)) {
        record.fail('the restart during the ZMQ soak produced no reconnect or no gap')
      }
    }
    if (options.mode === 'faults' || options.mode === 'regtest') await faults(node, record)
  } catch (error) {
    record.fail(`the run stopped: ${error?.name}: ${error?.message}`)
  } finally {
    if (own && node) {
      try {
        node.remove()
      } catch (error) {
        record.fail(`stopping the regtest node: ${error.message}`)
      }
    }
  }

  // The pending txid stays until a report shows the send finished and was looked up.
  if (record.data.pendingTxid !== undefined && record.data.send?.found !== true) {
    record.fail(
      `the send of ${record.data.pendingTxid} did not finish, or its transaction was not found: reconcile it by its txid; the .pending-txid file beside this report is kept`
    )
  }
  summary.duration = `${Math.round((Date.now() - startedAt.getTime()) / 1000)} s`
  if (record.errors.size > 0) {
    record.sections.push({
      title: 'Call errors',
      text: 'One row per method, error and path; `value` is the raw reply at the path, from `call()`.',
      rows: [...record.errors.values()],
    })
  }
  const report = {
    mode: options.mode,
    chain,
    passed: record.failures.length === 0,
    summary,
    sections: record.sections,
    failures: record.failures,
    record: { options: { ...options, sendAmount }, summary, ...record.data },
  }
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, renderReport(report))
  // Only once the transaction was found by its txid: until then the file is the only record of it.
  if (record.data.send?.found === true) rmSync(`${reportPath}.pending-txid`, { force: true })
  rmSync(claim, { force: true })
  log(`report: ${reportPath}`)
  log(report.passed ? 'PASS' : `FAIL: ${record.failures.length} failures`)
  return report.passed ? 0 : 1
}

main().then(
  code => process.exit(code),
  error => {
    console.error(`verify-network: ${error?.message ?? error}`)
    process.exit(2)
  }
)
