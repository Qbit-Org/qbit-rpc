// Type tests of ClientSatisfies and UndeclaredKeys, compiled by `pnpm
// typecheck:test` (Vitest does not run this file). Each line after a
// `@ts-expect-error` must fail to compile, and each Equal must hold.

import type { CallOptions, ChainStatus, ClientSatisfies, NodeVersion, QbitRpcClient, UndeclaredKeys } from '../src'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

interface Outpoint {
  readonly txid: string
  readonly vout: number
}

/** A few members as a consumer copies them, call options as the last argument. */
interface Copy {
  getBlockCount(callOptions?: CallOptions): Promise<number>
  getTxOut(
    txid: string,
    vout: number,
    options?: { readonly includeMempool?: boolean },
    callOptions?: CallOptions
  ): Promise<{ readonly valueBits: bigint; readonly confirmations: number } | null>
  lockUnspent(
    outputs: readonly Outpoint[],
    options?: { readonly persistent?: boolean },
    callOptions?: CallOptions
  ): Promise<void>
  unlockUnspent(outputs: readonly Outpoint[], callOptions?: CallOptions): Promise<void>
  call(method: string, params?: readonly unknown[], callOptions?: CallOptions): Promise<unknown>
  readonly chainStatus: ChainStatus
}

// An exact copy fits.
true satisfies ClientSatisfies<Copy>

// So does a narrower one: fewer arguments, narrower values, fewer result fields.
interface Narrower {
  getBlockCount(): Promise<number>
  testMempoolAccept(rawTxs: readonly string[], options?: undefined, callOptions?: CallOptions): Promise<unknown[]>
  walletProcessPsbt(
    psbt: string,
    options?: { readonly sighashType?: 'DEFAULT' },
    callOptions?: { readonly signal?: AbortSignal }
  ): Promise<{ readonly complete: boolean }>
  walletCreateFundedPsbt(args: {
    readonly outputs: readonly { readonly address: string; readonly amountBits: bigint }[]
    readonly options: { readonly feeRateBitsPerKvB: bigint }
  }): Promise<{ readonly psbt: string }>
}
true satisfies ClientSatisfies<Narrower>

/** The call options merged into the method's own options, as the client took them before. */
interface Split {
  getTxOut(
    txid: string,
    vout: number,
    options?: { readonly includeMempool?: boolean } & CallOptions
  ): Promise<{ readonly valueBits: bigint } | null>
}
// A plain assignment takes it: TypeScript compares methods bivariantly, and an
// object with more properties is assignable to one with fewer. The client
// refuses `timeoutMs` in `options` with a TypeError.
export const plain = (rpc: QbitRpcClient): Split => rpc
// @ts-expect-error Split options.
true satisfies ClientSatisfies<Split>
true satisfies Equal<ClientSatisfies<Split>, { getTxOut: 'parameters' }>

/** A member the client lacks. */
interface Missing {
  getBlockCountAt(height: number): Promise<number>
}
// @ts-expect-error A missing member.
true satisfies ClientSatisfies<Copy & Missing>
true satisfies Equal<ClientSatisfies<Copy & Missing>, { getBlockCountAt: 'missing' }>

/** A return type the client's is not assignable to. */
interface Returns {
  getBlockCount(callOptions?: CallOptions): Promise<string>
}
// @ts-expect-error A wrong return type.
true satisfies ClientSatisfies<Returns>
true satisfies Equal<ClientSatisfies<Returns>, { getBlockCount: 'returns' }>

// An optional member fits when the client has it as the copy declares it, and
// when the client lacks it; Required<> requires it. One the client has must fit.
interface Optional {
  getBlockCount(): Promise<number>
  confirmChain?(callOptions?: CallOptions): Promise<unknown>
  rescanUtxoSet?(): Promise<void>
}
true satisfies ClientSatisfies<Optional>
true satisfies Equal<ClientSatisfies<Required<Optional>>, { rescanUtxoSet: 'missing' }>
true satisfies Equal<
  ClientSatisfies<{ confirmChain?(options?: { readonly force?: boolean }): Promise<unknown> }>,
  { confirmChain: 'parameters' }
>

// Each member that does not fit is named, with why: lockUnspent(unlock,
// outputs, options) resolving a boolean is how the client took it before.
interface Old {
  lockUnspent(
    unlock: boolean,
    outputs: readonly Outpoint[],
    options?: { readonly persistent?: boolean } & CallOptions
  ): Promise<boolean>
  testMempoolAccept(rawTxs: readonly string[], callOptions?: CallOptions): Promise<unknown[]>
  finalizePsbt(psbt: string, options?: { readonly extract?: boolean; readonly signal?: AbortSignal }): Promise<unknown>
}
true satisfies Equal<
  ClientSatisfies<Copy & Split & Old & Missing>,
  {
    getTxOut: 'parameters'
    lockUnspent: 'returns' | 'parameters'
    testMempoolAccept: 'parameters'
    finalizePsbt: 'parameters'
    getBlockCountAt: 'missing'
  }
>

// Parameters that do not fit for other reasons: a value wider than the client
// takes (`string` for `AddressType`), a key the client does not declare deeper
// in an argument, more arguments than the client takes, and an optional one the
// client requires.
true satisfies Equal<
  ClientSatisfies<{
    getRawChangeAddress(options?: { readonly addressType?: string }): Promise<string>
    walletCreateFundedPsbt(args: {
      readonly outputs: readonly { readonly address: string; readonly amountBits: bigint }[]
      readonly options: { readonly feeRateBitsPerKvB: bigint; readonly fee_rate?: number }
    }): Promise<unknown>
    getBlockCount(callOptions?: CallOptions, extra?: boolean): Promise<number>
    getBlockHash(height?: number): Promise<string>
  }>,
  {
    getRawChangeAddress: 'parameters'
    walletCreateFundedPsbt: 'parameters'
    getBlockCount: 'parameters'
    getBlockHash: 'parameters'
  }
>

// Members that are not methods, or are on one side only.
true satisfies Equal<
  ClientSatisfies<{ readonly chainStatus: 'confirmed'; readonly getBlockCount: number; nodeVersion(): unknown }>,
  { chainStatus: 'type'; getBlockCount: 'type'; nodeVersion: 'type' }
>

// UndeclaredKeys compares argument lists position by position, at any depth,
// and names a key the parameter lacks rather than what is under it.
true satisfies Equal<
  UndeclaredKeys<[{ a?: number } & CallOptions], [{ a?: number }, CallOptions?]>,
  'signal' | 'timeoutMs'
>
true satisfies Equal<UndeclaredKeys<[{ a?: number }, CallOptions?], [{ a?: number }, CallOptions?]>, never>
true satisfies Equal<UndeclaredKeys<{ o: { a: 1; b: { c: 3 } }[] }, { o: readonly { a: number }[] }>, 'b'>
// A key of any member of a union parameter is declared, and `unknown` takes any key.
true satisfies Equal<UndeclaredKeys<{ a: 1 } | { b: 2 }, { a: number } | { b: number }>, never>
true satisfies Equal<UndeclaredKeys<{ a: 1; c: 3 } | { b: 2 }, { a: number } | { b: number }>, 'c'>
true satisfies Equal<UndeclaredKeys<{ a: { b: 1 } }, { a: unknown }>, never>
true satisfies Equal<UndeclaredKeys<string | undefined, string>, never>

// After review: each case below names a copy the type used to judge wrongly.

/** The nodeVersion getter, copied exactly, undefined included. */
true satisfies ClientSatisfies<Pick<QbitRpcClient, 'nodeVersion'>>
true satisfies ClientSatisfies<{ readonly nodeVersion: NodeVersion | undefined }>

/** A tuple argument where the client takes an array: its elements are checked against the array's element. */
interface TupleExtra {
  unlockUnspent(outputs: readonly [{ txid: string; vout: number; timeoutMs: number }]): Promise<void>
}
// @ts-expect-error An undeclared key inside a tuple element.
true satisfies ClientSatisfies<TupleExtra>
true satisfies Equal<ClientSatisfies<TupleExtra>, { unlockUnspent: 'parameters' }>
true satisfies ClientSatisfies<{ unlockUnspent(outputs: readonly [Outpoint]): Promise<void> }>

/** Options typed `object` or `{}` let any key through. */
// @ts-expect-error Options of any shape.
true satisfies ClientSatisfies<{ getTxOut(txid: string, vout: number, options?: object): Promise<unknown> }>
// @ts-expect-error Options of any shape.
true satisfies ClientSatisfies<{ getTxOut(txid: string, vout: number, options?: {}): Promise<unknown> }>

/** One output merging both forms of a funded PSBT's output union. */
interface MergedOutput {
  walletCreateFundedPsbt(args: {
    readonly outputs: readonly { readonly address: string; readonly amountBits: bigint; readonly data?: string }[]
  }): Promise<unknown>
}
// @ts-expect-error `data` beside `address`: no member of the union declares both.
true satisfies ClientSatisfies<MergedOutput>

/** Both forms' keys required at once: the argument fits both members, and the client refuses it as either. */
interface BothForms {
  walletCreateFundedPsbt(args: {
    readonly outputs: readonly { readonly address: string; readonly amountBits: bigint; readonly data: string }[]
  }): Promise<unknown>
}
// @ts-expect-error Every output holds `address` and `data`, which the client refuses together.
true satisfies ClientSatisfies<BothForms>
true satisfies Equal<ClientSatisfies<BothForms>, { walletCreateFundedPsbt: 'parameters' }>

/** The usual exclusive-or union: each form names the other's keys as `never`, which only hold undefined. */
interface ExclusiveForms {
  walletCreateFundedPsbt(args: {
    readonly outputs: readonly (
      | { readonly address: string; readonly amountBits: bigint; readonly data?: never }
      | { readonly data: string; readonly address?: never; readonly amountBits?: never }
    )[]
  }): Promise<unknown>
}
true satisfies ClientSatisfies<ExclusiveForms>

/** A key no member of the union declares is still reported, even when it can only be undefined. */
interface UnknownNever {
  walletCreateFundedPsbt(args: {
    readonly outputs: readonly { readonly address: string; readonly amountBits: bigint; readonly memo?: never }[]
  }): Promise<unknown>
}
// @ts-expect-error `memo` is no key of either form.
true satisfies ClientSatisfies<UnknownNever>

/** A member typed as a nullable function is still checked as a method. */
interface NullableSplit {
  getTxOut:
    | ((txid: string, vout: number, options?: { readonly includeMempool?: boolean } & CallOptions) => Promise<unknown>)
    | null
}
// @ts-expect-error Split options behind `| null`.
true satisfies ClientSatisfies<NullableSplit>
true satisfies Equal<ClientSatisfies<NullableSplit>, { getTxOut: 'parameters' }>

/** A branded txid is still a string. */
type Txid = string & { readonly __brand: 'Txid' }
true satisfies ClientSatisfies<{ getMempoolEntry(txid: Txid): Promise<unknown> }>
