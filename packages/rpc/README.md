# @qbit-oss/rpc

> **Unaudited MVP**, not published to npm. See the [repository README](../../README.md).

A Node.js JSON-RPC client for qbit Core (`qbitd`) v1.0.0. No runtime
dependencies.

```ts
import { QbitRpcClient } from '@qbit-oss/rpc'

const rpc = new QbitRpcClient({
  url: 'http://127.0.0.1:48352/', // testnet4
  auth: { cookieFile: '/home/qbit/.qbit/testnet4/.cookie' },
  expectedChain: 'testnet4',
})
const info = await rpc.getBlockchainInfo()
```

## Client options

| Option | Default | Notes |
| --- | --- | --- |
| `url` | required | `http://` only for a loopback host (`localhost`, `127.0.0.0/8`, `::1`); anything else must be `https://`. No credentials, query or fragment in the URL. The path may name a wallet (`/wallet/<name>`). |
| `wallet` | none | Sends every call to `/wallet/<name>` (URL-encoded). Needed for wallet calls when several wallets are loaded. |
| `auth` | required | `{ username, password }` (HTTP Basic), or `{ cookieFile }` for a loopback endpoint only. The cookie is read again for every request, so `qbitd` can restart and rotate it. |
| `expectedChain` | required | `main`, `test`, `testnet4`, `signet` or `regtest`. |
| `capabilities` | `[]` | Any of `wallet-read`, `wallet-write`, `broadcast`. |
| `timeoutMs` | 30,000 | One deadline per operation: any wait for a request slot, cookie read, every attempt and every backoff. Override per call. |
| `maxResponseBytes` | 16 MiB | Larger replies fail with `RpcResponseTooLargeError` (or an unknown outcome for side-effecting calls). |
| `readRetries` | 0 | Opt-in retries for methods without side effects (see below). |
| `retryDelayMs` | 250 | First backoff; doubles per retry, capped at 10 s, never past the deadline. |
| `chainCheckMaxAgeMs` | 10,000 | How long a chain confirmation stays fresh before a wallet-write or broadcast call re-checks it. 0 re-checks before every such call. |
| `maxConcurrentRequests` | 8 | Most requests this client has open at once, on pooled and fresh connections alike (1 to 1,024); it also sizes the keep-alive pool. Further attempts wait in FIFO order under their deadline. See [the work queue](#the-work-queue). |
| `directNode` | `false` | Set when `url` reaches `qbitd` itself. `qbitd`'s HTTP 503 `Work queue depth exceeded` is then a definite failure, not an unknown outcome. Opt-in, because a proxy in between can answer 503 after forwarding the request. See [the work queue](#the-work-queue). |

Every call also takes `{ signal?: AbortSignal, timeoutMs?: number }`.

## Capabilities and the allowlist

Every method, typed or through `call()`, must be on the allowlist
(`METHOD_POLICIES`), and its capability must be enabled. A refused call throws
`RpcCapabilityError` before any request is made.

| Capability | Methods |
| --- | --- |
| none (read) | `getblockchaininfo`, `getnetworkinfo`, `getbestblockhash`, `getblockcount`, `getblockhash`, `getblockheader`, `getrawtransaction`, `getmempoolentry`, `gettxout`, `getconfirmationtarget`, `estimatesmartfee`, `validateaddress`, `verifydatapqchash`; untyped: `getblock`, `getchaintips`, `getmempoolinfo`, `getrawmempool`, `decoderawtransaction`, `decodepsbt`, `analyzepsbt`, `getorphanmetrics`, `getarchivepeers`, `getindexinfo`, `getzmqnotifications`, `uptime` |
| `wallet-read` | `getwalletinfo`, `gettransaction`, `listunspent`, `getaddressinfo`, `listlockunspent`, `listsinceblock`, `listtransactions`, `getbalances`; untyped: `listwallets` |
| `wallet-write` | `walletcreatefundedpsbt`, `walletprocesspsbt`, `finalizepsbt`, `walletpassphrase`, `walletlock`, `getrawchangeaddress`, `lockunspent`, `getnewaddress` |
| `broadcast` | `testmempoolaccept`, `sendrawtransaction` |

`sendmany`, `sendtoaddress`, `send`, `sendall`, `bumpfee` and `psbtbumpfee` are
not allowlisted: they sign and broadcast in one step, so you cannot store the
signed transaction before it leaves the node. `finalizepsbt` and
`testmempoolaccept` change nothing, but are gated with the steps they belong to.

### Chain guard

`wallet-write` and `broadcast` calls also need `await rpc.confirmChain()`,
which compares `getblockchaininfo.chain` with `expectedChain`. Until it has
matched, or after a check found another chain, they throw `RpcChainGuardError`
(`reason: 'unconfirmed'` or `'mismatch'`) without sending anything.

A confirmation goes stale after `chainCheckMaxAgeMs` (default 10 s), and at
once on a connection error (including a reset keep-alive connection whose read
then succeeded on another attempt), an HTTP 401, or a changed cookie (qbitd
writes a new one each time it starts). A wallet-write or broadcast call made
while it is stale first runs `getblockchaininfo` again, under the call's own
deadline. If that check fails, the call fails without being sent (a plain
error, never an unknown outcome; the error names `getblockchaininfo`). If it
finds another chain, the call is refused and so is every later one until
`confirmChain()` matches again. `rpc.chainStatus` is `unconfirmed`,
`confirmed`, `stale` or `mismatch`.

The guard decides after a call's last wait, as it hands the request to the
transport: a mismatch recorded by another check while the call read its
cookie, ran its re-check or waited between re-checks still refuses it. (Once handed over, the request is
sent; nothing recorded after that can recall it.) A guarded call reads the
cookie once per attempt and sends its re-check and itself with that header: a
confirmation counts only for calls with the cookie it was made with, and if
qbitd restarts after the read, the node rejects the call with HTTP 401 instead
of running it.

A check whose answer arrives after a connection error or an HTTP 401 on any
call may predate it, so it changes nothing: the guarded call (or
`confirmChain()`) waits `retryDelayMs` (at most 10 s, and never past the
deadline) and checks again, up to three checks
per attempt, and then fails with `RpcChainGuardError` `reason: 'stale'`,
nothing sent; try again later. So `confirmChain()` resolves only once a check
made with the cookie it read confirmed the chain, and an unconfirmed client
stays refused until then. An answer reporting another chain always stands:
only a `confirmChain()` begun after it can clear it, and one that sees a
mismatch recorded while it runs throws it.

The check and the call are separate requests. Behind a load balancer or DNS
name that can switch nodes, they can reach different nodes: point the client
at one node.

## Typed methods

Results are validated field by field (hashes, hex, integer ranges, enums,
amounts) and returned with camelCase names; fields the node adds beyond these
are dropped (use `call()` for the raw reply). A result that does not validate
throws `RpcResponseError` with `reason: 'validation'` and the `path` of the
offending value.

| Method | Returns |
| --- | --- |
| `getBlockchainInfo()` | `BlockchainInfo`, including `p2mrValidationWeight` and `futureBlockTime` |
| `getNetworkInfo()` | `NetworkInfo`; `relayFeeBitsPerKvB`, `incrementalFeeBitsPerKvB` |
| `getBestBlockHash()`, `getBlockHash(height)` | block hash |
| `getBlockCount()` | the tip's height |
| `getBlockHeader(hash)` | `BlockHeader`; checks the hash, `versionHex` and genesis linkage |
| `getRawTransaction(txid, { blockHash? })` | hex |
| `getRawTransactionVerbose(txid, { blockHash? })` | `DecodedTransaction`, output values as `valueBits` |
| `getMempoolEntry(txid)` | `MempoolEntry`: sizes, `depends`, `spentBy`, fees as `baseBits` and so on; `RpcError` -5 when not in the mempool |
| `getTxOut(txid, vout, { includeMempool? })` | `TxOut` with `valueBits` and `coinbase`, or `null` when spent or unknown |
| `getConfirmationTarget(valueBits, { securityLevel?, mergeMiningPct?, btcHashrate? })` | `ConfirmationTarget` (the node's float `value_qbt` echo is dropped) |
| `estimateSmartFee(confTarget, { mode? })` | `{ feeRateBitsPerKvB?, errors?, blocks }` |
| `validateAddress(address)` | `AddressValidation`, a union on `isValid` |
| `verifyDataPqcHash(proof)` | `DataPqcHashVerification` |
| `testMempoolAccept(rawTxs, { maxFeeRateBitsPerKvB? })` | one `MempoolAcceptance` per transaction, checked against each hex's txid |
| `sendRawTransaction(hex, { maxFeeRateBitsPerKvB?, maxBurnAmountBits? })` | txid, checked against the hex |
| `getWalletInfo()` | `WalletInfo`, including `pqcKeyValidation` |
| `getTransaction(txid)` | `WalletTransaction`; signed `amountBits` and `feeBits` |
| `listUnspent(options?)` | `UnspentOutput[]` |
| `getAddressInfo(address)` | `AddressInfo` with the PQC usage fields; checks the address |
| `listLockUnspent()` | `Outpoint[]` (`{ txid, vout }`) |
| `listSinceBlock({ blockHash?, targetConfirmations?, includeWatchOnly?, includeRemoved?, includeChange? })` | `SinceBlockHistory`: `transactions`, `removed`, `lastBlock`; `RpcError` -5 for an unknown block |
| `listTransactions({ label?, count?, skip?, includeWatchOnly? })` | `WalletHistoryEntry[]`, the newest `count` (default 10), oldest first |
| `getBalances()` | `WalletBalances`: `mine` (`trustedBits`, `untrustedPendingBits`, `immatureBits`, `usedBits?`) and `lastProcessedBlock` |
| `walletCreateFundedPsbt({ inputs?, outputs, locktime?, options?, bip32derivs?, version? })` | `{ psbt, feeBits, changePos }` |
| `walletProcessPsbt(psbt, { sign?, sighashType?, bip32derivs?, finalize? })` | `ProcessedPsbt` with the PQC usage fields |
| `finalizePsbt(psbt, { extract? })` | `{ psbt?, hex?, complete }` |
| `walletPassphrase(passphrase, timeoutSeconds)`, `walletLock()` | nothing |
| `getRawChangeAddress({ addressType? })` | a new change address |
| `getNewAddress({ label?, addressType? })` | a new receiving address, filed under `label` |
| `lockUnspent(unlock, outputs, { persistent? })` | `true` |

`AddressInfo` and `ProcessedPsbt` carry qbit Core's PQC signature-budget
fields: for the keys of one of the wallet's addresses (`getaddressinfo`, absent
for other addresses), or for the local keys that signed (`walletprocesspsbt`).
They are `pqcKeyStates` (per key: `pubkey`, `pqcSignatureCount`,
`pqcSignatureLimit`, `pqcSignaturesRemaining`, `pqcLimitState`),
`pqcOverallLimitState`, and the four single-key fields when exactly one key is
involved; `ProcessedPsbt` adds `warnings`. `pqcLimitState` is `normal`,
`warning`, `critical` or `exhausted`. A key's limit is 2^30 signatures. qbit
Core v1.0.0's `getwalletinfo` does not report these counts.

`lockUnspent(false, outputs)` locks outputs against automatic coin selection
and `lockUnspent(true, outputs)` unlocks them. The locks live in memory and
are gone after a node restart unless `persistent: true` is passed when
locking. The node checks every output first: one that is unknown, spent,
already locked (locking) or not locked (unlocking) rejects the whole call with
`RpcError` -8 and changes nothing. `outputs` must not be empty, since qbit Core
reads an empty list as "do nothing"; to unlock everything, use
`call('lockunspent', [true])`. `getRawChangeAddress` takes a key from the
change keypool. Both are side-effecting wallet-write calls.

`getNewAddress` takes a key from the receiving keypool and files the address
under `label` (the default label, `''`, when left out; `*` is refused before
sending, as qbit Core reserves it). It is side-effecting too: never retried,
and a lost reply is an `RpcUnknownOutcomeError`, since a second call would hand
out a second address.

### Wallet history

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
`confirmations`. A replaced transaction's entries have `replacedByTxid`, and its
replacement is listed too, so skip those as well.

`listTransactions` lists the newest `count` entries after skipping the newest
`skip`, without change outputs. A `label` keeps incoming entries paying to that
label; `*` lists everything, and qbit Core refuses `''`, so the client does.
`count + skip` must be at most 2,147,483,647, as qbit Core adds them as 32-bit
integers.

`getBalances` reports `mine` in bits. `usedBits` is present only for a wallet
with `avoid_reuse` set, where `0n` is a real zero. qbit Core v1.0.0 has no
`watchonly` section: a wallet without private keys reports what it watches
under `mine`. `lastProcessedBlock` is the block the balances were computed at.

`QbitRpcClient` satisfies the `CoreRpc` interface of the qbit Core wallet
adapter in `qbit-payments` with no wrapper (`test/core-rpc.test.ts` checks a
copy of it). Scope the client to the wallet (`wallet`), enable `wallet-read`,
`wallet-write` and `broadcast`, and call `confirmChain()` before handing it
over.

Arguments are checked before sending; invalid ones reject with `TypeError` or
`RangeError` and nothing is sent. Options are strict: each options or
arguments object, at every level (`args`, `inputs`, `outputs`, `options`,
`proof`, and the call options `signal` and `timeoutMs`), takes only the keys
documented for it. Any other key rejects with a `TypeError` that names it and,
for the node's spelling or a near miss, the key to use
(`subtract_fee_from_outputs` → `subtractFeeFromOutputs`, `fee_rate` →
`feeRateBitsPerKvB`, `minconf` → `minConf`), and the unit when it differs
(`fee_rate` is bits/vB, `feeRateBitsPerKvB` bits per 1,000 vbytes). Inherited
keys count as the object's own, except keys on `Object.prototype` itself, which
no caller set. Where an outpoint is expected (`lockUnspent` outputs,
`walletCreateFundedPsbt` inputs), the other fields of a typed result that is
also an outpoint (a `listUnspent()`, `listSinceBlock()` or `listTransactions()`
entry, or a decoded transaction input) are allowed and ignored. Only `txid`,
`vout` and, for an input, `sequence` are read, so a decoded input passed to
`walletCreateFundedPsbt` keeps its own sequence number. TypeScript catches
unknown keys only in object literals, not in spread objects or options read
from configuration.

`call()` passes its parameters through unchecked, with one exception: it
refuses `walletcreatefundedpsbt` options, as they are serialized, that qbit
Core v1.0.0 accepts and then ignores, so far `subtract_fee_from_outputs` (the node reads
`subtractFeeFromOutputs`; with the other name the wallet pays the fee).

## Amounts

No JS `number` carries money. Amounts are `bigint` bits (1 QBT = 100,000,000
bits; the 210,000,000 QBT cap is 2.1e16 bits, above 2^53). Fee rates are
`bigint` bits per 1,000 vbytes, qbit Core's `CFeeRate` unit: `1_000n` is
1 bit/vB.

- Replies are parsed from their source text, so `90071992.54740993` QBT becomes
  exactly `9007199254740993n`. Amounts with more than 8 decimals, negative
  amounts where the field cannot be negative, exponents and values above the
  cap fail validation.
- Outgoing amounts must be `bigint`s from 0 to the cap and are written as exact
  decimal JSON numbers (`0.00000001`). Numbers, `NaN`, `Infinity`, negative or
  oversized values are refused before sending.
- `parseQbt(text)` and `formatQbt(bits)` convert at your boundaries.
- `call()` returns every JSON number as a `JsonNumber`: use `toBits()`,
  `toBigInt()`, `toSafeInteger()` or `toNumber()`. Arithmetic on it throws.
  Pass amounts to `call()` as `formatQbt(bits)` strings, which qbit Core
  accepts, and large integers as `bigint`.

## Failure model

| Situation | Read methods | Side-effecting methods (`sendrawtransaction`, wallet-write except `finalizepsbt`) |
| --- | --- | --- |
| Refused locally (capability, allowlist, chain guard, bad argument) | throws, nothing sent | throws, nothing sent |
| Connection refused, DNS failure, TLS failure, cookie unreadable | `RpcTransportError` | `RpcTransportError` (provably not sent) |
| Node error object | `RpcError` | `RpcError` |
| HTTP 401/403/404 and other 3xx/4xx | `RpcTransportError` | `RpcTransportError` (rejected before execution) |
| Timeout or abort while waiting for a request slot | `RpcTimeoutError`, `RpcAbortedError` | `RpcTimeoutError`, `RpcAbortedError` (provably not sent) |
| HTTP 503 `Work queue depth exceeded` with `directNode` set | `RpcTransportError` | `RpcTransportError` (rejected before execution) |
| Timeout, abort, dropped connection, any other HTTP 5xx, malformed, invalid or oversized reply after the request was sent | the matching error | `RpcUnknownOutcomeError`, with that error as `cause` and, for `sendrawtransaction` (typed or through `call()`), the `txid` |

- **Retries** happen only for methods without side effects, only when
  `readRetries` is set (apart from the keep-alive retry below), and only for
  connection errors, HTTP 5xx, cookie read failures, HTTP 401 under cookie auth
  (the cookie may have rotated), and (single calls) RPC error -28 while the
  node warms up. Side-effecting calls are never retried.
- **Deadline.** `timeoutMs` covers the whole operation: any wait for a request
  slot, cookie read, every attempt, every backoff and every item of a batch. On
  expiry the request is destroyed and its socket released.
- **Keep-alive.** Methods without side effects, batches and the chain re-check
  share a pool of keep-alive connections sized to `maxConcurrentRequests`
  (default 8), plus one spare for a connection still closing; open requests
  stay within the limit. The client closes one after 15 s idle, before
  qbitd's `-rpcservertimeout` (30 s by default) does. With a
  `-rpcservertimeout` below 15 s qbitd closes idle connections first, and the
  race below happens more often: each one costs an extra attempt and a chain
  re-check. A request written to a connection just as qbitd closes it is reset
  before any reply. A request without side effects that is reset this way
  (`ECONNRESET` or `EPIPE` on a reused connection, within 1 s of going out
  and before any byte of the reply) gets one more attempt at once, under the
  same deadline, even with `readRetries: 0` and not counted in it, and the
  other idle connections are closed first. The reset makes the chain
  confirmation stale, since a qbitd restart looks the same, and the attempt
  takes the normal path: the cookie is read again, and `finalizepsbt` and
  `testmempoolaccept` re-check the chain before they are sent again. If it
  fails, its error is reported like any connection error. The chain re-check
  before a wallet-write or broadcast call gets the same extra attempt: the call
  itself has not been sent yet, and goes out once, after a check that succeeds.
  A later reset (the node failing during a request), any other error and a
  reply that began get no extra attempt, so a proxy in between is covered only
  if it closes idle connections silently: one that answers first (HTTP 408) is
  not retried.
- Side-effecting calls use a fresh connection each, so a stale keep-alive
  socket cannot turn into an unknown outcome, and are never sent twice.
- A wallet `RpcError` means the node answered with an error. For
  `walletprocesspsbt`, qbit Core may still have advanced the PQC signature
  counters of keys it tried.

### The work queue

`qbitd` hands each HTTP request to one of its `-rpcthreads` workers (default 16)
through a queue of `-rpcworkqueue` entries (default 64). A request that finds
the queue full is answered with HTTP 503 and the body `Work queue depth exceeded`
without being run, and `debug.log` records the rejection.

**Avoiding it.** `maxConcurrentRequests` limits one client's open requests. Keep
the total over all clients of a node, plus anything else using its RPC port, at
or below `-rpcworkqueue`: that holds even when long calls occupy every worker.
At the defaults, eight clients fit. More `-rpcthreads` add throughput, not this
guarantee. Each attempt takes a slot before it does anything else and frees it
however it ends: a batch counts once, a chain re-check (and any pause before
checking again) runs in its call's slot, the extra attempt after a stale
keep-alive connection keeps the slot, and a retry queues again after its
backoff.

A hung request holds its slot until its deadline, so calls behind it wait and
can time out without being sent. A request abandoned at its deadline frees its
slot at once, but `qbitd` may still hold it, so after timeouts the node can see
more than the limit.

**Classifying it.** By default that 503 is treated like any other 5xx: an unknown
outcome for a side-effecting call, because a proxy in between can answer 503
after forwarding the request. Set `directNode` when nothing sits between the
client and `qbitd`: the exact body under HTTP 503 is then a plain
`RpcTransportError` (`reason: 'http_status'`, `status: 503`), retried under
`readRetries` for methods without side effects and never for side-effecting
ones. Any other body or status keeps the default classification.

## Batches

```ts
import { requests } from '@qbit-oss/rpc'

const [a, b] = await rpc.batch([requests.getBlockHash(100), requests.getBlockHeader(hash)])
if (a.ok) console.log(a.value)
else console.error(a.error) // RpcError or RpcResponseError for this entry only
```

Batches carry read and wallet-read methods only (up to 1,000), sent as one
JSON-RPC request and matched to replies by id. Each entry reports success or
its own error. A missing reply for an entry is that entry's `RpcResponseError`;
an unknown or repeated id, a malformed reply item, a non-array reply, a
transport failure, a timeout or an oversized reply rejects the whole batch. `requests.raw(method, params)`
adds an untyped entry.

## Secrets

Credentials live in private class fields. `JSON.stringify(client)` and
`util.inspect(client)` show only the URL, chain, capabilities, auth kind and
chain status. Messages and properties this package writes never include
credentials, cookie contents, request parameters or request bodies.
`RpcError.message` is the node's own text, which can quote an argument such as
an address or hash; qbit Core's `walletpassphrase` errors do not quote the
passphrase. The package does not log.
