# qbit-rpc

> **Unaudited MVP.** These packages have not had a security review, are not
> published to npm, and their API may change without notice. Try them on
> testnet4 or regtest. Do not point them at a mainnet wallet holding funds you
> cannot afford to lose.

Node.js clients for a qbit Core node you run: JSON-RPC (`@qbit-oss/rpc`) and
ZMQ notifications (`@qbit-oss/zmq`). They complement the official SDK:
[`@qbit-oss/api`](https://github.com/Qbit-Org/qbit-js/tree/main/packages/api)
talks to block explorers, not to `qbitd`. Nothing here is specific to one
application.

## Which package do I need?

- [`@qbit-oss/rpc`](packages/rpc/README.md) to read chain and wallet state from
  `qbitd`, fund and sign PSBTs with its wallet, and broadcast. Every method is
  allowlisted and gated by capabilities the client opts into, wallet-write and
  broadcast calls wait until the node's chain is confirmed, results are
  validated, and amounts are exact `bigint` bits. No runtime dependencies.
- [`@qbit-oss/zmq`](packages/zmq/README.md) to be woken by `qbitd`'s ZMQ
  notifications (new blocks, mempool changes) and told when you missed some. It
  depends on the native [`zeromq`](https://www.npmjs.com/package/zeromq) addon,
  which is why it is a separate package.
- A service that reacts to blocks usually wants both: ZMQ to wake up, RPC to
  read what changed.

## Install

The packages are not on npm (both are `0.0.0` and `"private": true`). Build and
pack them from this repository, then install the tarballs:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
(cd packages/rpc && npm pack)   # qbit-oss-rpc-0.0.0.tgz
(cd packages/zmq && npm pack)   # qbit-oss-zmq-0.0.0.tgz
npm install /path/to/qbit-oss-rpc-0.0.0.tgz /path/to/qbit-oss-zmq-0.0.0.tgz
```

Node.js 22.13+, 24 or 26+. Both packages ship CommonJS and ESM builds with
type declarations.

## Quick start

Pay out from a testnet4 wallet, saving the signed transaction before it is
broadcast:

```ts
import { QbitRpcClient, RpcUnknownOutcomeError } from '@qbit-oss/rpc'

const rpc = new QbitRpcClient({
  url: 'http://127.0.0.1:48352/',
  wallet: 'payouts',
  auth: { cookieFile: '/home/qbit/.qbit/testnet4/.cookie' },
  expectedChain: 'testnet4',
  capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
})

await rpc.confirmChain() // wallet-write and broadcast calls are refused until this matches

const funded = await rpc.walletCreateFundedPsbt({
  outputs: [{ address: 'tq1...', amountBits: 150_000_000n }], // 1.5 QBT
  options: { feeRateBitsPerKvB: 1_000n, changeType: 'p2mr' },
})
const signed = await rpc.walletProcessPsbt(funded.psbt)
if (!signed.complete || signed.hex === undefined) throw new Error('not fully signed')
if (signed.pqcOverallLimitState === 'critical' || signed.pqcOverallLimitState === 'exhausted') {
  // rotate keys before the signature budget runs out
}
await saveSignedTransaction(signed.hex) // your storage: persist before broadcasting

const [preflight] = await rpc.testMempoolAccept([signed.hex])
if (preflight?.allowed !== true) throw new Error(`rejected: ${preflight?.rejectReason}`)
try {
  const txid = await rpc.sendRawTransaction(signed.hex)
} catch (error) {
  if (RpcUnknownOutcomeError.is(error)) {
    // The node may have relayed it. Look it up by error.txid; resubmitting the
    // same hex is harmless. Never rebuild the payment with new inputs.
  }
  throw error
}
```

Wake up on new blocks:

```ts
import { QbitZmqSubscriber } from '@qbit-oss/zmq'

const zmq = new QbitZmqSubscriber({ url: 'tcp://127.0.0.1:28332', topics: ['hashblock'] })
for await (const event of zmq) {
  if (event.kind === 'gap') await reconcileOverRpc() // messages were lost
  if (event.kind === 'message' && event.message.topic === 'hashblock') await onBlock(event.message.hash)
}
```

## Common tasks

| Task | Call |
| --- | --- |
| Check the node is on the right chain | `rpc.confirmChain()` |
| Chain tip and sync state | `rpc.getBlockchainInfo()`, `rpc.getBestBlockHash()` |
| Walk headers | `rpc.getBlockHash(height)`, `rpc.getBlockHeader(hash)` |
| Many reads in one round trip | `rpc.batch([requests.getBlockHash(1), requests.getBlockHash(2)])` |
| Confirmations to require for a deposit | `rpc.getConfirmationTarget(valueBits, { securityLevel: 'high' })` |
| Fee estimate | `rpc.estimateSmartFee(6)` → `feeRateBitsPerKvB` |
| Validate an address | `rpc.validateAddress(address)` (P2MR: `witnessVersion: 2`) |
| Wallet balance inputs | `rpc.listUnspent()`, `rpc.getWalletInfo()` |
| Look up a wallet transaction | `rpc.getTransaction(txid)` |
| Build, sign, finalize | `walletCreateFundedPsbt` → `walletProcessPsbt` → `finalizePsbt` |
| Preflight and broadcast | `rpc.testMempoolAccept([hex])`, `rpc.sendRawTransaction(hex)` |
| Unlock an encrypted wallet | `rpc.walletPassphrase(passphrase, seconds)`, `rpc.walletLock()` |
| Verify a data-hash PQC proof | `rpc.verifyDataPqcHash(proof)` |
| Any other allowlisted method | `rpc.call('getmempoolinfo')` (numbers come back as `JsonNumber`) |
| Convert amounts | `parseQbt('1.5')` → `150000000n`, `formatQbt(1n)` → `'0.00000001'` |
| Block and mempool notifications | `new QbitZmqSubscriber({ url, topics })`, `subscriber.health()` |

## Errors you must handle

All `@qbit-oss/rpc` errors extend `QbitRpcError`; recognize them with
`X.is(error)`, which also works across the CommonJS and ESM builds.

| Error | Meaning | What to do |
| --- | --- | --- |
| `RpcUnknownOutcomeError` | A wallet-write or broadcast call may have been executed, but no valid reply arrived (timeout, abort, dropped connection, proxy 5xx, malformed or oversized reply). Never retried. | Reconcile before acting again: look up `txid` for a broadcast, re-read wallet state for a signing call. |
| `RpcError` | The node answered with an error: `code` and `message` are the node's. | Handle by code, for example -26 rejected, -25 missing inputs, -27 already confirmed, -14 wrong passphrase, -28 node warming up. |
| `RpcCapabilityError` | Refused before sending: capability not enabled, method not allowlisted, or not batchable. | A programming or configuration error. |
| `RpcChainGuardError` | A wallet-write or broadcast call before `confirmChain()`, or after a chain check (yours, or the automatic re-check of a stale confirmation) found the wrong chain. Nothing was sent. | Call `confirmChain()`; on `mismatch`, check the URL. |
| `RpcTransportError` | Connection failed, an HTTP status without a JSON-RPC reply (401 credentials, 403 `rpcallowip`), or the cookie file could not be read. | Retry reads later; fix configuration for 401/403. |
| `RpcTimeoutError`, `RpcAbortedError` | The operation's deadline (`timeoutMs`) expired, or your `AbortSignal` fired. For side-effecting calls these arrive as the `cause` of an `RpcUnknownOutcomeError`. | Retry reads if appropriate. |
| `RpcResponseError`, `RpcResponseTooLargeError` | The reply was not valid JSON-RPC, a result failed validation (`path` says where), or it passed `maxResponseBytes`. | Treat the node or proxy as misbehaving; do not guess the value. |

`@qbit-oss/zmq` does not throw for bad input from the publisher: malformed
messages, sequence gaps and socket failures arrive as `malformed`, `gap` and
`reconnect` events, and `health()` reports `unknown` until a message arrives
and again as soon as the connection drops.

## What this MVP leaves out

- **Not published, not audited.** No npm release or publish workflow.
- **Typed methods** cover the list in the [`@qbit-oss/rpc` README](packages/rpc/README.md#typed-methods).
  Other allowlisted methods are untyped through `call()`. `sendmany`,
  `sendtoaddress`, `send`, `sendall` and `bumpfee` are excluded on purpose:
  they sign and broadcast in one step.
- `getwalletinfo` in qbit Core v1.0.0 has no per-key PQC signature counts; they
  appear on `walletprocesspsbt` replies (and `getaddressinfo` through `call()`).
- No custom TLS options (CA bundles, client certificates) for HTTPS endpoints,
  no connection-count limits beyond 8 pooled sockets per client, and no proxy
  support.
- The chain guard compares the chain name only, not the genesis hash, and its
  re-check is a separate request from the guarded call, so it cannot tell two
  nodes of the same chain apart behind one URL.
- `@qbit-oss/zmq` does not decode `rawblock` or `rawtx` bodies, and does not
  support CURVE authentication (qbitd does not offer it).
- Browser support, and migrating existing services onto these packages.

## Development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

`verify` runs `format:check`, `build`, `test`, `typecheck`, `typecheck:test`,
`pack:check` and `consumer:check`, as `.github/workflows/ci.yml` does.

The live smoke test starts a throwaway regtest node (loopback only, temporary
data directory) from a qbit Core binary you have verified, and runs both
packages against it:

```sh
QBIT_BIN_DIR=/path/to/qbit-1.0.0/bin scripts/regtest-smoke.sh
```

Changes are listed in [CHANGELOG.md](CHANGELOG.md); report vulnerabilities as
[SECURITY.md](SECURITY.md) describes.
