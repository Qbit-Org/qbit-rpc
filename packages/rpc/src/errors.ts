import type { Capability, QbitChain } from './capabilities'
import { ownValue } from './own'

// Every error class carries a brand, `Symbol.for('qbit-rpc.<ClassName>')`, on
// its prototype. `Symbol.for` keys are shared across realms and across the
// CommonJS and ESM builds, so `X.is(error)` recognizes an error from another
// copy of this package where `instanceof` cannot.
function brand(target: { prototype: object }, name: string): void {
  Object.defineProperty(target.prototype, Symbol.for(`qbit-rpc.${name}`), { value: true })
}

function hasBrand(value: unknown, name: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[Symbol.for(`qbit-rpc.${name}`)] === true
  )
}

/**
 * Base class of every error this package throws for a refused, failed or
 * malformed call. The messages and properties it writes never contain
 * credentials, cookie contents or request parameters; only `RpcError.message`
 * carries the node's own text, which a `check_failed` {@link RpcChainGuardError}
 * quotes when its `cause` is an `RpcError`.
 */
export class QbitRpcError extends Error {
  /** The JSON-RPC method the error is about, when there is one. */
  readonly method?: string

  constructor(message: string, method?: string, options?: { cause?: unknown }) {
    super(message)
    // Always the error's own, with the attributes Error gives one, and
    // undefined when none was given: an absent cause would read a polluted
    // Object.prototype's. Like every details object here, often `{}` or built
    // with spreads, options is read by its own keys only.
    Object.defineProperty(this, 'cause', {
      value: options === undefined ? undefined : ownValue(options, 'cause'),
      writable: true,
      enumerable: false,
      configurable: true,
    })
    this.name = new.target.name
    if (method !== undefined) this.method = method
  }

  /** Whether `value` is a `QbitRpcError` (or subclass) from any copy of this package. */
  static is(value: unknown): value is QbitRpcError {
    return hasBrand(value, 'QbitRpcError')
  }
}
brand(QbitRpcError, 'QbitRpcError')

/** Why a call was refused before any request was sent. */
export type RpcCapabilityRefusal = 'not_enabled' | 'unknown_method' | 'not_batchable'

/**
 * The client refused a method before sending anything: its capability is not
 * enabled, the method is not on the allowlist, or it cannot go in a batch.
 */
export class RpcCapabilityError extends QbitRpcError {
  readonly reason: RpcCapabilityRefusal
  /** The capability the method needs, for `not_enabled`. */
  readonly required?: Capability

  constructor(method: string, reason: RpcCapabilityRefusal, required?: Capability) {
    const detail =
      reason === 'not_enabled'
        ? `needs the '${required}' capability, which this client does not enable`
        : reason === 'unknown_method'
          ? 'is not on the allowlist'
          : 'cannot be sent in a batch (batches carry read methods only)'
    super(`RPC method ${method} refused: it ${detail}`, method)
    this.reason = reason
    if (required !== undefined) this.required = required
  }

  static override is(value: unknown): value is RpcCapabilityError {
    return hasBrand(value, 'RpcCapabilityError')
  }
}
brand(RpcCapabilityError, 'RpcCapabilityError')

/** What a chain check compares: the chain name, the genesis block hash and, on signet, the challenge. */
export type ChainCheck = 'chain' | 'genesis_hash' | 'signet_challenge'

/** What a chain check found, beyond the chain name, for a `mismatch` {@link RpcChainGuardError}. */
export interface ChainMismatch {
  readonly differs: readonly ChainCheck[]
  readonly expectedGenesisHash: string
  /** Absent when the `getblockhash 0` reply failed, and the chain name or challenge differed anyway. */
  readonly actualGenesisHash?: string
  readonly expectedSignetChallenge?: string
  readonly actualSignetChallenge?: string
}

/** A signet challenge for a message: long scripts are cut short. */
function challengeText(challenge: string | undefined): string {
  if (challenge === undefined) return 'none'
  return challenge.length <= 80 ? challenge : `${challenge.slice(0, 80)}... (${challenge.length / 2} bytes)`
}

function mismatchText(expected: QbitChain, actual: string | undefined, mismatch: ChainMismatch | undefined): string {
  const chain = `chain '${actual}', expected '${expected}'`
  if (mismatch === undefined || mismatch.differs.length === 0) return chain
  return mismatch.differs
    .map(check =>
      check === 'chain'
        ? chain
        : check === 'genesis_hash'
          ? `genesis block ${ownValue(mismatch, 'actualGenesisHash') ?? 'unknown'}, expected ${mismatch.expectedGenesisHash}`
          : `signet challenge ${challengeText(ownValue(mismatch, 'actualSignetChallenge'))}, expected ${challengeText(ownValue(mismatch, 'expectedSignetChallenge'))}`
    )
    .join('; ')
}

/** Why {@link RpcChainGuardError} refused a call. */
export type RpcChainGuardReason = 'unconfirmed' | 'mismatch' | 'stale' | 'check_failed'

/** The failure's own message, for quoting in another error's. */
function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * A wallet-write or broadcast call was refused, and nothing of it was sent,
 * because the node's chain has not been confirmed (`reason: 'unconfirmed'`), or
 * {@link QbitRpcClient.confirmChain} found a different chain, genesis block or
 * signet challenge (`reason: 'mismatch'`, see `differs`), or every chain check
 * it ran was overtaken by a connection error, an HTTP 401 or another check,
 * which cast doubt on its answer (`reason: 'stale'`), or the chain re-check it
 * ran first could not finish (`reason: 'check_failed'`). The check's failure is
 * the `cause` of `check_failed`, and `method` is always the refused call's. As
 * nothing was sent, `stale` and `check_failed` are worth trying again;
 * `cause` tells whether soon is any use.
 */
export class RpcChainGuardError extends QbitRpcError {
  readonly reason: RpcChainGuardReason
  /** The chain the client expects (the `expectedChain` option). */
  readonly expectedChain: QbitChain
  /** The chain the node reported, for `mismatch`. */
  readonly actualChain?: string
  /**
   * For `mismatch`, what the node reported differently: its chain name
   * (`chain`), its genesis block hash (`genesis_hash`) or, when signet is
   * expected, its challenge (`signet_challenge`, also when it reported none).
   */
  readonly differs?: readonly ChainCheck[]
  /** The genesis block hash the client expects, for `mismatch`. */
  readonly expectedGenesisHash?: string
  /**
   * The genesis block hash the node reported (`getblockhash 0`), for
   * `mismatch`; absent when that reply failed and the chain name or challenge
   * differed anyway.
   */
  readonly actualGenesisHash?: string
  /** The signet challenge the client expects, for `mismatch` when signet is expected. */
  readonly expectedSignetChallenge?: string
  /** The signet challenge the node reported, for `mismatch`; absent when it reported none (only a signet does). */
  readonly actualSignetChallenge?: string

  constructor(
    method: string,
    reason: RpcChainGuardReason,
    expectedChain: QbitChain,
    details: { readonly actualChain?: string; readonly mismatch?: ChainMismatch; readonly cause?: unknown } = {}
  ) {
    const actualChain = ownValue(details, 'actualChain')
    const mismatch = ownValue(details, 'mismatch')
    const hasCause = Object.hasOwn(details, 'cause')
    super(
      reason === 'unconfirmed'
        ? `RPC method ${method} refused: call confirmChain() first to check the node is on ${expectedChain}`
        : reason === 'mismatch'
          ? `RPC method ${method} refused: the node reports ${mismatchText(expectedChain, actualChain, mismatch)}`
          : reason === 'stale'
            ? `RPC method ${method} refused: its chain checks kept being overtaken by connection errors, HTTP 401s or other checks; try again`
            : `RPC method ${method} refused: its chain re-check failed${hasCause ? ` (${causeText(details.cause)})` : ''}`,
      method,
      hasCause ? { cause: details.cause } : undefined
    )
    this.reason = reason
    this.expectedChain = expectedChain
    if (actualChain !== undefined) this.actualChain = actualChain
    if (mismatch !== undefined) {
      this.differs = Object.freeze([...mismatch.differs])
      this.expectedGenesisHash = mismatch.expectedGenesisHash
      const actualGenesisHash = ownValue(mismatch, 'actualGenesisHash')
      const expectedSignetChallenge = ownValue(mismatch, 'expectedSignetChallenge')
      const actualSignetChallenge = ownValue(mismatch, 'actualSignetChallenge')
      if (actualGenesisHash !== undefined) this.actualGenesisHash = actualGenesisHash
      if (expectedSignetChallenge !== undefined) this.expectedSignetChallenge = expectedSignetChallenge
      if (actualSignetChallenge !== undefined) this.actualSignetChallenge = actualSignetChallenge
    }
  }

  static override is(value: unknown): value is RpcChainGuardError {
    return hasBrand(value, 'RpcChainGuardError')
  }
}
brand(RpcChainGuardError, 'RpcChainGuardError')

/**
 * The node answered this call with a JSON-RPC error object. `rpcCode` is the
 * node's error code (for example -5 invalid address or key, -8 invalid
 * parameter, -25 missing inputs, -26 rejected, -27 already in the chain, -28
 * warming up) and `message` the node's message, capped at 1,000 characters.
 */
export class RpcError extends QbitRpcError {
  /** The node's JSON-RPC error code. A `code` property, on any error here, is a string instead. */
  readonly rpcCode: number

  constructor(method: string, rpcCode: number, message: string) {
    super(message, method)
    this.rpcCode = rpcCode
  }

  static override is(value: unknown): value is RpcError {
    return hasBrand(value, 'RpcError')
  }
}
brand(RpcError, 'RpcError')

/**
 * The request could not be completed: the connection failed (`network`), the
 * node or a proxy answered with an HTTP status that carries no JSON-RPC reply
 * (`http_status`, see `status`), or the cookie file could not be read
 * (`credentials`).
 */
export class RpcTransportError extends QbitRpcError {
  readonly reason: 'network' | 'http_status' | 'credentials'
  /** The HTTP status, for `http_status`. */
  readonly status?: number
  /**
   * A system error code such as `ECONNREFUSED` or `ENOENT`, when there is one.
   * For `credentials` it can also be this package's `EMALFORMED` (the file is
   * not `user:password`), `ETOOBIG` (over 1 KiB) or `EREAD` (the read failed
   * with no code of its own). It is never a node's code: see `RpcError.rpcCode`.
   */
  readonly code?: string

  constructor(
    method: string,
    reason: 'network' | 'http_status' | 'credentials',
    details: { status?: number; code?: string } = {}
  ) {
    const status = ownValue(details, 'status')
    const code = ownValue(details, 'code')
    const message =
      reason === 'http_status'
        ? `RPC ${method} failed: HTTP ${status}${status === 401 ? ' (credentials rejected)' : ''}`
        : reason === 'credentials'
          ? `RPC ${method} failed: the cookie file could not be read${code ? ` (${code})` : ''}`
          : `RPC ${method} failed: connection error${code ? ` (${code})` : ''}`
    super(message, method)
    this.reason = reason
    if (status !== undefined) this.status = status
    if (code !== undefined) this.code = code
  }

  static override is(value: unknown): value is RpcTransportError {
    return hasBrand(value, 'RpcTransportError')
  }
}
brand(RpcTransportError, 'RpcTransportError')

/** The operation's deadline (`timeoutMs`) expired. It covers every attempt, backoff and the cookie read. */
export class RpcTimeoutError extends QbitRpcError {
  readonly timeoutMs: number

  constructor(method: string, timeoutMs: number) {
    super(`RPC ${method} timed out after ${timeoutMs} ms`, method)
    this.timeoutMs = timeoutMs
  }

  static override is(value: unknown): value is RpcTimeoutError {
    return hasBrand(value, 'RpcTimeoutError')
  }
}
brand(RpcTimeoutError, 'RpcTimeoutError')

/** The caller's `AbortSignal` fired. The signal's reason is the `cause`. */
export class RpcAbortedError extends QbitRpcError {
  constructor(method: string, reason: unknown) {
    super(`RPC ${method} was aborted`, method, { cause: reason })
  }

  static override is(value: unknown): value is RpcAbortedError {
    return hasBrand(value, 'RpcAbortedError')
  }
}
brand(RpcAbortedError, 'RpcAbortedError')

/** The response body passed `maxResponseBytes`, so the client stopped reading it. */
export class RpcResponseTooLargeError extends QbitRpcError {
  readonly limitBytes: number

  constructor(method: string, limitBytes: number) {
    super(`RPC ${method} response exceeded ${limitBytes} bytes`, method)
    this.limitBytes = limitBytes
  }

  static override is(value: unknown): value is RpcResponseTooLargeError {
    return hasBrand(value, 'RpcResponseTooLargeError')
  }
}
brand(RpcResponseTooLargeError, 'RpcResponseTooLargeError')

/**
 * The response was not a well-formed JSON-RPC reply (`protocol`), or its result
 * failed validation (`validation`). `path` locates the offending value, for
 * example `result.vout[0].value`. When the request's own `parse` threw something
 * other than this package's validation failure, `path` is `result` and `cause`
 * is what it threw.
 */
export class RpcResponseError extends QbitRpcError {
  readonly reason: 'protocol' | 'validation'
  readonly path: string

  constructor(
    method: string,
    reason: 'protocol' | 'validation',
    path: string,
    expected: string,
    options?: { readonly cause?: unknown }
  ) {
    super(`RPC ${method} returned an invalid response at ${path}: expected ${expected}`, method, options)
    this.reason = reason
    this.path = path
  }

  static override is(value: unknown): value is RpcResponseError {
    return hasBrand(value, 'RpcResponseError')
  }
}
brand(RpcResponseError, 'RpcResponseError')

/**
 * A wallet-write or broadcast request may have been executed, but no valid
 * reply arrived: the deadline expired, the caller aborted, the connection
 * dropped, the reply was too large or malformed, or a proxy answered with a
 * 5xx status, or a JSON-RPC error under a status qbitd does not use for one,
 * after the request was sent. The client never retries such a call.
 * Reconcile before trying again: for `sendrawtransaction`, look the `txid` up
 * (`getrawtransaction`, `gettransaction`, `getmempoolentry`); resubmitting the
 * same hex is harmless, but never rebuild the payment with different inputs.
 * The underlying error is the `cause`.
 */
export class RpcUnknownOutcomeError extends QbitRpcError {
  /** For `sendrawtransaction`, the txid computed from the submitted hex, when it parses. */
  readonly txid?: string

  constructor(method: string, cause: QbitRpcError, txid?: string) {
    super(`RPC ${method} outcome is unknown: the node may have executed it (${cause.message})`, method, { cause })
    if (txid !== undefined) this.txid = txid
  }

  static override is(value: unknown): value is RpcUnknownOutcomeError {
    return hasBrand(value, 'RpcUnknownOutcomeError')
  }
}
brand(RpcUnknownOutcomeError, 'RpcUnknownOutcomeError')
