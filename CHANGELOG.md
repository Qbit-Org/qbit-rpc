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
