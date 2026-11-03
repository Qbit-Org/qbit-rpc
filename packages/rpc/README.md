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
| `timeoutMs` | 30,000 | One deadline per operation: cookie read, every attempt and every backoff. Override per call. |
| `maxResponseBytes` | 16 MiB | Larger replies fail with `RpcResponseTooLargeError` (or an unknown outcome for side-effecting calls). |
| `readRetries` | 0 | Opt-in retries for methods without side effects (see below). |
| `retryDelayMs` | 250 | First backoff; doubles per retry, capped at 10 s, never past the deadline. |
| `chainCheckMaxAgeMs` | 10,000 | How long a chain confirmation stays fresh before a wallet-write or broadcast call re-checks it. 0 re-checks before every such call. |

Every call also takes `{ signal?: AbortSignal, timeoutMs?: number }`.

## Capabilities and the allowlist

Every method, typed or through `call()`, must be on the allowlist
(`METHOD_POLICIES`), and its capability must be enabled. A refused call throws
`RpcCapabilityError` before any request is made.

| Capability | Methods |
| --- | --- |
| none (read) | `getblockchaininfo`, `getnetworkinfo`, `getbestblockhash`, `getblockcount`, `getblockhash`, `getblockheader`, `getrawtransaction`, `getmempoolentry`, `gettxout`, `getconfirmationtarget`, `estimatesmartfee`, `validateaddress`, `verifydatapqchash`; untyped: `getblock`, `getchaintips`, `getmempoolinfo`, `getrawmempool`, `decoderawtransaction`, `decodepsbt`, `analyzepsbt`, `getorphanmetrics`, `getarchivepeers`, `getindexinfo`, `getzmqnotifications`, `uptime` |
| `wallet-read` | `getwalletinfo`, `gettransaction`, `listunspent`, `getaddressinfo`, `listlockunspent`; untyped: `getbalances`, `listtransactions`, `listsinceblock`, `listwallets` |
| `wallet-write` | `walletcreatefundedpsbt`, `walletprocesspsbt`, `finalizepsbt`, `walletpassphrase`, `walletlock`, `getrawchangeaddress`, `lockunspent`; untyped: `getnewaddress` |
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
once on a connection error, an HTTP 401, or a changed cookie (qbitd writes a
new one each time it starts). A wallet-write or broadcast call made while it is
stale first runs `getblockchaininfo` again, under the call's own deadline. If
that check fails, the call fails without being sent (a plain error, never an
unknown outcome; the error names `getblockchaininfo`). If it finds another
chain, the call is refused and so is every later one until `confirmChain()`
matches again. `rpc.chainStatus` is `unconfirmed`, `confirmed`, `stale` or
`mismatch`.

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
| `walletCreateFundedPsbt({ inputs?, outputs, locktime?, options?, bip32derivs?, version? })` | `{ psbt, feeBits, changePos }` |
| `walletProcessPsbt(psbt, { sign?, sighashType?, bip32derivs?, finalize? })` | `ProcessedPsbt` with the PQC usage fields |
| `finalizePsbt(psbt, { extract? })` | `{ psbt?, hex?, complete }` |
| `walletPassphrase(passphrase, timeoutSeconds)`, `walletLock()` | nothing |
| `getRawChangeAddress({ addressType? })` | a new change address |
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

`QbitRpcClient` satisfies the `CoreRpc` interface of the qbit Core wallet
adapter in `qbit-payments` with no wrapper (`test/core-rpc.test.ts` checks a
copy of it). Scope the client to the wallet (`wallet`), enable `wallet-read`,
`wallet-write` and `broadcast`, and call `confirmChain()` before handing it
over.

Arguments are checked before sending; invalid ones reject with `TypeError` or
`RangeError` and nothing is sent.

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
| Timeout, abort, dropped connection, HTTP 5xx, malformed, invalid or oversized reply after the request was sent | the matching error | `RpcUnknownOutcomeError`, with that error as `cause` and, for `sendrawtransaction` (typed or through `call()`), the `txid` |

- **Retries** happen only for methods without side effects, only when
  `readRetries` is set, and only for connection errors, HTTP 5xx, cookie read
  failures, HTTP 401 under cookie auth (the cookie may have rotated), and
  (single calls) RPC error -28 while the node warms up. Side-effecting calls are
  never retried.
- **Deadline.** `timeoutMs` covers the whole operation: cookie read, every
  attempt, every backoff and every item of a batch. On expiry the request is
  destroyed and its socket released.
- Side-effecting calls use a fresh connection, so a stale keep-alive socket
  cannot turn into an unknown outcome.
- A wallet `RpcError` means the node answered with an error. For
  `walletprocesspsbt`, qbit Core may still have advanced the PQC signature
  counters of keys it tried.

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
