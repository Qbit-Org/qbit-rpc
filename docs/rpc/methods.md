# Methods, arguments and batches

## Typed methods

Results are validated field by field (hashes, hex, integer ranges, enums,
amounts) and returned with camelCase names; fields the node adds beyond these
are dropped (use `call()` for the raw reply). Which enums take a value a later
qbit Core adds, and which fields may be absent, is in
[Versions and compatibility](versions.md). Every object in a result, typed or
from `call()`, has a null prototype: an absent field must read as `undefined`
even if `Object.prototype` is polluted after the reply arrives, such as a
missing `blockHash` on an unconfirmed transaction. The client reads the reply
itself by its own properties too. So `toStrictEqual` and `assert.deepStrictEqual`
against a plain object literal fail (use `toEqual`), a result object has no
`hasOwnProperty` (use `Object.hasOwn`), and `String()` throws on one; spread a
result into `{}` for a plain object. A result that does not validate
throws `RpcResponseError` with `reason: 'validation'` and the `path` of the
offending value. After a side-effecting call the node has acted, so that error
is the `cause` of an `RpcUnknownOutcomeError`. Each method also takes
[call options](configuration.md#call-options) as its last argument, left out below.

| Method | Returns |
| --- | --- |
| `getBlockchainInfo()` | `BlockchainInfo`, including `p2mrValidationWeight` and `futureBlockTime` |
| `getNetworkInfo()` | `NetworkInfo`; `relayFeeBitsPerKvB`, `incrementalFeeBitsPerKvB` |
| `getBestBlockHash()`, `getBlockHash(height)` | block hash |
| `getBlockCount()` | the tip's height |
| `getBlockHeader(hash)` | `BlockHeader`; checks the hash, `versionHex` and genesis linkage |
| `getBlock(hash)` | `Block` (verbosity 1): the header's fields, `strippedSize`, `size`, `weight` and `tx`, the txids; checks the hash and `nTx`; `RpcError` -5 for an unknown block, -1 for a pruned one |
| `getBlockWithTransactions(hash)` | `BlockWithTransactions` (verbosity 2): `tx` decoded as in `getRawTransactionVerbose`, with `feeBits` where undo data allows; see [large replies](reading-the-chain.md#large-replies) |
| `getBlockHex(hash)` | the block as stored, as hex (verbosity 0), its header checked to hash to `hash` |
| `getChainTips()` | `ChainTip[]` (`height`, `hash`, `branchLen`, `status`); checks there is one `active` tip, the only one with `branchLen` 0 |
| `waitForNewBlock(waitMs, { currentTip? })`, `waitForBlockHeight(height, waitMs)` | `BlockRef` (`hash`, `height`), the tip; see [long polls](reading-the-chain.md#long-polls) |
| `getRawTransaction(txid, { blockHash? })` | hex, checked to hash to `txid` |
| `getRawTransactionVerbose(txid, { blockHash? })` | `DecodedTransaction`, output values as `valueBits` |
| `getMempoolInfo()` | `MempoolInfo`; the fee floor is `mempoolMinFeeBitsPerKvB` |
| `getRawMempool()` | the txids in the mempool |
| `getRawMempoolVerbose()` | `Record<txid, MempoolEntry>`; see [large replies](reading-the-chain.md#large-replies) |
| `getRawMempoolSequence()` | `MempoolSnapshot`: `txids` and `mempoolSequence`, a `bigint` as in the ZMQ `sequence` topic |
| `getTxSpendingPrevout(outputs)` | `TxSpendingPrevout[]`, one per output in order, checked against them: `spendingTxid` names the mempool transaction spending it, absent otherwise. An output spent in a block looks unspent |
| `getMempoolEntry(txid)` | `MempoolEntry`: sizes, `depends`, `spentBy`, fees as `baseBits` and so on; `RpcError` -5 when not in the mempool |
| `getTxOut(txid, vout, { includeMempool? })` | `TxOut` with `valueBits` and `coinbase`, or `null` when spent or unknown; `vout` 0 to 4,294,967,295 |
| `getConfirmationTarget(valueBits, { securityLevel?, mergeMiningPct?, btcHashrate? })` | `ConfirmationTarget` (the node's float `value_qbt` echo is dropped) |
| `estimateSmartFee(confTarget, { mode? })` | `{ feeRateBitsPerKvB?, errors?, blocks }` |
| `validateAddress(address)` | `AddressValidation`, a union on `isValid` |
| `verifyDataPqcHash(proof)` | `DataPqcHashVerification`; takes a `signDataPqcHash()` result as it is |
| `getDescriptorInfo(descriptor)` | `DescriptorInfo`: the canonical form, without private keys, and `checksum`, checked against the descriptor; see [descriptors](wallet-admin.md#descriptors) |
| `deriveAddresses(descriptor, { range? })` | the addresses, one per index of `range`; see [descriptors](wallet-admin.md#descriptors) |
| `testMempoolAccept(rawTxs, { maxFeeRateBitsPerKvB? })` | one `MempoolAcceptance` per transaction, checked against each hex's txid; see [fee-rate caps](payments.md#fee-rate-caps) |
| `sendRawTransaction(hex, { maxFeeRateBitsPerKvB?, maxBurnAmountBits? })` | txid, checked against the hex; see [fee-rate caps](payments.md#fee-rate-caps) |
| `submitPackage(rawTxs, { maxFeeRateBitsPerKvB?, maxBurnAmountBits? })` | `PackageSubmission`; see [submitting a package](payments.md#submitting-a-package-cpfp) |
| `getMiningInfo()` | `MiningInfo`; `blockMinTxFeeBitsPerKvB`, and `next`, the next block's candidate |
| `getBlockTemplate({ rules?, capabilities? })` | `BlockTemplate`; `coinbaseValueBits`, each transaction's `feeBits`; see [mining](mining.md) |
| `checkBlockProposal(blockHex)` | `BlockSubmissionResult`: null, or the reason; see [mining](mining.md) |
| `submitBlock(blockHex)` | `BlockSubmissionResult`: null, or the reason; see [mining](mining.md) |
| `createAuxBlock(payoutAddress)` | `AuxBlock`; see [merge mining](mining.md#merge-mining-auxpow) |
| `submitAuxBlock(blockHash, auxpowHex)` | `BlockSubmissionResult`: null, or the reason; see [merge mining](mining.md#merge-mining-auxpow) |
| `getWalletInfo()` | `WalletInfo`, including `pqcKeyValidation` |
| `getTransaction(txid)` | `WalletTransaction`; signed `amountBits` and `feeBits` |
| `listUnspent(options?)` | `UnspentOutput[]` |
| `getAddressInfo(address)` | `AddressInfo` with the PQC usage fields; checks the address, ignoring case only for bech32 and bech32m |
| `listLockUnspent()` | `Outpoint[]` (`{ txid, vout }`) |
| `listSinceBlock({ blockHash?, targetConfirmations?, includeWatchOnly?, includeRemoved?, includeChange? })` | `SinceBlockHistory`: `transactions`, `removed`, `lastBlock`; `RpcError` -5 for an unknown block |
| `listTransactions({ label?, count?, skip?, includeWatchOnly? })` | `WalletHistoryEntry[]`, the newest `count` (default 10), oldest first |
| `getBalances()` | `WalletBalances`: `mine` (`trustedBits`, `untrustedPendingBits`, `immatureBits`, `usedBits?`) and `lastProcessedBlock` |
| `walletCreateFundedPsbt({ inputs?, outputs, locktime?, options?, bip32derivs?, version? })` | `{ psbt, feeBits, changePos }` |
| `walletProcessPsbt(psbt, { sign?, sighashType?, bip32derivs?, finalize?, pqcCheck? })` | `ProcessedPsbt` with the PQC usage fields; when it signs, after `checkPqcSigning` passes (`pqcCheck: false` skips it, unsafe), under one deadline |
| `checkPqcSigning(psbt)` | `PqcSigningPlan`: the signatures signing takes from each of the wallet's PQC keys, or `PqcSigningError`; see [checking PQC keys before signing](payments.md#checking-pqc-keys-before-signing) |
| `finalizePsbt(psbt, { extract? })` | `{ psbt?, hex?, complete }` |
| `psbtBumpFee(txid, { feeRateBitsPerKvB?, confTarget?, estimateMode?, replaceable?, outputs?, originalChangeIndex? })` | `BumpedPsbt`: `{ psbt, originalFeeBits, feeBits, errors }`, the PSBT unsigned |
| `walletPassphrase(passphrase, timeoutSeconds)`, `walletLock()` | nothing; see [unlocking a wallet](wallet.md#unlocking-an-encrypted-wallet) |
| `getRawChangeAddress({ addressType? })` | a new change address; see [address types](wallet.md#address-types) |
| `getNewAddress({ label?, addressType? })` | a new receiving address, filed under `label` |
| `lockUnspent(outputs, { persistent? })` | nothing, once every output is locked |
| `unlockUnspent(outputs)` | nothing, once every output is unlocked |
| `signDataPqcHash(address, messageHash, { pubkey?, leafScript?, controlBlock?, includePqcUsage? })` | `DataPqcHashSignature`, the proof and what was signed, checked against the request; see [signing a data hash](wallet.md#signing-a-data-hash) |
| `createWallet(name, { disablePrivateKeys?, blank?, passphrase?, avoidReuse?, loadOnStartup? })`, `loadWallet(name, { loadOnStartup? })` | `LoadedWallet` (`name`, checked, and `warnings`); see [wallet administration](wallet-admin.md) |
| `unloadWallet(name, { loadOnStartup? })` | `UnloadedWallet` (`warnings`) |
| `listWalletDir()` | `WalletDirEntry[]` (`name`, `warnings`) |
| `importDescriptors(descriptors)` | one `DescriptorImportResult` per descriptor, in order |
| `rescanBlockchain({ startHeight?, stopHeight? })` | `RescanResult` (`startHeight`, `stopHeight`), checked against the heights asked for |
| `backupWallet(destination)`, `walletPassphraseChange(oldPassphrase, newPassphrase)`, `keypoolRefill({ newSize? })` | nothing |

`AddressInfo` and `ProcessedPsbt` carry qbit Core's PQC signature-budget
fields: for the keys of one of the wallet's addresses (`getaddressinfo`, absent
for other addresses), or for the local keys that signed (`walletprocesspsbt`).
They are `pqcKeyStates` (per key: `pubkey`, `pqcSignatureCount`,
`pqcSignatureLimit`, `pqcSignaturesRemaining`, `pqcLimitState`),
`pqcOverallLimitState`, and the four single-key fields when exactly one key is
involved; `ProcessedPsbt` adds `warnings`. `pqcLimitState` is `normal`,
`warning`, `critical` or `exhausted`, or a state a later qbit Core adds, passed
through as it is: treat a state you do not know as at least `critical`. A key's
limit is 2^30 signatures. qbit Core v1.0.0's `getwalletinfo` does not report
these counts. What each state means and what to do:
[PQC signature budgets](wallet.md#pqc-signature-budgets).

`lockUnspent(outputs)` locks outputs against automatic coin selection and
`unlockUnspent(outputs)` unlocks them, both through qbit Core's `lockunspent`.
A lock lives in memory and is gone after a node restart, unless it was made
with `lockUnspent(outputs, { persistent: true })`: then it is written to the
wallet and loaded again when the node starts. Locking an output that is locked
already is refused, except with `persistent`, which locks it again,
persistently. `unlockUnspent` takes no `persistent` (qbit Core ignores it
there) and clears either kind of lock. The node checks every output first: one
that is unknown, spent, already locked (locking) or not locked (unlocking)
rejects the whole call with `RpcError` -8 and changes nothing. Both resolve with
nothing once every output is done; qbit Core answers `true` or an error, and any
other reply fails validation. `outputs` must not be empty: qbit Core reads an
empty list as "do nothing", and a left-out one as "unlock everything", which is
`call('lockunspent', [true])`. `vout` is 0 to 2,147,483,647: qbit Core reads it
as a signed 32-bit integer here. `getRawChangeAddress` takes a key from the
change keypool. All three are side-effecting wallet-write calls.

`getNewAddress` takes a key from the receiving keypool and files the address
under `label` (the default label, `''`, when left out; `*` is refused before
sending, as qbit Core reserves it). It is side-effecting too: never retried,
and a lost reply is an `RpcUnknownOutcomeError`, since a second call would hand
out a second address.

## Arguments and options

Arguments are checked before sending; invalid ones reject with `TypeError` or
`RangeError` and nothing is sent. A number argument of `-0` is sent as `0`.
Integer arguments take the range qbit Core v1.0.0 reads them in, so a value the
node would refuse is refused first and every value it takes gets through:
`getTxOut`'s `vout` is 0 to 4,294,967,295 (an unsigned 32-bit integer), an
input's `vout` in `walletCreateFundedPsbt` and an output's in `lockUnspent` and
`unlockUnspent` 0 to 2,147,483,647 (a signed one), `walletCreateFundedPsbt`'s
`version` 1 to 3 (the standard versions) and `options.maxTxWeight` 65 to
400,000 (the standard weight limits). Where the node's limit depends on its
state (a height above the tip, an output index past the outputs), the node
answers. Options are strict: each options or arguments object, at every level
(`args`, `inputs`, `outputs`, `options`, `proof`, and the call options), takes
only the keys documented for it. Any other key rejects with
a `TypeError` that names it and, for the node's spelling or a near miss, the key
to use (`subtract_fee_from_outputs` → `subtractFeeFromOutputs`, `fee_rate` →
`feeRateBitsPerKvB`, `minconf` → `minConf`), and the unit when it differs
(`fee_rate` is bits/vB, `feeRateBitsPerKvB` bits per 1,000 vbytes). Each object
is read from its own enumerable properties only, each once, so a getter on the
object itself runs once. A key it takes that the object holds any other way
(inherited, a class getter, not enumerable, on a polluted `Object.prototype`,
left out of the keys a `Proxy` lists, or answered only by its `get` trap)
rejects with a `TypeError` that names it and says to pass a plain object: copy
a class instance's values into one. An unknown key only on `Object.prototype` is
skipped, as its value is never read, and an object left out reads as empty
whatever `Object.prototype` holds. Arrays are read by their own elements: a hole
rejects with a `TypeError` naming its index. Where an outpoint is expected (`lockUnspent` outputs,
`walletCreateFundedPsbt` inputs), the other fields of a typed result that is
also an outpoint (a `listUnspent()`, `listSinceBlock()` or `listTransactions()`
entry, or a decoded transaction input) are allowed and ignored. Only `txid`,
`vout` and, for an input, `sequence` are read, so a decoded input passed to
`walletCreateFundedPsbt` keeps its own sequence number. TypeScript catches
unknown keys only in object literals, not in spread objects or options read from
configuration.

## `call()` parameters

`call()` passes its parameters through unchecked, serialized once, from their
own data, when the request is built: an array hole rejects with a `TypeError`, a
`toJSON` on `Object.prototype` or `Array.prototype` never applies, and a
`bigint` is always an integer literal. A `requests.raw()` request holds its
`params` as they are sent, parsed back without loss (every number a
`JsonNumber`, every object without a prototype), so a `toJSON` or a getter in
them runs once. A request body nests at most 512 arrays and objects, as deep as
qbit Core v1.0.0 parses, its envelope included: the request object is one level,
so `call()`'s params, the params array included, nest at most 511, and a batch's
array is one more, so a `batch()` entry's nest at most 510. Deeper parameters are
a `TypeError` before anything is sent, where the node would answer HTTP 500
`Parse error`: `requests.raw()` refuses more than 511, and `batch()` more than
510, naming the entry.
There is one exception to passing them through unchecked: when it sends the
call, the client refuses options that qbit Core v1.0.0 accepts and then
ignores, read from the request body as it is sent:
`walletcreatefundedpsbt`'s `subtract_fee_from_outputs` (the node reads
`subtractFeeFromOutputs`; with the other name the wallet pays the fee), and
`signdatapqchash`'s camel-case option names.
`psbtbumpfee` has none: qbit Core refuses every option key it does not read.

## Batches

```ts
import { requests } from '@qbit-oss/rpc'

const [a, b] = await rpc.batch([requests.getBlockHash(100), requests.getBlockHeader(hash)])
if (a.ok) console.log(a.value)
else console.error(a.error) // RpcError or RpcResponseError for this entry only
```

Batches carry read and wallet-read methods only (up to 1,000), `extraMethods`
entries included, sent as one
JSON-RPC request and matched to replies by id. Each entry reports success or
its own error. A missing reply for an entry is that entry's `RpcResponseError`;
an unknown or repeated id, a malformed reply item, a non-array reply, a
transport failure, a timeout or an oversized reply rejects the whole batch. `requests.raw(method, params)`
adds an untyped entry.

An entry is any `RpcRequest`, so you can write your own `parse`. The entries
are read by their own elements, and each entry's `method`, `params`, `parse`
and `waitMs` (a long poll's, which a batch refuses) once, as its own
enumerable properties: a hole, or one of these held any other
way (a class's `parse` method, a key on a polluted `Object.prototype`), rejects
with a `TypeError` before anything is sent, and so does a `method` that is not a
non-empty primitive string (a `String` object, or an object with `toJSON`), so
the method the capability check sees is the one sent. So does `params` that is
sent as anything but an array, as `call()` also refuses: named params would
get past the checks and the redaction of the node's messages. Left out, it
sends none. The `parse` runs
synchronously and may throw anything: whatever it throws fails that entry with
`RpcResponseError` (`reason: 'validation'`, `path: 'result'`), with the thrown
value as `cause`, and the other entries are unaffected. The same holds on every
other path that takes an `RpcRequest`, where a side-effecting call's failure
arrives as the `cause` of an `RpcUnknownOutcomeError`, since the node has acted.

## Checking an interface of your own: `ClientSatisfies`

A package that takes a qbit Core client often declares the calls it makes as an
interface of its own, so that its declarations need not name this package and
its tests can pass a fake: `qbit-payments`' `CoreRpc` and `qbit-game-kit`'s
`PayoutRpc` are two. `QbitRpcClient` has to go on fitting such a copy, and a
plain assignment (`const rpc: CoreRpc = client`) cannot tell: TypeScript
compares methods bivariantly, and an object with more properties is assignable
to one with fewer. So a copy that declares the call options inside a method's
own options, `getTxOut(txid, vout, options?: { includeMempool?: boolean } &
CallOptions)`, type-checks, and the client refuses `timeoutMs` there with a
`TypeError`.

`ClientSatisfies<Copy>` is `true` when the client fits `Copy`, and otherwise an
object naming each member of `Copy` that does not, with why. Check it in the
type tests your CI compiles, so that a change on either side that breaks the
fit fails there. Below, the first interface fits; the second declares the call
options inside `getTxOut`'s own options, and its check fails with error TS1360,
`Type 'boolean' does not satisfy the expected type '{ getTxOut: "parameters"; }'`:

```ts
import type { CallOptions, ClientSatisfies, TxOut } from '@qbit-oss/rpc'

// The calls a package makes, declared on its side.
interface CoreRpc {
  getBlockCount(callOptions?: CallOptions): Promise<number>
  getTxOut(
    txid: string,
    vout: number,
    options?: { includeMempool?: boolean },
    callOptions?: CallOptions
  ): Promise<TxOut | null>
}
true satisfies ClientSatisfies<CoreRpc>

interface Drifted {
  getTxOut(txid: string, vout: number, options?: { includeMempool?: boolean } & CallOptions): Promise<TxOut | null>
}
// @ts-expect-error TS1360: { getTxOut: 'parameters' }
true satisfies ClientSatisfies<Drifted>
```

| Reason | The member |
| --- | --- |
| `missing` | The client has no such member. A member optional in the copy (`confirmChain?()`) may be missing: check `ClientSatisfies<Required<Copy>>` to require it. |
| `returns` | What the client's method returns is not assignable to what the copy's returns. The copy may read fewer fields, but an open enum needs its `(string & {})`, as for `PqcLimitState` (see [values a later qbit Core may add](versions.md)). |
| `parameters` | The copy allows arguments the client does not take. They are compared both ways: the copy's arguments must be assignable to the client's parameters, compared strictly rather than bivariantly, and may hold no key, at any depth, that the client does not declare there (the type `UndeclaredKeys` lists them). The copy may take fewer arguments, or narrower values, such as `sighashType?: 'DEFAULT'`, or `options?: undefined` to pass call options alone. |
| `type` | A member that is not a method has a type the client's is not assignable to, or one of the two is a method and the other is not. |

Parameters are compared position by position, and a tuple argument element by element against an array parameter. Against a union, such as a funded PSBT's outputs, an argument passes only when one member it fits declares every key it can hold, so one output with both `address` and `data` is reported, optional or not. A key that can only be `undefined`, as in the exclusive-or form `{ address; amountBits; data?: never } | { data; address?: never; amountBits?: never }`, counts as declared when any member declares it. Options typed `object` or `{}` are reported too, as they let any key through. A branded primitive (`string & { __brand: 'Txid' }`) fits where the client takes the primitive.

**Limits, where TypeScript gives the type nothing to compare:**
- **Overloads:** only the last signature of an overloaded member is checked. Declare one signature per member.
- **Generic methods:** a generic signature is compared at its constraints. A copy's generic method can pass where a call through it would not, and a copy that specializes the client's generic `batch` reports `returns`. Declare copies without type parameters.
- **Outpoints:** `lockUnspent` and `unlockUnspent` accept a typed result with its extra fields at run time, but declare `{ txid, vout }`. A copy that declares the extras reports `parameters`: declare `{ txid, vout }` too.

`tsc` shortens a long type in its messages: set `"noErrorTruncation": true` in
the tsconfig of the type tests to see every member. The check runs whenever
your CI does, against the version of this package you install, so a change
here reaches it when you update; to hear of one sooner, also run it on a
schedule against a build of this repository's `main`. It checks types only:
how the copy is used is out of its sight, such as reading a node's error code
from `rpcCode` (see [Errors](errors.md)).
