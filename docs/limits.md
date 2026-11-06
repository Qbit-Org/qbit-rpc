# Limits

What the packages do not do, or cannot check.

- **Typed methods** cover the list in [Methods](rpc/methods.md#typed-methods).
  Other allowlisted methods are untyped through `call()`. A client can open a
  method the package does not allowlist with
  [`extraMethods`](rpc/capabilities.md#opening-another-method-extramethods),
  untyped and unvalidated, under a capability and with `sideEffects` stated.
  For a method qbit Core v1.0.0's `help` lists, the package refuses a policy
  below what the method does; for a hidden one, it cannot check the policy.
  Node administration (`stop`, `setban`, `addnode`, ...) opens only this way,
  under the `node-admin` capability, which allowlists nothing by default.
  `sendmany`, `sendtoaddress`, `send`, `sendall` and `bumpfee` are excluded on
  purpose, and cannot be opened: they sign and broadcast in one step.
  `psbtbumpfee` returns an unsigned PSBT instead, so it is allowlisted and
  typed.
- `getwalletinfo` in qbit Core v1.0.0 has no per-key PQC signature counts; they
  appear on `walletprocesspsbt` and `getaddressinfo` replies.
- No connection limit across clients: each client keeps at most
  `maxConcurrentRequests` requests open, default 8, on a keep-alive pool of
  that size plus one spare. See [the work queue](rpc/errors.md#the-work-queue).
- A remote node goes behind a TLS terminator, with a private CA, a client
  certificate and key pins, as [Remote nodes](rpc/remote-nodes.md) describes.
  There is no built-in proxy: a `connect` function opens the tunnel, and the
  client keeps TLS and its checks over it. Certificate verification cannot be
  turned off, not by `NODE_TLS_REJECT_UNAUTHORIZED=0` either, and revocation
  (CRL, OCSP) is not checked; a pin narrows trust to the keys it names.
- A polluted `Object.prototype` is refused, not worked around: while it has an
  enumerable property of its own, every `@qbit-oss/rpc` call fails, unsent,
  with `RpcTransportError` `reason: 'prototype_polluted'`. Node reads options
  and certificate fields from objects that inherit it. Pollution that lands
  after that check can still crash the process inside Node: `blockList` and
  `handshakeTimeout` on Node 22.13 and 24, `infoAccess` on Node 22.13. An
  application must remove it; see
  [a polluted `Object.prototype`](rpc/remote-nodes.md#a-polluted-objectprototype).
- The [chain guard](rpc/chain-guard.md) checks the chain name, the genesis
  block hash and, on signet, the challenge. It still cannot tell apart two
  regtest nodes (they share one genesis block), the default signet from a
  look-alike mined with the same open challenge (`51`), or two nodes of the
  same chain behind one URL, as its re-check is a separate request from the
  guarded call.
- `@qbit-oss/zmq` does not decode `rawblock` or `rawtx` bodies, and does not
  support CURVE authentication (qbitd does not offer it).
- Neither package runs in a browser: both use Node.js built-in modules.
