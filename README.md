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

Both packages ship CommonJS and ESM builds with type declarations. For the
Node.js versions and platforms they run on, see below.

## Node.js and platforms

`engines` accepts Node.js `^22.13.0 || ^24.0.0 || >=26.0.0`. CI runs all of
`pnpm verify` on Linux x64 (`ubuntu-latest`) for every pull request and push to
`main`, once per line: 22.13.0 exactly (the floor), and the newest 22.x, 24.x
and 26.x. It installs with `--config.engine-strict=true`, so a non-optional
locked dependency whose `engines` leaves out one of these fails CI (pnpm skips
an optional one instead). The `verify` check passes only when every Node.js
line passed.

Node.js 27 and later majors are accepted but untested. They are expected to
work: `@qbit-oss/rpc` uses only standard JavaScript (`JSON.parse` source text
access and `JSON.rawJSON`, checked when a client is created), and the `zeromq`
addon is built against Node-API, whose ABI stays the same across Node.js
majors, so the same prebuild loads without a rebuild. Node.js 23 and 25 are not
accepted.

`@qbit-oss/rpc` has no native code. CI runs its tests on Linux x64 only (the
manual arm64 jobs below load its packed builds too); it is expected to work
wherever a supported Node.js runs.

`@qbit-oss/zmq` needs a prebuilt addon from `zeromq` 6.5.0, which ships one
for each platform below:

| Platform | Minimum | CI |
| --- | --- | --- |
| Linux x64, glibc | glibc 2.25 | All of `verify`, on each Node.js line above |
| Linux arm64, glibc | glibc 2.25 | Loads `zeromq` and the packed packages on `ubuntu-24.04-arm`, Node.js 26.x, in manual runs |
| macOS arm64 | macOS 14 | The same, on `macos-latest` (the current image, not the minimum), in manual runs |
| macOS x64 | macOS 13.7 | Untested |
| Linux x64 and arm64, musl (Alpine) | | Untested |
| Windows x64, arm64 and ia32 | | Untested |

The two arm64 jobs run only when started by hand (`workflow_dispatch`), not on
pull requests or pushes: macOS minutes are billed at a multiple for this
private repository, and the arm64 runners must first be available to it. On a
platform not in the table above, `zeromq`'s install script builds libzmq from
source, which needs CMake, Ninja and vcpkg and is not tested here.

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
const [preflight] = await rpc.testMempoolAccept([signed.hex])
if (preflight?.allowed !== true) throw new Error(`rejected: ${preflight?.rejectReason}`)
const { txid } = preflight // the txid of this hex; nothing is broadcast yet
await saveSignedTransaction(txid, signed.hex) // your storage: persist both before broadcasting
try {
  await rpc.sendRawTransaction(signed.hex) // resolves with the same txid
} catch (error) {
  if (RpcUnknownOutcomeError.is(error)) {
    // The node may have relayed it. Reconcile by the stored txid
    // (rpc.getTransaction(txid)); resubmitting the stored hex is harmless.
    // Never rebuild the payment with new inputs.
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
| Preflight and broadcast | `rpc.testMempoolAccept([hex])`, `rpc.sendRawTransaction(hex)` (the node's 0.10 QBT/kvB fee-rate cap, or `{ maxFeeRateBitsPerKvB }`) |
| Keep coins out of coin selection | `rpc.lockUnspent(outputs, { persistent: true })`, `rpc.unlockUnspent(outputs)` |
| Unlock an encrypted wallet | `rpc.walletPassphrase(passphrase, seconds)`, `rpc.walletLock()`; a new wallet's first unlock is slow, see [its deadline](packages/rpc/README.md#unlocking-an-encrypted-wallet) |
| Verify a data-hash PQC proof | `rpc.verifyDataPqcHash(proof)` |
| Any other allowlisted method | `rpc.call('getmempoolinfo')` (numbers come back as `JsonNumber`) |
| Abort a call or give it its own deadline | the last argument: `rpc.getTxOut(txid, vout, { includeMempool: true }, { signal, timeoutMs: 5_000 })` |
| Convert amounts | `parseQbt('1.5')` → `150000000n`, `formatQbt(1n)` → `'0.00000001'` |
| Block and mempool notifications | `new QbitZmqSubscriber({ url, topics })`, `subscriber.health()` |

## Errors you must handle

Each package has one table of its errors, every class, `reason` and `code`, with
what to do about each: [`@qbit-oss/rpc`](packages/rpc/README.md#failure-model) and
[`@qbit-oss/zmq`](packages/zmq/README.md#errors). A test keeps them equal to the
code. Recognize an error with `X.is(error)`, which also works across the CommonJS
and ESM builds.

The one to handle first: a side-effecting `@qbit-oss/rpc` call that may have run
rejects with `RpcUnknownOutcomeError`. Reconcile before acting again. Any other
rejection is definite: refused, not sent, or the node's own answer (`RpcError`,
whose number is `rpcCode`). A failed chain re-check is `RpcChainGuardError` with
`reason: 'check_failed'` and the failure as `cause`: nothing was sent.

`@qbit-oss/zmq` does not throw for bad input from the publisher: malformed
messages, sequence gaps and socket failures arrive as `malformed`, `gap` and
`reconnect` events, and `health()` reports `unknown` until a message arrives
and again as soon as the connection drops.

## What this MVP leaves out

- **Not published, not audited.** No npm release or publish workflow.
- **Typed methods** cover the list in the [`@qbit-oss/rpc` README](packages/rpc/README.md#typed-methods).
  Other allowlisted methods are untyped through `call()`. `sendmany`,
  `sendtoaddress`, `send`, `sendall` and `bumpfee` are excluded on purpose:
  they sign and broadcast in one step. `psbtbumpfee` returns an unsigned PSBT
  instead, so it is allowlisted and typed.
- `getwalletinfo` in qbit Core v1.0.0 has no per-key PQC signature counts; they
  appear on `walletprocesspsbt` and `getaddressinfo` replies.
- No custom TLS options (CA bundles, client certificates) for HTTPS endpoints,
  no connection limit across clients (each client keeps at most
  `maxConcurrentRequests` requests open, default 8, on a keep-alive pool of
  that size plus one spare), and no proxy support.
- The chain guard checks the chain name, the genesis block hash and, on signet,
  the challenge. It still cannot tell apart two regtest nodes (they share one
  genesis block), the default signet from a look-alike mined with the same open
  challenge (`51`), or two nodes of the same chain behind one URL, as its
  re-check is a separate request from the guarded call.
- `@qbit-oss/zmq` does not decode `rawblock` or `rawtx` bodies, and does not
  support CURVE authentication (qbitd does not offer it).
- Browser support, and migrating existing services onto these packages.

## Development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

`verify` runs `format:check`, `build`, `api:check`, `test`, `test:release`
(which needs `gpg`), `typecheck`, `typecheck:test`, `pack:check` and
`consumer:check`, as `.github/workflows/ci.yml` does, on each Node.js line.

### The API report

Each package's public API is recorded in `packages/<package>/etc/<package>.api.md`,
an [API Extractor](https://api-extractor.com/) (`@microsoft/api-extractor`
7.59.4) report of every export and its declaration, made from the built
declarations, `lib/index.d.ts` and `lib/index.d.mts`. `api:check` compares both
builds' declarations with the checked-in report and fails on any difference, so
a change to the public API, breaking or not, cannot reach `main` without a
change to that file in the same pull request. The report holds no paths and
does not depend on the Node.js version: every line of the CI matrix checks the
same file. A public type that names an unexported one fails the check too.
What each package exports, and what it keeps internal, is in its README:
[`@qbit-oss/rpc`](packages/rpc/README.md#public-api) and
[`@qbit-oss/zmq`](packages/zmq/README.md#public-api).

After an intended API change:

```sh
corepack pnpm api:update   # builds, then rewrites packages/*/etc/*.api.md
git diff packages/*/etc    # review what changed
```

Commit the reports with the change, and list a breaking change in
[CHANGELOG.md](CHANGELOG.md) with how a caller migrates. `api:check` alone
(after `corepack pnpm build`) runs the check without writing anything.

The live smoke test starts a throwaway regtest node (loopback only, temporary
data directory) from a verified qbit Core release, and runs both packages
against it, including every ZMQ topic, a qbitd restart and an oversized
message. CI's `regtest smoke` job runs it on every pull request and push to
`main`. Its encrypted test wallets are first unlocked by the tests, with
`walletPassphrase`'s default deadline: qbitd runs a new encrypted wallet's
deferred keypool top-up inside that first unlock, 25 to 49 s. To run it locally:

```sh
bin="$(node scripts/qbit-release.mjs fetch "$(mktemp -d)/qbit-core")"
QBIT_BIN_DIR="$bin" scripts/regtest-smoke.sh
```

`scripts/qbit-release.mjs` downloads `SHA256SUMS` and `SHA256SUMS.asc` from
the release on `github.com/Qbit-Org/qbit`, and verifies them with `gpg` in a
temporary GnuPG home holding only the keys in `scripts/qbit-release-keys/`:
copies of qbit's own `contrib/keys/operator-keys/` at the release tag, which
its `README.md` names. Every signature must be good and by a listed signing
key, and the distinct signers must meet the release line's quorum in
`keys.json` (3 of 5 for `mainnet`, which v1.0.0 is). Only then does it take
the tarball's SHA-256 from `SHA256SUMS`, and it extracts the tarball only if
it has that hash. CI caches the tarball under that hash, and checks a
restored one again before use.

The release under test is named in one place, `scripts/qbit-core-release.mjs`;
the tag, asset names and cache key follow from it, and the smoke script
refuses a `QBIT_BIN_DIR` of another version. A release signed under a newer
key policy also needs `scripts/qbit-release-keys/` updated, as its `README.md`
describes.

Changes are listed in [CHANGELOG.md](CHANGELOG.md); report vulnerabilities as
[SECURITY.md](SECURITY.md) describes.
