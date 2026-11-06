import { assertBits, BITS_PER_QBT, formatBitsPerVbyte, formatQbt } from './amount'
import { IGNORED_OPTIONS, QBIT_CHAINS, type QbitChain } from './capabilities'
import { JsonNumber, parseJsonLossless, rawDecimal, stringifyRequest } from './json'
import { argArray, argOptions, keysOf, NO_OPTIONS, ownElements } from './own'
import { displayHash, rawTransactionTxid } from './raw-tx'
import { readNodeVersion } from './version'
import {
  amount,
  anyInteger,
  array,
  base64,
  bigUnsigned,
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
  openOneOf,
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
  /**
   * Validates the raw result (numbers as `JsonNumber`) and converts it,
   * synchronously. It may throw anything on a malformed result: the client
   * reports whatever it throws as `RpcResponseError` (`reason: 'validation'`),
   * with the thrown value as `cause`. That is the entry's own error in a batch,
   * and, for a call with side effects, the `cause` of an
   * `RpcUnknownOutcomeError`, since the node has acted by then.
   */
  readonly parse: (result: unknown) => T
  /** For `sendrawtransaction`: the txid computed from the hex, when it parses. */
  readonly txid?: string
  /**
   * For `submitpackage`: one txid per transaction, in package order, computed
   * from its hex, or `null` where the hex does not parse here (the node is the
   * judge of that, as for `sendrawtransaction`, so it is sent all the same).
   */
  readonly txids?: readonly (string | null)[]
  /**
   * For `submitblock` and `submitheader`: the hash of the header the hex starts
   * with, when it holds one. For `submitauxblock`: the hash submitted.
   */
  readonly blockHash?: string
  /**
   * For a long poll (`waitfornewblock`, `waitforblockheight`, `waitforblock`):
   * how long the node holds the request before it answers, in milliseconds.
   * The client's deadline must be at least this plus `LONG_POLL_MARGIN_MS`.
   */
  readonly waitMs?: number
}

function request<T>(
  method: string,
  params: readonly unknown[],
  parse: (result: unknown) => T,
  extras: Pick<RpcRequest<T>, 'txid' | 'txids' | 'blockHash' | 'waitMs'> = {}
): RpcRequest<T> {
  // Trailing omitted arguments are dropped; omitted ones in between become
  // null, which qbit Core reads as "use the default".
  const trimmed = [...params]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop()
  const positional = trimmed.map(value => (value === undefined ? null : value))
  // Without a prototype, like every object a result holds: a txid left out reads as undefined.
  return Object.freeze(compact<RpcRequest<T>>({ method, params: positional, parse, ...extras }))
}

// ---------------------------------------------------------------------------
// Argument checks. They throw TypeError or RangeError before any request.
// The numeric ones return -0 as 0, so the sign of zero reaches no request.
// ---------------------------------------------------------------------------

function argInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value === 0 ? 0 : value
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
  return value === 0 ? 0 : value
}

function argString(value: unknown, name: string, options: { readonly nonEmpty?: boolean } = NO_OPTIONS): string {
  const nonEmpty = options.nonEmpty === true
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
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string, one of ${values.join(', ')}`)
  if (!(values as readonly string[]).includes(value)) {
    throw new RangeError(`${name} must be one of ${values.join(', ')}`)
  }
  return value as T
}

/** A builder's top-level `options`: a typed client method takes its call options in a separate, last argument. */
function methodOptions(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  return argOptions(value, 'options', keys, { callOptions: true })
}

function opt<T>(value: unknown, check: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : check(value)
}

/** An outgoing amount as an exact decimal JSON number. */
function qbtParam(bits: unknown, name: string): unknown {
  return rawDecimal(formatQbt(assertBits(bits, name)))
}

/**
 * `maxfeerate`, bits per 1,000 vbytes. qbit Core v1.0.0 refuses 1 QBT/kvB or
 * more, and reads 0 as no cap at all, the opposite of a cap of zero: so 0n is
 * refused. Left out, the node applies its default cap of 0.1 QBT/kvB.
 */
function maxFeeRateParam(value: unknown, name: string): unknown {
  const bits = assertBits(value, name)
  if (bits === 0n || bits >= BITS_PER_QBT) {
    throw new RangeError(
      `${name} must be from 1 to 99999999 bits/kvB: qbit Core reads 0 as no cap and refuses 1 QBT/kvB or more`
    )
  }
  return rawDecimal(formatQbt(bits))
}

/** A wallet `fee_rate` option: bits per 1,000 vbytes, sent as bits/vB with 3 decimals. */
function feeRateParam(value: unknown, name: string): unknown {
  return rawDecimal(formatBitsPerVbyte(assertBits(value, name)))
}

const R = 'result'

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

/** `getblockchaininfo`. Field names are camelCase; amounts and fee rates are bits. */
export interface BlockchainInfo {
  /**
   * A {@link QbitChain}, or a chain name a later qbit Core adds, as it is: the
   * chain guard compares it with `expectedChain`.
   */
  readonly chain: QbitChain | (string & {})
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
    chain: field(o, 'chain', R, openOneOf(QBIT_CHAINS)),
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
    p2mrValidationWeight: compact<BlockchainInfo['p2mrValidationWeight']>({
      legacyPerSigop: field(weight, 'legacy_per_sigop', wp, nonNegativeInteger),
      v2PerSigop: field(weight, 'v2_per_sigop', wp, nonNegativeInteger),
      activationHeight: field(weight, 'activation_height', wp, int32),
      activeForTip: field(weight, 'active_for_tip', wp, boolean),
      activeForNextBlock: field(weight, 'active_for_next_block', wp, boolean),
      blocksRemaining: field(weight, 'blocks_remaining', wp, nonNegativeInteger),
    }),
    futureBlockTime: compact<BlockchainInfo['futureBlockTime']>({
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
    }),
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
  // The chain check's reader, so this and the version gate agree on every reply.
  const { version, subversion } = readNodeVersion(o)
  return compact<NetworkInfo>({
    version,
    subversion,
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
        return compact<NetworkInfo['networks'][number]>({
          name: field(n, 'name', ep, string),
          limited: field(n, 'limited', ep, boolean),
          reachable: field(n, 'reachable', ep, boolean),
          proxy: field(n, 'proxy', ep, string),
          proxyRandomizeCredentials: field(n, 'proxy_randomize_credentials', ep, boolean),
        })
      })
    ),
    relayFeeBitsPerKvB: optional(o, 'relayfee', R, amount),
    incrementalFeeBitsPerKvB: optional(o, 'incrementalfee', R, amount),
    localAddresses: field(o, 'localaddresses', R, (v, p) =>
      array(v, p, (entry, ep) => {
        const a = object(entry, ep)
        return compact<NetworkInfo['localAddresses'][number]>({
          address: field(a, 'address', ep, string),
          port: field(a, 'port', ep, integer(0, 65535)),
          score: field(a, 'score', ep, anyInteger),
        })
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

/** The header's fields, as `getblockheader` and `getblock` both print them, checked against the requested hash. */
function blockHeaderFields(o: JsonObject, requestedHash: string): BlockHeader {
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

function parseBlockHeader(requestedHash: string): (value: unknown) => BlockHeader {
  return value => blockHeaderFields(object(value, R), requestedHash)
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
    scriptSig: compact<{ readonly asm: string; readonly hex: string }>({
      asm: field(sig, 'asm', `${path}.scriptSig`, string),
      hex: field(sig, 'hex', `${path}.scriptSig`, hex()),
    }),
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
  return compact<TransactionOutput>({
    valueBits: field(out, 'value', path, amount),
    n: field(out, 'n', path, uint32),
    scriptPubKey: field(out, 'scriptPubKey', path, parseScriptPubKey),
  })
}

/** The fields qbit Core's `TxToUniv` prints for `getrawtransaction` and for each of `getblock`'s transactions. */
function transactionFields(o: JsonObject, path: string): BlockTransaction {
  const tx = {
    txid: field(o, 'txid', path, hash),
    hash: field(o, 'hash', path, hash),
    version: field(o, 'version', path, uint32),
    size: field(o, 'size', path, nonNegativeInteger),
    vsize: field(o, 'vsize', path, nonNegativeInteger),
    weight: field(o, 'weight', path, nonNegativeInteger),
    locktime: field(o, 'locktime', path, uint32),
    vin: field(o, 'vin', path, (v, p) => array(v, p, parseInput)),
    vout: field(o, 'vout', path, (v, p) => array(v, p, parseOutput)),
    hex: field(o, 'hex', path, hex()),
  }
  tx.vout.forEach((output, index) => {
    if (output.n !== index) throw new ResultIssue(`${path}.vout[${index}].n`, `${index}`)
  })
  return tx
}

function parseDecodedTransaction(requestedTxid: string): (value: unknown) => DecodedTransaction {
  return value => {
    const o = object(value, R)
    const tx = compact<DecodedTransaction>({
      ...transactionFields(o, R),
      blockHash: optional(o, 'blockhash', R, hash),
      confirmations: optional(o, 'confirmations', R, nonNegativeInteger),
      blockTime: optional(o, 'blocktime', R, nonNegativeInteger),
      time: optional(o, 'time', R, nonNegativeInteger),
      inActiveChain: optional(o, 'in_active_chain', R, boolean),
    })
    if (tx.txid !== requestedTxid) throw new ResultIssue(`${R}.txid`, 'the requested txid')
    return tx
  }
}

/** One transaction of {@link BlockWithTransactions}: `getrawtransaction`'s fields, without those about its block. */
export interface BlockTransaction extends Omit<
  DecodedTransaction,
  'blockHash' | 'confirmations' | 'blockTime' | 'time' | 'inActiveChain'
> {
  /** Absent for a coinbase transaction, and when the block's undo data is not available (pruned). */
  readonly feeBits?: bigint
}

/** `getblock` with verbosity 1: the header's fields, the block's sizes and its txids. */
export interface Block extends BlockHeader {
  readonly strippedSize: number
  readonly size: number
  readonly weight: number
  /** The block's txids, the coinbase first. */
  readonly tx: readonly string[]
}

/** `getblock` with verbosity 2: as {@link Block}, with each transaction decoded. */
export interface BlockWithTransactions extends Omit<Block, 'tx'> {
  readonly tx: readonly BlockTransaction[]
}

function parseBlock<T>(
  requestedHash: string,
  item: (value: unknown, path: string) => T
): (value: unknown) => Omit<Block, 'tx'> & { readonly tx: readonly T[] } {
  return value => {
    const o = object(value, R)
    const block = compact<Omit<Block, 'tx'> & { readonly tx: readonly T[] }>({
      ...blockHeaderFields(o, requestedHash),
      strippedSize: field(o, 'strippedsize', R, nonNegativeInteger),
      size: field(o, 'size', R, nonNegativeInteger),
      weight: field(o, 'weight', R, nonNegativeInteger),
      tx: field(o, 'tx', R, (v, p) => array(v, p, item)),
    })
    if (block.tx.length !== block.nTx) throw new ResultIssue(`${R}.tx`, `nTx (${block.nTx}) entries`)
    return block
  }
}

function parseBlockTransaction(value: unknown, path: string): BlockTransaction {
  const o = object(value, path)
  return compact<BlockTransaction>({
    ...transactionFields(o, path),
    feeBits: optional(o, 'fee', path, amount),
  })
}

/** A serialized block's header. Its hash is what `getblock` looks the block up by; an AuxPoW proof follows it. */
const BLOCK_HEADER_BYTES = 80
const BLOCK_HEADER_HEX = new RegExp(`^[0-9a-fA-F]{${BLOCK_HEADER_BYTES * 2}}`)

/** The hash of a serialized block's header, in display byte order, or undefined when the hex is too short to hold one. */
function serializedBlockHash(blockHex: string): string | undefined {
  if (!BLOCK_HEADER_HEX.test(blockHex)) return undefined
  return displayHash(Buffer.from(blockHex.slice(0, BLOCK_HEADER_BYTES * 2), 'hex'))
}

/**
 * `getchaintips`'s status (src/rpc/blockchain.cpp): `unknown` is what qbit Core
 * prints when it has no other. Open: a later qbit Core may add one, and the
 * entry keeps its meaning.
 */
export type ChainTipStatus = 'invalid' | 'headers-only' | 'valid-headers' | 'valid-fork' | 'active' | 'unknown'
const CHAIN_TIP_STATUSES: readonly ChainTipStatus[] = [
  'invalid',
  'headers-only',
  'valid-headers',
  'valid-fork',
  'active',
  'unknown',
]

/** One `getchaintips` entry. */
export interface ChainTip {
  readonly height: number
  readonly hash: string
  /** 0 for the active chain's tip; otherwise how many blocks connect this tip to the active chain. */
  readonly branchLen: number
  readonly status: ChainTipStatus | (string & {})
}

/** qbit Core always reports the active tip, once: a reply without it says nothing about the chain. */
function parseChainTips(value: unknown): ChainTip[] {
  const tips = array(value, R, (entry, path): ChainTip => {
    const o = object(entry, path)
    return compact<ChainTip>({
      height: field(o, 'height', path, nonNegativeInteger),
      hash: field(o, 'hash', path, hash),
      branchLen: field(o, 'branchlen', path, nonNegativeInteger),
      status: field(o, 'status', path, openOneOf(CHAIN_TIP_STATUSES)),
    })
  })
  const active = tips.flatMap((tip, index) => (tip.status === 'active' ? [index] : []))
  if (active.length !== 1) throw new ResultIssue(R, "exactly one entry with status 'active'")
  tips.forEach((tip, index) => {
    if ((tip.branchLen === 0) !== (index === active[0])) {
      throw new ResultIssue(`${R}[${index}].branchlen`, "0 exactly for the entry with status 'active'")
    }
  })
  return tips
}

/** A block by its hash and height: what `waitfornewblock` and `waitforblockheight` return. */
export interface BlockRef {
  readonly hash: string
  readonly height: number
}

function parseBlockRef(value: unknown): BlockRef {
  const o = object(value, R)
  return compact<BlockRef>({ hash: field(o, 'hash', R, hash), height: field(o, 'height', R, nonNegativeInteger) })
}

/**
 * How much longer than a long poll's own wait its deadline must run, for the
 * wait for a request slot, the cookie read and the round trip. A 34 s wait on
 * regtest answered in 34.007 s.
 */
export const LONG_POLL_MARGIN_MS = 10_000
/** The longest long poll: with the margin, the longest deadline a call can have. */
const MAX_LONG_POLL_WAIT_MS = 3_600_000 - LONG_POLL_MARGIN_MS

/**
 * The long polls qbit Core v1.0.0 has, and where each takes its wait in ms
 * among its positional params (src/rpc/blockchain.cpp). Typed or through
 * `call()`, the client bounds them by that wait.
 */
const LONG_POLL_WAIT_PARAM: Readonly<Record<string, number>> = Object.freeze({
  waitfornewblock: 0,
  waitforblockheight: 1,
  waitforblock: 1,
})

/** Whether `method` is one of qbit Core v1.0.0's long polls, however its request was built. */
export function isLongPoll(method: string): boolean {
  return Object.hasOwn(LONG_POLL_WAIT_PARAM, method)
}

/** qbit Core reads 0 or no timeout as a wait with no end, which outlives any deadline and holds a node worker meanwhile. */
function argWaitMs(value: unknown, name = 'waitMs'): number {
  return argInteger(value, name, 1, MAX_LONG_POLL_WAIT_MS)
}

/**
 * The long poll's params with its wait set to `waitMs`: what the client sends
 * when its deadline has less time left than the request's own wait.
 */
export function longPollParams(request: RpcRequest<unknown>, waitMs: number): unknown[] {
  const params = [...request.params]
  params[LONG_POLL_WAIT_PARAM[request.method]!] = waitMs
  return params
}

/**
 * Whether a long poll asks the same again when sent again. `waitfornewblock`
 * without a tip waits from the tip when the node runs it, so a retry would
 * wait past a block found since the first attempt: it is not retried.
 */
export function longPollRetryable(request: RpcRequest<unknown>): boolean {
  return request.method !== 'waitfornewblock' || (request.params[1] !== undefined && request.params[1] !== null)
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

function parseMempoolEntry(value: unknown, path = R): MempoolEntry {
  const o = object(value, path)
  const f = field(o, 'fees', path, object)
  const fp = `${path}.fees`
  const count = integer(1, Number.MAX_SAFE_INTEGER)
  const txids = (v: unknown, p: string): string[] => array(v, p, hash)
  return compact<MempoolEntry>({
    vsize: field(o, 'vsize', path, nonNegativeInteger),
    weight: field(o, 'weight', path, nonNegativeInteger),
    time: field(o, 'time', path, nonNegativeInteger),
    height: field(o, 'height', path, nonNegativeInteger),
    descendantCount: field(o, 'descendantcount', path, count),
    descendantSize: field(o, 'descendantsize', path, nonNegativeInteger),
    ancestorCount: field(o, 'ancestorcount', path, count),
    ancestorSize: field(o, 'ancestorsize', path, nonNegativeInteger),
    wtxid: field(o, 'wtxid', path, hash),
    fees: compact<MempoolEntry['fees']>({
      baseBits: field(f, 'base', fp, amount),
      modifiedBits: field(f, 'modified', fp, signedAmount),
      ancestorBits: field(f, 'ancestor', fp, signedAmount),
      descendantBits: field(f, 'descendant', fp, signedAmount),
    }),
    depends: field(o, 'depends', path, txids),
    spentBy: field(o, 'spentby', path, txids),
    bip125Replaceable: optional(o, 'bip125-replaceable', path, boolean),
    unbroadcast: field(o, 'unbroadcast', path, boolean),
  })
}

/** `getmempoolinfo`. Fee rates are in bits per 1,000 vbytes. */
export interface MempoolInfo {
  /** True once the attempt to load the saved mempool has finished. */
  readonly loaded: boolean
  /** Transactions in the mempool. */
  readonly size: number
  /** Their total vsize. */
  readonly bytes: number
  /** The memory the mempool uses. */
  readonly usage: number
  readonly totalFeeBits: bigint
  /** The most memory it may use. */
  readonly maxMempool: number
  /** The fee floor: the higher of the mempool's current minimum and `minRelayTxFeeBitsPerKvB`. */
  readonly mempoolMinFeeBitsPerKvB: bigint
  readonly minRelayTxFeeBitsPerKvB: bigint
  readonly incrementalRelayFeeBitsPerKvB: bigint
  readonly unbroadcastCount: number
  /** Deprecated by qbit Core, which still reports it in v1.0.0. */
  readonly fullRbf?: boolean
  readonly permitBareMultisig: boolean
  readonly maxDataCarrierSize: number
}

function parseMempoolInfo(value: unknown): MempoolInfo {
  const o = object(value, R)
  return compact<MempoolInfo>({
    loaded: field(o, 'loaded', R, boolean),
    size: field(o, 'size', R, nonNegativeInteger),
    bytes: field(o, 'bytes', R, nonNegativeInteger),
    usage: field(o, 'usage', R, nonNegativeInteger),
    totalFeeBits: field(o, 'total_fee', R, amount),
    maxMempool: field(o, 'maxmempool', R, nonNegativeInteger),
    mempoolMinFeeBitsPerKvB: field(o, 'mempoolminfee', R, amount),
    minRelayTxFeeBitsPerKvB: field(o, 'minrelaytxfee', R, amount),
    incrementalRelayFeeBitsPerKvB: field(o, 'incrementalrelayfee', R, amount),
    unbroadcastCount: field(o, 'unbroadcastcount', R, nonNegativeInteger),
    fullRbf: optional(o, 'fullrbf', R, boolean),
    permitBareMultisig: field(o, 'permitbaremultisig', R, boolean),
    maxDataCarrierSize: field(o, 'maxdatacarriersize', R, nonNegativeInteger),
  })
}

/** `getrawmempool` with `mempool_sequence`. */
export interface MempoolSnapshot {
  readonly txids: readonly string[]
  /** An unsigned 64-bit counter, as in the ZMQ `sequence` topic's mempool events. */
  readonly mempoolSequence: bigint
}

function parseMempoolSnapshot(value: unknown): MempoolSnapshot {
  const o = object(value, R)
  return compact<MempoolSnapshot>({
    txids: field(o, 'txids', R, (v, p) => array(v, p, hash)),
    mempoolSequence: field(o, 'mempool_sequence', R, bigUnsigned(0xffff_ffff_ffff_ffffn)),
  })
}

/**
 * An object keyed by hashes, each value parsed, without a prototype like every
 * object a result holds. Only a hash can be a key, so none reaches
 * `Object.prototype`.
 */
function hashKeyed<T>(value: unknown, path: string, parse: (value: unknown, path: string) => T): Record<string, T> {
  const keyed = Object.create(null) as Record<string, T>
  for (const [key, entry] of Object.entries(object(value, path))) {
    hash(key, `${path}.${key} (its key)`)
    keyed[key] = parse(entry, `${path}.${key}`)
  }
  return keyed
}

/** One output `gettxspendingprevout` checked. */
export interface TxSpendingPrevout {
  readonly txid: string
  readonly vout: number
  /** The mempool transaction spending it; absent when none does, which says nothing about the chain. */
  readonly spendingTxid?: string
}

function parseTxSpendingPrevouts(outputs: readonly Outpoint[]): (value: unknown) => TxSpendingPrevout[] {
  return value => {
    const entries = array(value, R, (entry, path): TxSpendingPrevout => {
      const o = object(entry, path)
      return compact<TxSpendingPrevout>({
        txid: field(o, 'txid', path, hash),
        vout: field(o, 'vout', path, uint32),
        spendingTxid: optional(o, 'spendingtxid', path, hash),
      })
    })
    if (entries.length !== outputs.length) throw new ResultIssue(R, `${outputs.length} entries, one per output`)
    entries.forEach((entry, index) => {
      if (entry.txid !== outputs[index]!.txid || entry.vout !== outputs[index]!.vout) {
        throw new ResultIssue(`${R}[${index}]`, 'the output passed at that position')
      }
    })
    return entries
  }
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
  const out = compact<TxOut>({
    bestBlock: field(o, 'bestblock', R, hash),
    confirmations: field(o, 'confirmations', R, nonNegativeInteger),
    valueBits: field(o, 'value', R, amount),
    scriptPubKey: field(o, 'scriptPubKey', R, parseScriptPubKey),
    coinbase: field(o, 'coinbase', R, boolean),
  })
  // A coinbase transaction is never in the mempool.
  if (out.coinbase && out.confirmations === 0) {
    throw new ResultIssue(`${R}.confirmations`, 'at least 1 for a coinbase output')
  }
  return out
}

/**
 * Security levels `getconfirmationtarget` models: 1, 3, 6 and 60 Bitcoin
 * confirmations. Closed: the reply names the level the caller asked for, so
 * another one fails validation.
 */
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
    /** Or a source a later qbit Core adds, as it is. */
    readonly hashrateSource:
      'observed_chainwork' | 'override_merge_mining_pct' | 'fallback_merge_mining_pct' | (string & {})
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
  return compact<ConfirmationTarget>({
    requiredConfirmations: field(o, 'required_confirmations', R, nonNegativeInteger),
    requiredMinutes: field(o, 'required_minutes', R, nonNegative),
    equivalentBtcConfirmations: field(o, 'equivalent_btc_confirmations', R, nonNegative),
    permissionlessHashrate: field(o, 'permissionless_hashrate', R, nonNegative),
    auxpowHashrate: field(o, 'auxpow_hashrate', R, nonNegative),
    totalObservedHashrate: field(o, 'total_observed_hashrate', R, nonNegative),
    orphanRate: field(o, 'orphan_rate', R, finite(0, 1)),
    securityLevel: field(o, 'security_level', R, oneOf(SECURITY_LEVELS)),
    model: compact<ConfirmationTarget['model']>({
      btcTargetConfirmations: field(m, 'btc_target_confirmations', mp, nonNegativeInteger),
      blockTimeSeconds: field(m, 'block_time_seconds', mp, nonNegativeInteger),
      hashrateSource: field(
        m,
        'hashrate_source',
        mp,
        openOneOf(['observed_chainwork', 'override_merge_mining_pct', 'fallback_merge_mining_pct'] as const)
      ),
      hashrateWindowBlocks: field(m, 'hashrate_window_blocks', mp, nonNegativeInteger),
      permissionlessBlocksInWindow: field(m, 'permissionless_blocks_in_window', mp, nonNegativeInteger),
      auxpowBlocksInWindow: field(m, 'auxpow_blocks_in_window', mp, nonNegativeInteger),
      mergeMiningPct: field(m, 'merge_mining_pct', mp, finite(0, 1)),
      btcHashrate: field(m, 'btc_hashrate', mp, nonNegative),
      orphanRatePenalty: field(m, 'orphan_rate_penalty', mp, nonNegative),
      securityPerConfirmation: field(m, 'security_per_confirmation', mp, nonNegative),
      cadenceMergedFraction: field(m, 'cadence_merged_fraction', mp, finite(0, 1)),
    }),
  })
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
  return compact<AddressValidation>({
    isValid: false,
    error: field(o, 'error', R, string),
    errorLocations: field(o, 'error_locations', R, (v, p) => array(v, p, nonNegativeInteger)),
  })
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

/**
 * `signdatapqchash`: the proof, which `verifyDataPqcHash` takes as it is, what
 * the key signed, and, with `includePqcUsage`, the signing key's PQC usage fields.
 */
export interface DataPqcHashSignature extends DataPqcHashProof, PqcUsage {
  /** The qbit data-signature hash the key signed, which commits to `messageHash`. */
  readonly datasigHash: string
  /** `QbitDataSigPQC` in qbit Core v1.0.0. */
  readonly domain: string
  /** `SLH-DSA-SHA2-128s-bounded30` in qbit Core v1.0.0. */
  readonly algorithm: string
  /** The P2MR Merkle root the address commits to. */
  readonly p2mrMerkleRoot: string
  /** PQC threshold warnings, with `includePqcUsage`, when the node emitted any. */
  readonly warnings?: readonly string[]
}

/** What `signdatapqchash` was asked for, which its reply must repeat; the hex in lowercase. */
interface DataPqcSigningRequest {
  readonly address: string
  readonly messageHash: string
  readonly pubkey: string | undefined
  readonly leafScript: string | undefined
  readonly controlBlock: string | undefined
}

/**
 * Whether `echoed` names the address `asked` named. A bech32 or bech32m
 * address is the same in either case (BIP 173), though written all in one, so
 * for one of those the case does not count: qbit Core v1.0.0 echoes the
 * address as it was sent (seen on regtest, an all-uppercase one included), and
 * a node that printed it in lowercase would still name the key that signed.
 */
function sameAddress(echoed: string, asked: string): boolean {
  if (echoed === asked) return true
  const oneCase = asked === asked.toLowerCase() || asked === asked.toUpperCase()
  return oneCase && /^[a-z0-9]+1[a-z0-9]+$/i.test(asked) && echoed.toLowerCase() === asked.toLowerCase()
}

function parseDataPqcSignature(asked: DataPqcSigningRequest): (value: unknown) => DataPqcHashSignature {
  /** A reply field that must be the one asked for, when one was. */
  const same =
    (expected: string | undefined, parse: (value: unknown, path: string) => string, what: string) =>
    (value: unknown, path: string): string => {
      const parsed = parse(value, path)
      if (expected !== undefined && parsed !== expected) throw new ResultIssue(path, what)
      return parsed
    }
  return value => {
    const o = object(value, R)
    return compact<DataPqcHashSignature>({
      address: field(o, 'address', R, (v, p) => {
        const echoed = string(v, p)
        if (!sameAddress(echoed, asked.address)) throw new ResultIssue(p, 'the requested address')
        return echoed
      }),
      messageHash: field(o, 'message_hash', R, same(asked.messageHash, hex(32), 'the requested hash')),
      signature: field(o, 'signature', R, (v, p) => {
        const signature = hex()(v, p)
        if (signature === '') throw new ResultIssue(p, 'a non-empty signature')
        return signature
      }),
      pubkey: field(o, 'pubkey', R, same(asked.pubkey, hex(32), 'the requested pubkey')),
      leafScript: field(o, 'leaf_script', R, same(asked.leafScript, hex(), 'the requested leaf script')),
      controlBlock: field(o, 'control_block', R, same(asked.controlBlock, hex(), 'the requested control block')),
      leafVersion: field(o, 'leaf_version', R, integer(0, 255)),
      proofMode: field(o, 'proof_mode', R, oneOf(['p2mr-pubkey'] as const)),
      datasigHash: field(o, 'datasig_hash', R, hex(32)),
      domain: field(o, 'domain', R, string),
      algorithm: field(o, 'algorithm', R, string),
      p2mrMerkleRoot: field(o, 'p2mr_merkle_root', R, hex(32)),
      ...pqcUsage(o),
      warnings: optional(o, 'warnings', R, warnings),
    })
  }
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

/** qbit Core v1.0.0's descriptor characters, in its order (`DescriptorChecksum`, src/script/descriptor.cpp). */
const DESCRIPTOR_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}" + 'IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~' + 'ijklmnopqrstuvwxyzABCDEFGH`#"\\ '
const DESCRIPTOR_CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const DESCRIPTOR_CHECKSUM = /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/
const POLYMOD_GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn] as const

function polyMod(c: bigint, value: number): bigint {
  const top = c >> 35n
  let next = ((c & 0x7ffffffffn) << 5n) ^ BigInt(value)
  POLYMOD_GENERATOR.forEach((generator, bit) => {
    if ((top >> BigInt(bit)) & 1n) next ^= generator
  })
  return next
}

/**
 * The checksum qbit Core appends to `body` after a `#` (BIP 380), or undefined
 * when `body` holds a character descriptors do not use, which the node refuses.
 */
export function descriptorChecksum(body: string): string | undefined {
  let c = 1n
  let groups = 0
  let count = 0
  for (const char of body) {
    const position = DESCRIPTOR_CHARSET.indexOf(char)
    if (position < 0) return undefined
    c = polyMod(c, position & 31)
    groups = groups * 3 + (position >> 5)
    if (++count === 3) {
      c = polyMod(c, groups)
      groups = 0
      count = 0
    }
  }
  if (count > 0) c = polyMod(c, groups)
  for (let i = 0; i < 8; i += 1) c = polyMod(c, 0)
  c ^= 1n
  let checksum = ''
  for (let i = 0; i < 8; i += 1) checksum += DESCRIPTOR_CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - i))) & 31n)]
  return checksum
}

/** A descriptor's text before its `#checksum`, and the checksum when it has one. */
function splitDescriptor(descriptor: string): { readonly body: string; readonly checksum: string | undefined } {
  const at = descriptor.indexOf('#')
  return at < 0
    ? { body: descriptor, checksum: undefined }
    : { body: descriptor.slice(0, at), checksum: descriptor.slice(at + 1) }
}

/**
 * A descriptor argument as qbit Core parses it: non-empty, of descriptor
 * characters only, with at most one `#`, then its 8-character checksum, which
 * is checked here; `requireChecksum` refuses one without, as `deriveaddresses`
 * and `importdescriptors` do. A descriptor can hold private keys, so the
 * messages never quote it.
 */
function argDescriptor(value: unknown, name: string, requireChecksum: boolean): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} must be a non-empty string`)
  const { body, checksum } = splitDescriptor(value)
  const computed = descriptorChecksum(body)
  if (body === '' || computed === undefined) {
    throw new TypeError(`${name} must be a descriptor: it holds a character descriptors do not use`)
  }
  if (checksum === undefined) {
    if (requireChecksum) {
      throw new TypeError(`${name} needs its checksum, # and 8 characters, which getDescriptorInfo() returns`)
    }
  } else if (checksum !== computed) {
    throw new TypeError(
      `${name}'s checksum ${DESCRIPTOR_CHECKSUM.test(checksum) ? 'does not match the descriptor: look for a typo in either' : 'must be 8 checksum characters after one #'}`
    )
  }
  return value
}

/** Whether a descriptor derives a range of scripts: a key path ending in `*`, the only place descriptors use one. */
const isRanged = (descriptor: string): boolean => splitDescriptor(descriptor).body.includes('*')

/** Whether a descriptor has multipath key paths (`<0;1>`, BIP 389), the only place descriptors use `<`. */
const isMultipath = (descriptor: string): boolean => splitDescriptor(descriptor).body.includes('<')

/** The shortest run of letters and digits redacted from the node's messages: every private key encoding is longer. */
const MIN_SECRET_LENGTH = 16
const REDACTED = '[redacted]'
/** The most of a node's message an error or a result keeps. */
export const MAX_NODE_MESSAGE = 1000

/**
 * The key material `descriptors` may hold, as the node quotes it in a message
 * (`key '...' is not valid`, `Could not add descriptor '...'`): each run of 16
 * or more letters and digits, longest first. Extended keys, WIF keys and hex
 * keys are such runs; so are public keys and hashes, which are redacted too.
 */
function descriptorSecrets(descriptors: readonly string[]): readonly string[] {
  const secrets = new Set<string>()
  for (const descriptor of descriptors) {
    for (const run of descriptor.split(/[^0-9A-Za-z]+/)) if (run.length >= MIN_SECRET_LENGTH) secrets.add(run)
  }
  return [...secrets].sort((a, b) => b.length - a.length)
}

/**
 * Refuses, with a `TypeError`, an option of IGNORED_OPTIONS in `params`, the
 * params of a call to `method` as the client sends them: the request body
 * parsed back, so after `toJSON()`, without the values JSON leaves out, and
 * with each getter read once, by the serialization the node receives.
 */
export function checkIgnoredOptions(method: string, params: unknown): void {
  const ignored = Object.hasOwn(IGNORED_OPTIONS, method) ? IGNORED_OPTIONS[method] : undefined
  if (ignored === undefined || !Array.isArray(params)) return
  // The params parsed back from the body: an array without holes, its objects without a prototype.
  const options: unknown = ignored.param < params.length ? params[ignored.param] : undefined
  if (typeof options !== 'object' || options === null) return
  for (const [key, read] of Object.entries(ignored.keys)) {
    if (Object.hasOwn(options, key)) {
      throw new TypeError(
        `${method} option ${key} is accepted and then ignored by qbit Core v1.0.0: send ${read}, or use ${ignored.typed}()`
      )
    }
  }
}

/**
 * `text` with every secret replaced by `[redacted]`, in any case, as the node
 * may print hex key material in another case than it was sent in. Secrets are
 * runs of letters and digits, so they need no escaping in a pattern.
 */
export function redact(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return text
  return text.replace(new RegExp(secrets.join('|'), 'gi'), REDACTED)
}

/**
 * The key material that the descriptors of a call to `method` may hold, to
 * redact from the node's messages about it: those of `importdescriptors`,
 * `deriveaddresses` and `getdescriptorinfo`. The client reads `params` from
 * the request body it sends, parsed back, so a copy of a request, one built by
 * hand, a descriptor passed as a `String` or behind `toJSON()`, and params
 * changed after the request was built are all redacted by what was sent.
 */
export function messageSecrets(method: string, params: unknown): readonly string[] {
  return Array.isArray(params) ? descriptorSecrets(rawDescriptors(method, params)) : []
}

/** The descriptors of a call's parameters, for redaction; any that are not strings are left out. */
function rawDescriptors(method: string, params: readonly unknown[]): string[] {
  const first = params.length > 0 ? params[0] : undefined
  if ((method === 'deriveaddresses' || method === 'getdescriptorinfo') && typeof first === 'string') return [first]
  if (method !== 'importdescriptors' || !Array.isArray(first)) return []
  return first.flatMap((entry: unknown) => {
    const desc =
      typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'desc')
        ? (entry as Record<string, unknown>)['desc']
        : undefined
    return typeof desc === 'string' ? [desc] : []
  })
}

/** A descriptor range: its last index, from 0, or `[begin, end]`, both included. */
export type DescriptorRange = number | readonly [begin: number, end: number]

/**
 * A range as qbit Core's `ParseDescriptorRange` takes it: from 0 to
 * 2,147,483,647, begin at most end, and at most 1,000,000 indexes. Sent as
 * `[begin, end]`.
 */
function rangeParam(value: unknown, name: string): [number, number] {
  let begin = 0
  let end: number
  if (typeof value === 'number') end = argInteger(value, name, 0, 0x7fff_ffff)
  else {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new TypeError(`${name} must be an end index or [begin, end]`)
    }
    begin = argInteger(value[0], `${name}[0]`, 0, 0x7fff_ffff)
    end = argInteger(value[1], `${name}[1]`, 0, 0x7fff_ffff)
    if (begin > end) throw new RangeError(`${name} must not begin after its end`)
  }
  // For both forms, as ParseDescriptorRange (src/rpc/util.cpp) checks: an end index n is [0, n].
  if (end - begin >= 1_000_000) {
    throw new RangeError(
      `${name} must span at most 1,000,000 indexes${typeof value === 'number' ? ': an end index of at most 999999' : ''}`
    )
  }
  return [begin, end]
}

/** The number of indexes in a range sent as `[begin, end]`. */
const rangeSize = ([begin, end]: readonly [number, number]): number => end - begin + 1

/** `getdescriptorinfo`. The descriptor is qbit Core's canonical form, without private keys. */
export interface DescriptorInfo {
  /** The canonical form, with its checksum; for a multipath descriptor, the first path's. */
  readonly descriptor: string
  /** Each path's descriptor, with its checksum, for a multipath descriptor (`<0;1>`) only. */
  readonly multipathExpansion?: readonly string[]
  /** The checksum of the descriptor as passed, checked here against it. */
  readonly checksum: string
  readonly isRange: boolean
  readonly isSolvable: boolean
  /** For a P2MR descriptor only: whether the wallet can build its satisfaction within P2MR v1's limits. */
  readonly hasP2mrStandardSatisfaction?: boolean
  readonly hasPrivateKeys: boolean
}

/** A descriptor qbit Core returns: with a checksum, which must be its own. */
function returnedDescriptor(value: unknown, path: string): string {
  const descriptor = string(value, path)
  const { body, checksum } = splitDescriptor(descriptor)
  if (checksum === undefined || descriptorChecksum(body) !== checksum) {
    throw new ResultIssue(path, 'a descriptor with its own checksum')
  }
  return descriptor
}

function parseDescriptorInfo(asked: string): (value: unknown) => DescriptorInfo {
  const multipath = isMultipath(asked)
  return value => {
    const o = object(value, R)
    const info = compact<DescriptorInfo>({
      descriptor: field(o, 'descriptor', R, returnedDescriptor),
      multipathExpansion: optional(o, 'multipath_expansion', R, (v, p) => array(v, p, returnedDescriptor)),
      checksum: field(o, 'checksum', R, (v, p) => {
        if (v !== descriptorChecksum(splitDescriptor(asked).body))
          throw new ResultIssue(p, 'the requested descriptor’s checksum')
        return v as string
      }),
      isRange: field(o, 'isrange', R, (v, p) => {
        if (boolean(v, p) !== isRanged(asked)) throw new ResultIssue(p, 'true exactly when the descriptor has a *')
        return v as boolean
      }),
      isSolvable: field(o, 'issolvable', R, boolean),
      hasP2mrStandardSatisfaction: optional(o, 'has_p2mr_standard_satisfaction', R, boolean),
      hasPrivateKeys: field(o, 'hasprivatekeys', R, boolean),
    })
    if ((info.multipathExpansion !== undefined) !== multipath || (info.multipathExpansion?.length ?? 2) < 2) {
      throw new ResultIssue(
        `${R}.multipath_expansion`,
        multipath ? 'a descriptor per path, for a multipath descriptor' : 'nothing, for a descriptor without <'
      )
    }
    return info
  }
}

/** `deriveaddresses`: one address per index, or a multiple of that for `combo()`, which gives several. */
function parseDerivedAddresses(descriptor: string, indexes: number): (value: unknown) => string[] {
  const combo = splitDescriptor(descriptor).body.startsWith('combo(')
  return value => {
    const addresses = array(value, R, (v, p) => parseAddress(v, p))
    if (combo ? addresses.length === 0 || addresses.length % indexes !== 0 : addresses.length !== indexes) {
      throw new ResultIssue(
        R,
        combo ? `addresses for each of the ${indexes} indexes` : `${indexes} addresses, one per index`
      )
    }
    return addresses
  }
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
          return compact<NonNullable<MempoolAcceptance['fees']>>({
            baseBits: field(f, 'base', fp, amount),
            effectiveFeeRateBitsPerKvB: field(f, 'effective-feerate', fp, amount),
            effectiveIncludes: field(f, 'effective-includes', fp, (w, wp) => array(w, wp, hash)),
          })
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

/** One transaction's outcome in {@link PackageSubmission}. */
export interface PackageTransactionResult {
  readonly txid: string
  /** The wtxid of a transaction with this txid and another witness in the mempool: the submitted one was ignored. */
  readonly otherWtxid?: string
  readonly vsize?: number
  readonly fees?: {
    readonly baseBits: bigint
    /** Absent when the transaction was already in the mempool. */
    readonly effectiveFeeRateBitsPerKvB?: bigint
    /** wtxids of the transactions the effective fee rate includes. */
    readonly effectiveIncludes?: readonly string[]
  }
  /** Why the mempool refused this transaction. */
  readonly error?: string
}

/**
 * `submitpackage`. A refusal is a result, not an error, and may be partial:
 * `packageMsg` other than `success` can come with a parent accepted and its
 * child refused, so read each transaction's `error`, or the mempool.
 */
export interface PackageSubmission {
  /** `success` when every transaction was accepted or already in the mempool; otherwise the node's text. */
  readonly packageMsg: string
  /** By wtxid. Empty, or missing transactions, when the package failed before each was evaluated. */
  readonly txResults: Readonly<Record<string, PackageTransactionResult>>
  /** txids of the mempool transactions this package replaced. */
  readonly replacedTransactions?: readonly string[]
}

function parsePackageTransaction(value: unknown, path: string): PackageTransactionResult {
  const o = object(value, path)
  return compact<PackageTransactionResult>({
    txid: field(o, 'txid', path, hash),
    otherWtxid: optional(o, 'other-wtxid', path, hash),
    vsize: optional(o, 'vsize', path, nonNegativeInteger),
    fees: optional(o, 'fees', path, (v, fp) => {
      const f = object(v, fp)
      return compact<NonNullable<PackageTransactionResult['fees']>>({
        baseBits: field(f, 'base', fp, amount),
        effectiveFeeRateBitsPerKvB: optional(f, 'effective-feerate', fp, amount),
        effectiveIncludes: optional(f, 'effective-includes', fp, (w, wp) => array(w, wp, hash)),
      })
    }),
    error: optional(o, 'error', path, string),
  })
}

function parsePackageSubmission(
  rawTxs: readonly string[],
  txids: readonly (string | null)[]
): (value: unknown) => PackageSubmission {
  return value => {
    const o = object(value, R)
    const submission = compact<PackageSubmission>({
      packageMsg: field(o, 'package_msg', R, string),
      txResults: field(o, 'tx-results', R, (v, p) => hashKeyed(v, p, parsePackageTransaction)),
      replacedTransactions: optional(o, 'replaced-transactions', R, (v, p) => array(v, p, hash)),
    })
    const results = Object.entries(submission.txResults)
    // Only when every hex parsed does `txids` name the whole package.
    if (!txids.includes(null)) {
      for (const [wtxid, result] of results) {
        if (!txids.includes(result.txid)) {
          throw new ResultIssue(`${R}.tx-results.${wtxid}.txid`, 'the txid of a transaction in the package')
        }
      }
    }
    if (submission.packageMsg === 'success') {
      if (results.length !== rawTxs.length) {
        throw new ResultIssue(`${R}.tx-results`, `${rawTxs.length} entries for a package that succeeded`)
      }
      for (const [wtxid, result] of results) {
        if (result.error !== undefined) {
          throw new ResultIssue(`${R}.tx-results.${wtxid}.error`, 'no error in a package that succeeded')
        }
      }
    }
    return submission
  }
}

/** A package's transactions: the checks `testmempoolaccept` and `submitpackage` share. */
function packageParam(rawTxs: unknown): string[] {
  if (!Array.isArray(rawTxs) || rawTxs.length < 1 || rawTxs.length > MAX_PACKAGE_COUNT) {
    throw new RangeError(`rawTxs must be an array of 1 to ${MAX_PACKAGE_COUNT} transactions`)
  }
  return ownElements(rawTxs, 'rawTxs').map((tx, i) => argHex(tx, `rawTxs[${i}]`))
}

/** The txid computed from each of a package's hex, in package order, or `null` where it does not parse. */
function packageTxids(rawTxs: readonly unknown[]): (string | null)[] {
  return rawTxs.map(tx => (typeof tx === 'string' ? (rawTransactionTxid(tx) ?? null) : null))
}

/**
 * The errors qbit Core v1.0.0's `submitpackage` raises before it hands any
 * transaction to the mempool, by code, and for -25 by message
 * (src/rpc/mempool.cpp at v1.0.0, and the RPC server around it):
 *
 * - -28 `RPC_IN_WARMUP`: the server is starting, before any method runs
 *   (`CRPCTable::execute`, src/rpc/server.cpp:497-502).
 * - -3 `RPC_TYPE_ERROR`: a parameter of the wrong type (`RPCHelpMan::HandleRequest`,
 *   src/rpc/util.cpp:770-783; a `UniValue::type_error` from `get_array` or
 *   `get_str`, src/rpc/server.cpp:525-526), or a `maxfeerate` or
 *   `maxburnamount` that is not an amount (`AmountFromValue`, src/rpc/util.cpp:191-201,
 *   from mempool.cpp:994 and 1002).
 * - -8 `RPC_INVALID_PARAMETER`: no transaction or more than 25
 *   (mempool.cpp:988-991), or a `maxfeerate` of 1 QBT/kvB or more
 *   (`ParseFeeRate`, src/rpc/util.cpp:206).
 * - -22 `RPC_DESERIALIZATION_ERROR`: a transaction that does not decode
 *   (mempool.cpp:1008-1011).
 * - -25 `RPC_TRANSACTION_ERROR` with `MAX_BURN_EXCEEDED`'s text, an output
 *   burning more than `maxburnamount` (mempool.cpp:1013-1017), or the
 *   package-topology text (mempool.cpp:1022-1024).
 *
 * Every other error can come after `ProcessNewPackage` (mempool.cpp:1029) has
 * accepted part of the package: -25 with `PCKG_MEMPOOL_ERROR`'s reason
 * (mempool.cpp:1044-1049) or `transaction broadcast failed: ... (N
 * transactions were broadcast successfully)`, as -25, -26 or -27 by its
 * `TransactionError` (mempool.cpp:1068-1075), and -1 from a failed
 * `CHECK_NONFATAL` (mempool.cpp:1038-1040 and 1055), which the RPC server
 * reports as `RPC_MISC_ERROR` (src/rpc/server.cpp:527-528). -1 also reports a
 * wrong number of parameters, before the method runs, but it is not told
 * apart by its text: a typed call never sends one.
 */
const SUBMIT_PACKAGE_REFUSALS: readonly { readonly code: number; readonly message?: string }[] = [
  // The JSON-RPC layer's, before any method runs: a parse error, an invalid
  // request, a method not found, invalid params.
  { code: -32700 },
  { code: -32600 },
  { code: -32601 },
  { code: -32602 },
  { code: -28 },
  { code: -3 },
  { code: -8 },
  { code: -22 },
  { code: -25, message: 'Unspendable output exceeds maximum configured by user (maxburnamount)' },
  { code: -25, message: 'package topology disallowed. not child-with-parents or parents depend on each other.' },
]

/**
 * Whether the node's error to `method` means it did nothing, so the call's
 * outcome is definite. `submitpackage` can raise errors after accepting part
 * of the package: only those of SUBMIT_PACKAGE_REFUSALS come before. For
 * every other method, an error reply is the node's refusal.
 */
export function refusedBeforeActing(method: string, code: number, message: string): boolean {
  if (method !== 'submitpackage') return true
  return SUBMIT_PACKAGE_REFUSALS.some(
    refusal => refusal.code === code && (refusal.message === undefined || refusal.message === message)
  )
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

/** `getmininginfo`. */
export interface MiningInfo {
  /** The active chain's height. */
  readonly blocks: number
  /** Of the last block the node assembled; absent until it has assembled one. */
  readonly currentBlockWeight?: number
  /** Of the last block the node assembled, without its coinbase; absent until it has assembled one. */
  readonly currentBlockTx?: number
  /** The tip's compact target. */
  readonly bits: string
  readonly difficulty: number
  /** The tip's target: `bits` expanded. */
  readonly target: string
  readonly networkHashPs: number
  readonly pooledTx: number
  readonly blockMinTxFeeBitsPerKvB: bigint
  readonly chain: QbitChain | (string & {})
  /** On signet only. */
  readonly signetChallenge?: string
  /** The next permissionless block's candidate. */
  readonly next: {
    readonly height: number
    readonly bits: string
    readonly difficulty: number
    readonly target: string
  }
  /** Node warnings; a single string under `-deprecatedrpc=warnings` becomes a one-element array. */
  readonly warnings: readonly string[]
}

/** A compact target (`bits`) expanded, as qbit Core's `SetCompact` does, without its sign bit. */
function compactTarget(bits: string): bigint {
  const compact = Number.parseInt(bits, 16)
  const exponent = compact >>> 24
  const mantissa = BigInt(compact & 0x007f_ffff)
  return exponent <= 3 ? mantissa >> BigInt(8 * (3 - exponent)) : mantissa << BigInt(8 * (exponent - 3))
}

/**
 * An object of the node's own keys (rule names, coinbase flags), each value
 * parsed, without a prototype like every object a result holds, so no key
 * reaches `Object.prototype` and an absent one reads as undefined.
 */
function keyed<T>(value: unknown, path: string, parse: (value: unknown, path: string) => T): Record<string, T> {
  const out = Object.create(null) as Record<string, T>
  for (const [key, entry] of Object.entries(object(value, path))) out[key] = parse(entry, `${path}.${key}`)
  return out
}

/** A `bits` and `target` printed together: one is the other's form, and a pool compares its shares with `target`. */
function compactTargetFields(o: JsonObject, path: string): { readonly bits: string; readonly target: string } {
  const bits = field(o, 'bits', path, hex(4))
  const target = field(o, 'target', path, hex(32))
  if (BigInt(`0x${target}`) !== compactTarget(bits)) {
    throw new ResultIssue(`${path}.target`, `the target of bits ${bits}`)
  }
  return { bits, target }
}

function parseMiningInfo(value: unknown): MiningInfo {
  const o = object(value, R)
  const next = field(o, 'next', R, object)
  const np = `${R}.next`
  return compact<MiningInfo>({
    blocks: field(o, 'blocks', R, nonNegativeInteger),
    currentBlockWeight: optional(o, 'currentblockweight', R, nonNegativeInteger),
    currentBlockTx: optional(o, 'currentblocktx', R, nonNegativeInteger),
    ...compactTargetFields(o, R),
    difficulty: field(o, 'difficulty', R, finite(0)),
    networkHashPs: field(o, 'networkhashps', R, finite(0)),
    pooledTx: field(o, 'pooledtx', R, nonNegativeInteger),
    blockMinTxFeeBitsPerKvB: field(o, 'blockmintxfee', R, amount),
    chain: field(o, 'chain', R, openOneOf(QBIT_CHAINS)),
    signetChallenge: optional(o, 'signet_challenge', R, hex()),
    next: compact<MiningInfo['next']>({
      height: field(next, 'height', np, nonNegativeInteger),
      ...compactTargetFields(next, np),
      difficulty: field(next, 'difficulty', np, finite(0)),
    }),
    warnings: field(o, 'warnings', R, warnings),
  })
}

/** How much a block's P2MR signature operations weigh at a template's or candidate's height. */
export interface P2mrValidationWeightRule {
  readonly perSigop: number
  readonly v2Active: boolean
  readonly v2ActivationHeight: number
}

function parseP2mrValidationWeightRule(value: unknown, path: string): P2mrValidationWeightRule {
  const o = object(value, path)
  return compact<P2mrValidationWeightRule>({
    perSigop: field(o, 'per_sigop', path, nonNegativeInteger),
    v2Active: field(o, 'v2_active', path, boolean),
    v2ActivationHeight: field(o, 'v2_activation_height', path, nonNegativeInteger),
  })
}

/** How far a template's or candidate's timestamp may pass the node's clock. */
export interface FutureBlockTimeRule {
  readonly limitSeconds: number
  readonly v2Active: boolean
  readonly v2ActivationHeight: number
}

function parseFutureBlockTimeRule(value: unknown, path: string): FutureBlockTimeRule {
  const o = object(value, path)
  return compact<FutureBlockTimeRule>({
    limitSeconds: field(o, 'limit_seconds', path, nonNegativeInteger),
    v2Active: field(o, 'v2_active', path, boolean),
    v2ActivationHeight: field(o, 'v2_activation_height', path, nonNegativeInteger),
  })
}

/** One transaction of a {@link BlockTemplate}, for a block to include as it is. */
export interface BlockTemplateTransaction {
  /** The transaction's hex, with its witness. */
  readonly data: string
  readonly txid: string
  /** The wtxid. */
  readonly hash: string
  /** The transactions this one needs before it, by their 1-based place in `transactions`. */
  readonly depends: readonly number[]
  readonly feeBits: bigint
  readonly sigops: number
  readonly weight: number
}

/**
 * `getblocktemplate`: the data to build the next block from. Permissionless
 * work only: `version` never signals AuxPoW, and no AuxPoW field is printed.
 * Merge mining goes through {@link AuxBlock}.
 */
export interface BlockTemplate {
  readonly version: number
  /** The rules the block must follow; a `!` prefix marks one the miner must understand. */
  readonly rules: readonly string[]
  readonly vbAvailable: Readonly<Record<string, number>>
  readonly capabilities: readonly string[]
  readonly vbRequired: number
  /** The BIP310 version-rolling mask for this work, `00000000` when rolling is off. */
  readonly versionRollingMask: string
  readonly previousBlockHash: string
  /** Without the coinbase, which the miner builds. */
  readonly transactions: readonly BlockTemplateTransaction[]
  /** Data for the coinbase's scriptSig. */
  readonly coinbaseAux: Readonly<Record<string, string>>
  /** What the coinbase may pay at most: the subsidy and every transaction's fee. */
  readonly coinbaseValueBits: bigint
  /**
   * Passed to `getblocktemplate` through `call()`, it holds the reply: see
   * {@link https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/mining.md | Mining}.
   */
  readonly longPollId: string
  /** `bits` expanded. */
  readonly target: string
  readonly minTime: number
  readonly mutable: readonly string[]
  readonly nonceRange: string
  readonly sigOpLimit: number
  readonly sizeLimit: number
  /** Absent before segwit's activation. */
  readonly weightLimit?: number
  readonly curTime: number
  readonly bits: string
  readonly height: number
  readonly p2mrValidationWeight: P2mrValidationWeightRule
  readonly futureBlockTime: FutureBlockTimeRule
  /** On signet only. */
  readonly signetChallenge?: string
  /** The coinbase output to commit to the witnesses, as long as the coinbase's witness is 32 zero bytes and `transactions` stands. */
  readonly defaultWitnessCommitment?: string
}

function parseBlockTemplateTransaction(value: unknown, path: string, place: number): BlockTemplateTransaction {
  const o = object(value, path)
  const tx = compact<BlockTemplateTransaction>({
    data: field(o, 'data', path, hex()),
    txid: field(o, 'txid', path, hash),
    hash: field(o, 'hash', path, hash),
    depends: field(o, 'depends', path, (v, p) => array(v, p, integer(1, place - 1))),
    feeBits: field(o, 'fee', path, bitsInteger),
    sigops: field(o, 'sigops', path, nonNegativeInteger),
    weight: field(o, 'weight', path, nonNegativeInteger),
  })
  // A miner builds the block from data: it must be a transaction, whose txid
  // and wtxid are the ones the template names.
  const txid = rawTransactionTxid(tx.data)
  if (txid === undefined) throw new ResultIssue(`${path}.data`, 'a serialized transaction')
  if (txid !== tx.txid) throw new ResultIssue(`${path}.txid`, 'the txid of data')
  if (displayHash(Buffer.from(tx.data, 'hex')) !== tx.hash) throw new ResultIssue(`${path}.hash`, 'the wtxid of data')
  return tx
}

function parseBlockTemplate(value: unknown): BlockTemplate {
  const o = object(value, R)
  const strings = (v: unknown, p: string): string[] => array(v, p, string)
  return compact<BlockTemplate>({
    version: field(o, 'version', R, int32),
    rules: field(o, 'rules', R, strings),
    vbAvailable: field(o, 'vbavailable', R, (v, p) => keyed(v, p, nonNegativeInteger)),
    capabilities: field(o, 'capabilities', R, strings),
    vbRequired: field(o, 'vbrequired', R, nonNegativeInteger),
    versionRollingMask: field(o, 'versionrollingmask', R, hex(4)),
    previousBlockHash: field(o, 'previousblockhash', R, hash),
    transactions: field(o, 'transactions', R, (v, p) => {
      let place = 1 // The coinbase is 0.
      return array(v, p, (entry, path) => parseBlockTemplateTransaction(entry, path, place++))
    }),
    coinbaseAux: field(o, 'coinbaseaux', R, (v, p) => keyed(v, p, hex())),
    coinbaseValueBits: field(o, 'coinbasevalue', R, bitsInteger),
    longPollId: field(o, 'longpollid', R, string),
    ...compactTargetFields(o, R),
    minTime: field(o, 'mintime', R, nonNegativeInteger),
    mutable: field(o, 'mutable', R, strings),
    nonceRange: field(o, 'noncerange', R, hex(8)),
    sigOpLimit: field(o, 'sigoplimit', R, nonNegativeInteger),
    sizeLimit: field(o, 'sizelimit', R, nonNegativeInteger),
    weightLimit: optional(o, 'weightlimit', R, nonNegativeInteger),
    curTime: field(o, 'curtime', R, nonNegativeInteger),
    height: field(o, 'height', R, integer(1, 0x7fff_ffff)),
    p2mrValidationWeight: field(o, 'p2mr_validation_weight', R, parseP2mrValidationWeightRule),
    futureBlockTime: field(o, 'future_block_time', R, parseFutureBlockTimeRule),
    signetChallenge: optional(o, 'signet_challenge', R, hex()),
    defaultWitnessCommitment: optional(o, 'default_witness_commitment', R, hex()),
  })
}

/**
 * `createauxblock`: a merge-mining candidate the node holds in its cache. The
 * parent chain's coinbase commits to `hash`, in the byte order
 * `commitmentOrder` names, and its header must meet `target`.
 */
export interface AuxBlock {
  /** The candidate's block hash, for `submitAuxBlock` and, once accepted, `getBlockHeader`. */
  readonly hash: string
  /** This chain's AuxPoW chain id: 47 on main, 31430 on the test chains and regtest. */
  readonly chainId: number
  readonly previousBlockHash: string
  readonly coinbaseValueBits: bigint
  readonly bits: string
  readonly height: number
  /** `bits` expanded. */
  readonly target: string
  readonly p2mrValidationWeight: P2mrValidationWeightRule
  readonly futureBlockTime: FutureBlockTimeRule
  /** The byte order the commitment must use. */
  readonly commitmentOrder: 'internal' | 'display'
  /** The height from which the order is `display`. */
  readonly commitmentActivationHeight: number
}

function parseAuxBlock(value: unknown): AuxBlock {
  const o = object(value, R)
  return compact<AuxBlock>({
    hash: field(o, 'hash', R, hash),
    chainId: field(o, 'chainid', R, integer(0, 0xffff)),
    previousBlockHash: field(o, 'previousblockhash', R, hash),
    coinbaseValueBits: field(o, 'coinbasevalue', R, bitsInteger),
    ...compactTargetFields(o, R),
    height: field(o, 'height', R, integer(1, 0x7fff_ffff)),
    p2mrValidationWeight: field(o, 'p2mr_validation_weight', R, parseP2mrValidationWeightRule),
    futureBlockTime: field(o, 'future_block_time', R, parseFutureBlockTimeRule),
    commitmentOrder: field(o, 'commitmentorder', R, oneOf(['internal', 'display'] as const)),
    commitmentActivationHeight: field(o, 'commitmentactivationheight', R, nonNegativeInteger),
  })
}

/**
 * Why qbit Core did not answer null to a block. Not every one is a refusal:
 *
 * - `duplicate`: the node has the block already, accepted or stored before; it
 *   says nothing of the tip.
 * - `inconclusive`: it was stored but not connected, as it is not on the best
 *   chain; no refusal, and nothing says it will win.
 * - `duplicate-invalid`: it is known and invalid.
 * - `duplicate-inconclusive`: from a proposal, known and not fully checked.
 * - `inconclusive-not-best-prevblk`: from a proposal, its parent is not the tip.
 * - `stale-prevblk`: from `submitauxblock`, no candidate is cached under the
 *   hash: its parent left the tip, it expired or was evicted, or it was accepted.
 * - `rejected`: refused without a reason.
 *
 * Any other is the consensus check that failed (`high-hash`, `bad-txnmrklroot`,
 * `bad-cb-amount`, `bad-auxpow-commitment`, `time-too-new` and so on) or one a
 * later qbit Core adds: open, as it says why, and the result keeps its meaning.
 */
export type BlockSubmissionReason =
  | 'duplicate'
  | 'duplicate-invalid'
  | 'duplicate-inconclusive'
  | 'inconclusive'
  | 'inconclusive-not-best-prevblk'
  | 'stale-prevblk'
  | 'rejected'
  | 'high-hash'
  | (string & {})
const BLOCK_SUBMISSION_REASONS: readonly BlockSubmissionReason[] = [
  'duplicate',
  'duplicate-invalid',
  'duplicate-inconclusive',
  'inconclusive',
  'inconclusive-not-best-prevblk',
  'stale-prevblk',
  'rejected',
  'high-hash',
]

/** Null for a block accepted (BIP22), or {@link BlockSubmissionReason}. Null does not say it became the tip. */
export type BlockSubmissionResult = null | BlockSubmissionReason

function parseBlockSubmission(value: unknown): BlockSubmissionResult {
  return value === null ? null : openOneOf(BLOCK_SUBMISSION_REASONS)(value, R)
}

/** What an unknown outcome names for a `call()`: the block submitted. */
function submittedBlockHash(method: string, first: string): string | undefined {
  // submitheader's hex is the 80-byte header alone; submitblock's starts with it.
  if (method === 'submitblock' || method === 'submitheader') return serializedBlockHash(first)
  return method === 'submitauxblock' && /^[0-9a-fA-F]{64}$/.test(first) ? first.toLowerCase() : undefined
}

function stringListParam(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of strings`)
  return ownElements(value, name).map((entry, i) => argString(entry, `${name}[${i}]`, { nonEmpty: true }))
}

// ---------------------------------------------------------------------------
// PQC signature budgets
// ---------------------------------------------------------------------------

/**
 * A PQC key's signature-budget state, or a state a later qbit Core adds, as it
 * is: treat one you do not know as at least `critical`.
 */
export type PqcLimitState = 'normal' | 'warning' | 'critical' | 'exhausted' | (string & {})
const PQC_LIMIT_STATES = ['normal', 'warning', 'critical', 'exhausted'] as const

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
  const limitState = openOneOf(PQC_LIMIT_STATES)
  return {
    pqcKeyStates: optional(o, 'pqc_key_states', R, (v, p) =>
      array(v, p, (entry, ep) => {
        const k = object(entry, ep)
        return compact<PqcKeyState>({
          pubkey: field(k, 'pubkey', ep, hex(32)),
          pqcSignatureCount: field(k, 'pqc_signature_count', ep, uint32),
          pqcSignatureLimit: field(k, 'pqc_signature_limit', ep, uint32),
          pqcSignaturesRemaining: field(k, 'pqc_signatures_remaining', ep, uint32),
          pqcLimitState: field(k, 'pqc_limit_state', ep, limitState),
        })
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
  /** Absent from a qbit Core that no longer reports `paytxfee`, which Bitcoin Core has deprecated. */
  readonly payTxFeeBitsPerKvB?: bigint
  readonly privateKeysEnabled: boolean
  readonly avoidReuse: boolean
  /** False when no rescan is running. */
  readonly scanning: false | { readonly duration: number; readonly progress: number }
  readonly descriptors: boolean
  /** Validation state of plaintext PQC key records. */
  readonly pqcKeyValidation: {
    /** Or a status a later qbit Core adds, as it is; `signingBlocked` says whether the wallet signs. */
    readonly status: 'not_required' | 'pending' | 'running' | 'complete' | 'failed' | (string & {})
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
  return compact<LastProcessedBlock>({
    hash: field(o, 'hash', path, hash),
    height: field(o, 'height', path, nonNegativeInteger),
  })
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
    payTxFeeBitsPerKvB: optional(o, 'paytxfee', R, amount),
    privateKeysEnabled: field(o, 'private_keys_enabled', R, boolean),
    avoidReuse: field(o, 'avoid_reuse', R, boolean),
    scanning: field(o, 'scanning', R, (s, sp) => {
      if (s === false) return false as const
      const scan = object(s, sp)
      return compact<{ readonly duration: number; readonly progress: number }>({
        duration: field(scan, 'duration', sp, nonNegativeInteger),
        progress: field(scan, 'progress', sp, finite(0, 1)),
      })
    }),
    descriptors: field(o, 'descriptors', R, boolean),
    pqcKeyValidation: compact<WalletInfo['pqcKeyValidation']>({
      status: field(v, 'status', vp, openOneOf(['not_required', 'pending', 'running', 'complete', 'failed'] as const)),
      progress: field(v, 'progress', vp, finite(0, 1)),
      plaintextRecords: field(v, 'plaintext_records', vp, nonNegativeInteger),
      pendingRecords: field(v, 'pending_records', vp, nonNegativeInteger),
      validatedRecords: field(v, 'validated_records', vp, nonNegativeInteger),
      failedRecords: field(v, 'failed_records', vp, nonNegativeInteger),
      signingBlocked: field(v, 'signing_blocked', vp, boolean),
      encryptionRecommended: field(v, 'encryption_recommended', vp, boolean),
    }),
    externalSigner: field(o, 'external_signer', R, boolean),
    blank: field(o, 'blank', R, boolean),
    birthtime: optional(o, 'birthtime', R, nonNegativeInteger),
    flags: field(o, 'flags', R, (f, fp) => array(f, fp, string)),
    lastProcessedBlock: field(o, 'lastprocessedblock', R, parseLastProcessedBlock),
  })
}

/**
 * Closed: an entry of another category fails validation, as the sign and fee
 * checks depend on it, and so do the sums of what a wallet received and sent.
 */
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

const LIST_UNSPENT_OPTIONS = keysOf<ListUnspentOptions>({
  minConf: true,
  maxConf: true,
  addresses: true,
  includeUnsafe: true,
  minimumAmountBits: true,
  maximumAmountBits: true,
  maximumCount: true,
  minimumSumAmountBits: true,
  includeImmatureCoinbase: true,
})

/**
 * The fields beside `txid` and `vout` of each typed result that is also an
 * outpoint: a `listUnspent()` entry, a decoded transaction input, and a
 * `listSinceBlock()` or `listTransactions()` entry. Allowed, and not read,
 * where an outpoint is expected, so such a result can be passed as it is.
 */
const OUTPOINT_EXTRAS = [
  ...new Set([
    ...keysOf<UnspentOutput>({
      txid: true,
      vout: true,
      address: true,
      label: true,
      scriptPubKey: true,
      amountBits: true,
      confirmations: true,
      ancestorCount: true,
      ancestorSize: true,
      ancestorFeesBits: true,
      redeemScript: true,
      witnessScript: true,
      spendable: true,
      solvable: true,
      reused: true,
      desc: true,
      parentDescs: true,
      safe: true,
    }),
    ...keysOf<Extract<TransactionInput, { readonly txid: string }>>({
      txid: true,
      vout: true,
      scriptSig: true,
      txinwitness: true,
      sequence: true,
    }),
    ...keysOf<WalletHistoryEntry>({
      address: true,
      category: true,
      amountBits: true,
      label: true,
      vout: true,
      feeBits: true,
      abandoned: true,
      parentDescs: true,
      confirmations: true,
      generated: true,
      trusted: true,
      blockHash: true,
      blockHeight: true,
      blockIndex: true,
      blockTime: true,
      txid: true,
      wtxid: true,
      walletConflicts: true,
      replacedByTxid: true,
      replacesTxid: true,
      mempoolConflicts: true,
      to: true,
      time: true,
      timeReceived: true,
      comment: true,
      bip125Replaceable: true,
    }),
  ]),
].filter(key => key !== 'txid' && key !== 'vout')

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
  /**
   * As the node encodes it: a bech32 or bech32m address in lowercase, a base58
   * address (which qbit Core v1.0.0 makes only on regtest with `-p2mronly=0`)
   * as it was requested.
   */
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
    // The node lowercases a bech32 address it was given in uppercase. Case is
    // part of a base58 address, so anything else must match exactly.
    const same =
      info.address === requestedAddress ||
      (isBech32Form(info.address) &&
        isBech32Form(requestedAddress) &&
        info.address.toLowerCase() === requestedAddress.toLowerCase())
    if (!same) throw new ResultIssue(`${R}.address`, 'the requested address')
    return info
  }
}

/**
 * Whether `address` has the form of a bech32 or bech32m string (BIP 173, BIP
 * 350), which may be written in either case: a human-readable part of
 * printable ASCII, the separator `1` and at least six data characters (the
 * checksum alone has six), all in one case. The checksum is left to the node.
 */
function isBech32Form(address: string): boolean {
  const lower = address.toLowerCase()
  if (address !== lower && address !== address.toUpperCase()) return false
  return /^[\x21-\x7e]+1[02-9ac-hj-np-z]{6,}$/.test(lower)
}

/** A transaction output: its txid and output index. */
export interface Outpoint {
  readonly txid: string
  readonly vout: number
}

function parseOutpoint(value: unknown, path: string): Outpoint {
  const o = object(value, path)
  return compact<Outpoint>({ txid: field(o, 'txid', path, hash), vout: field(o, 'vout', path, uint32) })
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
  /**
   * On a replaced transaction's entries, when `bumpfee` replaced it; it is
   * never cleared, so the original keeps it even if the original is the one
   * mined. A replacement sent with `sendRawTransaction` (as after
   * `psbtBumpFee`) sets neither this nor `replacesTxid`: the transactions list
   * each other in `walletConflicts` (and in `mempoolConflicts` while in the
   * mempool). Count an original and its replacements as one payment: the mined
   * one once one is mined (the others then have negative `confirmations`),
   * and otherwise once, as pending.
   */
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

const LIST_SINCE_BLOCK_OPTIONS = keysOf<ListSinceBlockOptions>({
  blockHash: true,
  targetConfirmations: true,
  includeWatchOnly: true,
  includeRemoved: true,
  includeChange: true,
})

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

const LIST_TRANSACTIONS_OPTIONS = keysOf<ListTransactionsOptions>({
  label: true,
  count: true,
  skip: true,
  includeWatchOnly: true,
})

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
  return compact<WalletBalances>({
    mine: compact<WalletBalances['mine']>({
      trustedBits: field(m, 'trusted', mp, amount),
      untrustedPendingBits: field(m, 'untrusted_pending', mp, amount),
      immatureBits: field(m, 'immature', mp, amount),
      usedBits: optional(m, 'used', mp, amount),
    }),
    lastProcessedBlock: field(o, 'lastprocessedblock', R, parseLastProcessedBlock),
  })
}

// ---------------------------------------------------------------------------
// Wallet write
// ---------------------------------------------------------------------------

/**
 * An address (output) type: the five qbit Core v1.0.0 parses
 * (`src/outputtype.cpp`); it refuses any other name with `RpcError` -5. Which
 * ones a wallet can make depends on the chain: main, test, testnet4 and signet
 * make only `p2mr`, and so does regtest unless qbitd runs with `-p2mronly=0`,
 * which allows all five. A type the chain does not allow is refused with
 * `RpcError` -5 too.
 */
export type AddressType = 'p2mr' | 'bech32m' | 'bech32' | 'p2sh-segwit' | 'legacy'
// A record, so the compiler requires every AddressType here exactly once.
const ADDRESS_TYPE_SET: Readonly<Record<AddressType, true>> = {
  p2mr: true,
  bech32m: true,
  bech32: true,
  'p2sh-segwit': true,
  legacy: true,
}
const ADDRESS_TYPES = Object.keys(ADDRESS_TYPE_SET) as AddressType[]

export type FundedPsbtOutput = { readonly address: string; readonly amountBits: bigint } | { readonly data: string }

export interface WalletCreateFundedPsbtArgs {
  /**
   * Inputs to spend; leave out to let the wallet select coins. `vout` is 0 to
   * 2,147,483,647 (qbit Core reads it as a signed 32-bit integer), `sequence`
   * 0 to 4,294,967,295.
   */
  readonly inputs?: readonly { readonly txid: string; readonly vout: number; readonly sequence?: number }[]
  /** At least one output. Each address once; at most one `data` (OP_RETURN) output. */
  readonly outputs: readonly FundedPsbtOutput[]
  /** 0 to 4,294,967,295. */
  readonly locktime?: number
  readonly options?: {
    readonly addInputs?: boolean
    readonly includeUnsafe?: boolean
    readonly minConf?: number
    readonly maxConf?: number
    readonly changeAddress?: string
    readonly changePosition?: number
    /** The change output's type; see {@link AddressType}. Default: the wallet's `-changetype`. */
    readonly changeType?: AddressType
    /** Lock the selected coins in the wallet until they are spent or unlocked. */
    readonly lockUnspents?: boolean
    /** An explicit fee rate in bits per 1,000 vbytes (`250n` is 0.25 bits/vB). Exclusive with `confTarget`. */
    readonly feeRateBitsPerKvB?: bigint
    /** Output indexes, before change is added, that pay the fee. */
    readonly subtractFeeFromOutputs?: readonly number[]
    /** The largest weight the transaction may have, 65 to 400,000 (qbit Core's standard limit, the default). */
    readonly maxTxWeight?: number
    readonly replaceable?: boolean
    readonly confTarget?: number
    readonly estimateMode?: FeeEstimateMode
  }
  readonly bip32derivs?: boolean
  /** The transaction version, 1 to 3: qbit Core refuses a non-standard one. Default 2. */
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
  return compact<FundedPsbt>({
    psbt: field(o, 'psbt', R, base64),
    feeBits: field(o, 'fee', R, amount),
    changePos: field(o, 'changepos', R, integer(-1, Number.MAX_SAFE_INTEGER)),
  })
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

export interface PsbtBumpFeeOptions {
  /**
   * The new fee rate in bits per 1,000 vbytes (`1250n` is 1.25 bits/vB): at
   * least the original's plus the node's incremental relay fee. Exclusive with
   * `confTarget` and `estimateMode`. Default: the wallet's estimate.
   */
  readonly feeRateBitsPerKvB?: bigint
  /** Blocks for the wallet's estimate, 1 to 1,008. Default: the wallet's `-txconfirmtarget`. */
  readonly confTarget?: number
  readonly estimateMode?: FeeEstimateMode
  /** Default true: inputs signal BIP 125 (sequence 0xfffffffd); false sets 0xfffffffe. */
  readonly replaceable?: boolean
  /**
   * Outputs for the replacement instead of the original's, as
   * `walletCreateFundedPsbt` takes them. Without the original's change
   * address among them, the rest goes to a new change key. Exclusive with
   * `originalChangeIndex`.
   */
  readonly outputs?: readonly FundedPsbtOutput[]
  /**
   * The original output that pays for the bump and takes the rest, whatever it
   * pays: pointing it at a payment makes that payment smaller. Default: the
   * change output the wallet recognises.
   */
  readonly originalChangeIndex?: number
}

/** `psbtbumpfee`: an unsigned replacement. */
export interface BumpedPsbt {
  /** Spends every input of the original, and maybe more. Sign it with `walletProcessPsbt`. */
  readonly psbt: string
  /** The original's fee. */
  readonly originalFeeBits: bigint
  /**
   * The replacement's fee. With `outputs` and no `feeRateBitsPerKvB`, it can
   * be at most `originalFeeBits`, and the mempool then refuses the
   * replacement (`RpcError` -26).
   */
  readonly feeBits: bigint
  /** qbit Core v1.0.0 returned none with a PSBT in any case checked; it rejects the call instead. */
  readonly errors: readonly string[]
}

function parseBumpedPsbt(value: unknown): BumpedPsbt {
  const o = object(value, R)
  return compact<BumpedPsbt>({
    psbt: field(o, 'psbt', R, base64),
    originalFeeBits: field(o, 'origfee', R, amount),
    feeBits: field(o, 'fee', R, amount),
    errors: field(o, 'errors', R, strings),
  })
}

const parseNull = (value: unknown): null => nullValue(value, R)

/** `lockunspent`'s reply: it answers `true` or an error, never `false`. */
function parseTrue(value: unknown): true {
  if (value !== true) throw new ResultIssue(R, 'true')
  return true
}

/** An address the wallet returns: bech32 or base58 characters only. */
function parseAddress(value: unknown, path = R): string {
  if (typeof value !== 'string' || !/^[0-9A-Za-z]+$/.test(value)) throw new ResultIssue(path, 'an address')
  return value
}

// ---------------------------------------------------------------------------
// Wallet administration
// ---------------------------------------------------------------------------

/** `createwallet` and `loadwallet`: the wallet's name, as it was asked for, and any warnings. */
export interface LoadedWallet {
  /** The name or path passed, which names the wallet from then on. */
  readonly name: string
  readonly warnings?: readonly string[]
}

function parseLoadedWallet(requestedName: string): (value: unknown) => LoadedWallet {
  return value => {
    const o = object(value, R)
    const name = field(o, 'name', R, string)
    if (name !== requestedName) throw new ResultIssue(`${R}.name`, 'the requested wallet name')
    return compact<LoadedWallet>({ name, warnings: optional(o, 'warnings', R, strings) })
  }
}

/** `unloadwallet`: any warnings, such as about a startup list it could not update. */
export interface UnloadedWallet {
  readonly warnings?: readonly string[]
}

function parseUnloadedWallet(value: unknown): UnloadedWallet {
  return compact<UnloadedWallet>({ warnings: optional(object(value, R), 'warnings', R, strings) })
}

/** A wallet in the node's wallet directory (`listwalletdir`), loaded or not. */
export interface WalletDirEntry {
  readonly name: string
  /** Such as a legacy wallet's, which must be migrated before it loads. */
  readonly warnings?: readonly string[]
}

function parseWalletDir(value: unknown): WalletDirEntry[] {
  const wallet = (entry: unknown, path: string): WalletDirEntry => {
    const o = object(entry, path)
    return compact<WalletDirEntry>({
      name: field(o, 'name', path, string),
      warnings: optional(o, 'warnings', path, strings),
    })
  }
  return field(object(value, R), 'wallets', R, (v, p) => array(v, p, wallet))
}

/** One descriptor for `importDescriptors`. */
export interface DescriptorImport {
  /**
   * The descriptor, with its checksum. It can hold private keys: see
   * {@link https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/wallet-admin.md#descriptors | Descriptors}.
   */
  readonly desc: string
  /**
   * Unix time in seconds from which to rescan for the descriptor's
   * transactions, 0 for the whole chain, or `'now'`, the tip's median time,
   * for keys never used. The call rescans once, from 2 hours before the
   * earliest of its descriptors' timestamps and the tip's time: always the
   * last 2 hours of blocks at least.
   */
  readonly timestamp: number | 'now'
  /** Make it the active descriptor of its output type, receiving or (with `internal`) change. Ranged only. */
  readonly active?: boolean
  /** The indexes to derive, for a ranged descriptor (one with `*`); left out, the first `-keypool` (1,000). */
  readonly range?: DescriptorRange
  /**
   * The next index to hand out, for a ranged descriptor: within `range`, which
   * it needs, as the default range depends on the node's `-keypool`.
   */
  readonly nextIndex?: number
  /** Treat its outputs as change. Not for a multipath descriptor, whose second path is the change one. */
  readonly internal?: boolean
  /** A label for its address: only for a descriptor without a range or multipath that is not `internal`. */
  readonly label?: string
}

/** The node's answer to one descriptor of `importDescriptors`. */
export type DescriptorImportResult =
  | { readonly success: true; readonly warnings?: readonly string[] }
  | {
      readonly success: false
      /** The node's error for this descriptor, its message redacted of key material. */
      readonly error: { readonly rpcCode: number; readonly message: string }
      readonly warnings?: readonly string[]
    }

const DESCRIPTOR_IMPORT = keysOf<DescriptorImport>({
  desc: true,
  timestamp: true,
  active: true,
  range: true,
  nextIndex: true,
  internal: true,
  label: true,
})

/**
 * `importdescriptors`' requests, refusing before sending what qbit Core v1.0.0
 * would refuse or ignore for one descriptor while importing the others:
 * `range`, `nextIndex` and `active` without a range (`*`), `nextIndex` without
 * `range` or outside it, a label on a ranged, multipath or internal descriptor,
 * the label `*`, and `internal` on a multipath one.
 */
function descriptorImportsParam(value: unknown): { readonly desc: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('descriptors must be a non-empty array of { desc, timestamp, ... }')
  }
  return ownElements(value, 'descriptors').map((entry: unknown, i) => {
    const name = `descriptors[${i}]`
    const o = argOptions(entry, name, DESCRIPTOR_IMPORT)
    const desc = argDescriptor(o['desc'], `${name}.desc`, true)
    const timestamp = o['timestamp']
    if (timestamp !== 'now') {
      // Block times are uint32 seconds: a larger value is most likely milliseconds.
      if (
        typeof timestamp !== 'number' ||
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        timestamp > 0xffff_ffff
      ) {
        throw new RangeError(`${name}.timestamp must be 'now' or Unix time in seconds, an integer from 0 to 4294967295`)
      }
    }
    const range = opt(o['range'], v => rangeParam(v, `${name}.range`))
    const nextIndex = opt(o['nextIndex'], v => argInteger(v, `${name}.nextIndex`, 0, 0x7fff_ffff))
    const active = opt(o['active'], v => argBoolean(v, `${name}.active`))
    const internal = opt(o['internal'], v => argBoolean(v, `${name}.internal`))
    const label = opt(o['label'], v => argString(v, `${name}.label`))
    if (!isRanged(desc)) {
      if (range !== undefined || nextIndex !== undefined || active === true) {
        throw new TypeError(`${name}: range, nextIndex and active are for a ranged descriptor, one with *`)
      }
    } else if (label !== undefined) {
      throw new TypeError(`${name}.label is for a descriptor without *: qbit Core refuses it with a range`)
    }
    if (nextIndex !== undefined && range === undefined && isRanged(desc)) {
      // Without range qbit Core uses [0, -keypool) (src/wallet/rpc/backup.cpp:879-881), which the client
      // cannot know, and refuses a nextIndex outside it for this descriptor while importing the others.
      throw new TypeError(
        `${name}.nextIndex needs range: without it qbit Core derives the node's -keypool keys, which this client cannot check nextIndex against`
      )
    }
    if (range !== undefined && nextIndex !== undefined && (nextIndex < range[0] || nextIndex > range[1])) {
      throw new RangeError(`${name}.nextIndex must be within range`)
    }
    if (isMultipath(desc) && (label !== undefined || internal !== undefined)) {
      throw new TypeError(`${name}: a multipath descriptor takes neither label nor internal; its second path is change`)
    }
    if (label !== undefined && internal === true) throw new TypeError(`${name}.label is not for an internal descriptor`)
    if (label === '*') throw new RangeError(`${name}.label must not be *`)
    return {
      desc,
      ...compact<Record<string, unknown>>({ timestamp, active, range, next_index: nextIndex, internal, label }),
    }
  })
}

function parseDescriptorImports(
  count: number,
  secrets: readonly string[]
): (value: unknown) => DescriptorImportResult[] {
  // Redacted, then capped, as the client does an RpcError's message.
  const redacted = (v: unknown, p: string): string[] =>
    strings(v, p).map(text => redact(text, secrets).slice(0, MAX_NODE_MESSAGE))
  const result = (entry: unknown, path: string): DescriptorImportResult => {
    const o = object(entry, path)
    const success = field(o, 'success', path, boolean)
    const warned = optional(o, 'warnings', path, redacted)
    const error = optional(o, 'error', path, (v, p) => {
      const e = object(v, p)
      return compact<{ readonly rpcCode: number; readonly message: string }>({
        rpcCode: field(e, 'code', p, int32),
        message: redact(field(e, 'message', p, string), secrets).slice(0, MAX_NODE_MESSAGE),
      })
    })
    if (success) {
      if (error !== undefined) throw new ResultIssue(`${path}.error`, 'no error, for a success')
      return compact<Extract<DescriptorImportResult, { readonly success: true }>>({ success, warnings: warned })
    }
    if (error === undefined) throw new ResultIssue(`${path}.error`, 'the error of a failure (the field is missing)')
    return compact<Extract<DescriptorImportResult, { readonly success: false }>>({ success, error, warnings: warned })
  }
  return value => {
    const results = array(value, R, result)
    if (results.length !== count) throw new ResultIssue(R, `${count} results, one per descriptor`)
    return results
  }
}

/** `rescanblockchain`: the heights it scanned. */
export interface RescanResult {
  readonly startHeight: number
  /** The last block scanned; null in the rare case a reorg left it no block to scan. */
  readonly stopHeight: number | null
}

function parseRescan(startHeight: number, stopHeight: number | undefined): (value: unknown) => RescanResult {
  return value => {
    const o = object(value, R)
    const start = field(o, 'start_height', R, int32)
    if (start !== startHeight) throw new ResultIssue(`${R}.start_height`, 'the requested start height')
    const last = integer(start, stopHeight ?? 0x7fff_ffff)
    return compact<RescanResult>({
      startHeight: start,
      stopHeight: field(o, 'stop_height', R, (v, p) => (v === null ? null : last(v, p))),
    })
  }
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

const FUNDED_PSBT_ARGS = keysOf<WalletCreateFundedPsbtArgs>({
  inputs: true,
  outputs: true,
  locktime: true,
  options: true,
  bip32derivs: true,
  version: true,
})

const FUNDED_PSBT_OPTIONS = keysOf<NonNullable<WalletCreateFundedPsbtArgs['options']>>({
  addInputs: true,
  includeUnsafe: true,
  minConf: true,
  maxConf: true,
  changeAddress: true,
  changePosition: true,
  changeType: true,
  lockUnspents: true,
  feeRateBitsPerKvB: true,
  subtractFeeFromOutputs: true,
  maxTxWeight: true,
  replaceable: true,
  confTarget: true,
  estimateMode: true,
})

const PSBT_BUMP_FEE_OPTIONS = keysOf<PsbtBumpFeeOptions>({
  feeRateBitsPerKvB: true,
  confTarget: true,
  estimateMode: true,
  replaceable: true,
  outputs: true,
  originalChangeIndex: true,
})

const DATA_PQC_HASH_PROOF = keysOf<DataPqcHashProof>({
  address: true,
  messageHash: true,
  signature: true,
  pubkey: true,
  leafScript: true,
  controlBlock: true,
  leafVersion: true,
  proofMode: true,
})

/** The fields of a `signDataPqcHash()` result beyond its proof: allowed, and not read, by `verifyDataPqcHash`. */
const DATA_PQC_HASH_SIGNATURE_EXTRAS = keysOf<DataPqcHashSignature>({
  address: true,
  messageHash: true,
  signature: true,
  pubkey: true,
  leafScript: true,
  controlBlock: true,
  leafVersion: true,
  proofMode: true,
  datasigHash: true,
  domain: true,
  algorithm: true,
  p2mrMerkleRoot: true,
  warnings: true,
  pqcKeyStates: true,
  pqcOverallLimitState: true,
  pqcSignatureCount: true,
  pqcSignatureLimit: true,
  pqcSignaturesRemaining: true,
  pqcLimitState: true,
}).filter(key => !DATA_PQC_HASH_PROOF.includes(key))

/**
 * A P2MR control block as qbit Core v1.0.0 takes it: the control byte, then
 * up to 128 32-byte nodes (`P2MR_CONTROL_*`, src/script/interpreter.h); lowercased.
 */
function controlBlockParam(value: unknown, name: string): string {
  const block = argHex(value, name)
  if ((block.length / 2 - 1) % 32 !== 0 || block.length / 2 > 1 + 32 * 128) {
    throw new TypeError(`${name} must be 1 + 32 × n bytes, n from 0 to 128`)
  }
  return block.toLowerCase()
}

function fundedPsbtOptions(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const o = argOptions(value, 'args.options', FUNDED_PSBT_OPTIONS)
  // argOptions read each option once, so a getter cannot pass the check below and then send both.
  const feeRate = o['feeRateBitsPerKvB']
  const confTarget = o['confTarget']
  const estimateMode = o['estimateMode']
  if (feeRate !== undefined && (confTarget !== undefined || estimateMode !== undefined)) {
    throw new TypeError('args.options.feeRateBitsPerKvB excludes args.options.confTarget and args.options.estimateMode')
  }
  // Key names as qbit Core v1.0.0's walletcreatefundedpsbt reads them. Its
  // option type check also accepts some aliases it then ignores (for example
  // subtract_fee_from_outputs), so each name here was checked against a live
  // node: see test/regtest/smoke.test.ts.
  const out = compact<Record<string, unknown>>({
    add_inputs: opt(o['addInputs'], v => argBoolean(v, 'args.options.addInputs')),
    include_unsafe: opt(o['includeUnsafe'], v => argBoolean(v, 'args.options.includeUnsafe')),
    minconf: opt(o['minConf'], v => argInteger(v, 'args.options.minConf', 0, 0x7fff_ffff)),
    maxconf: opt(o['maxConf'], v => argInteger(v, 'args.options.maxConf', 0, 0x7fff_ffff)),
    change_address: opt(o['changeAddress'], v => argString(v, 'args.options.changeAddress', { nonEmpty: true })),
    change_position: opt(o['changePosition'], v => argInteger(v, 'args.options.changePosition', 0, 0x7fff_ffff)),
    change_type: opt(o['changeType'], v => argOneOf(v, 'args.options.changeType', ADDRESS_TYPES)),
    lock_unspents: opt(o['lockUnspents'], v => argBoolean(v, 'args.options.lockUnspents')),
    fee_rate: opt(feeRate, v => feeRateParam(v, 'args.options.feeRateBitsPerKvB')),
    subtractFeeFromOutputs: opt(o['subtractFeeFromOutputs'], v =>
      argArray(v, 'args.options.subtractFeeFromOutputs').map((index, i) =>
        argInteger(index, `args.options.subtractFeeFromOutputs[${i}]`, 0, 0x7fff_ffff)
      )
    ),
    // MIN_STANDARD_TX_NONWITNESS_SIZE (65) times WITNESS_SCALE_FACTOR (1) to MAX_STANDARD_TX_WEIGHT.
    max_tx_weight: opt(o['maxTxWeight'], v => argInteger(v, 'args.options.maxTxWeight', 65, 400_000)),
    replaceable: opt(o['replaceable'], v => argBoolean(v, 'args.options.replaceable')),
    conf_target: opt(confTarget, v => argInteger(v, 'args.options.confTarget', 1, 1008)),
    estimate_mode: opt(estimateMode, v => argOneOf(v, 'args.options.estimateMode', FEE_MODES)),
  })
  return out
}

/**
 * `outputs` as `walletcreatefundedpsbt` and `psbtbumpfee` take them: a
 * non-empty array of `{ address, amountBits }`, sent as `{ [address]: amount }`,
 * or `{ data }`.
 */
function outputsParam(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${name} must be a non-empty array`)
  return ownElements(value, name).map((output, i) => {
    const p = argOptions(output, `${name}[${i}]`, ['address', 'amountBits', 'data'])
    // Each field is read once, so the either/or check and the output sent see the same values.
    const { address: addressField, amountBits, data } = p
    if (data !== undefined) {
      if (addressField !== undefined || amountBits !== undefined) {
        throw new TypeError(`${name}[${i}] must be either { address, amountBits } or { data }`)
      }
      return { data: argHex(data, `${name}[${i}].data`) }
    }
    const address = argString(addressField, `${name}[${i}].address`, { nonEmpty: true })
    return { [address]: qbtParam(amountBits, `${name}[${i}].amountBits`) }
  })
}

/** The outputs of `lockunspent` and `gettxspendingprevout`: a non-empty array of outpoints, each as `{ txid, vout }`. */
function outpointsParam(value: unknown): { txid: string; vout: number }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RangeError('outputs must be a non-empty array of { txid, vout }')
  }
  return ownElements(value, 'outputs').map((output, i) => {
    const p = argOptions(output, `outputs[${i}]`, ['txid', 'vout'], { ignored: OUTPOINT_EXTRAS })
    return {
      txid: argHash(p['txid'], `outputs[${i}].txid`),
      // qbit Core reads it as an int and refuses a negative one.
      vout: argInteger(p['vout'], `outputs[${i}].vout`, 0, 0x7fff_ffff),
    }
  })
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
   * `JsonNumber`. For `sendrawtransaction` and `submitpackage` the txids are
   * computed from the hex, as the typed methods do, and for `submitblock`,
   * `submitheader` (opened with `extraMethods`) and `submitauxblock` the block
   * hash, so an unknown outcome still names them. For a long poll
   * (`waitfornewblock`, `waitforblockheight`, `waitforblock`) the wait is read
   * from its timeout parameter, which must be 1 to 3,590,000 ms: absent or 0,
   * the node would wait with no end, so it is a `RangeError`. The call's
   * deadline is then at least the wait plus 10 s, as for the typed long polls.
   * When the client sends it, it refuses an option qbit Core accepts and then
   * ignores (a `TypeError`), and redacts the node's error about
   * `importdescriptors`, `deriveaddresses` or `getdescriptorinfo` of the key
   * material of the descriptors sent, as for the typed methods; an
   * `importdescriptors` result is the node's as it is, and can quote a
   * descriptor in full.
   *
   * The params are serialized here, once, and the request holds them as they
   * will be sent: parsed back without loss, every number a `JsonNumber` and
   * every object without a prototype. So a `toJSON` or a getter in them runs
   * once, and what the client checks when it sends them is what it sends; the
   * txids and the wait are read from them too. The depth limit counts the
   * request envelope they are sent in, as `call()` sends them; `batch()`
   * refuses an entry its array takes over the limit.
   */
  raw(method: string, params: readonly unknown[] = []): RpcRequest<unknown> {
    argString(method, 'method', { nonEmpty: true })
    const list = parseJsonLossless(stringifyRequest(argArray(params, 'params'), 1)) as unknown[]
    const parse = (result: unknown): unknown => result
    const hexTx = list[0]
    const txid = method === 'sendrawtransaction' && typeof hexTx === 'string' ? rawTransactionTxid(hexTx) : undefined
    const txids =
      method === 'submitpackage' && Array.isArray(hexTx) && hexTx.length > 0 ? packageTxids(hexTx) : undefined
    // A long poll is bounded by its own wait, as a typed one is; without one the node waits for ever.
    const waitParam = Object.hasOwn(LONG_POLL_WAIT_PARAM, method) ? LONG_POLL_WAIT_PARAM[method]! : undefined
    let waitMs: number | undefined
    if (waitParam !== undefined) {
      // As sent: a number is a JsonNumber here, and the snapshot has no holes.
      const sent = waitParam < list.length ? list[waitParam] : undefined
      const wait = sent instanceof JsonNumber ? sent.toNumber() : sent
      if (wait === undefined || wait === null || wait === 0) {
        throw new RangeError(
          `${method} without a timeout, or with 0, waits with no end and holds a qbitd worker meanwhile: pass a timeout in ms as params[${waitParam}], from 1 to ${MAX_LONG_POLL_WAIT_MS}`
        )
      }
      waitMs = argWaitMs(wait, `params[${waitParam}] (${method}'s timeout)`)
    }
    // BIP22's long poll has no timeout at all: the node holds the request, and its worker, until the tip or mempool changes.
    const template = method === 'getblocktemplate' ? list[0] : undefined
    if (typeof template === 'object' && template !== null && Object.hasOwn(template, 'longpollid')) {
      throw new TypeError(
        'getblocktemplate with longpollid waits with no end and holds a qbitd worker meanwhile: wait for a block with the ZMQ hashblock topic or waitfornewblock, then ask again'
      )
    }
    const blockHash = typeof hexTx === 'string' ? submittedBlockHash(method, hexTx) : undefined
    return Object.freeze(
      compact<RpcRequest<unknown>>({
        method,
        params: list,
        parse,
        txid,
        txids: txids === undefined ? undefined : Object.freeze(txids),
        waitMs,
        blockHash,
      })
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
  /**
   * `getblock` at verbosity 1: the header's fields, sizes and txids, checked
   * against `blockHash`. `RpcError` -5 for an unknown block; -1 for one pruned,
   * or whose witness data was pruned.
   */
  getBlock(blockHash: string): RpcRequest<Block> {
    const requested = argHash(blockHash, 'blockHash')
    return request('getblock', [requested, 1], parseBlock(requested, hash))
  },
  /**
   * `getblock` at verbosity 2: as {@link requests.getBlock}, each transaction
   * decoded. A full block's reply can pass the client's `maxResponseBytes`; see
   * {@link https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/reading-the-chain.md#large-replies | Large replies}.
   */
  getBlockWithTransactions(blockHash: string): RpcRequest<BlockWithTransactions> {
    const requested = argHash(blockHash, 'blockHash')
    return request('getblock', [requested, 2], parseBlock(requested, parseBlockTransaction))
  },
  /**
   * `getblock` at verbosity 0: the block as stored, as hex, its header checked
   * to hash to `blockHash`. A block whose witness data was pruned comes without
   * it.
   */
  getBlockHex(blockHash: string): RpcRequest<string> {
    const requested = argHash(blockHash, 'blockHash')
    return request('getblock', [requested, 0], v => {
      const returned = hex()(v, R)
      if (serializedBlockHash(returned) !== requested) throw new ResultIssue(R, 'the requested block')
      return returned
    })
  },
  /** Every block tip the node knows: the active chain's, once, and those of other branches. */
  getChainTips: (): RpcRequest<ChainTip[]> => request('getchaintips', [], parseChainTips),
  /**
   * Hold the request until the tip differs from `options.currentTip` (left out,
   * from the tip when the node runs the call: a block found between two calls
   * is missed, and the client does not retry it) or `waitMs` (1 to 3,590,000)
   * has passed, then return the tip. A returned tip equal to the one passed
   * means the wait ran out. A tip that is not the node's returns at once. See
   * {@link https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/reading-the-chain.md#long-polls | Long polls}.
   */
  waitForNewBlock(waitMs: number, options?: { readonly currentTip?: string }): RpcRequest<BlockRef> {
    const o = methodOptions(options, ['currentTip'])
    const wait = argWaitMs(waitMs)
    return request(
      'waitfornewblock',
      [wait, opt(o['currentTip'], v => argHash(v, 'options.currentTip'))],
      parseBlockRef,
      {
        waitMs: wait,
      }
    )
  },
  /**
   * Hold the request until the tip reaches `height` or `waitMs` (1 to
   * 3,590,000) has passed, then return the tip. A returned height below
   * `height` means the wait ran out, so it is not refused. See
   * {@link https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/reading-the-chain.md#long-polls | Long polls}.
   */
  waitForBlockHeight(height: number, waitMs: number): RpcRequest<BlockRef> {
    const wait = argWaitMs(waitMs)
    return request('waitforblockheight', [argInteger(height, 'height', 0, 0x7fff_ffff), wait], parseBlockRef, {
      waitMs: wait,
    })
  },
  /**
   * The serialized transaction as hex, checked to hash to `txid`. Without
   * `-txindex`, only mempool transactions or ones in `blockHash`.
   */
  getRawTransaction(txid: string, options?: { readonly blockHash?: string }): RpcRequest<string> {
    const o = methodOptions(options, ['blockHash'])
    const requested = argHash(txid, 'txid')
    return request(
      'getrawtransaction',
      [requested, 0, opt(o['blockHash'], v => argHash(v, 'options.blockHash'))],
      v => {
        const returned = hex()(v, R)
        if (rawTransactionTxid(returned) !== requested) throw new ResultIssue(R, 'the requested transaction')
        return returned
      }
    )
  },
  /** The decoded transaction (verbosity 1). */
  getRawTransactionVerbose(txid: string, options?: { readonly blockHash?: string }): RpcRequest<DecodedTransaction> {
    const o = methodOptions(options, ['blockHash'])
    const requested = argHash(txid, 'txid')
    return request(
      'getrawtransaction',
      [requested, 1, opt(o['blockHash'], v => argHash(v, 'options.blockHash'))],
      parseDecodedTransaction(requested)
    )
  },
  getMempoolInfo: (): RpcRequest<MempoolInfo> => request('getmempoolinfo', [], parseMempoolInfo),
  /** The txids in the mempool. */
  getRawMempool: (): RpcRequest<string[]> => request('getrawmempool', [false], v => array(v, R, hash)),
  /** Every mempool entry, by txid. A full mempool's reply can pass the client's `maxResponseBytes`. */
  getRawMempoolVerbose: (): RpcRequest<Record<string, MempoolEntry>> =>
    request('getrawmempool', [true], v => hashKeyed(v, R, parseMempoolEntry)),
  /** The txids in the mempool and the mempool sequence they stand at, to line up with the ZMQ `sequence` topic. */
  getRawMempoolSequence: (): RpcRequest<MempoolSnapshot> =>
    request('getrawmempool', [false, true], parseMempoolSnapshot),
  /**
   * Which mempool transaction spends each output, checked against `outputs`,
   * one entry per output in order. The mempool only: an output spent in a block
   * and one never spent look alike.
   */
  getTxSpendingPrevout(outputs: readonly Outpoint[]): RpcRequest<TxSpendingPrevout[]> {
    const checked = outpointsParam(outputs)
    return request('gettxspendingprevout', [checked], parseTxSpendingPrevouts(checked))
  },
  /** Rejects with `RpcError` code -5 when the transaction is not in the mempool. */
  getMempoolEntry: (txid: string): RpcRequest<MempoolEntry> =>
    request('getmempoolentry', [argHash(txid, 'txid')], parseMempoolEntry),
  /**
   * An unspent output, or null when it is spent or does not exist. With
   * `includeMempool` (the node's default, true), outputs of mempool
   * transactions are found and outputs spent in the mempool are not. `vout`
   * is 0 to 4,294,967,295: qbit Core reads it as an unsigned 32-bit integer.
   */
  getTxOut(txid: string, vout: number, options?: { readonly includeMempool?: boolean }): RpcRequest<TxOut | null> {
    const o = methodOptions(options, ['includeMempool'])
    return request(
      'gettxout',
      [
        argHash(txid, 'txid'),
        argInteger(vout, 'vout', 0, 0xffff_ffff),
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
    const o = methodOptions(options, ['securityLevel', 'mergeMiningPct', 'btcHashrate'])
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
    const o = methodOptions(options, ['mode'])
    return request(
      'estimatesmartfee',
      [argInteger(confTarget, 'confTarget', 1, 1008), opt(o['mode'], v => argOneOf(v, 'options.mode', FEE_MODES))],
      parseSmartFee
    )
  },

  validateAddress: (address: string): RpcRequest<AddressValidation> =>
    request('validateaddress', [argString(address, 'address')], parseAddressValidation),
  /** Takes a `signDataPqcHash()` result as it is: its fields beyond the proof's are allowed, and not read. */
  verifyDataPqcHash(proof: DataPqcHashProof): RpcRequest<DataPqcHashVerification> {
    const p = argOptions(proof, 'proof', DATA_PQC_HASH_PROOF, {
      ignored: DATA_PQC_HASH_SIGNATURE_EXTRAS,
      callOptions: true,
    })
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
  /**
   * Analyse a descriptor: its canonical form, without private keys, and its
   * checksum, checked here against the descriptor. The checksum may be left
   * out. A descriptor can hold private keys: they travel only in the request
   * body, and the node's error, which can quote a key, is redacted.
   */
  getDescriptorInfo(descriptor: string): RpcRequest<DescriptorInfo> {
    const desc = argDescriptor(descriptor, 'descriptor', false)
    return request('getdescriptorinfo', [desc], parseDescriptorInfo(desc))
  },
  /**
   * The addresses a descriptor derives, one per index of `range`, which a
   * ranged descriptor (one with `*`) needs and any other refuses. The
   * descriptor needs its checksum. On a P2MR chain a ranged descriptor derives
   * from private key material, `pqc(<xprv>/...)`: it is redacted from the
   * node's error as `getDescriptorInfo`'s is. A multipath descriptor (`<0;1>`)
   * is refused: derive each of `getDescriptorInfo()`'s `multipathExpansion`.
   */
  deriveAddresses(descriptor: string, options?: { readonly range?: DescriptorRange }): RpcRequest<string[]> {
    const desc = argDescriptor(descriptor, 'descriptor', true)
    if (isMultipath(desc)) {
      throw new TypeError(
        "descriptor must not be multipath (<0;1>): derive each path's descriptor, getDescriptorInfo()'s multipathExpansion"
      )
    }
    const o = methodOptions(options, ['range'])
    const range = opt(o['range'], v => rangeParam(v, 'options.range'))
    if (isRanged(desc) !== (range !== undefined)) {
      throw new TypeError(
        range === undefined
          ? 'options.range is required for a ranged descriptor, one with *'
          : 'options.range is only for a ranged descriptor, one with *'
      )
    }
    return request(
      'deriveaddresses',
      [desc, range],
      parseDerivedAddresses(desc, range === undefined ? 1 : rangeSize(range))
    )
  },

  /**
   * Whether the mempool would accept each transaction, without broadcasting.
   * `maxFeeRateBitsPerKvB` caps the fee rate, 1n to 99,999,999n bits per 1,000
   * vbytes; left out, qbit Core's default cap of 0.1 QBT/kvB (10,000,000n)
   * applies. 0n is refused: qbit Core reads 0 as no cap at all.
   */
  testMempoolAccept(
    rawTxs: readonly string[],
    options?: { readonly maxFeeRateBitsPerKvB?: bigint }
  ): RpcRequest<MempoolAcceptance[]> {
    const txs = packageParam(rawTxs)
    const o = methodOptions(options, ['maxFeeRateBitsPerKvB'])
    return request(
      'testmempoolaccept',
      [txs, opt(o['maxFeeRateBitsPerKvB'], v => maxFeeRateParam(v, 'options.maxFeeRateBitsPerKvB'))],
      parseMempoolAcceptance(txs)
    )
  },
  /**
   * Returns the txid. A failure after the request may have reached the node is
   * an `RpcUnknownOutcomeError`. `maxFeeRateBitsPerKvB` caps the fee rate, 1n
   * to 99,999,999n bits per 1,000 vbytes; left out, qbit Core's default cap of
   * 0.1 QBT/kvB (10,000,000n) applies. 0n is refused: qbit Core reads 0 as no
   * cap at all. `maxBurnAmountBits` (default 0n) is the most the transaction
   * may send to provably unspendable outputs.
   */
  sendRawTransaction(
    hexTx: string,
    options?: { readonly maxFeeRateBitsPerKvB?: bigint; readonly maxBurnAmountBits?: bigint }
  ): RpcRequest<string> {
    const tx = argHex(hexTx, 'hex')
    const o = methodOptions(options, ['maxFeeRateBitsPerKvB', 'maxBurnAmountBits'])
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
      txid === undefined ? {} : { txid }
    )
  },
  /**
   * Submit up to 25 signed transactions as one package, parents first and the
   * child last, so a child's fee can pay for its parents (CPFP). A refusal is
   * in the result, and may be partial: see {@link PackageSubmission}. A failure
   * after the request may have reached the node is an `RpcUnknownOutcomeError`
   * naming the package in `txids`. `maxFeeRateBitsPerKvB` and
   * `maxBurnAmountBits` are as for {@link requests.sendRawTransaction}, each
   * transaction checked: 0n as a fee-rate cap is refused.
   */
  submitPackage(
    rawTxs: readonly string[],
    options?: { readonly maxFeeRateBitsPerKvB?: bigint; readonly maxBurnAmountBits?: bigint }
  ): RpcRequest<PackageSubmission> {
    const txs = packageParam(rawTxs)
    const o = methodOptions(options, ['maxFeeRateBitsPerKvB', 'maxBurnAmountBits'])
    const txids = packageTxids(txs)
    return request(
      'submitpackage',
      [
        txs,
        opt(o['maxFeeRateBitsPerKvB'], v => maxFeeRateParam(v, 'options.maxFeeRateBitsPerKvB')),
        opt(o['maxBurnAmountBits'], v => qbtParam(v, 'options.maxBurnAmountBits')),
      ],
      parsePackageSubmission(txs, txids),
      { txids: Object.freeze(txids) }
    )
  },

  getMiningInfo: (): RpcRequest<MiningInfo> => request('getmininginfo', [], parseMiningInfo),
  /**
   * The data to build the next permissionless block from. `rules` are those the
   * miner understands, `['segwit']` by default (`QbitRpcClient.getBlockTemplate`
   * adds `signet` on signet); it must hold `segwit`, which qbit Core requires,
   * and on signet also `signet`. qbit Core v1.0.0 does not
   * read `capabilities`. On main, `RpcError` -9 with no peers and -10 while the
   * node syncs. See {@link https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/mining.md | Mining}.
   */
  getBlockTemplate(options?: {
    readonly rules?: readonly string[]
    readonly capabilities?: readonly string[]
  }): RpcRequest<BlockTemplate> {
    const o = methodOptions(options, ['rules', 'capabilities'])
    const rules = o['rules'] === undefined ? ['segwit'] : stringListParam(o['rules'], 'options.rules')
    if (!rules.includes('segwit')) throw new RangeError("options.rules must hold 'segwit', which qbit Core requires")
    const capabilities = opt(o['capabilities'], v => stringListParam(v, 'options.capabilities'))
    return request(
      'getblocktemplate',
      [compact<Record<string, unknown>>({ mode: 'template', rules, capabilities })],
      parseBlockTemplate
    )
  },
  /**
   * `getblocktemplate` in `proposal` mode (BIP23): check a block before hashing
   * it, everything but its proof of work. Nothing changes at the node. Null if
   * it would be accepted on the tip, or the reason it would not.
   */
  checkBlockProposal(blockHex: string): RpcRequest<BlockSubmissionResult> {
    const data = argHex(blockHex, 'blockHex')
    return request('getblocktemplate', [{ mode: 'proposal', data }], parseBlockSubmission)
  },
  /**
   * Submit a solved block, whole, as hex. Null if it was accepted, or a
   * {@link BlockSubmissionReason}: `duplicate` and `inconclusive` are no
   * refusals. `RpcError` -22 for hex that does not decode as a block. A failure
   * after the request may have reached the node is an `RpcUnknownOutcomeError`
   * naming the block in `blockHash`, the hash of the hex's 80-byte header, when
   * it holds one. Look it up with `getBlockHeader`, or submit it again: a block
   * the node has answers `duplicate`.
   */
  submitBlock(blockHex: string): RpcRequest<BlockSubmissionResult> {
    const block = argHex(blockHex, 'blockHex')
    const blockHash = serializedBlockHash(block)
    return request('submitblock', [block], parseBlockSubmission, blockHash === undefined ? {} : { blockHash })
  },
  /**
   * Ask for a merge-mining candidate paying its coinbase to `payoutAddress`,
   * which must be a P2MR address (`RpcError` -5 otherwise). The reply does not
   * name the address, so nothing can check it against the request: the coinbase
   * shows it once the block is accepted. The node holds the candidate in a cache
   * until its parent leaves the tip, `-auxpowtemplateexpiry` or
   * `-auxpowtemplatecachelimit`. An unknown outcome names nothing: ask again.
   */
  createAuxBlock(payoutAddress: string): RpcRequest<AuxBlock> {
    return request('createauxblock', [argString(payoutAddress, 'payoutAddress', { nonEmpty: true })], parseAuxBlock)
  },
  /**
   * Submit the AuxPoW proof for a candidate of {@link requests.createAuxBlock},
   * by its `hash`. Null if the block was accepted, or a
   * {@link BlockSubmissionReason}. `RpcError` -22 for a proof that does not
   * decode. A failure after the request may have reached the node is an
   * `RpcUnknownOutcomeError` naming `blockHash`. Look it up with
   * `getBlockHeader`, and do not submit it again to find out: the node forgets
   * an accepted candidate, so that answers `stale-prevblk`.
   */
  submitAuxBlock(blockHash: string, auxpowHex: string): RpcRequest<BlockSubmissionResult> {
    const candidate = argHash(blockHash, 'blockHash')
    return request('submitauxblock', [candidate, argHex(auxpowHex, 'auxpowHex')], parseBlockSubmission, {
      blockHash: candidate,
    })
  },

  getWalletInfo: (): RpcRequest<WalletInfo> => request('getwalletinfo', [], parseWalletInfo),
  getTransaction(txid: string): RpcRequest<WalletTransaction> {
    const requested = argHash(txid, 'txid')
    return request('gettransaction', [requested], parseWalletTransaction(requested))
  },
  listUnspent(options?: ListUnspentOptions): RpcRequest<UnspentOutput[]> {
    const o = methodOptions(options, LIST_UNSPENT_OPTIONS)
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
        opt(o['addresses'], v =>
          argArray(v, 'options.addresses').map((a, i) => argString(a, `options.addresses[${i}]`, { nonEmpty: true }))
        ),
        opt(o['includeUnsafe'], v => argBoolean(v, 'options.includeUnsafe')),
        Object.keys(query).length > 0 ? query : undefined,
      ],
      v => array(v, R, parseUnspent)
    )
  },
  /**
   * Checks that the reply is about `address`: a bech32 or bech32m address in
   * either case, any other exactly. Rejects with `RpcError` code -5 for an
   * address invalid on this network.
   */
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
    const o = methodOptions(options, LIST_SINCE_BLOCK_OPTIONS)
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
    const o = methodOptions(options, LIST_TRANSACTIONS_OPTIONS)
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
    const a = argOptions(args, 'args', FUNDED_PSBT_ARGS, { callOptions: true })
    const outputs = outputsParam(a['outputs'], 'args.outputs')
    const inputs = opt(a['inputs'], v =>
      argArray(v, 'args.inputs').map((input, i) => {
        const p = argOptions(input, `args.inputs[${i}]`, ['txid', 'vout', 'sequence'], {
          ignored: OUTPOINT_EXTRAS,
        })
        return compact<Record<string, unknown>>({
          txid: argHash(p['txid'], `args.inputs[${i}].txid`),
          // qbit Core reads it as an int and refuses a negative one.
          vout: argInteger(p['vout'], `args.inputs[${i}].vout`, 0, 0x7fff_ffff),
          sequence: opt(p['sequence'], s => argInteger(s, `args.inputs[${i}].sequence`, 0, 0xffff_ffff)),
        })
      })
    )
    return request(
      'walletcreatefundedpsbt',
      [
        inputs ?? [],
        outputs,
        opt(a['locktime'], v => argInteger(v, 'args.locktime', 0, 0xffff_ffff)),
        fundedPsbtOptions(a['options']),
        opt(a['bip32derivs'], v => argBoolean(v, 'args.bip32derivs')),
        // TX_MIN_STANDARD_VERSION to TX_MAX_STANDARD_VERSION.
        opt(a['version'], v => argInteger(v, 'args.version', 1, 3)),
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
    const o = methodOptions(options, ['sign', 'sighashType', 'bip32derivs', 'finalize'])
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
    const o = methodOptions(options, ['extract'])
    return request(
      'finalizepsbt',
      [argBase64(psbt, 'psbt'), opt(o['extract'], v => argBoolean(v, 'options.extract'))],
      parseFinalizedPsbt
    )
  },
  /**
   * An unsigned replacement for the wallet's unconfirmed transaction `txid`,
   * paying a higher fee. It spends every input of the original and may add
   * more; nothing is signed or sent. Sign it with `walletProcessPsbt`, store
   * the hex, then `sendRawTransaction`. It needs the wallet unlocked (`RpcError`
   * -13 otherwise). Side-effecting all the same: when the original has no change
   * output the wallet recognises, or `outputs` leave out its change address,
   * each call takes change keys from the keypool for good. A lost reply is an
   * `RpcUnknownOutcomeError`; calling again is safe, at worst using up more
   * change keys. The change position is random, so a repeat call can return
   * another transaction. Rejects with `RpcError` -5 for a transaction the
   * wallet does not know, -8 for a fee rate too low or a transaction with
   * descendants, -1 once the original or a replacement is mined (an input "is
   * already spent"), and -4 for insufficient funds or a fee above `-maxtxfee`.
   */
  psbtBumpFee(txid: string, options?: PsbtBumpFeeOptions): RpcRequest<BumpedPsbt> {
    const requested = argHash(txid, 'txid')
    const o = methodOptions(options, PSBT_BUMP_FEE_OPTIONS)
    // argOptions read each option once, so a getter cannot pass the checks below and then send something else.
    const feeRate = o['feeRateBitsPerKvB']
    const confTarget = o['confTarget']
    const estimateMode = o['estimateMode']
    const outputs = o['outputs']
    const originalChangeIndex = o['originalChangeIndex']
    if (feeRate !== undefined && (confTarget !== undefined || estimateMode !== undefined)) {
      throw new TypeError('options.feeRateBitsPerKvB excludes options.confTarget and options.estimateMode')
    }
    if (outputs !== undefined && originalChangeIndex !== undefined) {
      throw new TypeError('options.outputs excludes options.originalChangeIndex')
    }
    // Key names as qbit Core v1.0.0's psbtbumpfee reads them. It refuses any
    // other key (-3), so none is accepted and then ignored; each was checked
    // against a live node: see test/regtest/smoke.test.ts.
    const bump = compact<Record<string, unknown>>({
      fee_rate: opt(feeRate, v => {
        // The node never takes a zero rate: the new fee must exceed the original's.
        if (v === 0n) throw new RangeError('options.feeRateBitsPerKvB must be above 0')
        return feeRateParam(v, 'options.feeRateBitsPerKvB')
      }),
      conf_target: opt(confTarget, v => argInteger(v, 'options.confTarget', 1, 1008)),
      estimate_mode: opt(estimateMode, v => argOneOf(v, 'options.estimateMode', FEE_MODES)),
      replaceable: opt(o['replaceable'], v => argBoolean(v, 'options.replaceable')),
      outputs: opt(outputs, v => outputsParam(v, 'options.outputs')),
      original_change_index: opt(originalChangeIndex, v =>
        argInteger(v, 'options.originalChangeIndex', 0, 0xffff_ffff)
      ),
    })
    return request('psbtbumpfee', [requested, Object.keys(bump).length > 0 ? bump : undefined], parseBumpedPsbt)
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
   * A new address from the wallet's internal (change) keypool. See
   * {@link AddressType} for the types each chain offers; one the chain or the
   * wallet does not offer rejects with `RpcError` code -5. On regtest, a wallet
   * encrypted at creation rejects with code -12 unless `addressType` is `p2mr`
   * or the node runs with `-changetype=p2mr`.
   */
  getRawChangeAddress(options?: { readonly addressType?: AddressType }): RpcRequest<string> {
    const o = methodOptions(options, ['addressType'])
    return request(
      'getrawchangeaddress',
      [opt(o['addressType'], v => argOneOf(v, 'options.addressType', ADDRESS_TYPES))],
      parseAddress
    )
  },
  /**
   * A new receiving address from the wallet's external keypool, listed under
   * `label` (the default label, `''`, when left out; qbit Core reserves `*`).
   * See {@link AddressType} for the types each chain offers; one the chain or
   * the wallet does not offer rejects with `RpcError` code -5, and a wallet
   * with no keys with code -4. On regtest, a wallet encrypted at creation
   * rejects with code -12 unless `addressType` is `p2mr`.
   */
  getNewAddress(options?: { readonly label?: string; readonly addressType?: AddressType }): RpcRequest<string> {
    const o = methodOptions(options, ['label', 'addressType'])
    return request(
      'getnewaddress',
      [
        opt(o['label'], v => {
          const label = argString(v, 'options.label')
          if (label === '*') throw new RangeError('options.label must not be *')
          return label
        }),
        opt(o['addressType'], v => argOneOf(v, 'options.addressType', ADDRESS_TYPES)),
      ],
      parseAddress
    )
  },
  /**
   * Lock wallet outputs against automatic coin selection (`lockunspent` with
   * `unlock` false). A lock is kept in memory and gone after a node restart,
   * unless `persistent` is set: then it is written to the wallet and loaded
   * again on start. The node checks every output first and rejects with
   * `RpcError` code -8, changing nothing, when one is unknown, spent or already
   * locked; with `persistent`, an output already locked is locked again,
   * persistently. `outputs` must not be empty.
   */
  lockUnspent(outputs: readonly Outpoint[], options?: { readonly persistent?: boolean }): RpcRequest<true> {
    const locked = outpointsParam(outputs)
    const o = methodOptions(options, ['persistent'])
    return request(
      'lockunspent',
      [false, locked, opt(o['persistent'], v => argBoolean(v, 'options.persistent'))],
      parseTrue
    )
  },
  /**
   * Unlock wallet outputs (`lockunspent` with `unlock` true), whether they were
   * locked persistently or in memory only. The node checks every output first
   * and rejects with `RpcError` code -8, changing nothing, when one is unknown,
   * spent or not locked. `outputs` must not be empty: qbit Core unlocks nothing
   * for an empty list and every output when the list is left out, which is
   * `call('lockunspent', [true])`.
   */
  unlockUnspent(outputs: readonly Outpoint[]): RpcRequest<true> {
    return request('lockunspent', [true, outpointsParam(outputs)], parseTrue)
  },
  /**
   * Sign a 32-byte hash with the PQC key that a wallet P2MR address commits
   * to, for sign-in or attestation: `verifyDataPqcHash` takes the result as
   * it is. Every signature counts against the key's signature budget (2^30),
   * so a failure after sending is an `RpcUnknownOutcomeError`, and a call
   * again signs again. `includePqcUsage` adds the key's budget fields, which
   * qbit Core advises enabling only for local diagnostics. `pubkey`,
   * `leafScript` and `controlBlock` choose the leaf when the address commits to
   * more than one. Rejects with `RpcError` -13 while the wallet is locked, and
   * -4 for an address the wallet does not have.
   */
  signDataPqcHash(
    address: string,
    messageHash: string,
    options?: {
      readonly pubkey?: string
      readonly leafScript?: string
      readonly controlBlock?: string
      readonly includePqcUsage?: boolean
    }
  ): RpcRequest<DataPqcHashSignature> {
    const o = methodOptions(options, ['pubkey', 'leafScript', 'controlBlock', 'includePqcUsage'])
    const asked: DataPqcSigningRequest = {
      address: argString(address, 'address', { nonEmpty: true }),
      messageHash: argHex(messageHash, 'messageHash', 32).toLowerCase(),
      pubkey: opt(o['pubkey'], v => argHex(v, 'options.pubkey', 32).toLowerCase()),
      leafScript: opt(o['leafScript'], v => argHex(v, 'options.leafScript').toLowerCase()),
      controlBlock: opt(o['controlBlock'], v => controlBlockParam(v, 'options.controlBlock')),
    }
    // Key names as qbit Core v1.0.0's signdatapqchash reads them: it ignores any other.
    const signOptions = compact<Record<string, unknown>>({
      pubkey: asked.pubkey,
      leaf_script: asked.leafScript,
      control_block: asked.controlBlock,
      include_pqc_usage: opt(o['includePqcUsage'], v => argBoolean(v, 'options.includePqcUsage')),
    })
    return request(
      'signdatapqchash',
      [asked.address, asked.messageHash, Object.keys(signOptions).length > 0 ? signOptions : undefined],
      parseDataPqcSignature(asked)
    )
  },

  /**
   * Create and load a wallet; a name with a path creates it there. With
   * `passphrase` it is encrypted, never echoed, and its first unlock runs its
   * deferred keypool top-up (see `walletPassphrase`); an empty one is refused,
   * as qbit Core would create the wallet unencrypted. A failure after sending
   * is an `RpcUnknownOutcomeError`: `listWalletDir()` shows whether it exists.
   * Rejects with `RpcError` -4 when it exists already.
   */
  createWallet(
    walletName: string,
    options?: {
      readonly disablePrivateKeys?: boolean
      readonly blank?: boolean
      readonly passphrase?: string
      readonly avoidReuse?: boolean
      readonly loadOnStartup?: boolean
    }
  ): RpcRequest<LoadedWallet> {
    const name = argString(walletName, 'walletName')
    const o = methodOptions(options, ['disablePrivateKeys', 'blank', 'passphrase', 'avoidReuse', 'loadOnStartup'])
    const disablePrivateKeys = opt(o['disablePrivateKeys'], v => argBoolean(v, 'options.disablePrivateKeys'))
    const passphrase = opt(o['passphrase'], v => {
      if (typeof v !== 'string' || v === '') {
        throw new TypeError(
          'options.passphrase must be a non-empty string: qbit Core creates an unencrypted wallet for an empty one'
        )
      }
      return v
    })
    if (passphrase !== undefined && disablePrivateKeys === true) {
      throw new TypeError(
        'options.passphrase excludes options.disablePrivateKeys: a wallet without private keys has nothing to encrypt'
      )
    }
    return request(
      'createwallet',
      [
        name,
        disablePrivateKeys,
        opt(o['blank'], v => argBoolean(v, 'options.blank')),
        passphrase,
        opt(o['avoidReuse'], v => argBoolean(v, 'options.avoidReuse')),
        // descriptors: qbit Core creates descriptor wallets only.
        undefined,
        opt(o['loadOnStartup'], v => argBoolean(v, 'options.loadOnStartup')),
      ],
      parseLoadedWallet(name)
    )
  },
  /**
   * Load a wallet from the wallet directory, or a path. `loadOnStartup` true
   * adds it to the node's startup list and false removes it. Rejects with
   * `RpcError` -35 when it is loaded already, and -18 when it does not exist.
   */
  loadWallet(filename: string, options?: { readonly loadOnStartup?: boolean }): RpcRequest<LoadedWallet> {
    const name = argString(filename, 'filename')
    const o = methodOptions(options, ['loadOnStartup'])
    return request(
      'loadwallet',
      [name, opt(o['loadOnStartup'], v => argBoolean(v, 'options.loadOnStartup'))],
      parseLoadedWallet(name)
    )
  },
  /**
   * Unload a wallet. With a client `wallet`, the name must be that one (-8
   * otherwise). The node answers once every call still running on the wallet
   * has ended, so its default deadline is 120 s. Rejects with `RpcError` -18
   * when it is not loaded, and -4 while it rescans.
   */
  unloadWallet(walletName: string, options?: { readonly loadOnStartup?: boolean }): RpcRequest<UnloadedWallet> {
    const o = methodOptions(options, ['loadOnStartup'])
    return request(
      'unloadwallet',
      [argString(walletName, 'walletName'), opt(o['loadOnStartup'], v => argBoolean(v, 'options.loadOnStartup'))],
      parseUnloadedWallet
    )
  },
  /** The wallets in the node's wallet directory, loaded or not. */
  listWalletDir: (): RpcRequest<WalletDirEntry[]> => request('listwalletdir', [], parseWalletDir),
  /**
   * Import descriptors into the wallet, then rescan once from the earliest
   * `timestamp`. One result per descriptor, in order: a refused one does not
   * stop the others. Each is checked before sending (see
   * {@link DescriptorImport}), with its checksum. Descriptors can hold private
   * keys: they travel only in the request body, and the node's messages,
   * which can quote a descriptor in full, are redacted. The default deadline
   * is 120 s: see
   * {@link https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/wallet-admin.md | Wallet administration}.
   * Needs the wallet unlocked (`RpcError` -13).
   */
  importDescriptors(descriptors: readonly DescriptorImport[]): RpcRequest<DescriptorImportResult[]> {
    // Frozen, so what is sent is what the result's messages are redacted of.
    const params = Object.freeze(descriptorImportsParam(descriptors).map(entry => Object.freeze(entry)))
    const secrets = descriptorSecrets(params.map(entry => entry.desc))
    return request('importdescriptors', [params], parseDescriptorImports(params.length, secrets))
  },
  /**
   * Rescan the chain from `startHeight` (default 0) to `stopHeight` (default
   * the tip) for the wallet's transactions. The default deadline is 120 s:
   * see
   * {@link https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/wallet-admin.md | Wallet administration}.
   * Rejects with `RpcError` -8 for a height past the
   * wallet's tip, -4 while a rescan runs, and -13 while the wallet is locked.
   */
  rescanBlockchain(options?: {
    readonly startHeight?: number
    readonly stopHeight?: number
  }): RpcRequest<RescanResult> {
    const o = methodOptions(options, ['startHeight', 'stopHeight'])
    const startHeight = opt(o['startHeight'], v => argInteger(v, 'options.startHeight', 0, 0x7fff_ffff))
    const stopHeight = opt(o['stopHeight'], v => argInteger(v, 'options.stopHeight', 0, 0x7fff_ffff))
    if (stopHeight !== undefined && stopHeight < (startHeight ?? 0)) {
      throw new RangeError('options.stopHeight must not be below options.startHeight')
    }
    return request('rescanblockchain', [startHeight, stopHeight], parseRescan(startHeight ?? 0, stopHeight))
  },
  /**
   * Copy the wallet to `destination`, a file path on the node's host, which
   * it overwrites; a relative one is resolved against `qbitd`'s working
   * directory. qbit Core v1.0.0 refuses a directory, and a path whose
   * directory does not exist, with `RpcError` -4.
   */
  backupWallet: (destination: string): RpcRequest<null> =>
    request('backupwallet', [argString(destination, 'destination', { nonEmpty: true })], parseNull),
  /**
   * Change an encrypted wallet's passphrase. Neither passphrase is ever logged
   * or put in an error. Rejects with `RpcError` -14 for a wrong old
   * passphrase, and -15 for an unencrypted wallet.
   */
  walletPassphraseChange: (oldPassphrase: string, newPassphrase: string): RpcRequest<null> =>
    request(
      'walletpassphrasechange',
      [
        argString(oldPassphrase, 'oldPassphrase', { nonEmpty: true }),
        argString(newPassphrase, 'newPassphrase', { nonEmpty: true }),
      ],
      parseNull
    ),
  /**
   * Derive keys until each active descriptor's keypool holds `newSize`
   * (default `-keypool`, 1,000). The default deadline is 120 s: see
   * {@link https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/wallet-admin.md | Wallet administration}.
   * Needs the wallet unlocked (`RpcError` -13).
   */
  keypoolRefill(options?: { readonly newSize?: number }): RpcRequest<null> {
    const o = methodOptions(options, ['newSize'])
    // 0 is qbit Core's "the -keypool default": leave newSize out for that.
    return request(
      'keypoolrefill',
      [opt(o['newSize'], v => argInteger(v, 'options.newSize', 1, 0x7fff_ffff))],
      parseNull
    )
  },
}
