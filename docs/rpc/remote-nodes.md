# Remote nodes

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
[failure model](errors.md)): nothing was sent, and it is not retried. An
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
503 after forwarding a request: leave [`directNode`](errors.md#the-work-queue) off.
Set it only for one that relays bytes and never answers HTTP, such as stunnel.
One that puts a JSON-RPC error on its own 502, 503 or 504 stays an unknown
outcome for a side-effecting call ([which statuses are the node's](errors.md#which-statuses-are-the-nodes));
one that does so under 500 reads as the node's answer, so have it answer 502 or
504 when it times out.

## Proxies: `connect`

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

## A polluted `Object.prototype`

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
  from their own properties only, as [Client options](configuration.md#client-options) and
  [Typed methods](methods.md#typed-methods) say;
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

## localhost

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
