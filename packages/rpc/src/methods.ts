import { assertBits, BITS_PER_QBT, formatBitsPerVbyte, formatQbt } from './amount'
import { QBIT_CHAINS, type QbitChain } from './capabilities'
import { rawDecimal } from './json'
import { rawTransactionTxid } from './raw-tx'
import {
  amount,
  anyInteger,
  array,
  base64,
  bitsInteger,
  boolean,
  compact,
  field,
  finite,
  hash,
  hex,
  int32,
  integer,
  nonNegativeInteger,
  nullValue,
  object,
  oneOf,
  optional,
  ResultIssue,
  signedAmount,
  string,
  uint32,
  warnings,
  type JsonObject,
} from './validate'

/**
 * One JSON-RPC call: the method, its positional parameters, and the parser
 * that validates and converts its result. Build one with a function from
 * {@link requests}; pass it to `QbitRpcClient.batch`, or let a typed client
 * method build and send it.
 */
export interface RpcRequest<T> {
  readonly method: string
  readonly params: readonly unknown[]
  /** Validates the raw result (numbers as `JsonNumber`) and converts it. Throws on a malformed result. */
  readonly parse: (result: unknown) => T
  /** For `sendrawtransaction`: the txid computed from the hex, when it parses. */
  readonly txid?: string
}

function request<T>(
  method: string,
  params: readonly unknown[],
  parse: (result: unknown) => T,
  txid?: string
): RpcRequest<T> {
  // Trailing omitted arguments are dropped; omitted ones in between become
  // null, which qbit Core reads as "use the default".
  const trimmed = [...params]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop()
  const positional = trimmed.map(value => (value === undefined ? null : value))
  return Object.freeze(
    txid === undefined ? { method, params: positional, parse } : { method, params: positional, parse, txid }
  )
}

// ---------------------------------------------------------------------------
// Argument checks. They throw TypeError or RangeError before any request.
// ---------------------------------------------------------------------------

function argInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

function argFinite(value: unknown, name: string, min: number, max: number, minExclusive = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value > max ||
    (minExclusive ? value <= min : value < min)
  ) {
    throw new RangeError(
      `${name} must be a finite number ${minExclusive ? 'above' : 'from'} ${min}${max === Infinity ? '' : ` to ${max}`}`
    )
  }
  return value
}

function argString(value: unknown, name: string, { nonEmpty = false } = {}): string {
  if (typeof value !== 'string' || (nonEmpty && value === '')) {
    throw new TypeError(`${name} must be a ${nonEmpty ? 'non-empty ' : ''}string`)
  }
  return value
}

function argBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

function argHash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value))
    throw new TypeError(`${name} must be 64 hex characters`)
  return value.toLowerCase()
}

function argHex(value: unknown, name: string, bytes?: number): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(value) ||
    (bytes !== undefined && value.length !== bytes * 2)
  ) {
    throw new TypeError(
      `${name} must be ${bytes === undefined ? 'non-empty hex of whole bytes' : `${bytes * 2} hex characters`}`
    )
  }
  return value
}

function argBase64(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new TypeError(`${name} must be non-empty padded base64`)
  }
  return value
}

function argOneOf<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new RangeError(`${name} must be one of ${values.join(', ')}`)
  }
  return value as T
}

function argOptions(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}

function opt<T>(value: unknown, check: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : check(value)
}

/** An outgoing amount as an exact decimal JSON number. */
function qbtParam(bits: unknown, name: string): unknown {
  return rawDecimal(formatQbt(assertBits(bits, name)))
}

/** qbit Core refuses `maxfeerate` values of 1 QBT/kvB or more. */
function maxFeeRateParam(value: unknown, name: string): unknown {
  const bits = assertBits(value, name)
  if (bits >= BITS_PER_QBT) throw new RangeError(`${name} must be below 100000000 bits/kvB (1 QBT/kvB)`)
  return rawDecimal(formatQbt(bits))
}

const R = 'result'

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

/** `getblockchaininfo`. Field names are camelCase; amounts and fee rates are bits. */
export interface BlockchainInfo {
  readonly chain: QbitChain
  readonly blocks: number
  readonly headers: number
  readonly bestBlockHash: string
  /** Compact target, 8 hex characters. */
  readonly bits: string
  readonly target: string
  readonly difficulty: number
  readonly time: number
  readonly medianTime: number
  /** Estimated verification progress, 0 to 1. */
  readonly verificationProgress: number
  readonly initialBlockDownload: boolean
  readonly chainwork: string
  readonly sizeOnDisk: number
  readonly pruned: boolean
  readonly pruneHeight?: number
  readonly automaticPruning?: boolean
  readonly pruneTargetSize?: number
  readonly signetChallenge?: string
  readonly p2mrValidationWeight: {
    readonly legacyPerSigop: number
    readonly v2PerSigop: number
    readonly activationHeight: number
    readonly activeForTip: boolean
    readonly activeForNextBlock: boolean
    readonly blocksRemaining: number
  }
  readonly futureBlockTime: {
    readonly legacyLimitSeconds: number
    readonly v2LimitSeconds: number
    readonly activationHeight: number
    readonly activeForTip: boolean
    readonly activeForNextBlock: boolean
    readonly tipLimitSeconds: number
    readonly nextBlockLimitSeconds: number
    readonly blocksRemaining: number
    readonly nextBlockMinTime: number
    readonly nextBlockMaxTime: number
    /** Negative when no valid timestamp is currently available for the next block. */
    readonly nextBlockTimeHeadroomSeconds: number
  }
  /** Node warnings; a single string under `-deprecatedrpc=warnings` becomes a one-element array. */
  readonly warnings: readonly string[]
}

function parseBlockchainInfo(value: unknown): BlockchainInfo {
  const o = object(value, R)
  const weight = field(o, 'p2mr_validation_weight', R, object)
  const wp = `${R}.p2mr_validation_weight`
  const future = field(o, 'future_block_time', R, object)
  const fp = `${R}.future_block_time`
  return compact<BlockchainInfo>({
    chain: field(o, 'chain', R, oneOf(QBIT_CHAINS)),
    blocks: field(o, 'blocks', R, nonNegativeInteger),
    headers: field(o, 'headers', R, nonNegativeInteger),
    bestBlockHash: field(o, 'bestblockhash', R, hash),
    bits: field(o, 'bits', R, hex(4)),
    target: field(o, 'target', R, hex(32)),
    difficulty: field(o, 'difficulty', R, finite(0)),
    time: field(o, 'time', R, nonNegativeInteger),
    medianTime: field(o, 'mediantime', R, nonNegativeInteger),
    verificationProgress: field(o, 'verificationprogress', R, finite(0, 1)),
    initialBlockDownload: field(o, 'initialblockdownload', R, boolean),
    chainwork: field(o, 'chainwork', R, hex(32)),
    sizeOnDisk: field(o, 'size_on_disk', R, nonNegativeInteger),
    pruned: field(o, 'pruned', R, boolean),
    pruneHeight: optional(o, 'pruneheight', R, nonNegativeInteger),
    automaticPruning: optional(o, 'automatic_pruning', R, boolean),
    pruneTargetSize: optional(o, 'prune_target_size', R, nonNegativeInteger),
    signetChallenge: optional(o, 'signet_challenge', R, hex()),
    p2mrValidationWeight: {
      legacyPerSigop: field(weight, 'legacy_per_sigop', wp, nonNegativeInteger),
      v2PerSigop: field(weight, 'v2_per_sigop', wp, nonNegativeInteger),
      activationHeight: field(weight, 'activation_height', wp, int32),
      activeForTip: field(weight, 'active_for_tip', wp, boolean),
      activeForNextBlock: field(weight, 'active_for_next_block', wp, boolean),
      blocksRemaining: field(weight, 'blocks_remaining', wp, nonNegativeInteger),
    },
    futureBlockTime: {
      legacyLimitSeconds: field(future, 'legacy_limit_seconds', fp, nonNegativeInteger),
      v2LimitSeconds: field(future, 'v2_limit_seconds', fp, nonNegativeInteger),
      activationHeight: field(future, 'activation_height', fp, int32),
      activeForTip: field(future, 'active_for_tip', fp, boolean),
      activeForNextBlock: field(future, 'active_for_next_block', fp, boolean),
      tipLimitSeconds: field(future, 'tip_limit_seconds', fp, nonNegativeInteger),
      nextBlockLimitSeconds: field(future, 'next_block_limit_seconds', fp, nonNegativeInteger),
      blocksRemaining: field(future, 'blocks_remaining', fp, nonNegativeInteger),
      nextBlockMinTime: field(future, 'next_block_min_time', fp, anyInteger),
      nextBlockMaxTime: field(future, 'next_block_max_time', fp, anyInteger),
      nextBlockTimeHeadroomSeconds: field(future, 'next_block_time_headroom_seconds', fp, anyInteger),
    },
    warnings: field(o, 'warnings', R, warnings),
  })
}

/** `getnetworkinfo`. Fields qbit Core only reports with networking or a mempool running are optional. */
export interface NetworkInfo {
  readonly version: number
  readonly subversion: string
  readonly protocolVersion: number
  /** Service flags, 16 hex characters. */
  readonly localServices?: string
  /** For example `NETWORK`, `WITNESS`, `NODE_ARCHIVE`, `NODE_WITNESS_PRUNED`. */
  readonly localServicesNames?: readonly string[]
  readonly localRelay?: boolean
  readonly timeOffset?: number
  readonly networkActive?: boolean
  readonly connections?: number
  readonly connectionsIn?: number
  readonly connectionsOut?: number
  readonly networks: readonly {
    readonly name: string
    readonly limited: boolean
    readonly reachable: boolean
    readonly proxy: string
    readonly proxyRandomizeCredentials: boolean
  }[]
  /** Minimum relay fee rate in bits per 1,000 vbytes. */
  readonly relayFeeBitsPerKvB?: bigint
  readonly incrementalFeeBitsPerKvB?: bigint
  readonly localAddresses: readonly { readonly address: string; readonly port: number; readonly score: number }[]
  readonly warnings: readonly string[]
}

function parseNetworkInfo(value: unknown): NetworkInfo {
  const o = object(value, R)
  return compact<NetworkInfo>({
    version: field(o, 'version', R, nonNegativeInteger),
    subversion: field(o, 'subversion', R, string),
    protocolVersion: field(o, 'protocolversion', R, nonNegativeInteger),
    localServices: optional(o, 'localservices', R, hex(8)),
    localServicesNames: optional(o, 'localservicesnames', R, (v, p) => array(v, p, string)),
    localRelay: optional(o, 'localrelay', R, boolean),
    timeOffset: optional(o, 'timeoffset', R, anyInteger),
    networkActive: optional(o, 'networkactive', R, boolean),
    connections: optional(o, 'connections', R, nonNegativeInteger),
    connectionsIn: optional(o, 'connections_in', R, nonNegativeInteger),
    connectionsOut: optional(o, 'connections_out', R, nonNegativeInteger),
    networks: field(o, 'networks', R, (v, p) =>
      array(v, p, (entry, ep) => {
        const n = object(entry, ep)
        return {
          name: field(n, 'name', ep, string),
          limited: field(n, 'limited', ep, boolean),
          reachable: field(n, 'reachable', ep, boolean),
          proxy: field(n, 'proxy', ep, string),
          proxyRandomizeCredentials: field(n, 'proxy_randomize_credentials', ep, boolean),
        }
      })
    ),
    relayFeeBitsPerKvB: optional(o, 'relayfee', R, amount),
    incrementalFeeBitsPerKvB: optional(o, 'incrementalfee', R, amount),
    localAddresses: field(o, 'localaddresses', R, (v, p) =>
      array(v, p, (entry, ep) => {
        const a = object(entry, ep)
        return {
          address: field(a, 'address', ep, string),
          port: field(a, 'port', ep, integer(0, 65535)),
          score: field(a, 'score', ep, anyInteger),
        }
      })
    ),
    warnings: field(o, 'warnings', R, warnings),
  })
}

/** `getblockheader` with `verbose=true`. */
export interface BlockHeader {
  readonly hash: string
  /** -1 when the block is not on the active chain. */
  readonly confirmations: number
  readonly height: number
  readonly version: number
  /** `version` as 8 hex characters. */
  readonly versionHex: string
  readonly merkleRoot: string
  readonly time: number
  readonly medianTime: number
  readonly nonce: number
  readonly bits: string
  readonly target: string
  readonly difficulty: number
  readonly chainwork: string
  readonly nTx: number
  /** Absent only for the genesis block. */
  readonly previousBlockHash?: string
  readonly nextBlockHash?: string
}

function parseBlockHeader(requestedHash: string): (value: unknown) => BlockHeader {
  return value => {
    const o = object(value, R)
    const header = compact<BlockHeader>({
      hash: field(o, 'hash', R, hash),
      confirmations: field(o, 'confirmations', R, integer(-1, Number.MAX_SAFE_INTEGER)),
      height: field(o, 'height', R, nonNegativeInteger),
      version: field(o, 'version', R, int32),
      versionHex: field(o, 'versionHex', R, hex(4)),
      merkleRoot: field(o, 'merkleroot', R, hash),
      time: field(o, 'time', R, uint32),
      medianTime: field(o, 'mediantime', R, nonNegativeInteger),
      nonce: field(o, 'nonce', R, uint32),
      bits: field(o, 'bits', R, hex(4)),
      target: field(o, 'target', R, hex(32)),
      difficulty: field(o, 'difficulty', R, finite(0)),
      chainwork: field(o, 'chainwork', R, hex(32)),
      nTx: field(o, 'nTx', R, nonNegativeInteger),
      previousBlockHash: optional(o, 'previousblockhash', R, hash),
      nextBlockHash: optional(o, 'nextblockhash', R, hash),
    })
    if (header.hash !== requestedHash) throw new ResultIssue(`${R}.hash`, 'the requested block hash')
    if ((header.version >>> 0).toString(16).padStart(8, '0') !== header.versionHex) {
      throw new ResultIssue(`${R}.versionHex`, 'the hex form of version')
    }
    if ((header.height === 0) !== (header.previousBlockHash === undefined)) {
      throw new ResultIssue(`${R}.previousblockhash`, 'a previous block hash exactly when height is above 0')
    }
    return header
  }
}

/** A decoded transaction, as `getrawtransaction` with verbosity 1 returns it. */
export interface DecodedTransaction {
  readonly txid: string
  /** The witness txid (wtxid). */
  readonly hash: string
  readonly version: number
  readonly size: number
  readonly vsize: number
  readonly weight: number
  readonly locktime: number
  readonly vin: readonly TransactionInput[]
  readonly vout: readonly TransactionOutput[]
  readonly hex: string
  readonly blockHash?: string
  readonly confirmations?: number
  readonly blockTime?: number
  readonly time?: number
  /** Only present when a block hash was passed. */
  readonly inActiveChain?: boolean
}

export type TransactionInput =
  | {
      readonly coinbase: string
      readonly txinwitness?: readonly string[]
      readonly sequence: number
    }
  | {
      readonly txid: string
      readonly vout: number
      readonly scriptSig: { readonly asm: string; readonly hex: string }
      readonly txinwitness?: readonly string[]
      readonly sequence: number
    }

export interface TransactionOutput {
  readonly valueBits: bigint
  readonly n: number
  readonly scriptPubKey: ScriptPubKey
}

/** A decoded output script, as `getrawtransaction` and `gettxout` report it. */
export interface ScriptPubKey {
  readonly asm: string
  readonly desc: string
  readonly hex: string
  readonly address?: string
  /** Output type, for example `witness_v2_p2mr` or `nulldata`. */
  readonly type: string
}

function parseInput(value: unknown, path: string): TransactionInput {
  const i = object(value, path)
  const txinwitness = optional(i, 'txinwitness', path, (v, p) => array(v, p, hex()))
  const sequence = field(i, 'sequence', path, uint32)
  if (Object.hasOwn(i, 'coinbase')) {
    return compact<TransactionInput>({ coinbase: field(i, 'coinbase', path, hex()), txinwitness, sequence })
  }
  const sig = field(i, 'scriptSig', path, object)
  return compact<TransactionInput>({
    txid: field(i, 'txid', path, hash),
    vout: field(i, 'vout', path, uint32),
    scriptSig: {
      asm: field(sig, 'asm', `${path}.scriptSig`, string),
      hex: field(sig, 'hex', `${path}.scriptSig`, hex()),
    },
    txinwitness,
    sequence,
  })
}

function parseScriptPubKey(value: unknown, path: string): ScriptPubKey {
  const spk = object(value, path)
  return compact<ScriptPubKey>({
    asm: field(spk, 'asm', path, string),
    desc: field(spk, 'desc', path, string),
    hex: field(spk, 'hex', path, hex()),
    address: optional(spk, 'address', path, string),
    type: field(spk, 'type', path, string),
  })
}

function parseOutput(value: unknown, path: string): TransactionOutput {
  const out = object(value, path)
  return {
    valueBits: field(out, 'value', path, amount),
    n: field(out, 'n', path, uint32),
    scriptPubKey: field(out, 'scriptPubKey', path, parseScriptPubKey),
  }
}

function parseDecodedTransaction(requestedTxid: string): (value: unknown) => DecodedTransaction {
  return value => {
    const o = object(value, R)
    const tx = compact<DecodedTransaction>({
      txid: field(o, 'txid', R, hash),
      hash: field(o, 'hash', R, hash),
      version: field(o, 'version', R, uint32),
      size: field(o, 'size', R, nonNegativeInteger),
      vsize: field(o, 'vsize', R, nonNegativeInteger),
      weight: field(o, 'weight', R, nonNegativeInteger),
      locktime: field(o, 'locktime', R, uint32),
      vin: field(o, 'vin', R, (v, p) => array(v, p, parseInput)),
      vout: field(o, 'vout', R, (v, p) => array(v, p, parseOutput)),
      hex: field(o, 'hex', R, hex()),
      blockHash: optional(o, 'blockhash', R, hash),
      confirmations: optional(o, 'confirmations', R, nonNegativeInteger),
      blockTime: optional(o, 'blocktime', R, nonNegativeInteger),
      time: optional(o, 'time', R, nonNegativeInteger),
      inActiveChain: optional(o, 'in_active_chain', R, boolean),
    })
    if (tx.txid !== requestedTxid) throw new ResultIssue(`${R}.txid`, 'the requested txid')
    tx.vout.forEach((output, index) => {
      if (output.n !== index) throw new ResultIssue(`${R}.vout[${index}].n`, `${index}`)
    })
    return tx
  }
}

/** `getmempoolentry`. Sizes are in vbytes; qbit Core does not discount witness data. */
export interface MempoolEntry {
  readonly vsize: number
  readonly weight: number
  /** Unix time the transaction entered this node's mempool. */
  readonly time: number
  /** The block height when it entered. */
  readonly height: number
  /** In-mempool descendants and ancestors, this transaction included. */
  readonly descendantCount: number
  readonly descendantSize: number
  readonly ancestorCount: number
  readonly ancestorSize: number
  readonly wtxid: string
  readonly fees: {
    readonly baseBits: bigint
    /** These three include `prioritisetransaction` deltas, so they can be negative. */
    readonly modifiedBits: bigint
    readonly ancestorBits: bigint
    readonly descendantBits: bigint
  }
  /** txids of the mempool transactions this one spends. */
  readonly depends: readonly string[]
  /** txids of the mempool transactions spending its outputs. */
  readonly spentBy: readonly string[]
  /** Deprecated by qbit Core, which still reports it in v1.0.0. */
  readonly bip125Replaceable?: boolean
  /** True until a peer has acknowledged the initial broadcast. */
  readonly unbroadcast: boolean
}

function parseMempoolEntry(value: unknown): MempoolEntry {
  const o = object(value, R)
  const f = field(o, 'fees', R, object)
  const fp = `${R}.fees`
  const count = integer(1, Number.MAX_SAFE_INTEGER)
  const txids = (v: unknown, p: string): string[] => array(v, p, hash)
  return compact<MempoolEntry>({
    vsize: field(o, 'vsize', R, nonNegativeInteger),
    weight: field(o, 'weight', R, nonNegativeInteger),
    time: field(o, 'time', R, nonNegativeInteger),
    height: field(o, 'height', R, nonNegativeInteger),
    descendantCount: field(o, 'descendantcount', R, count),
    descendantSize: field(o, 'descendantsize', R, nonNegativeInteger),
    ancestorCount: field(o, 'ancestorcount', R, count),
    ancestorSize: field(o, 'ancestorsize', R, nonNegativeInteger),
    wtxid: field(o, 'wtxid', R, hash),
    fees: {
      baseBits: field(f, 'base', fp, amount),
      modifiedBits: field(f, 'modified', fp, signedAmount),
      ancestorBits: field(f, 'ancestor', fp, signedAmount),
      descendantBits: field(f, 'descendant', fp, signedAmount),
    },
    depends: field(o, 'depends', R, txids),
    spentBy: field(o, 'spentby', R, txids),
    bip125Replaceable: optional(o, 'bip125-replaceable', R, boolean),
    unbroadcast: field(o, 'unbroadcast', R, boolean),
  })
}

/** `gettxout`: an unspent output. */
export interface TxOut {
  /** The tip the answer was computed at. */
  readonly bestBlock: string
  /** 0 for an output of a mempool transaction. */
  readonly confirmations: number
  readonly valueBits: bigint
  readonly scriptPubKey: ScriptPubKey
  readonly coinbase: boolean
}

function parseTxOut(value: unknown): TxOut | null {
  if (value === null) return null
  const o = object(value, R)
  const out: TxOut = {
    bestBlock: field(o, 'bestblock', R, hash),
    confirmations: field(o, 'confirmations', R, nonNegativeInteger),
    valueBits: field(o, 'value', R, amount),
    scriptPubKey: field(o, 'scriptPubKey', R, parseScriptPubKey),
    coinbase: field(o, 'coinbase', R, boolean),
  }
  // A coinbase transaction is never in the mempool.
  if (out.coinbase && out.confirmations === 0) {
    throw new ResultIssue(`${R}.confirmations`, 'at least 1 for a coinbase output')
  }
  return out
}

/** Security levels `getconfirmationtarget` models: 1, 3, 6 and 60 Bitcoin confirmations. */
export type SecurityLevel = 'low' | 'medium' | 'high' | 'maximum'
const SECURITY_LEVELS: readonly SecurityLevel[] = ['low', 'medium', 'high', 'maximum']

/**
 * `getconfirmationtarget`. The node's `value_qbt` echo is omitted: qbit Core
 * computes it as a floating-point number, so it can be inexact. The value you
 * passed is the exact one.
 */
export interface ConfirmationTarget {
  readonly requiredConfirmations: number
  readonly requiredMinutes: number
  readonly equivalentBtcConfirmations: number
  /** H/s, permissionless lane only. */
  readonly permissionlessHashrate: number
  /** H/s, AuxPoW lane only. */
  readonly auxpowHashrate: number
  readonly totalObservedHashrate: number
  readonly orphanRate: number
  readonly securityLevel: SecurityLevel
  readonly model: {
    readonly btcTargetConfirmations: number
    readonly blockTimeSeconds: number
    readonly hashrateSource: 'observed_chainwork' | 'override_merge_mining_pct' | 'fallback_merge_mining_pct'
    readonly hashrateWindowBlocks: number
    readonly permissionlessBlocksInWindow: number
    readonly auxpowBlocksInWindow: number
    readonly mergeMiningPct: number
    readonly btcHashrate: number
    readonly orphanRatePenalty: number
    readonly securityPerConfirmation: number
    readonly cadenceMergedFraction: number
  }
}

function parseConfirmationTarget(value: unknown): ConfirmationTarget {
  const o = object(value, R)
  const m = field(o, 'model', R, object)
  const mp = `${R}.model`
  const nonNegative = finite(0)
  return {
    requiredConfirmations: field(o, 'required_confirmations', R, nonNegativeInteger),
    requiredMinutes: field(o, 'required_minutes', R, nonNegative),
    equivalentBtcConfirmations: field(o, 'equivalent_btc_confirmations', R, nonNegative),
    permissionlessHashrate: field(o, 'permissionless_hashrate', R, nonNegative),
    auxpowHashrate: field(o, 'auxpow_hashrate', R, nonNegative),
    totalObservedHashrate: field(o, 'total_observed_hashrate', R, nonNegative),
    orphanRate: field(o, 'orphan_rate', R, finite(0, 1)),
    securityLevel: field(o, 'security_level', R, oneOf(SECURITY_LEVELS)),
    model: {
      btcTargetConfirmations: field(m, 'btc_target_confirmations', mp, nonNegativeInteger),
      blockTimeSeconds: field(m, 'block_time_seconds', mp, nonNegativeInteger),
      hashrateSource: field(
        m,
        'hashrate_source',
        mp,
        oneOf(['observed_chainwork', 'override_merge_mining_pct', 'fallback_merge_mining_pct'] as const)
      ),
      hashrateWindowBlocks: field(m, 'hashrate_window_blocks', mp, nonNegativeInteger),
      permissionlessBlocksInWindow: field(m, 'permissionless_blocks_in_window', mp, nonNegativeInteger),
      auxpowBlocksInWindow: field(m, 'auxpow_blocks_in_window', mp, nonNegativeInteger),
      mergeMiningPct: field(m, 'merge_mining_pct', mp, finite(0, 1)),
      btcHashrate: field(m, 'btc_hashrate', mp, nonNegative),
      orphanRatePenalty: field(m, 'orphan_rate_penalty', mp, nonNegative),
      securityPerConfirmation: field(m, 'security_per_confirmation', mp, nonNegative),
      cadenceMergedFraction: field(m, 'cadence_merged_fraction', mp, finite(0, 1)),
    },
  }
}

export type FeeEstimateMode = 'unset' | 'economical' | 'conservative'
const FEE_MODES: readonly FeeEstimateMode[] = ['unset', 'economical', 'conservative']

/** `estimatesmartfee`. `feeRateBitsPerKvB` is absent when the node could not estimate; see `errors`. */
export interface SmartFeeEstimate {
  readonly feeRateBitsPerKvB?: bigint
  readonly errors?: readonly string[]
  readonly blocks: number
}

function parseSmartFee(value: unknown): SmartFeeEstimate {
  const o = object(value, R)
  return compact<SmartFeeEstimate>({
    feeRateBitsPerKvB: optional(o, 'feerate', R, amount),
    errors: optional(o, 'errors', R, (v, p) => array(v, p, string)),
    blocks: field(o, 'blocks', R, nonNegativeInteger),
  })
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

/** `validateaddress`. A P2MR address reports `isWitness: true` and `witnessVersion: 2`. */
export type AddressValidation =
  | {
      readonly isValid: true
      readonly address: string
      readonly scriptPubKey: string
      readonly isScript?: boolean
      readonly isWitness?: boolean
      readonly witnessVersion?: number
      readonly witnessProgram?: string
    }
  | {
      readonly isValid: false
      readonly error: string
      readonly errorLocations: readonly number[]
    }

function parseAddressValidation(value: unknown): AddressValidation {
  const o = object(value, R)
  if (field(o, 'isvalid', R, boolean)) {
    return compact<AddressValidation>({
      isValid: true,
      address: field(o, 'address', R, string),
      scriptPubKey: field(o, 'scriptPubKey', R, hex()),
      isScript: optional(o, 'isscript', R, boolean),
      isWitness: optional(o, 'iswitness', R, boolean),
      witnessVersion: optional(o, 'witness_version', R, integer(0, 16)),
      witnessProgram: optional(o, 'witness_program', R, hex()),
    })
  }
  return {
    isValid: false,
    error: field(o, 'error', R, string),
    errorLocations: field(o, 'error_locations', R, (v, p) => array(v, p, nonNegativeInteger)),
  }
}

/** The proof `signdatapqchash` returns, as `verifydatapqchash` takes it. */
export interface DataPqcHashProof {
  readonly address: string
  /** The 32-byte hash that was signed. */
  readonly messageHash: string
  readonly signature: string
  /** The 32-byte P2MR public key. */
  readonly pubkey: string
  readonly leafScript: string
  readonly controlBlock: string
  readonly leafVersion: number
  /** The only mode qbit Core v1.0.0 supports. */
  readonly proofMode: 'p2mr-pubkey'
}

/** `verifydatapqchash`. When `valid` is false, `error` gives the reason. */
export interface DataPqcHashVerification {
  readonly valid: boolean
  readonly error?: string
  readonly address?: string
  readonly messageHash?: string
  readonly datasigHash?: string
  readonly pubkey?: string
  readonly proofMode?: string
  readonly p2mrMerkleRoot?: string
}

function parseDataPqcVerification(value: unknown): DataPqcHashVerification {
  const o = object(value, R)
  return compact<DataPqcHashVerification>({
    valid: field(o, 'valid', R, boolean),
    error: optional(o, 'error', R, string),
    address: optional(o, 'address', R, string),
    messageHash: optional(o, 'message_hash', R, hex(32)),
    datasigHash: optional(o, 'datasig_hash', R, hex(32)),
    pubkey: optional(o, 'pubkey', R, hex(32)),
    proofMode: optional(o, 'proof_mode', R, string),
    p2mrMerkleRoot: optional(o, 'p2mr_merkle_root', R, hex(32)),
  })
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/** qbit Core's `MAX_PACKAGE_COUNT`. */
const MAX_PACKAGE_COUNT = 25

/** One `testmempoolaccept` entry, in the order the transactions were passed. */
export interface MempoolAcceptance {
  readonly txid: string
  readonly wtxid: string
  readonly packageError?: string
  /** Absent when the transaction was not fully validated because another one in the package failed. */
  readonly allowed?: boolean
  readonly vsize?: number
  readonly fees?: {
    readonly baseBits: bigint
    readonly effectiveFeeRateBitsPerKvB: bigint
    /** wtxids of the transactions the effective fee rate includes. */
    readonly effectiveIncludes: readonly string[]
  }
  readonly rejectReason?: string
  readonly rejectDetails?: string
}

function parseMempoolAcceptance(rawTxs: readonly string[]): (value: unknown) => MempoolAcceptance[] {
  return value => {
    const entries = array(value, R, (entry, path): MempoolAcceptance => {
      const o = object(entry, path)
      return compact<MempoolAcceptance>({
        txid: field(o, 'txid', path, hash),
        wtxid: field(o, 'wtxid', path, hash),
        packageError: optional(o, 'package-error', path, string),
        allowed: optional(o, 'allowed', path, boolean),
        vsize: optional(o, 'vsize', path, nonNegativeInteger),
        fees: optional(o, 'fees', path, (v, fp) => {
          const f = object(v, fp)
          return {
            baseBits: field(f, 'base', fp, amount),
            effectiveFeeRateBitsPerKvB: field(f, 'effective-feerate', fp, amount),
            effectiveIncludes: field(f, 'effective-includes', fp, (w, wp) => array(w, wp, hash)),
          }
        }),
        rejectReason: optional(o, 'reject-reason', path, string),
        rejectDetails: optional(o, 'reject-details', path, string),
      })
    })
    if (entries.length !== rawTxs.length) throw new ResultIssue(R, `${rawTxs.length} entries, one per transaction`)
    entries.forEach((entry, index) => {
      const txid = rawTransactionTxid(rawTxs[index]!)
      if (txid !== undefined && entry.txid !== txid) {
        throw new ResultIssue(`${R}[${index}].txid`, 'the txid of the transaction passed at that position')
      }
    })
    return entries
  }
}

// ---------------------------------------------------------------------------
// PQC signature budgets
// ---------------------------------------------------------------------------

export type PqcLimitState = 'normal' | 'warning' | 'critical' | 'exhausted'
const PQC_LIMIT_STATES: readonly PqcLimitState[] = ['normal', 'warning', 'critical', 'exhausted']

/** Signature-budget state of one local PQC key that took part in a response. */
export interface PqcKeyState {
  readonly pubkey: string
  readonly pqcSignatureCount: number
  readonly pqcSignatureLimit: number
  readonly pqcSignaturesRemaining: number
  readonly pqcLimitState: PqcLimitState
}

/**
 * The PQC usage fields qbit Core adds to a response that involves local PQC
 * keys: the keys that signed (`walletprocesspsbt`) or an address's keys
 * (`getaddressinfo`). `pqcKeyStates` lists every key; the four single-key
 * fields are only present when exactly one key is involved. Treat `critical`
 * and `exhausted` as operational events.
 */
export interface PqcUsage {
  readonly pqcKeyStates?: readonly PqcKeyState[]
  readonly pqcOverallLimitState?: PqcLimitState
  readonly pqcSignatureCount?: number
  readonly pqcSignatureLimit?: number
  readonly pqcSignaturesRemaining?: number
  readonly pqcLimitState?: PqcLimitState
}

/** The PQC usage fields of a result object; absent ones stay undefined, for `compact`. */
function pqcUsage(o: JsonObject): { [K in keyof PqcUsage]: PqcUsage[K] | undefined } {
  const limitState = oneOf(PQC_LIMIT_STATES)
  return {
    pqcKeyStates: optional(o, 'pqc_key_states', R, (v, p) =>
      array(v, p, (entry, ep) => {
        const k = object(entry, ep)
        return {
          pubkey: field(k, 'pubkey', ep, hex(32)),
          pqcSignatureCount: field(k, 'pqc_signature_count', ep, uint32),
          pqcSignatureLimit: field(k, 'pqc_signature_limit', ep, uint32),
          pqcSignaturesRemaining: field(k, 'pqc_signatures_remaining', ep, uint32),
          pqcLimitState: field(k, 'pqc_limit_state', ep, limitState),
        }
      })
    ),
    pqcOverallLimitState: optional(o, 'pqc_overall_limit_state', R, limitState),
    pqcSignatureCount: optional(o, 'pqc_signature_count', R, uint32),
    pqcSignatureLimit: optional(o, 'pqc_signature_limit', R, uint32),
    pqcSignaturesRemaining: optional(o, 'pqc_signatures_remaining', R, uint32),
    pqcLimitState: optional(o, 'pqc_limit_state', R, limitState),
  }
}

// ---------------------------------------------------------------------------
// Wallet read
// ---------------------------------------------------------------------------

/** `getwalletinfo`. qbit Core v1.0.0 reports no per-key PQC signature counts here; see `walletProcessPsbt`. */
export interface WalletInfo {
  readonly walletName: string
  readonly walletVersion: number
  readonly format: string
  readonly txCount: number
  readonly keypoolSize: number
  readonly keypoolSizeHdInternal?: number
  /** Unix time until which the wallet is unlocked, 0 when locked; absent for unencrypted wallets. */
  readonly unlockedUntil?: number
  readonly payTxFeeBitsPerKvB: bigint
  readonly privateKeysEnabled: boolean
  readonly avoidReuse: boolean
  /** False when no rescan is running. */
  readonly scanning: false | { readonly duration: number; readonly progress: number }
  readonly descriptors: boolean
  /** Validation state of plaintext PQC key records. */
  readonly pqcKeyValidation: {
    readonly status: 'not_required' | 'pending' | 'running' | 'complete' | 'failed'
    readonly progress: number
    readonly plaintextRecords: number
    readonly pendingRecords: number
    readonly validatedRecords: number
    readonly failedRecords: number
    readonly signingBlocked: boolean
    readonly encryptionRecommended: boolean
  }
  readonly externalSigner: boolean
  readonly blank: boolean
  readonly birthtime?: number
  readonly flags: readonly string[]
  readonly lastProcessedBlock: LastProcessedBlock
}

export interface LastProcessedBlock {
  readonly hash: string
  readonly height: number
}

function parseLastProcessedBlock(value: unknown, path: string): LastProcessedBlock {
  const o = object(value, path)
  return { hash: field(o, 'hash', path, hash), height: field(o, 'height', path, nonNegativeInteger) }
}

function parseWalletInfo(value: unknown): WalletInfo {
  const o = object(value, R)
  const v = field(o, 'pqc_key_validation', R, object)
  const vp = `${R}.pqc_key_validation`
  return compact<WalletInfo>({
    walletName: field(o, 'walletname', R, string),
    walletVersion: field(o, 'walletversion', R, nonNegativeInteger),
    format: field(o, 'format', R, string),
    txCount: field(o, 'txcount', R, nonNegativeInteger),
    keypoolSize: field(o, 'keypoolsize', R, nonNegativeInteger),
    keypoolSizeHdInternal: optional(o, 'keypoolsize_hd_internal', R, nonNegativeInteger),
    unlockedUntil: optional(o, 'unlocked_until', R, nonNegativeInteger),
    payTxFeeBitsPerKvB: field(o, 'paytxfee', R, amount),
    privateKeysEnabled: field(o, 'private_keys_enabled', R, boolean),
    avoidReuse: field(o, 'avoid_reuse', R, boolean),
    scanning: field(o, 'scanning', R, (s, sp) => {
      if (s === false) return false as const
      const scan = object(s, sp)
      return {
        duration: field(scan, 'duration', sp, nonNegativeInteger),
        progress: field(scan, 'progress', sp, finite(0, 1)),
      }
    }),
    descriptors: field(o, 'descriptors', R, boolean),
    pqcKeyValidation: {
      status: field(v, 'status', vp, oneOf(['not_required', 'pending', 'running', 'complete', 'failed'] as const)),
      progress: field(v, 'progress', vp, finite(0, 1)),
      plaintextRecords: field(v, 'plaintext_records', vp, nonNegativeInteger),
      pendingRecords: field(v, 'pending_records', vp, nonNegativeInteger),
      validatedRecords: field(v, 'validated_records', vp, nonNegativeInteger),
      failedRecords: field(v, 'failed_records', vp, nonNegativeInteger),
      signingBlocked: field(v, 'signing_blocked', vp, boolean),
      encryptionRecommended: field(v, 'encryption_recommended', vp, boolean),
    },
    externalSigner: field(o, 'external_signer', R, boolean),
    blank: field(o, 'blank', R, boolean),
    birthtime: optional(o, 'birthtime', R, nonNegativeInteger),
    flags: field(o, 'flags', R, (f, fp) => array(f, fp, string)),
    lastProcessedBlock: field(o, 'lastprocessedblock', R, parseLastProcessedBlock),
  })
}

export type WalletTxCategory = 'send' | 'receive' | 'generate' | 'immature' | 'orphan'
const WALLET_TX_CATEGORIES: readonly WalletTxCategory[] = ['send', 'receive', 'generate', 'immature', 'orphan']

/** `gettransaction`. Amounts are signed bits: sends and fees are negative. */
export interface WalletTransaction {
  readonly amountBits: bigint
  readonly feeBits?: bigint
  /** Negative when the transaction conflicted that many blocks ago. */
  readonly confirmations: number
  readonly generated?: boolean
  readonly trusted?: boolean
  readonly blockHash?: string
  readonly blockHeight?: number
  readonly blockIndex?: number
  readonly blockTime?: number
  readonly txid: string
  readonly wtxid: string
  readonly walletConflicts: readonly string[]
  readonly replacedByTxid?: string
  readonly replacesTxid?: string
  readonly mempoolConflicts: readonly string[]
  readonly to?: string
  readonly time: number
  readonly timeReceived: number
  readonly comment?: string
  readonly bip125Replaceable: 'yes' | 'no' | 'unknown'
  readonly parentDescs?: readonly string[]
  readonly details: readonly {
    readonly address?: string
    readonly category: WalletTxCategory
    readonly amountBits: bigint
    readonly label?: string
    readonly vout: number
    readonly feeBits?: bigint
    readonly abandoned: boolean
    readonly parentDescs?: readonly string[]
  }[]
  readonly hex: string
  readonly lastProcessedBlock: LastProcessedBlock
}

const strings = (v: unknown, p: string): string[] => array(v, p, string)

function parseWalletTransaction(requestedTxid: string): (value: unknown) => WalletTransaction {
  return value => {
    const o = object(value, R)
    const tx = compact<WalletTransaction>({
      amountBits: field(o, 'amount', R, signedAmount),
      feeBits: optional(o, 'fee', R, signedAmount),
      confirmations: field(o, 'confirmations', R, anyInteger),
      generated: optional(o, 'generated', R, boolean),
      trusted: optional(o, 'trusted', R, boolean),
      blockHash: optional(o, 'blockhash', R, hash),
      blockHeight: optional(o, 'blockheight', R, nonNegativeInteger),
      blockIndex: optional(o, 'blockindex', R, nonNegativeInteger),
      blockTime: optional(o, 'blocktime', R, nonNegativeInteger),
      txid: field(o, 'txid', R, hash),
      wtxid: field(o, 'wtxid', R, hash),
      walletConflicts: field(o, 'walletconflicts', R, (v, p) => array(v, p, hash)),
      replacedByTxid: optional(o, 'replaced_by_txid', R, hash),
      replacesTxid: optional(o, 'replaces_txid', R, hash),
      mempoolConflicts: field(o, 'mempoolconflicts', R, (v, p) => array(v, p, hash)),
      to: optional(o, 'to', R, string),
      time: field(o, 'time', R, nonNegativeInteger),
      timeReceived: field(o, 'timereceived', R, nonNegativeInteger),
      comment: optional(o, 'comment', R, string),
      bip125Replaceable: field(o, 'bip125-replaceable', R, oneOf(['yes', 'no', 'unknown'] as const)),
      parentDescs: optional(o, 'parent_descs', R, strings),
      details: field(o, 'details', R, (v, p) =>
        array(v, p, (entry, ep) => {
          const d = object(entry, ep)
          return compact<WalletTransaction['details'][number]>({
            address: optional(d, 'address', ep, string),
            category: field(d, 'category', ep, oneOf(WALLET_TX_CATEGORIES)),
            amountBits: field(d, 'amount', ep, signedAmount),
            label: optional(d, 'label', ep, string),
            vout: field(d, 'vout', ep, uint32),
            feeBits: optional(d, 'fee', ep, signedAmount),
            abandoned: field(d, 'abandoned', ep, boolean),
            parentDescs: optional(d, 'parent_descs', ep, strings),
          })
        })
      ),
      hex: field(o, 'hex', R, hex()),
      lastProcessedBlock: field(o, 'lastprocessedblock', R, parseLastProcessedBlock),
    })
    if (tx.txid !== requestedTxid) throw new ResultIssue(`${R}.txid`, 'the requested txid')
    return tx
  }
}

/** One `listunspent` entry. */
export interface UnspentOutput {
  readonly txid: string
  readonly vout: number
  readonly address?: string
  readonly label?: string
  readonly scriptPubKey: string
  readonly amountBits: bigint
  readonly confirmations: number
  readonly ancestorCount?: number
  readonly ancestorSize?: number
  /** qbit Core prints this field in bits, not QBT. */
  readonly ancestorFeesBits?: bigint
  readonly redeemScript?: string
  readonly witnessScript?: string
  readonly spendable: boolean
  readonly solvable: boolean
  readonly reused?: boolean
  readonly desc?: string
  readonly parentDescs: readonly string[]
  readonly safe: boolean
}

function parseUnspent(value: unknown, path: string): UnspentOutput {
  const o = object(value, path)
  return compact<UnspentOutput>({
    txid: field(o, 'txid', path, hash),
    vout: field(o, 'vout', path, uint32),
    address: optional(o, 'address', path, string),
    label: optional(o, 'label', path, string),
    scriptPubKey: field(o, 'scriptPubKey', path, hex()),
    amountBits: field(o, 'amount', path, amount),
    confirmations: field(o, 'confirmations', path, nonNegativeInteger),
    ancestorCount: optional(o, 'ancestorcount', path, nonNegativeInteger),
    ancestorSize: optional(o, 'ancestorsize', path, nonNegativeInteger),
    ancestorFeesBits: optional(o, 'ancestorfees', path, bitsInteger),
    redeemScript: optional(o, 'redeemScript', path, hex()),
    witnessScript: optional(o, 'witnessScript', path, hex()),
    spendable: field(o, 'spendable', path, boolean),
    solvable: field(o, 'solvable', path, boolean),
    reused: optional(o, 'reused', path, boolean),
    desc: optional(o, 'desc', path, string),
    parentDescs: field(o, 'parent_descs', path, strings),
    safe: field(o, 'safe', path, boolean),
  })
}

export interface ListUnspentOptions {
  /** Default 1. */
  readonly minConf?: number
  /** Default 9,999,999. */
  readonly maxConf?: number
  readonly addresses?: readonly string[]
  /** Default true. */
  readonly includeUnsafe?: boolean
  readonly minimumAmountBits?: bigint
  readonly maximumAmountBits?: bigint
  readonly maximumCount?: number
  readonly minimumSumAmountBits?: bigint
  readonly includeImmatureCoinbase?: boolean
}

/**
 * `getaddressinfo`. For an address of this wallet, `desc` is present and the
 * PQC fields report the signature budgets of its keys.
 */
export interface AddressInfo extends PqcUsage {
  /** As the node encodes it: a bech32 address in lowercase. */
  readonly address: string
  readonly scriptPubKey: string
  readonly isMine: boolean
  /** Whether the wallet knows how to spend coins sent here, ignoring a lack of private keys. */
  readonly solvable: boolean
  readonly desc?: string
  readonly parentDesc?: string
  readonly isScript?: boolean
  readonly isChange: boolean
  readonly isWitness: boolean
  readonly witnessVersion?: number
  readonly witnessProgram?: string
  readonly labels: readonly string[]
}

function parseAddressInfo(requestedAddress: string): (value: unknown) => AddressInfo {
  return value => {
    const o = object(value, R)
    const info = compact<AddressInfo>({
      address: field(o, 'address', R, string),
      scriptPubKey: field(o, 'scriptPubKey', R, hex()),
      isMine: field(o, 'ismine', R, boolean),
      solvable: field(o, 'solvable', R, boolean),
      desc: optional(o, 'desc', R, string),
      parentDesc: optional(o, 'parent_desc', R, string),
      isScript: optional(o, 'isscript', R, boolean),
      isChange: field(o, 'ischange', R, boolean),
      isWitness: field(o, 'iswitness', R, boolean),
      witnessVersion: optional(o, 'witness_version', R, integer(0, 16)),
      witnessProgram: optional(o, 'witness_program', R, hex()),
      labels: field(o, 'labels', R, strings),
      ...pqcUsage(o),
    })
    // The node lowercases a bech32 address it was given in uppercase.
    if (info.address.toLowerCase() !== requestedAddress.toLowerCase()) {
      throw new ResultIssue(`${R}.address`, 'the requested address')
    }
    return info
  }
}

/** A transaction output: its txid and output index. */
export interface Outpoint {
  readonly txid: string
  readonly vout: number
}

function parseOutpoint(value: unknown, path: string): Outpoint {
  const o = object(value, path)
  return { txid: field(o, 'txid', path, hash), vout: field(o, 'vout', path, uint32) }
}

/**
 * One `listsinceblock` or `listtransactions` entry: one output of a wallet
 * transaction, seen from one side. A payment to the wallet itself is a `send`
 * and a `receive` entry for the same `vout`. Amounts are signed bits.
 */
export interface WalletHistoryEntry {
  /** Absent for an output with no address, such as OP_RETURN. */
  readonly address?: string
  readonly category: WalletTxCategory
  /** At most 0 for `send` (0 for OP_RETURN); at least 0 for every other category. */
  readonly amountBits: bigint
  /** The address book label of `address`; `''` is the default label. Absent when the address has no entry. */
  readonly label?: string
  readonly vout: number
  /**
   * Only on `send` entries, and always on them. All outputs minus this wallet's
   * inputs, repeated on each of the transaction's `send` entries, so do not sum
   * it per entry. When every input is this wallet's, that is the fee, negative;
   * with inputs from other wallets it is not the fee, and it can be positive.
   */
  readonly feeBits?: bigint
  /**
   * The wallet abandoned the transaction (its inputs can be spent again), or its
   * coinbase was orphaned. At 0 confirmations, `listSinceBlock` lists it on
   * every call until it is mined after all (it confirms, `abandoned` false), a
   * conflict is mined (negative `confirmations`), or the orphaned block is
   * reconnected. An entry that stops being listed may have gone either way:
   * `getTransaction` tells which.
   */
  readonly abandoned: boolean
  /** Only on entries that receive: the descriptors of the output's script. Can be empty. */
  readonly parentDescs?: readonly string[]
  /** 0 when unconfirmed. Negative when the transaction conflicted that many blocks ago. */
  readonly confirmations: number
  /** True for a coinbase transaction. */
  readonly generated?: boolean
  /** Whether the wallet would spend from it. Present exactly when `confirmations` is 0 or negative. */
  readonly trusted?: boolean
  /** The block holding the transaction. This and the next three are present exactly when `confirmations` is above 0. */
  readonly blockHash?: string
  readonly blockHeight?: number
  /** The transaction's position in that block. */
  readonly blockIndex?: number
  /** That block's header time, Unix seconds, as the miner set it. */
  readonly blockTime?: number
  readonly txid: string
  readonly wtxid: string
  /** txids of wallet transactions spending the same inputs. */
  readonly walletConflicts: readonly string[]
  /** On a replaced transaction's entries. Its replacement is listed too, so do not count both. */
  readonly replacedByTxid?: string
  readonly replacesTxid?: string
  /** txids of mempool transactions that conflict with this one or an ancestor. */
  readonly mempoolConflicts: readonly string[]
  readonly to?: string
  /** The wallet's own time for the transaction, Unix seconds. Not a block time. */
  readonly time: number
  /** When this wallet first recorded the transaction, by the node's clock, Unix seconds. */
  readonly timeReceived: number
  readonly comment?: string
  readonly bip125Replaceable: 'yes' | 'no' | 'unknown'
}

function parseHistoryEntry(value: unknown, path: string): WalletHistoryEntry {
  const o = object(value, path)
  const entry = compact<WalletHistoryEntry>({
    address: optional(o, 'address', path, parseAddress),
    category: field(o, 'category', path, oneOf(WALLET_TX_CATEGORIES)),
    amountBits: field(o, 'amount', path, signedAmount),
    label: optional(o, 'label', path, string),
    vout: field(o, 'vout', path, uint32),
    feeBits: optional(o, 'fee', path, signedAmount),
    abandoned: field(o, 'abandoned', path, boolean),
    parentDescs: optional(o, 'parent_descs', path, strings),
    confirmations: field(o, 'confirmations', path, anyInteger),
    generated: optional(o, 'generated', path, boolean),
    trusted: optional(o, 'trusted', path, boolean),
    blockHash: optional(o, 'blockhash', path, hash),
    blockHeight: optional(o, 'blockheight', path, nonNegativeInteger),
    blockIndex: optional(o, 'blockindex', path, nonNegativeInteger),
    blockTime: optional(o, 'blocktime', path, nonNegativeInteger),
    txid: field(o, 'txid', path, hash),
    wtxid: field(o, 'wtxid', path, hash),
    walletConflicts: field(o, 'walletconflicts', path, (v, p) => array(v, p, hash)),
    replacedByTxid: optional(o, 'replaced_by_txid', path, hash),
    replacesTxid: optional(o, 'replaces_txid', path, hash),
    mempoolConflicts: field(o, 'mempoolconflicts', path, (v, p) => array(v, p, hash)),
    to: optional(o, 'to', path, string),
    time: field(o, 'time', path, nonNegativeInteger),
    timeReceived: field(o, 'timereceived', path, nonNegativeInteger),
    comment: optional(o, 'comment', path, string),
    bip125Replaceable: field(o, 'bip125-replaceable', path, oneOf(['yes', 'no', 'unknown'] as const)),
  })
  const isSend = entry.category === 'send'
  if (isSend ? entry.amountBits > 0n : entry.amountBits < 0n) {
    throw new ResultIssue(
      `${path}.amount`,
      isSend ? 'at most 0 for a send entry' : `at least 0 for a ${entry.category} entry`
    )
  }
  if (isSend !== (entry.feeBits !== undefined)) throw new ResultIssue(`${path}.fee`, 'a fee exactly on send entries')
  const placement = [entry.blockHash, entry.blockHeight, entry.blockIndex, entry.blockTime]
  const placed = placement.every(part => part !== undefined)
  if (!placed && placement.some(part => part !== undefined)) {
    throw new ResultIssue(`${path}.blockhash`, 'blockhash, blockheight, blockindex and blocktime together')
  }
  if (placed !== entry.confirmations > 0) {
    throw new ResultIssue(`${path}.confirmations`, 'above 0 exactly when the entry names its block')
  }
  if (placed === (entry.trusted !== undefined)) {
    throw new ResultIssue(`${path}.trusted`, 'present exactly when confirmations is 0 or negative')
  }
  return entry
}

const historyEntries = (v: unknown, p: string): WalletHistoryEntry[] => array(v, p, parseHistoryEntry)

/**
 * `listsinceblock`'s parameters. Its sixth, `label` (only incoming entries
 * paying to that label), is not typed here; it is reachable through `call()`.
 */
export interface ListSinceBlockOptions {
  /** List from the block after this one, or from the fork point when it left the active chain. Default: the whole history. */
  readonly blockHash?: string
  /** Which block `lastBlock` names, counted back from the tip (1 is the tip). It filters nothing. Default 1. */
  readonly targetConfirmations?: number
  /** qbit Core v1.0.0 accepts this and ignores it: a wallet's watch-only entries are always listed. */
  readonly includeWatchOnly?: boolean
  /** Whether to return `removed`. Default true. */
  readonly includeRemoved?: boolean
  /** Also list change outputs, each as a `send` and a `receive` entry. Default false. */
  readonly includeChange?: boolean
}

/** `listsinceblock`. */
export interface SinceBlockHistory {
  /**
   * Every entry of a later block and every entry at 0 confirmations, plus the
   * `send` entries of a transaction a later block conflicted. qbit Core leaves a
   * conflicted transaction's `receive` entries out: to undo a credit, use
   * `removed` and `getTransaction`, which reports negative `confirmations`.
   */
  readonly transactions: readonly WalletHistoryEntry[]
  /**
   * Entries of the blocks between `blockHash` and the fork point, when that
   * block left the active chain, as they are now: 0 `confirmations` back in the
   * mempool, positive with the new block when mined again, negative when a
   * conflict was mined instead. Absent only when `includeRemoved` was false.
   */
  readonly removed?: readonly WalletHistoryEntry[]
  /** Pass this as the next call's `blockHash`. */
  readonly lastBlock: string
}

function parseSinceBlock(includeRemoved: boolean | undefined): (value: unknown) => SinceBlockHistory {
  return value => {
    const o = object(value, R)
    const history = compact<SinceBlockHistory>({
      transactions: field(o, 'transactions', R, historyEntries),
      removed: optional(o, 'removed', R, historyEntries),
      lastBlock: field(o, 'lastblock', R, hash),
    })
    // A reply without the reorg list it was asked for must not read as "nothing removed".
    if ((history.removed !== undefined) !== (includeRemoved !== false)) {
      throw new ResultIssue(`${R}.removed`, includeRemoved === false ? 'no removed array' : 'a removed array')
    }
    return history
  }
}

export interface ListTransactionsOptions {
  /** Only incoming entries paying to addresses with this label. `*`, the default, lists everything. */
  readonly label?: string
  /** At most this many entries, the newest ones. Default 10. */
  readonly count?: number
  /** Skip this many of the newest entries first. Default 0. `count + skip` must be at most 2,147,483,647. */
  readonly skip?: number
  /** qbit Core v1.0.0 accepts this and ignores it: a wallet's watch-only entries are always listed. */
  readonly includeWatchOnly?: boolean
}

/**
 * `getbalances`, in bits. qbit Core v1.0.0 has no `watchonly` section: a wallet
 * without private keys reports what it watches under `mine`.
 */
export interface WalletBalances {
  readonly mine: {
    /** Confirmed outputs, and unconfirmed ones the wallet created. */
    readonly trustedBits: bigint
    /** Outputs others created that are still in the mempool. */
    readonly untrustedPendingBits: bigint
    readonly immatureBits: bigint
    /** Only for a wallet with `avoid_reuse` set, where 0n is a real zero. */
    readonly usedBits?: bigint
  }
  /** The block these balances were computed at. */
  readonly lastProcessedBlock: LastProcessedBlock
}

function parseBalances(value: unknown): WalletBalances {
  const o = object(value, R)
  const m = field(o, 'mine', R, object)
  const mp = `${R}.mine`
  return {
    mine: compact<WalletBalances['mine']>({
      trustedBits: field(m, 'trusted', mp, amount),
      untrustedPendingBits: field(m, 'untrusted_pending', mp, amount),
      immatureBits: field(m, 'immature', mp, amount),
      usedBits: optional(m, 'used', mp, amount),
    }),
    lastProcessedBlock: field(o, 'lastprocessedblock', R, parseLastProcessedBlock),
  }
}

// ---------------------------------------------------------------------------
// Wallet write
// ---------------------------------------------------------------------------

export type FundedPsbtOutput = { readonly address: string; readonly amountBits: bigint } | { readonly data: string }

export interface WalletCreateFundedPsbtArgs {
  /** Inputs to spend; leave out to let the wallet select coins. */
  readonly inputs?: readonly { readonly txid: string; readonly vout: number; readonly sequence?: number }[]
  /** At least one output. Each address once; at most one `data` (OP_RETURN) output. */
  readonly outputs: readonly FundedPsbtOutput[]
  readonly locktime?: number
  readonly options?: {
    readonly addInputs?: boolean
    readonly includeUnsafe?: boolean
    readonly minConf?: number
    readonly maxConf?: number
    readonly changeAddress?: string
    readonly changePosition?: number
    /** For example `p2mr`. */
    readonly changeType?: string
    /** Lock the selected coins in the wallet until they are spent or unlocked. */
    readonly lockUnspents?: boolean
    /** An explicit fee rate in bits per 1,000 vbytes (`250n` is 0.25 bits/vB). Exclusive with `confTarget`. */
    readonly feeRateBitsPerKvB?: bigint
    /** Output indexes, before change is added, that pay the fee. */
    readonly subtractFeeFromOutputs?: readonly number[]
    readonly maxTxWeight?: number
    readonly replaceable?: boolean
    readonly confTarget?: number
    readonly estimateMode?: FeeEstimateMode
  }
  readonly bip32derivs?: boolean
  readonly version?: number
}

/** `walletcreatefundedpsbt`. */
export interface FundedPsbt {
  readonly psbt: string
  readonly feeBits: bigint
  /** -1 when no change output was added. */
  readonly changePos: number
}

function parseFundedPsbt(value: unknown): FundedPsbt {
  const o = object(value, R)
  return {
    psbt: field(o, 'psbt', R, base64),
    feeBits: field(o, 'fee', R, amount),
    changePos: field(o, 'changepos', R, integer(-1, Number.MAX_SAFE_INTEGER)),
  }
}

/** `walletprocesspsbt`. */
export interface ProcessedPsbt extends PqcUsage {
  readonly psbt: string
  readonly complete: boolean
  /** The network transaction, when complete. */
  readonly hex?: string
  /** PQC threshold warnings, when the node emitted any. */
  readonly warnings?: readonly string[]
}

function parseProcessedPsbt(value: unknown): ProcessedPsbt {
  const o = object(value, R)
  return compact<ProcessedPsbt>({
    psbt: field(o, 'psbt', R, base64),
    complete: field(o, 'complete', R, boolean),
    hex: optional(o, 'hex', R, hex()),
    ...pqcUsage(o),
    warnings: optional(o, 'warnings', R, warnings),
  })
}

export type SighashType =
  'DEFAULT' | 'ALL' | 'NONE' | 'SINGLE' | 'ALL|ANYONECANPAY' | 'NONE|ANYONECANPAY' | 'SINGLE|ANYONECANPAY'
const SIGHASH_TYPES: readonly SighashType[] = [
  'DEFAULT',
  'ALL',
  'NONE',
  'SINGLE',
  'ALL|ANYONECANPAY',
  'NONE|ANYONECANPAY',
  'SINGLE|ANYONECANPAY',
]

/** `finalizepsbt`. With `extract` (the default) and a complete PSBT, `hex` replaces `psbt`. */
export interface FinalizedPsbt {
  readonly psbt?: string
  readonly hex?: string
  readonly complete: boolean
}

function parseFinalizedPsbt(value: unknown): FinalizedPsbt {
  const o = object(value, R)
  return compact<FinalizedPsbt>({
    psbt: optional(o, 'psbt', R, base64),
    hex: optional(o, 'hex', R, hex()),
    complete: field(o, 'complete', R, boolean),
  })
}

const parseNull = (value: unknown): null => nullValue(value, R)

/** An address the wallet returns: bech32 or base58 characters only. */
function parseAddress(value: unknown, path = R): string {
  if (typeof value !== 'string' || !/^[0-9A-Za-z]+$/.test(value)) throw new ResultIssue(path, 'an address')
  return value
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function fundedPsbtOptions(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const o = argOptions(value, 'options')
  if (o['feeRateBitsPerKvB'] !== undefined && (o['confTarget'] !== undefined || o['estimateMode'] !== undefined)) {
    throw new TypeError('options.feeRateBitsPerKvB excludes options.confTarget and options.estimateMode')
  }
  // Key names as qbit Core v1.0.0's walletcreatefundedpsbt reads them. Its
  // option type check also accepts some aliases it then ignores (for example
  // subtract_fee_from_outputs), so each name here was checked against a live
  // node: see test/regtest/smoke.test.ts.
  const out = compact<Record<string, unknown>>({
    add_inputs: opt(o['addInputs'], v => argBoolean(v, 'options.addInputs')),
    include_unsafe: opt(o['includeUnsafe'], v => argBoolean(v, 'options.includeUnsafe')),
    minconf: opt(o['minConf'], v => argInteger(v, 'options.minConf', 0, 0x7fff_ffff)),
    maxconf: opt(o['maxConf'], v => argInteger(v, 'options.maxConf', 0, 0x7fff_ffff)),
    change_address: opt(o['changeAddress'], v => argString(v, 'options.changeAddress', { nonEmpty: true })),
    change_position: opt(o['changePosition'], v => argInteger(v, 'options.changePosition', 0, 0x7fff_ffff)),
    change_type: opt(o['changeType'], v => argString(v, 'options.changeType', { nonEmpty: true })),
    lock_unspents: opt(o['lockUnspents'], v => argBoolean(v, 'options.lockUnspents')),
    fee_rate: opt(o['feeRateBitsPerKvB'], v =>
      rawDecimal(formatBitsPerVbyte(assertBits(v, 'options.feeRateBitsPerKvB')))
    ),
    subtractFeeFromOutputs: opt(o['subtractFeeFromOutputs'], v => {
      if (!Array.isArray(v)) throw new TypeError('options.subtractFeeFromOutputs must be an array')
      return v.map((index, i) => argInteger(index, `options.subtractFeeFromOutputs[${i}]`, 0, 0x7fff_ffff))
    }),
    max_tx_weight: opt(o['maxTxWeight'], v => argInteger(v, 'options.maxTxWeight', 1, 0x7fff_ffff)),
    replaceable: opt(o['replaceable'], v => argBoolean(v, 'options.replaceable')),
    conf_target: opt(o['confTarget'], v => argInteger(v, 'options.confTarget', 1, 1008)),
    estimate_mode: opt(o['estimateMode'], v => argOneOf(v, 'options.estimateMode', FEE_MODES)),
  })
  return out
}

/**
 * Request builders for every typed method. Each validates its arguments
 * (throwing `TypeError` or `RangeError` before anything is sent) and returns an
 * {@link RpcRequest} carrying the result parser. Use them with
 * `QbitRpcClient.batch`; the client's methods of the same name use them too.
 */
export const requests = {
  /**
   * Any allowlisted method, untyped: the result keeps every number as a
   * `JsonNumber`. For `sendrawtransaction` the txid is computed from the hex,
   * as the typed method does, so an unknown outcome still names it.
   */
  raw(method: string, params: readonly unknown[] = []): RpcRequest<unknown> {
    argString(method, 'method', { nonEmpty: true })
    if (!Array.isArray(params)) throw new TypeError('params must be an array')
    const parse = (result: unknown): unknown => result
    const hexTx = params[0]
    const txid = method === 'sendrawtransaction' && typeof hexTx === 'string' ? rawTransactionTxid(hexTx) : undefined
    return Object.freeze(
      txid === undefined ? { method, params: [...params], parse } : { method, params: [...params], parse, txid }
    )
  },

  getBlockchainInfo: (): RpcRequest<BlockchainInfo> => request('getblockchaininfo', [], parseBlockchainInfo),
  getNetworkInfo: (): RpcRequest<NetworkInfo> => request('getnetworkinfo', [], parseNetworkInfo),
  getBestBlockHash: (): RpcRequest<string> => request('getbestblockhash', [], v => hash(v, R)),
  /** The height of the active chain's tip; the genesis block is 0. */
  getBlockCount: (): RpcRequest<number> => request('getblockcount', [], v => nonNegativeInteger(v, R)),
  getBlockHash: (height: number): RpcRequest<string> =>
    request('getblockhash', [argInteger(height, 'height', 0, 0x7fff_ffff)], v => hash(v, R)),
  getBlockHeader(blockHash: string): RpcRequest<BlockHeader> {
    const requested = argHash(blockHash, 'blockHash')
    return request('getblockheader', [requested, true], parseBlockHeader(requested))
  },
  /** The serialized transaction as hex. Without `-txindex`, only mempool transactions or ones in `blockHash`. */
  getRawTransaction(txid: string, options?: { readonly blockHash?: string }): RpcRequest<string> {
    const o = argOptions(options, 'options')
    return request(
      'getrawtransaction',
      [argHash(txid, 'txid'), 0, opt(o['blockHash'], v => argHash(v, 'options.blockHash'))],
      v => hex()(v, R)
    )
  },
  /** The decoded transaction (verbosity 1). */
  getRawTransactionVerbose(txid: string, options?: { readonly blockHash?: string }): RpcRequest<DecodedTransaction> {
    const o = argOptions(options, 'options')
    const requested = argHash(txid, 'txid')
    return request(
      'getrawtransaction',
      [requested, 1, opt(o['blockHash'], v => argHash(v, 'options.blockHash'))],
      parseDecodedTransaction(requested)
    )
  },
  /** Rejects with `RpcError` code -5 when the transaction is not in the mempool. */
  getMempoolEntry: (txid: string): RpcRequest<MempoolEntry> =>
    request('getmempoolentry', [argHash(txid, 'txid')], parseMempoolEntry),
  /**
   * An unspent output, or null when it is spent or does not exist. With
   * `includeMempool` (the node's default, true), outputs of mempool
   * transactions are found and outputs spent in the mempool are not.
   */
  getTxOut(txid: string, vout: number, options?: { readonly includeMempool?: boolean }): RpcRequest<TxOut | null> {
    const o = argOptions(options, 'options')
    return request(
      'gettxout',
      [
        argHash(txid, 'txid'),
        argInteger(vout, 'vout', 0, 0x7fff_ffff),
        opt(o['includeMempool'], v => argBoolean(v, 'options.includeMempool')),
      ],
      parseTxOut
    )
  },
  getConfirmationTarget(
    valueBits: bigint,
    options?: {
      readonly securityLevel?: SecurityLevel
      readonly mergeMiningPct?: number
      readonly btcHashrate?: number
    }
  ): RpcRequest<ConfirmationTarget> {
    const o = argOptions(options, 'options')
    return request(
      'getconfirmationtarget',
      [
        assertBits(valueBits, 'valueBits'),
        opt(o['securityLevel'], v => argOneOf(v, 'options.securityLevel', SECURITY_LEVELS)),
        opt(o['mergeMiningPct'], v => argFinite(v, 'options.mergeMiningPct', 0, 1)),
        opt(o['btcHashrate'], v => argFinite(v, 'options.btcHashrate', 0, Infinity, true)),
      ],
      parseConfirmationTarget
    )
  },
  estimateSmartFee(confTarget: number, options?: { readonly mode?: FeeEstimateMode }): RpcRequest<SmartFeeEstimate> {
    const o = argOptions(options, 'options')
    return request(
      'estimatesmartfee',
      [argInteger(confTarget, 'confTarget', 1, 1008), opt(o['mode'], v => argOneOf(v, 'options.mode', FEE_MODES))],
      parseSmartFee
    )
  },

  validateAddress: (address: string): RpcRequest<AddressValidation> =>
    request('validateaddress', [argString(address, 'address')], parseAddressValidation),
  verifyDataPqcHash(proof: DataPqcHashProof): RpcRequest<DataPqcHashVerification> {
    const p = argOptions(proof, 'proof')
    return request(
      'verifydatapqchash',
      [
        {
          address: argString(p['address'], 'proof.address', { nonEmpty: true }),
          message_hash: argHex(p['messageHash'], 'proof.messageHash', 32),
          signature: argHex(p['signature'], 'proof.signature'),
          pubkey: argHex(p['pubkey'], 'proof.pubkey', 32),
          leaf_script: argHex(p['leafScript'], 'proof.leafScript'),
          control_block: argHex(p['controlBlock'], 'proof.controlBlock'),
          leaf_version: argInteger(p['leafVersion'], 'proof.leafVersion', 0, 255),
          proof_mode: argOneOf(p['proofMode'], 'proof.proofMode', ['p2mr-pubkey'] as const),
        },
      ],
      parseDataPqcVerification
    )
  },

  testMempoolAccept(
    rawTxs: readonly string[],
    options?: { readonly maxFeeRateBitsPerKvB?: bigint }
  ): RpcRequest<MempoolAcceptance[]> {
    if (!Array.isArray(rawTxs) || rawTxs.length < 1 || rawTxs.length > MAX_PACKAGE_COUNT) {
      throw new RangeError(`rawTxs must be an array of 1 to ${MAX_PACKAGE_COUNT} transactions`)
    }
    const txs = rawTxs.map((tx, i) => argHex(tx, `rawTxs[${i}]`))
    const o = argOptions(options, 'options')
    return request(
      'testmempoolaccept',
      [txs, opt(o['maxFeeRateBitsPerKvB'], v => maxFeeRateParam(v, 'options.maxFeeRateBitsPerKvB'))],
      parseMempoolAcceptance(txs)
    )
  },
  /** Returns the txid. A failure after the request may have reached the node is an `RpcUnknownOutcomeError`. */
  sendRawTransaction(
    hexTx: string,
    options?: { readonly maxFeeRateBitsPerKvB?: bigint; readonly maxBurnAmountBits?: bigint }
  ): RpcRequest<string> {
    const tx = argHex(hexTx, 'hex')
    const o = argOptions(options, 'options')
    const txid = rawTransactionTxid(tx)
    return request(
      'sendrawtransaction',
      [
        tx,
        opt(o['maxFeeRateBitsPerKvB'], v => maxFeeRateParam(v, 'options.maxFeeRateBitsPerKvB')),
        opt(o['maxBurnAmountBits'], v => qbtParam(v, 'options.maxBurnAmountBits')),
      ],
      v => {
        const returned = hash(v, R)
        if (txid !== undefined && returned !== txid) throw new ResultIssue(R, 'the txid of the submitted transaction')
        return returned
      },
      txid
    )
  },

  getWalletInfo: (): RpcRequest<WalletInfo> => request('getwalletinfo', [], parseWalletInfo),
  getTransaction(txid: string): RpcRequest<WalletTransaction> {
    const requested = argHash(txid, 'txid')
    return request('gettransaction', [requested], parseWalletTransaction(requested))
  },
  listUnspent(options?: ListUnspentOptions): RpcRequest<UnspentOutput[]> {
    const o = argOptions(options, 'options')
    const query = compact<Record<string, unknown>>({
      minimumAmount: opt(o['minimumAmountBits'], v => qbtParam(v, 'options.minimumAmountBits')),
      maximumAmount: opt(o['maximumAmountBits'], v => qbtParam(v, 'options.maximumAmountBits')),
      maximumCount: opt(o['maximumCount'], v => argInteger(v, 'options.maximumCount', 1, Number.MAX_SAFE_INTEGER)),
      minimumSumAmount: opt(o['minimumSumAmountBits'], v => qbtParam(v, 'options.minimumSumAmountBits')),
      include_immature_coinbase: opt(o['includeImmatureCoinbase'], v =>
        argBoolean(v, 'options.includeImmatureCoinbase')
      ),
    })
    return request(
      'listunspent',
      [
        opt(o['minConf'], v => argInteger(v, 'options.minConf', 0, 0x7fff_ffff)),
        opt(o['maxConf'], v => argInteger(v, 'options.maxConf', 0, 0x7fff_ffff)),
        opt(o['addresses'], v => {
          if (!Array.isArray(v)) throw new TypeError('options.addresses must be an array')
          return v.map((a, i) => argString(a, `options.addresses[${i}]`, { nonEmpty: true }))
        }),
        opt(o['includeUnsafe'], v => argBoolean(v, 'options.includeUnsafe')),
        Object.keys(query).length > 0 ? query : undefined,
      ],
      v => array(v, R, parseUnspent)
    )
  },
  /** Checks that the reply is about `address`. Rejects with `RpcError` code -5 for an address invalid on this network. */
  getAddressInfo(address: string): RpcRequest<AddressInfo> {
    const requested = argString(address, 'address', { nonEmpty: true })
    return request('getaddressinfo', [requested], parseAddressInfo(requested))
  },
  /** The outputs `lockUnspent` or `walletCreateFundedPsbt`'s `lockUnspents` locked, persistent or not. */
  listLockUnspent: (): RpcRequest<Outpoint[]> => request('listlockunspent', [], v => array(v, R, parseOutpoint)),
  /**
   * Wallet activity since a block; see {@link SinceBlockHistory}. Rejects with
   * `RpcError` code -5 for a block the node does not know.
   */
  listSinceBlock(options?: ListSinceBlockOptions): RpcRequest<SinceBlockHistory> {
    const o = argOptions(options, 'options')
    const includeRemoved = opt(o['includeRemoved'], v => argBoolean(v, 'options.includeRemoved'))
    return request(
      'listsinceblock',
      [
        opt(o['blockHash'], v => argHash(v, 'options.blockHash')),
        opt(o['targetConfirmations'], v => argInteger(v, 'options.targetConfirmations', 1, 0x7fff_ffff)),
        opt(o['includeWatchOnly'], v => argBoolean(v, 'options.includeWatchOnly')),
        includeRemoved,
        opt(o['includeChange'], v => argBoolean(v, 'options.includeChange')),
      ],
      parseSinceBlock(includeRemoved)
    )
  },
  /** The wallet's newest entries, oldest of them first. Change outputs and a conflicted transaction's `receive` entries are not listed. */
  listTransactions(options?: ListTransactionsOptions): RpcRequest<WalletHistoryEntry[]> {
    const o = argOptions(options, 'options')
    const count = opt(o['count'], v => argInteger(v, 'options.count', 0, 0x7fff_ffff))
    const skip = opt(o['skip'], v => argInteger(v, 'options.skip', 0, 0x7fff_ffff))
    // qbit Core adds the two as 32-bit integers, with its default count of 10 when count is left out.
    if ((count ?? 10) + (skip ?? 0) > 0x7fff_ffff) {
      throw new RangeError('options.count + options.skip must be at most 2147483647')
    }
    return request(
      'listtransactions',
      [
        // qbit Core refuses an empty label here (-8): only `*` or a label name.
        opt(o['label'], v => argString(v, 'options.label', { nonEmpty: true })),
        count,
        skip,
        opt(o['includeWatchOnly'], v => argBoolean(v, 'options.includeWatchOnly')),
      ],
      v => historyEntries(v, R)
    )
  },
  getBalances: (): RpcRequest<WalletBalances> => request('getbalances', [], parseBalances),

  walletCreateFundedPsbt(args: WalletCreateFundedPsbtArgs): RpcRequest<FundedPsbt> {
    const a = argOptions(args, 'args')
    const outputs = a['outputs']
    if (!Array.isArray(outputs) || outputs.length === 0) throw new TypeError('args.outputs must be a non-empty array')
    const inputs = opt(a['inputs'], v => {
      if (!Array.isArray(v)) throw new TypeError('args.inputs must be an array')
      return v.map((input, i) => {
        const p = argOptions(input, `args.inputs[${i}]`)
        return compact<Record<string, unknown>>({
          txid: argHash(p['txid'], `args.inputs[${i}].txid`),
          vout: argInteger(p['vout'], `args.inputs[${i}].vout`, 0, 0xffff_ffff),
          sequence: opt(p['sequence'], s => argInteger(s, `args.inputs[${i}].sequence`, 0, 0xffff_ffff)),
        })
      })
    })
    const serializedOutputs = outputs.map((output: unknown, i) => {
      const p = argOptions(output, `args.outputs[${i}]`)
      if (p['data'] !== undefined) {
        if (p['address'] !== undefined || p['amountBits'] !== undefined) {
          throw new TypeError(`args.outputs[${i}] must be either { address, amountBits } or { data }`)
        }
        return { data: argHex(p['data'], `args.outputs[${i}].data`) }
      }
      const address = argString(p['address'], `args.outputs[${i}].address`, { nonEmpty: true })
      return { [address]: qbtParam(p['amountBits'], `args.outputs[${i}].amountBits`) }
    })
    return request(
      'walletcreatefundedpsbt',
      [
        inputs ?? [],
        serializedOutputs,
        opt(a['locktime'], v => argInteger(v, 'args.locktime', 0, 0xffff_ffff)),
        fundedPsbtOptions(a['options']),
        opt(a['bip32derivs'], v => argBoolean(v, 'args.bip32derivs')),
        opt(a['version'], v => argInteger(v, 'args.version', 1, 0xffff_ffff)),
      ],
      parseFundedPsbt
    )
  },
  /** Signs (by default) and finalizes what the wallet can. A failure after sending is an `RpcUnknownOutcomeError`. */
  walletProcessPsbt(
    psbt: string,
    options?: {
      readonly sign?: boolean
      readonly sighashType?: SighashType
      readonly bip32derivs?: boolean
      readonly finalize?: boolean
    }
  ): RpcRequest<ProcessedPsbt> {
    const o = argOptions(options, 'options')
    return request(
      'walletprocesspsbt',
      [
        argBase64(psbt, 'psbt'),
        opt(o['sign'], v => argBoolean(v, 'options.sign')),
        opt(o['sighashType'], v => argOneOf(v, 'options.sighashType', SIGHASH_TYPES)),
        opt(o['bip32derivs'], v => argBoolean(v, 'options.bip32derivs')),
        opt(o['finalize'], v => argBoolean(v, 'options.finalize')),
      ],
      parseProcessedPsbt
    )
  },
  finalizePsbt(psbt: string, options?: { readonly extract?: boolean }): RpcRequest<FinalizedPsbt> {
    const o = argOptions(options, 'options')
    return request(
      'finalizepsbt',
      [argBase64(psbt, 'psbt'), opt(o['extract'], v => argBoolean(v, 'options.extract'))],
      parseFinalizedPsbt
    )
  },
  /** Unlocks the wallet for `timeoutSeconds` (qbit Core caps it at 100,000,000). The passphrase is never logged or put in an error. */
  walletPassphrase: (passphrase: string, timeoutSeconds: number): RpcRequest<null> =>
    request(
      'walletpassphrase',
      [
        argString(passphrase, 'passphrase', { nonEmpty: true }),
        argInteger(timeoutSeconds, 'timeoutSeconds', 0, 100_000_000),
      ],
      parseNull
    ),
  walletLock: (): RpcRequest<null> => request('walletlock', [], parseNull),
  /**
   * A new address from the wallet's internal (change) keypool. Launch chains
   * offer only `p2mr`. An unknown or unavailable type rejects with `RpcError`
   * code -5. On regtest, a wallet encrypted at creation rejects with code -12
   * unless `addressType` is `p2mr` or the node runs with `-changetype=p2mr`.
   */
  getRawChangeAddress(options?: { readonly addressType?: string }): RpcRequest<string> {
    const o = argOptions(options, 'options')
    return request(
      'getrawchangeaddress',
      [opt(o['addressType'], v => argString(v, 'options.addressType', { nonEmpty: true }))],
      parseAddress
    )
  },
  /**
   * A new receiving address from the wallet's external keypool, listed under
   * `label` (the default label, `''`, when left out; qbit Core reserves `*`).
   * Launch chains offer only `p2mr`. An unknown or unavailable type rejects with
   * `RpcError` code -5, and a wallet with no keys with code -4. On regtest, a
   * wallet encrypted at creation rejects with code -12 unless `addressType` is
   * `p2mr`.
   */
  getNewAddress(options?: { readonly label?: string; readonly addressType?: string }): RpcRequest<string> {
    const o = argOptions(options, 'options')
    return request(
      'getnewaddress',
      [
        opt(o['label'], v => {
          const label = argString(v, 'options.label')
          if (label === '*') throw new RangeError('options.label must not be *')
          return label
        }),
        opt(o['addressType'], v => argString(v, 'options.addressType', { nonEmpty: true })),
      ],
      parseAddress
    )
  },
  /**
   * Lock (`unlock` false) or unlock (`unlock` true) wallet outputs against
   * automatic coin selection. Locks are kept in memory and gone after a node
   * restart, unless `persistent` is set when locking. The node checks every
   * output first and rejects with `RpcError` code -8, changing nothing, when one
   * is unknown, spent, already locked (locking) or not locked (unlocking).
   * `outputs` must not be empty: to unlock every output, use
   * `call('lockunspent', [true])`.
   */
  lockUnspent(
    unlock: boolean,
    outputs: readonly Outpoint[],
    options?: { readonly persistent?: boolean }
  ): RpcRequest<boolean> {
    const unlocking = argBoolean(unlock, 'unlock')
    if (!Array.isArray(outputs) || outputs.length === 0) {
      throw new RangeError('outputs must be a non-empty array of { txid, vout }')
    }
    const o = argOptions(options, 'options')
    return request(
      'lockunspent',
      [
        unlocking,
        outputs.map((output: unknown, i) => {
          const p = argOptions(output, `outputs[${i}]`)
          return {
            txid: argHash(p['txid'], `outputs[${i}].txid`),
            vout: argInteger(p['vout'], `outputs[${i}].vout`, 0, 0x7fff_ffff),
          }
        }),
        opt(o['persistent'], v => argBoolean(v, 'options.persistent')),
      ],
      v => boolean(v, R)
    )
  },
}
