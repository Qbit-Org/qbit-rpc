# Changelog

Notable changes to `@qbit-oss/rpc` and `@qbit-oss/zmq`. Both packages share one
version. Nothing has been published yet: both are `0.0.0` and private.

## Unreleased: initial MVP

### @qbit-oss/rpc

- `QbitRpcClient` for qbit Core v1.0.0 JSON-RPC over HTTP(S), with `/wallet/<name>`
  endpoints, HTTP Basic or cookie authentication (the cookie re-read per
  request, loopback only) and refusal of cleartext credentials to non-loopback
  hosts.
- A method allowlist with opt-in `wallet-read`, `wallet-write` and `broadcast`
  capabilities, enforced before any request, for typed methods, `call()` and
  `batch()` alike. `sendmany` and the other sign-and-broadcast methods are not
  allowlisted.
- A chain guard: wallet-write and broadcast calls wait for `confirmChain()`.
- Typed, validated methods: `getblockchaininfo`, `getnetworkinfo`,
  `getbestblockhash`, `getblockhash`, `getblockheader`, `getrawtransaction`
  (hex and verbose), `getconfirmationtarget`, `estimatesmartfee`,
  `validateaddress`, `verifydatapqchash`, `testmempoolaccept`,
  `sendrawtransaction`, `getwalletinfo`, `gettransaction`, `listunspent`,
  `walletcreatefundedpsbt`, `walletprocesspsbt` (with PQC usage fields),
  `finalizepsbt`, `walletpassphrase`, `walletlock`.
- Amounts as `bigint` bits, parsed from the reply text and written as exact
  decimals; `parseQbt`, `formatQbt` and `JsonNumber` for untyped results.
- Typed errors, `RpcUnknownOutcomeError` for side-effecting calls whose outcome
  is unknown, one deadline per operation, opt-in read retries, a response size
  cap, and JSON-RPC batches for reads with per-item results.

### @qbit-oss/zmq

- `parseZmqMessage` for the `hashblock`, `hashtx`, `rawblock`, `rawtx` and
  `sequence` topics, rejecting malformed frames with `ZmqFrameError`.
- `QbitZmqSubscriber`: an async iterator of messages, per-topic sequence gaps,
  malformed messages and socket replacements, with `health()` reporting
  `unknown` until a message arrives, and clean `close()`.
- Hashes are reported in the byte order qbitd sends, which is the RPC display
  order. The parser this was ported from reversed them a second time.

### Review fixes

- `walletCreateFundedPsbt` sends `subtractFeeFromOutputs` under the name qbit
  Core reads. It sent `subtract_fee_from_outputs`, which the node accepts and
  ignores, so the wallet paid fees meant to come out of the recipient's
  output. Every option name sent to `walletcreatefundedpsbt` and `listunspent`
  is now checked against a live node in the regtest smoke test.
- The chain guard goes stale after `chainCheckMaxAgeMs` (default 10 s) or on a
  connection error, HTTP 401 or cookie change, and wallet-write and broadcast
  calls re-check the chain first, under their own deadline. `chainStatus` can
  be `stale`.
- Wallet-write and broadcast calls evaluate the chain guard after their last
  await, as the request is handed to the transport, so a mismatch recorded
  while one read its cookie, re-checked the chain or waited to re-check
  refuses it; only a `confirmChain()` begun after a mismatch clears it. They read the
  cookie once per attempt and send the re-check and the call with that header;
  a confirmation counts only for calls with the cookie it was made with. A
  chain check answered after a connection error or HTTP 401 elsewhere, or
  after a mismatch, changes nothing: the call (or `confirmChain()`) checks
  again after `retryDelayMs`, up to three checks, then fails with the new
  `RpcChainGuardError` reason `stale`, having sent nothing.
- `call('sendrawtransaction', ...)` reports the computed txid in an
  `RpcUnknownOutcomeError`, as the typed method does.
- `@qbit-oss/zmq`: health is `unknown` as soon as the connection drops, and the
  socket is replaced; `staleAfterMs` defaults to 10 minutes; the first message
  on each topic after a replacement is a gap; `maxMessageSize` defaults to
  2,065,536 bytes; `rawblock` and `rawtx` bodies over 2,000,000 bytes are
  malformed; `reconnect` events carry a `reason`.

### Wallet and chain methods for the payout adapter

- Typed, validated methods for the calls qbit-payments' qbit Core wallet
  adapter makes, so `QbitRpcClient` satisfies its `CoreRpc` interface with no
  wrapper: `getblockcount`, `getmempoolentry` and `gettxout` (read),
  `getaddressinfo` and `listlockunspent` (wallet-read), `getrawchangeaddress`
  and `lockunspent` (wallet-write, side-effecting: never retried, unknown
  outcome when the reply is lost). Amounts are bits; `getaddressinfo` carries
  the PQC signature-budget fields. Parameters and results were checked against
  a qbit Core v1.0.0 regtest node, and the smoke test drives each method.
- `lockUnspent` refuses an empty list of outputs, which qbit Core would read as
  "do nothing".

### Wallet history and receiving

- Typed, validated `listsinceblock`, `listtransactions` and `getbalances`
  (wallet-read) and `getnewaddress` (wallet-write, side-effecting: never
  retried, unknown outcome when the reply is lost). Entries carry signed bits,
  their block placement and conflicts, and are checked for consistency (a
  send's sign, a fee on every send and only there, a block exactly when
  confirmed, `trusted` exactly when not); `listSinceBlock` returns `lastBlock`
  and `removed`, which must be present unless `includeRemoved: false`;
  balances keep an absent `used` apart from zero. `listTransactions` refuses a
  `count + skip` above 2,147,483,647 and an empty label, and `getNewAddress`
  the label `*`. Parameters and reply shapes were checked against a qbit Core
  v1.0.0 regtest node, including a reorg, and the smoke test drives each
  method, including the payout adapter's `listsinceblock` call.
