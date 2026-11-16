// Type tests of the wallet history entries and getTransaction's details,
// compiled by `pnpm typecheck:test` (Vitest does not run this file). Each line
// after a `@ts-expect-error` must fail to compile, and each Equal must hold.
//
// qbit Core v1.0.1 lists a change-only self-transfer as one fee-only `send`
// entry without `vout`, `address` or `label`. A consumer must not be able to
// use such an entry as an output, nor read its missing `vout` as a number,
// while code that first narrows to an output keeps compiling.

import type { CallOptions, ClientSatisfies, Outpoint, WalletHistoryEntry, WalletTransaction } from '../src'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

declare const entry: WalletHistoryEntry
declare const detail: WalletTransaction['details'][number]

// Unnarrowed, `vout` may be absent, and so may `address` and `label` (as before).
true satisfies Equal<typeof entry.vout, number | undefined>
true satisfies Equal<typeof detail.vout, number | undefined>
true satisfies Equal<typeof entry.address, string | undefined>
true satisfies Equal<typeof entry.label, string | undefined>
// @ts-expect-error a missing vout is not a number
export const voutAsNumber: number = entry.vout
// @ts-expect-error nor is a detail's
export const detailVoutAsNumber: number = detail.vout
// @ts-expect-error an entry is not an outpoint until it is narrowed to one
export const entryAsOutpoint: Outpoint = entry
// @ts-expect-error a missing vout cannot be added to
export const nextVout = entry.vout + 1

// Narrowed on `vout`: an output's entry, usable as an outpoint.
if (entry.vout !== undefined) {
  true satisfies Equal<typeof entry.vout, number>
  true satisfies Equal<typeof entry.category, 'send' | 'receive' | 'generate' | 'immature' | 'orphan'>
  entry satisfies Outpoint
}
if (detail.vout !== undefined) true satisfies Equal<typeof detail.vout, number>

// Narrowed on a category other than send: always an output's entry, as code
// that credits deposits reads it.
if (entry.category === 'receive') true satisfies Equal<typeof entry.vout, number>
if (entry.category !== 'send') entry satisfies Outpoint
if (detail.category === 'receive') true satisfies Equal<typeof detail.vout, number>
// A send may be either.
if (entry.category === 'send') true satisfies Equal<typeof entry.vout, number | undefined>

// The fee-only entry: a send whose fee is always present, with no output fields.
if (entry.vout === undefined) {
  true satisfies Equal<typeof entry.category, 'send'>
  true satisfies Equal<typeof entry.feeBits, bigint>
  true satisfies Equal<typeof entry.address, undefined>
  true satisfies Equal<typeof entry.label, undefined>
  true satisfies Equal<typeof entry.parentDescs, undefined>
  true satisfies Equal<typeof entry.txid, string>
}
if (detail.vout === undefined) true satisfies Equal<typeof detail.feeBits, bigint>

// The outputs of a list, as a consumer filters them.
declare const entries: readonly WalletHistoryEntry[]
export const outpoints: readonly Outpoint[] = entries.filter(
  (e): e is Extract<WalletHistoryEntry, { readonly vout: number }> => e.vout !== undefined
)

// A copy of the client declaring `vout` as always present on getTransaction's
// details no longer fits: its code would read the fee-only entry's missing vout.
interface StrictDetails {
  getTransaction(
    txid: string,
    callOptions?: CallOptions
  ): Promise<{ readonly details: readonly { readonly category: string; readonly vout: number }[] }>
}
true satisfies Equal<ClientSatisfies<StrictDetails>, { getTransaction: 'returns' }>
// One that declares it optional fits.
interface OptionalVout {
  getTransaction(
    txid: string,
    callOptions?: CallOptions
  ): Promise<{ readonly details: readonly { readonly category: string; readonly vout?: number }[] }>
  listTransactions(): Promise<readonly { readonly txid: string; readonly vout?: number; readonly feeBits?: bigint }[]>
}
true satisfies ClientSatisfies<OptionalVout>
