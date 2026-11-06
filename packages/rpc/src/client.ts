import { createHash } from 'node:crypto'
import { inspect } from 'node:util'

import {
  CAPABILITIES,
  extraMethodPolicies,
  guarded,
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
  LONG_POLL_MARGIN_MS,
  isLongPoll,
  MAX_NODE_MESSAGE,
  checkIgnoredOptions,
  longPollParams,
  longPollRetryable,
  messageSecrets,
  redact,
  refusedBeforeActing,
  requests,
  type AddressInfo,
  type AddressType,
  type AddressValidation,
  type AuxBlock,
  type Block,
  type BlockchainInfo,
  type BlockHeader,
  type BlockRef,
  type BlockSubmissionResult,
  type BlockTemplate,
  type BlockWithTransactions,
  type BumpedPsbt,
  type ChainTip,
  type ConfirmationTarget,
  type DataPqcHashProof,
  type DataPqcHashSignature,
  type DataPqcHashVerification,
  type DecodedTransaction,
  type DescriptorImport,
  type DescriptorImportResult,
  type DescriptorInfo,
  type DescriptorRange,
  type FeeEstimateMode,
  type FinalizedPsbt,
  type FundedPsbt,
  type ListSinceBlockOptions,
  type ListTransactionsOptions,
  type ListUnspentOptions,
  type LoadedWallet,
  type MempoolAcceptance,
  type MempoolEntry,
  type MempoolInfo,
  type MempoolSnapshot,
  type MiningInfo,
  type NetworkInfo,
  type Outpoint,
  type PackageSubmission,
  type ProcessedPsbt,
  type PsbtBumpFeeOptions,
  type RescanResult,
  type RpcRequest,
  type SecurityLevel,
  type SighashType,
  type SinceBlockHistory,
  type SmartFeeEstimate,
  type TxOut,
  type TxSpendingPrevout,
  type UnloadedWallet,
  type UnspentOutput,
  type WalletBalances,
  type WalletCreateFundedPsbtArgs,
  type WalletDirEntry,
  type WalletHistoryEntry,
  type WalletInfo,
  type WalletTransaction,
} from './methods'
import { argArray, argOptions, CALL_OPTION_KEYS, keysOf, ownElements, ownValue, plainOptions } from './own'
import { ExchangeFailure, HttpTransport, prototypePollution } from './transport'
import { inputAddresses, planPqcSigning, psbtInputAddresses, type PqcSigningPlan } from './pqc-signing'
import { compact, ResultIssue } from './validate'
import { nodeVersionRequest, type NodeVersion } from './version'

/** How the client treats a method opened with `extraMethods`, as it treats an allowlisted one with the same policy. */
export interface ExtraMethodPolicy {
  /** What the client must enable: `read` for a chain read, or a capability. */
  readonly capability: 'read' | Capability
  /** Whether a call can change node or wallet state; it has no default. */
  readonly sideEffects: boolean
}

/** The options of a {@link QbitRpcClient}, checked at construction: a bad one is a `TypeError` or a `RangeError`. */
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
  /** The node's credentials: a user name and password, or qbitd's cookie file. See {@link RpcAuth}. */
  readonly auth: RpcAuth
  /**
   * TLS settings for an `https` url: a private CA, a client certificate, the
   * name to check, and key pins. Default: the system's CAs, no client
   * certificate, the URL's host, no pin. See
   * [Remote nodes](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/remote-nodes.md).
   */
  readonly tls?: RpcTlsOptions
  /**
   * Opens the stream for each connection to an `https` url, such as a tunnel
   * through a proxy; the client runs TLS over it, with every check. Not with
   * cookie authentication. Default: connect to the URL's host directly.
   */
  readonly connect?: RpcConnect
  /** The chain this client must talk to. `confirmChain()` checks it; wallet-write, broadcast, mining and wallet-admin calls wait for that check. */
  readonly expectedChain: QbitChain
  /**
   * The genesis block hash the node must report (`getblockhash 0`) on every
   * chain check: 64 hex characters, in either case (compared in lowercase).
   * Default: `expectedChain`'s genesis block in qbit Core v1.0.0, which the
   * [Chain guard](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/chain-guard.md)
   * lists. Set it for a node built with other chain parameters.
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
   * Methods to allow beyond the package's allowlist, for this client, untyped,
   * through `call()` and `requests.raw()`. Each entry is the method's policy:
   * `capability`, `read` or one in `capabilities`, and `sideEffects`, which
   * has no default; one with side effects needs `wallet-write`, `broadcast`,
   * `mining`, `wallet-admin` or `node-admin`. The client treats the method as
   * an allowlisted one with that policy: `wallet-write`, `broadcast`, `mining`,
   * `wallet-admin` and `node-admin` wait for the chain guard, and a method with
   * side effects is never retried or batched, uses a fresh connection, and is
   * an `RpcUnknownOutcomeError` when it may have run. A `node-admin` call needs
   * the chain's identity only: an unsupported qbit Core version does not
   * refuse it, and it is never batched; node administration (`stop`, `setban`,
   * `addnode`, ...) is reachable only this way, under `node-admin`. A method qbit Core
   * v1.0.0's `help` lists may not be declared below what it does: a wallet
   * method needs a wallet capability, and one that changes state needs
   * `sideEffects: true` under its kind's capability. A method `help` does not
   * list keeps the policy given. An allowlisted method may be restated with
   * its own policy, which then applies. Anything else is a `TypeError`: a
   * policy below the method's, another policy for an allowlisted method, a
   * capability the client does not enable, an option or entry that is not a
   * plain object or is malformed, and `sendmany`, `sendtoaddress`, `send`,
   * `sendall` and `bumpfee`, which sign and broadcast in one step. `toJSON()`
   * lists them. Default none.
   */
  readonly extraMethods?: Readonly<Record<string, ExtraMethodPolicy>>
  /**
   * Deadline for one operation (a call or a batch, with every retry, any wait
   * for a request slot and the cookie read). Default 30,000 ms. For
   * `walletpassphrase` and `walletlock` it is at least 120,000 ms (see
   * {@link QbitRpcClient.walletPassphrase}), and so for `keypoolrefill`,
   * `importdescriptors`, `rescanblockchain`, `loadwallet` and `unloadwallet`
   * (see [Wallet administration](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/wallet-admin.md)):
   * a shorter client `timeoutMs` does
   * not shorten it, nor a long poll's, at least its wait plus 10 s (see
   * {@link QbitRpcClient.waitForNewBlock}). A call's own `timeoutMs` overrides
   * all of these. With `connect`, it also bounds a pooled connection still
   * opening after its read gave up.
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
   * How long a chain confirmation stays fresh. A wallet-write, broadcast, mining or wallet-admin call
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
   * `-rpcworkqueue` (see
   * [the work queue](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/errors.md#the-work-queue)).
   * Default 8.
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
  /**
   * Let wallet-write, broadcast, mining and wallet-admin calls go to a node of a qbit Core version
   * this package does not support. Every chain check also reads the node's
   * version (`getnetworkinfo`); by default one outside qbit Core 1.0.x
   * releases refuses them, as another chain does, with `RpcChainGuardError`
   * (`reason: 'unsupported_version'`) until `confirmChain()` finds a supported
   * one. Set it to accept the risk: such a node may read an argument
   * differently, or answer in a shape this package does not validate.
   * `nodeVersion` still shows the version, and a version that does not parse
   * still fails the check. Default false.
   */
  readonly allowUnsupportedNodeVersion?: boolean
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
  /** Overrides the client's `timeoutMs`, and a method's own default (`walletPassphrase`'s, `keypoolRefill`'s, ...), for this operation. */
  readonly timeoutMs?: number
}

/**
 * One batch entry's outcome. Transport, timeout and size failures reject the
 * whole batch instead. An entry whose `parse` throws, whatever it throws, has
 * an `RpcResponseError` here.
 */
export type BatchItem<T> =
  | {
      /** The entry succeeded. */
      readonly ok: true
      /** Its result, validated and converted. */
      readonly value: T
    }
  | {
      /** The entry failed. */
      readonly ok: false
      /** The node's error for this entry, or why its result did not validate. */
      readonly error: RpcError | RpcResponseError
    }

/** What `batch()` resolves with: one {@link BatchItem} per request, in the order the requests were passed. */
export type BatchResults<T extends readonly RpcRequest<unknown>[]> = {
  -readonly [K in keyof T]: BatchItem<T[K] extends RpcRequest<infer R> ? R : never>
}

/**
 * The chain guard's state:
 *
 * - `unconfirmed`: `confirmChain()` has not succeeded yet. Wallet-write, broadcast,
 *   mining and wallet-admin calls are refused.
 * - `confirmed`: the node reported `expectedChain`, its genesis block and, on
 *   signet, its challenge, within `chainCheckMaxAgeMs`.
 * - `stale`: it did, but longer ago, or a connection error, an HTTP 401 or a
 *   cookie change happened since. The next wallet-write, broadcast, mining or wallet-admin call
 *   checks the chain again before it is sent.
 * - `mismatch`: the node reported another chain, genesis block or signet
 *   challenge. Wallet-write, broadcast, mining and wallet-admin calls are refused until
 *   `confirmChain()` matches again.
 * - `unsupported_version`: the node reported the expected chain, but a qbit
 *   Core version this package does not support (see `nodeVersion`), and
 *   `allowUnsupportedNodeVersion` is not set. Wallet-write, broadcast, mining and wallet-admin calls
 *   are refused until `confirmChain()` finds a supported version.
 */
export type ChainStatus = 'unconfirmed' | 'confirmed' | 'stale' | 'mismatch' | 'unsupported_version'

/**
 * `true` when `QbitRpcClient` fits `Copy`, an interface a consumer declares
 * for the client, strictly enough that every call `Copy` allows is one the
 * client takes. Otherwise an object with each member of `Copy` that does not
 * fit, and why:
 *
 * - `missing`: the client has no such member. A member optional in `Copy`
 *   (`confirmChain?()`) may be missing; check `Required<Copy>` to require it.
 * - `returns`: what the client's method returns is not assignable to what
 *   `Copy`'s returns.
 * - `parameters`: `Copy` allows arguments the client does not take. They are
 *   compared both ways: the arguments `Copy` allows must be assignable to the
 *   client's parameters, compared strictly rather than bivariantly, as
 *   TypeScript compares methods; and they may hold no key, at any depth, that
 *   the client's parameter there does not declare ({@link UndeclaredKeys}). So
 *   call options (`signal`, `timeoutMs`) declared in a method's own options
 *   do not fit: the client takes them in a separate, last argument, and
 *   refuses them in the options with a `TypeError`.
 * - `type`: a member that is not a method has a type the client's is not
 *   assignable to, or one of the two is a method and the other is not.
 *
 * Check it in the consumer's type tests, which its CI compiles:
 *
 * ```ts
 * import type { ClientSatisfies } from '@qbit-oss/rpc'
 *
 * true satisfies ClientSatisfies<CoreRpc>
 * ```
 */
export type ClientSatisfies<Copy extends object> = {
  -readonly [K in keyof Copy]-?: K extends keyof QbitRpcClient
    ? Exclude<Copy[K], undefined> extends (...args: infer Args) => infer Result
      ? QbitRpcClient[K] extends (...args: infer Params) => infer ClientResult
        ? | ([ClientResult] extends [Result] ? never : 'returns')
          | ([Args] extends [Params]
              ? [UndeclaredKeys<Args, Params>] extends [never]
                ? never
                : 'parameters'
              : 'parameters')
        : 'type'
      : [QbitRpcClient[K]] extends [Exclude<Copy[K], undefined>]
        ? never
        : 'type'
    : {} extends Pick<Copy, K>
      ? never
      : 'missing'
} extends infer Reasons
  ? { [K in keyof Reasons as [Reasons[K]] extends [never] ? never : K]: Reasons[K] } extends infer Mismatches
    ? {} extends Mismatches
      ? true
      : Mismatches
    : never
  : never

/**
 * The keys an argument of type `Arg` can hold, at any depth, that the
 * parameter `Param` it is passed to does not declare; `never` when there is
 * none. TypeScript lets such a key through, since an object with more
 * properties is assignable to one with fewer, but the client refuses it with a
 * `TypeError`. Argument lists (tuples) are compared position by position, and
 * a key of any member of a union `Param` is declared. For {@link ClientSatisfies}.
 */
export type UndeclaredKeys<Arg, Param> = unknown extends Param
  ? never
  : [Param] extends [never]
    ? never
    : 0 extends 1 & Arg
      ? never
      : Arg extends (...args: never) => unknown
        ? never
        : Arg extends readonly unknown[]
          ? {
              [I in keyof Arg]-?: UndeclaredKeys<
                Arg[I],
                Param extends unknown ? (I extends keyof Param ? Param[I] : never) : never
              >
            }[number]
          : Arg extends object
            ? | Exclude<keyof Arg, Param extends unknown ? keyof Param : never>
              | {
                  [K in keyof Arg]-?: UndeclaredKeys<
                    Arg[K],
                    Param extends unknown ? (K extends keyof Param ? Param[K] : never) : never
                  >
                }[keyof Arg]
            : never

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
   * Recorded and lifted as a mismatch is; `doubt` as there. `matched`: that
   * check also read the expected chain and genesis block, with no doubt
   * meanwhile, which a `node-admin` call, refused by no version, takes as a
   * confirmation made then, with that cookie, until the next doubt.
   */
  | {
      readonly status: 'unsupported_version'
      readonly version: NodeVersion
      readonly doubt: number
      readonly matched?: { readonly at: number; readonly digest: string; readonly suspicions: number }
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

/** Of a long poll's reply margin, what a first attempt's setup may use before its wait is shortened. */
const LONG_POLL_SLACK_MS = 1000
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
  extraMethods: true,
  timeoutMs: true,
  maxResponseBytes: true,
  readRetries: true,
  retryDelayMs: true,
  chainCheckMaxAgeMs: true,
  maxConcurrentRequests: true,
  directNode: true,
  allowUnsupportedNodeVersion: true,
})
/** The options `walletProcessPsbt` takes: the builder's, and `pqcCheck`. */
const PROCESS_PSBT_OPTIONS = ['sign', 'sighashType', 'bip32derivs', 'finalize', 'pqcCheck'] as const
/** What `batch()` reads of an entry: `waitMs` only to refuse a long poll. */
const BATCH_ENTRY = ['method', 'params', 'parse', 'waitMs'] as const

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
 * before anything is sent, wallet-write, broadcast, mining and wallet-admin calls also need a
 * confirmed chain, and every typed result is validated before it is returned.
 * Amounts are `bigint` bits. See [Errors](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/errors.md)
 * for the failure model.
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
  readonly #extraMethods: ReadonlyMap<string, MethodPolicy>
  /** Undefined when the option is unset: each method's own default applies. */
  readonly #timeoutMs: number | undefined
  readonly #maxResponseBytes: number
  readonly #readRetries: number
  readonly #retryDelayMs: number
  readonly #chainCheckMaxAgeMs: number
  readonly #directNode: boolean
  readonly #allowUnsupportedNodeVersion: boolean
  readonly #limiter: Limiter
  readonly #transport: HttpTransport
  /** What `tls` sets, for `toJSON()`; undefined when it is not given. */
  readonly #tlsSummary: Readonly<Record<string, unknown>> | undefined
  readonly #customConnect: boolean
  #chain: ChainState = { status: 'unconfirmed' }
  /**
   * Counts signs that the node may have changed (a connection error, an HTTP
   * 401), chain mismatches and unsupported versions. A chain check that saw it
   * change while in flight cannot record a confirmation.
   */
  #doubts = 0
  /**
   * Counts the signs alone that the node behind the URL may be another one: a
   * connection error, an HTTP 401. A node-admin call's match stands only
   * while none has come since the check that read it began.
   */
  #suspicions = 0
  /** Chain checks in the order they were sent, so one answered late cannot roll `#nodeVersion` back. */
  #chainChecks = 0
  #nodeVersion: NodeVersion | undefined
  #nodeVersionCheck = 0
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
    this.#extraMethods = extraMethodPolicies(own.extraMethods, this.#capabilities)
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
    if (own.allowUnsupportedNodeVersion !== undefined && typeof own.allowUnsupportedNodeVersion !== 'boolean') {
      throw new TypeError('allowUnsupportedNodeVersion must be a boolean')
    }
    this.#allowUnsupportedNodeVersion = own.allowUnsupportedNodeVersion ?? false
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
   * The qbit Core version the node reported (`getnetworkinfo`'s `version` and
   * `subversion`) to the newest chain check sent that read one; undefined
   * before then. `supported` says whether this package supports it: qbit Core
   * 1.0.x releases. See `allowUnsupportedNodeVersion`.
   */
  get nodeVersion(): NodeVersion | undefined {
    return this.#nodeVersion
  }

  /**
   * Send `getblockchaininfo`, `getblockhash 0` and `getnetworkinfo` in one
   * JSON-RPC batch, and compare the node's `chain` with `expectedChain`, its
   * genesis block hash with `expectedGenesisHash` and, on signet, its
   * `signet_challenge` with `expectedSignetChallenge` (a missing one differs),
   * and read its version into `nodeVersion`. On a match of all three, on a
   * supported version (or with `allowUnsupportedNodeVersion`), wallet-write, broadcast,
   * mining and wallet-admin calls are allowed; once the confirmation goes stale they re-run
   * this check before they are sent. On a mismatch, or an unsupported version,
   * they stay refused and this throws `RpcChainGuardError` (`mismatch` or
   * `unsupported_version`), as it does when any check finds one while this
   * call runs (its cookie read, checks, waits and retries included), unless a
   * `confirmChain()` begun after that mismatch cleared it first. It returns its
   * own last check's `getblockchaininfo` answer, which another check may have
   * overtaken: call `getBlockchainInfo()` for current block data. An
   * unsupported version is reported even when the node's `getblockchaininfo`
   * reply does not validate, as it may well be why. An answer that a
   * connection error or an HTTP 401 elsewhere may postdate is checked again,
   * after `retryDelayMs`, up to three checks per attempt; then this throws
   * `reason: 'stale'` (retried like a read under `readRetries`) and changes
   * nothing. This is a read and the check itself, so any other failure of it
   * is thrown as it is (`RpcTimeoutError`, `RpcTransportError` and so on, about
   * `getblockchaininfo`, `getblockhash` or `getnetworkinfo`, a version that does
   * not parse included), never `reason: 'check_failed'`.
   */
  async confirmChain(callOptions?: CallOptions): Promise<BlockchainInfo> {
    const method = 'getblockchaininfo'
    // A mismatch or unsupported version recorded after this point is newer
    // than this call: it stands, and this call throws it.
    const started = this.#doubts
    refusePollution(method)
    return this.#operation(method, this.#callSettings(callOptions), false, async attempt => {
      try {
        const authorization = await this.#authorization(method, attempt.signal)
        let info: BlockchainInfo | undefined
        // A refusal the last check recorded is thrown before any wait; it may have left `info` unset.
        for (let checks = 0; this.#chainNeedsCheck(method, authorization, checks, started) || info === undefined;) {
          if (checks > 0) await this.#pause(method, attempt)
          this.#refuseRecordedSince(method, started)
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
   * Call any allowlisted method, or one in `extraMethods`, with positional
   * parameters. The result is returned unvalidated, with every number as a
   * `JsonNumber`. Pass amounts as strings from `formatQbt(bits)` (qbit Core
   * accepts amount strings) and integers above 2^53 as `bigint`.
   */
  call(method: string, params: readonly unknown[] = [], callOptions?: CallOptions): Promise<unknown> {
    return this.#lazy(() => requests.raw(method, params), callOptions)
  }

  /**
   * Send several read or wallet-read requests, long polls apart, in one JSON-RPC batch, matched
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

  /** See {@link requests.getBlockchainInfo}. */
  getBlockchainInfo(callOptions?: CallOptions): Promise<BlockchainInfo> {
    return this.#single(requests.getBlockchainInfo(), callOptions)
  }
  /** See {@link requests.getNetworkInfo}. */
  getNetworkInfo(callOptions?: CallOptions): Promise<NetworkInfo> {
    return this.#single(requests.getNetworkInfo(), callOptions)
  }
  /** See {@link requests.getBestBlockHash}. */
  getBestBlockHash(callOptions?: CallOptions): Promise<string> {
    return this.#single(requests.getBestBlockHash(), callOptions)
  }
  /** See {@link requests.getBlockCount}. */
  getBlockCount(callOptions?: CallOptions): Promise<number> {
    return this.#single(requests.getBlockCount(), callOptions)
  }
  /** See {@link requests.getBlockHash}. */
  getBlockHash(height: number, callOptions?: CallOptions): Promise<string> {
    return this.#lazy(() => requests.getBlockHash(height), callOptions)
  }
  /** See {@link requests.getBlockHeader}. */
  getBlockHeader(blockHash: string, callOptions?: CallOptions): Promise<BlockHeader> {
    return this.#lazy(() => requests.getBlockHeader(blockHash), callOptions)
  }
  /** See {@link requests.getBlock}. */
  getBlock(blockHash: string, callOptions?: CallOptions): Promise<Block> {
    return this.#lazy(() => requests.getBlock(blockHash), callOptions)
  }
  /** See {@link requests.getBlockWithTransactions}. */
  getBlockWithTransactions(blockHash: string, callOptions?: CallOptions): Promise<BlockWithTransactions> {
    return this.#lazy(() => requests.getBlockWithTransactions(blockHash), callOptions)
  }
  /** See {@link requests.getBlockHex}. */
  getBlockHex(blockHash: string, callOptions?: CallOptions): Promise<string> {
    return this.#lazy(() => requests.getBlockHex(blockHash), callOptions)
  }
  /** See {@link requests.getChainTips}. */
  getChainTips(callOptions?: CallOptions): Promise<ChainTip[]> {
    return this.#single(requests.getChainTips(), callOptions)
  }
  /**
   * Long-poll for a new tip. The deadline is the call's `timeoutMs`, which must
   * be at least `waitMs` plus 10 s, else the longer of that and the client's
   * `timeoutMs`. Without `options.currentTip` it is never retried: a retry
   * would wait from the tip at that time, past a block found meanwhile. With
   * it, a retry under `readRetries` asks for no more than the deadline has
   * left. See {@link requests.waitForNewBlock}.
   */
  waitForNewBlock(
    waitMs: number,
    options?: { readonly currentTip?: string },
    callOptions?: CallOptions
  ): Promise<BlockRef> {
    return this.#lazy(() => requests.waitForNewBlock(waitMs, options), callOptions)
  }
  /**
   * Long-poll for a height, under the deadline {@link QbitRpcClient.waitForNewBlock}
   * has. A retry under `readRetries` asks for no more than the deadline has
   * left. See {@link requests.waitForBlockHeight}.
   */
  waitForBlockHeight(height: number, waitMs: number, callOptions?: CallOptions): Promise<BlockRef> {
    return this.#lazy(() => requests.waitForBlockHeight(height, waitMs), callOptions)
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
  /** See {@link requests.getMempoolInfo}. */
  getMempoolInfo(callOptions?: CallOptions): Promise<MempoolInfo> {
    return this.#single(requests.getMempoolInfo(), callOptions)
  }
  /** See {@link requests.getRawMempool}. */
  getRawMempool(callOptions?: CallOptions): Promise<string[]> {
    return this.#single(requests.getRawMempool(), callOptions)
  }
  /** See {@link requests.getRawMempoolVerbose}. */
  getRawMempoolVerbose(callOptions?: CallOptions): Promise<Record<string, MempoolEntry>> {
    return this.#single(requests.getRawMempoolVerbose(), callOptions)
  }
  /** See {@link requests.getRawMempoolSequence}. */
  getRawMempoolSequence(callOptions?: CallOptions): Promise<MempoolSnapshot> {
    return this.#single(requests.getRawMempoolSequence(), callOptions)
  }
  /** See {@link requests.getTxSpendingPrevout}. */
  getTxSpendingPrevout(outputs: readonly Outpoint[], callOptions?: CallOptions): Promise<TxSpendingPrevout[]> {
    return this.#lazy(() => requests.getTxSpendingPrevout(outputs), callOptions)
  }
  /** See {@link requests.getMempoolEntry}. */
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
  /** See {@link requests.validateAddress}. */
  validateAddress(address: string, callOptions?: CallOptions): Promise<AddressValidation> {
    return this.#lazy(() => requests.validateAddress(address), callOptions)
  }
  /** See {@link requests.verifyDataPqcHash}: it takes a `signDataPqcHash()` result as it is. */
  verifyDataPqcHash(proof: DataPqcHashProof, callOptions?: CallOptions): Promise<DataPqcHashVerification> {
    return this.#lazy(() => requests.verifyDataPqcHash(proof), callOptions)
  }
  /** See {@link requests.getDescriptorInfo}. */
  getDescriptorInfo(descriptor: string, callOptions?: CallOptions): Promise<DescriptorInfo> {
    return this.#lazy(() => requests.getDescriptorInfo(descriptor), callOptions)
  }
  /** See {@link requests.deriveAddresses}. */
  deriveAddresses(
    descriptor: string,
    options?: { readonly range?: DescriptorRange },
    callOptions?: CallOptions
  ): Promise<string[]> {
    return this.#lazy(() => requests.deriveAddresses(descriptor, options), callOptions)
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
  /** See {@link requests.submitPackage}. */
  submitPackage(
    rawTxs: readonly string[],
    options?: { readonly maxFeeRateBitsPerKvB?: bigint; readonly maxBurnAmountBits?: bigint },
    callOptions?: CallOptions
  ): Promise<PackageSubmission> {
    return this.#lazy(() => requests.submitPackage(rawTxs, options), callOptions)
  }
  /** See {@link requests.getMiningInfo}. */
  getMiningInfo(callOptions?: CallOptions): Promise<MiningInfo> {
    return this.#single(requests.getMiningInfo(), callOptions)
  }
  /**
   * See {@link requests.getBlockTemplate}. With `expectedChain: 'signet'`, the
   * rules default to `['segwit', 'signet']`, as qbit Core requires there.
   */
  getBlockTemplate(
    options?: { readonly rules?: readonly string[]; readonly capabilities?: readonly string[] },
    callOptions?: CallOptions
  ): Promise<BlockTemplate> {
    return this.#lazy(() => {
      // qbit Core refuses a signet template without the signet rule (src/rpc/mining.cpp:991-994).
      // Anything but undefined or an object goes to the builder as it is, which refuses it as on any chain.
      const object = typeof options === 'object' && options !== null
      const defaultRules =
        options === undefined ||
        (object && (!Object.hasOwn(options, 'rules') || (options as { readonly rules?: unknown }).rules === undefined))
      return requests.getBlockTemplate(
        this.#expectedChain === 'signet' && defaultRules ? { ...options, rules: ['segwit', 'signet'] } : options
      )
    }, callOptions)
  }
  /** See {@link requests.checkBlockProposal}. */
  checkBlockProposal(blockHex: string, callOptions?: CallOptions): Promise<BlockSubmissionResult> {
    return this.#lazy(() => requests.checkBlockProposal(blockHex), callOptions)
  }
  /** See {@link requests.submitBlock}. */
  submitBlock(blockHex: string, callOptions?: CallOptions): Promise<BlockSubmissionResult> {
    return this.#lazy(() => requests.submitBlock(blockHex), callOptions)
  }
  /** See {@link requests.createAuxBlock}. */
  createAuxBlock(payoutAddress: string, callOptions?: CallOptions): Promise<AuxBlock> {
    return this.#lazy(() => requests.createAuxBlock(payoutAddress), callOptions)
  }
  /** See {@link requests.submitAuxBlock}. */
  submitAuxBlock(blockHash: string, auxpowHex: string, callOptions?: CallOptions): Promise<BlockSubmissionResult> {
    return this.#lazy(() => requests.submitAuxBlock(blockHash, auxpowHex), callOptions)
  }
  /** See {@link requests.getWalletInfo}. */
  getWalletInfo(callOptions?: CallOptions): Promise<WalletInfo> {
    return this.#single(requests.getWalletInfo(), callOptions)
  }
  /** See {@link requests.getTransaction}. */
  getTransaction(txid: string, callOptions?: CallOptions): Promise<WalletTransaction> {
    return this.#lazy(() => requests.getTransaction(txid), callOptions)
  }
  /** See {@link requests.listUnspent}. */
  listUnspent(options?: ListUnspentOptions, callOptions?: CallOptions): Promise<UnspentOutput[]> {
    return this.#lazy(() => requests.listUnspent(options), callOptions)
  }
  /** See {@link requests.getAddressInfo}. */
  getAddressInfo(address: string, callOptions?: CallOptions): Promise<AddressInfo> {
    return this.#lazy(() => requests.getAddressInfo(address), callOptions)
  }
  /** See {@link requests.listLockUnspent}. */
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
  /** See {@link requests.getBalances}. */
  getBalances(callOptions?: CallOptions): Promise<WalletBalances> {
    return this.#single(requests.getBalances(), callOptions)
  }
  /** See {@link requests.walletCreateFundedPsbt}. */
  walletCreateFundedPsbt(args: WalletCreateFundedPsbtArgs, callOptions?: CallOptions): Promise<FundedPsbt> {
    return this.#lazy(() => requests.walletCreateFundedPsbt(args), callOptions)
  }
  /**
   * See {@link requests.walletProcessPsbt}. When it signs (`sign` is not
   * false), it first runs {@link QbitRpcClient.checkPqcSigning} on `psbt` and
   * sends nothing to sign when that refuses: an exhausted PQC key signs nothing
   * and raises no error, and one that runs out partway leaves the inputs after
   * it unsigned. So it needs `wallet-read` too. The check's `decodepsbt`,
   * `getaddressinfo` batch and the signing share one deadline, the call's, and
   * its signal; a failure of the check is thrown as it is, with nothing signed.
   * `pqcCheck: false` skips the check, which is unsafe: only for a caller that
   * counts the budgets itself, or knows the wallet has no PQC key.
   */
  walletProcessPsbt(
    psbt: string,
    options?: {
      readonly sign?: boolean
      readonly sighashType?: SighashType
      readonly bip32derivs?: boolean
      readonly finalize?: boolean
      readonly pqcCheck?: boolean
    },
    callOptions?: CallOptions
  ): Promise<ProcessedPsbt> {
    return this.#processPsbt(psbt, options, callOptions)
  }
  /**
   * Count the PQC signatures signing `psbt` with this wallet would take from
   * each of its keys, before signing: `decodepsbt` gives the address of the
   * output each input spends, and `getaddressinfo`, for each address once in
   * one batch, its keys' states and signatures left. Each input needs one
   * signature from each key its address holds. Rejects with `PqcSigningError`
   * when an input names no address, a PQC state comes without its keys, a key
   * is `exhausted` or in a state this version does not know, or a key has
   * fewer signatures left than it needs. Resolves with each key's count, the
   * worst state, and a warning per `critical` key; an input whose address
   * holds no PQC key of this wallet needs none. Needs `wallet-read`; nothing is
   * signed. `walletProcessPsbt` runs it by default.
   */
  checkPqcSigning(psbt: string, callOptions?: CallOptions): Promise<PqcSigningPlan> {
    return this.#checkPqcSigning(psbt, callOptions)
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
   * deadline, so one sent meanwhile can need a longer `timeoutMs`. See
   * [Unlocking](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/wallet.md#unlocking-an-encrypted-wallet).
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
  /** See {@link requests.signDataPqcHash}: each signature counts against the key's PQC signature budget. */
  signDataPqcHash(
    address: string,
    messageHash: string,
    options?: {
      readonly pubkey?: string
      readonly leafScript?: string
      readonly controlBlock?: string
      readonly includePqcUsage?: boolean
    },
    callOptions?: CallOptions
  ): Promise<DataPqcHashSignature> {
    return this.#lazy(() => requests.signDataPqcHash(address, messageHash, options), callOptions)
  }
  /** See {@link requests.createWallet}. Needs `wallet-admin`, as do the eight methods after it. */
  createWallet(
    walletName: string,
    options?: {
      readonly disablePrivateKeys?: boolean
      readonly blank?: boolean
      readonly passphrase?: string
      readonly avoidReuse?: boolean
      readonly loadOnStartup?: boolean
    },
    callOptions?: CallOptions
  ): Promise<LoadedWallet> {
    return this.#lazy(() => requests.createWallet(walletName, options), callOptions)
  }
  /** See {@link requests.loadWallet}. */
  loadWallet(
    filename: string,
    options?: { readonly loadOnStartup?: boolean },
    callOptions?: CallOptions
  ): Promise<LoadedWallet> {
    return this.#lazy(() => requests.loadWallet(filename, options), callOptions)
  }
  /** See {@link requests.unloadWallet}: its default deadline is 120 s. */
  unloadWallet(
    walletName: string,
    options?: { readonly loadOnStartup?: boolean },
    callOptions?: CallOptions
  ): Promise<UnloadedWallet> {
    return this.#lazy(() => requests.unloadWallet(walletName, options), callOptions)
  }
  /** See {@link requests.listWalletDir}. */
  listWalletDir(callOptions?: CallOptions): Promise<WalletDirEntry[]> {
    return this.#single(requests.listWalletDir(), callOptions)
  }
  /** See {@link requests.importDescriptors}: its default deadline is 120 s. */
  importDescriptors(
    descriptors: readonly DescriptorImport[],
    callOptions?: CallOptions
  ): Promise<DescriptorImportResult[]> {
    return this.#lazy(() => requests.importDescriptors(descriptors), callOptions)
  }
  /** See {@link requests.rescanBlockchain}: its default deadline is 120 s. */
  rescanBlockchain(
    options?: { readonly startHeight?: number; readonly stopHeight?: number },
    callOptions?: CallOptions
  ): Promise<RescanResult> {
    return this.#lazy(() => requests.rescanBlockchain(options), callOptions)
  }
  /** See {@link requests.backupWallet}. */
  backupWallet(destination: string, callOptions?: CallOptions): Promise<void> {
    return this.#lazy(() => requests.backupWallet(destination), callOptions).then(() => undefined)
  }
  /** See {@link requests.walletPassphraseChange}. */
  walletPassphraseChange(oldPassphrase: string, newPassphrase: string, callOptions?: CallOptions): Promise<void> {
    return this.#lazy(() => requests.walletPassphraseChange(oldPassphrase, newPassphrase), callOptions).then(
      () => undefined
    )
  }
  /** See {@link requests.keypoolRefill}: its default deadline is 120 s. */
  keypoolRefill(options?: { readonly newSize?: number }, callOptions?: CallOptions): Promise<void> {
    return this.#lazy(() => requests.keypoolRefill(options), callOptions).then(() => undefined)
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
      ...(this.#extraMethods.size === 0 ? {} : { extraMethods: Object.fromEntries(this.#extraMethods) }),
      auth: this.#credentials.kind,
      ...(this.#tlsSummary === undefined ? {} : { tls: structuredClone(this.#tlsSummary) }),
      ...(this.#customConnect ? { connect: 'custom' } : {}),
      chainStatus: this.chainStatus,
      ...(this.#nodeVersion === undefined ? {} : { nodeVersion: this.#nodeVersion }),
    }
  }

  /** What `util.inspect` and `console.log` show: {@link QbitRpcClient.toJSON}'s description, without credentials. */
  [inspect.custom](): string {
    return `QbitRpcClient ${inspect(this.toJSON())}`
  }

  // -------------------------------------------------------------------------

  /** Build the request inside the promise, so an invalid argument rejects instead of throwing. */
  async #lazy<T>(build: () => RpcRequest<T>, callOptions?: CallOptions): Promise<T> {
    return this.#single(build(), callOptions)
  }

  async #checkPqcSigning(psbt: string, callOptions: CallOptions | undefined): Promise<PqcSigningPlan> {
    const decode = psbtInputAddresses(psbt)
    refusePollution(decode.method)
    return this.#planPqcSigning(decode, sharedDeadline(this.#callSettings(callOptions)))
  }

  /**
   * `walletprocesspsbt`, after the PQC check unless it signs nothing or
   * `pqcCheck` is false. The check's calls and the signing run under one
   * deadline, and the signing is sent only once the check has passed.
   */
  async #processPsbt(psbt: string, options: unknown, callOptions: CallOptions | undefined): Promise<ProcessedPsbt> {
    const own = argOptions(options, 'options', PROCESS_PSBT_OPTIONS, { callOptions: true })
    const pqcCheck = own['pqcCheck']
    if (pqcCheck !== undefined && typeof pqcCheck !== 'boolean')
      throw new TypeError('options.pqcCheck must be a boolean')
    // The rest is the builder's to check, on an object without a prototype, as own is.
    const forwarded = compact<Record<string, unknown>>({
      sign: own['sign'],
      sighashType: own['sighashType'],
      bip32derivs: own['bip32derivs'],
      finalize: own['finalize'],
    })
    const request = requests.walletProcessPsbt(psbt, forwarded as Parameters<typeof requests.walletProcessPsbt>[1])
    // With sign false the wallet fills in what it knows and signs nothing, so no key's budget is spent.
    if (pqcCheck === false || own['sign'] === false) return this.#single(request, callOptions)
    const method = request.method
    refusePollution(method)
    // Refused before the check sends anything: the call's own capability and the guard's first decision, then the check's.
    this.#authorize(method, false)
    if (!this.#capabilities.has('wallet-read')) throw new RpcCapabilityError(method, 'not_enabled', 'wallet-read')
    const settings = sharedDeadline(this.#callSettings(callOptions))
    await this.#planPqcSigning(psbtInputAddresses(psbt), settings)
    return this.#single(request, undefined, settings)
  }

  /** The PQC check: `decode`, then each input address's `getaddressinfo`, in batches, under `settings`. */
  async #planPqcSigning(decode: RpcRequest<(string | undefined)[]>, settings: CallSettings): Promise<PqcSigningPlan> {
    // getaddressinfo's wallet-read, checked before decodepsbt is sent.
    this.#authorize('getaddressinfo', true)
    const spent = inputAddresses(await this.#single(decode, undefined, settings))
    const unique = [...new Set(spent)]
    const infos = new Map<string, AddressInfo>()
    for (let from = 0; from < unique.length; from += MAX_BATCH) {
      const addresses = unique.slice(from, from + MAX_BATCH)
      const replies = await this.#batch(
        addresses.map(address => requests.getAddressInfo(address)),
        undefined,
        settings
      )
      replies.forEach((reply, index) => {
        if (!reply.ok) throw reply.error
        infos.set(addresses[index]!, reply.value as AddressInfo)
      })
    }
    return planPqcSigning(spent, infos)
  }

  #chainExpired(at: number): boolean {
    return performance.now() - at >= this.#chainCheckMaxAgeMs
  }

  /**
   * Record what a chain check sent with `digest` found: `report` from its
   * `getblockchaininfo` and `getblockhash` replies (absent when the first
   * failed), `version` from its `getnetworkinfo` reply (absent when that
   * failed), and whether every reply was valid (`complete`). Returns whether
   * it recorded a refusal, which stands whatever else failed. `since` is
   * `#doubts` when its request was sent: if something cast doubt on the node
   * since then, the answer may predate it, so a match changes nothing. A
   * mismatch answer always stands, and so does an unsupported version: only a
   * `confirmChain()` that began after it was recorded (`clearsBefore`, its
   * starting `#doubts`) can replace it with a match. An unsupported version
   * replaces a mismatch only when such a `confirmChain()` found it with a
   * chain report that is whole (both replies valid) and matches: without one,
   * the node may still be on the other chain, which is reported first: that
   * `confirmChain()` records the mismatch again as it was, so it throws it.
   */
  #recordChain(
    report: ChainReport | undefined,
    version: NodeVersion | undefined,
    complete: boolean,
    since: number,
    suspicion: number,
    digest: string,
    clearsBefore: number | undefined
  ): boolean {
    const chain = this.#chain
    const differs = report === undefined ? [] : this.#chainDifferences(report)
    // The expected chain and genesis block, and a version, read with no sign since the check
    // began that the node is another one: what a node-admin call, refused by no version, goes on.
    const identity =
      report !== undefined &&
      report.genesisHash !== undefined &&
      differs.length === 0 &&
      version !== undefined &&
      this.#suspicions === suspicion
        ? { at: performance.now(), digest, suspicions: suspicion }
        : undefined
    const lifts =
      (chain.status !== 'mismatch' && chain.status !== 'unsupported_version') ||
      (clearsBefore !== undefined && chain.doubt <= clearsBefore)
    if (report !== undefined && differs.length > 0) {
      this.#doubts += 1
      this.#chain = { status: 'mismatch', report, differs, doubt: this.#doubts }
      return true
    }
    if (version !== undefined && !version.supported && !this.#allowUnsupportedNodeVersion) {
      // differs is empty here, so a report with its genesis hash read is a match.
      const matched = report !== undefined && report.genesisHash !== undefined
      if (chain.status !== 'mismatch' || (lifts && matched)) {
        this.#doubts += 1
        this.#chain = {
          status: 'unsupported_version',
          version,
          doubt: this.#doubts,
          ...(identity === undefined ? {} : { matched: identity }),
        }
      } else if (lifts) {
        this.#doubts += 1
        this.#chain = { ...chain, doubt: this.#doubts }
      }
      return true
    }
    // A supported version again, while the unsupported one stays recorded until a confirmChain():
    // the match is fresh for node-admin calls, and nothing else changes.
    if (chain.status === 'unsupported_version' && !lifts && identity !== undefined) {
      this.#chain = { ...chain, matched: identity }
    }
    if (complete && this.#doubts === since && lifts) {
      this.#chain = { status: 'confirmed', at: performance.now(), digest }
    }
    return false
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
    this.#suspicions += 1
    if (this.#chain.status === 'confirmed') this.#chain = { status: 'invalidated' }
  }

  /**
   * The refusal of a guarded call while the chain is unconfirmed or another
   * one, or the version unsupported, which `versionExempt` (a `node-admin`
   * call) leaves out: it goes on to check the chain, and takes a match.
   */
  #chainRefusal(method: string, versionExempt = false): RpcChainGuardError | undefined {
    const chain = this.#chain
    if (chain.status === 'unconfirmed') return new RpcChainGuardError(method, 'unconfirmed', this.#expectedChain)
    if (chain.status === 'mismatch') return this.#mismatchError(method, chain)
    if (chain.status === 'unsupported_version' && !versionExempt) {
      return new RpcChainGuardError(method, 'unsupported_version', this.#expectedChain, { nodeVersion: chain.version })
    }
    return undefined
  }

  /**
   * Whether a call sent with `authorization` must check the chain before it
   * goes on, after `checks` checks in this attempt. A confirmation counts for
   * the cookie it was made with, and, once this attempt has checked, however
   * old it is. Throws the guard's refusal, and `stale` (retryable) once
   * MAX_CHAIN_CHECKS checks have each been doubted. `confirming` is set for
   * `confirmChain()`, to `#doubts` when it began: it always checks, and is
   * refused only by a mismatch or unsupported version found since then.
   * `versionExempt`, for a `node-admin` call, takes an unsupported version
   * whose check matched the chain as it takes a confirmation.
   */
  #chainNeedsCheck(
    method: string,
    authorization: Authorization,
    checks: number,
    confirming?: number,
    versionExempt = false
  ): boolean {
    const chain = this.#chain
    if (confirming === undefined) {
      const refusal = this.#chainRefusal(method, versionExempt)
      if (refusal !== undefined) throw new Failure(refusal, false, false)
    } else {
      this.#refuseRecordedSince(method, confirming)
    }
    const fresh = (at: number): boolean => checks > 0 || (confirming === undefined && !this.#chainExpired(at))
    if (chain.status === 'confirmed' && chain.digest === authorization.digest && fresh(chain.at)) return false
    if (
      versionExempt &&
      chain.status === 'unsupported_version' &&
      chain.matched?.digest === authorization.digest &&
      // None since: after a connection error or an HTTP 401 the node may be another one.
      chain.matched.suspicions === this.#suspicions &&
      fresh(chain.matched.at)
    ) {
      return false
    }
    if (checks >= MAX_CHAIN_CHECKS) {
      throw new Failure(new RpcChainGuardError(method, 'stale', this.#expectedChain), false, true)
    }
    return true
  }

  /** `confirmChain()`'s refusal: a mismatch or unsupported version recorded since it began (`#doubts` was `started`). */
  #refuseRecordedSince(method: string, started: number): void {
    const chain = this.#chain
    if ((chain.status === 'mismatch' || chain.status === 'unsupported_version') && chain.doubt > started) {
      throw new Failure(this.#chainRefusal(method)!, false, false)
    }
  }

  /**
   * What a guarded call rejects with when its chain guard threw `error`. A
   * refusal stands as it is, as does one for a polluted Object.prototype that
   * came after the call began. A failed re-check, or a wait before one that was cut
   * short, becomes `check_failed` about the call itself, with the failure as
   * `cause`, unless a mismatch or an unsupported version was recorded meanwhile,
   * which stands. The failure keeps its classification: a guarded call without
   * side effects retries it under `readRetries`, and a stale socket still gets
   * its extra attempt.
   */
  #guardFailure(method: string, error: unknown, versionExempt = false): Failure {
    if (error instanceof Failure && (RpcChainGuardError.is(error.error) || isPollutionRefusal(error.error)))
      return error
    const refusal = this.#chainRefusal(method, versionExempt)
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
   * `#recordChain`. `getblockchaininfo`, `getblockhash 0` and `getnetworkinfo`
   * go in one batch: one exchange under the attempt's signal, answered by one
   * node. Its failures, an error or a malformed or missing reply for any
   * request included, are definite failures that record nothing: a guarded
   * request has not been sent, and `#guardFailure` reports them as the guarded
   * call's. Whole-exchange failures name `getblockchaininfo`, and a reply's
   * failure its request, the first in batch order. Two exceptions, as a
   * refusal is always safe to record: a chain name or signet challenge that
   * differs is a mismatch whatever the other replies were, and an unsupported
   * version is recorded whatever the `getblockchaininfo` and `getblockhash`
   * replies were. Then this returns the info, when its reply was valid, and
   * the caller's next guard decision throws the refusal. The version, when
   * valid, goes to `nodeVersion` unless a check sent later has set it.
   */
  async #checkChain(
    attempt: AttemptContext,
    authorization: Authorization,
    clearsBefore: number | undefined
  ): Promise<BlockchainInfo | undefined> {
    const check = requests.getBlockchainInfo()
    const genesis = requests.getBlockHash(0)
    const network = nodeVersionRequest()
    const ids = [this.#nextId++, this.#nextId++, this.#nextId++] as const
    const body = stringifyRequest(
      [check, genesis, network].map((request, index) => ({
        jsonrpc: '2.0',
        id: ids[index],
        method: request.method,
        params: request.params,
      }))
    )
    const since = this.#doubts
    const suspicion = this.#suspicions
    const sent = ++this.#chainChecks
    const definite = (error: unknown): Failure => {
      const failure = asFailure(check.method, error, attempt)
      return new Failure(failure.error, false, failure.retryable, failure.staleSocket)
    }
    let info: BlockchainInfo | undefined
    let genesisHash: string | undefined
    let version: NodeVersion | undefined
    /** The first reply that failed, thrown unless the check records a refusal. */
    let failed: { readonly error: unknown } | undefined
    try {
      const text = await this.#exchange(check.method, body, attempt.signal, false, undefined, authorization.header)
      const replies = repliesById(check.method, parseOrProtocolError(check.method, text), ids)
      // Each reply on its own, so what one shows counts when another failed.
      const read = <T>(request: RpcRequest<T>, id: number): T | undefined => {
        try {
          return this.#checkReply(request, replies, id)
        } catch (error) {
          failed ??= { error }
          return undefined
        }
      }
      info = read(check, ids[0])
      genesisHash = read(genesis, ids[1])
      version = read(network, ids[2])
    } catch (error) {
      throw definite(error)
    }
    if (version !== undefined && sent > this.#nodeVersionCheck) {
      this.#nodeVersion = version
      this.#nodeVersionCheck = sent
    }
    const report =
      info === undefined ? undefined : { chain: info.chain, genesisHash, signetChallenge: info.signetChallenge }
    const refused = this.#recordChain(
      report,
      version,
      failed === undefined,
      since,
      suspicion,
      authorization.digest,
      clearsBefore
    )
    if (failed !== undefined && !refused) throw definite(failed.error)
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
    const policy = methodPolicy(method) ?? this.#extraMethods.get(method)
    if (policy === undefined) throw new RpcCapabilityError(method, 'unknown_method')
    // A batch is sent as a read: on a pooled connection, retried, never an
    // unknown outcome, and without the chain guard.
    if (inBatch && (policy.sideEffects || policy.longPoll === true || guarded(policy))) {
      throw new RpcCapabilityError(method, 'not_batchable')
    }
    if (policy.capability !== 'read' && !this.#capabilities.has(policy.capability)) {
      throw new RpcCapabilityError(method, 'not_enabled', policy.capability)
    }
    if (guarded(policy)) {
      // Refuse before reading a cookie; the call decides again just before it is sent.
      const refusal = this.#chainRefusal(method, policy.capability === 'node-admin')
      if (refusal !== undefined) throw refusal
    }
    return policy
  }

  /** `shared`: the settings of an operation this call is part of, with its deadline, in place of `callOptions`. */
  async #single<T>(request: RpcRequest<T>, callOptions?: CallOptions, shared?: CallSettings): Promise<T> {
    const { method } = request
    refusePollution(method)
    const policy = this.#authorize(method, false)
    const id = this.#nextId++
    const { waitMs } = request
    // A long poll's deadline is at least its wait plus the margin, checked before anything is sent.
    const settings = shared ?? this.#callSettings(callOptions, ownValue(policy, 'timeoutMs'), waitMs)
    // Sent at most once: a call with side effects, and a long poll a retry would not repeat.
    const once = policy.sideEffects || (waitMs !== undefined && !longPollRetryable(request))
    // Serialized once: what the node receives is what the checks below read.
    const body = stringifyRequest({ jsonrpc: '2.0', id, method, params: request.params })
    const sent = sentParams(body)
    checkIgnoredOptions(method, sent)
    const secrets = messageSecrets(method, sent)
    const redactor = (message: string): string => redact(message, secrets)
    let attempts = 0
    return this.#operation(method, settings, once, async attempt => {
      const retry = attempts++ > 0
      try {
        // One cookie read per attempt: the chain check and the call are sent
        // with that header, and a new cookie (qbitd restarted) means a check.
        const authorization = await this.#authorization(method, attempt.signal)
        if (guarded(policy)) {
          // node-admin: the chain's identity only, so stop and setban reach a node of an unsupported version.
          const exempt = policy.capability === 'node-admin'
          try {
            // Decide after the last await: a mismatch or doubt recorded meanwhile is honoured.
            for (let checks = 0; this.#chainNeedsCheck(method, authorization, checks, undefined, exempt); checks += 1) {
              if (checks > 0) {
                await this.#pause(method, attempt)
                // Decide again after the wait: a mismatch recorded meanwhile refuses the call.
                if (!this.#chainNeedsCheck(method, authorization, checks, undefined, exempt)) break
              }
              await this.#checkChain(attempt, authorization, undefined)
            }
          } catch (error) {
            throw this.#guardFailure(method, error, exempt)
          }
        }
        let sending = body
        if (waitMs !== undefined) {
          // Each attempt runs under what is left of the deadline: it asks the node
          // to wait no longer than that, less the margin for the reply, and with
          // nothing left it is not sent. A first attempt keeps its wait unless a
          // wait for a request slot, the cookie read or a chain re-check took
          // more than LONG_POLL_SLACK_MS of that margin.
          const margin = LONG_POLL_MARGIN_MS - (retry ? 0 : LONG_POLL_SLACK_MS)
          const left = Math.floor(attempt.deadline - performance.now()) - margin
          if (left < 1) throw new Failure(new RpcTimeoutError(method, attempt.timeoutMs), false, false)
          if (left < waitMs) {
            sending = stringifyRequest({ jsonrpc: '2.0', id, method, params: longPollParams(request, left) })
          }
        }
        const text = await this.#exchange(
          method,
          sending,
          attempt.signal,
          policy.sideEffects,
          id,
          authorization.header,
          redactor
        )
        const reply = this.#envelope(method, parseOrProtocolError(method, text), id, 'response', redactor)
        if (!reply.ok) {
          const unknown = nodeErrorUnknown(method, policy.sideEffects, reply.error)
          throw new Failure(reply.error, unknown, !policy.sideEffects && reply.error.rpcCode === RPC_IN_WARMUP)
        }
        return validated(method, request, reply.result)
      } catch (error) {
        const failure = asFailure(method, error, attempt)
        if (policy.sideEffects && failure.unknown) {
          throw new Failure(
            new RpcUnknownOutcomeError(method, failure.error, request.txid, request.txids, request.blockHash),
            false,
            false
          )
        }
        throw failure
      }
    })
  }

  async #batch(
    entries: readonly RpcRequest<unknown>[],
    callOptions: unknown,
    shared?: CallSettings
  ): Promise<BatchItem<unknown>[]> {
    if (!Array.isArray(entries)) throw new TypeError('batch takes an array of requests')
    refusePollution(`batch(${entries.length})`)
    const settings = shared ?? this.#callSettings(callOptions)
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
    for (const entry of list) {
      this.#authorize(entry.method, true)
      // A long poll opened through extraMethods (waitforblock) waits as well, a hand-built entry included.
      if (entry.waitMs !== undefined || isLongPoll(entry.method)) {
        throw new RpcCapabilityError(entry.method, 'not_batchable')
      }
    }
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
    // Read back from the body, as for a single call: each entry's checks and
    // redaction follow what is sent, a copied or hand-built entry's included.
    const sent = bodies.map(sentParams)
    // An array, or none, as call() takes them: named params would pass the checks and redaction below unread.
    sent.forEach((params, index) => {
      if (params !== undefined && !Array.isArray(params)) {
        throw new TypeError(`batch() entry ${index}: params must be an array`)
      }
    })
    list.forEach((entry, index) => checkIgnoredOptions(entry.method, sent[index]))
    const redactors = list.map((entry, index) => {
      const secrets = messageSecrets(entry.method, sent[index])
      return (message: string): string => redact(message, secrets)
    })
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
        const reply = this.#envelope(entry.method, byId.get(id), id, `response[id=${id}]`, redactors[index])
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
   * deadline is `settings.timeoutMs`, see `#callSettings`. A call sent at most
   * once (`once`: one with side effects, or a long poll a retry would not
   * repeat) is not retried. The deadline timer, the caller's abort listener and
   * any backoff sleep are released on every exit path.
   */
  async #operation<T>(
    label: string,
    settings: CallSettings,
    once: boolean,
    attempt: (context: AttemptContext) => Promise<T>
  ): Promise<T> {
    const retries = once ? 0 : this.#readRetries
    const { timeoutMs, signal: callerSignal } = settings
    if (callerSignal?.aborted) throw new RpcAbortedError(label, callerSignal.reason)
    const shared = settings.deadline
    const deadline = shared ?? performance.now() + timeoutMs
    // A deadline shared with the calls before this one may have passed: then nothing is sent.
    const left = shared === undefined ? timeoutMs : shared - performance.now()
    if (left <= 0) throw new RpcTimeoutError(label, timeoutMs)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(TIMEOUT), left)
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
              const stale = error instanceof Failure && error.staleSocket && (!once || !error.unknown)
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
   * the longer of that and the client's; else the client's, else 30 s. A long
   * poll's (`waitMs`) defaults to at least its wait plus LONG_POLL_MARGIN_MS,
   * and must be at least that, or a call that sees no block could only end as
   * a timeout: a `RangeError`, unsent.
   */
  #callSettings(callOptions: unknown, methodTimeoutMs?: number, waitMs?: number): CallSettings {
    const own = argOptions(callOptions, 'callOptions', CALL_OPTIONS)
    // A method's own default is a floor: a short client timeout must not cut a call qbit Core is known to need longer for.
    const floor = waitMs === undefined ? methodTimeoutMs : Math.max(methodTimeoutMs ?? 0, waitMs + LONG_POLL_MARGIN_MS)
    const fallback =
      floor === undefined ? (this.#timeoutMs ?? DEFAULT_TIMEOUT_MS) : Math.max(floor, this.#timeoutMs ?? 0)
    const timeoutMs = checkInteger(own['timeoutMs'], 'callOptions.timeoutMs', 1, 3_600_000, fallback)
    if (waitMs !== undefined && timeoutMs < waitMs + LONG_POLL_MARGIN_MS) {
      throw new RangeError(
        `callOptions.timeoutMs must be at least waitMs (${waitMs}) plus ${LONG_POLL_MARGIN_MS} ms, for the wait for a request slot and the reply`
      )
    }
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
    authorization: string,
    redact: (message: string) => string = unchanged
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
    const legacy = id === undefined ? undefined : legacyError(method, reply.body, id, redact)
    if (legacy !== undefined && NODE_ERROR_STATUSES.has(reply.status)) {
      throw new Failure(legacy, nodeErrorUnknown(method, sideEffects, legacy), false)
    }
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
    path: string,
    redact: (message: string) => string = unchanged
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
    const nodeError = isJsonObject(error) ? nodeErrorFrom(method, error, redact) : undefined
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

/**
 * Whether the node's error, under HTTP 200 or a legacy status, leaves a call
 * with side effects of unknown outcome: submitpackage can fail after accepting
 * part of the package.
 */
function nodeErrorUnknown(method: string, sideEffects: boolean, error: RpcError): boolean {
  return sideEffects && !refusedBeforeActing(method, error.rpcCode, error.message)
}

function legacyError(
  method: string,
  body: string,
  id: number,
  redact: (message: string) => string
): RpcError | undefined {
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
  return isJsonObject(error) ? nodeErrorFrom(method, error, redact) : undefined
}

const unchanged = (message: string): string => message

/**
 * The params of a single request's body, parsed back as the node will read
 * them: its objects without a prototype, every number a `JsonNumber`.
 */
function sentParams(body: string): unknown {
  return ownValue(parseJsonLossless(body) as { readonly params?: unknown }, 'params')
}

/** The node's error, from an object parseJsonLossless made, its message redacted (see `messageSecrets`) before it is capped. */
function nodeErrorFrom(
  method: string,
  error: Readonly<Record<string, unknown>>,
  redact: (message: string) => string
): RpcError | undefined {
  const code = ownValue(error, 'code')
  const message = ownValue(error, 'message')
  if (!(code instanceof JsonNumber) || !/^-?(?:0|[1-9][0-9]{0,9})$/.test(code.source) || typeof message !== 'string') {
    return undefined
  }
  return new RpcError(method, Number(code.source), redact(message).slice(0, MAX_NODE_MESSAGE))
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
  /**
   * The deadline on the `performance.now()` clock, when the call is part of an
   * operation that set it: dependent calls share one. Else `timeoutMs` from
   * when the call starts.
   */
  readonly deadline?: number
}

/** `settings` with its deadline set from now, for an operation of several calls. */
function sharedDeadline(settings: CallSettings): CallSettings {
  return { ...settings, deadline: performance.now() + settings.timeoutMs }
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
