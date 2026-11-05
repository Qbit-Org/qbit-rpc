import { createHash } from 'node:crypto'
import { inspect } from 'node:util'

import {
  CAPABILITIES,
  methodPolicy,
  QBIT_CHAINS,
  QBIT_DEFAULT_SIGNET_CHALLENGE,
  QBIT_GENESIS_HASHES,
  type Capability,
  type MethodPolicy,
  type QbitChain,
} from './capabilities'
import {
  CookieReadFailure,
  Credentials,
  parseConnect,
  parseEndpoint,
  parseTls,
  type Endpoint,
  type RpcAuth,
  type RpcConnect,
  type RpcTlsOptions,
} from './endpoint'
import {
  QbitRpcError,
  RpcAbortedError,
  RpcCapabilityError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcResponseTooLargeError,
  RpcTimeoutError,
  RpcTransportError,
  RpcUnknownOutcomeError,
  type ChainCheck,
  type ChainMismatch,
} from './errors'
import { assertLosslessJsonSupport, isJsonObject, JsonNumber, parseJsonLossless, stringifyRequest } from './json'
import { Limiter } from './limiter'
import {
  requests,
  type AddressInfo,
  type AddressType,
  type AddressValidation,
  type BlockchainInfo,
  type BlockHeader,
  type BumpedPsbt,
  type ConfirmationTarget,
  type DataPqcHashProof,
  type DataPqcHashVerification,
  type DecodedTransaction,
  type FeeEstimateMode,
  type FinalizedPsbt,
  type FundedPsbt,
  type ListSinceBlockOptions,
  type ListTransactionsOptions,
  type ListUnspentOptions,
  type MempoolAcceptance,
  type MempoolEntry,
  type NetworkInfo,
  type Outpoint,
  type ProcessedPsbt,
  type PsbtBumpFeeOptions,
  type RpcRequest,
  type SecurityLevel,
  type SighashType,
  type SinceBlockHistory,
  type SmartFeeEstimate,
  type TxOut,
  type UnspentOutput,
  type WalletBalances,
  type WalletCreateFundedPsbtArgs,
  type WalletHistoryEntry,
  type WalletInfo,
  type WalletTransaction,
} from './methods'
import { argArray, argOptions, CALL_OPTION_KEYS, keysOf, ownElements, ownValue, plainOptions } from './own'
import { ExchangeFailure, HttpTransport, prototypePollution } from './transport'
import { ResultIssue } from './validate'

export interface QbitRpcClientOptions {
  /**
   * The node's JSON-RPC endpoint, such as `http://127.0.0.1:48352/` for
   * testnet4. Plain `http` is only accepted for a loopback host: an address in
   * 127.0.0.0/8 or `::1`, or `localhost`, which every connection resolves and
   * refuses (`RpcTransportError`, `reason: 'not_loopback'`) unless all its
   * addresses are loopback. The path may already name a wallet
   * (`/wallet/<name>`); otherwise pass `wallet`.
   */
  readonly url: string
  /** Send every call to `/wallet/<name>`. Required for wallet calls when the node has several wallets loaded. */
  readonly wallet?: string
  readonly auth: RpcAuth
  /**
   * TLS settings for an `https` url: a private CA, a client certificate, the
   * name to check, and key pins. Default: the system's CAs, no client
   * certificate, the URL's host, no pin. See the package README's "Remote nodes".
   */
  readonly tls?: RpcTlsOptions
  /**
   * Opens the stream for each connection to an `https` url, such as a tunnel
   * through a proxy; the client runs TLS over it, with every check. Not with
   * cookie authentication. Default: connect to the URL's host directly.
   */
  readonly connect?: RpcConnect
  /** The chain this client must talk to. `confirmChain()` checks it; wallet-write and broadcast calls wait for that check. */
  readonly expectedChain: QbitChain
  /**
   * The genesis block hash the node must report (`getblockhash 0`) on every
   * chain check: 64 hex characters, in either case (compared in lowercase).
   * Default: `expectedChain`'s genesis block in qbit Core v1.0.0, which the
   * package README lists. Set it for a node built with other chain parameters.
   */
  readonly expectedGenesisHash?: string
  /**
   * The challenge (block script) a signet node must report as
   * `signet_challenge` on every chain check: non-empty hex of whole bytes, in
   * either case (compared in lowercase). Only with `expectedChain: 'signet'`.
   * Default `51`, OP_TRUE, the default signet's open challenge, which anyone
   * can mine a separate signet with.
   */
  readonly expectedSignetChallenge?: string
  /** Capabilities beyond chain reads. Default none: read-only. */
  readonly capabilities?: readonly Capability[]
  /**
   * Deadline for one operation (a call or a batch, with every retry, any wait
   * for a request slot and the cookie read). Default 30,000 ms. For
   * `walletpassphrase` and `walletlock` it is at least 120,000 ms (see
   * {@link QbitRpcClient.walletPassphrase}): a shorter client `timeoutMs` does
   * not shorten it. A call's own `timeoutMs` overrides both. With `connect`, it
   * also bounds a pooled connection still opening after its read gave up.
   */
  readonly timeoutMs?: number
  /** Largest response body read before the call fails. Default 16 MiB. */
  readonly maxResponseBytes?: number
  /**
   * Extra attempts for methods without side effects after a connection error
   * (`reason: 'network'`; a TLS or loopback refusal would only repeat), an HTTP
   * 5xx, a credentials failure, an HTTP 401 under cookie auth, or (single calls
   * and the chain check) RPC error -28, node warming up. Default 0: no retries.
   * Methods with side effects are never retried. Apart from these, even at 0,
   * a request without side effects that is reset on a reused keep-alive
   * connection just after it was written, before any reply byte (qbitd closed
   * it for idleness), gets one more attempt at once, as does a chain re-check
   * before a call with side effects; the reset still makes the chain stale.
   */
  readonly readRetries?: number
  /** Delay before the first retry; it doubles for each further one, up to 10 s. Default 250 ms. */
  readonly retryDelayMs?: number
  /**
   * How long a chain confirmation stays fresh. A wallet-write or broadcast call
   * made later first re-runs the chain check, under the call's own deadline; if
   * that check fails, the call is not sent and rejects with `RpcChainGuardError`
   * (`reason: 'check_failed'`, the failure as `cause`). A connection error, an
   * HTTP 401 or a changed cookie (a qbitd restart) makes the confirmation stale
   * at once. 0 re-checks before every such call. Default 10,000 ms.
   */
  readonly chainCheckMaxAgeMs?: number
  /**
   * Most requests this client has open at once, on pooled and fresh connections
   * alike, from 1 to 1,024. A batch counts once, and a chain re-check (with any
   * pause before checking again) runs in its call's slot. Further attempts wait
   * in FIFO order under their operation's deadline; one that times out or is
   * aborted while waiting was never sent, so it is a plain `RpcTimeoutError` or
   * `RpcAbortedError`, never an unknown outcome. Keep the total over all clients of a node at or below its
   * `-rpcworkqueue` (see the README's failure model). Default 8.
   */
  readonly maxConcurrentRequests?: number
  /**
   * Set when `url` reaches qbitd itself, with no proxy in between. qbitd's HTTP
   * 503 `Work queue depth exceeded` is then a definite failure, since qbitd
   * answers it without running the request: a plain `RpcTransportError`, even
   * for a side-effecting call. It is opt-in because a proxy in between can answer
   * 503 after forwarding the request, so by default every 5xx stays an unknown
   * outcome for side-effecting calls. Default false.
   */
  readonly directNode?: boolean
}

/**
 * Per-call options: the last argument of every client method, apart from the
 * method's own options. Each key is checked: any other is a `TypeError`.
 */
export interface CallOptions {
  /**
   * Aborts the call. An abort after a side-effecting request was sent is an
   * `RpcUnknownOutcomeError`; one during its chain re-check is an
   * `RpcChainGuardError` (`reason: 'check_failed'`), and one at any other point
   * before it was sent an `RpcAbortedError`.
   */
  readonly signal?: AbortSignal
  /** Overrides the client's `timeoutMs`, and a method's own default (`walletPassphrase`'s, `walletLock`'s), for this operation. */
  readonly timeoutMs?: number
}

/**
 * One batch entry's outcome. Transport, timeout and size failures reject the
 * whole batch instead. An entry whose `parse` throws, whatever it throws, has
 * an `RpcResponseError` here.
 */
export type BatchItem<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcError | RpcResponseError }

export type BatchResults<T extends readonly RpcRequest<unknown>[]> = {
  -readonly [K in keyof T]: BatchItem<T[K] extends RpcRequest<infer R> ? R : never>
}

/**
 * The chain guard's state:
 *
 * - `unconfirmed`: `confirmChain()` has not succeeded yet. Wallet-write and
 *   broadcast calls are refused.
 * - `confirmed`: the node reported `expectedChain`, its genesis block and, on
 *   signet, its challenge, within `chainCheckMaxAgeMs`.
 * - `stale`: it did, but longer ago, or a connection error, an HTTP 401 or a
 *   cookie change happened since. The next wallet-write or broadcast call
 *   checks the chain again before it is sent.
 * - `mismatch`: the node reported another chain, genesis block or signet
 *   challenge. Wallet-write and broadcast calls are refused until
 *   `confirmChain()` matches again.
 */
export type ChainStatus = 'unconfirmed' | 'confirmed' | 'stale' | 'mismatch'

type ChainState =
  | { readonly status: 'unconfirmed' }
  /** `digest`: of the Authorization header the check was sent with; a call with another one checks again. */
  | { readonly status: 'confirmed'; readonly at: number; readonly digest: string }
  | { readonly status: 'invalidated' }
  /** `doubt`: `#doubts` once it was recorded, to tell a check sent before it from one sent after. */
  | {
      readonly status: 'mismatch'
      readonly report: ChainReport
      readonly differs: readonly ChainCheck[]
      readonly doubt: number
    }

/**
 * What a chain check found: the node's chain name, genesis block hash and
 * signet challenge (on signet only). The genesis hash is missing only from a
 * mismatch the chain name or challenge already showed, when the `getblockhash`
 * reply failed.
 */
interface ChainReport {
  readonly chain: string
  readonly genesisHash: string | undefined
  readonly signetChallenge: string | undefined
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const DEFAULT_RETRY_DELAY_MS = 250
const DEFAULT_CHAIN_CHECK_MAX_AGE_MS = 10_000
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8
const MAX_CONCURRENT_REQUESTS = 1024
/** qbitd's whole reply body when its work queue is full (qbit Core v1.0.0). */
const WORK_QUEUE_REJECTION = 'Work queue depth exceeded'
/**
 * The HTTP statuses qbitd puts on a JSON-RPC error (`JSONErrorReply` in qbit Core
 * v1.0.0's src/httprpc.cpp): 400 for -32600, 404 for -32601, and 500 for any other.
 */
const NODE_ERROR_STATUSES: ReadonlySet<number> = new Set([400, 404, 500])
const MAX_RETRY_DELAY_MS = 10_000
const MAX_BATCH = 1000
const RPC_IN_WARMUP = -28
const MAX_NODE_MESSAGE = 1000
/** Chain checks one guarded attempt or `confirmChain()` runs while each answer is doubted. */
const MAX_CHAIN_CHECKS = 3

const TIMEOUT = Symbol('timeout')
/** Exchange failures of the connection itself: each makes the chain confirmation stale. */
const CONNECTION_KINDS: ReadonlySet<string> = new Set(['network', 'tls', 'not_loopback'])
const CALL_OPTIONS: readonly (keyof CallOptions)[] = CALL_OPTION_KEYS
const CLIENT_OPTIONS = keysOf<QbitRpcClientOptions>({
  url: true,
  wallet: true,
  auth: true,
  tls: true,
  connect: true,
  expectedChain: true,
  expectedGenesisHash: true,
  expectedSignetChallenge: true,
  capabilities: true,
  timeoutMs: true,
  maxResponseBytes: true,
  readRetries: true,
  retryDelayMs: true,
  chainCheckMaxAgeMs: true,
  maxConcurrentRequests: true,
  directNode: true,
})
/** What `batch()` reads of an entry. */
const BATCH_ENTRY = ['method', 'params', 'parse'] as const

/** An attempt's failure, with what is known about whether the node may have acted on it. */
class Failure {
  constructor(
    readonly error: QbitRpcError,
    /** The request may have been executed and no definite answer arrived. */
    readonly unknown: boolean,
    readonly retryable: boolean,
    /** See `ExchangeFailure.staleSocket`. */
    readonly staleSocket: boolean = false
  ) {}
}

/** A hex option of whole bytes (exactly `bytes` of them, when set), in either case; lowercased. */
function checkHex(value: unknown, name: string, bytes?: number): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    !/^(?:[0-9a-fA-F]{2})+$/.test(value) ||
    (bytes !== undefined && value.length !== bytes * 2)
  ) {
    throw new TypeError(
      `${name} must be ${bytes === undefined ? 'non-empty hex of whole bytes' : `${bytes * 2} hex characters`}`
    )
  }
  return value.toLowerCase()
}

function checkInteger<F extends number | undefined>(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: F
): number | F {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

/**
 * A JSON-RPC client for one qbit Core node (and optionally one wallet).
 *
 * Every method is checked against an allowlist and the client's capabilities
 * before anything is sent, wallet-write and broadcast calls also need a
 * confirmed chain, and every typed result is validated before it is returned.
 * Amounts are `bigint` bits. See the package README for the failure model.
 *
 * Each typed method takes the arguments of the request builder of the same
 * name in {@link requests}, then {@link CallOptions} (`signal`, `timeoutMs`)
 * as a separate last argument: `getTxOut(txid, vout, { includeMempool },
 * { timeoutMs })`. A method's own options never hold call options.
 */
export class QbitRpcClient {
  readonly #endpoint: Endpoint
  readonly #credentials: Credentials
  readonly #expectedChain: QbitChain
  readonly #expectedGenesisHash: string
  /** Set exactly when `#expectedChain` is signet. */
  readonly #expectedSignetChallenge: string | undefined
  readonly #capabilities: ReadonlySet<Capability>
  /** Undefined when the option is unset: each method's own default applies. */
  readonly #timeoutMs: number | undefined
  readonly #maxResponseBytes: number
  readonly #readRetries: number
  readonly #retryDelayMs: number
  readonly #chainCheckMaxAgeMs: number
  readonly #directNode: boolean
  readonly #limiter: Limiter
  readonly #transport: HttpTransport
  /** What `tls` sets, for `toJSON()`; undefined when it is not given. */
  readonly #tlsSummary: Readonly<Record<string, unknown>> | undefined
  readonly #customConnect: boolean
  #chain: ChainState = { status: 'unconfirmed' }
  /**
   * Counts signs that the node may have changed (a connection error, an HTTP
   * 401) and chain mismatches. A chain check that saw it change while in
   * flight cannot record a confirmation.
   */
  #doubts = 0
  /** A digest of the newest Authorization header read: another one than a confirmation's means the cookie rotated. */
  #authDigest: string | undefined
  /** Cookie reads in the order they started, so one that finishes late cannot roll `#authDigest` back. */
  #authReads = 0
  #authDigestRead = 0
  #nextId = 1

  constructor(options: QbitRpcClientOptions) {
    assertLosslessJsonSupport()
    if (typeof options !== 'object' || options === null) throw new TypeError('options must be an object')
    // Read once, own properties only: an option given any other way, such as
    // capabilities, tls or connect on a polluted Object.prototype, is refused.
    // So is a key that is no option: with walletName, wallet calls would go to
    // whichever wallet the node has loaded.
    const own = argOptions(options, 'options', CLIENT_OPTIONS) as unknown as QbitRpcClientOptions
    this.#endpoint = parseEndpoint(own.url, own.wallet)
    this.#credentials = new Credentials(own.auth, this.#endpoint)
    const tls = parseTls(own.tls, this.#endpoint)
    const connect = parseConnect(own.connect, this.#endpoint)
    if (connect !== undefined && this.#credentials.kind === 'cookie') {
      throw new TypeError('cookie authentication cannot use connect: the cookie goes to loopback only')
    }
    this.#tlsSummary = tls?.summary
    this.#customConnect = connect !== undefined
    if (!(QBIT_CHAINS as readonly unknown[]).includes(own.expectedChain)) {
      throw new TypeError(`expectedChain must be one of ${QBIT_CHAINS.join(', ')}`)
    }
    this.#expectedChain = own.expectedChain
    this.#expectedGenesisHash =
      checkHex(own.expectedGenesisHash, 'expectedGenesisHash', 32) ?? QBIT_GENESIS_HASHES[this.#expectedChain]
    const challenge = checkHex(own.expectedSignetChallenge, 'expectedSignetChallenge')
    if (challenge !== undefined && this.#expectedChain !== 'signet') {
      throw new TypeError("expectedSignetChallenge needs expectedChain: 'signet'")
    }
    this.#expectedSignetChallenge =
      this.#expectedChain === 'signet' ? (challenge ?? QBIT_DEFAULT_SIGNET_CHALLENGE) : undefined
    const capabilities = own.capabilities === undefined ? [] : argArray(own.capabilities, 'capabilities')
    for (const capability of capabilities) {
      if (!(CAPABILITIES as readonly unknown[]).includes(capability)) {
        throw new TypeError(`unknown capability ${String(capability)}: use ${CAPABILITIES.join(', ')}`)
      }
    }
    this.#capabilities = new Set(capabilities as Capability[])
    this.#timeoutMs = checkInteger(own.timeoutMs, 'timeoutMs', 1, 3_600_000, undefined)
    this.#maxResponseBytes = checkInteger(
      own.maxResponseBytes,
      'maxResponseBytes',
      1024,
      256 * 1024 * 1024,
      DEFAULT_MAX_RESPONSE_BYTES
    )
    this.#readRetries = checkInteger(own.readRetries, 'readRetries', 0, 10, 0)
    this.#retryDelayMs = checkInteger(own.retryDelayMs, 'retryDelayMs', 0, 60_000, DEFAULT_RETRY_DELAY_MS)
    this.#chainCheckMaxAgeMs = checkInteger(
      own.chainCheckMaxAgeMs,
      'chainCheckMaxAgeMs',
      0,
      86_400_000,
      DEFAULT_CHAIN_CHECK_MAX_AGE_MS
    )
    const maxConcurrentRequests = checkInteger(
      own.maxConcurrentRequests,
      'maxConcurrentRequests',
      1,
      MAX_CONCURRENT_REQUESTS,
      DEFAULT_MAX_CONCURRENT_REQUESTS
    )
    if (own.directNode !== undefined && typeof own.directNode !== 'boolean') {
      throw new TypeError('directNode must be a boolean')
    }
    this.#directNode = own.directNode ?? false
    this.#limiter = new Limiter(maxConcurrentRequests)
    // The pool follows the limit, so requests queue in the limiter rather than
    // in the agent, and a limit above 8 applies to reads too. The spare socket
    // covers one the agent still counts after destroying it (a timeout, an
    // abort, a stale reset) until it has closed, so the slot holder after it
    // does not wait in the agent. Open requests stay within the limit.
    // Credentials in cleartext, and a cookie at all, go to loopback only: a
    // host name must resolve to loopback, checked as each connection is made.
    this.#transport = new HttpTransport(maxConcurrentRequests + 1, undefined, {
      loopbackOnly: this.#endpoint.url.protocol === 'http:' || this.#credentials.kind === 'cookie',
      tls,
      connect,
      openTimeoutMs: this.#timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
  }

  /** The chain guard's state; see {@link ChainStatus}. */
  get chainStatus(): ChainStatus {
    const chain = this.#chain
    if (chain.status === 'invalidated') return 'stale'
    if (chain.status === 'confirmed' && (this.#chainExpired(chain.at) || chain.digest !== this.#authDigest)) {
      return 'stale'
    }
    return chain.status
  }

  /**
   * Send `getblockchaininfo` and `getblockhash 0` in one JSON-RPC batch, and
   * compare the node's `chain` with `expectedChain`, its genesis block hash
   * with `expectedGenesisHash` and, on signet, its `signet_challenge` with
   * `expectedSignetChallenge` (a missing one differs). On a match of all
   * three, wallet-write and broadcast calls are allowed; once the confirmation
   * goes stale they re-run this check before they are sent. On a mismatch they
   * stay refused and this throws `RpcChainGuardError`, as it does when any
   * check finds a mismatch while this call runs (its cookie read, checks,
   * waits and retries included), unless a `confirmChain()` begun after that
   * mismatch cleared it first. It returns its own last check's
   * `getblockchaininfo` answer, which another check may have overtaken: call
   * `getBlockchainInfo()` for current block data. An answer that a connection error or an
   * HTTP 401 elsewhere may postdate is checked again, after `retryDelayMs`, up
   * to three checks per attempt; then this throws `reason: 'stale'` (retried
   * like a read under `readRetries`) and changes nothing. This is a read and the
   * check itself, so any other failure of it is thrown as it is (`RpcTimeoutError`,
   * `RpcTransportError` and so on, about `getblockchaininfo` or `getblockhash`),
   * never `reason: 'check_failed'`.
   */
  async confirmChain(callOptions?: CallOptions): Promise<BlockchainInfo> {
    const method = 'getblockchaininfo'
    // A mismatch recorded after this point is newer than this call: it stands, and this call throws it.
    const started = this.#doubts
    refusePollution(method)
    return this.#operation(method, this.#callSettings(callOptions), false, async attempt => {
      try {
        const authorization = await this.#authorization(method, attempt.signal)
        let info: BlockchainInfo | undefined
        for (let checks = 0; info === undefined || this.#chainNeedsCheck(method, authorization, checks, started);) {
          if (checks > 0) await this.#pause(method, attempt)
          this.#refuseMismatchSince(method, started)
          info = await this.#checkChain(attempt, authorization, started)
          checks += 1
        }
        return info
      } catch (error) {
        throw asFailure(method, error, attempt)
      }
    })
  }

  /**
   * Call any allowlisted method with positional parameters. The result is
   * returned unvalidated, with every number as a `JsonNumber`. Pass amounts as
   * strings from `formatQbt(bits)` (qbit Core accepts amount strings) and
   * integers above 2^53 as `bigint`.
   */
  call(method: string, params: readonly unknown[] = [], callOptions?: CallOptions): Promise<unknown> {
    return this.#lazy(() => requests.raw(method, params), callOptions)
  }

  /**
   * Send several read or wallet-read requests in one JSON-RPC batch, matched
   * to their replies by id. Each entry succeeds or fails on its own, a throwing
   * `parse` included; a transport failure, timeout or oversized reply rejects
   * the whole batch.
   */
  batch<const T extends readonly RpcRequest<unknown>[]>(
    entries: T,
    callOptions?: CallOptions
  ): Promise<BatchResults<T>> {
    return this.#batch(entries, callOptions) as Promise<BatchResults<T>>
  }

  getBlockchainInfo(callOptions?: CallOptions): Promise<BlockchainInfo> {
    return this.#single(requests.getBlockchainInfo(), callOptions)
  }
  getNetworkInfo(callOptions?: CallOptions): Promise<NetworkInfo> {
    return this.#single(requests.getNetworkInfo(), callOptions)
  }
  getBestBlockHash(callOptions?: CallOptions): Promise<string> {
    return this.#single(requests.getBestBlockHash(), callOptions)
  }
  getBlockCount(callOptions?: CallOptions): Promise<number> {
    return this.#single(requests.getBlockCount(), callOptions)
  }
  getBlockHash(height: number, callOptions?: CallOptions): Promise<string> {
    return this.#lazy(() => requests.getBlockHash(height), callOptions)
  }
  getBlockHeader(blockHash: string, callOptions?: CallOptions): Promise<BlockHeader> {
    return this.#lazy(() => requests.getBlockHeader(blockHash), callOptions)
  }
  /** See {@link requests.getRawTransaction}. */
  getRawTransaction(
    txid: string,
    options?: { readonly blockHash?: string },
    callOptions?: CallOptions
  ): Promise<string> {
    return this.#lazy(() => requests.getRawTransaction(txid, options), callOptions)
  }
  /** See {@link requests.getRawTransactionVerbose}. */
  getRawTransactionVerbose(
    txid: string,
    options?: { readonly blockHash?: string },
    callOptions?: CallOptions
  ): Promise<DecodedTransaction> {
    return this.#lazy(() => requests.getRawTransactionVerbose(txid, options), callOptions)
  }
  getMempoolEntry(txid: string, callOptions?: CallOptions): Promise<MempoolEntry> {
    return this.#lazy(() => requests.getMempoolEntry(txid), callOptions)
  }
  /** See {@link requests.getTxOut}. */
  getTxOut(
    txid: string,
    vout: number,
    options?: { readonly includeMempool?: boolean },
    callOptions?: CallOptions
  ): Promise<TxOut | null> {
    return this.#lazy(() => requests.getTxOut(txid, vout, options), callOptions)
  }
  /** See {@link requests.getConfirmationTarget}. */
  getConfirmationTarget(
    valueBits: bigint,
    options?: {
      readonly securityLevel?: SecurityLevel
      readonly mergeMiningPct?: number
      readonly btcHashrate?: number
    },
    callOptions?: CallOptions
  ): Promise<ConfirmationTarget> {
    return this.#lazy(() => requests.getConfirmationTarget(valueBits, options), callOptions)
  }
  /** See {@link requests.estimateSmartFee}. */
  estimateSmartFee(
    confTarget: number,
    options?: { readonly mode?: FeeEstimateMode },
    callOptions?: CallOptions
  ): Promise<SmartFeeEstimate> {
    return this.#lazy(() => requests.estimateSmartFee(confTarget, options), callOptions)
  }
  validateAddress(address: string, callOptions?: CallOptions): Promise<AddressValidation> {
    return this.#lazy(() => requests.validateAddress(address), callOptions)
  }
  verifyDataPqcHash(proof: DataPqcHashProof, callOptions?: CallOptions): Promise<DataPqcHashVerification> {
    return this.#lazy(() => requests.verifyDataPqcHash(proof), callOptions)
  }
  /** See {@link requests.testMempoolAccept}. */
  testMempoolAccept(
    rawTxs: readonly string[],
    options?: { readonly maxFeeRateBitsPerKvB?: bigint },
    callOptions?: CallOptions
  ): Promise<MempoolAcceptance[]> {
    return this.#lazy(() => requests.testMempoolAccept(rawTxs, options), callOptions)
  }
  /** See {@link requests.sendRawTransaction}. */
  sendRawTransaction(
    hex: string,
    options?: { readonly maxFeeRateBitsPerKvB?: bigint; readonly maxBurnAmountBits?: bigint },
    callOptions?: CallOptions
  ): Promise<string> {
    return this.#lazy(() => requests.sendRawTransaction(hex, options), callOptions)
  }
  getWalletInfo(callOptions?: CallOptions): Promise<WalletInfo> {
    return this.#single(requests.getWalletInfo(), callOptions)
  }
  getTransaction(txid: string, callOptions?: CallOptions): Promise<WalletTransaction> {
    return this.#lazy(() => requests.getTransaction(txid), callOptions)
  }
  /** See {@link requests.listUnspent}. */
  listUnspent(options?: ListUnspentOptions, callOptions?: CallOptions): Promise<UnspentOutput[]> {
    return this.#lazy(() => requests.listUnspent(options), callOptions)
  }
  getAddressInfo(address: string, callOptions?: CallOptions): Promise<AddressInfo> {
    return this.#lazy(() => requests.getAddressInfo(address), callOptions)
  }
  listLockUnspent(callOptions?: CallOptions): Promise<Outpoint[]> {
    return this.#single(requests.listLockUnspent(), callOptions)
  }
  /** See {@link requests.listSinceBlock}. */
  listSinceBlock(options?: ListSinceBlockOptions, callOptions?: CallOptions): Promise<SinceBlockHistory> {
    return this.#lazy(() => requests.listSinceBlock(options), callOptions)
  }
  /** See {@link requests.listTransactions}. */
  listTransactions(options?: ListTransactionsOptions, callOptions?: CallOptions): Promise<WalletHistoryEntry[]> {
    return this.#lazy(() => requests.listTransactions(options), callOptions)
  }
  getBalances(callOptions?: CallOptions): Promise<WalletBalances> {
    return this.#single(requests.getBalances(), callOptions)
  }
  walletCreateFundedPsbt(args: WalletCreateFundedPsbtArgs, callOptions?: CallOptions): Promise<FundedPsbt> {
    return this.#lazy(() => requests.walletCreateFundedPsbt(args), callOptions)
  }
  /** See {@link requests.walletProcessPsbt}. */
  walletProcessPsbt(
    psbt: string,
    options?: {
      readonly sign?: boolean
      readonly sighashType?: SighashType
      readonly bip32derivs?: boolean
      readonly finalize?: boolean
    },
    callOptions?: CallOptions
  ): Promise<ProcessedPsbt> {
    return this.#lazy(() => requests.walletProcessPsbt(psbt, options), callOptions)
  }
  /** See {@link requests.finalizePsbt}. */
  finalizePsbt(
    psbt: string,
    options?: { readonly extract?: boolean },
    callOptions?: CallOptions
  ): Promise<FinalizedPsbt> {
    return this.#lazy(() => requests.finalizePsbt(psbt, options), callOptions)
  }
  /** See {@link requests.psbtBumpFee}. */
  psbtBumpFee(txid: string, options?: PsbtBumpFeeOptions, callOptions?: CallOptions): Promise<BumpedPsbt> {
    return this.#lazy(() => requests.psbtBumpFee(txid, options), callOptions)
  }
  /**
   * Unlock the wallet for `timeoutSeconds`, counted from when the unlock ends.
   * The deadline is the call's `timeoutMs` if it gives one, else the longer
   * of 120 s and the client's `timeoutMs`:
   * qbit Core v1.0.0 runs a new encrypted wallet's deferred keypool top-up
   * inside its first unlock, which took 25 to 49 s on regtest. A deadline
   * missed once the request was sent is an `RpcUnknownOutcomeError`: the
   * wallet may be unlocked, and `getWalletInfo().unlockedUntil` (0 when
   * locked) tells. One missed before that (waiting for a request slot, reading
   * the cookie, connecting, or in the chain re-check) is an `RpcTimeoutError`,
   * or `RpcChainGuardError` `check_failed` with one as its `cause`, and
   * nothing was sent. Every call on that
   * wallet waits for a first unlock, and the others keep the client's
   * deadline, so one sent meanwhile can need a longer `timeoutMs`. See the
   * package README.
   */
  walletPassphrase(passphrase: string, timeoutSeconds: number, callOptions?: CallOptions): Promise<void> {
    return this.#lazy(() => requests.walletPassphrase(passphrase, timeoutSeconds), callOptions).then(() => undefined)
  }
  /**
   * Lock the wallet. qbit Core answers only once a first unlock still running
   * has ended, so the default deadline is {@link QbitRpcClient.walletPassphrase}'s:
   * the call's `timeoutMs` if it gives one, else the longer of 120 s and the
   * client's `timeoutMs`. A deadline missed once the request was sent is an
   * `RpcUnknownOutcomeError`; one missed before that is an `RpcTimeoutError`,
   * or `RpcChainGuardError` `check_failed` with one as its `cause`.
   */
  walletLock(callOptions?: CallOptions): Promise<void> {
    return this.#single(requests.walletLock(), callOptions).then(() => undefined)
  }
  /** See {@link requests.getRawChangeAddress}. */
  getRawChangeAddress(options?: { readonly addressType?: AddressType }, callOptions?: CallOptions): Promise<string> {
    return this.#lazy(() => requests.getRawChangeAddress(options), callOptions)
  }
  /** See {@link requests.getNewAddress}. */
  getNewAddress(
    options?: { readonly label?: string; readonly addressType?: AddressType },
    callOptions?: CallOptions
  ): Promise<string> {
    return this.#lazy(() => requests.getNewAddress(options), callOptions)
  }
  /**
   * Lock wallet outputs against automatic coin selection, in memory or, with
   * `persistent`, in the wallet. Resolves once every output is locked; see
   * {@link requests.lockUnspent}.
   */
  lockUnspent(
    outputs: readonly Outpoint[],
    options?: { readonly persistent?: boolean },
    callOptions?: CallOptions
  ): Promise<void> {
    return this.#lazy(() => requests.lockUnspent(outputs, options), callOptions).then(() => undefined)
  }
  /**
   * Unlock wallet outputs, however they were locked. Resolves once every
   * output is unlocked; see {@link requests.unlockUnspent}.
   */
  unlockUnspent(outputs: readonly Outpoint[], callOptions?: CallOptions): Promise<void> {
    return this.#lazy(() => requests.unlockUnspent(outputs), callOptions).then(() => undefined)
  }

  /** Close pooled keep-alive connections. The client stays usable; later calls open new ones. */
  close(): void {
    this.#transport.close()
  }

  /** A description without credentials, for logs. */
  toJSON(): Record<string, unknown> {
    const url = new URL(this.#endpoint.url.href)
    return {
      url: url.href,
      expectedChain: this.#expectedChain,
      expectedGenesisHash: this.#expectedGenesisHash,
      ...(this.#expectedSignetChallenge === undefined
        ? {}
        : { expectedSignetChallenge: this.#expectedSignetChallenge }),
      capabilities: [...this.#capabilities],
      auth: this.#credentials.kind,
      ...(this.#tlsSummary === undefined ? {} : { tls: structuredClone(this.#tlsSummary) }),
      ...(this.#customConnect ? { connect: 'custom' } : {}),
      chainStatus: this.chainStatus,
    }
  }

  [inspect.custom](): string {
    return `QbitRpcClient ${inspect(this.toJSON())}`
  }

  // -------------------------------------------------------------------------

  /** Build the request inside the promise, so an invalid argument rejects instead of throwing. */
  async #lazy<T>(build: () => RpcRequest<T>, callOptions?: CallOptions): Promise<T> {
    return this.#single(build(), callOptions)
  }

  #chainExpired(at: number): boolean {
    return performance.now() - at >= this.#chainCheckMaxAgeMs
  }

  /**
   * Record what a chain check sent with `digest` reported. `since` is
   * `#doubts` when its request was sent: if something cast doubt on the node
   * since then, the answer may predate it, so a match changes nothing. A mismatch
   * answer always stands: only a `confirmChain()` that began after it was
   * recorded (`clearsBefore`, its starting `#doubts`) can replace it with a
   * match.
   */
  #recordChain(report: ChainReport, since: number, digest: string, clearsBefore: number | undefined): void {
    const chain = this.#chain
    const differs = this.#chainDifferences(report)
    if (differs.length > 0) {
      this.#doubts += 1
      this.#chain = { status: 'mismatch', report, differs, doubt: this.#doubts }
    } else if (
      report.genesisHash !== undefined &&
      this.#doubts === since &&
      (chain.status !== 'mismatch' || (clearsBefore !== undefined && chain.doubt <= clearsBefore))
    ) {
      this.#chain = { status: 'confirmed', at: performance.now(), digest }
    }
  }

  /** What `report` has that differs from the expected chain, genesis block and signet challenge. */
  #chainDifferences(report: ChainReport): ChainCheck[] {
    const differs: ChainCheck[] = []
    if (report.chain !== this.#expectedChain) differs.push('chain')
    if (report.genesisHash !== undefined && report.genesisHash !== this.#expectedGenesisHash) {
      differs.push('genesis_hash')
    }
    // A signet node always reports its challenge, so a missing one differs too.
    if (this.#expectedSignetChallenge !== undefined && report.signetChallenge !== this.#expectedSignetChallenge) {
      differs.push('signet_challenge')
    }
    return differs
  }

  /** The refusal of a guarded call (or `confirmChain()`) after the recorded `mismatch`. */
  #mismatchError(method: string, mismatch: Extract<ChainState, { status: 'mismatch' }>): RpcChainGuardError {
    const { report, differs } = mismatch
    const details: ChainMismatch = {
      differs,
      expectedGenesisHash: this.#expectedGenesisHash,
      ...(report.genesisHash === undefined ? {} : { actualGenesisHash: report.genesisHash }),
      ...(this.#expectedSignetChallenge === undefined
        ? {}
        : { expectedSignetChallenge: this.#expectedSignetChallenge }),
      ...(report.signetChallenge === undefined ? {} : { actualSignetChallenge: report.signetChallenge }),
    }
    return new RpcChainGuardError(method, 'mismatch', this.#expectedChain, {
      actualChain: report.chain,
      mismatch: details,
    })
  }

  /** A sign the node may have restarted or been replaced: re-check the chain before the next guarded call. */
  #invalidateChain(): void {
    this.#doubts += 1
    if (this.#chain.status === 'confirmed') this.#chain = { status: 'invalidated' }
  }

  /** The refusal of a guarded call while the chain is unconfirmed or another one. */
  #chainRefusal(method: string): RpcChainGuardError | undefined {
    const chain = this.#chain
    if (chain.status === 'unconfirmed') return new RpcChainGuardError(method, 'unconfirmed', this.#expectedChain)
    if (chain.status === 'mismatch') return this.#mismatchError(method, chain)
    return undefined
  }

  /**
   * Whether a call sent with `authorization` must check the chain before it
   * goes on, after `checks` checks in this attempt. A confirmation counts for
   * the cookie it was made with, and, once this attempt has checked, however
   * old it is. Throws the guard's refusal, and `stale` (retryable) once
   * MAX_CHAIN_CHECKS checks have each been doubted. `confirming` is set for
   * `confirmChain()`, to `#doubts` when it began: it always checks, and is
   * refused only by a mismatch found since then.
   */
  #chainNeedsCheck(method: string, authorization: Authorization, checks: number, confirming?: number): boolean {
    const chain = this.#chain
    if (confirming === undefined) {
      const refusal = this.#chainRefusal(method)
      if (refusal !== undefined) throw new Failure(refusal, false, false)
    } else {
      this.#refuseMismatchSince(method, confirming)
    }
    const fresh =
      checks > 0 || (confirming === undefined && chain.status === 'confirmed' && !this.#chainExpired(chain.at))
    if (chain.status === 'confirmed' && chain.digest === authorization.digest && fresh) return false
    if (checks >= MAX_CHAIN_CHECKS) {
      throw new Failure(new RpcChainGuardError(method, 'stale', this.#expectedChain), false, true)
    }
    return true
  }

  /** `confirmChain()`'s refusal: a mismatch recorded since it began (`#doubts` was `started`). */
  #refuseMismatchSince(method: string, started: number): void {
    const chain = this.#chain
    if (chain.status === 'mismatch' && chain.doubt > started) {
      throw new Failure(this.#mismatchError(method, chain), false, false)
    }
  }

  /**
   * What a guarded call rejects with when its chain guard threw `error`. A
   * refusal stands as it is, as does one for a polluted Object.prototype that
   * came after the call began. A failed re-check, or a wait before one that was cut
   * short, becomes `check_failed` about the call itself, with the failure as
   * `cause`, unless a mismatch was recorded meanwhile, which stands. The failure
   * keeps its classification: a guarded call without side effects retries it
   * under `readRetries`, and a stale socket still gets its extra attempt.
   */
  #guardFailure(method: string, error: unknown): Failure {
    if (error instanceof Failure && (RpcChainGuardError.is(error.error) || isPollutionRefusal(error.error)))
      return error
    const refusal = this.#chainRefusal(method)
    if (refusal !== undefined) return new Failure(refusal, false, false)
    // Anything else thrown here, a bug included, still failed before the call was sent.
    if (!(error instanceof Failure)) {
      return new Failure(
        new RpcChainGuardError(method, 'check_failed', this.#expectedChain, { cause: error }),
        false,
        false
      )
    }
    const failed = new RpcChainGuardError(method, 'check_failed', this.#expectedChain, { cause: error.error })
    return new Failure(failed, false, error.retryable, error.staleSocket)
  }

  /**
   * Wait `retryDelayMs` (at most 10 s) before checking the chain again. A wait
   * that would pass the deadline ends the attempt at once with the retryable
   * `stale` refusal; an abort ends it unsent, reported like a failed check.
   */
  async #pause(method: string, attempt: AttemptContext): Promise<void> {
    const delay = Math.min(this.#retryDelayMs, MAX_RETRY_DELAY_MS)
    if (performance.now() + delay >= attempt.deadline) {
      throw new Failure(new RpcChainGuardError(method, 'stale', this.#expectedChain), false, true)
    }
    try {
      await sleep(delay, attempt.signal)
    } catch {
      throw asFailure('getblockchaininfo', new ExchangeFailure('aborted', false), attempt)
    }
  }

  /**
   * One chain check, sent with `authorization` (the header of the call it
   * guards), and recorded; `clearsBefore` for `confirmChain()`'s, see
   * `#recordChain`. `getblockchaininfo` and `getblockhash 0` go in one batch:
   * one exchange under the attempt's signal, answered by one node. Its
   * failures, an error or a malformed or missing reply for either request
   * included, are definite failures that record nothing: a guarded request has
   * not been sent, and `#guardFailure` reports them as the guarded call's.
   * Whole-exchange failures name `getblockchaininfo`. The one exception: when
   * only the `getblockhash` reply fails, a chain name or signet challenge that
   * differs is still recorded as a mismatch.
   */
  async #checkChain(
    attempt: AttemptContext,
    authorization: Authorization,
    clearsBefore: number | undefined
  ): Promise<BlockchainInfo> {
    const check = requests.getBlockchainInfo()
    const genesis = requests.getBlockHash(0)
    const ids = [this.#nextId++, this.#nextId++] as const
    const body = stringifyRequest([
      { jsonrpc: '2.0', id: ids[0], method: check.method, params: check.params },
      { jsonrpc: '2.0', id: ids[1], method: genesis.method, params: genesis.params },
    ])
    const since = this.#doubts
    let info: BlockchainInfo
    let genesisHash: string | undefined
    try {
      const text = await this.#exchange(check.method, body, attempt.signal, false, undefined, authorization.header)
      const replies = repliesById(check.method, parseOrProtocolError(check.method, text), ids)
      info = this.#checkReply(check, replies, ids[0])
      try {
        genesisHash = this.#checkReply(genesis, replies, ids[1])
      } catch (error) {
        // Another chain name or signet challenge is a mismatch whatever the
        // genesis reply was, so it is recorded; otherwise the check failed.
        const shown = { chain: info.chain, genesisHash: undefined, signetChallenge: info.signetChallenge }
        if (this.#chainDifferences(shown).length === 0) throw error
      }
    } catch (error) {
      const failure = asFailure(check.method, error, attempt)
      throw new Failure(failure.error, false, failure.retryable, failure.staleSocket)
    }
    const report = { chain: info.chain, genesisHash, signetChallenge: info.signetChallenge }
    this.#recordChain(report, since, authorization.digest, clearsBefore)
    return info
  }

  /** The chain check's reply to `request`: its validated result, or a failure (-28, warming up, is retryable). */
  #checkReply<T>(request: RpcRequest<T>, replies: ReadonlyMap<number, unknown>, id: number): T {
    const path = `response[id=${id}]`
    if (!replies.has(id))
      throw new Failure(protocolError(request.method, path, 'a reply for this request'), true, false)
    const reply = this.#envelope(request.method, replies.get(id), id, path)
    if (!reply.ok) throw new Failure(reply.error, false, reply.error.rpcCode === RPC_IN_WARMUP)
    return validated(request.method, request, reply.result)
  }

  #authorize(method: string, inBatch: boolean): MethodPolicy {
    // A primitive string on every path, so the method checked is the one sent.
    if (typeof method !== 'string' || method === '') throw new TypeError('method must be a non-empty string')
    const policy = methodPolicy(method)
    if (policy === undefined) throw new RpcCapabilityError(method, 'unknown_method')
    if (inBatch && policy.capability !== 'read' && policy.capability !== 'wallet-read') {
      throw new RpcCapabilityError(method, 'not_batchable')
    }
    if (policy.capability !== 'read' && !this.#capabilities.has(policy.capability)) {
      throw new RpcCapabilityError(method, 'not_enabled', policy.capability)
    }
    if (guarded(policy)) {
      // Refuse before reading a cookie; the call decides again just before it is sent.
      const refusal = this.#chainRefusal(method)
      if (refusal !== undefined) throw refusal
    }
    return policy
  }

  async #single<T>(request: RpcRequest<T>, callOptions?: CallOptions): Promise<T> {
    const { method } = request
    refusePollution(method)
    const policy = this.#authorize(method, false)
    const id = this.#nextId++
    const body = stringifyRequest({ jsonrpc: '2.0', id, method, params: request.params })
    const settings = this.#callSettings(callOptions, ownValue(policy, 'timeoutMs'))
    return this.#operation(method, settings, policy.sideEffects, async attempt => {
      try {
        // One cookie read per attempt: the chain check and the call are sent
        // with that header, and a new cookie (qbitd restarted) means a check.
        const authorization = await this.#authorization(method, attempt.signal)
        if (guarded(policy)) {
          try {
            // Decide after the last await: a mismatch or doubt recorded meanwhile is honoured.
            for (let checks = 0; this.#chainNeedsCheck(method, authorization, checks); checks += 1) {
              if (checks > 0) {
                await this.#pause(method, attempt)
                // Decide again after the wait: a mismatch recorded meanwhile refuses the call.
                if (!this.#chainNeedsCheck(method, authorization, checks)) break
              }
              await this.#checkChain(attempt, authorization, undefined)
            }
          } catch (error) {
            throw this.#guardFailure(method, error)
          }
        }
        const text = await this.#exchange(method, body, attempt.signal, policy.sideEffects, id, authorization.header)
        const reply = this.#envelope(method, parseOrProtocolError(method, text), id, 'response')
        if (!reply.ok) {
          throw new Failure(reply.error, false, !policy.sideEffects && reply.error.rpcCode === RPC_IN_WARMUP)
        }
        return validated(method, request, reply.result)
      } catch (error) {
        const failure = asFailure(method, error, attempt)
        if (policy.sideEffects && failure.unknown) {
          throw new Failure(new RpcUnknownOutcomeError(method, failure.error, request.txid), false, false)
        }
        throw failure
      }
    })
  }

  async #batch(entries: readonly RpcRequest<unknown>[], callOptions: unknown): Promise<BatchItem<unknown>[]> {
    if (!Array.isArray(entries)) throw new TypeError('batch takes an array of requests')
    refusePollution(`batch(${entries.length})`)
    const settings = this.#callSettings(callOptions)
    // Refused from the length before anything is copied, and again on the copy, which is what is sent.
    const tooMany = (length: number): void => {
      if (length > MAX_BATCH) throw new RangeError(`a batch holds at most ${MAX_BATCH} requests`)
    }
    tooMany(entries.length)
    // Each entry's own fields, read once: a hole, or a params, method or parse
    // an entry leaves out, is never read from a prototype.
    const given = ownElements(entries, 'entries')
    tooMany(given.length)
    const list = given.map((entry, index) => {
      const own =
        (typeof entry === 'object' || typeof entry === 'function') && entry !== null
          ? plainOptions(entry, `entries[${index}]`, BATCH_ENTRY)
          : undefined
      // A caller's mistake, not the node's: refused before anything is sent.
      if (typeof own?.parse !== 'function') throw new TypeError(`batch() entry ${index} has no parse function`)
      // A primitive string, so the method the allowlist checks is the one sent:
      // a String object or a toJSON could name another.
      if (typeof own.method !== 'string' || own.method === '') {
        throw new TypeError(`batch() entry ${index} has no method name: method must be a non-empty string`)
      }
      return own as RpcRequest<unknown>
    })
    for (const entry of list) this.#authorize(entry.method, true)
    if (list.length === 0) return []
    const ids = list.map(() => this.#nextId++)
    const label = `batch(${list.length})`
    const bodies = list.map((entry, index) => {
      try {
        // Inside the batch's array, which counts towards the depth limit.
        return stringifyRequest({ jsonrpc: '2.0', id: ids[index], method: entry.method, params: entry.params }, 1)
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        throw new TypeError(`batch() entry ${index}: ${error.message}`, { cause: error })
      }
    })
    const body = `[${bodies.join(',')}]`
    return this.#operation(label, settings, false, async attempt => {
      let text: string
      try {
        const authorization = await this.#authorization(label, attempt.signal)
        text = await this.#exchange(label, body, attempt.signal, false, undefined, authorization.header)
      } catch (error) {
        throw asFailure(label, error, attempt)
      }
      const byId = repliesById(label, parseOrProtocolError(label, text), ids)
      return list.map((entry, index): BatchItem<unknown> => {
        const id = ids[index]!
        if (!byId.has(id)) {
          return { ok: false, error: protocolError(entry.method, `response[id=${id}]`, 'a reply for this request') }
        }
        const reply = this.#envelope(entry.method, byId.get(id), id, `response[id=${id}]`)
        if (!reply.ok) return { ok: false, error: reply.error }
        try {
          // Called on the caller's entry, as entry.parse(result) would be.
          return { ok: true, value: entry.parse.call(given[index], reply.result) }
        } catch (error) {
          return { ok: false, error: validationError(entry.method, error) }
        }
      })
    })
  }

  /**
   * Run `attempt` under one deadline, retrying retryable failures while time
   * remains, unless the operation has side effects. Such a retry counts against
   * `readRetries`. Apart from these, a stale pooled socket gets one more attempt
   * at once, even with side effects when the failure is definite: then only the
   * chain re-check was sent, as the request itself uses a fresh connection. The
   * deadline timer, the caller's abort listener and any backoff sleep are
   * released on every exit path.
   */
  async #operation<T>(
    label: string,
    settings: CallSettings,
    sideEffects: boolean,
    attempt: (context: AttemptContext) => Promise<T>
  ): Promise<T> {
    const retries = sideEffects ? 0 : this.#readRetries
    const { timeoutMs, signal: callerSignal } = settings
    if (callerSignal?.aborted) throw new RpcAbortedError(label, callerSignal.reason)
    const deadline = performance.now() + timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(TIMEOUT), timeoutMs)
    const onAbort = (): void => controller.abort(callerSignal!.reason)
    callerSignal?.addEventListener('abort', onAbort, { once: true })
    const context = { signal: controller.signal, deadline, timeoutMs, maxResponseBytes: this.#maxResponseBytes }
    try {
      let tries = 0
      let staleSocketTried = false
      for (;;) {
        try {
          return await this.#inSlot(label, context, async slotted => {
            try {
              return await attempt(slotted)
            } catch (error) {
              // The whole attempt runs again at once, in the same slot: a new
              // cookie read, and a guarded call re-checks the chain, which the
              // reset has made stale.
              const stale = error instanceof Failure && error.staleSocket && (!sideEffects || !error.unknown)
              if (!stale || staleSocketTried) throw error
              staleSocketTried = true
              if (slotted.signal.aborted) throw new Failure(stopError(label, slotted), false, false)
              return await attempt(slotted)
            }
          })
        } catch (error) {
          if (!(error instanceof Failure)) throw error
          const delay = Math.min(this.#retryDelayMs * 2 ** tries, MAX_RETRY_DELAY_MS)
          if (!error.retryable || tries >= retries || performance.now() + delay >= deadline) throw error.error
          tries += 1
          try {
            await sleep(delay, controller.signal)
          } catch {
            throw stopError(label, context)
          }
        }
      }
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * The call options, read once as the caller's own properties (left out, a
   * key is never read from Object.prototype) and checked: an operation takes
   * only these, so they are read and checked once. The deadline is the call's
   * `timeoutMs`; else, for a method with its own default (`methodTimeoutMs`),
   * the longer of that and the client's; else the client's, else 30 s.
   */
  #callSettings(callOptions: unknown, methodTimeoutMs?: number): CallSettings {
    const own = argOptions(callOptions, 'callOptions', CALL_OPTIONS)
    // A method's own default is a floor: a short client timeout must not cut a call qbit Core is known to need longer for.
    const fallback =
      methodTimeoutMs === undefined
        ? (this.#timeoutMs ?? DEFAULT_TIMEOUT_MS)
        : Math.max(methodTimeoutMs, this.#timeoutMs ?? 0)
    const timeoutMs = checkInteger(own['timeoutMs'], 'callOptions.timeoutMs', 1, 3_600_000, fallback)
    const signal = own['signal']
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw new TypeError('callOptions.signal must be an AbortSignal')
    return { timeoutMs, signal }
  }

  /**
   * Run one attempt in a request slot, taken before anything else the attempt
   * does (the cookie read, the guard's decision, a chain re-check and the pause
   * before checking again) and released however it ends. A stale socket's extra
   * attempt runs in the same slot; a retry's backoff holds none. A deadline or
   * abort before the attempt starts is a definite failure: nothing was sent.
   */
  async #inSlot<T>(
    label: string,
    context: AttemptContext,
    attempt: (context: AttemptContext) => Promise<T>
  ): Promise<T> {
    try {
      await this.#limiter.acquire(context.signal)
    } catch {
      throw new Failure(stopError(label, context), false, false)
    }
    try {
      if (context.signal.aborted) throw new Failure(stopError(label, context), false, false)
      return await attempt(context)
    } finally {
      this.#limiter.release()
    }
  }

  /**
   * One HTTP exchange. Returns the body of a 200 reply; anything else throws a
   * Failure or ExchangeFailure. `id` is the single request's id, or undefined
   * for a batch. The request is handed to the transport before the first
   * await, so nothing recorded after a guard decision made just before the
   * call can slip in between; nothing recorded after that can recall it.
   */
  async #exchange(
    method: string,
    body: string,
    signal: AbortSignal,
    sideEffects: boolean,
    id: number | undefined,
    authorization: string
  ): Promise<string> {
    let reply
    try {
      reply = await this.#transport.send({
        url: this.#endpoint.url,
        authorization,
        body,
        signal,
        maxResponseBytes: this.#maxResponseBytes,
        freshConnection: sideEffects,
      })
    } catch (error) {
      // A changed certificate or address may be another node as much as a dropped connection is.
      if (error instanceof ExchangeFailure && CONNECTION_KINDS.has(error.kind)) this.#invalidateChain()
      throw error
    }
    if (reply.status === 401) this.#invalidateChain()
    if (reply.status === 200) return reply.body
    // A JSON-RPC error reply for this request id under a status qbitd uses for
    // one (JSON-RPC 1.x behaviour, passed through by a proxy) is the node's answer.
    // Under any other status qbitd did not send it, directNode or not: something
    // in between read the request and may have forwarded it, so it is that
    // status's error, and an unknown outcome for side-effecting calls. So is
    // anything else under a 5xx, which may come from a proxy after the node acted.
    const legacy = id === undefined ? undefined : legacyError(method, reply.body, id)
    if (legacy !== undefined && NODE_ERROR_STATUSES.has(reply.status)) throw new Failure(legacy, false, false)
    const transportError = new RpcTransportError(method, 'http_status', { status: reply.status })
    // With the endpoint declared to be qbitd itself, this exact reply is its
    // refusal to queue the request, which it sends without running anything.
    if (this.#directNode && reply.status === 503 && reply.body === WORK_QUEUE_REJECTION) {
      throw new Failure(transportError, false, true)
    }
    if (reply.status >= 500) throw new Failure(transportError, true, true)
    if (reply.status >= 300) {
      // Rejected before execution (authentication, rpcallowip, unknown path),
      // unless a JSON-RPC error for this request shows something read it.
      throw new Failure(
        transportError,
        legacy !== undefined,
        reply.status === 401 && this.#credentials.kind === 'cookie'
      )
    }
    throw new Failure(protocolError(method, 'response', `HTTP 200, not ${reply.status}`), true, false)
  }

  /** The Authorization header for one attempt, and its digest: a new cookie (qbitd restarted) makes the chain stale. */
  async #authorization(method: string, signal: AbortSignal): Promise<Authorization> {
    const read = ++this.#authReads
    let header: string
    try {
      header = await abortable(this.#credentials.header(signal), signal)
    } catch (error) {
      if (signal.aborted) throw new ExchangeFailure('aborted', false)
      if (error instanceof CookieReadFailure) {
        throw new Failure(new RpcTransportError(method, 'credentials', { code: error.code }), false, true)
      }
      throw error
    }
    const digest = createHash('sha256').update(header).digest('hex')
    if (read > this.#authDigestRead) {
      this.#authDigest = digest
      this.#authDigestRead = read
    }
    return { header, digest }
  }

  /** Validate one JSON-RPC 2.0 reply object. */
  #envelope(
    method: string,
    value: unknown,
    id: number,
    path: string
  ): { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: RpcError } {
    if (!isJsonObject(value)) throw new Failure(protocolError(method, path, 'a JSON-RPC reply object'), true, false)
    const reply = value
    for (const key of Object.keys(reply)) {
      if (key !== 'jsonrpc' && key !== 'id' && key !== 'result' && key !== 'error') {
        throw new Failure(protocolError(method, `${path}.${key}`, 'only jsonrpc, id, result and error'), true, false)
      }
    }
    if (ownValue(reply, 'jsonrpc') !== '2.0') {
      throw new Failure(protocolError(method, `${path}.jsonrpc`, '"2.0"'), true, false)
    }
    const replyId = ownValue(reply, 'id')
    if (!(replyId instanceof JsonNumber) || replyId.source !== String(id)) {
      throw new Failure(protocolError(method, `${path}.id`, `the request id ${id}`), true, false)
    }
    const hasResult = Object.hasOwn(reply, 'result')
    const hasError = Object.hasOwn(reply, 'error')
    if (hasResult === hasError) {
      throw new Failure(protocolError(method, path, 'exactly one of result and error'), true, false)
    }
    // ok is always set, so no key of this object is read from Object.prototype.
    if (hasResult) return { ok: true, result: ownValue(reply, 'result') }
    const error = ownValue(reply, 'error')
    // Any other error (an array, a number, a string) is malformed: an unknown outcome for a side-effecting call.
    const nodeError = isJsonObject(error) ? nodeErrorFrom(method, error) : undefined
    if (nodeError === undefined) {
      throw new Failure(
        protocolError(method, `${path}.error`, 'an object with an integer code and a message'),
        true,
        false
      )
    }
    return { ok: false, error: nodeError }
  }
}

function guarded(policy: MethodPolicy): boolean {
  return policy.capability === 'wallet-write' || policy.capability === 'broadcast'
}

function legacyError(method: string, body: string, id: number): RpcError | undefined {
  let reply: unknown
  try {
    reply = parseJsonLossless(body)
  } catch {
    return undefined
  }
  if (!isJsonObject(reply)) return undefined
  const replyId = ownValue(reply, 'id')
  if (!(replyId instanceof JsonNumber) || replyId.source !== String(id)) return undefined
  // A body that also claims a result contradicts itself: not a definite node error, as in #envelope.
  const result = ownValue(reply, 'result')
  if (result !== undefined && result !== null) return undefined
  const error = ownValue(reply, 'error')
  return isJsonObject(error) ? nodeErrorFrom(method, error) : undefined
}

/** The node's error, from an object parseJsonLossless made. */
function nodeErrorFrom(method: string, error: Readonly<Record<string, unknown>>): RpcError | undefined {
  const code = ownValue(error, 'code')
  const message = ownValue(error, 'message')
  if (!(code instanceof JsonNumber) || !/^-?(?:0|[1-9][0-9]{0,9})$/.test(code.source) || typeof message !== 'string') {
    return undefined
  }
  return new RpcError(method, Number(code.source), message.slice(0, MAX_NODE_MESSAGE))
}

function protocolError(method: string, path: string, expected: string): RpcResponseError {
  return new RpcResponseError(method, 'protocol', path, expected)
}

/**
 * A batch reply's items by request id. Throws unless it is an array whose
 * every item answers one of `ids`, once; an id with no item is absent.
 */
function repliesById(label: string, parsed: unknown, ids: readonly number[]): Map<number, unknown> {
  if (!Array.isArray(parsed)) throw new Failure(protocolError(label, 'response', 'an array of replies'), true, false)
  const byId = new Map<number, unknown>()
  parsed.forEach((item, index) => {
    const path = `response[${index}]`
    const replyId = isJsonObject(item) ? ownValue(item, 'id') : undefined
    const numericId =
      replyId instanceof JsonNumber && /^[1-9][0-9]*$/.test(replyId.source) ? Number(replyId.source) : NaN
    if (!ids.includes(numericId) || byId.has(numericId)) {
      throw new Failure(protocolError(label, `${path}.id`, 'the id of a request in this batch, once'), true, false)
    }
    byId.set(numericId, item)
  })
  return byId
}

function parseOrProtocolError(method: string, text: string): unknown {
  try {
    return parseJsonLossless(text)
  } catch {
    throw new Failure(protocolError(method, 'response', 'a JSON body'), true, false)
  }
}

/** The failure of a request's `parse`: this package's validators throw `ResultIssue`, and a custom one anything. */
function validationError(method: string, thrown: unknown): RpcResponseError {
  return thrown instanceof ResultIssue
    ? new RpcResponseError(method, 'validation', thrown.path, thrown.expected)
    : new RpcResponseError(method, 'validation', 'result', "a result this request's parse function accepts", {
        cause: thrown,
      })
}

function validated<T>(method: string, request: RpcRequest<T>, result: unknown): T {
  try {
    return request.parse(result)
  } catch (error) {
    throw new Failure(validationError(method, error), true, false)
  }
}

/** An attempt's Authorization header, and its digest for comparing it with a confirmation's. */
interface Authorization {
  readonly header: string
  readonly digest: string
}

/** The call options, read and checked by `#callSettings`. */
interface CallSettings {
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
}

interface AttemptContext {
  /** Fires at the operation's deadline (reason TIMEOUT) or when the caller aborts (the caller's reason). */
  readonly signal: AbortSignal
  /** The operation's deadline, on the `performance.now()` clock. */
  readonly deadline: number
  readonly timeoutMs: number
  readonly maxResponseBytes: number
}

/**
 * Refuses a call while Object.prototype is polluted, before anything else it
 * does, so that it fails as this and not as a refused chain check. The
 * transport checks again before each request and connection.
 */
function refusePollution(method: string): void {
  const polluted = prototypePollution()
  if (polluted > 0) throw new RpcTransportError(method, 'prototype_polluted', { pollutedKeys: polluted })
}

function isPollutionRefusal(error: unknown): boolean {
  return RpcTransportError.is(error) && error.reason === 'prototype_polluted'
}

/** The error for an attempt whose signal fired: the deadline or the caller's abort. */
function stopError(method: string, attempt: AttemptContext): QbitRpcError {
  const reason = attempt.signal.reason
  return reason === TIMEOUT ? new RpcTimeoutError(method, attempt.timeoutMs) : new RpcAbortedError(method, reason)
}

/** Turn whatever an attempt threw into a Failure with its outcome and retry classification. */
function asFailure(method: string, error: unknown, attempt: AttemptContext): Failure {
  if (error instanceof Failure) return error
  if (error instanceof ExchangeFailure) {
    switch (error.kind) {
      case 'aborted':
        return new Failure(stopError(method, attempt), error.sent, false)
      case 'too_large':
        return new Failure(new RpcResponseTooLargeError(method, attempt.maxResponseBytes), true, false)
      case 'bad_body':
        return new Failure(protocolError(method, 'response', 'a UTF-8 body'), true, false)
      case 'network':
        return new Failure(
          new RpcTransportError(method, 'network', error.code === undefined ? {} : { code: error.code }),
          error.sent,
          true,
          error.staleSocket
        )
      // Refusals that trying again would only repeat. An alert after the
      // request was written is sent: an unknown outcome for a side-effecting call.
      case 'tls':
        return new Failure(
          new RpcTransportError(method, 'tls', error.code === undefined ? {} : { code: error.code }),
          error.sent,
          false
        )
      case 'not_loopback':
        return new Failure(new RpcTransportError(method, 'not_loopback'), error.sent, false)
      case 'prototype_polluted':
        return new Failure(
          new RpcTransportError(method, 'prototype_polluted', { pollutedKeys: error.pollutedKeys ?? 0 }),
          error.sent,
          false
        )
    }
  }
  throw error
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
