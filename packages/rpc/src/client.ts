import { createHash } from 'node:crypto'
import { inspect } from 'node:util'

import {
  CAPABILITIES,
  methodPolicy,
  QBIT_CHAINS,
  type Capability,
  type MethodPolicy,
  type QbitChain,
} from './capabilities'
import { CookieReadFailure, Credentials, parseEndpoint, type Endpoint, type RpcAuth } from './endpoint'
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
} from './errors'
import { assertLosslessJsonSupport, JsonNumber, parseJsonLossless, stringifyRequest } from './json'
import {
  argOptions,
  requests,
  withCallOptions,
  type AddressInfo,
  type AddressValidation,
  type BlockchainInfo,
  type BlockHeader,
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
import { ExchangeFailure, HttpTransport } from './transport'
import { ResultIssue } from './validate'

export interface QbitRpcClientOptions {
  /**
   * The node's JSON-RPC endpoint, such as `http://127.0.0.1:48352/` for
   * testnet4. Plain `http` is only accepted for a loopback host. The path may
   * already name a wallet (`/wallet/<name>`); otherwise pass `wallet`.
   */
  readonly url: string
  /** Send every call to `/wallet/<name>`. Required for wallet calls when the node has several wallets loaded. */
  readonly wallet?: string
  readonly auth: RpcAuth
  /** The chain this client must talk to. `confirmChain()` checks it; wallet-write and broadcast calls wait for that check. */
  readonly expectedChain: QbitChain
  /** Capabilities beyond chain reads. Default none: read-only. */
  readonly capabilities?: readonly Capability[]
  /** Deadline for one operation (a call or a batch, with every retry and the cookie read). Default 30,000 ms. */
  readonly timeoutMs?: number
  /** Largest response body read before the call fails. Default 16 MiB. */
  readonly maxResponseBytes?: number
  /**
   * Extra attempts for methods without side effects after a connection error,
   * an HTTP 5xx, a credentials failure, an HTTP 401 under cookie auth, or
   * (single calls) RPC error -28, node warming up. Default 0: no retries.
   * Methods with side effects are never retried.
   */
  readonly readRetries?: number
  /** Delay before the first retry; it doubles for each further one, up to 10 s. Default 250 ms. */
  readonly retryDelayMs?: number
  /**
   * How long a chain confirmation stays fresh. A wallet-write or broadcast call
   * made later first re-runs the chain check, under the call's own deadline.
   * A connection error, an HTTP 401 or a changed cookie (a qbitd restart)
   * makes the confirmation stale at once. 0 re-checks before every such call.
   * Default 10,000 ms.
   */
  readonly chainCheckMaxAgeMs?: number
}

/** Per-call options. */
export interface CallOptions {
  /** Aborts the call. An abort after a side-effecting request was sent is an `RpcUnknownOutcomeError`. */
  readonly signal?: AbortSignal
  /** Overrides the client's `timeoutMs` for this operation. */
  readonly timeoutMs?: number
}

/** One batch entry's outcome. Transport, timeout and size failures reject the whole batch instead. */
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
 * - `confirmed`: the node reported `expectedChain` within `chainCheckMaxAgeMs`.
 * - `stale`: it did, but longer ago, or a connection error, an HTTP 401 or a
 *   cookie change happened since. The next wallet-write or broadcast call
 *   checks the chain again before it is sent.
 * - `mismatch`: the node reported another chain. Wallet-write and broadcast
 *   calls are refused until `confirmChain()` matches again.
 */
export type ChainStatus = 'unconfirmed' | 'confirmed' | 'stale' | 'mismatch'

type ChainState =
  | { readonly status: 'unconfirmed' }
  /** `digest`: of the Authorization header the check was sent with; a call with another one checks again. */
  | { readonly status: 'confirmed'; readonly at: number; readonly digest: string }
  | { readonly status: 'invalidated' }
  /** `doubt`: `#doubts` once it was recorded, to tell a check sent before it from one sent after. */
  | { readonly status: 'mismatch'; readonly actual: string; readonly doubt: number }

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const DEFAULT_RETRY_DELAY_MS = 250
const DEFAULT_CHAIN_CHECK_MAX_AGE_MS = 10_000
const MAX_RETRY_DELAY_MS = 10_000
const MAX_BATCH = 1000
const RPC_IN_WARMUP = -28
const MAX_NODE_MESSAGE = 1000
/** Chain checks one guarded attempt or `confirmChain()` runs while each answer is doubted. */
const MAX_CHAIN_CHECKS = 3

const TIMEOUT = Symbol('timeout')
const CALL_OPTIONS = ['signal', 'timeoutMs'] as const satisfies readonly (keyof CallOptions)[]

/** An attempt's failure, with what is known about whether the node may have acted on it. */
class Failure {
  constructor(
    readonly error: QbitRpcError,
    /** The request may have been executed and no definite answer arrived. */
    readonly unknown: boolean,
    readonly retryable: boolean
  ) {}
}

function checkInteger(value: unknown, name: string, min: number, max: number, fallback: number): number {
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
 */
export class QbitRpcClient {
  readonly #endpoint: Endpoint
  readonly #credentials: Credentials
  readonly #expectedChain: QbitChain
  readonly #capabilities: ReadonlySet<Capability>
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #readRetries: number
  readonly #retryDelayMs: number
  readonly #chainCheckMaxAgeMs: number
  readonly #transport = new HttpTransport()
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
    this.#endpoint = parseEndpoint(options.url, options.wallet)
    this.#credentials = new Credentials(options.auth, this.#endpoint)
    if (!(QBIT_CHAINS as readonly unknown[]).includes(options.expectedChain)) {
      throw new TypeError(`expectedChain must be one of ${QBIT_CHAINS.join(', ')}`)
    }
    this.#expectedChain = options.expectedChain
    const capabilities = options.capabilities ?? []
    if (!Array.isArray(capabilities)) throw new TypeError('capabilities must be an array')
    for (const capability of capabilities) {
      if (!(CAPABILITIES as readonly unknown[]).includes(capability)) {
        throw new TypeError(`unknown capability ${String(capability)}: use ${CAPABILITIES.join(', ')}`)
      }
    }
    this.#capabilities = new Set(capabilities)
    this.#timeoutMs = checkInteger(options.timeoutMs, 'timeoutMs', 1, 3_600_000, DEFAULT_TIMEOUT_MS)
    this.#maxResponseBytes = checkInteger(
      options.maxResponseBytes,
      'maxResponseBytes',
      1024,
      256 * 1024 * 1024,
      DEFAULT_MAX_RESPONSE_BYTES
    )
    this.#readRetries = checkInteger(options.readRetries, 'readRetries', 0, 10, 0)
    this.#retryDelayMs = checkInteger(options.retryDelayMs, 'retryDelayMs', 0, 60_000, DEFAULT_RETRY_DELAY_MS)
    this.#chainCheckMaxAgeMs = checkInteger(
      options.chainCheckMaxAgeMs,
      'chainCheckMaxAgeMs',
      0,
      86_400_000,
      DEFAULT_CHAIN_CHECK_MAX_AGE_MS
    )
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
   * Call `getblockchaininfo` and compare its `chain` with `expectedChain`. On a
   * match, wallet-write and broadcast calls are allowed; once the confirmation
   * goes stale they re-run this check before they are sent. On a mismatch they
   * stay refused and this throws `RpcChainGuardError`, as it does when any
   * check finds a mismatch while this call runs (its cookie read, checks,
   * waits and retries included). An answer that a connection error or an
   * HTTP 401 elsewhere may postdate is checked again, after `retryDelayMs`, up
   * to three checks per attempt; then this throws `reason: 'stale'` (retried
   * like a read under `readRetries`) and changes nothing.
   */
  async confirmChain(options: CallOptions = {}): Promise<BlockchainInfo> {
    const method = 'getblockchaininfo'
    // A mismatch recorded after this point is newer than this call: it stands, and this call throws it.
    const started = this.#doubts
    return this.#operation(method, options, this.#readRetries, async attempt => {
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
  call(method: string, params: readonly unknown[] = [], options: CallOptions = {}): Promise<unknown> {
    return this.#lazy(() => requests.raw(method, params), options)
  }

  /**
   * Send several read or wallet-read requests in one JSON-RPC batch, matched
   * to their replies by id. Each entry succeeds or fails on its own; a
   * transport failure, timeout or oversized reply rejects the whole batch.
   */
  batch<const T extends readonly RpcRequest<unknown>[]>(
    entries: T,
    options: CallOptions = {}
  ): Promise<BatchResults<T>> {
    return this.#batch(entries, options) as Promise<BatchResults<T>>
  }

  getBlockchainInfo(options?: CallOptions): Promise<BlockchainInfo> {
    return this.#single(requests.getBlockchainInfo(), options)
  }
  getNetworkInfo(options?: CallOptions): Promise<NetworkInfo> {
    return this.#single(requests.getNetworkInfo(), options)
  }
  getBestBlockHash(options?: CallOptions): Promise<string> {
    return this.#single(requests.getBestBlockHash(), options)
  }
  getBlockCount(options?: CallOptions): Promise<number> {
    return this.#single(requests.getBlockCount(), options)
  }
  getBlockHash(height: number, options?: CallOptions): Promise<string> {
    return this.#lazy(() => requests.getBlockHash(height), options)
  }
  getBlockHeader(blockHash: string, options?: CallOptions): Promise<BlockHeader> {
    return this.#lazy(() => requests.getBlockHeader(blockHash), options)
  }
  getRawTransaction(txid: string, options?: { readonly blockHash?: string } & CallOptions): Promise<string> {
    return this.#lazyWith(options, own => requests.getRawTransaction(txid, own))
  }
  getRawTransactionVerbose(
    txid: string,
    options?: { readonly blockHash?: string } & CallOptions
  ): Promise<DecodedTransaction> {
    return this.#lazyWith(options, own => requests.getRawTransactionVerbose(txid, own))
  }
  getMempoolEntry(txid: string, options?: CallOptions): Promise<MempoolEntry> {
    return this.#lazy(() => requests.getMempoolEntry(txid), options)
  }
  getTxOut(
    txid: string,
    vout: number,
    options?: { readonly includeMempool?: boolean } & CallOptions
  ): Promise<TxOut | null> {
    return this.#lazyWith(options, own => requests.getTxOut(txid, vout, own))
  }
  getConfirmationTarget(
    valueBits: bigint,
    options?: {
      readonly securityLevel?: SecurityLevel
      readonly mergeMiningPct?: number
      readonly btcHashrate?: number
    } & CallOptions
  ): Promise<ConfirmationTarget> {
    return this.#lazyWith(options, own => requests.getConfirmationTarget(valueBits, own))
  }
  estimateSmartFee(
    confTarget: number,
    options?: { readonly mode?: FeeEstimateMode } & CallOptions
  ): Promise<SmartFeeEstimate> {
    return this.#lazyWith(options, own => requests.estimateSmartFee(confTarget, own))
  }
  validateAddress(address: string, options?: CallOptions): Promise<AddressValidation> {
    return this.#lazy(() => requests.validateAddress(address), options)
  }
  verifyDataPqcHash(proof: DataPqcHashProof, options?: CallOptions): Promise<DataPqcHashVerification> {
    return this.#lazy(() => requests.verifyDataPqcHash(proof), options)
  }
  testMempoolAccept(
    rawTxs: readonly string[],
    options?: { readonly maxFeeRateBitsPerKvB?: bigint } & CallOptions
  ): Promise<MempoolAcceptance[]> {
    return this.#lazyWith(options, own => requests.testMempoolAccept(rawTxs, own))
  }
  sendRawTransaction(
    hex: string,
    options?: { readonly maxFeeRateBitsPerKvB?: bigint; readonly maxBurnAmountBits?: bigint } & CallOptions
  ): Promise<string> {
    return this.#lazyWith(options, own => requests.sendRawTransaction(hex, own))
  }
  getWalletInfo(options?: CallOptions): Promise<WalletInfo> {
    return this.#single(requests.getWalletInfo(), options)
  }
  getTransaction(txid: string, options?: CallOptions): Promise<WalletTransaction> {
    return this.#lazy(() => requests.getTransaction(txid), options)
  }
  listUnspent(options?: ListUnspentOptions & CallOptions): Promise<UnspentOutput[]> {
    return this.#lazyWith(options, own => requests.listUnspent(own))
  }
  getAddressInfo(address: string, options?: CallOptions): Promise<AddressInfo> {
    return this.#lazy(() => requests.getAddressInfo(address), options)
  }
  listLockUnspent(options?: CallOptions): Promise<Outpoint[]> {
    return this.#single(requests.listLockUnspent(), options)
  }
  listSinceBlock(options?: ListSinceBlockOptions & CallOptions): Promise<SinceBlockHistory> {
    return this.#lazyWith(options, own => requests.listSinceBlock(own))
  }
  listTransactions(options?: ListTransactionsOptions & CallOptions): Promise<WalletHistoryEntry[]> {
    return this.#lazyWith(options, own => requests.listTransactions(own))
  }
  getBalances(options?: CallOptions): Promise<WalletBalances> {
    return this.#single(requests.getBalances(), options)
  }
  walletCreateFundedPsbt(args: WalletCreateFundedPsbtArgs, options?: CallOptions): Promise<FundedPsbt> {
    return this.#lazy(() => requests.walletCreateFundedPsbt(args), options)
  }
  walletProcessPsbt(
    psbt: string,
    options?: {
      readonly sign?: boolean
      readonly sighashType?: SighashType
      readonly bip32derivs?: boolean
      readonly finalize?: boolean
    } & CallOptions
  ): Promise<ProcessedPsbt> {
    return this.#lazyWith(options, own => requests.walletProcessPsbt(psbt, own))
  }
  finalizePsbt(psbt: string, options?: { readonly extract?: boolean } & CallOptions): Promise<FinalizedPsbt> {
    return this.#lazyWith(options, own => requests.finalizePsbt(psbt, own))
  }
  walletPassphrase(passphrase: string, timeoutSeconds: number, options?: CallOptions): Promise<void> {
    return this.#lazy(() => requests.walletPassphrase(passphrase, timeoutSeconds), options).then(() => undefined)
  }
  walletLock(options?: CallOptions): Promise<void> {
    return this.#single(requests.walletLock(), options).then(() => undefined)
  }
  getRawChangeAddress(options?: { readonly addressType?: string } & CallOptions): Promise<string> {
    return this.#lazyWith(options, own => requests.getRawChangeAddress(own))
  }
  getNewAddress(options?: { readonly label?: string; readonly addressType?: string } & CallOptions): Promise<string> {
    return this.#lazyWith(options, own => requests.getNewAddress(own))
  }
  lockUnspent(
    unlock: boolean,
    outputs: readonly Outpoint[],
    options?: { readonly persistent?: boolean } & CallOptions
  ): Promise<boolean> {
    return this.#lazyWith(options, own => requests.lockUnspent(unlock, outputs, own))
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
      capabilities: [...this.#capabilities],
      auth: this.#credentials.kind,
      chainStatus: this.chainStatus,
    }
  }

  [inspect.custom](): string {
    return `QbitRpcClient ${inspect(this.toJSON())}`
  }

  // -------------------------------------------------------------------------

  /** Build the request inside the promise, so an invalid argument rejects instead of throwing. */
  async #lazy<T>(build: () => RpcRequest<T>, options?: CallOptions): Promise<T> {
    return this.#single(build(), options)
  }

  /**
   * `#lazy` for a typed method whose options carry the call options too: its
   * request builder checks the other keys, and allows these two there.
   */
  async #lazyWith<T, O extends object>(
    options: (O & CallOptions) | undefined,
    build: (own: O | undefined) => RpcRequest<T>
  ): Promise<T> {
    if (options === undefined) return this.#single(build(undefined))
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new TypeError('options must be an object')
    }
    const view = options as Record<string, unknown>
    const call = { signal: view['signal'], timeoutMs: view['timeoutMs'] }
    return this.#single(
      withCallOptions(options, () => build(options)),
      call as CallOptions
    )
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
  #recordChain(info: BlockchainInfo, since: number, digest: string, clearsBefore: number | undefined): void {
    const chain = this.#chain
    if (info.chain !== this.#expectedChain) {
      this.#doubts += 1
      this.#chain = { status: 'mismatch', actual: info.chain, doubt: this.#doubts }
    } else if (
      this.#doubts === since &&
      (chain.status !== 'mismatch' || (clearsBefore !== undefined && chain.doubt <= clearsBefore))
    ) {
      this.#chain = { status: 'confirmed', at: performance.now(), digest }
    }
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
    if (chain.status === 'mismatch')
      return new RpcChainGuardError(method, 'mismatch', this.#expectedChain, chain.actual)
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
      throw new Failure(new RpcChainGuardError(method, 'mismatch', this.#expectedChain, chain.actual), false, false)
    }
  }

  /**
   * Wait `retryDelayMs` (at most 10 s) before checking the chain again. A wait
   * that would pass the deadline ends the attempt at once with the retryable
   * `stale` refusal; an abort ends it unsent, reported like a failed check,
   * under `getblockchaininfo`.
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
   * `#recordChain`. Its failures are plain failures: a guarded request has
   * not been sent.
   */
  async #checkChain(
    attempt: AttemptContext,
    authorization: Authorization,
    clearsBefore: number | undefined
  ): Promise<BlockchainInfo> {
    const check = requests.getBlockchainInfo()
    const id = this.#nextId++
    const body = stringifyRequest({ jsonrpc: '2.0', id, method: check.method, params: check.params })
    const since = this.#doubts
    let info: BlockchainInfo
    try {
      const text = await this.#exchange(check.method, body, attempt.signal, false, id, authorization.header)
      const reply = this.#envelope(check.method, parseOrProtocolError(check.method, text), id, 'response')
      if ('error' in reply) throw new Failure(reply.error, false, reply.error.code === RPC_IN_WARMUP)
      info = validated(check.method, check, reply.result)
    } catch (error) {
      const failure = asFailure(check.method, error, attempt)
      throw new Failure(failure.error, false, failure.retryable)
    }
    this.#recordChain(info, since, authorization.digest, clearsBefore)
    return info
  }

  #authorize(method: string, inBatch: boolean): MethodPolicy {
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

  async #single<T>(request: RpcRequest<T>, options: CallOptions = {}): Promise<T> {
    const { method } = request
    const policy = this.#authorize(method, false)
    const id = this.#nextId++
    const body = stringifyRequest({ jsonrpc: '2.0', id, method, params: request.params })
    return this.#operation(method, options, policy.sideEffects ? 0 : this.#readRetries, async attempt => {
      try {
        // One cookie read per attempt: the chain check and the call are sent
        // with that header, and a new cookie (qbitd restarted) means a check.
        const authorization = await this.#authorization(method, attempt.signal)
        if (guarded(policy)) {
          // Decide after the last await: a mismatch or doubt recorded meanwhile is honoured.
          for (let checks = 0; this.#chainNeedsCheck(method, authorization, checks); checks += 1) {
            if (checks > 0) {
              await this.#pause(method, attempt)
              // Decide again after the wait: a mismatch recorded meanwhile refuses the call.
              if (!this.#chainNeedsCheck(method, authorization, checks)) break
            }
            await this.#checkChain(attempt, authorization, undefined)
          }
        }
        const text = await this.#exchange(method, body, attempt.signal, policy.sideEffects, id, authorization.header)
        const reply = this.#envelope(method, parseOrProtocolError(method, text), id, 'response')
        if ('error' in reply) {
          throw new Failure(reply.error, false, !policy.sideEffects && reply.error.code === RPC_IN_WARMUP)
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

  async #batch(entries: readonly RpcRequest<unknown>[], options: CallOptions): Promise<BatchItem<unknown>[]> {
    if (!Array.isArray(entries)) throw new TypeError('batch takes an array of requests')
    argOptions(options, 'options', CALL_OPTIONS)
    if (entries.length > MAX_BATCH) throw new RangeError(`a batch holds at most ${MAX_BATCH} requests`)
    for (const entry of entries) this.#authorize(entry.method, true)
    if (entries.length === 0) return []
    const ids = entries.map(() => this.#nextId++)
    const label = `batch(${entries.length})`
    const body = stringifyRequest(
      entries.map((entry, index) => ({ jsonrpc: '2.0', id: ids[index], method: entry.method, params: entry.params }))
    )
    return this.#operation(label, options, this.#readRetries, async attempt => {
      let text: string
      try {
        const authorization = await this.#authorization(label, attempt.signal)
        text = await this.#exchange(label, body, attempt.signal, false, undefined, authorization.header)
      } catch (error) {
        throw asFailure(label, error, attempt)
      }
      const parsed = parseOrProtocolError(label, text)
      if (!Array.isArray(parsed))
        throw new Failure(protocolError(label, 'response', 'an array of replies'), true, false)
      const byId = new Map<number, unknown>()
      parsed.forEach((item, index) => {
        const path = `response[${index}]`
        const replyId = item !== null && typeof item === 'object' ? (item as Record<string, unknown>)['id'] : undefined
        const numericId =
          replyId instanceof JsonNumber && /^[1-9][0-9]*$/.test(replyId.source) ? Number(replyId.source) : NaN
        if (!ids.includes(numericId) || byId.has(numericId)) {
          throw new Failure(protocolError(label, `${path}.id`, 'the id of a request in this batch, once'), true, false)
        }
        byId.set(numericId, item)
      })
      return entries.map((entry, index): BatchItem<unknown> => {
        const id = ids[index]!
        if (!byId.has(id)) {
          return { ok: false, error: protocolError(entry.method, `response[id=${id}]`, 'a reply for this request') }
        }
        const reply = this.#envelope(entry.method, byId.get(id), id, `response[id=${id}]`)
        if ('error' in reply) return { ok: false, error: reply.error }
        try {
          return { ok: true, value: validated(entry.method, entry, reply.result) }
        } catch (error) {
          if (error instanceof Failure && RpcResponseError.is(error.error)) return { ok: false, error: error.error }
          throw error
        }
      })
    })
  }

  /**
   * Run `attempt` under one deadline, retrying retryable failures while time
   * remains. The deadline timer, the caller's abort listener and any backoff
   * sleep are released on every exit path.
   */
  async #operation<T>(
    label: string,
    options: CallOptions,
    retries: number,
    attempt: (context: AttemptContext) => Promise<T>
  ): Promise<T> {
    argOptions(options, 'options', CALL_OPTIONS)
    const timeoutMs = checkInteger(options.timeoutMs, 'timeoutMs', 1, 3_600_000, this.#timeoutMs)
    const callerSignal = options.signal
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal))
      throw new TypeError('signal must be an AbortSignal')
    if (callerSignal?.aborted) throw new RpcAbortedError(label, callerSignal.reason)
    const deadline = performance.now() + timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(TIMEOUT), timeoutMs)
    const onAbort = (): void => controller.abort(callerSignal!.reason)
    callerSignal?.addEventListener('abort', onAbort, { once: true })
    try {
      for (let tries = 0; ; tries += 1) {
        try {
          return await attempt({
            signal: controller.signal,
            deadline,
            timeoutMs,
            maxResponseBytes: this.#maxResponseBytes,
          })
        } catch (error) {
          if (!(error instanceof Failure)) throw error
          const delay = Math.min(this.#retryDelayMs * 2 ** tries, MAX_RETRY_DELAY_MS)
          if (!error.retryable || tries >= retries || performance.now() + delay >= deadline) throw error.error
          try {
            await sleep(delay, controller.signal)
          } catch {
            throw controller.signal.reason === TIMEOUT
              ? new RpcTimeoutError(label, timeoutMs)
              : new RpcAbortedError(label, controller.signal.reason)
          }
        }
      }
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onAbort)
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
      if (error instanceof ExchangeFailure && error.kind === 'network') this.#invalidateChain()
      throw error
    }
    if (reply.status === 401) this.#invalidateChain()
    if (reply.status === 200) return reply.body
    // A JSON-RPC error reply for this request id under an HTTP error status
    // (JSON-RPC 1.x behaviour, passed through by a proxy) is still the node's
    // answer. Anything else under a 5xx may come from a proxy after the node
    // acted, so it stays an unknown outcome for side-effecting calls.
    const legacy = reply.status >= 400 && id !== undefined ? legacyError(method, reply.body, id) : undefined
    if (legacy !== undefined) throw new Failure(legacy, false, false)
    const transportError = new RpcTransportError(method, 'http_status', { status: reply.status })
    if (reply.status >= 500) throw new Failure(transportError, true, true)
    if (reply.status >= 300) {
      // Rejected before execution: authentication, rpcallowip, unknown path.
      throw new Failure(transportError, false, reply.status === 401 && this.#credentials.kind === 'cookie')
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
  ): { readonly result: unknown } | { readonly error: RpcError } {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof JsonNumber) {
      throw new Failure(protocolError(method, path, 'a JSON-RPC reply object'), true, false)
    }
    const reply = value as Record<string, unknown>
    for (const key of Object.keys(reply)) {
      if (key !== 'jsonrpc' && key !== 'id' && key !== 'result' && key !== 'error') {
        throw new Failure(protocolError(method, `${path}.${key}`, 'only jsonrpc, id, result and error'), true, false)
      }
    }
    if (reply['jsonrpc'] !== '2.0') throw new Failure(protocolError(method, `${path}.jsonrpc`, '"2.0"'), true, false)
    const replyId = reply['id']
    if (!(replyId instanceof JsonNumber) || replyId.source !== String(id)) {
      throw new Failure(protocolError(method, `${path}.id`, `the request id ${id}`), true, false)
    }
    const hasResult = Object.hasOwn(reply, 'result')
    const hasError = Object.hasOwn(reply, 'error')
    if (hasResult === hasError) {
      throw new Failure(protocolError(method, path, 'exactly one of result and error'), true, false)
    }
    if (hasResult) return { result: reply['result'] }
    const error = reply['error']
    const nodeError =
      error !== null && typeof error === 'object' ? nodeErrorFrom(method, error as Record<string, unknown>) : undefined
    if (nodeError === undefined) {
      throw new Failure(
        protocolError(method, `${path}.error`, 'an object with an integer code and a message'),
        true,
        false
      )
    }
    return { error: nodeError }
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
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return undefined
  const { id: replyId, error } = reply as Record<string, unknown>
  if (!(replyId instanceof JsonNumber) || replyId.source !== String(id)) return undefined
  if (error === null || typeof error !== 'object') return undefined
  return nodeErrorFrom(method, error as Record<string, unknown>)
}

function nodeErrorFrom(method: string, error: Record<string, unknown>): RpcError | undefined {
  const code = error['code']
  const message = error['message']
  if (!(code instanceof JsonNumber) || !/^-?(?:0|[1-9][0-9]{0,9})$/.test(code.source) || typeof message !== 'string') {
    return undefined
  }
  return new RpcError(method, Number(code.source), message.slice(0, MAX_NODE_MESSAGE))
}

function protocolError(method: string, path: string, expected: string): RpcResponseError {
  return new RpcResponseError(method, 'protocol', path, expected)
}

function parseOrProtocolError(method: string, text: string): unknown {
  try {
    return parseJsonLossless(text)
  } catch {
    throw new Failure(protocolError(method, 'response', 'a JSON body'), true, false)
  }
}

function validated<T>(method: string, request: RpcRequest<T>, result: unknown): T {
  try {
    return request.parse(result)
  } catch (error) {
    if (error instanceof ResultIssue) {
      throw new Failure(new RpcResponseError(method, 'validation', error.path, error.expected), true, false)
    }
    throw error
  }
}

/** An attempt's Authorization header, and its digest for comparing it with a confirmation's. */
interface Authorization {
  readonly header: string
  readonly digest: string
}

interface AttemptContext {
  /** Fires at the operation's deadline (reason TIMEOUT) or when the caller aborts (the caller's reason). */
  readonly signal: AbortSignal
  /** The operation's deadline, on the `performance.now()` clock. */
  readonly deadline: number
  readonly timeoutMs: number
  readonly maxResponseBytes: number
}

/** Turn whatever an attempt threw into a Failure with its outcome and retry classification. */
function asFailure(method: string, error: unknown, attempt: AttemptContext): Failure {
  if (error instanceof Failure) return error
  if (error instanceof ExchangeFailure) {
    switch (error.kind) {
      case 'aborted': {
        const reason = attempt.signal.reason
        const abort =
          reason === TIMEOUT ? new RpcTimeoutError(method, attempt.timeoutMs) : new RpcAbortedError(method, reason)
        return new Failure(abort, error.sent, false)
      }
      case 'too_large':
        return new Failure(new RpcResponseTooLargeError(method, attempt.maxResponseBytes), true, false)
      case 'bad_body':
        return new Failure(protocolError(method, 'response', 'a UTF-8 body'), true, false)
      case 'network':
        return new Failure(
          new RpcTransportError(method, 'network', error.code === undefined ? {} : { code: error.code }),
          error.sent,
          true
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
