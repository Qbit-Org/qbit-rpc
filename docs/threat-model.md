# Threat model

What `@qbit-oss/rpc` and `@qbit-oss/zmq` protect, against whom, and what they
leave to the application and to the operator of the node. Each mitigation
names the page or the source file it rests on. Report a vulnerability as
[SECURITY.md](../SECURITY.md) describes, which also says how far the packages
have been reviewed.

## The system

- **RPC to a node on the same host:** plain HTTP to a loopback address, with
  HTTP Basic credentials or qbitd's cookie file.
- **RPC to a node elsewhere:** HTTPS to a TLS terminator in front of qbitd,
  which serves plain HTTP, optionally through a proxy that a `connect`
  function tunnels through ([Remote nodes](rpc/remote-nodes.md)).
- **ZMQ:** qbitd publishes notifications over `tcp://` or `ipc://`, without
  authentication, and the subscriber connects to it
  ([Addresses, topics and gaps](zmq/messages.md)).
- **Keys:** qbitd's wallet holds the private keys and signs. Neither package
  holds a private key.

## Assets

| Asset | Where it lives | Who holds it |
| --- | --- | --- |
| The wallet's spend authority | qbitd's wallet, which signs what a `wallet-write` call asks it to while it is unlocked | The node; any client with `wallet-write`; anyone with the RPC credentials, through any method qbitd lets that RPC user call |
| RPC credentials | A Basic username and password, in the client's private fields, sent in every request's `Authorization` header | The application, the node, and a TLS terminator in between |
| The cookie | A file qbitd writes in its data directory each time it starts; the client reads it again for every attempt | Anyone who can read the file, until qbitd restarts |
| A signed transaction | From `walletProcessPsbt` until it confirms: the application's storage, then the mempool | Anyone holding it can broadcast it |
| The chain view | What the application believes about blocks, transactions, balances and confirmations: the node's replies, and the ZMQ notifications that prompt them | Whatever answers as the node, and whatever publishes to the subscriber |

Further secrets travel as arguments: wallet passphrases (`walletPassphrase`,
`createWallet`, `walletPassphraseChange`), descriptors with private keys
(`importDescriptors`), and the TLS client key, which goes into Node's TLS
context at construction and is not kept
([Secrets](rpc/configuration.md#secrets),
[wallet administration](rpc/wallet-admin.md)).

## Actors and trust boundaries

| Actor | Trusted with | Section |
| --- | --- | --- |
| The application | Everything: it chooses the URL, credentials, capabilities and expected chain. The packages bound its mistakes, not its intent. | [The application](#the-application), [Spend authority](#spend-authority) |
| The node | The wallet's keys, and the truth of the chain view. The packages check its replies for consistency, not for truth. | [A malicious or compromised node](#a-malicious-or-compromised-node) |
| A TLS terminator or gateway in front of the node | As much as the node: it sees the credentials and every request and reply in plaintext. | [A proxy or TLS terminator](#a-proxy-or-tls-terminator) |
| A proxy that `connect` tunnels through | Nothing but delivery: it sees TLS only. | [A proxy or TLS terminator](#a-proxy-or-tls-terminator) |
| The network | Nothing but delivery, outside loopback. | [A network attacker](#a-network-attacker) |
| Other users of either host | Nothing. The boundary is the operating system's. | [Local attackers](#local-attackers) |
| ZMQ publishers | Nothing: whatever answers at the address the subscriber connects to can publish. | [ZMQ spoofing](#zmq-spoofing) |
| npm and the dependency supply chain | The code that runs: these packages and `zeromq`. | [The supply chain](#the-supply-chain) |
| The runtime | Node.js and the rest of the process, except a polluted `Object.prototype`, which is refused. | [A polluted runtime](#a-polluted-runtime) |

## The application

The application holds the client and chooses its configuration, so whatever
controls that configuration controls the client. The packages bound its
mistakes:

- Options, arguments and call options are strict: an unknown key, one held
  other than as an own property, or a value out of range is a `TypeError` or
  `RangeError`, and nothing is sent
  ([Client options](rpc/configuration.md#client-options),
  [Arguments and options](rpc/methods.md#arguments-and-options)).
- What qbit Core would take and then read differently is refused before
  sending: options it accepts and ignores, such as `subtract_fee_from_outputs`
  ([`call()` parameters](rpc/methods.md#call-parameters)), and a fee-rate cap
  of `0n`, which it reads as no cap
  ([Fee-rate caps](rpc/payments.md#fee-rate-caps)).
- A side-effecting call is never retried, and one that may have run without a
  reply is an `RpcUnknownOutcomeError`, never a plain failure
  ([Errors](rpc/errors.md)).
- Capabilities and the chain guard limit what each client can do
  ([Spend authority](#spend-authority)).

What stays yours: keep the configuration (above all the URL, credentials,
capabilities, `extraMethods` and expected chain) out of reach of untrusted
input, and reconcile every `RpcUnknownOutcomeError` before acting again.

## A malicious or compromised node

A node that holds the wallet's keys can spend the wallet whatever any client
does. What follows is about the replies, and the chain view built from them.

**Every reply is validated.** The JSON-RPC 2.0 envelope is strict, and a batch's
replies are matched by id. A typed method's result is validated field by field:
types, integer ranges, hashes, hex, enums and amounts, none above
`MAX_MONEY_BITS`. A reply that fails is an `RpcResponseError`, or for a
side-effecting call the `cause` of an `RpcUnknownOutcomeError`
([Typed methods](rpc/methods.md#typed-methods), [Errors](rpc/errors.md),
[validate.ts](../packages/rpc/src/validate.ts),
[methods.ts](../packages/rpc/src/methods.ts)).

**Some values are checked against what the client computes or asked for:**

| Check | Where |
| --- | --- |
| The txid of a raw transaction, computed as the double SHA-256 of its serialization without witness | `getRawTransaction(txid)`'s hex hashes to `txid`; `sendRawTransaction`'s txid, and each `testMempoolAccept` result's, is the txid of the hex sent; a lost reply's `RpcUnknownOutcomeError` carries the computed `txid` (for `submitPackage`, `txids`) ([raw-tx.ts](../packages/rpc/src/raw-tx.ts)) |
| A block hash, computed from the 80-byte header | `getBlockHex(hash)`'s header hashes to `hash` |
| A block template's transactions | each transaction's `data` hashes to its `txid` and its wtxid |
| A descriptor's checksum | `getDescriptorInfo`'s `checksum` is the requested descriptor's |
| The reply repeats the request | the hash of `getBlockHeader` and `getBlock`; the txid of `getTransaction` and `getRawTransactionVerbose`; `getAddressInfo`'s address; `signDataPqcHash`'s address, hash and any key data asked for; `getTxSpendingPrevout`'s outputs; `rescanBlockchain`'s heights; the wallet name of `createWallet` and `loadWallet` |
| The reply agrees with itself | `versionHex` is `version` in hex; a previous block hash exactly above height 0; `getBlock`'s `tx` has `nTx` entries; `getChainTips` has one active tip |

**The chain guard** compares the chain name, the genesis block hash
(`getblockhash 0`), on signet the challenge, and the node's version with what
the client expects, before every `wallet-write`, `broadcast`, `mining`,
`wallet-admin` and `node-admin` call
([Chain guard](rpc/chain-guard.md), [Versions and compatibility](rpc/versions.md)).
These are the node's own answers: the guard catches a client pointed at the
wrong node, not a node that lies about which one it is.

**Sizes** are capped: a reply above `maxResponseBytes`, by its
`Content-Length` or as it arrives, is refused (see
[Denial of service](#denial-of-service)), and a node's error message is kept to
1,000 characters.

**What a node can still lie about** is anything only it knows, in a reply that
validates:

- which block is at a height (`getBlockHash`), and every header field but the
  hash. No proof of work, Merkle root or signature is checked, and `getBlock`'s
  txids are not checked against the Merkle root;
- whether an output exists and what it holds (`getTxOut`), the mempool, fee
  estimates, confirmation targets, confirmations, balances and wallet history;
- the outcome of any check it runs for you: `validateAddress`,
  `verifyDataPqcHash`, `testMempoolAccept`'s `allowed`, PQC signature budgets,
  and the fee-rate and burn caps of `sendRawTransaction` and `submitPackage`,
  which the node enforces ([Fee-rate caps](rpc/payments.md#fee-rate-caps));
- whether a transaction was relayed: a txid that matches the hex shows only that
  the node read that hex;
- what a PSBT pays: `walletCreateFundedPsbt` builds it and `walletProcessPsbt`
  signs it in the node's wallet. The package decodes it only for the PQC check
  before signing, which reads its inputs' addresses, so its outputs are not
  checked;
- its chain, genesis block and version.

**What stays yours.** Run the node yourself, on a host you control, and count
it, and its terminator, among what you trust. Before a decision that moves value
on a reply, such as crediting a deposit, confirm it from a second source you
trust independently, such as a second node.

## A proxy or TLS terminator

**A TLS terminator or gateway** (nginx, HAProxy, stunnel, a load balancer) ends
TLS and forwards plain HTTP to qbitd. It reads the credentials and every request
and reply, so it is trusted as the node is.

- The client verifies its certificate on every connection (see
  [A network attacker](#a-network-attacker)).
- qbitd puts a JSON-RPC error body only under HTTP 400, 404 and 500. Under any
  other status the client takes it for something in between answering for
  itself, as a gateway does with a 502, 503 or 504 when it times out after
  forwarding a `sendrawtransaction`: a read fails with `RpcTransportError`
  `http_status`, and a side-effecting call with an `RpcUnknownOutcomeError`.
  qbitd's own HTTP 503 `Work queue depth exceeded` is a definite failure only
  with `directNode`, which is off by default, since a proxy can answer 503 after
  forwarding the request
  ([Which statuses are the node's](rpc/errors.md#which-statuses-are-the-nodes),
  [The work queue](rpc/errors.md#the-work-queue)).
- Yours: keep the hop from the terminator to qbitd, which is plain HTTP, on
  loopback or a private network; set `directNode` only for one that relays
  bytes and never answers HTTP; and point the client at one node, as the chain
  check and the call it guards are separate requests that a load balancer can
  send to different nodes ([Chain guard](rpc/chain-guard.md)). The client cannot
  tell a gateway that puts a JSON-RPC error body under 200, 400, 404 or 500 from
  the node.

**A proxy that `connect` tunnels through** (HTTP CONNECT, SOCKS) carries the
TLS connection and sees only TLS, and the node's host and port.

- The client runs TLS to the terminator over the tunnel, with every check, and
  HTTP over that. `connect` needs an `https` URL and Basic credentials: over
  `http`, or with a cookie, the client could not see where the credentials go.
  A `connect` function's errors are not kept, as they may quote the proxy's
  credentials ([Proxies](rpc/remote-nodes.md#proxies-connect),
  [endpoint.ts](../packages/rpc/src/endpoint.ts)).
- Yours: the proxy's address, trust and authentication, and the hop to it. A
  CONNECT request's `Proxy-Authorization` travels in cleartext unless the
  connection to the proxy is itself TLS.

## A network attacker

**Cleartext only on loopback.** An `http` URL is a `TypeError` at construction
unless its host is a loopback address (127.0.0.0/8, `::1`,
`::ffff:127.0.0.1`) or `localhost`. Cookie authentication needs a loopback
host too. A URL may not carry credentials
([Client options](rpc/configuration.md#client-options),
[endpoint.ts](../packages/rpc/src/endpoint.ts)).

**`localhost` is resolved, not trusted.** Every connection to it resolves it
with the system resolver and is refused, `RpcTransportError` `not_loopback` and
nothing sent, unless every address is loopback. Node connects to the addresses
checked, with no second lookup ([localhost](rpc/remote-nodes.md#localhost),
[transport.ts](../packages/rpc/src/transport.ts)).

**TLS is always verified.** There is no `rejectUnauthorized`, and the client
ignores `NODE_TLS_REJECT_UNAUTHORIZED=0`. Every connection checks the
certificate against the CAs (`tls.ca`, which replaces the system's), the name
(`tls.servername`, or the URL's host) and, when set, the pins (`tls.pinSha256`,
the SHA-256 of the node's own certificate's public key, after the CA and name
checks). Every connection runs a full handshake: the client resumes no TLS
session, since Node skips the certificate checks on a resumed one, and fails a
handshake that resumes one. Nothing is written before the checks pass. A failure
is `RpcTransportError` `tls`, not retried; `EPINMISMATCH`, a key no pin names,
can be an attack ([Remote nodes](rpc/remote-nodes.md), [Errors](rpc/errors.md)).

**What the network can still do** is drop, delay or reset connections. Reads
fail, or retry under `readRetries`. Side-effecting calls use a fresh connection
each and are never retried, so a reset leaves an `RpcUnknownOutcomeError` to
reconcile, never a second send ([Errors](rpc/errors.md)). It also sees the
size and timing of the traffic, and the node's host name in DNS and SNI.

**What stays yours:**

- Revocation (CRL, OCSP) is not checked: a pin, or a short-lived certificate
  from your own CA, is what limits a stolen key. Rotate a pinned key by adding
  the next key's pin first.
- Keep qbitd's own RPC port, which serves plain HTTP, off the network
  (`-rpcbind`, `-rpcallowip`).
- The client takes Node's TLS defaults (default CAs, minimum and maximum
  version, ciphers) when it is constructed or at its first TLS connection:
  whatever the application sets there applies
  ([Remote nodes](rpc/remote-nodes.md)).

## Local attackers

**The cookie.** It goes to loopback hosts only, is read again for every attempt
so that a cookie qbitd rotated at a restart is picked up, and is refused when
larger than 1,024 bytes or malformed (`RpcTransportError` `credentials`, code
`ETOOBIG` or `EMALFORMED`). Its contents never appear in an error. A chain
confirmation counts only for calls made with the cookie it was made with
([Chain guard](rpc/chain-guard.md), [Errors](rpc/errors.md)). The client does
not check the file's owner or permissions: it reads the file the path names
([endpoint.ts](../packages/rpc/src/endpoint.ts)). qbit Core v1.0.0 creates it
readable by its owner only, unless `-rpccookieperms` says `group` or `all`
(`src/httprpc.cpp`, `src/rpc/request.cpp`). An application running as another
user needs the operator to widen that deliberately, to a group only those two
users share, and never to `all`.

**Loopback HTTP authenticates no one.** Any local process can connect to the RPC
port, and only the credentials stop it. Nor can the client tell qbitd from
another process listening on that port: a local user who binds it while qbitd
is down receives what the client sends, a Basic password that stays valid, a
cookie that stops working when qbitd next starts and writes a new one, or a
wallet passphrase, and can answer as the node. Keep untrusted users off the
node's host. A TLS terminator does not help here, pinned or not: its own hop
to qbitd's port is plain HTTP, which the same local user can bind.

**Memory.** Credentials are kept in private class fields, out of `toJSON()`
and `util.inspect`, and neither package logs
([Secrets](rpc/configuration.md#secrets)). A user who can read the process's
memory, or the node's data directory, has them: that boundary is the operating
system's.

**ZMQ.** A local process can bind the publisher's address while qbitd is down
and publish: see [ZMQ spoofing](#zmq-spoofing).

## ZMQ spoofing

qbitd's ZMQ publisher has no authentication, and the subscriber supports no
CURVE authentication, which qbitd does not offer ([Limits](limits.md)).
Whatever answers at the address the subscriber connects to, a process that
binds it while qbitd is down included, can publish to it, and anything on the
path can drop or forge messages.

**What the package does.** `parseZmqMessage` is strict: three frames, a topic
qbit Core publishes, the exact body length for the topic, a known `sequence`
label and a 4-byte counter. Anything else is a `malformed` event. Each topic's
counter is followed, and a skip or a restart is a `gap` event; `health()`
reports silence; heartbeats drop a publisher that stops answering
([Addresses, topics and gaps](zmq/messages.md),
[Health and connection handling](zmq/connection.md),
[parser.ts](../packages/zmq/src/parser.ts)). These catch garbage and loss, not
forgery: a forged message with a plausible counter is an ordinary `message`
event, and a forger can hide a gap as well as make one.

**What stays yours.** A notification is a signal to wake up, nothing more.
Confirm what it reports over RPC before acting on it, never act on a `rawtx` or
`rawblock` body alone (the package does not decode them), and reconcile over
RPC on a schedule, not only on a `gap`. Keep the publisher on loopback or a
private network.

## Denial of service

**From a node or proxy, through replies.**

- `maxResponseBytes`, 16 MiB by default and at most 256 MiB, caps each reply,
  per client: by its declared `Content-Length` before the body is read, and by
  the bytes received as it arrives. A larger reply is
  `RpcResponseTooLargeError`, not retried ([Client options](rpc/configuration.md#client-options),
  [Large replies](rpc/reading-the-chain.md#large-replies),
  [transport.ts](../packages/rpc/src/transport.ts)).
- Within the cap, the reply is held in memory and parsed keeping every number
  as a `JsonNumber` object and every object without a prototype
  ([json.ts](../packages/rpc/src/json.ts)): a reply of many small numbers takes
  many times its size in memory. Set `maxResponseBytes` to what the client
  reads and the process can hold, and give a client that reads whole blocks its
  own.
- Every operation has one deadline, `timeoutMs` (30 s by default for most
  methods), over every wait, attempt and backoff, so a node that hangs fails
  the call at the deadline ([Errors](rpc/errors.md)).

**Towards the node, from the application's own load.**

- A batch holds at most 1,000 requests, reads and wallet reads only, sent as one
  request whose reply is under the same cap ([Batches](rpc/methods.md#batches)).
- `maxConcurrentRequests`, 8 by default and at most 1,024, bounds one client's
  open requests; further calls wait in turn under their deadline. Nothing
  bounds requests across clients: qbitd queues up to `-rpcworkqueue` (64) for
  its `-rpcthreads` (16) workers and answers the rest with HTTP 503. A request
  abandoned at its deadline frees its slot at once, but qbitd may still be
  running it ([The work queue](rpc/errors.md#the-work-queue)).
- A long poll holds a request slot and a qbitd worker for its whole wait.
  `waitMs` must be 1 to 3,590,000 ms (qbit Core reads 0 as no limit), long
  polls are never batched, and qbitd does not notice a client that left, so an
  abandoned wait holds its worker until it ends. Give long polls their own
  client and keep them well below `-rpcthreads`
  ([Long polls](rpc/reading-the-chain.md#long-polls)).
- A request body nests at most 512 arrays and objects, as deep as qbit Core
  v1.0.0 parses ([`call()` parameters](rpc/methods.md#call-parameters)).
- Through `connect`, at most `maxConcurrentRequests` plus one connections open
  at once for reads, and as many for side-effecting calls. A `connect` that
  ignores its `signal` and never settles keeps its turn for good
  ([Proxies](rpc/remote-nodes.md#proxies-connect)).

**From a ZMQ publisher.**

- `maxMessageSize`, 2,065,536 bytes by default, caps each message part: libzmq
  drops a connection that sends more, and the subscriber replaces the socket.
  The parser refuses a body of the wrong length for its topic
  ([Health and connection handling](zmq/connection.md#connection-handling),
  [Addresses, topics and gaps](zmq/messages.md#topics-and-messages)).
- The receive queue keeps zeromq's default high-water mark of 1,000 messages,
  each part up to `maxMessageSize`. A slow consumer or a hostile publisher can
  fill it. While it is full, libzmq stops reading the connection, heartbeats
  included, so with heartbeats on (the default) the connection drops after
  `heartbeatTimeoutMs`, the queued messages are lost, and a `gap` follows
  ([Heartbeats and TCP keepalive](zmq/connection.md#heartbeats-and-tcp-keepalive)).
  A subscriber that needs neither `rawblock` nor `rawtx` can set
  `maxMessageSize` far lower, down to 1,024 bytes; keep the loop body short and
  hand slow work to a queue of your own.

## The supply chain

**What an application installs.**

- `@qbit-oss/rpc` has no runtime dependencies. `@qbit-oss/zmq` has one, an
  optional peer, `zeromq` `^6.5.0`, loaded only by the default socket at the
  first iteration, which the application installs and updates itself. Neither
  package has an install script ([Packaging and dependencies](packaging.md),
  [rpc's](../packages/rpc/package.json) and
  [zmq's](../packages/zmq/package.json) `package.json`).
- `zeromq` is a native addon. Its install script checks that its prebuilt
  addon loads, and if none does, builds libzmq from source. A package manager
  that blocks install scripts until approved needs it approved only on a
  platform without a prebuilt addon ([`zeromq`](packaging.md#zeromq)).
- Each tarball holds a fixed list of files under a size ceiling, which
  `pack:check` enforces ([Packaging and dependencies](packaging.md)).

**What this repository does.**

- `pnpm-workspace.yaml` blocks dependency lifecycle scripts unless
  `allowBuilds` approves them (only `esbuild` and `zeromq`), and refuses to
  resolve a version published less than a day ago (`minimumReleaseAge`).
- CI installs with `--frozen-lockfile`, runs with a read-only token
  (`contents: read`), and pins each GitHub Action to a commit SHA
  ([ci.yml](../.github/workflows/ci.yml)).
- Dependabot proposes updates weekly, with a cooldown of 2 days, and each
  `zeromq` update in a pull request of its own
  ([Updates](../CONTRIBUTING.md#updates),
  [dependabot.yml](../.github/dependabot.yml)).
- [`.github/CODEOWNERS`](../.github/CODEOWNERS) covers the release path:
  `.github/`, the scripts, manifests, lockfile, workspace, build configuration
  and RELEASING.md.
  [RELEASING.md](../RELEASING.md) records who can approve a release, the
  repository and npm settings that enforce it, publishing with npm trusted
  publishing and provenance, and under [Gaps](../RELEASING.md#gaps) which of
  those settings do not hold yet.
- The qbit Core release that CI's regtest smoke test runs is verified against
  its signing keys before use
  ([The regtest smoke test](../CONTRIBUTING.md#the-regtest-smoke-test)).

**What stays yours.** Lock the versions you install, approve `zeromq`'s
install script deliberately, update `zeromq` yourself, and check that a version
you install has provenance from this repository (step 10 of
[RELEASING.md's one-time setup](../RELEASING.md#one-time-setup)).

## A polluted runtime

**What `@qbit-oss/rpc` does.**

- While `Object.prototype` has an enumerable property of its own, every call is
  refused with `RpcTransportError` `prototype_polluted`, checked at the start of
  the call, before each connection and before each request is sent. It is not
  retried, no option turns it off, and the message gives how many such
  properties there are, never their names.
- Options, `tls`, `auth`, request options and arguments, call options and
  batch entries are read from their own properties: one held any other way is a
  `TypeError` ([Client options](rpc/configuration.md#client-options),
  [Arguments and options](rpc/methods.md#arguments-and-options),
  [own.ts](../packages/rpc/src/own.ts)).
- Replies are parsed into objects without a prototype and read by their own
  properties, and requests are serialized from their own data, never through a
  `toJSON` on `Object.prototype` or `Array.prototype`
  ([json.ts](../packages/rpc/src/json.ts)).
- Every option Node reads from the objects the client passes it is set on
  them as their own, and the certificate fields of the name and pin checks are
  read as the certificate's own ([A polluted `Object.prototype`](rpc/remote-nodes.md#a-polluted-objectprototype)).

**Its limits.** The check sees neither a property that is not enumerable nor
one that lands after it, while a connection opens. On the Node.js versions
tested, such a `blockList`, `handshakeTimeout` or `infoAccess` on
`Object.prototype` can crash the process from inside Node, before that
connection carries a request ([Limits](limits.md)). `@qbit-oss/zmq` makes no such check: it holds no
credentials, and reads its options as ordinary properties, inherited ones
included ([subscriber.ts](../packages/zmq/src/subscriber.ts)).

**What stays yours.** Find and remove the pollution, typically JSON parsed into
a deep merge that followed a `__proto__` key, and fix the code that let it in.
Other code in the process is trusted: it can patch Node's `http`, `tls` or `dns`
modules, or wrap the client.

## Spend authority

**Capabilities.** A client starts with none, and can then only read the chain.
Each method needs its capability, enabled at construction, or the call is
refused with `RpcCapabilityError` before any request is made
([Capabilities and the allowlist](rpc/capabilities.md),
[capabilities.ts](../packages/rpc/src/capabilities.ts)):

- `wallet-read` reads a wallet;
- `wallet-write` funds, signs and finalizes PSBTs, builds fee bumps, unlocks
  and locks the wallet, hands out addresses, locks coins and signs data hashes:
  with the wallet unlocked, a process with it can sign a transaction paying
  anyone;
- `broadcast` tests and sends transactions and packages;
- `mining` reads block templates and submits blocks;
- `wallet-admin` creates, loads and backs up wallets, imports descriptors with
  their private keys, rescans and changes the passphrase;
- `node-admin` allowlists nothing by itself.

`sendmany`, `sendtoaddress`, `send`, `sendall` and `bumpfee` sign and broadcast
in one step: they are not allowlisted and cannot be opened, so the signed
transaction can be stored before it leaves the node
([Payments](rpc/payments.md)). A side-effecting call is never retried and uses a
fresh connection, so the client never sends it twice; when it may have run
without a reply, it is an `RpcUnknownOutcomeError` to reconcile, with the
computed txid for a broadcast ([Errors](rpc/errors.md)).

**`extraMethods`** opens another method for one client, untyped and
unvalidated, under a capability and with `sideEffects` stated. For each of the
161 methods qbit Core v1.0.0's `help` lists, and its 18 hidden ones, the
package knows what the method does and refuses a policy below that: a method
that signs with the wallet's keys needs `wallet-write` with side effects, one
that administers the node needs `node-admin`. The regtest smoke test compares
this table with `help` on the node. A method in neither table, such as one a
later release adds, keeps whatever policy it is given, and a `read` entry is
open to the client whatever its `capabilities`
([Opening another method](rpc/capabilities.md#opening-another-method-extramethods),
[method-classes.ts](../packages/rpc/src/method-classes.ts)).

**`node-admin`** methods (`stop`, `setban`, `invalidateblock`, ...) open only
through `extraMethods`, under `node-admin`, with side effects; any other
capability for them is a `TypeError`, so a client that broadcasts cannot stop
the node ([Node administration](rpc/capabilities.md#node-administration-node-admin)).

**The chain guard.** `wallet-write`, `broadcast`, `mining`, `wallet-admin` and
`node-admin` calls are refused, unsent, until `confirmChain()` has matched the
chain name, genesis block hash and, on signet, challenge, on a supported
version unless `allowUnsupportedNodeVersion` is set (`node-admin` needs the
chain's identity only). The confirmation goes
stale after `chainCheckMaxAgeMs`, 10 s by default, and at once on a connection
error, an HTTP 401 or a changed cookie, and a stale one is checked again before
the call. It cannot tell two regtest nodes apart, the default signet from a
look-alike mined with the same open challenge, or two nodes of one chain behind
one URL, and it trusts the node's own answers
([Chain guard](rpc/chain-guard.md)). It stops a client from acting on the wrong
chain by mistake; it does not stop a node from lying.

**What stays yours.**

- Capabilities limit what one client sends, not what its credentials allow:
  anything holding the RPC credentials or the cookie can call any method qbitd
  lets that RPC user call, `sendtoaddress` included. Give each service its own
  RPC user (`-rpcauth`), restrict it with `-rpcwhitelist`, and give each client
  the fewest capabilities it needs.
- Treat any process with `wallet-write`, and anything that can reach the node's
  RPC port with its credentials, as able to spend the wallet. Keep the wallet
  encrypted and unlock it for as short a time as the work needs
  ([Unlocking an encrypted wallet](rpc/wallet.md#unlocking-an-encrypted-wallet)).
- Decide what to sign: check a funded PSBT's outputs before
  `walletProcessPsbt`, store the signed transaction before broadcasting it, and
  reconcile an unknown outcome by its txid rather than paying again
  ([Paying out from a wallet](rpc/payments.md#paying-out-from-a-wallet)).
- Open only the `extraMethods` a service needs, and declare a method neither
  table holds with side effects when unsure.
- Never log a `requests` entry that carries a secret, or a raw `call()`
  result or error for a method that takes keys: the package redacts key
  material from the node's messages only for the typed methods and a few
  others ([Secrets](rpc/configuration.md#secrets)).

## Non-goals

- **Verifying the chain.** No proof of work, Merkle proof or header chain is
  checked. The node is the source of truth for the chain view.
- **Protecting against a compromised node or terminator.** One holds the keys,
  the other sees the credentials.
- **Access control on the node.** Capabilities are least privilege for the
  application's own code, not a boundary against a process that holds the
  credentials.
- **Holding or protecting private keys.** qbitd's wallet holds them, and
  `backupWallet` writes them to a file on the node's host.
- **Hostile code in the same process,** a debugger, or root on either host.
- **Privacy from the node or terminator,** which see every address, txid and
  wallet call.
- **Certificate revocation** (CRL, OCSP).
- **Authenticated ZMQ.** qbitd does not offer it.
- **Limits across clients,** or protecting the node from its other clients.
- **The node's configuration and host:** its RPC binding, allowed addresses,
  cookie permissions, users and whitelists, and the terminator in front of it.
- **Browsers.** Both packages run on Node.js only.
