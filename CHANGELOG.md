# Changelog

Notable changes to `@qbit-oss/rpc` and `@qbit-oss/zmq`, for those who use them.
Both packages share one version, and [RELEASING.md](RELEASING.md#versioning)
says what a version number promises: below 1.0, a minor release (`0.1.x` to
`0.2.0`) can break, and a patch release cannot, apart from the behaviour
changes listed there, each marked **Behaviour change:** below.

A release's section collects its entries as they land, headed
`## X.Y.Z (unreleased)`, and is dated, `## X.Y.Z - YYYY-MM-DD`, when that
version is published. Release candidates (`X.Y.Z-rc.N`, on npm's `candidate`
dist-tag) ship what their release's section says so far. Every pull request that
changes a package's `src/` adds a line here, which CI checks.

How the code changed before its first release, review by review, is in
[docs/history/before-0.1.0.md](docs/history/before-0.1.0.md).

## 0.1.0 (unreleased)

The first release of both packages.

### Supported versions

- **qbit Core 1.0.x releases**: 1.0.0 and later 1.0 patch releases, not
  pre-releases such as `1.0.1-rc1`. Tested against v1.0.0 on regtest, by CI
  on every pull request. `@qbit-oss/rpc` reads the node's version with every
  chain check (`rpc.nodeVersion`) and refuses wallet-write, broadcast, mining
  and wallet-admin calls to any other version unless the client sets
  `allowUnsupportedNodeVersion`. A qbit Core 1.1 node needs a release of these
  packages that supports it.
- **Node.js** `^22.13.0 || ^24.0.0 || >=26.0.0`. CI tests 22.13.0 and the
  newest 22.x, 24.x and 26.x on Linux x64; Node.js 27 and later are accepted
  but untested.
- **TypeScript** 5.0 or later and **`@types/node`** 22.0.0 or later for the
  declarations, which you install yourself. Raising either floor is a breaking
  change.
- **`zeromq`** `^6.5.0`, an optional peer dependency of `@qbit-oss/zmq` that
  you install beside it for `QbitZmqSubscriber`'s default socket. CI loads it
  on Linux x64, and on Linux arm64 and macOS arm64 for pull requests that
  change `@qbit-oss/zmq` or the lockfile, and weekly.
- Both packages ship CommonJS and ESM builds with type declarations and source
  maps, have no runtime dependencies, and set `"sideEffects": false`.

### `@qbit-oss/rpc`

- `QbitRpcClient`, a JSON-RPC client for `qbitd` over HTTP to a loopback
  address or HTTPS to anything else, with HTTP Basic or cookie authentication
  (the cookie read again for every request, so `qbitd` can restart).
- **Capabilities.** Every method is on an allowlist, and gated by the
  capabilities a client opts into: none by default (reads only), then
  `wallet-read`, `wallet-write`, `broadcast`, `mining`, `wallet-admin` and
  `node-admin`. `extraMethods` opens a method the package does not list, under
  a stated capability and side-effect policy that the package checks against
  qbit Core v1.0.0's methods. `sendmany`, `sendtoaddress`, `send`, `sendall`
  and `bumpfee`, which sign and broadcast in one step, cannot be opened.
- **Chain guard.** Wallet-write, broadcast, mining, wallet-admin and
  node-admin calls are refused until `confirmChain()` has matched the node's
  chain name, genesis block and, on signet, challenge against
  `expectedChain`, and the check is repeated before such a call once it is
  older than `chainCheckMaxAgeMs` (10 s) or after a connection error, HTTP 401
  or cookie change.
- **Typed, validated methods** for chain and mempool reads, fee estimates and
  confirmation targets, raw transactions and packages (CPFP), the wallet
  (balances, history, UTXOs, addresses, coin locks, PSBT funding, signing,
  finalizing and fee bumping, encryption), long polls for blocks, mining (block
  templates, block submission, AuxPoW merge mining), wallet administration
  (create, load, unload, descriptors, rescans, backups) and PQC data-hash
  signing. Results are checked field by field and returned with camelCase
  names and null prototypes; anything else allowlisted is available untyped
  through `call()` and `batch()`.
- **Amounts** are `bigint` bits, read from the reply's own number text and
  written as exact decimals; `parseQbt`, `formatQbt` and `JsonNumber` cover
  untyped results.
- **Failure model.** Typed errors with `X.is()` checks that work across the
  CommonJS and ESM builds. A side-effecting call that may have run rejects with
  `RpcUnknownOutcomeError`, carrying the txid, txids or block hash to reconcile
  with, and is never retried or sent twice; every other rejection is definite.
  One deadline covers each operation, reads can opt into retries, replies are
  capped in size, and `maxConcurrentRequests` keeps a client inside `qbitd`'s
  work queue.
- **PQC signature budgets**: `walletProcessPsbt` and `getAddressInfo` report
  each key's signatures used and left, and its state (`normal`, `warning`,
  `critical`, `exhausted`, or one a later qbit Core adds).
- **A PQC check before signing.** `walletProcessPsbt` counts, per PQC key, the
  signatures a PSBT needs against those the key has left, and signs nothing
  when an exhausted key, or one that would run out partway, would leave it
  half signed (`PqcSigningError`). It needs `wallet-read` as well as
  `wallet-write`; `checkPqcSigning(psbt)` runs the check alone.
- **Remote nodes** behind a TLS terminator: a private CA, a client
  certificate, key pins and a `connect` function for proxies, with certificate
  verification that cannot be turned off.
- **`ClientSatisfies<Copy>`**, a type that checks an interface you declare for
  the client instead of importing its types: `true` when `QbitRpcClient` fits
  it, and otherwise each member that does not, with parameters compared both
  ways (`UndeclaredKeys`). Check it in your own type tests,
  `true satisfies ClientSatisfies<MyRpc>`; see
  [Methods](docs/rpc/methods.md#checking-an-interface-of-your-own-clientsatisfies).

### `@qbit-oss/zmq`

- `parseZmqMessage` for the `hashblock`, `hashtx`, `rawblock`, `rawtx` and
  `sequence` topics, refusing malformed frames with `ZmqFrameError`.
- `QbitZmqSubscriber`, an async iterator of messages that also reports
  per-topic sequence `gap`s, `malformed` messages and `reconnect`s, with
  `health()` (`unknown`, `receiving`, `stale`, `closed`). It replaces its own
  socket when the connection drops, and with libzmq's heartbeats (on by
  default) drops a `qbitd` that stops answering within 30 s. libzmq drops a
  connection that sends a message over `maxMessageSize`; the subscriber
  reconnects and reports the gap.

### Documentation

- An API reference of both packages, generated by TypeDoc from the doc
  comments, every export and member, published at
  <https://qbit-org.github.io/qbit-rpc/> from each final release.
- [`examples/`](examples/README.md): a payout that checks the PQC signature
  budgets, stores the signed transaction before broadcasting it and
  reconciles a lost reply by its txid; a deposit watcher that wakes on ZMQ and
  syncs over RPC; and a header walk that follows reorgs back to the fork. CI
  type-checks them, and every TypeScript block in `docs/`, against the packed
  packages.

### Security posture

- **Has not had a third-party security review.** Report vulnerabilities
  privately, as [SECURITY.md](SECURITY.md) describes.
- These packages drive a wallet. Treat any process holding a client with
  `wallet-write`, and the node's RPC port, as able to spend the wallet's
  funds. The packages hold no private keys: signing happens in `qbitd`.
- Credentials and the cookie are sent in cleartext only to a loopback address,
  checked on the address each connection goes to (`localhost` is resolved,
  not trusted by name); anything else needs HTTPS, whose certificate checks
  cannot be turned off, `NODE_TLS_REJECT_UNAUTHORIZED=0` included.
- Options are read from their own properties only, and every call is refused
  while `Object.prototype` is polluted, so prototype pollution in the
  application cannot enable a capability, add credentials or weaken TLS.
- Errors never quote credentials, cookie contents or request parameters; the
  node's own messages about descriptors have private-key-like runs redacted.
  `call()` returns results, and other methods' errors, as the node sent them:
  never log them for a method that takes keys.
- ZMQ notifications are unauthenticated (`qbitd` offers no CURVE): confirm
  over RPC what a notification reports before acting on it.
- Both packages are published from this repository's release workflow only,
  with npm provenance, after a maintainer approves the publish; see
  [RELEASING.md](RELEASING.md).

### Known limitations

- Tested against regtest only. The checks against a mainnet node, read-only
  and with ZMQ, that [docs/network-verification.md](docs/network-verification.md)
  plans have not been run yet; testnet4 is not in the plan.
- On regtest `estimatesmartfee` never returns a fee rate, so the typed
  `estimateSmartFee` has not parsed a real estimate, and AuxPoW (merge-mined)
  blocks, peers, pruned nodes and initial block download have not been seen.
- Untested platforms: macOS x64, musl (Alpine) and Windows. Neither package runs
  in a browser.
- `getwalletinfo` in qbit Core v1.0.0 has no per-key PQC signature counts.
- The chain guard cannot tell two regtest nodes apart, the default signet from
  a look-alike with the same open challenge, or two nodes of one chain behind
  one URL.
- No built-in proxy (use `connect`), and certificate revocation (CRL, OCSP) is
  not checked.
- `@qbit-oss/zmq` does not decode `rawblock` or `rawtx` bodies.
