# Wallet

## Unlocking an encrypted wallet

`walletPassphrase(passphrase, timeoutSeconds)` unlocks the wallet for
`timeoutSeconds`, counted from when qbit Core finishes the unlock, and
`walletLock()` locks it again. Both are side-effecting wallet-write calls.

**The first unlock is slow.** On a chain that allows only P2MR outputs (every
chain, unless regtest runs with `-p2mronly=0`), qbit Core v1.0.0 creates a
wallet with a passphrase with 16 keys per descriptor, and derives the rest of
its keypool (`-keypool`, 1,000 by default) inside the wallet's first
`walletpassphrase`, which answers only once that is done. On regtest that first
unlock took 25 to 31 s on a shared host and 49 s on a GitHub-hosted
`ubuntu-latest` runner; later ones take about 0.2 s. Unloading and loading the
wallet, or restarting the node, does not skip it. The time grows with
`-keypool`: on that host 2.3 s at 100 keys, 13 s at 500, 28 s at 1,000 and 53 s
at 2,000. While it runs, every other call on that wallet waits for it,
`getWalletInfo()` and `walletLock()` included; chain calls and other wallets do
not. A wallet created without a passphrase derives the rest of its keypool in
the background instead, from 30 s after it is created or loaded: no call waits
for all of it, only about 0.2 s each while it runs.

**The default deadline.** So `walletPassphrase` and `walletLock`, typed or as
`walletpassphrase` and `walletlock` through `call()`, have a default deadline of
120 s, more than twice the slowest first unlock measured, as five
[wallet-admin](wallet-admin.md) methods have; every other method keeps
30 s. A client's `timeoutMs` applies to these only when it is longer than
120 s, so a client that sets a short one does not cut the first unlock, or a
lock waiting for it. The call's own `timeoutMs` always wins:

```ts
const rpc = new QbitRpcClient({ ...options, timeoutMs: 10_000 }) // every call; these two keep 120 s
await rpc.walletPassphrase(passphrase, 60) // 120 s
await rpc.walletLock() // 120 s
await rpc.walletPassphrase(passphrase, 60, { timeoutMs: 300_000 }) // the call's own wins
```

Every other call keeps the client's deadline, so one on that wallet sent during
a first unlock can need a longer `timeoutMs`: a read such as `getWalletInfo()`
that misses it is an `RpcTimeoutError` you can repeat, a side-effecting call
such as `getNewAddress()` an `RpcUnknownOutcomeError`.

With a `-keypool` above about 2,000, or a host slower than that runner, pass a
longer `timeoutMs`, or unlock the wallet once right after creating it, before
it serves anything.

**A missed deadline.** Once it is sent, a `walletPassphrase` that misses its
deadline or is aborted rejects with `RpcUnknownOutcomeError`: qbit Core may still
be unlocking the wallet, or may have unlocked it. Before it is sent (waiting
for a request slot, reading the cookie, connecting, or in the chain re-check)
it rejects with `RpcTimeoutError` or `RpcAbortedError`, or `RpcChainGuardError`
`check_failed` with one of those as its `cause`: nothing was sent, and calling
it again is safe. After an `RpcUnknownOutcomeError`, `getWalletInfo()` tells
which: `unlockedUntil` is 0 while the wallet is locked, the Unix time it locks
again once unlocked, and absent on a wallet with no passphrase. It waits for an
unlock still running, so give it a deadline that covers one. If it fails too,
the outcome is still unknown, so the original error is the one to report:

```ts
try {
  await rpc.walletPassphrase(passphrase, 60)
} catch (error) {
  if (!RpcUnknownOutcomeError.is(error)) throw error // not sent, or the node's answer
  // getwalletinfo waits for an unlock still running.
  const info = await rpc.getWalletInfo({ timeoutMs: 120_000 }).catch(() => undefined)
  if (!info?.unlockedUntil) throw error // locked, or no answer: still not unlocked for sure
  // unlocked, until info.unlockedUntil
}
```

Calling `walletPassphrase` again is safe too: it waits for one still running,
then sets a new relock time. `walletLock()` also waits for it, under the same
default deadline.

## Signing right after `qbitd` starts

After `qbitd` starts, qbit Core v1.0.0 validates an unencrypted wallet's
plaintext PQC keys before it signs. Until
`getWalletInfo().pqcKeyValidation.signingBlocked` is false, `walletProcessPsbt`
fails with `RpcError` "plaintext PQC wallet key validation is still in
progress". Wait for it before signing.

## PQC signature budgets

Each P2MR address of a wallet has its own PQC key, and qbit Core v1.0.0 lets a
key make 2^30 (1,073,741,824) signatures. It counts each signature the key
makes, one per input it signs, and writes the count to the wallet before
signing: signing the same unsigned PSBT twice uses two, broadcast or not. The state follows from
the count (`src/wallet/pqc_usage.h`):

| `pqcLimitState` | Count | The node | What to do |
| --- | --- | --- | --- |
| `normal` | below 2^28 | signs | nothing |
| `warning` | from 2^28 (268,435,456) | signs; a `warnings` line on entering, and again every further 2^24 signatures | plan to move the coins to a new address, and stop reusing this one |
| `critical` | from 2^30 − 2^24 (1,056,964,608) | signs; a line on entering, and again every further 2^20 signatures | stop using the address and spend its coins to a new one now, while every coin still has a signature (one per input) |
| `exhausted` | 2^30, none left | signs nothing more with the key | the wallet can no longer spend the address's coins: lock them with `lockUnspent(outputs, { persistent: true })`, so coin selection skips them after a restart too, and lock a coin that arrives there later the same way (`listUnspent` with `addresses` and `minConf: 0` finds it, unconfirmed too); rotate to a new key/address, as the node's warning says |

What to watch, as observed on a v1.0.0 regtest node:

- `walletProcessPsbt` reports only the keys that signed in that call, with the
  count after signing. The signature that reaches the limit is reported as
  `exhausted`, `pqcSignaturesRemaining` 0, and the warning `PQC key <pubkey>
  reached the signature limit (1073741824 of 1073741824 signatures used, 0
  remaining). Rotate to a new key/address.` The other lines read `PQC key
  <pubkey> entered warning usage range (…)` or `… remains in critical usage
  range (…)`. Lines are text for people: act on `pqcLimitState`.
- An exhausted key is not an error. `walletProcessPsbt` resolves with
  `complete: false`, leaves that key's inputs unsigned, and says nothing about
  it: a PSBT only that key would sign comes back with no PQC fields and no
  warning, and beside other keys only they are reported, so
  `pqcOverallLimitState` can be `normal`. With two inputs and one signature
  left, the first input is signed and the second is not.
- The wallet still lists an exhausted key's coins as spendable, counts them in
  its balance, and `walletCreateFundedPsbt` picks them.
- So `walletProcessPsbt` reads the state of the keys it is about to use
  first, and refuses to sign (`PqcSigningError`) on `exhausted`, on a state
  this version does not know, or when a key has fewer signatures left than
  the inputs it would sign; `checkPqcSigning(psbt)` runs that check alone, and
  warns of a `critical` key, which is when to sign the spend that moves the
  coins on. See [checking PQC keys before signing](payments.md#checking-pqc-keys-before-signing).
  It reads `getAddressInfo` of each input's address, which can be the wallet's
  unconfirmed change. Read the change address's state too before you reuse
  it: `getAddressInfo` reports any state, `exhausted` too, without warnings.
  An incomplete PSBT whose inputs are all the wallet's own may mean an
  exhausted key, signed with `pqcCheck: false`.
- The count is the wallet's own. A wallet restored from a backup counts from
  the backup's count, and one the descriptor is imported into counts from 0
  (`test/functional/wallet_pqc_usage.py`), so neither knows the signatures the
  key made since, or elsewhere.

How this was checked: qbit Core v1.0.0 has no option to lower the limit, so the
regtest smoke test writes a key's count into the wallet file below each
threshold, reloads the wallet and signs; it asserts each state, both reminder
lines, the limit, and the exhausted key's incomplete PSBT (signed with
`pqcCheck: false`), and that `walletProcessPsbt` refuses a key that would run
out, and an exhausted one, before signing, its count read back unchanged. The reasoning for
the advice in the last column is ours, not the node's; that the worst key sets
`pqcOverallLimitState` when several keys differ is read from the source only;
and no key has reached these counts by signing.

## Address types

`getNewAddress`'s and `getRawChangeAddress`'s `addressType`, and
`walletCreateFundedPsbt`'s `options.changeType`, are an `AddressType`: `p2mr`,
`bech32m`, `bech32`, `p2sh-segwit` or `legacy`, the five names qbit Core v1.0.0
parses. Any other string is refused before sending, as the node refuses it
(`RpcError` -5); the type is closed so that a typo fails to compile. Which of
the five a wallet can make depends on the chain:

| Chain | Address types |
| --- | --- |
| `main`, `test`, `testnet4`, `signet` | `p2mr` only |
| `regtest` | `p2mr` only, unless qbitd runs with `-p2mronly=0`: then all five |

A type the chain does not allow is the node's `RpcError` -5. Left out, the
wallet's `-addresstype` or `-changetype` applies.

## Wallet history

`listSinceBlock` and `listTransactions` return `WalletHistoryEntry` objects,
one per output a wallet transaction sent or received, in signed bits:
`amountBits` is at most 0 for `send` (0 for an OP_RETURN output, which has no
`address`) and at least 0 for every other category. `feeBits` is on every
`send` entry and no other. It is all outputs minus this wallet's inputs,
repeated on each of the transaction's `send` entries, so do not add it up per
entry. When every input is this wallet's, that is the fee, as a negative
number; with inputs from other wallets it is not the fee, and it can be
positive. A payment to the wallet itself is a `send` and a `receive` entry for
one output. `blockHash`, `blockHeight`, `blockIndex` and `blockTime` (the block
header's time, unlike the wallet's `time` and `timeReceived`) are present
exactly when `confirmations` is above 0, and `trusted` exactly when it is not.
`confirmations` is negative for a transaction that a mined conflict replaced,
and `abandoned` marks a transaction the wallet gave up on, or an orphaned
coinbase.

Use `listSinceBlock` as a cursor: store `lastBlock` and pass it as the next
call's `blockHash`. `transactions` holds every entry of the later blocks and
every entry at 0 confirmations, plus the `send` entries of a transaction a later
block conflicted. An unconfirmed entry comes back until it is mined. An
abandoned transaction or orphaned coinbase stays at 0 confirmations and comes
back on every call until it is mined after all (it then confirms, with
`abandoned` false), a conflict is mined (negative `confirmations`), or the
orphaned block is reconnected; an entry that stops being listed may have gone
either way, and `getTransaction` tells which. Key entries by `txid`, `vout` and
whether the entry is a `send` (a payment to the wallet itself has a `send` and a
`receive` entry for one `vout`), and keep the latest `category`: a coinbase
output goes from `immature` to `generate`, or to `orphan`. With
`targetConfirmations: n`, `lastBlock` is n - 1 blocks below the tip (the genesis
block on a shorter chain), so entries keep coming back until they have n
confirmations. When the stored block has left the active chain, the call lists
from the fork point, and `removed` holds the entries of the blocks that left,
each as it is now: 0 `confirmations` back in the mempool, positive with its new
block when mined again, negative when a conflict was mined instead. `removed` is
absent only when `includeRemoved: false` was passed; otherwise a reply without
it fails validation instead of reading as "nothing removed". qbit Core v1.0.0
accepts `includeWatchOnly` and ignores it.

To credit deposits, read `receive` entries, and undo a credit from `removed` and
`getTransaction`. qbit Core leaves a conflicted transaction's `receive` entries
out of `transactions` and `listTransactions`, so a double-spent deposit just
stops being listed. It is in `removed` only when the stored block was in a part
of the chain that left. A deposit credited while unconfirmed, or while the
stored block was still below its block, is in neither list, so check each
credited `txid` with `getTransaction` until you consider it final: it reports
negative `confirmations`, with no `receive` entry in `details`.

To add up what the wallet sent, take `send` entries without `includeChange`
(which adds each change output as a `send` and a `receive` entry), count each
`txid` and `vout` once, and skip `abandoned` entries and those with negative
`confirmations`. A replaced payment appears as several transactions spending
the same inputs: the original and each replacement. `bumpfee` links them with
`replacedByTxid` and `replacesTxid`; a replacement sent with
`sendRawTransaction`, as after `psbtBumpFee`, sets neither, and only
`walletConflicts` links them, which stays set even if a replacement leaves the
mempool unmined. Treat each such group as one payment. Once one of them is
mined, the others have negative `confirmations`: count the mined one, even
when it is the original and carries `replacedByTxid`. Until then the payment is
pending: count it once, as pending, not from both entries, as a replacement can
pay another amount or recipient. Don't rely on `mempoolConflicts` alone: it is
empty again when none of them is in the mempool.

`listTransactions` lists the newest `count` entries after skipping the newest
`skip`, without change outputs. A `label` keeps incoming entries paying to that
label; `*` lists everything, and qbit Core refuses `''`, so the client does.
`count + skip` must be at most 2,147,483,647, as qbit Core adds them as 32-bit
integers.

`getBalances` reports `mine` in bits. `usedBits` is present only for a wallet
with `avoid_reuse` set, where `0n` is a real zero. qbit Core v1.0.0 has no
`watchonly` section: a wallet without private keys reports what it watches
under `mine`. `lastProcessedBlock` is the block the balances were computed at.

## As a `CoreRpc` wallet adapter

`QbitRpcClient` is passed as it is, with no wrapper, to the qbit Core wallet
adapter in `qbit-payments`, whose `CoreRpc` interface declares the calls it
makes. Scope the client to the wallet (`wallet`), enable `wallet-read`,
`wallet-write` and `broadcast`, and call `confirmChain()` before handing it
over. Check that the client fits `CoreRpc` in the adapter's own type tests,
with [`ClientSatisfies`](methods.md#checking-an-interface-of-your-own-clientsatisfies).
That check sees types only: the adapter must also read a node's error code
from `rpcCode`. Reading `code`, it would take every node error for an unknown
outcome.

## Signing a data hash

`signDataPqcHash(address, messageHash, options)` signs a 32-byte hash with the
PQC key a P2MR address of the wallet commits to, for sign-in or attestation.
It is a `wallet-write` call, behind the chain guard, and needs the wallet
unlocked (`RpcError` -13; -4 for an address the wallet does not have, or while
the wallet validates its PQC keys). The result is checked against the request
(address, hash and any `pubkey`, `leafScript` or `controlBlock` asked for; the
address in either case, as a bech32m address in capitals is the same one, and
qbit Core v1.0.0 echoes it as it was sent), and `verifyDataPqcHash` takes it
as it is:

```ts
const signed = await rpc.signDataPqcHash(address, challengeHash, { includePqcUsage: true })
const { valid } = await rpc.verifyDataPqcHash(signed) // any node, no wallet or capability
const state = signed.pqcOverallLimitState
if (state !== undefined && state !== 'normal' && state !== 'warning') {
  // critical, exhausted, or a state a later qbit Core adds: rotate to a new address
}
```

Each signature uses one of the key's 2^30 (SLH-DSA-SHA2-128s-bounded30), so it
has side effects: never retried, and a lost reply is an
`RpcUnknownOutcomeError`, after which the count may have advanced; signing
again uses another. Sign each challenge once, and keep a signature you need
again. `includePqcUsage` adds the key's [PQC usage fields](methods.md#typed-methods) and
threshold `warnings`, as `walletProcessPsbt`'s; qbit Core advises it only for
local diagnostics, as they show the exact remaining budget. Without it, read
the budget with `getAddressInfo(address)`. qbit Core reads the option names in
snake case and ignores any other, so through `call()`, `includePqcUsage`,
`leafScript` and `controlBlock` are refused (send `include_pqc_usage` and so
on, or use the typed method).
