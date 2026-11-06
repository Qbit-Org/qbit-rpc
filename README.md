# qbit-rpc

Node.js clients for a qbit Core node you run: JSON-RPC (`@qbit-oss/rpc`) and
ZMQ notifications (`@qbit-oss/zmq`). They complement the official SDK:
[`@qbit-oss/api`](https://github.com/Qbit-Org/qbit-js/tree/main/packages/api)
talks to block explorers, not to `qbitd`. Nothing here is specific to one
application.

## Which package do I need?

- [`@qbit-oss/rpc`](packages/rpc/README.md) to read chain and wallet state from
  `qbitd`, fund and sign PSBTs with its wallet, and broadcast. Every method is
  allowlisted, by the package or by the client's own `extraMethods`, and gated
  by capabilities the client opts into, wallet-write and
  broadcast calls wait until the node's chain is confirmed, results are
  validated, and amounts are exact `bigint` bits. No runtime dependencies.
- [`@qbit-oss/zmq`](packages/zmq/README.md) to be woken by `qbitd`'s ZMQ
  notifications (new blocks, mempool changes) and told when you missed some. It
  uses the native [`zeromq`](https://www.npmjs.com/package/zeromq) addon, an
  optional peer dependency you install beside it, which is why it is a separate
  package.
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
npm install /path/to/qbit-oss-rpc-0.0.0.tgz /path/to/qbit-oss-zmq-0.0.0.tgz zeromq@^6.5.0
```

`zeromq` is needed only for `QbitZmqSubscriber`'s default socket; see
[Packaging and dependencies](#packaging-and-dependencies). Both packages ship
CommonJS and ESM builds with type declarations. For the qbit Core versions,
Node.js versions and platforms they support, see below.

## Supported qbit Core versions

**qbit Core 1.0.x releases**: 1.0.0 and any later 1.0 patch release, but no
pre-release such as `1.0.1-rc1` or `0.1.2-testnet4`. Both packages are tested
against v1.0.0, the release `scripts/qbit-core-release.mjs` names, by CI's
`regtest smoke` job. A new minor version is supported only once that job passes
against it, in a release of these packages that says so.

`@qbit-oss/rpc` checks the node's version with every chain check and exposes it
as `rpc.nodeVersion`. On another version it refuses wallet-write and broadcast
calls with `RpcChainGuardError` `reason: 'unsupported_version'`, unless the
client sets `allowUnsupportedNodeVersion`; reads go on, and every reply is
still validated. Which values a later qbit Core may add pass through, and which
fail validation, is in its README:
[Versions and compatibility](packages/rpc/README.md#versions-and-compatibility).

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

`@qbit-oss/zmq` is tested with `zeromq` 6.5.0, the floor of its peer range,
which ships a prebuilt addon for each platform below:

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
import { QbitRpcClient, requests, RpcUnknownOutcomeError } from '@qbit-oss/rpc'

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
// An exhausted PQC key signs nothing and raises no error: before signing, read
// the budget of each key this PSBT spends from, unconfirmed change included.
const { inputs } = (await rpc.call('decodepsbt', [funded.psbt])) as {
  inputs: { witness_utxo?: { scriptPubKey: { address?: string } } }[]
}
const addresses = inputs.map(input => input.witness_utxo?.scriptPubKey.address)
if (!addresses.every(address => address !== undefined)) throw new Error('an input without an address')
const spent = [...new Set(addresses)]
const budgets = await rpc.batch(spent.map(address => requests.getAddressInfo(address)))
const signing = new Map<string, number>() // signatures each PQC key makes here, one per input
for (const [i, info] of budgets.entries()) {
  if (!info.ok) throw info.error
  const state = info.value.pqcOverallLimitState // undefined: no PQC key of this wallet
  if (state === undefined) continue
  const known = state === 'normal' || state === 'warning' || state === 'critical'
  if (!known) throw new Error(`${spent[i]}: PQC key ${state}, rotate first`) // exhausted, or unknown
  const keys = info.value.pqcKeyStates ?? []
  if (keys.length === 0) throw new Error(`${spent[i]}: a PQC state without its keys`)
  const inputsHere = addresses.filter(address => address === spent[i]).length
  for (const { pubkey, pqcSignaturesRemaining: left } of keys) {
    const signs = (signing.get(pubkey) ?? 0) + inputsHere
    signing.set(pubkey, signs)
    // Signing must not run a key out halfway: the inputs after it would stay unsigned.
    if (left < signs) throw new Error(`PQC key ${pubkey}: ${left} signatures left, ${signs} inputs to sign`)
  }
  if (state !== 'critical') continue
  console.warn(`${spent[i]}: PQC key critical: stop using it, and spend its coins to a new address now`)
}
const signed = await rpc.walletProcessPsbt(funded.psbt)
if (!signed.complete || signed.hex === undefined) throw new Error('not fully signed')
const budget = signed.pqcOverallLimitState
if (budget !== undefined && budget !== 'normal' && budget !== 'warning') {
  // critical, exhausted, or a state a later qbit Core adds: rotate keys before the budget runs out
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
| A method the package does not allowlist | open it for one client, `extraMethods: { getchaintxstats: { capability: 'read', sideEffects: false } }`, then `rpc.call('getchaintxstats')`; see [opening another method](packages/rpc/README.md#opening-another-method-extramethods) |
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

## Limits

- **Typed methods** cover the list in the [`@qbit-oss/rpc` README](packages/rpc/README.md#typed-methods).
  Other allowlisted methods are untyped through `call()`. A client can open a
  method the package does not allowlist with
  [`extraMethods`](packages/rpc/README.md#opening-another-method-extramethods),
  untyped and unvalidated, under a capability and with `sideEffects` stated.
  For a method qbit Core v1.0.0's `help` lists, the package refuses a policy
  below what the method does; for a hidden one, it cannot check the policy.
  Node administration (`stop`, `setban`, `addnode`, ...) opens only this way,
  under the `node-admin` capability, which allowlists nothing by default.
  `sendmany`, `sendtoaddress`, `send`, `sendall` and `bumpfee` are excluded on
  purpose, and cannot be opened: they sign and broadcast in one step. `psbtbumpfee` returns an unsigned PSBT
  instead, so it is allowlisted and typed.
- `getwalletinfo` in qbit Core v1.0.0 has no per-key PQC signature counts; they
  appear on `walletprocesspsbt` and `getaddressinfo` replies.
- No connection limit across clients: each client keeps at most
  `maxConcurrentRequests` requests open, default 8, on a keep-alive pool of
  that size plus one spare.
- A remote node goes behind a TLS terminator, with a private CA, a client
  certificate and key pins as the [`@qbit-oss/rpc` README](packages/rpc/README.md#remote-nodes)
  describes. There is no built-in proxy: a `connect` function opens the tunnel,
  and the client keeps TLS and its checks over it. Certificate verification
  cannot be turned off, not by `NODE_TLS_REJECT_UNAUTHORIZED=0` either, and
  revocation (CRL, OCSP) is not checked; a pin narrows trust to the keys it
  names.
- A polluted `Object.prototype` is refused, not worked around: while it has an
  enumerable property of its own, every `@qbit-oss/rpc` call fails, unsent,
  with `RpcTransportError` `reason: 'prototype_polluted'`. Node reads options
  and certificate fields from objects that inherit it. Pollution that lands
  after that check can still crash the process inside Node: `blockList` and
  `handshakeTimeout` on Node 22.13 and 24, `infoAccess` on Node 22.13. An
  application must remove it; see the
  [`@qbit-oss/rpc` README](packages/rpc/README.md#a-polluted-objectprototype).
- The chain guard checks the chain name, the genesis block hash and, on signet,
  the challenge. It still cannot tell apart two regtest nodes (they share one
  genesis block), the default signet from a look-alike mined with the same open
  challenge (`51`), or two nodes of the same chain behind one URL, as its
  re-check is a separate request from the guarded call.
- `@qbit-oss/zmq` does not decode `rawblock` or `rawtx` bodies, and does not
  support CURVE authentication (qbitd does not offer it).
- Neither package runs in a browser: both use Node.js built-in modules.

## Packaging and dependencies

Each tarball holds exactly `package.json`, `README.md`, `LICENSE` and, in
`lib/`, the CommonJS build (`index.js`), the ESM build (`index.mjs`), a source
map for each and the declarations for each (`index.d.ts`, `index.d.mts`). The
maps carry every source file in `sourcesContent`, so `src/` is not shipped:
run Node.js with `--enable-source-maps` to see `src/*.ts` lines in stack traces.
`@qbit-oss/rpc` is about 1.57 MB unpacked (407 KB packed), most of it the two
maps; `@qbit-oss/zmq` about 224 KB (60 KB packed). `pack:check` fails on any
other file, on a map that does not carry its sources, and above a ceiling of
1,815,000 and 280,000 bytes unpacked.

The packages set no `"type"`: `.js` is CommonJS and `.mjs` ESM. They set
`"sideEffects": false`: no module does anything at import that a consumer
relies on (the error brands are set on the packages' own prototypes, and come
with any export that is used), so a bundler may drop a package nothing is
imported from. `consumer:check` bundles both with esbuild to check that a bare
import bundles to nothing, and that bundled error classes still recognize
errors from the CommonJS build.

### `zeromq`

`@qbit-oss/rpc` has no runtime dependencies. `@qbit-oss/zmq` has one optional
peer dependency, `zeromq` `^6.5.0`, and no others. It is optional because
only `QbitZmqSubscriber`'s default socket (`createZeromqSocket`) loads it, at
the first iteration: the parser, a custom `socketFactory` and the types work
without it, and without it a subscriber fails with `ZmqSetupError`
`module_load`. A peer, not a dependency, so that the application chooses and
updates the one copy of the native addon, and an install on a platform
without a prebuilt addon (where `zeromq`'s install script tries to build
libzmq from source) fails only for those who install `zeromq`. Applications
that subscribe add it themselves (`npm install zeromq@^6.5.0`); npm and pnpm
do not install an optional peer. A bundler must leave `zeromq` external, as
for any native addon.

The floor of the range is the version the workspace pins as a dev dependency,
so CI tests the floor; `pack:check` fails when they differ. The range admits
newer 6.x releases, which CI does not test until the floor moves. Raise the
floor (and the pin, together) to use a newer `zeromq` API, or when an older
6.x is known not to work.

### Other `@qbit-oss/*` packages

There are none yet. When one is added (say `@qbit-oss/protocol`, to check
addresses or decode `rawtx`):

- Use a caret range, never an exact pin, so an application can share one copy
  and take a fix without a release of these packages. On `0.x`, `^0.3.1` means
  `>=0.3.1 <0.4.0`, so a minor release is a breaking one.
- A plain dependency when it is used internally; a peer dependency when its
  types or classes appear in this package's API, so the application and this
  package see the same ones.
- The floor is the oldest version that works: raise it when using an API
  added later. Never `workspace:` or `file:` in a published manifest.
- The lockfile resolves the newest version in range, which every CI run tests.
  Add a CI job with the first such dependency to test the floor too: install
  with `pnpm install --no-frozen-lockfile --config.resolution-mode=lowest-direct`,
  which resolves each direct dependency to the lowest version its range
  allows, and run `pnpm verify`. A peer follows the `zeromq` rule instead:
  the dev pin is the floor. `pack:check` refuses any runtime dependency today,
  so the first one changes it as well.

### Updates

`.github/dependabot.yml` opens version update pull requests every Monday at
06:00 UTC, two days after a release at the earliest (pnpm refuses one younger
than a day): one for minor and patch updates of the dev tooling, one per major
update, one for each `zeromq` update, which moves the pin only: move the peer
range's floor by hand in that pull request (Dependabot does not update
`peerDependencies`, and `pack:check` fails until the two agree), and one for the
GitHub Actions, which stay pinned by SHA. Major updates of
`@types/node`, which follows the oldest supported Node.js line, are ignored.
Each runs the same CI as any pull request.

There is no ESLint: Prettier formats, and `tsc` in strict mode checks the code.

## Development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

`verify` runs `format:check`, `build`, `api:check`, `test`, `test:release`
(which needs `gpg`), `test:scripts`, `typecheck`, `typecheck:test`, `pack:check` and
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
refuses a `QBIT_BIN_DIR` of another version. The versions `@qbit-oss/rpc`
supports are defined in one place too, `packages/rpc/src/version.ts`; widen
them only after the smoke test passes against the new release, and say so in
[CHANGELOG.md](CHANGELOG.md). A release signed under a newer
key policy also needs `scripts/qbit-release-keys/` updated, as its `README.md`
describes.

### Property tests and fixtures

The parsers and validators are also tested with
[fast-check](https://fast-check.dev/) properties: amounts, `JsonNumber`, the
txid computation, every result validator, `parseZmqMessage` and the sequence
tracker. Each validator starts from real replies in
`packages/rpc/test/fixtures/regtest/`, which a mutation changes field by field:
it must validate, or fail as `RpcResponseError`, and on a side-effecting call
as `RpcUnknownOutcomeError`. In `test` each property runs a fixed number of
times from a fixed seed, so the run is the same everywhere and takes a few
seconds. For a longer fuzz, set the number of runs; each property then starts
from a random seed, which a failure prints, and `QBIT_FUZZ_SEED` replays it:

```sh
QBIT_FUZZ_RUNS=20000 corepack pnpm test
QBIT_FUZZ_RUNS=20000 QBIT_FUZZ_SEED=-428120168 corepack pnpm test
```

The fixtures come from a throwaway regtest node, as for the smoke test. To
capture them again, after a qbit Core release or a new typed method:

```sh
corepack pnpm build
QBIT_BIN_DIR="$bin" node scripts/capture-rpc-fixtures.mjs
```

It rewrites every fixture, and refuses one holding a path, or the host name as
a whole word of 4 or more characters. On a failure, Ctrl-C or SIGTERM it stops
the node, killing it after 60 s, and removes its data directory. Prettier
leaves the fixtures alone, so each keeps qbit Core's number text.

Changes are listed in [CHANGELOG.md](CHANGELOG.md); report vulnerabilities as
[SECURITY.md](SECURITY.md) describes.
