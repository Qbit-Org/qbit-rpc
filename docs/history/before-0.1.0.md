# Before 0.1.0: the review history

How `@qbit-oss/rpc` and `@qbit-oss/zmq` changed between the first commit and
the `0.1.0` release candidate, change by change, as `CHANGELOG.md` recorded it
while nothing was published. It is kept for maintainers: it says why the code
is the way it is, and which review found what. None of it describes a change
from one published version to another. For what `0.1.0` ships, read its
section in [CHANGELOG.md](../../CHANGELOG.md).

The text below is the `Unreleased` section as it stood when it moved here,
unchanged apart from its headings, each one level up, and its one relative
link, which now points from this directory.

## Breaking: remote nodes, TLS failures, how `localhost` is trusted, and a polluted `Object.prototype`

Settled before `0.1.0`: cleartext credentials, and a cookie at all, go to
loopback addresses only, whatever a name resolves to, a node behind a TLS
terminator can be reached with a private CA, a client certificate and pinned
keys, directly or through a proxy, and a polluted `Object.prototype` is
refused rather than read.

- `localhost` is no longer trusted by name. With an `http` URL, or with cookie
  authentication, every connection resolves it with the system resolver and is
  refused before anything is sent, with `RpcTransportError`
  `reason: 'not_loopback'` (not retried), unless every address is loopback:
  127.0.0.0/8, `::1`, or IPv4 loopback mapped to IPv6. Node connects to the
  addresses checked. A hosts file or container DNS that sent `localhost`
  elsewhere, even in part, used to get the Basic credentials or the cookie in
  cleartext. Any other name with `http` is still a `TypeError`.
- `http://[::ffff:127.0.0.1]/`, IPv4 loopback mapped to IPv6, is now loopback,
  as that answer for `localhost` is; it was a `TypeError`.
- A failed or refused TLS handshake is `RpcTransportError` `reason: 'tls'`,
  not `network`, with the same `code` (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
  `ERR_TLS_CERT_ALTNAME_INVALID`, `CERT_HAS_EXPIRED` and so on), and is no
  longer retried under `readRetries`, as a retry would only repeat it. A reset
  during the handshake stays `network`. So is a TLS alert refusing the
  handshake once the request was written, as under TLS 1.3 for a client
  certificate missing or not trusted (`ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`,
  `ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE`): a read fails with `tls`, and a
  side-effecting call stays an `RpcUnknownOutcomeError`, its `cause` now `tls`
  where it was `network`, since only the terminator says it passed nothing
  on. Before the request is written, as under TLS 1.2, such an alert is a
  definite `tls`. An error Node throws as it builds a connection is `tls` for a
  TLS or OpenSSL error (`ERR_TLS_*`, `ERR_SSL_*`, `ERR_OSSL_*`) and `network`
  for the socket's, such as an option it refuses, both with nothing sent.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` no longer turns certificate verification
  off: the client sets it on for every connection. For an `https` URL it used
  to turn off the CA and name checks, Node's default for that variable.
- A call is refused, with nothing sent, while `Object.prototype` has an
  enumerable property of its own: `RpcTransportError` with the new `reason:
  'prototype_polluted'`, checked at the start of every call, once a client
  method has built its request and before the call options, the capability or
  the chain are checked, and again before every connection and every request,
  pooled ones included, never retried, with no option to turn it off. The
  message gives how many such properties there are, not their names. Nothing
  in the language or in Node puts one there; JSON parsed into a deep merge
  that followed `__proto__` does, and Node reads connection options, socket
  state and certificate fields from objects that inherit it. Find and remove
  the pollution. Non-enumerable properties, as polyfills define, are not
  refused; the caller's objects and the node's replies are still read as own
  properties only, as below. Behind that check, the client also sets every option Node 22.13 and 24
  read from the objects it passes to `net.connect`, `tls.connect`,
  `http.request`, `https.request` and `dns.lookup` (now with
  `captureRejections`, the lookup's `order` and `verbatim`, and an own valid
  `timeout` on each request), and reads the certificate's `subject`,
  `subjectaltname` and `raw` as its own properties only: Node 22 leaves
  `subjectaltname` unset on a certificate without one, and its name check read
  the prototype's. What Node reads from objects it builds itself (the socket
  under a TLS socket, stream state, a socket's `blockList`) is out of reach:
  a polluted prototype can still make calls fail there, but none of the keys
  checked lets a check be skipped or credentials leave loopback. Pollution that
  lands after the check can still crash the process inside Node, and an
  application must remove it: `blockList` and `handshakeTimeout` on Node 22.13
  and 24, `infoAccess` on Node 22.13.
- No TLS session is resumed: every connection runs a full handshake, as Node
  skips the certificate checks on a resumed session. Node's https agent cached
  sessions for pooled connections before. A handshake that resumes one all the
  same, as the client never offers one, is a definite `tls` with `code:
  'ESESSIONRESUMED'`, with nothing sent. Without `tls.ca`
  or `tls.cert`, each client builds Node's default TLS context once, at its first
  connection, rather than for every connection, so later changes to Node's TLS
  defaults (`tls.setDefaultCACertificates()`, `tls.DEFAULT_MIN_VERSION`,
  `tls.DEFAULT_CIPHERS`) reach only clients that have not connected yet.

Added, and not breaking:

- The `tls` option, for an `https` URL: `ca` (PEM CAs that replace the
  system's), `cert` and `key` (a client certificate, and `passphrase` for an
  encrypted key, used once and not kept), `servername` (the name to check and
  send in SNI) and `pinSha256` (base64 SHA-256 of the node's
  SubjectPublicKeyInfo, several for rotation). Each is checked at
  construction, a `TypeError` naming the option and never its contents; there
  is no way to turn verification off. A key matching no pin is `tls` with
  `code: 'EPINMISMATCH'`. The pins are checked on every connection, pooled or
  fresh, after the CA and name checks.
- The `connect` option: a function that opens the stream for each connection,
  such as a tunnel through an HTTP CONNECT or SOCKS proxy, with no proxy code
  or dependency in the package. The client runs TLS over the stream with every
  check, pools connections for reads, calls `connect` again for each
  side-effecting call, keeps `maxConcurrentRequests`, the stale-connection
  retry and each call's deadline. A side-effecting call's connection gets the
  call's deadline and abort as its signal, which also ends the TLS handshake
  over its stream. A pooled connection, for reads, outlives the read it is
  opened for, and Node's pool can open one by itself, for a request queued
  behind a full pool. Once no read waits for it, its signal fires when the
  client's `timeoutMs` has passed since it started, or at once when a read that
  waits needs its turn, and on `close()` at any time. One that opens after its
  read gave up waits, idle, for the pool's next connection, keeping no process
  alive, and a reset on it gets the extra attempt of a stale keep-alive
  connection, so a proxy slower than a read's deadline still serves the reads
  after it, and a `connect` with no timeout of its own that honours its signal
  gives back its turn. At most `maxConcurrentRequests` plus one connections are
  opened through `connect` at once for reads, and as many again for
  side-effecting calls, which never wait behind reads' connections; a call
  waiting for one fails at its deadline, unsent, and one for a read that gave up
  is dropped without calling `connect`. A pooled connection's failure reaches
  only the read it serves by then, never one in flight on another connection,
  and the next read queued opens its own after one Node's pool opened by itself.
  It needs an `https` URL and Basic credentials. A stream returned twice, or
  destroyed without an error, is a `TypeError`; one that has already failed,
  one that closes before its handshake has ended (`ECONNRESET`), and a failure
  of `connect`, are `RpcTransportError` `network` with nothing sent.
- `toJSON()` shows what `tls` sets (a custom CA, a client certificate,
  `servername`, the pins), and `connect: 'custom'`. The types `RpcTlsOptions`,
  `RpcConnect` and `RpcConnectTarget` are exported.
- The `@qbit-oss/rpc` README's "Remote nodes" covers a TLS terminator, a
  private CA, client certificates, pinning and its rotation, a proxy through
  `connect`, `localhost` and a polluted `Object.prototype`; its failure model
  lists `tls`, `not_loopback` and `prototype_polluted`.

## Supported qbit Core versions, and values a later one may add

The packages support **qbit Core 1.0.x releases**. The range is defined once
(`packages/rpc/src/version.ts`) and widened only after the regtest smoke test
passes against a new minor version, and `@qbit-oss/rpc` checks the node's
version. A value a later qbit Core may add passes through where the rest of the
result keeps its meaning, and fails validation where it does not.

- Every chain check, `confirmChain()`'s and the re-check before a wallet-write
  or broadcast call, also sends `getnetworkinfo` in its batch, and exposes the
  version as `rpc.nodeVersion` (`version`, `subversion`, `major`, `minor`,
  `patch`, `supported`; frozen and without a prototype, as results are). A node outside qbit Core 1.0.x releases (`1.1.0`,
  `1.0.1-rc1`, another client's user agent) refuses wallet-write and broadcast
  calls, unsent, with `RpcChainGuardError` `reason: 'unsupported_version'`
  (`nodeVersion` says which), until a `confirmChain()` finds a supported one;
  `confirmChain()` throws it, and `chainStatus` is `unsupported_version`.
  `allowUnsupportedNodeVersion: true` accepts the risk of another version, so a
  node on a new qbit Core minor (1.1 or later) needs a release of this package
  that supports it, or that flag.

  ```ts
  if (RpcChainGuardError.is(error) && error.reason === 'unsupported_version') {
    // nothing was sent; error.nodeVersion?.subversion is the node's, such as '/qbit:1.1.0/'
  }
  ```

- Where `-rpcwhitelist` applies, the RPC user also needs `getnetworkinfo`:
  qbitd answers a batch holding a method the user may not call with HTTP 403,
  so every check fails without it (`confirmChain()` with `RpcTransportError`
  `http_status` 403, a guarded call with `check_failed`). The check's reply is
  about 2 KiB.
- A `getnetworkinfo` reply whose `version` or `subversion` does not parse, or
  whose two disagree, fails the check: `RpcResponseError` about
  `getnetworkinfo` from `confirmChain()`, `check_failed` with it as `cause` for
  a guarded call, whatever `allowUnsupportedNodeVersion` says. It is never
  taken for a supported version. `getNetworkInfo()` reads the two with the
  same reader, so it fails on the same reply, at the same path: its `version`
  is an integer from 0 to 2,147,483,647, and its `subversion` a user agent of
  that form.
- A recorded `mismatch` stands over an unsupported version until a
  `confirmChain()` begun after it reads a whole chain report (valid
  `getblockchaininfo` and `getblockhash 0` replies) that matches: a check whose
  report failed keeps the mismatch, and `confirmChain()` throws it.
- Open enums take a value a later qbit Core adds, as any non-empty string:
  `BlockchainInfo.chain` (`QbitChain | (string & {})`; in a chain check an
  unknown name is a `mismatch`), `ConfirmationTarget.model.hashrateSource`,
  `WalletInfo.pqcKeyValidation.status` and `PqcLimitState`. A `switch` over one
  needs a `default`, and a copy of the known values, such as a `CoreRpc`
  interface's `PqcLimitState`, needs `(string & {})` for `QbitRpcClient` to
  satisfy it. Treat a PQC state you do not know as at least `critical`:

  ```ts
  type PqcLimitState = 'normal' | 'warning' | 'critical' | 'exhausted' | (string & {})
  if (state !== 'normal' && state !== 'warning') rotate() // an unknown state too
  ```

- `WalletInfo.payTxFeeBitsPerKvB` is optional, as Bitcoin Core has deprecated
  `paytxfee`; absent means no fee rate is set.
- Closed, failing validation on another value: `WalletTxCategory` (the sign and
  fee checks depend on it), `bip125Replaceable` and `SecurityLevel`.

New with this: `QbitRpcClient.nodeVersion`, the `NodeVersion` type, the
`allowUnsupportedNodeVersion` option, `nodeVersion` in `toJSON()` and on
`RpcChainGuardError`, the supported versions in both READMEs, and the
`@qbit-oss/rpc` README's "Versions and compatibility", which lists every enum's
rule.

## Breaking: the error API

Settled before `0.1.0`: a property name has one type across both packages' error
classes and the `@qbit-oss/zmq` events, and a side-effecting call rejects with a
documented "not sent" error or `RpcUnknownOutcomeError`, never with a bare error
about another method.

- `RpcError.code` is now `RpcError.rpcCode`. `code` is a string wherever it remains
  (`RpcTransportError`, `ZmqFrameError`, `ZmqSetupError`, a `reconnect` event). The
  compiler cannot catch this where an error is `unknown` or cast, so search for it:
  `error.code === -5` is never true again, and `typeof error.code === 'number'`
  takes every node answer for no answer.

  ```ts
  if (RpcError.is(error) && error.code === -5) // before
  if (RpcError.is(error) && error.rpcCode === -5) // now
  const code = (error as { rpcCode?: unknown }).rpcCode // a structural check, now
  ```

- `RpcChainGuardError.expected` and `.actual` are now `.expectedChain` and
  `.actualChain`, like `expectedGenesisHash` beside them: `expected` was a chain name
  there and a counter on a `gap` event.
- A failed chain re-check before a wallet-write or broadcast call rejects with
  `RpcChainGuardError` `reason: 'check_failed'`, with `method` the call's and the
  failure as `cause`. It used to be a bare `RpcTimeoutError`, `RpcAbortedError`,
  `RpcTransportError`, `RpcError`, `RpcResponseError` or
  `RpcResponseTooLargeError` about `getblockchaininfo` or `getblockhash`.
  `confirmChain()`, which is that check, still throws those as they are.

  ```ts
  // before: a re-check's -28 looked like the node's answer to the call
  if (RpcError.is(error) && error.code === -28) wait()
  // now
  if (RpcChainGuardError.is(error) && error.reason === 'check_failed') {
    // nothing was sent; error.cause is the failure, with its own type
    if (RpcError.is(error.cause) && error.cause.rpcCode === -28) wait()
  }
  ```

- Code that takes `name === 'RpcChainGuardError'` to mean "another chain" must read
  `reason === 'mismatch'`: `check_failed` is a node that could not be checked.
- `RpcChainGuardError`'s constructor takes `(method, reason, expectedChain, {
  actualChain?, mismatch?, cause? })` in place of `(method, reason, expected, actual?,
  mismatch?)`.
- A request's `parse` that throws anything rejects with `RpcResponseError` (`reason:
  'validation'`, `path: 'result'`) with the thrown value as `cause`, for a single call
  and as a batch entry's own error; after a side-effecting call, as the `cause` of an
  `RpcUnknownOutcomeError`. It used to reject with the thrown value, and to reject the
  whole batch. Catch `RpcResponseError`, and read `cause`, where you caught your own
  exception. The built-in validators' failures are unchanged. A `batch()` entry
  without a `parse` function is a `TypeError`, and nothing is sent.
- `reconnect.code` is typed `ZmqReconnectCode`, a union of the codes libzmq raises
  here that stays open for any other string. Every string is still accepted, but an
  exhaustive `switch` should keep a `default`.

Added, and not breaking: `ZmqFrameError.is()`, with a `Symbol.for` brand as on
`ZmqSetupError`, for an error from the package's other build; the types
`RpcChainGuardReason` and `ZmqReconnectCode`; and one table of errors in each
package's README, which a test keeps equal to the code. The error tables that were
in the repository README and the `@qbit-oss/zmq` connection section moved into those.

## Breaking: method and option shapes, and the public exports

Settled before `0.1.0`: one call-options shape for every method, no inverted
flag, no zero that means "unlimited", argument ranges as qbit Core v1.0.0 reads
them, and a smaller set of exports. `etc/rpc.api.md` and `etc/zmq.api.md` now
record each package's public API, and CI fails when the built declarations
differ from them.

- Every client method takes its call options (`signal`, `timeoutMs`) as a
  separate last argument. Methods with options of their own took both in one
  object: `getRawTransaction`, `getRawTransactionVerbose`, `getTxOut`,
  `getConfirmationTarget`, `estimateSmartFee`, `testMempoolAccept`,
  `sendRawTransaction`, `listUnspent`, `listSinceBlock`, `listTransactions`,
  `walletProcessPsbt`, `finalizePsbt`, `psbtBumpFee`, `getRawChangeAddress`,
  `getNewAddress` and `lockUnspent`. Passing a call option there is now a
  `TypeError` that says where it goes, so nothing is dropped silently. Methods
  without options of their own (`getBlockCount(callOptions)`,
  `walletCreateFundedPsbt(args, callOptions)`, `call`, `batch`, `confirmChain`)
  take them where they did. The parameter is named `callOptions`, and so are
  its errors (`callOptions.timeoutMs must be ...`).

  ```ts
  await rpc.getTxOut(txid, vout, { includeMempool: true, timeoutMs: 5_000 }) // before
  await rpc.getTxOut(txid, vout, { includeMempool: true }, { timeoutMs: 5_000 }) // now
  await rpc.listUnspent({ minConf: 1, signal }) // before
  await rpc.listUnspent({ minConf: 1 }, { signal }) // now
  await rpc.sendRawTransaction(hex, { signal }) // before
  await rpc.sendRawTransaction(hex, undefined, { signal }) // now
  ```

- `lockUnspent(unlock, outputs, options)` copied `lockunspent`'s inverted flag,
  where `false` locks. `lockUnspent(outputs, { persistent })` now locks and
  `unlockUnspent(outputs)` unlocks; `unlockUnspent` takes no `persistent`, which
  qbit Core ignores when unlocking (an unlock clears persistent locks too). Both
  resolve with nothing, not `true`: qbit Core answers `true` or an error, and
  any other reply now fails validation. `requests.lockUnspent` and
  `requests.unlockUnspent` change the same way. To unlock every output, still
  use `call('lockunspent', [true])`.

  ```ts
  await rpc.lockUnspent(false, outputs, { persistent: true }) // before: locks
  await rpc.lockUnspent(outputs, { persistent: true }) // now
  await rpc.lockUnspent(true, outputs) // before: unlocks
  await rpc.unlockUnspent(outputs) // now
  ```

- `maxFeeRateBitsPerKvB: 0n` (`testMempoolAccept`, `sendRawTransaction`) is a
  `RangeError`. qbit Core reads a `maxfeerate` of 0 as no cap at all, the
  opposite of a cap of zero. Leave the option out for qbit Core's default cap,
  0.10 QBT/kvB (`10_000_000n`); pass a cap from `1n` to `99_999_999n`; or, to
  send with no cap, `call('sendrawtransaction', [hex, 0])`.
- Argument ranges are qbit Core v1.0.0's (`getInt<uint32_t>` or `getInt<int>`
  where each is read, and the policy limits it checks):
  - `getTxOut`'s `vout` takes 0 to 4,294,967,295; it stopped at 2,147,483,647.
  - An input's `vout` in `walletCreateFundedPsbt` stops at 2,147,483,647, as in
    `lockUnspent`; it took up to 4,294,967,295, which the node refused (-1).
  - `walletCreateFundedPsbt`'s `version` is 1 to 3 (it took up to
    4,294,967,295; the node refused anything above 3 with -8), and
    `options.maxTxWeight` 65 to 400,000 (it took 1 to 2,147,483,647; the node
    refused the rest with -4).
- `addressType` (`getNewAddress`, `getRawChangeAddress`) and
  `options.changeType` (`walletCreateFundedPsbt`) are typed `AddressType`,
  `'p2mr' | 'bech32m' | 'bech32' | 'p2sh-segwit' | 'legacy'`, the names qbit
  Core v1.0.0 parses, and any other string is a `RangeError` before sending
  (an empty or non-string one was a `TypeError`; an unknown name was the node's
  -5). A `string` variable no longer compiles there: type it `AddressType`.
  Which types a chain allows is unchanged, and still the node's -5: only `p2mr`
  on every chain but regtest with `-p2mronly=0`.
- No longer exported from `@qbit-oss/rpc`: `METHOD_POLICIES` and `MethodPolicy`
  (the README's allowlist table documents it, and a test keeps the two equal),
  `CAPABILITIES`, `QBIT_CHAINS`, `QBIT_GENESIS_HASHES` and
  `QBIT_DEFAULT_SIGNET_CHALLENGE`. The `Capability` and `QbitChain` types stay;
  the README lists the genesis hashes, and `client.toJSON()` shows the one a
  client uses. Keep a copy of a list you need.
- No longer exported from `@qbit-oss/zmq`: `SequenceTracker` (the subscriber's
  `gap` events report what it found), `ZMQ_TOPICS` (the `ZmqTopic` type names
  them), `DEFAULT_MAX_MESSAGE_SIZE` (2,065,536) and `DEFAULT_STALE_AFTER_MS`
  (600,000). `createZeromqSocket` stays, for a custom `socketFactory` that wraps
  the default socket. `ZmqMessage` is written as one intersection, with the same
  members.

Added, and not breaking: `AddressType`; the API reports, `pnpm api:check` (part
of `pnpm verify`) and `pnpm api:update`, with API Extractor 7.59.4 as a
development dependency.

## Breaking: options and replies are read from own properties only

A polluted `Object.prototype`, as an application's JSON merge of attacker input
makes one, supplies no value to a request and no field to a result:
`@qbit-oss/rpc` reads the caller's options and the node's replies from their own
properties only. The API report is unchanged.

- Every options or arguments object (`args`, `inputs` and `outputs` entries,
  `options`, `proof`), the call options (every client method, `call()`,
  `batch()`, `confirmChain()`), the `QbitRpcClient` options and their `auth`
  and `tls`, and each `batch()` entry's `method`, `params` and `parse` are read from a
  copy of their own enumerable properties, each read once. A key the method
  takes that the object holds any other way is a `TypeError` naming it, which
  says to pass a plain object: an inherited key (from a prototype, a class or a
  polluted `Object.prototype`), a class getter or method, a non-enumerable
  property, or a key a Proxy leaves out of its own keys or answers only from
  its `get` trap. So a polluted `capabilities`, `wallet`, `directNode`,
  `chainCheckMaxAgeMs`, `password`, `tls`, `connect` or `tls.ca` refuses the
  constructor instead of configuring the client; ignored instead, a `tls`, `ca`
  or `pinSha256` given so would leave the client trusting more than was asked
  for. A batch entry that is a class instance with a `parse` method is refused;
  copy its fields into a plain object. A getter on the object itself runs once, into the copy:
  the builders no longer keep the caller's object so that a getter keeps its
  receiver. An options object left out reads as empty. Unknown keys are refused
  with the same messages as before, and one only on `Object.prototype` is still
  skipped, as it is never read.
- The `QbitRpcClient` options, `auth` and `tls` are strict like every other
  options object: an unknown key is a `TypeError` naming it, with the key it
  most likely meant (`timeout` → `timeoutMs`, `cookie_file` → `cookieFile`,
  `server_name` → `tls.servername`) or the known keys. So `walletName` refuses the constructor, where it built a client without
  a wallet path, whose wallet calls went to whichever wallet the node had loaded.
- `capabilities: null` is a `TypeError` (`capabilities must be an array`), and
  so is `parseQbt(text, null)` (`options must be an object`).
- A `batch()` entry's `method` must be a non-empty primitive string, a
  `TypeError` otherwise: a `String` object or an object with `toJSON` could pass
  the capability check as one method and be sent as another. An empty method is
  a `TypeError`, not `RpcCapabilityError` `unknown_method`. A batch over 1,000
  entries is refused from its length before its entries are read.
- An HTTP error body that holds a node error and also a non-null `result`
  contradicts itself: it is not a definite `RpcError` but the HTTP error it came
  with, an unknown outcome for a side-effecting call, as such a body is at HTTP
  200.
- A JSON-RPC error body naming the request's id is a definite `RpcError` only
  under HTTP 400, 404 and 500, the statuses `qbitd` itself puts on one, as it
  is under 200. Under any other it was one too, so a JSON-RPC-aware gateway or
  load balancer that timed out after forwarding a `sendRawTransaction` and
  answered 502, 503 or 504 read as a definite failure, and a caller could pay
  twice. Now it is the HTTP error it came with: `RpcTransportError`
  `http_status` for a read, retried as usual, and an `RpcUnknownOutcomeError`
  for a side-effecting call, at 3xx and 4xx too, with or without `directNode`.
- Arrays (`outputs`, `inputs`, `subtractFeeFromOutputs`, `addresses`,
  `rawTxs`, the outputs of `lockUnspent` and `unlockUnspent`, `call()`'s
  params, the `capabilities` option, `tls.ca`, `tls.pinSha256` and `batch()`'s
  entries) are read by their
  own elements: a hole is a `TypeError` naming its index, and no element is
  read from `Array.prototype`.
- Parameters are serialized from own data: an object's own enumerable keys and
  an array's own elements, where a hole at any depth is a `TypeError`. A
  `toJSON` applies when the object or its class defines it (`JsonNumber`,
  `Date`), never one on `Object.prototype` or `Array.prototype`, and a `bigint`
  is an integer literal even with `BigInt.prototype.toJSON` set. A request body
  nests at most 512 arrays and objects, as deep as qbit Core v1.0.0 parses, its
  envelope included: the request object is one level, so `call()`'s params, the
  params array included, nest at most 511, and a batch's array is one more, so a
  `batch()` entry's nest at most 510. Deeper parameters are a `TypeError` before
  anything is sent, where the node answered HTTP 500 `Parse error` (for a
  side-effecting call, an unknown outcome): `requests.raw()` refuses more than
  511, and `batch()` refuses more than 510 with `batch() entry <index>: ` before
  the message. Every `TypeError` from serializing an entry names it the same way.
- `requests.raw()`, which `call()` uses, serializes its params once, when it
  builds the request, and the request's `params` are those as sent, parsed
  back without loss: every number a `JsonNumber`, every object without a
  prototype. A `toJSON` or a getter in them runs once, so the check for options
  qbit Core ignores sees what is sent. A hole, `NaN`, a cycle or too deep a
  nesting anywhere in them throws from `requests.raw()`, so `call()` rejects.
- Results are null-prototype objects: every object in a typed result, in
  `call()`'s result and in the reply a batch entry's `parse` gets. An absent
  field, such as `blockHash` on an unconfirmed transaction or `address` on an
  OP_RETURN output, reads as `undefined` even if `Object.prototype` is polluted
  after the reply arrives. The contents are unchanged. `toStrictEqual` and
  `assert.deepStrictEqual` against a plain object literal fail, a result object
  has no `hasOwnProperty` or `toString`, and `String()` or a template string
  throws on one; spread a result into `{}` for a plain object. Request objects
  from `requests` have no prototype either.
- A reply's `jsonrpc`, `id`, `result` and `error`, and an error's `code` and
  `message`, are read as own properties only. With `Object.prototype.error`
  set, a successful reply stays a success, and a broadcast the node accepted
  resolves with its txid; it rejected as a definite failure. A node error
  without its own `message` is a malformed reply (`RpcResponseError`, `reason:
  'protocol'`), and so is an `error` that is not an object (an array, a number,
  a string): for a side-effecting call, an unknown outcome. With `code` and
  `message` on a polluted `Object.prototype`, a reply with `"error":[]`, at HTTP
  200 or 5xx, was a definite `RpcError`. An HTTP error body that is an array or
  a number is no JSON-RPC answer either.
- The error classes take `cause`, `status`, `code` and the chain guard's
  details from their arguments' own properties only, so none of their
  properties or messages takes a value from `Object.prototype`. Every error has
  its own `cause`, `undefined` when none was given, not enumerable, writable
  and configurable as `Error` makes one: `'cause' in error` is always true, and
  `util.inspect` shows `[cause]: undefined`.
- `parseQbt(text, options)` reads `allowNegative` as an own property: options
  left out read as empty, and an inherited `allowNegative` is a `TypeError`. A
  reply amount that cannot be negative is refused when negative, whatever
  `Object.prototype.allowNegative` holds.

## @qbit-oss/rpc

- `QbitRpcClient` for qbit Core v1.0.0 JSON-RPC over HTTP(S), with `/wallet/<name>`
  endpoints, HTTP Basic or cookie authentication (the cookie re-read per
  request, loopback only) and refusal of cleartext credentials to non-loopback
  hosts, checked on the address each connection goes to.
- A method allowlist with opt-in `wallet-read`, `wallet-write` and `broadcast`
  capabilities, enforced before any request, for typed methods, `call()` and
  `batch()` alike. `sendmany` and the other sign-and-broadcast methods are not
  allowlisted.
- A chain guard: wallet-write and broadcast calls wait for `confirmChain()`.
- The chain guard pins the chain by its genesis block, and a signet by its
  challenge. Every check sends `getblockchaininfo` and `getblockhash 0` as one
  JSON-RPC batch under the call's deadline, and compares the chain name, the
  genesis hash (`expectedGenesisHash`, by default qbit Core v1.0.0's for
  `expectedChain`) and, on signet,
  `signet_challenge` (`expectedSignetChallenge`, default `51`). This is
  stricter: a node of a custom chain that reports a known name, or of another
  signet, is now refused with `mismatch`, and `RpcChainGuardError.differs` says
  what differed; set the new options for such a node. Where `-rpcwhitelist`
  applies, the RPC user also needs `getblockhash`, and a proxy in between must
  pass batches.
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
- A typed, validated `psbtBumpFee` (`psbtbumpfee`, wallet-write) bumps a stuck
  payment's fee with RBF and returns the replacement as an unsigned PSBT, for
  the sign, store and broadcast steps. It was left out as signing and
  broadcasting, which only `bumpfee` does. It is side-effecting (never retried,
  unknown outcome when the reply is lost), as it can take change keys from the
  keypool for good. Options, errors and replies were checked against a qbit
  Core v1.0.0 regtest node, and the smoke test bumps and replaces a payment.

## @qbit-oss/zmq

- `parseZmqMessage` for the `hashblock`, `hashtx`, `rawblock`, `rawtx` and
  `sequence` topics, rejecting malformed frames with `ZmqFrameError`.
- `QbitZmqSubscriber`: an async iterator of messages, per-topic sequence gaps,
  malformed messages and socket replacements, with `health()` reporting
  `unknown` until a message arrives, and clean `close()`.
- Hashes are reported in the byte order qbitd sends, which is the RPC display
  order. The parser this was ported from reversed them a second time.
- `QbitZmqSubscriber` checks `url` in the constructor, which throws a
  `TypeError` unless it is `tcp://<host>:<port>` (an IPv4 address, a bracketed
  IPv6 address or a host name, a port from 1 to 65535, optionally after a
  libzmq source address) or `ipc://<path>`: `tcp://127.0.0.1`,
  `tcp://127.0.0.1:notaport` and `tcp://*:28332` no longer reconnect forever.
  A `zeromq` addon that cannot be loaded, a custom factory's module-load error,
  and `EINVAL`, `ENAMETOOLONG` or `EPROTONOSUPPORT` from `connect()` end the
  iteration with the new `ZmqSetupError` (`code`, `cause`) and leave the
  subscriber `closed`; a node that is down is still retried. Socket
  factories receive `ipv6`, true for an IPv6 address, and
  `createZeromqSocket` applies it: an IPv6 address could not be reached
  before.

## Review fixes

- An unknown-key `TypeError` names the key only when it is a near-miss of a
  known one, or a short identifier in an options object, as option names are.
  The keys of an array entry such as `outputs[0]`, where the node's own
  `{ "<address>": amount }` format puts data, and any other key are "an unknown
  key (not shown)", so messages never include request parameters.
  `psbtBumpFee`, `walletCreateFundedPsbt`'s options and each output read the
  values a check relates once, so a getter cannot pass the check and then send
  something else. The wallet-history and
  reconciliation docs count an original and its replacements as one payment,
  the mined one once one is mined, even when it is the original and carries
  `replacedByTxid`.
- `@qbit-oss/zmq`: a dotted quad with a decimal part over 255 is refused even
  when another part has a leading zero (`tcp://300.0.0.01:28332`).
- `walletCreateFundedPsbt` sends `subtractFeeFromOutputs` under the name qbit
  Core reads. It sent `subtract_fee_from_outputs`, which the node accepts and
  ignores, so the wallet paid fees meant to come out of the recipient's
  output. Every option name sent to `walletcreatefundedpsbt` and `listunspent`
  is now checked against a live node in the regtest smoke test.
- Every typed method and request builder rejects an unknown option or argument
  key, at every level, with a `TypeError` that names it and the key it most
  likely meant, before anything is sent. They used to drop it silently, so
  `{ subtract_fee_from_outputs: [0] }` sent no fee subtraction. `call()`
  refuses `walletcreatefundedpsbt` options qbit Core v1.0.0 accepts and then
  ignores (`subtract_fee_from_outputs`).
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
- CI runs `verify` on Node.js 22.13.0, the `engines` floor, and on the newest
  22.x, 24.x and 26.x, where it ran Node.js 22 only, with `verify` passing only
  when all of them pass, and loads `zeromq` on macOS arm64 and Linux arm64 in
  manual runs. The README says what CI tests and what `engines` accepts
  untested: Node.js 27 and later, and the other platforms `zeromq` ships a
  prebuilt addon for.
- CI runs the regtest smoke test on every pull request and push to `main`
  (job `regtest smoke`), against qbit Core v1.0.0 downloaded only after
  `SHA256SUMS` verifies against 3 of the 5 `mainnet` release keys committed in
  `scripts/qbit-release-keys/` and the tarball against `SHA256SUMS`, cached by
  its SHA-256. The ZMQ smoke test now covers all five topics, both `sequence`
  body lengths, an RBF replacement's `mempool_removed`, a qbitd restart and
  `maxMessageSize`.
- `getRawTransaction` fails a reply whose hex does not hash to the requested
  txid, or is not a complete transaction, with `RpcResponseError` (`reason:
  'validation'`), as the verbose form does. `getAddressInfo` ignores case in
  the reply's address only when both it and the requested one are bech32 or
  bech32m, and compares a base58 address exactly. `parseQbt('-0')` and
  `parseQbt('-0.00000000')` return `0n` without `allowNegative`, and a number
  argument of `-0` is sent as `0`. A number field of a typed method's result
  written `-0` or `-0.0`, an integer such as a `vout` or `confirmations` or any
  other finite number, is read as `0`, never `-0`.
- `@qbit-oss/zmq`: health is `unknown` as soon as the connection drops, and the
  socket is replaced; `staleAfterMs` defaults to 10 minutes; the first message
  on each topic after a replacement is a gap; `maxMessageSize` defaults to
  2,065,536 bytes; `rawblock` and `rawtx` bodies over 2,000,000 bytes are
  malformed; `reconnect` events carry a `reason`.
- `@qbit-oss/zmq`: `health()` measures the last message's age on the monotonic
  clock (`performance.now()`), so a step in the wall clock no longer makes a
  fresh subscriber `stale` or an old one `receiving`. `lastMessageAt` and
  `receivedAt` stay `Date.now()` times, for display, and `health(now)` still
  reports the status at the wall-clock time `now`. Tests that simulate time
  must now fake `performance` as well as `Date`. `rawblock` and `rawtx`
  bodies are copied with `new Uint8Array(body)`, which is faster than
  `Uint8Array.from` and still a copy.

## TypeScript and `@types/node` floors

- The declarations need TypeScript 5.0 or later and `@types/node` 22.0.0 or
  later, which consumers install themselves; neither is a dependency or a peer
  dependency. CI type-checks the packed declarations at both floors, and
  raising either is a breaking change.

## Wallet and chain methods for the payout adapter

- Typed, validated methods for the calls qbit-payments' qbit Core wallet
  adapter makes, so `QbitRpcClient` satisfies its `CoreRpc` interface with no
  wrapper: `getblockcount`, `getmempoolentry` and `gettxout` (read),
  `getaddressinfo` and `listlockunspent` (wallet-read), `getrawchangeaddress`
  and `lockunspent` (wallet-write, side-effecting: never retried, unknown
  outcome when the reply is lost). Amounts are bits; `getaddressinfo` carries
  the PQC signature-budget fields. Parameters and results were checked against
  a qbit Core v1.0.0 regtest node, and the smoke test drives each method.
- `lockUnspent` refuses an empty list of outputs, which qbit Core would read as
  "do nothing" (and so does `unlockUnspent`, which replaced `lockUnspent(true, ...)`).

## Wallet history and receiving

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

## Stale keep-alive connections

- A request without side effects that is reset (`ECONNRESET`, `EPIPE`) on a
  reused keep-alive connection within 1 s of going out and before any byte
  of the reply, as when qbitd closes the connection for idleness
  (`-rpcservertimeout`), gets one more attempt at once, even with
  `readRetries: 0`, instead of failing. The other idle connections are closed
  first, and the chain confirmation goes stale, since a qbitd restart looks the
  same, so `finalizepsbt` and `testmempoolaccept` re-check the chain before
  they are sent again. The chain re-check before a side-effecting call gets the
  same attempt. The client closes pooled connections idle for 15 s, before
  qbitd's 30 s default. Side-effecting requests still use one fresh connection
  each and are never sent twice.

## Work queue rejections

- `maxConcurrentRequests` (default 8) limits a client's open requests, fresh
  connections included, so a burst of side-effecting calls no longer overflows
  qbitd's work queue. Further attempts wait in FIFO order under their deadline,
  and one that gives up there was never sent. With the new opt-in `directNode`,
  qbitd's 503 `Work queue depth exceeded` is a plain `RpcTransportError` rather
  than an unknown outcome.

## The first unlock of a new wallet

- `walletPassphrase` and `walletLock` (and `walletpassphrase` and `walletlock`
  through `call()`) have a default deadline of 120 s, not 30 s. qbit Core v1.0.0
  runs a new encrypted wallet's deferred keypool top-up inside its first unlock,
  which took 25 to 31 s on regtest on a shared host and 49 s on a GitHub-hosted
  runner, so that unlock, or a lock waiting for it, could miss 30 s and be an
  `RpcUnknownOutcomeError`. Every other method keeps 30 s, so a call on that
  wallet during a first unlock can need a longer `timeoutMs`. A client `timeoutMs` shorter than
  120 s does not shorten them, and a longer one applies; a call's own `timeoutMs`
  always wins. An unlock that misses its deadline once sent is an
  `RpcUnknownOutcomeError`, resolved with `getWalletInfo().unlockedUntil`,
  which waits for an unlock still running. One that misses it before it is
  sent is an `RpcTimeoutError`, or `RpcChainGuardError` `check_failed`, as for
  every call, and was not sent.

## Property and fuzz tests

- `parseZmqMessage` throws `ZmqFrameError` with code `frame_type` for a frame
  that is not a `Uint8Array` (a `Buffer` is one), a hole of a sparse array
  included, and a `TypeError` for a `frames` argument that is not an array.
- fast-check properties for amounts, `JsonNumber`, the txid computation,
  every result validator, the ZMQ parser and its sequence tracker, run in
  `pnpm test` with fixed counts and seeds; `QBIT_FUZZ_RUNS` runs them longer
  from random seeds. 47 real qbit Core v1.0.0 regtest replies, one or more for
  every typed method, are committed with the script that captures them, and
  each is validated and mutated field by field. A fuzz through the fake node
  checks that `walletCreateFundedPsbt`, `walletProcessPsbt` and
  `sendRawTransaction` reject a mutated reply only with
  `RpcUnknownOutcomeError`, and the smoke test checks the txid of generated
  transactions against `decoderawtransaction`.

## PQC signature-budget states

- No code change: the parser already takes every PQC field and state qbit Core
  v1.0.0 sends. The `warning`, `critical` and `exhausted` states are now
  observed on a regtest node, which has no option to lower the 2^30 limit: the
  smoke test writes keys' counts into the wallet file below each threshold,
  signs, and asserts each state's fields and warning lines. Fixture tests cover
  each state and boundary through `walletProcessPsbt` and `getAddressInfo`.
- The README's [PQC signature budgets](../rpc/wallet.md#pqc-signature-budgets)
  says what each state means and what to do, checked against the node. An
  exhausted key is not an error: `walletprocesspsbt` leaves its inputs
  unsigned (`complete: false`) and reports nothing about it, while the wallet
  still offers its coins for funding, so check `getAddressInfo` of the inputs
  before signing: each key's state, and its signatures left against the inputs
  it signs.

## Breaking: `zeromq` is an optional peer, and what the packages ship

- `zeromq` is an optional peer dependency of `@qbit-oss/zmq`, `^6.5.0`. npm
  and pnpm do not install it, so an application that subscribes with the
  default socket adds it: `npm install zeromq@^6.5.0`. Without it, the parser
  and a custom `socketFactory` work, and a subscriber's first iteration rejects
  with `ZmqSetupError` `code: 'module_load'`, whose message says that
  `zeromq` is an optional peer the application adds and gives the range; an
  install on a platform without a prebuilt addon does not fail for an
  application that does not install `zeromq`.
- The tarballs do not ship `src/`: the source maps carry every source file in
  `sourcesContent`. Each package is 9 files (the root README gives their
  sizes). `pack:check` asserts the exact file list, the maps' sources (each
  file of `src/`, and nothing outside it) and a size ceiling, and fails when a map has no sources or a size or ceiling is missing.
- Dependabot updates the `zeromq` dev pin only, as it does not read
  `peerDependencies`: move the peer range's floor by hand in that pull request,
  which `pack:check` fails until the two agree.
- Both packages set `"sideEffects": false`, so a bundler can drop a package
  nothing is imported from.
- The Vitest configs are `.mts` files, so Vitest does not warn that it loads
  ESM syntax as CommonJS. The packages still set no `"type"`.
- Dependabot opens weekly update pull requests for the npm dependencies and
  the GitHub Actions. The root README states the dependency policy, for
  `zeromq` and for future `@qbit-oss/*` dependencies.
- The stray `eslint-disable` comment in `endpoint.ts` is gone: ESLint is not
  used.

## Breaking: ZMQ heartbeats, and the subscriber replaces its own socket

- `QbitZmqSubscriber` sends libzmq's ZMTP heartbeats by default:
  `heartbeatIntervalMs` (10,000) and `heartbeatTimeoutMs` (20,000). A qbitd
  that stops answering without closing the connection (hung, stopped with
  `SIGSTOP`, its host gone) is dropped within 30 s, as a `reconnect` with
  `reason: 'disconnected'` and `unknown` health, rather than left to
  `staleAfterMs` (10 minutes). qbitd v1.0.0 answers the heartbeats; the regtest
  smoke test stops it with `SIGSTOP` and sees it dropped in 20 to 30 s, and
  messages resume, with a `gap` on each topic, after `SIGCONT`. Set
  `heartbeatIntervalMs: 0` for a publisher that does not answer them. A
  consumer that leaves the 1,000-message receive queue full for longer than the
  timeout drops a healthy publisher as well, since libzmq stops reading its
  PONGs: the queued messages are lost, and a `gap` follows. The package README
  says how to tell that from a hung qbitd, and what to do.
- Heartbeats run only after the ZMTP handshake, so libzmq's handshake interval
  (`ZMQ_HANDSHAKE_IVL`, 30 s) is set to the same bound, `heartbeatIntervalMs +
  heartbeatTimeoutMs`, and the subscriber gives up a socket whose handshake
  has not completed that long after `connect()` (30 s without heartbeats): a
  replacement that reaches a qbitd that is still hung is dropped within the
  bound too, as a `reconnect` with `reason: 'failed'`.
- `createZeromqSocket` turns off libzmq's own reconnect (`ZMQ_RECONNECT_IVL`
  -1). libzmq 4.3.5 aborts the process (`Assertion failed: _input_stopped`)
  when a socket it has reconnected by itself is read after the old connection
  filled the receive queue, which a missed heartbeat while the event loop is
  blocked brings about, even with a receive already pending. The subscriber
  replaces the socket instead: on `disconnect`, on `close` (a connection
  attempt failed) and at the handshake deadline (a host name that does not
  resolve, for which libzmq emits nothing). So a node that is down, from the
  start or after a drop, is a `reconnect` with `reason: 'failed'` and no
  `code` every `reconnectDelayMs`, where libzmq used to retry it silently, and
  `reason: 'disconnected'` is a connection that dropped after its handshake.
  Code that reads a `createZeromqSocket` socket itself, without the
  subscriber, gets no reconnect from libzmq: it replaces the socket on
  `disconnect` and `close`.
- `ZmqSocket.events` takes `disconnect`, `close` and `handshake`; a custom
  socket that has `events` emits all three. For one that never emits
  `handshake`, its first message counts as the handshake.
- `tcpKeepalive` with an `ipc://` url is a `TypeError`: an IPC connection has
  no TCP keepalive.
- `heartbeatTtlMs` (default 30,000, or twice the interval rounded up to a
  multiple of 100 when that is longer, and 0 without heartbeats) asks qbitd to
  drop a subscriber it has not heard from, which frees its queue; a subscriber
  process stopped that long reconnects when it runs again, and the tracker
  reports a `gap` on each topic. It must be 0 or, once libzmq has rounded it
  down to a multiple of 100, at least twice the interval: qbitd drops a healthy
  subscriber whose TTL runs out between heartbeats.
- Without heartbeats, `heartbeatTimeoutMs` and `heartbeatTtlMs` are unused, and
  each may be 0 or a value in its range.
- `tcpKeepalive`, `tcpKeepaliveIdleSeconds`, `tcpKeepaliveIntervalSeconds` and
  `tcpKeepaliveCount` set TCP keepalive, left to the operating system (off on
  Linux) by default. The last three need `tcpKeepalive: true`.
- The constructor throws a `RangeError` for a value out of range and a
  `TypeError` for a keepalive setting without `tcpKeepalive: true`.
- `ZmqSocketSettings` has the optional `heartbeatIntervalMs`,
  `heartbeatTimeoutMs`, `heartbeatTtlMs` and `handshakeIntervalMs`, which the
  subscriber always passes, and the keepalive settings, passed when set.
  `createZeromqSocket` applies them; a custom `socketFactory` that ignores them
  runs without heartbeats.
- `@qbit-oss/zmq` is about 224 KB unpacked, and its `pack:check` ceiling 280,000
  bytes.

## Opening another method

- The client option `extraMethods` opens a method the package does not
  allowlist, for that client only, untyped, through `call()` and
  `requests.raw()`, such as
  `{ getchaintxstats: { capability: 'read', sideEffects: false } }`. Each entry
  gets the treatment of an allowlisted method with the same policy
  (`ExtraMethodPolicy`): `wallet-write` and `broadcast` wait for the chain guard, and one
  with side effects is never retried or batched, uses a fresh connection, and
  is an `RpcUnknownOutcomeError` when it may have run. The constructor throws a
  `TypeError` for a malformed name or entry, an option or entry that is not a
  plain object (a `Map`, a class instance), an unknown capability or one the
  client does not enable (restated allowlisted methods included), a missing
  `sideEffects` (it has no default), side effects without `wallet-write`,
  `broadcast`, `mining` or `node-admin`, a method the package already allowlists with another policy
  (restating its own is accepted), and `sendmany`, `sendtoaddress`, `send`,
  `sendall` and `bumpfee`, which sign and broadcast in one step. `toJSON()` and
  `util.inspect` list the opened methods.
- Each of the 161 methods qbit Core v1.0.0's `help` lists has a fixed class,
  from its source: a policy below it is a `TypeError` naming the method and the
  policy it needs. A wallet method needs a wallet capability; one that signs or
  changes a wallet needs `wallet-write` with side effects; one that
  administers a wallet, `wallet-admin`; one that builds or submits blocks,
  `mining`; one that hands a transaction to the network needs `broadcast`
  with side effects. `walletpassphrasechange` or `signrawtransactionwithwallet`
  cannot be opened as a read. qbit Core v1.0.0's 18 hidden methods are
  classed too: `invalidateblock` cannot be opened as a read either. A method
  in neither table, as a later release's, keeps the policy given. The regtest
  smoke test compares the table with the node's `help`, and each hidden name
  with `help <name>`.
- A new capability, `node-admin`, for node administration: `stop`, `setban`,
  `clearbanned`, `addnode`, `disconnectnode`, `setnetworkactive`,
  `pruneblockchain`, `savemempool`, `importmempool`, `logging`,
  `dumptxoutset`, `loadtxoutset`, `getblockfrompeer`, `preciousblock` and
  `ping`. It allowlists nothing: each is reachable only through
  `extraMethods`, as `{ capability: 'node-admin', sideEffects: true }`, on a
  client whose `capabilities` include `node-admin`. Under any other
  capability, `broadcast` included, such an entry is a `TypeError` naming the
  method and `node-admin`. Its calls wait for the chain guard, by the chain's
  identity only: refused before `confirmChain()`, on another chain, and when
  the chain cannot be confirmed (`stale`, `check_failed`), but not for an
  unsupported qbit Core version, so `stop` and `setban` still reach such a
  node. None goes in a batch (`not_batchable`). `Capability` gains `node-admin`, so a
  `switch` over it checked for exhaustiveness needs the case.
- `extraMethods` and each entry are read from their own properties: a key of
  an entry held only on a polluted `Object.prototype` is a `TypeError` naming
  it, as for the other options, and an unknown key of an entry is refused with
  the key it most likely meant. `extraMethods` is one of the constructor's
  strict keys.

## Chain scanner, mempool and package methods

- Typed, validated methods for explorers and indexers, all reads: `getBlock`,
  `getBlockWithTransactions` and `getBlockHex` (`getblock` at verbosity 1, 2 and
  0, checked against the requested hash; a full block's verbosity-2 reply can
  pass the default 16 MiB `maxResponseBytes`, as a 1.92 MB regtest block's 21.1
  MB did), `getChainTips`, `getMempoolInfo`, `getRawMempool`,
  `getRawMempoolVerbose`, `getRawMempoolSequence` and `getTxSpendingPrevout`
  (a new allowlist entry, checked against the outputs asked about). `getblock`,
  `getchaintips`, `getmempoolinfo` and `getrawmempool` are also available
  untyped through `call()`.
- `waitForNewBlock` and `waitForBlockHeight`, long polls for where ZMQ is not
  available, allowlisted as reads. `waitMs` is required, as the node
  reads 0 as a wait with no end. The deadline runs to at least `waitMs` plus 10 s
  whatever the client's `timeoutMs`, and a call's own `timeoutMs` below `waitMs`
  plus 10 s is a `RangeError`. Each holds a request slot and a `qbitd` worker for
  its wait, even after the client gives up, and is refused in a batch.
- Through `call()` and `requests.raw()`, `waitfornewblock`, `waitforblockheight`
  and `waitforblock` take their wait from their timeout parameter, with the same
  deadline and batch rules; a timeout absent or 0 is a `RangeError` that says to
  pass one.
- A retried long poll asks the node for what the deadline has left, less the
  10 s margin, and is not sent when nothing is left. `waitForNewBlock` without
  `currentTip` is never retried, as the retry would wait from the tip at the
  retry and miss a block found meanwhile; with `currentTip` it is safe to retry.
- `submitPackage`, under `broadcast` with side effects, for CPFP: behind the chain
  guard, never retried, on a fresh connection, with the caps
  `sendRawTransaction` takes (a fee-rate cap of `0n` refused). A refusal is in
  the result, and can be partial. A lost reply is an `RpcUnknownOutcomeError`
  with the optional `txids`, one per transaction in package order, typed or
  through `call()`: the txid computed from its hex, or `null` for hex that does
  not parse here, which is sent all the same; `txid` is `sendrawtransaction`'s.
- The node's error to `submitpackage` is a definite `RpcError` only when qbit
  Core v1.0.0 raises it before handing any transaction to the mempool: -28,
  -3, -8, -22, -25 for a burn over `maxburnamount` or a package of another
  shape, and the JSON-RPC layer's -32700, -32600, -32601 and -32602, before
  any method runs. Any other (a failed relay after acceptance, a mempool error, a failed
  internal check) is an `RpcUnknownOutcomeError` with `txids` and that
  `RpcError` as `cause`.
- `extraMethods` refuses `submitpackage`, `gettxspendingprevout`,
  `waitfornewblock` and `waitforblockheight` under any policy but the
  allowlist's, as for every allowlisted method: `broadcast` with side effects for
  the first, `read` without for the others. Restating that policy is accepted.
- `RpcCapabilityError` `reason: 'not_batchable'` covers long polls too.
  `batch()` reads an entry's `waitMs` as it reads its `method`, `params` and
  `parse`, as its own property: one held any other way is a `TypeError`.
- Every new result object has no prototype, as every other result: the
  chain tips, `BlockRef`, `MempoolSnapshot`, a block and its transactions,
  and `PackageSubmission` with its `txResults`. `requests.raw()` reads a long
  poll's wait and `submitpackage`'s txids from the params as they will be
  sent, so a `toJSON` or a getter cannot change them after the check, and
  `RpcUnknownOutcomeError` copies `txids` by its own elements: a hole is a
  `TypeError`.

## `rawTransactionTxid` written from public sources

- `src/raw-tx.ts`, which computes the txid that names a broadcast in an
  `RpcUnknownOutcomeError`, is rewritten from BIP 144's serialization and the
  checks Bitcoin Core applies when it reads a transaction, which qbit Core
  keeps. The earlier version was adapted from another project's code. The API
  and behaviour are the same: undefined for hex that is not one whole
  transaction, for a CompactSize in a longer form than needed, or for trailing
  bytes; never a throw.
- `raw-tx-vectors.test.ts` pins three txids: Bitcoin's genesis coinbase (the
  legacy format) and, from qbit Core v1.0.0 on regtest, a coinbase and a P2MR
  wallet spend (the extended format).

## Mining pools

- The `mining` capability goes behind the chain guard; `Capability`, the
  capability tables and the guard's documentation name it.
- `getMiningInfo`, a read needing no capability, allowed in a batch.
- `getBlockTemplate({ rules?, capabilities? })` and
  `checkBlockProposal(blockHex)` (`getblocktemplate` in `template` and `proposal`
  mode), under `mining` without side effects: behind the chain guard, because a
  template from another chain is wasted hashing, retried like reads, and refused
  in a batch. `coinbaseValueBits` and each transaction's `feeBits` are `bigint`
  bits, and `target` is checked against `bits`, each `txid` against its `data`,
  and each `depends` entry against the transactions before it. qbit Core v1.0.0's
  template has no AuxPoW field, and its `version` never signals AuxPoW. The typed
  method takes no `longpollid`, as BIP22's wait has no end of its own: use ZMQ or
  `waitForNewBlock`. `call()` refuses a `getblocktemplate` with `longpollid`
  too, a `TypeError`, unsent.
- `submitBlock(blockHex)`, `createAuxBlock(payoutAddress)` and
  `submitAuxBlock(blockHash, auxpowHex)`, under `mining` with side effects: behind
  the chain guard, never retried, on a fresh connection, and an
  `RpcUnknownOutcomeError` when the reply is lost. `submitBlock` and
  `submitAuxBlock` answer null or a `BlockSubmissionReason`, an open enum:
  `duplicate` and `inconclusive` are not refusals. `submitauxblock` in v1.0.0
  answers as `submitblock` does, not with a boolean.
- `RpcUnknownOutcomeError` has an optional `blockHash`, its fifth constructor
  argument: for `submitblock` and `submitheader` the hash of the hex's 80-byte
  header, when it holds one, and for `submitauxblock` the hash submitted, typed
  or through `call()`. A lost `createauxblock` names nothing.
  Reconcile with `getBlockHeader(blockHash)`: submitting an accepted aux block
  again answers `stale-prevblk`, as the node forgets it.
- `extraMethods` refuses `getblocktemplate`, `submitblock`, `createauxblock`,
  `submitauxblock` and `getmininginfo` under any policy but the allowlist's, as
  for every allowlisted method: `submitblock` opened as `broadcast` is a
  `TypeError` at construction. Restating its policy is accepted.
- `extraMethods` also takes `mining` for a method with side effects, such as
  `submitheader`, which it treats as any other guarded call. qbit Core's mining
  methods (`submitheader`, `prioritisetransaction`) need `mining` there.
- `QbitRpcClient.getBlockTemplate()` defaults `rules` to `['segwit', 'signet']`
  with `expectedChain: 'signet'`, as qbit Core refuses a signet template
  without the `signet` rule; elsewhere `['segwit']`.
- A template transaction whose `data` does not parse as a transaction, or whose
  `txid` or `hash` (the wtxid) is not that of its `data`, fails validation.
- The capabilities whose calls wait for the chain guard are kept in one list,
  which the guard, the batch rule and `extraMethods` all read: a batch, sent
  without the guard, carries none of them. `node-admin` is in it, guarded by
  the chain's identity only.
- Every new result object has no prototype, as every other result: the
  mining info and its `next`, the block template with its transactions, rules
  and `vbAvailable` and `coinbaseAux` maps, and the aux block.
  `getBlockTemplate`'s `rules` and `capabilities` are read from the options'
  own properties, and their own elements: a hole is a `TypeError`.
- `pack:check`'s ceiling for `@qbit-oss/rpc` is 2,270,000 bytes unpacked, a
  quarter above its 1.82 MB with these methods.

## Breaking: wallet operators: administration, descriptors and data-hash signing

- The `wallet-admin` capability goes behind the chain guard, since importing
  descriptors, rescanning or creating a wallet on the wrong chain is a
  misconfiguration worth refusing; `Capability`, the capability tables and the
  guard's documentation name it.
- Typed and validated under it: `createWallet`, `loadWallet`, `unloadWallet`,
  `listWalletDir`, `importDescriptors`, `rescanBlockchain`, `backupWallet`,
  `walletPassphraseChange` and `keypoolRefill`. All but `listWalletDir`, a read
  gated as the step before `loadWallet`, have side effects: never retried, on a
  fresh connection, and an `RpcUnknownOutcomeError` when the reply is lost. None
  goes in a batch. The package README says how to reconcile each after a lost
  reply, and what calling it again does.
- Default deadlines of 120 s, as `walletPassphrase` has, for the calls qbit Core
  v1.0.0 makes derive PQC keys before answering, measured on regtest on a
  loaded shared host at 18 to 21 ms a key: `keypoolRefill` (41 s for a new
  wallet's default refill), `importDescriptors` (35 s for a receiving and a
  change descriptor from timestamp 0), `rescanBlockchain` (1,010 blocks in 0.25
  s, plus keys for each used address it finds), `unloadWallet`, which answers
  once the calls still running on the wallet end (36 s behind that refill), and
  `loadWallet`, which tops up the keypool and attaches the wallet to the chain,
  rescanning from the last block it saw, before it answers. A shorter client
  `timeoutMs` does not shorten them, a longer one applies, and a call's own
  always wins. A rescan of a long chain, an import
  with an early timestamp, or a large `newSize` or range needs the call's own
  `timeoutMs`: the README says how to size it. The other wallet-admin calls keep
  30 s (`createWallet` 0.6 s, 1.1 s with a passphrase).
- Secrets: `createWallet`'s passphrase and `walletPassphraseChange`'s two travel
  only in the request body, as `walletPassphrase`'s does. A descriptor can hold
  private keys, and qbit Core quotes them, a malformed key in its error and a
  refused import a whole descriptor (live). So the node's messages about
  `importdescriptors`, `deriveaddresses` and `getdescriptorinfo`, typed or
  through `call()` or in a batch, have every run of 16 or more letters and
  digits of the call's descriptors replaced by `[redacted]`, in any case, before
  they are capped at 1,000 characters: an `RpcError`'s `message`, and each
  `DescriptorImportResult`'s `error.message` and `warnings`. The client reads the
  descriptors from the request body it sends, so a copied or hand-built batch
  entry, params changed after `requests.raw()`, and a descriptor passed as a
  `String` or behind `toJSON()` are redacted too. A `call('importdescriptors')`
  result is the node's as it is.
- The package README warns that `call()` returns results, and other methods'
  errors, as the node sent them, which can quote private keys: never log them
  for a method that takes keys.
- Checked before sending, where qbit Core would refuse, or ignore, one
  descriptor of an import and go on with the others: each descriptor's
  characters and checksum (BIP 380, computed here; required by
  `importDescriptors` and `deriveAddresses`), `range`, `nextIndex` and `active`
  without `*`, a `nextIndex` outside `range` or without one (the default range
  is the node's first `-keypool` indexes, which the client cannot know), a
  label on a ranged, multipath or internal descriptor or of `*`, `internal` on
  a multipath one, and a timestamp above 2^32 - 1, most likely in
  milliseconds. An empty `createWallet`
  passphrase is refused (qbit Core creates the wallet unencrypted), as are a
  passphrase with `disablePrivateKeys`, an empty `backupWallet` destination
  (qbit Core answers success and writes nothing, live) and `newSize: 0` (qbit
  Core's "the default": leave it out).
- `getDescriptorInfo` and `deriveAddresses`, reads needing no capability and
  allowed in a batch. `getDescriptorInfo`'s canonical form and multipath
  expansion must carry their own checksums, its `checksum` must be the input's,
  and `isRange` must match its `*`. `deriveAddresses` takes the range qbit Core
  takes (from 0 to 2,147,483,647, at most 1,000,000 indexes in either form, so
  an end index of at most 999,999), which a ranged descriptor needs and any
  other refuses, and its reply must hold an address per index; a multipath descriptor is refused, as its reply would be one list per
  path.
- `signDataPqcHash`, under `wallet-write` with side effects: each signature uses
  one of the key's 2^30, so a lost reply is an `RpcUnknownOutcomeError`, and
  signing again uses another. Its result is checked against the request, the
  address in either case, as a bech32m address in capitals is the same one
  (qbit Core v1.0.0 echoes it as sent), and `includePqcUsage` adds the key's
  PQC usage fields and `warnings`, parsed as `walletProcessPsbt`'s.
  `verifyDataPqcHash` takes a `signDataPqcHash()` result as it is: the fields
  beyond the proof's are allowed and not read. qbit Core ignores an option name
  it does not read, so `call('signdatapqchash')` refuses `includePqcUsage`,
  `leafScript` and `controlBlock`, as it refuses `walletcreatefundedpsbt`'s
  `subtract_fee_from_outputs`: send `include_pqc_usage` and so on. Both checks
  run on the request body as it is sent, so a getter is read once, by what the
  node receives, and `requests.raw()` itself refuses neither.
- `extraMethods` refuses `createwallet`, `loadwallet`, `unloadwallet`,
  `listwalletdir`, `importdescriptors`, `rescanblockchain`, `backupwallet`,
  `walletpassphrasechange`, `keypoolrefill`, `getdescriptorinfo`,
  `deriveaddresses` and `signdatapqchash` under any policy but the allowlist's,
  as for every allowlisted method; restating the allowlist's policy is
  accepted. The package README's example opens `setlabel`.
- `extraMethods` also takes `wallet-admin`, behind the chain guard, for a method
  with side effects, such as `abortrescan`. The `TypeError` for side effects
  without a guarded capability names `wallet-admin` too. The wallet
  administration methods move from `wallet-write` to `wallet-admin`: an
  `extraMethods` entry that opened one under `wallet-write` is a `TypeError`
  naming the policy it needs. `wallet-admin` sits beside `node-admin`, which
  is guarded by the chain's identity only, and neither goes in a batch.
- Every new result object has no prototype, as every other result: each
  descriptor's import result and its `error`, the rescan's heights, the
  loaded, unloaded and listed wallets, the descriptor info and the data-hash
  signature. `importDescriptors()` reads its descriptors by their own
  elements, a hole being a `TypeError`. The send-time checks read the request
  body parsed back as the node will read it, its objects without a prototype.
- New exported types: `DataPqcHashSignature`, `DescriptorImport`,
  `DescriptorImportResult`, `DescriptorInfo`, `DescriptorRange`, `LoadedWallet`,
  `RescanResult`, `UnloadedWallet` and `WalletDirEntry`.

## Breaking: PQC key budgets checked before signing

An exhausted PQC key signs nothing and raises no error, and a key that runs
out partway leaves the inputs after it unsigned, so every caller had to count,
per key, the signatures a PSBT needs against `pqcSignaturesRemaining` before
signing. The client does it now.

- `checkPqcSigning(psbt)`, under `wallet-read`: `decodepsbt` for the output
  each input spends (its `non_witness_utxo`'s when it has one, as the wallet
  signs by it, else its `witness_utxo`), then `getaddressinfo` for each of
  those addresses once, in batches of up to 1,000, and the count: each input
  needs one signature from each PQC key its address holds. It resolves with a
  `PqcSigningPlan`: each key's `pubkey`, `addresses`, `needed`, `remaining` and
  `state`, the worst `state`, and a warning per `critical` key. Every field it
  reads is validated with the typed methods' parsers: `decodepsbt`'s inputs
  must match `tx.vin` one for one, a `non_witness_utxo` must be the spent
  transaction with the spent output, and an address must not be empty.
- `PqcSigningError`, with `reason` `no_address` (`inputIndex`), `no_keys` (a
  PQC state without `pqc_key_states`, `address`), `exhausted`, `unknown_state`
  (a state this version does not know: fail closed, `state`) or
  `would_run_out` (`pubkey`, `needed`, `remaining`). `method` is
  `walletprocesspsbt`; the message names the input and the key, never the
  address. New exported types: `PqcSigningKey`, `PqcSigningPlan` and
  `PqcSigningRefusal`.
- `walletProcessPsbt` runs the check first whenever it signs, and sends
  nothing to sign when it refuses or fails; the check's failure is thrown as
  it is, about `decodepsbt` or `getaddressinfo`. So it now needs `wallet-read`
  as well as `wallet-write`: without it, `RpcCapabilityError` (`required:
  'wallet-read'`) before anything is sent. The check and the signing share one
  deadline, the call's `timeoutMs` from when it starts, and its signal: a
  deadline the check used up is an `RpcTimeoutError` about
  `walletprocesspsbt`, with nothing sent. `sign: false` signs nothing and is
  not checked. `{ pqcCheck: false }` skips the check, unsafe; `pqcCheck` is the
  client's option, never sent, and `requests.walletProcessPsbt` does not take
  it. `call('walletprocesspsbt')` is not checked.
- The payout example in `docs/rpc/payments.md` uses `checkPqcSigning` instead
  of its 25 hand-written lines, and the page gains "Checking PQC keys before
  signing", with what the check cannot see: signatures made meanwhile, and a
  PSBT built elsewhere that misstates an input's `witness_utxo`.
- On regtest, with counts written into the wallet file, `walletProcessPsbt`
  refuses a key with one signature left and two inputs (`would_run_out`) and an
  exhausted key, its count read back unchanged, and signs a critical and a
  normal key's inputs through the check.

## `batch()` refuses params that are not an array

- A hand-built `batch()` entry whose `params` is sent as anything but an array
  is now a `TypeError`, unsent, as it already is through `call()` and
  `requests.raw()`. Sent as named params, it got past the checks of ignored
  options and the redaction of the node's messages, so a node error quoting a
  descriptor's private key came back as it was. The check reads the request
  body as it will be sent, so an array with a `toJSON` that returns an object
  is refused too. An entry that leaves `params` out still sends none.
