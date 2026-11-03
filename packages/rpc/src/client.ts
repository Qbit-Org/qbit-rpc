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
  requests,
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
  type ListUnspentOptions,
  type MempoolAcceptance,
  type NetworkInfo,
  type ProcessedPsbt,
  type RpcRequest,
  type SecurityLevel,
  type SighashType,
  type SmartFeeEstimate,
  type UnspentOutput,
  type WalletCreateFundedPsbtArgs,
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

/** Whether `confirmChain()` has matched the node's chain to `expectedChain`. */
export type ChainStatus = 'unconfirmed' | 'confirmed' | 'mismatch'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const DEFAULT_RETRY_DELAY_MS = 250
const MAX_RETRY_DELAY_MS = 10_000
const MAX_BATCH = 1000
const RPC_IN_WARMUP = -28
const MAX_NODE_MESSAGE = 1000

const TIMEOUT = Symbol('timeout')

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
  readonly #transport = new HttpTransport()
  #chain: { status: ChainStatus; actual?: string } = { status: 'unconfirmed' }
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
  }

  /** Whether the node's chain has been confirmed with {@link confirmChain}. */
  get chainStatus(): ChainStatus {
    return this.#chain.status
  }

  /**
   * Call `getblockchaininfo` and compare its `chain` with `expectedChain`. On a
   * match, wallet-write and broadcast calls are allowed from then on. On a
   * mismatch they stay refused and this throws `RpcChainGuardError`.
   */
  async confirmChain(options: CallOptions = {}): Promise<BlockchainInfo> {
    const info = await this.#single(requests.getBlockchainInfo(), options)
    if (info.chain !== this.#expectedChain) {
      this.#chain = { status: 'mismatch', actual: info.chain }
      throw new RpcChainGuardError('getblockchaininfo', 'mismatch', this.#expectedChain, info.chain)
    }
    this.#chain = { status: 'confirmed' }
    return info
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
  getBlockHash(height: number, options?: CallOptions): Promise<string> {
    return this.#lazy(() => requests.getBlockHash(height), options)
  }
  getBlockHeader(blockHash: string, options?: CallOptions): Promise<BlockHeader> {
    return this.#lazy(() => requests.getBlockHeader(blockHash), options)
  }
  getRawTransaction(txid: string, options?: { readonly blockHash?: string } & CallOptions): Promise<string> {
    return this.#lazy(() => requests.getRawTransaction(txid, options), options)
  }
  getRawTransactionVerbose(
    txid: string,
    options?: { readonly blockHash?: string } & CallOptions
  ): Promise<DecodedTransaction> {
    return this.#lazy(() => requests.getRawTransactionVerbose(txid, options), options)
  }
  getConfirmationTarget(
    valueBits: bigint,
    options?: {
      readonly securityLevel?: SecurityLevel
      readonly mergeMiningPct?: number
      readonly btcHashrate?: number
    } & CallOptions
  ): Promise<ConfirmationTarget> {
    return this.#lazy(() => requests.getConfirmationTarget(valueBits, options), options)
  }
  estimateSmartFee(
    confTarget: number,
    options?: { readonly mode?: FeeEstimateMode } & CallOptions
  ): Promise<SmartFeeEstimate> {
    return this.#lazy(() => requests.estimateSmartFee(confTarget, options), options)
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
    return this.#lazy(() => requests.testMempoolAccept(rawTxs, options), options)
  }
  sendRawTransaction(
    hex: string,
    options?: { readonly maxFeeRateBitsPerKvB?: bigint; readonly maxBurnAmountBits?: bigint } & CallOptions
  ): Promise<string> {
    return this.#lazy(() => requests.sendRawTransaction(hex, options), options)
  }
  getWalletInfo(options?: CallOptions): Promise<WalletInfo> {
    return this.#single(requests.getWalletInfo(), options)
  }
  getTransaction(txid: string, options?: CallOptions): Promise<WalletTransaction> {
    return this.#lazy(() => requests.getTransaction(txid), options)
  }
  listUnspent(options?: ListUnspentOptions & CallOptions): Promise<UnspentOutput[]> {
    return this.#lazy(() => requests.listUnspent(options), options)
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
    return this.#lazy(() => requests.walletProcessPsbt(psbt, options), options)
  }
  finalizePsbt(psbt: string, options?: { readonly extract?: boolean } & CallOptions): Promise<FinalizedPsbt> {
    return this.#lazy(() => requests.finalizePsbt(psbt, options), options)
  }
  walletPassphrase(passphrase: string, timeoutSeconds: number, options?: CallOptions): Promise<void> {
    return this.#lazy(() => requests.walletPassphrase(passphrase, timeoutSeconds), options).then(() => undefined)
  }
  walletLock(options?: CallOptions): Promise<void> {
    return this.#single(requests.walletLock(), options).then(() => undefined)
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
      chainStatus: this.#chain.status,
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

  #authorize(method: string, inBatch: boolean): MethodPolicy {
    const policy = methodPolicy(method)
    if (policy === undefined) throw new RpcCapabilityError(method, 'unknown_method')
    if (inBatch && policy.capability !== 'read' && policy.capability !== 'wallet-read') {
      throw new RpcCapabilityError(method, 'not_batchable')
    }
    if (policy.capability !== 'read' && !this.#capabilities.has(policy.capability)) {
      throw new RpcCapabilityError(method, 'not_enabled', policy.capability)
    }
    if (policy.capability === 'wallet-write' || policy.capability === 'broadcast') {
      if (this.#chain.status !== 'confirmed') {
        throw new RpcChainGuardError(
          method,
          this.#chain.status === 'mismatch' ? 'mismatch' : 'unconfirmed',
          this.#expectedChain,
          this.#chain.actual
        )
      }
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
        const text = await this.#exchange(method, body, attempt.signal, policy.sideEffects, id)
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
        text = await this.#exchange(label, body, attempt.signal, false, undefined)
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
          return await attempt({ signal: controller.signal, timeoutMs, maxResponseBytes: this.#maxResponseBytes })
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
   * for a batch.
   */
  async #exchange(
    method: string,
    body: string,
    signal: AbortSignal,
    sideEffects: boolean,
    id: number | undefined
  ): Promise<string> {
    let authorization: string
    try {
      authorization = await abortable(this.#credentials.header(signal), signal)
    } catch (error) {
      if (signal.aborted) throw new ExchangeFailure('aborted', false)
      if (error instanceof CookieReadFailure) {
        throw new Failure(new RpcTransportError(method, 'credentials', { code: error.code }), false, true)
      }
      throw error
    }
    const reply = await this.#transport.send({
      url: this.#endpoint.url,
      authorization,
      body,
      signal,
      maxResponseBytes: this.#maxResponseBytes,
      freshConnection: sideEffects,
    })
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

interface AttemptContext {
  /** Fires at the operation's deadline (reason TIMEOUT) or when the caller aborts (the caller's reason). */
  readonly signal: AbortSignal
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
