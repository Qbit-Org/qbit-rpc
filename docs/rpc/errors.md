# Errors

The one to handle first: a side-effecting call that may have run rejects with
`RpcUnknownOutcomeError`. Reconcile before acting again. Any other rejection is
definite: refused, not sent, or the node's own answer (`RpcError`, whose number
is `rpcCode`). A failed chain re-check is `RpcChainGuardError` with
`reason: 'check_failed'` and the failure as `cause`: nothing was sent.

The table below lists every error class, `reason` and `code`, with what to do
about each; a test keeps it equal to the code.

All these errors extend `QbitRpcError`. Recognize them with `X.is(error)`, which
also works across the CommonJS and ESM builds. A side-effecting method is
`sendrawtransaction`, `submitpackage`, `submitblock`, `createauxblock`,
`submitauxblock`, any wallet-write method except `finalizepsbt`, or an
[`extraMethods`](capabilities.md#opening-another-method-extramethods) entry with
`sideEffects: true`. A read
method gets the error that happened; a side-effecting one gets it only where the
last column says it was definitely not run, and otherwise an
`RpcUnknownOutcomeError` with that error as `cause`. `method` is always the call
you made, or in `cause` the request that failed. Every error has its own
`cause`, `undefined` when there is none, with the attributes `Error` gives one
(not enumerable), so it never reads `Object.prototype`; `util.inspect` shows
`[cause]: undefined` for these.

| Error | Value | Meaning | If the call has side effects | What to do |
| --- | --- | --- | --- | --- |
| `QbitRpcError` | | The base class of the others, never thrown itself. | | Recognize any of them with `QbitRpcError.is(error)`. |
| `RpcCapabilityError` | `reason: 'not_enabled'` | The method's capability (`required`) is not enabled. | Not sent | A configuration error. |
| `RpcCapabilityError` | `reason: 'unknown_method'` | The method is not on the allowlist or in `extraMethods`. | Not sent | A programming error. |
| `RpcCapabilityError` | `reason: 'not_batchable'` | A method other than a read in `batch()`, or a [long poll](reading-the-chain.md#long-polls). | Not sent | A programming error. |
| `RpcChainGuardError` | `reason: 'unconfirmed'` | A wallet-write, broadcast, mining or wallet-admin call before `confirmChain()` succeeded. | Not sent | Call `confirmChain()`. |
| `RpcChainGuardError` | `reason: 'mismatch'` | A chain check (yours, or the automatic re-check) found another chain, genesis block or signet challenge; `differs` says which. | Not sent | Check the URL, or set `expectedGenesisHash` or `expectedSignetChallenge` for a node with other chain parameters or a custom signet, then call `confirmChain()`. |
| `RpcChainGuardError` | `reason: 'unsupported_version'` | A chain check found a qbit Core version outside 1.0.x releases; `nodeVersion` says which. | Not sent | Run a supported qbit Core, or a release of this package that supports the node's, then call `confirmChain()`; or accept the risk with `allowUnsupportedNodeVersion`. |
| `RpcChainGuardError` | `reason: 'stale'` | Every chain check the call ran was overtaken by a connection error, an HTTP 401 or another check. | Not sent | Try again later. |
| `RpcChainGuardError` | `reason: 'check_failed'` | The chain re-check before the call failed; `cause` is the failure. | Not sent | Safe to call again; `cause` tells whether soon is any use. |
| `PqcSigningError` | `reason: 'no_address'` | The PQC check before signing (`walletProcessPsbt`, by default, or `checkPqcSigning`) found an input, `inputIndex`, that names no output with an address, so the signatures it needs cannot be counted. See [checking PQC keys before signing](payments.md#checking-pqc-keys-before-signing). | Not sent: nothing signed | Fill in the wallet's own inputs first with `walletProcessPsbt(psbt, { sign: false })`, which signs nothing. |
| `PqcSigningError` | `reason: 'no_keys'` | The node reported a PQC state for an input's address, `address`, without its keys. | Not sent: nothing signed | Treat the node as misbehaving; do not sign without the counts. |
| `PqcSigningError` | `reason: 'exhausted'` | A key, `pubkey`, or the address's overall state, is `exhausted`: it signs nothing more, and its inputs would stay unsigned. | Not sent: nothing signed | Rotate to a new key, and keep the address's coins out of coin selection (see [PQC signature budgets](wallet.md#pqc-signature-budgets)). |
| `PqcSigningError` | `reason: 'unknown_state'` | A key or address is in a PQC state this version does not know, `state`: refused, as it may not sign. | Not sent: nothing signed | Check what the qbit Core release says of the state, and update this package. |
| `PqcSigningError` | `reason: 'would_run_out'` | A key, `pubkey`, has fewer signatures left (`remaining`) than the PSBT needs from it (`needed`), so it would run out partway, leaving the inputs after it unsigned. | Not sent: nothing signed | Spend fewer of its inputs in one PSBT, and move its coins to a new address. |
| `RpcError` | | The node answered with an error, under HTTP 200, 400, 404 or 500: `rpcCode` and `message` are the node's. | The node's answer: not an unknown outcome | Handle by `rpcCode`, for example -26 rejected, -25 missing inputs, -27 already confirmed, -14 wrong passphrase, -28 node warming up. |
| `RpcTransportError` | `reason: 'network'` | The connection failed; `code` is the system's, such as `ECONNREFUSED`, or the error's of a [`connect` function](remote-nodes.md#proxies-connect). | Not sent when no connection was made (refused, DNS, a reset during the TLS handshake, `connect` failing); once one exists, an unknown outcome | Retry reads later. |
| `RpcTransportError` | `reason: 'tls'` | The TLS handshake failed or was refused: the node's certificate is not trusted (`code` such as `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `CERT_HAS_EXPIRED`), names another host (`ERR_TLS_CERT_ALTNAME_INVALID`) or carries a key no `tls.pinSha256` names (`EPINMISMATCH`, this package's); a handshake resumed a TLS session, which the client never offers (`ESESSIONRESUMED`, this package's); or the terminator refused the handshake with an alert, such as for a client certificate missing or not trusted (`ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`, `ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE`, `ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`, `EPROTO` before TLS 1.3). See [Remote nodes](remote-nodes.md). | Not sent when the handshake failed before the request was written, as it does under TLS 1.2 and for the client's own checks; an alert after that, under TLS 1.3, is the `cause` of an `RpcUnknownOutcomeError` for a side-effecting call | Fix the `tls` settings or the terminator's. Not retried. A key no pin names can be an attack. |
| `RpcTransportError` | `reason: 'not_loopback'` | `localhost`, in an `http` URL or with cookie authentication, resolved to an address that is not loopback, or to some. See [localhost](remote-nodes.md#localhost). | Not sent | Fix the hosts file or DNS, or put `127.0.0.1` in the URL. Not retried. |
| `RpcTransportError` | `reason: 'prototype_polluted'` | `Object.prototype` has enumerable properties of its own, which something in this process put there, such as JSON parsed into a deep merge that followed `__proto__`; the message says how many. Every call fails until they are gone. See [a polluted `Object.prototype`](remote-nodes.md#a-polluted-objectprototype). | Not sent | Find and remove the pollution, and fix the code that let it in. Not retried. |
| `RpcTransportError` | `reason: 'http_status'` | An HTTP status without the node's JSON-RPC reply, `status`: 401 credentials; 403 `rpcallowip`, or an `-rpcwhitelist` that does not allow a method sent (the chain check needs `getblockhash` and `getnetworkinfo` too); 502, 503 or 504 from a gateway, even with a JSON-RPC error body ([which statuses are the node's](#which-statuses-are-the-nodes)). | Not run for 3xx and 4xx, and for `Work queue depth exceeded` with `directNode`; any other 5xx, and a JSON-RPC error body under a status the node does not use for one, is an unknown outcome | Retry reads later; fix configuration for 401 and 403. |
| `RpcTransportError` | `reason: 'credentials'` | The cookie file could not be read; `code` says why, such as `ENOENT`, or `EMALFORMED`, `ETOOBIG` or `EREAD` from this package. | Not sent | Check the cookie file. |
| `RpcTimeoutError` | | The operation's deadline (`timeoutMs`) expired. | Not sent when it expired waiting for a slot, reading the cookie or before a connection was made; during the re-check it is the `cause` of `check_failed`; after that, an unknown outcome | Retry reads if appropriate. |
| `RpcAbortedError` | | Your `AbortSignal` fired; `cause` is its reason. | As for `RpcTimeoutError` | Your own decision to stop. |
| `RpcResponseTooLargeError` | | The reply passed `maxResponseBytes`, `limitBytes`. | Unknown outcome | Treat the node or proxy as misbehaving; do not guess the value. |
| `RpcResponseError` | `reason: 'protocol'` | The reply was not valid JSON-RPC; `path` says where. | Unknown outcome | Treat the node or proxy as misbehaving; do not guess the value. |
| `RpcResponseError` | `reason: 'validation'` | A result failed validation; `path` says where. For a [custom `parse`](methods.md#batches) that threw, `path` is `result` and `cause` is what it threw. | Unknown outcome | Treat the node or proxy as misbehaving; do not guess the value. |
| `RpcUnknownOutcomeError` | | The call may have been executed, but no valid reply arrived; `cause` is the failure; for `sendrawtransaction` (typed or through `call()`), `txid` is the computed txid, and for `submitpackage` (likewise), `txids` holds one entry per transaction in package order, its txid or `null` where its hex does not parse here, with `txid` unset; for `submitpackage` it is also a node error that can follow the acceptance of part of the package (see [submitting a package](payments.md#submitting-a-package-cpfp)), with that `RpcError` as `cause`; and for `submitblock`, `submitheader` and `submitauxblock` (likewise), `blockHash` names the block. Never retried. | Unknown outcome | Reconcile before acting again: look up `txid` or each of `txids` for a broadcast, `blockHash` with `getBlockHeader` for a block ([mining](mining.md)), re-read wallet state for a signing call, read `getWalletInfo().unlockedUntil` after `walletPassphrase` ([unlocking a wallet](wallet.md#unlocking-an-encrypted-wallet)), and for a wallet-admin call see [wallet administration](wallet-admin.md)'s table. |

A bad argument or option is a `TypeError` or `RangeError`, and nothing is sent.

**Before a side-effecting call is sent.** Each of these rejects without sending it,
with `method` the call's, so any error other than an `RpcUnknownOutcomeError` or a
node's `RpcError` means it did not run:

- a polluted `Object.prototype`, before anything else and at any point below:
  `RpcTransportError` `prototype_polluted`;
- the capability check: `RpcCapabilityError`;
- the guard's first decision, and its last after any wait: `RpcChainGuardError`
  `unconfirmed`, `mismatch` or `unsupported_version`;
- for `walletprocesspsbt`, the PQC check before signing: `PqcSigningError`,
  an `RpcCapabilityError` for `wallet-read`, or the check's own failure, whose
  `method` is `decodepsbt`, `getaddressinfo` or the batch's (an `RpcError`
  among them is the node's answer to the check, not to the signing), and an
  `RpcTimeoutError` about `walletprocesspsbt` when the check used up the
  deadline;
- a signal already aborted: `RpcAbortedError`;
- the wait for a request slot: `RpcTimeoutError` or `RpcAbortedError`;
- the cookie read: `RpcTransportError` `credentials`, or `RpcTimeoutError` or
  `RpcAbortedError`;
- the chain re-check, and a wait before checking again that is cut short:
  `RpcChainGuardError` `check_failed`;
- chain checks that kept being overtaken, or a wait that would pass the deadline:
  `RpcChainGuardError` `stale`;
- the connection, before one exists: `RpcTransportError` `network`, `tls` or
  `not_loopback`, a `TypeError` for a `connect` function that returned no new stream, or `RpcTimeoutError` or
  `RpcAbortedError`. A TLS alert after the request was written, under TLS 1.3,
  is not among these;
- HTTP 3xx and 4xx, unless with a JSON-RPC error body under a status other than
  400 and 404, and `Work queue depth exceeded` with `directNode`:
  `RpcTransportError` `http_status`, rejected without running it.

Retries, deadlines and connections work like this:

- **Retries** happen only for methods without side effects, only when
  `readRetries` is set (apart from the keep-alive retry below), and only for
  connection errors (`network`, not `tls`, `not_loopback` or
  `prototype_polluted`), HTTP 5xx, cookie read failures, HTTP 401 under cookie
  auth (the cookie may have rotated), and (single calls and the chain check)
  RPC error -28 while the node warms up. Side-effecting calls are never
  retried. `network` includes an option Node refuses as it opens a connection,
  one a non-enumerable property of `Object.prototype` can supply: such a read
  gets the same refusal on each of its retries, unsent.
- **Deadline.** `timeoutMs` covers the whole operation: any wait for a request
  slot, cookie read, every attempt, every backoff and every item of a batch. On
  expiry the request is destroyed and its socket released. `walletProcessPsbt`'s operation includes its
  PQC check: its `decodepsbt`, its `getaddressinfo` batches and the signing
  share one deadline, from when the call starts, and the caller's signal.
- **Keep-alive.** Methods without side effects, batches and the chain re-check
  share a pool of keep-alive connections sized to `maxConcurrentRequests`
  (default 8), plus one spare for a connection still closing; open requests
  stay within the limit. The client closes one after 15 s idle, before
  qbitd's `-rpcservertimeout` (30 s by default) does. With a
  `-rpcservertimeout` below 15 s qbitd closes idle connections first, and the
  race below happens more often: each one costs an extra attempt and a chain
  re-check. A request written to a connection just as qbitd closes it is reset
  before any reply. A request without side effects that is reset this way
  (`ECONNRESET` or `EPIPE` on a reused connection, or one kept after its read
  gave up, within 1 s of going out and before any byte of the reply) gets one more attempt at once, under the
  same deadline, even with `readRetries: 0` and not counted in it, and the
  other idle connections are closed first. The reset makes the chain
  confirmation stale, since a qbitd restart looks the same, and the attempt
  takes the normal path: the cookie is read again, and `finalizepsbt` and
  `testmempoolaccept` re-check the chain before they are sent again. If it
  fails, its error is reported like any connection error. The chain re-check
  before a wallet-write, broadcast, mining or wallet-admin call gets the same extra attempt: the call
  itself has not been sent yet, and goes out once, after a check that succeeds.
  A later reset (the node failing during a request), any other error and a
  reply that began get no extra attempt, so a proxy in between is covered only
  if it closes idle connections silently: one that answers first (HTTP 408) is
  not retried.
- Side-effecting calls use a fresh connection each, through `connect` too,
  so a stale keep-alive socket cannot turn into an unknown outcome, and are
  never sent twice.
- A wallet `RpcError` means the node answered with an error. For
  `walletprocesspsbt`, qbit Core may still have advanced the PQC signature
  counters of keys it tried.

## Which statuses are the node's

`qbitd` puts a JSON-RPC error body on three HTTP error statuses and no others:
400 for `-32600`, 404 for `-32601` and 500 for any other code. A body naming the
request's id is the node's answer under those, an `RpcError`, as it is under 200.
Under any other status something in between read the request and answered for
itself, as a JSON-RPC-aware gateway or load balancer does with a 502, 503 or 504
when it times out after forwarding a `sendrawtransaction`. The body is ignored:
a read fails with `RpcTransportError` `http_status`, and a side-effecting call
with an `RpcUnknownOutcomeError` whose `cause` that is, at 3xx and 4xx too.
`directNode` does not widen the three, as `qbitd` sends no such body under another
status; one there means something does sit in between. The client cannot tell a
gateway that answers such a body under 200, 400, 404 or 500 from the node: use
one that leaves those to the node.

## The work queue

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
