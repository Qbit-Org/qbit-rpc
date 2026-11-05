# @qbit-oss/rpc

A Node.js JSON-RPC client for qbit Core (`qbitd`) 1.0.x releases, checked
against v1.0.0; see [Versions and compatibility](#versions-and-compatibility).
No runtime dependencies and no native code.

Node.js `^22.13.0 || ^24.0.0 || >=26.0.0`. CI tests 22.13.0 and the newest
22.x, 24.x and 26.x on Linux x64; Node.js 27 and later, and other operating
systems, are expected to work but untested. See
[Node.js and platforms](../../README.md#nodejs-and-platforms).

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
| `url` | required | `http://` only for a loopback host: an address in `127.0.0.0/8` or `::1` (also as `::ffff:127.0.0.1`), or `localhost`, which every connection resolves and refuses unless all its addresses are loopback (see [localhost](#localhost)); anything else must be `https://`. No credentials, query or fragment in the URL. The path may name a wallet (`/wallet/<name>`). |
| `wallet` | none | Sends every call to `/wallet/<name>` (URL-encoded). Needed for wallet calls when several wallets are loaded. |
| `auth` | required | `{ username, password }` (HTTP Basic), or `{ cookieFile }` for a loopback endpoint only. The cookie is read again for every request, so `qbitd` can restart and rotate it. |
| `tls` | the system's CAs, no client certificate, the URL's host, no pin | For an `https` URL, such as a TLS terminator in front of `qbitd`: `ca`, `cert` and `key` (with `passphrase` for an encrypted key), `servername` and `pinSha256`. Each is checked at construction. Certificate verification cannot be turned off. See [Remote nodes](#remote-nodes). |
| `connect` | none: connect to the URL's host | A function that opens the stream for each connection, such as a tunnel through a proxy; the client runs TLS over it, with every check. `https` URL and Basic credentials only. See [Proxies](#proxies-connect). |
| `expectedChain` | required | `main`, `test`, `testnet4`, `signet` or `regtest`. |
| `expectedGenesisHash` | `expectedChain`'s, see [Chain guard](#chain-guard) | The genesis block hash every chain check expects from `getblockhash 0`: 64 hex characters, either case (compared in lowercase). Set it for a node built with other chain parameters. |
| `expectedSignetChallenge` | `51` on signet | The `signet_challenge` every chain check expects: non-empty hex of whole bytes (the challenge script), either case (compared in lowercase). Only with `expectedChain: 'signet'`. |
| `capabilities` | `[]` | Any of `wallet-read`, `wallet-write`, `broadcast`, `node-admin`. |
| `extraMethods` | none | Methods to allow beyond the allowlist, untyped, each `{ capability, sideEffects }`. See [opening another method](#opening-another-method-extramethods). |
| `timeoutMs` | 30,000; at least 120,000 for `walletPassphrase` and `walletLock`; at least the wait plus 10 s for a long poll | One deadline per operation: any wait for a request slot, cookie read, every attempt and every backoff. A shorter value does not shorten their 120 s, or a [long poll](#long-polls)'s. Override per call. See [unlocking a wallet](#unlocking-an-encrypted-wallet). With `connect`, it also bounds a pooled connection still opening after its read gave up (see [Proxies](#proxies-connect)). |
| `maxResponseBytes` | 16 MiB | Larger replies fail with `RpcResponseTooLargeError` (or an unknown outcome for side-effecting calls). A full block can pass the default: see [large replies](#large-replies). Leave a few KiB at least: the chain check's batched reply (`getblockchaininfo`, `getblockhash 0` and `getnetworkinfo`, about 2 KiB from a v1.0.0 node without peers) must fit, or every check fails. |
| `readRetries` | 0 | Opt-in retries for methods without side effects (see below). |
| `retryDelayMs` | 250 | First backoff; doubles per retry, capped at 10 s, never past the deadline. |
| `chainCheckMaxAgeMs` | 10,000 | How long a chain confirmation stays fresh before a wallet-write or broadcast call re-checks it. 0 re-checks before every such call. |
| `maxConcurrentRequests` | 8 | Most requests this client has open at once, on pooled and fresh connections alike (1 to 1,024); it also sizes the keep-alive pool. Further attempts wait in FIFO order under their deadline. See [the work queue](#the-work-queue). |
| `directNode` | `false` | Set when `url` reaches `qbitd` itself. `qbitd`'s HTTP 503 `Work queue depth exceeded` is then a definite failure, not an unknown outcome. Opt-in, because a proxy in between can answer 503 after forwarding the request. See [the work queue](#the-work-queue). |
| `allowUnsupportedNodeVersion` | `false` | Let wallet-write and broadcast calls go to a node outside qbit Core 1.0.x releases, which they are refused otherwise (`RpcChainGuardError` `reason: 'unsupported_version'`). `nodeVersion` still shows the version, and one that does not parse still fails the check. See [Versions and compatibility](#versions-and-compatibility). |

The options, and `tls` and `auth` within them, are read once each, when the
client is constructed, from their own enumerable properties, and the arrays in
them (`capabilities`, `tls.ca`, `tls.pinSha256`) by their own elements. An
option, or a key of `tls` or `auth`, held any other way (inherited, a class
getter, not enumerable, on a polluted `Object.prototype`, left out of the keys
a `Proxy` lists, or answered only by its `get` trap) is a `TypeError` that names
it and says to pass a plain object, and so is a hole in one of those arrays.
Read, such a value could enable a capability, pick a wallet, fill in a password
the application left out, or change whom the client trusts and how it
connects; ignored, a `tls`, `ca` or `pinSha256` would leave the client trusting
more than was asked for. So a polluted `Object.prototype` holding one of these
names fails at construction, unless the object sets that name itself. They are
strict too: any other key is a `TypeError` that names it, with the key it most
likely meant (`timeout` → `timeoutMs`, `server_name` → `tls.servername`) or the
known keys, so `walletName` cannot silently leave out the wallet. A key that is
no near miss and either is not a short identifier or sits in an array entry is
refused as "an unknown key (not shown)", so messages never quote configuration
or request data.

## Call options

Every method, `call()`, `batch()` and `confirmChain()` included, takes its call
options, `{ signal?: AbortSignal, timeoutMs?: number }`, as a separate last
argument, after the method's own options:

```ts
await rpc.getTxOut(txid, vout, { includeMempool: true }, { timeoutMs: 5_000 })
await rpc.listUnspent({ minConf: 1 }, { signal })
await rpc.sendRawTransaction(hex, undefined, { signal }) // none of its own options
```

`timeoutMs` (1 to 3,600,000) overrides the client's for this operation, and
the own default of `walletPassphrase` and `walletLock` (see [unlocking a wallet](#unlocking-an-encrypted-wallet))
and a [long poll](#long-polls)'s, and `signal` aborts it (see the [failure model](#failure-model)). A method's own
options never hold call options, and the call options hold nothing else: a key
in the wrong one is a `TypeError` that says where it belongs. So a method can
gain an option named like neither without breaking a caller.

## Remote nodes

`qbitd` serves plain HTTP, and the client sends credentials in cleartext only
to loopback. A node on another host goes behind a TLS terminator (nginx,
HAProxy, stunnel, a load balancer), and the client takes an `https` URL:

```ts
import { readFileSync } from 'node:fs'

const rpc = new QbitRpcClient({
  url: 'https://qbitd.internal.example:8443/',
  auth: { username: 'payments', password: process.env.QBIT_RPC_PASSWORD! },
  expectedChain: 'main',
  tls: {
    ca: readFileSync('rpc-ca.pem'), // the terminator's private CA
    cert: readFileSync('client.pem'), // when it requires a client certificate
    key: readFileSync('client-key.pem'),
    pinSha256: ['<the current key>', '<the next key>'],
  },
})
```

Each `tls` option is checked when the client is constructed, a `TypeError`
naming the option, never its contents:

- `ca`: PEM CA certificates, a string or Buffer holding one or more (text
  between them, as in CA bundles, is allowed), or an array of them. They
  replace the system's CAs: the node's certificate must chain to one of them.
  Leave it out for a certificate from a public CA. For a self-signed
  certificate, give the certificate itself.
- `cert` and `key`: the client certificate (then any intermediate
  certificates) and its PEM private key, for a terminator that requires one
  (nginx's `ssl_verify_client on`). One without the other, or a key that is not
  the certificate's, is refused. `passphrase` decrypts an encrypted `key`; it is
  used once, at construction, and not kept.
- `servername`: the host name the node's certificate must carry, also sent in
  SNI, instead of the URL's host: for a URL that names an address, or another
  name. A DNS name, not an address.
- `pinSha256`: the base64 SHA-256 of the SubjectPublicKeyInfo (the public
  key) of the node's certificate, or several. It is checked after the CA and
  name checks, which still apply, and only the node's own certificate counts,
  not its CA's. To rotate a key with no outage, add the next key's pin,
  rotate the terminator's key, then drop the old pin. Revocation (CRL or
  OCSP) is not checked: a pin, or a short-lived certificate from your own CA,
  is what limits a stolen key. To compute one:

  ```sh
  openssl x509 -in node.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
  ```

The certificate is always verified: there is no `rejectUnauthorized`, and the
client ignores `NODE_TLS_REJECT_UNAUTHORIZED=0`, which turns verification, and
with it the name and pin checks, off for Node's own default. Every
connection, a pooled one for reads and the new one each side-effecting call
opens, runs a full handshake with every check: the client resumes no TLS
session, since Node skips the certificate checks on a resumed one, and writes
nothing to a connection before its checks pass. It also fails a handshake that
does resume one (`code: 'ESESSIONRESUMED'`). A failure is an
`RpcTransportError` with `reason: 'tls'` and `code` (see the
[failure model](#failure-model)): nothing was sent, and it is not retried. An
error Node throws as it builds the connection is `tls` for a TLS or OpenSSL
error, and `network` for the socket's, such as an option it refuses, and
nothing was sent either. What the client does about a polluted
`Object.prototype` is [below](#a-polluted-objectprototype).

The client takes Node's default trust and protocol settings
(`tls.setDefaultCACertificates()`, `tls.DEFAULT_MIN_VERSION`,
`tls.DEFAULT_MAX_VERSION`, `tls.DEFAULT_CIPHERS`) at its first TLS connection,
or at construction when `tls` sets `ca` or `cert`. Create a new client after
changing them.

A terminator that refuses the client certificate in the handshake sends a TLS
alert, `tls` too. Under TLS 1.2 it arrives before the client has written
anything, and nothing was sent. Under TLS 1.3 the client finishes its side of
the handshake first and writes the request, and the alert
(`certificate_required`, `bad_certificate`, `unknown_ca` and the like) arrives
after it: only the terminator says it read nothing, and one that misbehaves
could have passed the request on, so for a side-effecting call it is an
`RpcUnknownOutcomeError` with the `tls` error as its `cause`; a read fails with
`tls` and is not retried. One that checks the certificate after the handshake
instead and drops the connection (Node's own TLS server does, for a certificate
it does not trust) leaves only a reset after the request went out, which the
client cannot tell from a node failing while it runs the request: for a
side-effecting call, an `RpcUnknownOutcomeError` too. nginx answers HTTP 400,
rejected before running anything. `confirmChain()`, a read, meets any of these
first.

A terminator that answers HTTP itself, such as nginx or HAProxy, can answer
503 after forwarding a request: leave [`directNode`](#the-work-queue) off.
Set it only for one that relays bytes and never answers HTTP, such as stunnel.
One that puts a JSON-RPC error on its own 502, 503 or 504 stays an unknown
outcome for a side-effecting call ([which statuses are the node's](#which-statuses-are-the-nodes));
one that does so under 500 reads as the node's answer, so have it answer 502 or
504 when it times out.

### Proxies: `connect`

The client has no proxy settings of its own. `connect` opens the byte stream
for each connection, such as a tunnel through an HTTP CONNECT or SOCKS proxy.
The client runs TLS over it, with every check above, and HTTP over that:

```ts
import { request } from 'node:http'
import type { RpcConnect } from '@qbit-oss/rpc'

/** A tunnel through an HTTP CONNECT proxy, given up after 10 s or when the client says so. */
function viaProxy(proxyHost: string, proxyPort: number): RpcConnect {
  return ({ host, port, signal }) =>
    new Promise((resolve, reject) => {
      const tunnel = request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${host}:${port}`,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
      tunnel.once('connect', (response, socket) => {
        if (response.statusCode === 200) return resolve(socket)
        socket.destroy()
        reject(new Error(`proxy answered HTTP ${response.statusCode}`))
      })
      tunnel.once('error', reject)
      tunnel.end()
    })
}

const rpc = new QbitRpcClient({
  url: 'https://qbitd.internal.example:8443/',
  auth,
  expectedChain: 'main',
  tls,
  connect: viaProxy('proxy.internal.example', 3128),
})
```

`connect({ host, port, signal })` gets the URL's host (a name, or an address
without brackets) and port (443 when the URL names none). It must:

- return a new `stream.Duplex`, such as a `net.Socket`, connected or
  connecting to that host and port, or a promise of one, on every call. A
  stream it returned before, one destroyed without an error or anything else
  is a `TypeError` for the call, with nothing sent. One that has already failed
  is `reason: 'network'`, nothing sent, with its error's `code`. Keep an `error`
  listener on a stream until you return it: the client sees it only then, and
  an error emitted before that, such as from a stream you destroy with an error
  in the same callback that resolves the promise, has nowhere else to go;
- throw or reject when it cannot. The call fails with `RpcTransportError`
  `reason: 'network'`, nothing sent, and the error's `code` when it is a
  string; the error itself is not kept, as it may quote a proxy's credentials.
  Reads retry it under `readRetries`. A connection for reads fails only the read
  it serves by then: never one that has gone out on another connection, and none
  when no read waits for it. Node's pool opens one by itself for the oldest read
  queued behind a full pool; when it fails, the next read queued opens its own;
- stop when `signal` fires: the client has given up on the connection, and
  destroys a stream that arrives later. It never fires once the connection is
  in use, and it also ends the TLS handshake over the stream. For a
  side-effecting call's connection it fires at the call's deadline or abort.
  A connection for reads serves the pool, so it outlives the read it was
  opened for, and Node's pool can also open one by itself, for a request queued
  behind a full pool. Once no read waits for such a connection, its `signal`
  fires when the client's `timeoutMs` (30 s by default) has passed since it
  started, or at once when a read that does wait needs its turn; on `close()`
  it fires at any time. A read that waits still has its own deadline, however
  long. One that opens after its read gave up waits, idle, for the next read,
  so a proxy slower than a read's deadline still serves the reads after it. Such
  a connection keeps no process alive, nor does one still in its handshake.
  Give up on your own too when the proxy does not answer, as the example does
  after 10 s.

The client opens at most `maxConcurrentRequests` plus one connections through
`connect` at once for reads, and as many again for side-effecting calls, so a
side-effecting call never waits behind connections for reads. Each counts from
the `connect` call until the call has returned or settled and the TLS handshake
over its stream has ended; a call that needs another of its kind waits for its
turn and fails at its deadline, unsent, and one for a read nobody waits for any
more is dropped without calling `connect`. A stream that closes before the
handshake has ended fails the connection at once, `network` with `code:
'ECONNRESET'`, unsent. A `connect` that ignores its `signal` and never settles
keeps its turn for good: with that many of them, every later call of its kind
waits and fails at its deadline. A stream that is no `net.Socket` keeps a
process alive as long as whatever is inside it does, as the client cannot reach
that.

The client keeps the rest: TLS to the node's terminator, end to end, with the
CA, name and pin checks on every connection; pooled connections for reads,
and a new `connect` call for each side-effecting call, whose connection closes
after the reply; `maxConcurrentRequests` over the requests out; the extra
attempt after a stale pooled connection; and one deadline over each call,
`connect` included. What is the caller's: the proxy's
address, trust and authentication, and the hop to it. A CONNECT request's
`Proxy-Authorization` travels in cleartext unless the connection to the proxy
is itself TLS; the proxy sees the node's host and port, and through the tunnel
only TLS. `connect` needs an `https` URL and Basic credentials: over `http`, or
with a cookie, the client could not see where the credentials go.

### A polluted `Object.prototype`

Every object inherits what `Object.prototype` holds wherever it has no
property of its own, and Node reads connection options, socket state and the
node's certificate from objects. So at the start of every call, once a client
method has built its request and before anything else the call does, and again
before it opens a connection and
before it sends each request, a pooled one included, the client checks
`Object.prototype`: if it has any enumerable property of its own, the call is
refused with `RpcTransportError` `reason: 'prototype_polluted'`. Nothing was
sent, it is not retried, and no option turns it off. The message gives how
many such properties there are, never their names, which come from whatever
put them there. Neither the language nor Node puts one there; something in
this process did, typically JSON parsed into a deep merge, or a path
assignment, that followed a `__proto__` key. Find it and remove it, and fix the
code that let it in: until then every call fails. A polyfill defines its
methods non-enumerable, as the language's own are, and is not refused.

That check is the protection. Behind it, for a property that is not
enumerable or appears during a handshake, the client also:

- reads the caller's objects (its options, `tls` and `auth`, request options
  and arguments, the call options, `batch()` entries) and the node's replies
  from their own properties only, as [Client options](#client-options) and
  [Typed methods](#typed-methods) say;
- sets every option Node reads from the objects it passes to `net.connect`,
  `tls.connect`, `http.request`, `https.request` and `dns.lookup`, and from
  Node's copies of them, own and undefined where unused, as found on Node
  22.13 and 24. None is read from the prototype: not a session to resume, a
  stream, path or lookup to connect through, nor an `agent` in place of the
  client's connections;
- reads the fields of the node's certificate that the name check uses
  (`subject` and `subjectaltname`), and for the pins its `raw` bytes, as the
  certificate's own properties only. Node 22 leaves `subjectaltname` unset on
  a certificate without one, and its own name check would read the
  prototype's.

What it cannot reach are the objects Node builds itself: the options of the
socket under a TLS socket and of the stream around a `connect` stream (such as
`pauseOnConnect`, `handshakeTimeout`, `handle` and `objectMode`), the socket
itself (its `blockList`), the certificate Node translates, stream state and
event listener tables. None of the keys checked lets a certificate, name or pin
check be skipped, or credentials in cleartext leave loopback.

**Known limit: pollution after the check can still crash the process.** The
check cannot see what lands after it, while a connection opens. The client
does not chase these keys into Node, as the outcome fails closed: the crash
comes before that connection carries a request. Any other call in flight dies
with the process, and its outcome is unknown. An application must remove the
pollution. Found on the versions tested, each thrown uncaught from inside Node,
and the same applies to a property that is not enumerable, which the check does
not see:

| Key on `Object.prototype` | Node | Thrown | When |
| --- | --- | --- | --- |
| `blockList`, not a block list | 22.13 and 24 | `self.blockList?.check is not a function` | A connection Node opens to the URL's host, pooled or fresh, not one through `connect`. |
| `handshakeTimeout`, not a number but above 0, such as `true` | 22.13 and 24 | `ERR_INVALID_ARG_TYPE` | A direct TLS connection, not one through `connect`. |
| `infoAccess`, not a string | 22.13 | `info.replace is not a function` | Any TLS handshake, `connect` included. |

### localhost

With an `http` URL, or with cookie authentication, credentials go to loopback
only. An address in the URL (127.0.0.0/8, `::1`, or IPv4 loopback mapped to
IPv6, `::ffff:127.0.0.1`) is checked when the client is constructed, and any
name but `localhost` is a `TypeError`. `localhost` is resolved as each
connection is made, by the system resolver (the hosts file, DNS), and the
connection is refused before anything is sent, `RpcTransportError`
`reason: 'not_loopback'`, unless every address is loopback: one address
elsewhere among them refuses it. Node connects to the addresses checked, with
no second lookup, so a name that resolves elsewhere later is caught by the
connection that would have gone there.

## Capabilities and the allowlist

Every method, typed or through `call()`, must be on the allowlist below, or in
the client's [`extraMethods`](#opening-another-method-extramethods), and its
capability must be enabled. A refused call throws `RpcCapabilityError` before
any request is made. The allowlist is not exported: this table is its
documentation, and a test keeps the two equal.

| Capability | Methods |
| --- | --- |
| none (read) | `getblockchaininfo`, `getnetworkinfo`, `getbestblockhash`, `getblockcount`, `getblockhash`, `getblockheader`, `getrawtransaction`, `getmempoolentry`, `gettxout`, `getconfirmationtarget`, `estimatesmartfee`, `validateaddress`, `verifydatapqchash`, `getblock`, `getchaintips`, `getmempoolinfo`, `getrawmempool`, `gettxspendingprevout`, `waitfornewblock`, `waitforblockheight`; untyped: `decoderawtransaction`, `decodepsbt`, `analyzepsbt`, `getorphanmetrics`, `getarchivepeers`, `getindexinfo`, `getzmqnotifications`, `uptime` |
| `wallet-read` | `getwalletinfo`, `gettransaction`, `listunspent`, `getaddressinfo`, `listlockunspent`, `listsinceblock`, `listtransactions`, `getbalances`; untyped: `listwallets` |
| `wallet-write` | `walletcreatefundedpsbt`, `walletprocesspsbt`, `finalizepsbt`, `psbtbumpfee`, `walletpassphrase`, `walletlock`, `getrawchangeaddress`, `lockunspent`, `getnewaddress` |
| `broadcast` | `testmempoolaccept`, `sendrawtransaction`, `submitpackage` |
| `node-admin` | none built in: node administration opens only through [extraMethods](#node-administration-node-admin) |

`sendmany`, `sendtoaddress`, `send`, `sendall` and `bumpfee` are not
allowlisted: they sign and broadcast in one step, so you cannot store the signed
transaction before it leaves the node. `psbtbumpfee` is allowlisted: it returns
an unsigned PSBT and signs and broadcasts nothing (see
[Bumping a stuck payment](#bumping-a-stuck-payment)). `finalizepsbt` and
`testmempoolaccept` change nothing, but are gated with the steps they belong to.

### Opening another method: `extraMethods`

qbit Core has many more methods. `extraMethods` opens one for one client,
untyped, through `call()` and `requests.raw()`, without changing the package.
Without the option no method is added.

```ts
const rpc = new QbitRpcClient({
  url,
  auth,
  expectedChain: 'testnet4',
  capabilities: ['wallet-write'],
  extraMethods: {
    getchaintxstats: { capability: 'read', sideEffects: false },
    keypoolrefill: { capability: 'wallet-write', sideEffects: true },
  },
})
const stats = await rpc.call('getchaintxstats', [144]) // numbers as JsonNumber
```

Each entry is the policy the client applies to the method, exactly as it does
to an allowlisted method with that policy:

- `capability`: `read` (no capability needed), or `wallet-read`,
  `wallet-write`, `broadcast` or `node-admin`, which `capabilities` must
  enable. `wallet-write`, `broadcast` and `node-admin` calls wait for the
  [chain guard](#chain-guard), and re-check the chain once it is stale;
  `node-admin` calls by the chain's identity only (see
  [node administration](#node-administration-node-admin)).
- `sideEffects`: required, `true` or `false`; there is no default. A method with
  side effects needs `wallet-write` or `broadcast`, so a client without them
  still cannot change state, and the chain guard covers every such call, or
  `node-admin`, for node administration. Such a
  call is never retried, uses a fresh connection, and is an
  `RpcUnknownOutcomeError` when it may have run (see the
  [failure model](#failure-model)).
- For each of the 161 methods qbit Core v1.0.0's `help` lists, the package
  knows what it does, from its source, and refuses a policy below that, so an
  entry cannot open `walletpassphrasechange` or `signrawtransactionwithwallet`
  as a read. A wallet method needs a wallet capability (`wallet-read` or
  `wallet-write`), and one that changes state needs `sideEffects: true` under
  its own kind's capability:

  | What the method does | Least policy | For example |
  | --- | --- | --- |
  | reads the chain, mempool, network or node, or computes from its arguments | any | `getchaintxstats`, `decodescript` |
  | reads a wallet | `wallet-read` or `wallet-write` | `getbalance`, `listlabels` |
  | signs with a wallet's keys, or changes the wallet | `wallet-write`, side effects | `signrawtransactionwithwallet`, `signmessage`, `setlabel`, `fundrawtransaction` |
  | administers a wallet, or returns its private keys | `wallet-write`, side effects (none for `listdescriptors` and `gethdkeys`) | `walletpassphrasechange`, `keypoolrefill`, `backupwallet`, `listdescriptors` |
  | hands a transaction to the mempool and the network | `broadcast`, side effects | `sendrawtransaction` |
  | builds or submits blocks, or changes a block template | `broadcast`, side effects (none for `getblocktemplate`) | `submitblock`, `prioritisetransaction` |
  | changes what the node stores, follows or connects to, or stops it | `node-admin`, side effects | `stop`, `setban`, `addnode`, `pruneblockchain`, `savemempool`, `ping` |

  Wallet administration and mining have no capability of their own yet: they
  need `wallet-write`, and `broadcast`, the capability that already changes
  what the node holds and relays. Node administration has its own,
  `node-admin`. qbit Core v1.0.0's 18 hidden methods, which `help` does not
  list, are classed the same way: `invalidateblock`, `reconsiderblock` and
  `setmocktime` need `node-admin`, and `generatetoaddress` the capability
  mining needs. A method in neither table, such as one a later release
  adds, keeps the policy you give it: the package cannot tell what it does.
  The regtest smoke test compares the table with `help` on the node, and
  each hidden name with `help <name>`, so a release that changes either
  fails it.
- In a [batch](#batches), only `read` and `wallet-read` entries, which have no
  side effects; any other, `node-admin` included, is `RpcCapabilityError`
  `not_batchable`.
- Every call takes a request slot ([the work queue](#the-work-queue)), and the
  call's or the client's deadline (30 s by default).

The constructor throws a `TypeError` naming the entry for:

- a name that is not lowercase letters and digits, from a letter, at most 64:
  every qbit Core method name has that form;
- an option or entry that is not a plain object (an object literal, or one
  made with `Object.create(null)`): a `Map` or a class instance has no own
  entries to read, and would open nothing;
- a policy below what the method does (above), naming the method and the
  policy it needs, such as `stop` under `broadcast`, which needs `node-admin`;
- a method the package allowlists already, with any policy but its own. Its
  own policy stands, so an entry cannot turn `walletpassphrase` into a read
  that is retried and never an unknown outcome. Restating the same policy is
  accepted, and the built-in one applies: when a later release allowlists a
  method you opened the same way, nothing breaks; when it allowlists it with
  another policy, the constructor throws until you remove or correct the entry;
- `sendmany`, `sendtoaddress`, `send`, `sendall` and `bumpfee`: they sign and
  broadcast in one step, so you cannot store the signed transaction before it
  leaves the node, and a lost reply leaves no txid to reconcile by. Build, sign,
  store, then `sendrawtransaction`;
- a key other than `capability` and `sideEffects`, an unknown capability, or a
  missing or non-boolean `sideEffects`;
- a capability `capabilities` does not enable, restated allowlisted methods
  included. Every call would be refused, so it is a configuration mistake,
  found at startup rather than at the first call. Clients that share one map
  pass each its own entries.

Only the object's own keys count, read once by the constructor: changing it
afterwards changes nothing. `toJSON()` and `util.inspect(client)` list the
opened methods with their policies, so an operator can see what a client
allows.

> **Warning.** An opened method is outside what this package checks and tests:
> its parameters go unchecked and its result unvalidated. For a method `help`
> lists, the package refuses a policy below what it does, but a policy above
> it is yours: `decodescript` under `broadcast` makes a read wait for the chain
> guard and never retry. For a method neither table holds, as a later release's, the policy is entirely
> yours, which the client cannot verify: one that changes node or wallet state
> declared with `sideEffects: false` is retried under `readRetries` and sent
> on a pooled connection, so it can run twice, and a lost reply looks like a
> definite failure, and a `read` entry is open to the client whatever its
> `capabilities` (`invalidateblock` as `read` lets a read-only service change
> the chain the node follows). Declare such a method with side effects when
> unsure. Open only what the service needs, and restrict the RPC user with
> `-rpcwhitelist` as well.

### Node administration: `node-admin`

`stop`, `setban`, `clearbanned`, `addnode`, `disconnectnode`,
`setnetworkactive`, `pruneblockchain`, `savemempool`, `importmempool`,
`logging`, `dumptxoutset`, `loadtxoutset`, `getblockfrompeer`,
`preciousblock` and `ping` change what the node stores, follows or connects
to, or stop it. They need the `node-admin` capability, which allowlists
nothing by default: a client reaches one only by enabling `node-admin` and
opening it in `extraMethods`, with side effects:

```ts
const admin = new QbitRpcClient({
  url,
  auth,
  expectedChain: 'testnet4',
  capabilities: ['node-admin'],
  extraMethods: { setban: { capability: 'node-admin', sideEffects: true } },
})
await admin.call('setban', ['127.0.0.2', 'add', 3600])
```

- Under any other capability, `broadcast` included, such an entry is a
  `TypeError` that names the method and `node-admin`, so a payment service
  that broadcasts cannot stop the node or ban a peer by stating `broadcast`.
- Under `node-admin`, on a client that does not enable it, the constructor
  throws, as for any capability.
- A `node-admin` call waits for the [chain guard](#chain-guard), as
  `wallet-write` and `broadcast` calls do, so a client that expects regtest
  never stops, bans or invalidates on a mainnet node it was pointed at by
  mistake. It is refused before `confirmChain()`, on another chain
  (`mismatch`), and when the chain cannot be confirmed (`stale`,
  `check_failed`). It needs the chain's identity only: on the expected chain
  with a qbit Core version this package does not support, which refuses the
  other guarded calls with `unsupported_version`, `stop` and `setban` still
  go out. Every client has an `expectedChain`, so there is no way round the
  guard: to administer a node whose chain cannot be confirmed, use
  `qbit-cli`.
- A `node-admin` call is never in a batch. Each has side effects: it is
  never retried, uses a fresh connection, and is an `RpcUnknownOutcomeError`
  when it may have run. `ping` too: it queues a ping on every peer.
- Enabling `node-admin` opens no allowlisted method, and no method that
  needs another capability.

A hidden method that administers the node (`invalidateblock`,
`reconsiderblock`, `setmocktime`, `addconnection`, `addpeeraddress`,
`mockscheduler`, `sendmsgtopeer`) needs `node-admin` with side effects too.

### Chain guard

`wallet-write`, `broadcast` and `node-admin` calls also need `await rpc.confirmChain()`.
Each chain check sends `getblockchaininfo`, `getblockhash 0` and
`getnetworkinfo` as one JSON-RPC batch, so one node answers all three in one
round trip, and compares three things: `chain` with `expectedChain`, the genesis
block hash with `expectedGenesisHash`, and on signet `signet_challenge` with
`expectedSignetChallenge` (a signet node that reports no challenge differs). It
also reads the node's version, which must be a supported one (see
[Versions and compatibility](#versions-and-compatibility)). Until a check has
matched all three on a supported version, or after one found any of them
different, they throw `RpcChainGuardError` (`reason: 'unconfirmed'` or
`'mismatch'`) without sending anything, and after one found an unsupported
version, `reason: 'unsupported_version'`. On
`mismatch`, `differs` lists what differed (`chain`, `genesis_hash`,
`signet_challenge`), `actualChain`, `actualGenesisHash` and
`actualSignetChallenge` hold what the node reported, `expectedChain`,
`expectedGenesisHash` and `expectedSignetChallenge` what the client expects,
and the message names each
difference. A chain name or challenge that differs is recorded as a `mismatch`
even when the `getblockhash 0` reply failed; `actualGenesisHash` is then
absent. A malformed constructor value is a `TypeError`, as is
`expectedSignetChallenge` without `expectedChain: 'signet'`.

| `expectedChain` | Default `expectedGenesisHash` |
| --- | --- |
| `main` | `0000000000004d60aa5d46013991d0a0e2995d89ee98e53068ae196d763e79f2` |
| `test` | `0000c20791706c6940a43d75db44d1ae9dadeb637cedfbaa5cf293435eeaab3c` |
| `testnet4` | `000000000000796fe86bbc0bf1b66a07e4b4c0676f74b54cf7e5ce8b3f1a0090` |
| `signet` | `0000000a5698c727f05cbdaeaff3e48b48ab187aeb03414e783ea81fed14d65c` |
| `regtest` | `0ee96aa77c4b600850e349344fa21b107e805f5370ddc7a6189db12cf69acce6` |

These are the genesis hashes qbit Core v1.0.0 asserts
(`src/kernel/chainparams.cpp`); `client.toJSON()` shows the one a client
expects. `expectedSignetChallenge` defaults to `51`, the challenge of qbit
Core's default signet. What the check still cannot tell apart:

- **Any two regtest nodes.** Every regtest node has the same genesis block.
- **The default signet and a look-alike.** Every signet has the same genesis
  block, so only the challenge tells signets apart, and `51` (OP_TRUE) is an
  open challenge: anyone can mine a separate signet with it. Pin a signet by a
  challenge only its operators can meet.
- **Two nodes of the same chain behind one URL** (see the end of this section).

Where `-rpcwhitelist` applies, the RPC user needs `getblockhash` and
`getnetworkinfo` as well as `getblockchaininfo` (qbitd answers a batch holding
a method the user may not call with HTTP 403 for the whole batch), and a proxy
in between must pass JSON-RPC batches.

A confirmation goes stale after `chainCheckMaxAgeMs` (default 10 s), and at
once on a connection error (including a reset keep-alive connection whose read
then succeeded on another attempt), an HTTP 401, or a changed cookie (qbitd
writes a new one each time it starts). A wallet-write or broadcast call made
while it is stale first runs the check again, under the call's own deadline
and in the same attempt, with no timer of its own. If that check fails, the
call is refused without being sent, with `RpcChainGuardError` `reason:
'check_failed'`, never an unknown outcome. Its `method` is the call's, and its
`cause` is what failed: an `RpcTimeoutError`, `RpcAbortedError`,
`RpcTransportError`, `RpcError`, `RpcResponseError` or
`RpcResponseTooLargeError` about `getblockchaininfo`, or `getblockhash` or
`getnetworkinfo` for an error or an invalid reply to that request. Nothing was sent, so calling again
is safe; `cause` tells whether soon is any use (a timeout, a dropped connection
or -28 warming up usually pass, an HTTP 403 does not). `check_failed` keeps
those failures' retry rules: `finalizepsbt` and `testmempoolaccept`, which have
no side effects, are retried under `readRetries`. A mismatch is not a failed
check: a chain name or challenge that differs is a `mismatch` even when the rest
of the reply failed, and so is a mismatch another check records while the
re-check fails. If the check finds another chain, genesis block or signet
challenge, the call is refused and so is every later one until `confirmChain()`
matches again; an unsupported version is refused the same way, until
`confirmChain()` finds a supported one. `rpc.chainStatus` is `unconfirmed`,
`confirmed`, `stale`, `mismatch` or `unsupported_version`. `confirmChain()` is a
read and the check itself, so it throws what failed as it is, never
`check_failed`.

The guard decides after a call's last wait, as it hands the request to the
transport: a mismatch recorded by another check while the call read its
cookie, ran its re-check or waited between re-checks still refuses it. (Once handed over, the request is
sent; nothing recorded after that can recall it.) A guarded call reads the
cookie once per attempt and sends its re-check and itself with that header: a
confirmation counts only for calls with the cookie it was made with, and if
qbitd restarts after the read, the node rejects the call with HTTP 401 instead
of running it.

A check whose answer arrives after a connection error or an HTTP 401 on any
call may predate it, so it changes nothing: the guarded call (or
`confirmChain()`) waits `retryDelayMs` (at most 10 s, and never past the
deadline) and checks again, up to three checks
per attempt, and then fails with `RpcChainGuardError` `reason: 'stale'`,
nothing sent; try again later. So `confirmChain()` resolves only once a check
made with the cookie it read confirmed the chain, and an unconfirmed client
stays refused until then. An answer reporting another chain always stands:
only a `confirmChain()` begun after it can clear it, and one that sees a
mismatch recorded while it runs throws it, unless a `confirmChain()` begun
after that mismatch cleared it first. It returns its own last check's
`getblockchaininfo` answer, which another check may have overtaken: call
`getBlockchainInfo()` for current block data.

The check and the call are separate requests. Behind a load balancer or DNS
name that can switch nodes, they can reach different nodes of the same chain
(or the check can reach the right node and the call another one): point the
client at one node.

## Versions and compatibility

This package supports **qbit Core 1.0.x releases**: 1.0.0 and any later 1.0
patch release, and no pre-release. It is tested against v1.0.0, the release
`scripts/qbit-core-release.mjs` names, by the regtest smoke test (CI's
`regtest smoke` job). A new minor version is supported only once that test
passes against it, in a release of this package that says so. The range is
defined once, in `src/version.ts`.

**The node's version.** Every chain check, `confirmChain()`'s and the re-check
before a wallet-write or broadcast call, reads `getnetworkinfo` in its batch, so
the version is checked as often as the chain: a guarded call checks again once
the confirmation is older than `chainCheckMaxAgeMs`, or after a sign of a qbitd
restart, as an upgrade is (a connection error, an HTTP 401, a new cookie).
`rpc.nodeVersion` holds the version from the newest check sent whose
`getnetworkinfo` reply was valid (undefined before the first), and `toJSON()`
shows it:

```ts
rpc.nodeVersion // { version: 10000, subversion: '/qbit:1.0.0/', major: 1, minor: 0, patch: 0, supported: true }
```

`version` is `getnetworkinfo.version`, 10000 × major + 100 × minor + patch, and
`subversion` the user agent, with any `-uacomment` in parentheses
(`/qbit:1.0.0(ours)/`). `supported` is true for the user agent `qbit` at 1.0.x
with no pre-release suffix: `/qbit:1.0.1/` is supported; `/qbit:1.1.0/`,
`/qbit:1.0.1-rc1/` and `/qbit:0.1.2-testnet4/` are not.

On a version that is not supported, wallet-write and broadcast calls are
refused (`node-admin` calls are not: they need the chain's identity only),
unsent, with `RpcChainGuardError` `reason: 'unsupported_version'` (its
`nodeVersion` says which), and `chainStatus` is `unsupported_version`. Like a
mismatch, it stands until a `confirmChain()` begun after it finds a supported
version, and `confirmChain()` throws it. It is reported even when the node's
`getblockchaininfo` reply does not validate, as a newer version may be why; a
chain that differs is reported first, and a recorded mismatch stays until a
`confirmChain()` begun after it reads a valid `getblockchaininfo` and
`getblockhash 0` that match. Reads are not refused: they still
validate every reply, so one a newer version changed fails as `RpcResponseError`,
and `nodeVersion` tells you why it may have. Set `allowUnsupportedNodeVersion:
true` to send guarded calls anyway, taking the risk that the node reads an
argument differently, which no validation catches. A version that does not
parse is never taken for a supported one: a `version` that is not an integer
from 0 to 2,147,483,647, a `subversion` not of the form `/name:major.minor.patch/`
(with qbit Core's optional `-phase` and `-rcN` suffixes and comments), or one
that disagrees with `version`, fails the check with `RpcResponseError` about
`getnetworkinfo`, whatever `allowUnsupportedNodeVersion` says: `confirmChain()`
throws it, and a guarded call is `check_failed` with it as `cause`.
`getNetworkInfo()` reads `version` and `subversion` with the same reader, so it
fails on such a reply too, at the same path.

**Values a later qbit Core may add.** A field this package reads is required
when qbit Core v1.0.0 prints it, except `paytxfee`
(`WalletInfo.payTxFeeBitsPerKvB`), which Bitcoin Core has deprecated: it is
optional, so its removal does not break `getWalletInfo()`. Fields the node adds
are dropped. An enum is open or closed:

| Value | An unknown value | Why |
| --- | --- | --- |
| `BlockchainInfo.chain` | Passed through | The chain guard compares it with `expectedChain` itself, so an unknown name is a `mismatch`. |
| `ConfirmationTarget.model.hashrateSource` | Passed through | It describes the model; the result means the same whatever it is. |
| `WalletInfo.pqcKeyValidation.status` | Passed through | `signingBlocked` says whether the wallet signs. |
| `PqcLimitState`: `pqcLimitState`, `pqcOverallLimitState` and each key's | Passed through | A signature-budget state must reach you, never be dropped or coerced: treat one you do not know as at least `critical`. |
| `WalletTxCategory`: `category` | Fails validation | The sign and fee checks are per category, and so are the sums of what a wallet received and sent. |
| `bip125Replaceable` | Fails validation | Its `unknown` already means "cannot tell". |
| `ConfirmationTarget.securityLevel` | Fails validation | It names the level the call asked for. |

An open value is typed as its known values or `(string & {})`, so the known
ones still complete in an editor and a `switch` over them needs a `default`. It
passes through as any non-empty string, as the node sent it; an empty or
non-string one fails validation. The JSON-RPC envelope stays strict: a reply
object with a key besides the four JSON-RPC 2.0 defines (`jsonrpc`, `id`,
`result`, `error`) is an `RpcResponseError` (`reason: 'protocol'`).

## Typed methods

Results are validated field by field (hashes, hex, integer ranges, enums,
amounts) and returned with camelCase names; fields the node adds beyond these
are dropped (use `call()` for the raw reply). Which enums take a value a later
qbit Core adds, and which fields may be absent, is in
[Versions and compatibility](#versions-and-compatibility). Every object in a result, typed or
from `call()`, has a null prototype: an absent field must read as `undefined`
even if `Object.prototype` is polluted after the reply arrives, such as a
missing `blockHash` on an unconfirmed transaction. The client reads the reply
itself by its own properties too. So `toStrictEqual` and `assert.deepStrictEqual`
against a plain object literal fail (use `toEqual`), a result object has no
`hasOwnProperty` (use `Object.hasOwn`), and `String()` throws on one; spread a
result into `{}` for a plain object. A result that does not validate
throws `RpcResponseError` with `reason: 'validation'` and the `path` of the
offending value. After a side-effecting call the node has acted, so that error
is the `cause` of an `RpcUnknownOutcomeError`. Each method also takes
[call options](#call-options) as its last argument, left out below.

| Method | Returns |
| --- | --- |
| `getBlockchainInfo()` | `BlockchainInfo`, including `p2mrValidationWeight` and `futureBlockTime` |
| `getNetworkInfo()` | `NetworkInfo`; `relayFeeBitsPerKvB`, `incrementalFeeBitsPerKvB` |
| `getBestBlockHash()`, `getBlockHash(height)` | block hash |
| `getBlockCount()` | the tip's height |
| `getBlockHeader(hash)` | `BlockHeader`; checks the hash, `versionHex` and genesis linkage |
| `getBlock(hash)` | `Block` (verbosity 1): the header's fields, `strippedSize`, `size`, `weight` and `tx`, the txids; checks the hash and `nTx`; `RpcError` -5 for an unknown block, -1 for a pruned one |
| `getBlockWithTransactions(hash)` | `BlockWithTransactions` (verbosity 2): `tx` decoded as in `getRawTransactionVerbose`, with `feeBits` where undo data allows; see [large replies](#large-replies) |
| `getBlockHex(hash)` | the block as stored, as hex (verbosity 0), its header checked to hash to `hash` |
| `getChainTips()` | `ChainTip[]` (`height`, `hash`, `branchLen`, `status`); checks there is one `active` tip, the only one with `branchLen` 0 |
| `waitForNewBlock(waitMs, { currentTip? })`, `waitForBlockHeight(height, waitMs)` | `BlockRef` (`hash`, `height`), the tip; see [long polls](#long-polls) |
| `getRawTransaction(txid, { blockHash? })` | hex, checked to hash to `txid` |
| `getRawTransactionVerbose(txid, { blockHash? })` | `DecodedTransaction`, output values as `valueBits` |
| `getMempoolInfo()` | `MempoolInfo`; the fee floor is `mempoolMinFeeBitsPerKvB` |
| `getRawMempool()` | the txids in the mempool |
| `getRawMempoolVerbose()` | `Record<txid, MempoolEntry>`; see [large replies](#large-replies) |
| `getRawMempoolSequence()` | `MempoolSnapshot`: `txids` and `mempoolSequence`, a `bigint` as in the ZMQ `sequence` topic |
| `getTxSpendingPrevout(outputs)` | `TxSpendingPrevout[]`, one per output in order, checked against them: `spendingTxid` names the mempool transaction spending it, absent otherwise. An output spent in a block looks unspent |
| `getMempoolEntry(txid)` | `MempoolEntry`: sizes, `depends`, `spentBy`, fees as `baseBits` and so on; `RpcError` -5 when not in the mempool |
| `getTxOut(txid, vout, { includeMempool? })` | `TxOut` with `valueBits` and `coinbase`, or `null` when spent or unknown; `vout` 0 to 4,294,967,295 |
| `getConfirmationTarget(valueBits, { securityLevel?, mergeMiningPct?, btcHashrate? })` | `ConfirmationTarget` (the node's float `value_qbt` echo is dropped) |
| `estimateSmartFee(confTarget, { mode? })` | `{ feeRateBitsPerKvB?, errors?, blocks }` |
| `validateAddress(address)` | `AddressValidation`, a union on `isValid` |
| `verifyDataPqcHash(proof)` | `DataPqcHashVerification` |
| `testMempoolAccept(rawTxs, { maxFeeRateBitsPerKvB? })` | one `MempoolAcceptance` per transaction, checked against each hex's txid; see [fee-rate caps](#fee-rate-caps) |
| `sendRawTransaction(hex, { maxFeeRateBitsPerKvB?, maxBurnAmountBits? })` | txid, checked against the hex; see [fee-rate caps](#fee-rate-caps) |
| `submitPackage(rawTxs, { maxFeeRateBitsPerKvB?, maxBurnAmountBits? })` | `PackageSubmission`; see [submitting a package](#submitting-a-package-cpfp) |
| `getWalletInfo()` | `WalletInfo`, including `pqcKeyValidation` |
| `getTransaction(txid)` | `WalletTransaction`; signed `amountBits` and `feeBits` |
| `listUnspent(options?)` | `UnspentOutput[]` |
| `getAddressInfo(address)` | `AddressInfo` with the PQC usage fields; checks the address, ignoring case only for bech32 and bech32m |
| `listLockUnspent()` | `Outpoint[]` (`{ txid, vout }`) |
| `listSinceBlock({ blockHash?, targetConfirmations?, includeWatchOnly?, includeRemoved?, includeChange? })` | `SinceBlockHistory`: `transactions`, `removed`, `lastBlock`; `RpcError` -5 for an unknown block |
| `listTransactions({ label?, count?, skip?, includeWatchOnly? })` | `WalletHistoryEntry[]`, the newest `count` (default 10), oldest first |
| `getBalances()` | `WalletBalances`: `mine` (`trustedBits`, `untrustedPendingBits`, `immatureBits`, `usedBits?`) and `lastProcessedBlock` |
| `walletCreateFundedPsbt({ inputs?, outputs, locktime?, options?, bip32derivs?, version? })` | `{ psbt, feeBits, changePos }` |
| `walletProcessPsbt(psbt, { sign?, sighashType?, bip32derivs?, finalize? })` | `ProcessedPsbt` with the PQC usage fields |
| `finalizePsbt(psbt, { extract? })` | `{ psbt?, hex?, complete }` |
| `psbtBumpFee(txid, { feeRateBitsPerKvB?, confTarget?, estimateMode?, replaceable?, outputs?, originalChangeIndex? })` | `BumpedPsbt`: `{ psbt, originalFeeBits, feeBits, errors }`, the PSBT unsigned |
| `walletPassphrase(passphrase, timeoutSeconds)`, `walletLock()` | nothing; see [unlocking a wallet](#unlocking-an-encrypted-wallet) |
| `getRawChangeAddress({ addressType? })` | a new change address; see [address types](#address-types) |
| `getNewAddress({ label?, addressType? })` | a new receiving address, filed under `label` |
| `lockUnspent(outputs, { persistent? })` | nothing, once every output is locked |
| `unlockUnspent(outputs)` | nothing, once every output is unlocked |

`AddressInfo` and `ProcessedPsbt` carry qbit Core's PQC signature-budget
fields: for the keys of one of the wallet's addresses (`getaddressinfo`, absent
for other addresses), or for the local keys that signed (`walletprocesspsbt`).
They are `pqcKeyStates` (per key: `pubkey`, `pqcSignatureCount`,
`pqcSignatureLimit`, `pqcSignaturesRemaining`, `pqcLimitState`),
`pqcOverallLimitState`, and the four single-key fields when exactly one key is
involved; `ProcessedPsbt` adds `warnings`. `pqcLimitState` is `normal`,
`warning`, `critical` or `exhausted`, or a state a later qbit Core adds, passed
through as it is: treat a state you do not know as at least `critical`. A key's
limit is 2^30 signatures. qbit Core v1.0.0's `getwalletinfo` does not report
these counts. What each state means and what to do:
[PQC signature budgets](#pqc-signature-budgets).

`lockUnspent(outputs)` locks outputs against automatic coin selection and
`unlockUnspent(outputs)` unlocks them, both through qbit Core's `lockunspent`.
A lock lives in memory and is gone after a node restart, unless it was made
with `lockUnspent(outputs, { persistent: true })`: then it is written to the
wallet and loaded again when the node starts. Locking an output that is locked
already is refused, except with `persistent`, which locks it again,
persistently. `unlockUnspent` takes no `persistent` (qbit Core ignores it
there) and clears either kind of lock. The node checks every output first: one
that is unknown, spent, already locked (locking) or not locked (unlocking)
rejects the whole call with `RpcError` -8 and changes nothing. Both resolve with
nothing once every output is done; qbit Core answers `true` or an error, and any
other reply fails validation. `outputs` must not be empty: qbit Core reads an
empty list as "do nothing", and a left-out one as "unlock everything", which is
`call('lockunspent', [true])`. `vout` is 0 to 2,147,483,647: qbit Core reads it
as a signed 32-bit integer here. `getRawChangeAddress` takes a key from the
change keypool. All three are side-effecting wallet-write calls.

`getNewAddress` takes a key from the receiving keypool and files the address
under `label` (the default label, `''`, when left out; `*` is refused before
sending, as qbit Core reserves it). It is side-effecting too: never retried,
and a lost reply is an `RpcUnknownOutcomeError`, since a second call would hand
out a second address.

### Unlocking an encrypted wallet

`walletPassphrase(passphrase, timeoutSeconds)` unlocks the wallet for
`timeoutSeconds`, counted from when qbit Core finishes the unlock, and
`walletLock()` locks it again. Both are side-effecting wallet-write calls.

**The first unlock is slow.** On a chain that allows only P2MR outputs (every
chain, unless regtest runs with `-p2mronly=0`), qbit Core v1.0.0 creates a
wallet with a passphrase with 16 keys per descriptor, and derives the rest of
its keypool (`-keypool`, 1,000 by default) inside the wallet's first
`walletpassphrase`, which answers only once that is done. On regtest that first
unlock took 25 to 31 s on a shared host and 49 s on a GitHub-hosted
`ubuntu-latest` runner; later ones take about 0.2 s. Unloading and loading the
wallet, or restarting the node, does not skip it. The time grows with
`-keypool`: on that host 2.3 s at 100 keys, 13 s at 500, 28 s at 1,000 and 53 s
at 2,000. While it runs, every other call on that wallet waits for it,
`getWalletInfo()` and `walletLock()` included; chain calls and other wallets do
not. A wallet created without a passphrase derives the rest of its keypool in
the background instead, from 30 s after it is created or loaded: no call waits
for all of it, only about 0.2 s each while it runs.

**The default deadline.** So `walletPassphrase` and `walletLock`, typed or as
`walletpassphrase` and `walletlock` through `call()`, have a default deadline of
120 s, more than twice the slowest first unlock measured. Every other method
keeps 30 s. A client's `timeoutMs` applies to these two only when it is longer
than 120 s, so a client that sets a short one does not cut the first unlock, or
a lock waiting for it. The call's own `timeoutMs` always wins:

```ts
const rpc = new QbitRpcClient({ ...options, timeoutMs: 10_000 }) // every call; these two keep 120 s
await rpc.walletPassphrase(passphrase, 60) // 120 s
await rpc.walletLock() // 120 s
await rpc.walletPassphrase(passphrase, 60, { timeoutMs: 300_000 }) // the call's own wins
```

Every other call keeps the client's deadline, so one on that wallet sent during
a first unlock can need a longer `timeoutMs`: a read such as `getWalletInfo()`
that misses it is an `RpcTimeoutError` you can repeat, a side-effecting call
such as `getNewAddress()` an `RpcUnknownOutcomeError`.

With a `-keypool` above about 2,000, or a host slower than that runner, pass a
longer `timeoutMs`, or unlock the wallet once right after creating it, before
it serves anything.

**A missed deadline.** Once it is sent, a `walletPassphrase` that misses its
deadline or is aborted rejects with `RpcUnknownOutcomeError`: qbit Core may still
be unlocking the wallet, or may have unlocked it. Before it is sent (waiting
for a request slot, reading the cookie, connecting, or in the chain re-check)
it rejects with `RpcTimeoutError` or `RpcAbortedError`, or `RpcChainGuardError`
`check_failed` with one of those as its `cause`: nothing was sent, and calling
it again is safe. After an `RpcUnknownOutcomeError`, `getWalletInfo()` tells
which: `unlockedUntil` is 0 while the wallet is locked, the Unix time it locks
again once unlocked, and absent on a wallet with no passphrase. It waits for an
unlock still running, so give it a deadline that covers one. If it fails too,
the outcome is still unknown, so the original error is the one to report:

```ts
try {
  await rpc.walletPassphrase(passphrase, 60)
} catch (error) {
  if (!RpcUnknownOutcomeError.is(error)) throw error // not sent, or the node's answer
  // getwalletinfo waits for an unlock still running.
  const info = await rpc.getWalletInfo({ timeoutMs: 120_000 }).catch(() => undefined)
  if (!info?.unlockedUntil) throw error // locked, or no answer: still not unlocked for sure
  // unlocked, until info.unlockedUntil
}
```

Calling `walletPassphrase` again is safe too: it waits for one still running,
then sets a new relock time. `walletLock()` also waits for it, under the same
default deadline.

### PQC signature budgets

Each P2MR address of a wallet has its own PQC key, and qbit Core v1.0.0 lets a
key make 2^30 (1,073,741,824) signatures. It counts each signature the key
makes, one per input it signs, and writes the count to the wallet before
signing: signing the same unsigned PSBT twice uses two, broadcast or not. The state follows from
the count (`src/wallet/pqc_usage.h`):

| `pqcLimitState` | Count | The node | What to do |
| --- | --- | --- | --- |
| `normal` | below 2^28 | signs | nothing |
| `warning` | from 2^28 (268,435,456) | signs; a `warnings` line on entering, and again every further 2^24 signatures | plan to move the coins to a new address, and stop reusing this one |
| `critical` | from 2^30 − 2^24 (1,056,964,608) | signs; a line on entering, and again every further 2^20 signatures | stop using the address and spend its coins to a new one now, while every coin still has a signature (one per input) |
| `exhausted` | 2^30, none left | signs nothing more with the key | the wallet can no longer spend the address's coins: lock them with `lockUnspent(outputs, { persistent: true })`, so coin selection skips them after a restart too, and lock a coin that arrives there later the same way (`listUnspent` with `addresses` and `minConf: 0` finds it, unconfirmed too); rotate to a new key/address, as the node's warning says |

What to watch, as observed on a v1.0.0 regtest node:

- `walletProcessPsbt` reports only the keys that signed in that call, with the
  count after signing. The signature that reaches the limit is reported as
  `exhausted`, `pqcSignaturesRemaining` 0, and the warning `PQC key <pubkey>
  reached the signature limit (1073741824 of 1073741824 signatures used, 0
  remaining). Rotate to a new key/address.` The other lines read `PQC key
  <pubkey> entered warning usage range (…)` or `… remains in critical usage
  range (…)`. Lines are text for people: act on `pqcLimitState`.
- An exhausted key is not an error. `walletProcessPsbt` resolves with
  `complete: false`, leaves that key's inputs unsigned, and says nothing about
  it: a PSBT only that key would sign comes back with no PQC fields and no
  warning, and beside other keys only they are reported, so
  `pqcOverallLimitState` can be `normal`. With two inputs and one signature
  left, the first input is signed and the second is not.
- The wallet still lists an exhausted key's coins as spendable, counts them in
  its balance, and `walletCreateFundedPsbt` picks them.
- So read the state of the keys you are about to use: `getAddressInfo` of each
  input's address before signing (the addresses `decodepsbt` gives for the
  funded PSBT's inputs, which can include the wallet's unconfirmed change; the
  root README's quick start reads them in one `batch`), and of the change
  address before you reuse it. `getAddressInfo` reports any state, `exhausted`
  too, without warnings. Refuse to sign on `exhausted` or a state you do not
  know, or when a key has fewer signatures left (`pqcKeyStates`) than the
  inputs it would sign; `critical` is when to sign the spend that moves the
  coins on. An
  incomplete PSBT whose inputs are all the wallet's own may mean an exhausted
  key.
- The count is the wallet's own. A wallet restored from a backup counts from
  the backup's count, and one the descriptor is imported into counts from 0
  (`test/functional/wallet_pqc_usage.py`), so neither knows the signatures the
  key made since, or elsewhere.

How this was checked: qbit Core v1.0.0 has no option to lower the limit, so the
regtest smoke test writes a key's count into the wallet file below each
threshold, reloads the wallet and signs; it asserts each state, both reminder
lines, the limit, and the exhausted key's incomplete PSBT. The reasoning for
the advice in the last column is ours, not the node's; that the worst key sets
`pqcOverallLimitState` when several keys differ is read from the source only;
and no key has reached these counts by signing.

### Address types

`getNewAddress`'s and `getRawChangeAddress`'s `addressType`, and
`walletCreateFundedPsbt`'s `options.changeType`, are an `AddressType`: `p2mr`,
`bech32m`, `bech32`, `p2sh-segwit` or `legacy`, the five names qbit Core v1.0.0
parses. Any other string is refused before sending, as the node refuses it
(`RpcError` -5); the type is closed so that a typo fails to compile. Which of
the five a wallet can make depends on the chain:

| Chain | Address types |
| --- | --- |
| `main`, `test`, `testnet4`, `signet` | `p2mr` only |
| `regtest` | `p2mr` only, unless qbitd runs with `-p2mronly=0`: then all five |

A type the chain does not allow is the node's `RpcError` -5. Left out, the
wallet's `-addresstype` or `-changetype` applies.

### Fee-rate caps

`testMempoolAccept`, `sendRawTransaction` and `submitPackage` take `maxFeeRateBitsPerKvB`, the
highest fee rate to accept, in bits per 1,000 vbytes: `1n` to `99_999_999n`
(qbit Core refuses 1 QBT/kvB or more). Left out, qbit Core's default cap
applies: 0.10 QBT/kvB, `10_000_000n` (10,000 bits/vB; `DEFAULT_MAX_RAW_TX_FEE_RATE`
in v1.0.0, and `help sendrawtransaction` shows it). `0n` is refused before
sending: qbit Core reads a cap of 0 as no cap at all, the opposite of what a cap
of zero says. To send without any cap, use
`call('sendrawtransaction', [hex, 0])`.

### Submitting a package (CPFP)

`submitPackage(rawTxs)` submits 1 to 25 signed transactions together, parents
first and the child last, so that the child's fee can pay for its parents. It
needs `broadcast`, waits for the chain guard, and is never retried. Unlike
`sendRawTransaction`, a refusal is a result, and it can be partial:

```ts
const { packageMsg, txResults } = await rpc.submitPackage([parentHex, childHex])
// 'success': every transaction was accepted or was in the mempool already.
// Anything else: the node's text. Read each entry of txResults, by wtxid:
// { txid, vsize?, fees?, otherWtxid?, error? }
```

- With `packageMsg` other than `success`, the parent can be in the mempool while
  the child was refused, and transactions can have no entry, when the package
  failed before each was evaluated. Check `getMempoolEntry` for what matters.
- The node's error is a definite `RpcError` only when qbit Core v1.0.0 raises
  it before handing any transaction to the mempool (`src/rpc/mempool.cpp`):
  -28 (starting), -3 (a parameter of the wrong type, or a cap that is not an
  amount), -8 (no transaction or more than 25, or a fee-rate cap of 1 QBT/kvB
  or more), -22 (a transaction that does not decode), and -25 with one of two
  texts, `Unspendable output exceeds maximum configured by user (maxburnamount)`
  (`maxBurnAmountBits`) and `package topology disallowed. not child-with-parents
  or parents depend on each other.` (a child that is not last); and the
  JSON-RPC layer's -32700, -32600, -32601 and -32602, raised before any method
  runs. Any other error can come after part of the package was accepted: a failed relay (`transaction
  broadcast failed: ... (N transactions were broadcast successfully)`, as -25,
  -26 or -27), a mempool error (-25), or a failed internal check (-1). Each is
  an `RpcUnknownOutcomeError` whose `cause` is the node's `RpcError`, with
  `txids`.
- On qbit Core v1.0.0 a child cannot rescue a parent below the relay floor
  (`minRelayTxFeeBitsPerKvB`, 250 bits/kvB by default): that parent's `error` is
  `min relay fee not met`. What a child can pay for is a parent above that floor
  and below a mempool floor raised by a full mempool. In the source, version 3
  (TRUC) parents are the one exception; this package's tests do not cover them.
- A lost reply is an `RpcUnknownOutcomeError` too. Its `txids` hold one entry
  per transaction, in package order, typed or through `call()`: the txid
  computed from its hex, or `null` where this package cannot parse the hex,
  which is sent all the same, as `sendRawTransaction` sends it (the node
  decides). `txid` stays unset, even for one transaction. Any of them may have
  been accepted. Submitting the same hex again is harmless: a transaction in the
  mempool already counts as success.

`maxFeeRateBitsPerKvB` is checked for each transaction, and `maxBurnAmountBits`
(default `0n`) for each output of each, as for `sendRawTransaction`.

### Large replies

qbit Core v1.0.0's largest block is 2,000,000 bytes, and its verbose JSON is many
times that: a transaction's hex, and its witness again, print at twice their
size, and each output prints its script three ways and its address. A 3.8 kB
P2MR spend prints about 16 kB, and a 1.92 MB regtest block of 8,800-output
transactions printed 21.1 MB at verbosity 2 (1.3 kB at verbosity 1, 3.8 MB at
verbosity 0), past the default `maxResponseBytes` of 16 MiB. A reply over the cap
stops at the cap as `RpcResponseTooLargeError`, which for a read changes nothing
on the node: it is not retried, and the same call will fail the same way.

A client that reads whole blocks should set `maxResponseBytes` above what it
expects, such as `64 * 1024 * 1024` (the most is 256 MiB), knowing that it holds
each reply in memory as it parses it. The limit is per client, so a scanner can
have its own. Alternatively read `getBlock` for the txids, and each transaction
with `getRawTransactionVerbose(txid, { blockHash })`. That block took 0.2 s to
answer on loopback; a slow link needs a longer `timeoutMs`, which bounds the
whole read.

`getRawMempoolVerbose()` has the same bound: an entry prints about 450 bytes, so
a mempool of some 37,000 transactions passes 16 MiB, which the default 300 MB
mempool can hold. `getRawMempool()` prints about 67 bytes per transaction.

### Long polls

`waitForNewBlock` and `waitForBlockHeight` are a fallback where
[`@qbit-oss/zmq`](../zmq/README.md) is not available. The node holds the request
until a block arrives or `waitMs` has passed, then answers with the tip, which is
not an error when the wait ran out:

```ts
let tip = await rpc.getBestBlockHash()
for (;;) {
  const next = await rpc.waitForNewBlock(60_000, { currentTip: tip })
  if (next.hash === tip) continue // the wait ran out
  tip = next.hash
}
// Below the height asked for: the wait ran out.
const { height } = await rpc.waitForBlockHeight(target, 60_000)
```

Pass `currentTip`: without it the node waits for a change from the tip when it
runs the call, and a block found between two calls is missed. For the same
reason, `waitForNewBlock` without `currentTip` is never retried, whatever
`readRetries`: a retry would wait from the tip at the retry, past a block found
since the first attempt. With `currentTip` it is safe to retry, as
`waitForBlockHeight` is.

**`waitMs` and the deadline.** `waitMs` is the node's own timeout, from 1 to
3,590,000 ms. qbit Core reads 0 as no timeout, so it is refused. The deadline
must outlast it by 10 s, for the wait for a request slot and the reply, or a
call that sees no block could only end as a timeout, so the client's
`timeoutMs` does not cut it short: unless the call gives its own, the deadline
is the longer of `waitMs` plus 10 s and the client's `timeoutMs`. A call's own
`timeoutMs` below `waitMs` plus 10 s is a `RangeError`, unsent. A 34 s wait,
longer than `qbitd`'s `-rpcservertimeout` of 30 s, answered in 34.007 s on
regtest. Each attempt asks the node to wait no longer than the deadline has
left, less those 10 s (of which a first attempt's own setup may use 1 s):
after a long wait for a request slot, or on a retry under `readRetries`, that
is less than `waitMs`, so the call answers with the tip rather than time out,
and with nothing left it ends as an `RpcTimeoutError` without sending. A long
poll is never in a batch, however its request was built. As a read, that is safe to call again.

**Other calls.** A long poll holds a [request slot](#the-work-queue) and a
`qbitd` worker for its whole wait. One leaves the other seven slots of the
default `maxConcurrentRequests` free, but `maxConcurrentRequests` long polls stop
that client's other calls, which wait behind them and can time out unsent, so give
long polls their own client, or count them in the limit. Across all clients, keep
long polls well below `-rpcthreads` (default 16): with all workers holding one,
every other request to the node waits, which is not refused.

**Giving up.** `qbitd` does not notice a client that left. A long poll aborted or
past its deadline frees its slot at once, but holds its worker until its wait ends
or a block arrives: with 16 abandoned 20 s waits on regtest, a plain read took 19 s.
Keep `waitMs` to what you would wait for anyway.

A long poll is refused in a batch (`not_batchable`), typed or raw: the batch's
other calls would wait behind it, under one deadline. Through `call()` and
`requests.raw()` the same rules apply, the wait read from the method's timeout
parameter (`waitfornewblock`'s first, `waitforblockheight`'s second): it must
be 1 to 3,590,000 ms, and absent or 0, which the node reads as a wait with no
end, it is a `RangeError` that says to pass a timeout. `waitforblock`, which
`extraMethods` can open, is bounded the same way by its second parameter.

### Bumping a stuck payment

```ts
const bump = await rpc.psbtBumpFee(txid, { feeRateBitsPerKvB: 4_000n }) // 4 bits/vB
const signed = await rpc.walletProcessPsbt(bump.psbt)
if (!signed.complete) throw new Error('the wallet could not sign every input')
await store(txid, signed.hex!) // before it leaves the node
await rpc.sendRawTransaction(signed.hex!)
```

`psbtBumpFee` builds a replacement (RBF) for one of the wallet's unconfirmed
transactions, with a higher fee, and returns it as an unsigned PSBT: nothing is
signed or sent. The replacement spends every input of the original, so at most
one of the two can confirm, and it may add inputs. The outputs stay as they
were unless you pass `outputs`; the extra fee comes out of the change output the
wallet recognises, or out of `originalChangeIndex`, whatever that output pays
(pointing it at a payment makes the payment smaller). `feeRateBitsPerKvB` must
be at least the original's rate plus the node's incremental relay fee
(`RpcError` -8 otherwise). Without it the wallet estimates, and with `outputs`
that shrink the transaction the estimate can come to no more than
`originalFeeBits`, which the mempool refuses (-26): compare the two, or pass a
fee rate. qbit Core v1.0.0 also bumps a transaction that did not signal BIP 125,
and its mempool took that replacement on regtest. The wallet must be unlocked
(-13). Check `complete` after signing: with inputs of another wallet, it is
false.

It is a side-effecting wallet-write call although it signs nothing: when the
original has no change output the wallet recognises, or `outputs` leave out its
change address, each call takes change keys from the keypool for good, and each
returns another transaction. It is never retried, and a lost reply is an
`RpcUnknownOutcomeError`. That is safe to resolve by calling again, since nothing
was signed or sent; at worst it uses up more change keys. The change position is
random, so even a repeat call that takes no key can return another PSBT and
txid: never reconcile by the txid of a bump.

Reconcile by the original's txid and the txid of each replacement you actually
broadcast, which is why the signed hex is stored first. After an unknown
outcome from `sendRawTransaction`, look both up (`getTransaction`) instead of
building the payment again: they spend the same inputs, so at most one
confirms, and sending the stored hex again returns the same txid while it is in
the mempool (once it is mined, -27 while one of its outputs is unspent and -25
once all are spent, so rely on `getTransaction`). If the original confirms first, the bump
loses the race: `psbtBumpFee` rejects with -1 (an input "is already spent"), and
a replacement signed earlier is refused with -25 (`testMempoolAccept` reports
`missing-inputs`); the payment went through as it was. Once a replacement
confirms, the original has negative `confirmations`, and sending it again fails
with -25. qbit Core names the replacement (`replacedByTxid`, `replacesTxid`)
only when `bumpfee` made it: after `psbtBumpFee` and `sendRawTransaction`, the
original lists it in `walletConflicts` (and in `mempoolConflicts` while it is
in the mempool) and is no longer `trusted`. To bump again, bump the replacement you broadcast: the wallet still
bumps the original, but that fee only has to beat the original's, and the
mempool refuses it (-26) unless it beats the replacement's too.

### Wallet history

`listSinceBlock` and `listTransactions` return `WalletHistoryEntry` objects,
one per output a wallet transaction sent or received, in signed bits:
`amountBits` is at most 0 for `send` (0 for an OP_RETURN output, which has no
`address`) and at least 0 for every other category. `feeBits` is on every
`send` entry and no other. It is all outputs minus this wallet's inputs,
repeated on each of the transaction's `send` entries, so do not add it up per
entry. When every input is this wallet's, that is the fee, as a negative
number; with inputs from other wallets it is not the fee, and it can be
positive. A payment to the wallet itself is a `send` and a `receive` entry for
one output. `blockHash`, `blockHeight`, `blockIndex` and `blockTime` (the block
header's time, unlike the wallet's `time` and `timeReceived`) are present
exactly when `confirmations` is above 0, and `trusted` exactly when it is not.
`confirmations` is negative for a transaction that a mined conflict replaced,
and `abandoned` marks a transaction the wallet gave up on, or an orphaned
coinbase.

Use `listSinceBlock` as a cursor: store `lastBlock` and pass it as the next
call's `blockHash`. `transactions` holds every entry of the later blocks and
every entry at 0 confirmations, plus the `send` entries of a transaction a later
block conflicted. An unconfirmed entry comes back until it is mined. An
abandoned transaction or orphaned coinbase stays at 0 confirmations and comes
back on every call until it is mined after all (it then confirms, with
`abandoned` false), a conflict is mined (negative `confirmations`), or the
orphaned block is reconnected; an entry that stops being listed may have gone
either way, and `getTransaction` tells which. Key entries by `txid`, `vout` and
whether the entry is a `send` (a payment to the wallet itself has a `send` and a
`receive` entry for one `vout`), and keep the latest `category`: a coinbase
output goes from `immature` to `generate`, or to `orphan`. With
`targetConfirmations: n`, `lastBlock` is n - 1 blocks below the tip (the genesis
block on a shorter chain), so entries keep coming back until they have n
confirmations. When the stored block has left the active chain, the call lists
from the fork point, and `removed` holds the entries of the blocks that left,
each as it is now: 0 `confirmations` back in the mempool, positive with its new
block when mined again, negative when a conflict was mined instead. `removed` is
absent only when `includeRemoved: false` was passed; otherwise a reply without
it fails validation instead of reading as "nothing removed". qbit Core v1.0.0
accepts `includeWatchOnly` and ignores it.

To credit deposits, read `receive` entries, and undo a credit from `removed` and
`getTransaction`. qbit Core leaves a conflicted transaction's `receive` entries
out of `transactions` and `listTransactions`, so a double-spent deposit just
stops being listed. It is in `removed` only when the stored block was in a part
of the chain that left. A deposit credited while unconfirmed, or while the
stored block was still below its block, is in neither list, so check each
credited `txid` with `getTransaction` until you consider it final: it reports
negative `confirmations`, with no `receive` entry in `details`.

To add up what the wallet sent, take `send` entries without `includeChange`
(which adds each change output as a `send` and a `receive` entry), count each
`txid` and `vout` once, and skip `abandoned` entries and those with negative
`confirmations`. A replaced payment appears as several transactions spending
the same inputs: the original and each replacement. `bumpfee` links them with
`replacedByTxid` and `replacesTxid`; a replacement sent with
`sendRawTransaction`, as after `psbtBumpFee`, sets neither, and only
`walletConflicts` links them, which stays set even if a replacement leaves the
mempool unmined. Treat each such group as one payment. Once one of them is
mined, the others have negative `confirmations`: count the mined one, even
when it is the original and carries `replacedByTxid`. Until then the payment is
pending: count it once, as pending, not from both entries, as a replacement can
pay another amount or recipient. Don't rely on `mempoolConflicts` alone: it is
empty again when none of them is in the mempool.

`listTransactions` lists the newest `count` entries after skipping the newest
`skip`, without change outputs. A `label` keeps incoming entries paying to that
label; `*` lists everything, and qbit Core refuses `''`, so the client does.
`count + skip` must be at most 2,147,483,647, as qbit Core adds them as 32-bit
integers.

`getBalances` reports `mine` in bits. `usedBits` is present only for a wallet
with `avoid_reuse` set, where `0n` is a real zero. qbit Core v1.0.0 has no
`watchonly` section: a wallet without private keys reports what it watches
under `mine`. `lastProcessedBlock` is the block the balances were computed at.

`QbitRpcClient` satisfies the `CoreRpc` interface of the qbit Core wallet
adapter in `qbit-payments` with no wrapper (`test/core-rpc.test.ts` checks a
copy of it). Scope the client to the wallet (`wallet`), enable `wallet-read`,
`wallet-write` and `broadcast`, and call `confirmChain()` before handing it
over. The adapter must read a node's error code from `rpcCode`, as the copy here
does: reading `code`, it would take every node error for an unknown outcome. It
must also take this version's shapes, which the copy has: call options as the
last argument, `lockUnspent(outputs, options)` and `unlockUnspent(outputs)`
resolving nothing, and a `PqcLimitState` open to a state a later qbit Core adds
(see [CHANGELOG.md](../../CHANGELOG.md)).

Arguments are checked before sending; invalid ones reject with `TypeError` or
`RangeError` and nothing is sent. A number argument of `-0` is sent as `0`.
Integer arguments take the range qbit Core v1.0.0 reads them in, so a value the
node would refuse is refused first and every value it takes gets through:
`getTxOut`'s `vout` is 0 to 4,294,967,295 (an unsigned 32-bit integer), an
input's `vout` in `walletCreateFundedPsbt` and an output's in `lockUnspent` and
`unlockUnspent` 0 to 2,147,483,647 (a signed one), `walletCreateFundedPsbt`'s
`version` 1 to 3 (the standard versions) and `options.maxTxWeight` 65 to
400,000 (the standard weight limits). Where the node's limit depends on its
state (a height above the tip, an output index past the outputs), the node
answers. Options are strict: each options or arguments object, at every level
(`args`, `inputs`, `outputs`, `options`, `proof`, and the call options), takes
only the keys documented for it. Any other key rejects with
a `TypeError` that names it and, for the node's spelling or a near miss, the key
to use (`subtract_fee_from_outputs` → `subtractFeeFromOutputs`, `fee_rate` →
`feeRateBitsPerKvB`, `minconf` → `minConf`), and the unit when it differs
(`fee_rate` is bits/vB, `feeRateBitsPerKvB` bits per 1,000 vbytes). Each object
is read from its own enumerable properties only, each once, so a getter on the
object itself runs once. A key it takes that the object holds any other way
(inherited, a class getter, not enumerable, on a polluted `Object.prototype`,
left out of the keys a `Proxy` lists, or answered only by its `get` trap)
rejects with a `TypeError` that names it and says to pass a plain object: copy
a class instance's values into one. An unknown key only on `Object.prototype` is
skipped, as its value is never read, and an object left out reads as empty
whatever `Object.prototype` holds. Arrays are read by their own elements: a hole
rejects with a `TypeError` naming its index. Where an outpoint is expected (`lockUnspent` outputs,
`walletCreateFundedPsbt` inputs), the other fields of a typed result that is
also an outpoint (a `listUnspent()`, `listSinceBlock()` or `listTransactions()`
entry, or a decoded transaction input) are allowed and ignored. Only `txid`,
`vout` and, for an input, `sequence` are read, so a decoded input passed to
`walletCreateFundedPsbt` keeps its own sequence number. TypeScript catches
unknown keys only in object literals, not in spread objects or options read from
configuration.

`call()` passes its parameters through unchecked, serialized once, from their
own data, when the request is built: an array hole rejects with a `TypeError`, a
`toJSON` on `Object.prototype` or `Array.prototype` never applies, and a
`bigint` is always an integer literal. A `requests.raw()` request holds its
`params` as they are sent, parsed back without loss (every number a
`JsonNumber`, every object without a prototype), so a `toJSON` or a getter in
them runs once. A request body nests at most 512 arrays and objects, as deep as
qbit Core v1.0.0 parses, its envelope included: the request object is one level,
so `call()`'s params, the params array included, nest at most 511, and a batch's
array is one more, so a `batch()` entry's nest at most 510. Deeper parameters are
a `TypeError` before anything is sent, where the node would answer HTTP 500
`Parse error`: `requests.raw()` refuses more than 511, and `batch()` more than
510, naming the entry.
There is one exception: it
refuses `walletcreatefundedpsbt` options, as they are serialized, that qbit
Core v1.0.0 accepts and then ignores, so far `subtract_fee_from_outputs` (the node reads
`subtractFeeFromOutputs`; with the other name the wallet pays the fee).
`psbtbumpfee` has none: qbit Core refuses every option key it does not read.

## Public API

`etc/rpc.api.md` is the package's API report: every export and its declaration,
generated by API Extractor from the built declarations. CI fails when the
CommonJS or ESM declarations differ from it, so every change to the public API
shows up in review as a change to that file. To update it after an intended
change, see the [repository README](../../README.md#the-api-report).

The package exports `QbitRpcClient` with its option and result types,
`requests`, the error classes, `JsonNumber`, and the amount helpers
`parseQbt`, `formatQbt`, `BITS_PER_QBT` and `MAX_MONEY_BITS`. The allowlist,
the lists of capabilities and chains, the default genesis hashes and signet
challenge, and the supported qbit Core versions are internal: the `Capability`
and `QbitChain` types name the values, the tables and text above list them, the
constructor refuses anything else, `nodeVersion.supported` applies the version
range, and `toJSON()` shows what a client uses.

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
- `parseQbt(text)` and `formatQbt(bits)` convert at your boundaries. `parseQbt`
  reads `-0` and `-0.00000000` as `0n`, without `allowNegative`: zero is not
  negative. It reads `allowNegative` as its options' own property: left out, the
  options read as empty, and an inherited one is a `TypeError`.
- `call()` returns every JSON number as a `JsonNumber`: use `toBits()`,
  `toBigInt()`, `toSafeInteger()` or `toNumber()`. Arithmetic on it throws.
  Pass amounts to `call()` as `formatQbt(bits)` strings, which qbit Core
  accepts, and large integers as `bigint`.

## Failure model

All these errors extend `QbitRpcError`. Recognize them with `X.is(error)`, which
also works across the CommonJS and ESM builds. A side-effecting method is
`sendrawtransaction`, any wallet-write method except `finalizepsbt`, or an
[`extraMethods`](#opening-another-method-extramethods) entry with
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
| `RpcCapabilityError` | `reason: 'not_batchable'` | A method other than a read in `batch()`, or a [long poll](#long-polls). | Not sent | A programming error. |
| `RpcChainGuardError` | `reason: 'unconfirmed'` | A wallet-write or broadcast call before `confirmChain()` succeeded. | Not sent | Call `confirmChain()`. |
| `RpcChainGuardError` | `reason: 'mismatch'` | A chain check (yours, or the automatic re-check) found another chain, genesis block or signet challenge; `differs` says which. | Not sent | Check the URL, or set `expectedGenesisHash` or `expectedSignetChallenge` for a node with other chain parameters or a custom signet, then call `confirmChain()`. |
| `RpcChainGuardError` | `reason: 'unsupported_version'` | A chain check found a qbit Core version outside 1.0.x releases; `nodeVersion` says which. | Not sent | Run a supported qbit Core, or a release of this package that supports the node's, then call `confirmChain()`; or accept the risk with `allowUnsupportedNodeVersion`. |
| `RpcChainGuardError` | `reason: 'stale'` | Every chain check the call ran was overtaken by a connection error, an HTTP 401 or another check. | Not sent | Try again later. |
| `RpcChainGuardError` | `reason: 'check_failed'` | The chain re-check before the call failed; `cause` is the failure. | Not sent | Safe to call again; `cause` tells whether soon is any use. |
| `RpcError` | | The node answered with an error, under HTTP 200, 400, 404 or 500: `rpcCode` and `message` are the node's. | The node's answer: not an unknown outcome | Handle by `rpcCode`, for example -26 rejected, -25 missing inputs, -27 already confirmed, -14 wrong passphrase, -28 node warming up. |
| `RpcTransportError` | `reason: 'network'` | The connection failed; `code` is the system's, such as `ECONNREFUSED`, or the error's of a [`connect` function](#proxies-connect). | Not sent when no connection was made (refused, DNS, a reset during the TLS handshake, `connect` failing); once one exists, an unknown outcome | Retry reads later. |
| `RpcTransportError` | `reason: 'tls'` | The TLS handshake failed or was refused: the node's certificate is not trusted (`code` such as `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `CERT_HAS_EXPIRED`), names another host (`ERR_TLS_CERT_ALTNAME_INVALID`) or carries a key no `tls.pinSha256` names (`EPINMISMATCH`, this package's); a handshake resumed a TLS session, which the client never offers (`ESESSIONRESUMED`, this package's); or the terminator refused the handshake with an alert, such as for a client certificate missing or not trusted (`ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`, `ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE`, `ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`, `EPROTO` before TLS 1.3). See [Remote nodes](#remote-nodes). | Not sent when the handshake failed before the request was written, as it does under TLS 1.2 and for the client's own checks; an alert after that, under TLS 1.3, is the `cause` of an `RpcUnknownOutcomeError` for a side-effecting call | Fix the `tls` settings or the terminator's. Not retried. A key no pin names can be an attack. |
| `RpcTransportError` | `reason: 'not_loopback'` | `localhost`, in an `http` URL or with cookie authentication, resolved to an address that is not loopback, or to some. See [localhost](#localhost). | Not sent | Fix the hosts file or DNS, or put `127.0.0.1` in the URL. Not retried. |
| `RpcTransportError` | `reason: 'prototype_polluted'` | `Object.prototype` has enumerable properties of its own, which something in this process put there, such as JSON parsed into a deep merge that followed `__proto__`; the message says how many. Every call fails until they are gone. See [a polluted `Object.prototype`](#a-polluted-objectprototype). | Not sent | Find and remove the pollution, and fix the code that let it in. Not retried. |
| `RpcTransportError` | `reason: 'http_status'` | An HTTP status without the node's JSON-RPC reply, `status`: 401 credentials; 403 `rpcallowip`, or an `-rpcwhitelist` that does not allow a method sent (the chain check needs `getblockhash` and `getnetworkinfo` too); 502, 503 or 504 from a gateway, even with a JSON-RPC error body ([which statuses are the node's](#which-statuses-are-the-nodes)). | Not run for 3xx and 4xx, and for `Work queue depth exceeded` with `directNode`; any other 5xx, and a JSON-RPC error body under a status the node does not use for one, is an unknown outcome | Retry reads later; fix configuration for 401 and 403. |
| `RpcTransportError` | `reason: 'credentials'` | The cookie file could not be read; `code` says why, such as `ENOENT`, or `EMALFORMED`, `ETOOBIG` or `EREAD` from this package. | Not sent | Check the cookie file. |
| `RpcTimeoutError` | | The operation's deadline (`timeoutMs`) expired. | Not sent when it expired waiting for a slot, reading the cookie or before a connection was made; during the re-check it is the `cause` of `check_failed`; after that, an unknown outcome | Retry reads if appropriate. |
| `RpcAbortedError` | | Your `AbortSignal` fired; `cause` is its reason. | As for `RpcTimeoutError` | Your own decision to stop. |
| `RpcResponseTooLargeError` | | The reply passed `maxResponseBytes`, `limitBytes`. | Unknown outcome | Treat the node or proxy as misbehaving; do not guess the value. |
| `RpcResponseError` | `reason: 'protocol'` | The reply was not valid JSON-RPC; `path` says where. | Unknown outcome | Treat the node or proxy as misbehaving; do not guess the value. |
| `RpcResponseError` | `reason: 'validation'` | A result failed validation; `path` says where. For a [custom `parse`](#batches) that threw, `path` is `result` and `cause` is what it threw. | Unknown outcome | Treat the node or proxy as misbehaving; do not guess the value. |
| `RpcUnknownOutcomeError` | | The call may have been executed, but no valid reply arrived; `cause` is the failure; for `sendrawtransaction` (typed or through `call()`), `txid` is the computed txid, and for `submitpackage` (likewise), `txids` holds one entry per transaction in package order, its txid or `null` where its hex does not parse here, with `txid` unset; for `submitpackage` it is also a node error that can follow the acceptance of part of the package (see [submitting a package](#submitting-a-package-cpfp)), with that `RpcError` as `cause`. Never retried. | Unknown outcome | Reconcile before acting again: look up `txid` or each of `txids` for a broadcast, re-read wallet state for a signing call, read `getWalletInfo().unlockedUntil` after `walletPassphrase` ([unlocking a wallet](#unlocking-an-encrypted-wallet)). |

A bad argument or option is a `TypeError` or `RangeError`, and nothing is sent.

**Before a side-effecting call is sent.** Each of these rejects without sending it,
with `method` the call's, so any error other than an `RpcUnknownOutcomeError` or a
node's `RpcError` means it did not run:

- a polluted `Object.prototype`, before anything else and at any point below:
  `RpcTransportError` `prototype_polluted`;
- the capability check: `RpcCapabilityError`;
- the guard's first decision, and its last after any wait: `RpcChainGuardError`
  `unconfirmed`, `mismatch` or `unsupported_version`;
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
  expiry the request is destroyed and its socket released.
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
  before a wallet-write or broadcast call gets the same extra attempt: the call
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

### Which statuses are the node's

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

### The work queue

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

## Batches

```ts
import { requests } from '@qbit-oss/rpc'

const [a, b] = await rpc.batch([requests.getBlockHash(100), requests.getBlockHeader(hash)])
if (a.ok) console.log(a.value)
else console.error(a.error) // RpcError or RpcResponseError for this entry only
```

Batches carry read and wallet-read methods only (up to 1,000), `extraMethods`
entries included, sent as one
JSON-RPC request and matched to replies by id. Each entry reports success or
its own error. A missing reply for an entry is that entry's `RpcResponseError`;
an unknown or repeated id, a malformed reply item, a non-array reply, a
transport failure, a timeout or an oversized reply rejects the whole batch. `requests.raw(method, params)`
adds an untyped entry.

An entry is any `RpcRequest`, so you can write your own `parse`. The entries
are read by their own elements, and each entry's `method`, `params`, `parse`
and `waitMs` (a long poll's, which a batch refuses) once, as its own
enumerable properties: a hole, or one of these held any other
way (a class's `parse` method, a key on a polluted `Object.prototype`), rejects
with a `TypeError` before anything is sent, and so does a `method` that is not a
non-empty primitive string (a `String` object, or an object with `toJSON`), so
the method the capability check sees is the one sent. The `parse` runs
synchronously and may throw anything: whatever it throws fails that entry with
`RpcResponseError` (`reason: 'validation'`, `path: 'result'`), with the thrown
value as `cause`, and the other entries are unaffected. The same holds on every
other path that takes an `RpcRequest`, where a side-effecting call's failure
arrives as the `cause` of an `RpcUnknownOutcomeError`, since the node has acted.

## Secrets

Credentials live in private class fields. `JSON.stringify(client)` and
`util.inspect(client)` show only the URL, chain, expected genesis hash (and,
on signet, challenge), capabilities, any `extraMethods` with their policies,
auth kind and chain status; with `tls`, whether it sets a CA and a client
certificate, its `servername` and its pins, which are public; with a `connect` function,
`connect: 'custom'`; and, once a check has read it, the node's version.
`tls.key` and `tls.passphrase`
go into Node's TLS context at construction and are not kept, and an error
about them names the option only. A `connect` function's own errors are not
kept either. Messages and
properties this package writes never include credentials, cookie contents,
request parameters or request bodies.
`RpcError.message` is the node's own text, which can quote an argument such as
an address or hash; qbit Core's `walletpassphrase` errors do not quote the
passphrase. A `check_failed` message quotes its `cause`'s, so it can carry the
node's answer to the chain check, whose requests hold no secrets. The package
does not log.
