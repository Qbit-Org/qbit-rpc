// An adapted copy of the `CoreRpc` interface the qbit Core wallet adapter in
// Qbit-Org/qbit-payments takes (packages/payments/src/core-wallet/rpc.ts at
// 8030b00). It differs from that file in four places: `Outpoint` is copied in
// from its src/tx.ts instead of imported, the `CoreRpc` comment names
// `QbitRpcClient` at 8ad6854 where the original names 09eac4a, `rpcErrorCode`
// and the `CoreRpc` comments read `rpcCode`, the property `RpcError` has had
// since qbit-rpc issue #8, where the original reads `code`, and the methods take
// the shapes qbit-rpc issue #9 settled, where the original has the earlier ones:
// the call options are a separate last argument instead of merged into a
// method's options, `lockUnspent(outputs, options)` locks and
// `unlockUnspent(outputs)` unlocks instead of `lockUnspent(unlock, outputs,
// options)`, both resolve `void`, and `addressType` is `'p2mr'`, not `string`.
// test/core-rpc.test.ts proves `QbitRpcClient` satisfies it without a wrapper.
// The adapter has changed since 8030b00 and this copy has not: a check that
// catches the drift, in place of the copy, is tracked in qbit-rpc issue #22.

/** An output a transaction spends (`Outpoint` in qbit-payments src/tx.ts). */
export interface Outpoint {
  txid: string
  vout: number
}

// --- Copied from qbit-payments packages/payments/src/core-wallet/rpc.ts ---

// The qbit Core RPC calls the adapter makes, as a structural interface. Its
// method names, argument order and result fields follow `@qbit-oss/rpc`'s
// `QbitRpcClient`, so that a client of it, scoped to one wallet, can be passed
// in directly or through a thin shim for the methods it reaches only through
// `call()`. Amounts are `bigint` bits; nothing here is ever a JS number of bits.

/** Per-call options, as `QbitRpcClient` takes them. */
export interface CoreRpcCallOptions {
  readonly signal?: AbortSignal
  /** The deadline of this call, every retry included. */
  readonly timeoutMs?: number
}

/** Signature-budget state of a PQC key, as qbit Core reports it. */
export type PqcLimitState = 'normal' | 'warning' | 'critical' | 'exhausted'

/** One local PQC key's signature budget (`pqc_key_states[]`). */
export interface CorePqcKeyState {
  readonly pubkey: string
  readonly pqcSignatureCount: number
  readonly pqcSignatureLimit: number
  readonly pqcSignaturesRemaining: number
  readonly pqcLimitState: PqcLimitState
}

/** `getblockchaininfo`, the fields the adapter reads. */
export interface CoreBlockchainInfo {
  /** `main`, `test`, `testnet4`, `signet` or `regtest`. */
  readonly chain: string
  readonly blocks: number
  readonly bestBlockHash: string
}

/** `getwalletinfo`, the fields the adapter reads. */
export interface CoreWalletInfo {
  readonly walletName: string
  /** 0 when locked; absent for an unencrypted wallet. */
  readonly unlockedUntil?: number
  readonly privateKeysEnabled: boolean
  readonly descriptors: boolean
  readonly pqcKeyValidation: { readonly signingBlocked: boolean }
  readonly lastProcessedBlock: { readonly hash: string; readonly height: number }
}

/** `gettransaction`, the fields the adapter reads. */
export interface CoreWalletTransaction {
  readonly txid: string
  /** Negative when a conflicting transaction is that many blocks deep. */
  readonly confirmations: number
  readonly blockHash?: string
  readonly blockHeight?: number
  readonly lastProcessedBlock: { readonly hash: string; readonly height: number }
}

/** `gettxout`: an unspent output. */
export interface CoreTxOut {
  readonly bestBlock: string
  /** 0 for an output of a mempool transaction. */
  readonly confirmations: number
  readonly valueBits: bigint
  readonly scriptPubKey: { readonly hex: string; readonly address?: string }
  readonly coinbase: boolean
}

/** `getaddressinfo`, the fields the adapter reads. */
export interface CoreAddressInfo {
  readonly address: string
  readonly scriptPubKey: string
  readonly isMine: boolean
  readonly solvable: boolean
  readonly isChange?: boolean
  /** Present for a wallet-owned P2MR address: its keys' signature budgets. */
  readonly pqcKeyStates?: readonly CorePqcKeyState[]
  readonly pqcOverallLimitState?: PqcLimitState
}

/** A `walletcreatefundedpsbt` output: an address and an amount in bits. */
export interface CoreFundedPsbtOutput {
  readonly address: string
  readonly amountBits: bigint
}

/** `walletcreatefundedpsbt`'s arguments, named as `QbitRpcClient` names them. */
export interface CoreFundedPsbtArgs {
  readonly inputs?: readonly { readonly txid: string; readonly vout: number }[]
  readonly outputs: readonly CoreFundedPsbtOutput[]
  readonly options: {
    readonly addInputs?: boolean
    readonly includeUnsafe?: boolean
    readonly minConf?: number
    readonly changeAddress?: string
    readonly changePosition?: number
    readonly lockUnspents?: boolean
    /** Bits per 1,000 vbytes; sent as `fee_rate` in bits per vbyte. */
    readonly feeRateBitsPerKvB: bigint
    /**
     * Output indexes that pay the fee. qbit Core v1.0.0 reads only the
     * camelCase `subtractFeeFromOutputs` option here and silently ignores
     * `subtract_fee_from_outputs`.
     */
    readonly subtractFeeFromOutputs?: readonly number[]
    readonly maxTxWeight?: number
    readonly replaceable?: boolean
  }
}

/** `walletcreatefundedpsbt`'s result. */
export interface CoreFundedPsbt {
  /** Base64. */
  readonly psbt: string
  readonly feeBits: bigint
  /** -1 when no change output was added. */
  readonly changePos: number
}

/** `walletprocesspsbt`'s result. */
export interface CoreProcessedPsbt {
  readonly psbt: string
  readonly complete: boolean
  readonly hex?: string
  readonly pqcKeyStates?: readonly CorePqcKeyState[]
  readonly pqcOverallLimitState?: PqcLimitState
  /** PQC threshold warnings, when the node emitted any. */
  readonly warnings?: readonly string[]
}

/** `finalizepsbt`'s result. */
export interface CoreFinalizedPsbt {
  readonly psbt?: string
  readonly hex?: string
  readonly complete: boolean
}

/** One `testmempoolaccept` entry. */
export interface CoreMempoolAcceptance {
  readonly txid: string
  readonly allowed?: boolean
  readonly rejectReason?: string
  readonly rejectDetails?: string
}

/**
 * The qbit Core RPC calls the Core wallet and chain make, on one node and,
 * for wallet calls, one wallet (`QbitRpcClient`'s `wallet` option).
 *
 * **Errors.** A JSON-RPC error from the node must reject with an error whose
 * `rpcCode` is the node's numeric error code, as `QbitRpcClient`'s `RpcError`
 * does: that is a definite answer. Anything else (a timeout, a dropped
 * connection, an abort) means the outcome of a call with side effects is
 * unknown, and the adapter treats it so.
 *
 * Methods `QbitRpcClient` at `8ad6854` reaches only through `call()`:
 * `getBlockCount`, `getMempoolEntry`, `getTxOut`, `getAddressInfo`,
 * `getRawChangeAddress`, `lockUnspent` and `listLockUnspent`.
 */
export interface CoreRpc {
  getBlockchainInfo(callOptions?: CoreRpcCallOptions): Promise<CoreBlockchainInfo>
  getBlockCount(callOptions?: CoreRpcCallOptions): Promise<number>
  getBestBlockHash(callOptions?: CoreRpcCallOptions): Promise<string>
  /** Rejects with `rpcCode` -5 for a transaction not in the mempool. */
  getMempoolEntry(txid: string, callOptions?: CoreRpcCallOptions): Promise<object>
  /** `null` for an output that is spent, or unknown; with `includeMempool`, spent in the mempool too. */
  getTxOut(
    txid: string,
    vout: number,
    options?: { readonly includeMempool?: boolean },
    callOptions?: CoreRpcCallOptions
  ): Promise<CoreTxOut | null>
  getConfirmationTarget(
    valueBits: bigint,
    options?: { readonly securityLevel?: 'low' | 'medium' | 'high' | 'maximum' },
    callOptions?: CoreRpcCallOptions
  ): Promise<{ readonly requiredConfirmations: number }>
  /** No options of its own: the node's default fee-rate cap applies. */
  testMempoolAccept(
    rawTxs: readonly string[],
    options?: undefined,
    callOptions?: CoreRpcCallOptions
  ): Promise<CoreMempoolAcceptance[]>
  /** Resolves with the txid. No options of its own: the node's default fee-rate cap applies. */
  sendRawTransaction(hex: string, options?: undefined, callOptions?: CoreRpcCallOptions): Promise<string>

  getWalletInfo(callOptions?: CoreRpcCallOptions): Promise<CoreWalletInfo>
  /** Rejects with `rpcCode` -5 for a transaction the wallet does not know. */
  getTransaction(txid: string, callOptions?: CoreRpcCallOptions): Promise<CoreWalletTransaction>
  getAddressInfo(address: string, callOptions?: CoreRpcCallOptions): Promise<CoreAddressInfo>
  getRawChangeAddress(options?: { readonly addressType?: 'p2mr' }, callOptions?: CoreRpcCallOptions): Promise<string>
  /** `lockunspent` with `unlock` false. Rejects with `rpcCode` -8 for an output it cannot lock. */
  lockUnspent(
    outputs: readonly Outpoint[],
    options?: { readonly persistent?: boolean },
    callOptions?: CoreRpcCallOptions
  ): Promise<void>
  /** `lockunspent` with `unlock` true. Rejects with `rpcCode` -8 for an output it cannot unlock. */
  unlockUnspent(outputs: readonly Outpoint[], callOptions?: CoreRpcCallOptions): Promise<void>
  listLockUnspent(callOptions?: CoreRpcCallOptions): Promise<Outpoint[]>
  walletCreateFundedPsbt(args: CoreFundedPsbtArgs, callOptions?: CoreRpcCallOptions): Promise<CoreFundedPsbt>
  walletProcessPsbt(
    psbt: string,
    options?: {
      readonly sign?: boolean
      readonly sighashType?: 'DEFAULT'
      readonly bip32derivs?: boolean
      readonly finalize?: boolean
    },
    callOptions?: CoreRpcCallOptions
  ): Promise<CoreProcessedPsbt>
  finalizePsbt(
    psbt: string,
    options?: { readonly extract?: boolean },
    callOptions?: CoreRpcCallOptions
  ): Promise<CoreFinalizedPsbt>
  walletPassphrase(passphrase: string, timeoutSeconds: number, callOptions?: CoreRpcCallOptions): Promise<void>
  walletLock(callOptions?: CoreRpcCallOptions): Promise<void>
}

/** The node's numeric JSON-RPC error code of `error`, or `undefined` when it is not a node answer. */
export function rpcErrorCode(error: unknown): number | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { rpcCode?: unknown }).rpcCode : undefined
  return typeof code === 'number' && Number.isInteger(code) ? code : undefined
}

/** RPC_INVALID_ADDRESS_OR_KEY: no such transaction (`gettransaction`, `getmempoolentry`). */
export const RPC_NOT_FOUND = -5
/** RPC_INVALID_PARAMETER: `lockUnspent` or `unlockUnspent` of an output it cannot lock or unlock. */
export const RPC_INVALID_PARAMETER = -8
/** RPC_WALLET_INSUFFICIENT_FUNDS. */
export const RPC_WALLET_INSUFFICIENT_FUNDS = -6
/** RPC_VERIFY_ALREADY_IN_CHAIN: "Transaction outputs already in utxo set". */
export const RPC_VERIFY_ALREADY_IN_CHAIN = -27
