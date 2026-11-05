# @qbit-oss/zmq

A Node.js subscriber and strict parser for qbit Core v1.0.0's ZMQ
notifications. The subscriber's default socket uses the native
[`zeromq`](https://www.npmjs.com/package/zeromq) addon, loaded at a
subscriber's first iteration, not when it is constructed, so the parser works
without it.

Node.js `^22.13.0 || ^24.0.0 || >=26.0.0`, on a platform `zeromq` 6.5.0 ships a
prebuilt addon for: Linux x64 and arm64 (glibc 2.25 or later, or musl), macOS
arm64 (14 or later) and x64 (13.7 or later), and Windows x64, arm64 and ia32.
CI runs the tests on Linux x64 with Node.js 22.13.0 and the newest 22.x, 24.x
and 26.x, and loads the addon on Linux arm64 and macOS arm64 with 26.x in
manual runs. The other platforms, and Node.js 27 and later, are untested.
See [Node.js and platforms](../../README.md#nodejs-and-platforms).

```ts
import { QbitZmqSubscriber, ZmqSetupError } from '@qbit-oss/zmq'

// qbitd -testnet4 -zmqpubhashblock=tcp://127.0.0.1:28332 -zmqpubsequence=tcp://127.0.0.1:28332
const zmq = new QbitZmqSubscriber({
  url: 'tcp://127.0.0.1:28332',
  topics: ['hashblock', 'sequence'],
  staleAfterMs: 10 * 60_000, // the default
})

try {
  for await (const event of zmq) {
    switch (event.kind) {
      case 'message':
        if (event.message.topic === 'hashblock') await onBlock(event.message.hash)
        break
      case 'gap':
        // event.missed is absent when how many were lost is unknown
        await reconcileOverRpc()
        break
      case 'malformed':
      case 'reconnect':
        log(event)
        break
    }
  }
} catch (error) {
  // A configuration or installation problem that retrying cannot fix.
  if (ZmqSetupError.is(error)) log(error.code, error.message, error.cause)
  throw error
}
```

## Installing `zeromq`

`zeromq` is an optional peer dependency, `^6.5.0`: install it beside the
package when you subscribe with the default socket.

```sh
npm install /path/to/qbit-oss-zmq-0.0.0.tgz zeromq@^6.5.0   # packed as the repository README shows
```

npm and pnpm do not install an optional peer, and nothing in the package needs
it at import: `parseZmqMessage`, the types and a custom `socketFactory` work
without it. Without it, a subscriber's first iteration rejects with
`ZmqSetupError` `code: 'module_load'`. It is a peer so that the application
owns the one copy of the native addon and updates it, and so that an install
on a platform without a prebuilt addon, where `zeromq`'s install script builds
libzmq from source, fails only for applications that install `zeromq`. CI
tests 6.5.0, the floor of the range; newer 6.x releases are in range but
untested. A bundler must leave `zeromq` external. See [Packaging and
dependencies](../../README.md#packaging-and-dependencies).

## Addresses

The constructor checks `url` and throws a `TypeError` naming the problem
unless it is one of:

- `tcp://<host>:<port>`, where the host is an IPv4 address, an IPv6 address in
  brackets (`tcp://[::1]:28332`, optionally with a zone such as
  `[fe80::1%eth0]`) or a host name, and the port a decimal number from 1 to
  65535. libzmq's source form, `tcp://<source>:<port>;<host>:<port>`, also
  works: it connects from the given local IP address or interface, whose port
  may be `0` or `*` for any.
- `ipc://<path>`: a Unix socket path, or `@<name>` in Linux's abstract
  namespace.

So `tcp://127.0.0.1` (no port), `tcp://127.0.0.1:notaport`, port 0 or above
65535, `tcp://*:28332` (`*` binds, it does not connect), an empty host, an
IPv6 address without brackets, a dotted quad with a part above 255, an empty
`ipc://` path, a control character and any other scheme are refused. libzmq's
own `connect()` takes some of these and then retries forever without
connecting, or reads `:93868` and `:28332abc` as port 28332. A host name that
does not resolve is not refused: it is retried like a node that is down, as
DNS may come up later, though only after the handshake deadline (see
[Connection handling](#connection-handling)), since libzmq reports nothing
for it.

The socket enables IPv6 only for an IPv6 address: libzmq cannot reach one
without it, and with it resolves `localhost` to `::1` first, missing a
publisher on 127.0.0.1. So a host name resolves to IPv4 addresses only, unless
the source address is IPv6: for a publisher reachable only over IPv6, use its
bracketed address. A custom
`socketFactory` receives the setting as `settings.ipv6`, and
`createZeromqSocket(settings)` applies it.

## Topics and messages

Every message has three frames: topic, body, and a 4-byte little-endian
counter that qbitd keeps per topic. `parseZmqMessage(frames)` takes them as
an array of `Uint8Array`s (`Buffer`s are), and returns:

| Topic | Body | Parsed |
| --- | --- | --- |
| `hashblock` | 32-byte block hash | `{ topic, sequence, hash }` |
| `hashtx` | 32-byte txid | `{ topic, sequence, txid }` |
| `rawblock` | serialized block (81 to 2,000,000 bytes) | `{ topic, sequence, bytes }`, not decoded |
| `rawtx` | serialized transaction (10 to 2,000,000 bytes) | `{ topic, sequence, bytes }`, not decoded |
| `sequence` | hash + `C`/`D` (33 bytes), or hash + `A`/`R` + 8-byte mempool sequence (41 bytes) | `{ topic, sequence, event, hash, mempoolSequence? }` with `event` `block_connected`, `block_disconnected`, `mempool_added` or `mempool_removed` |

Hashes are hex in the order RPC shows them; qbitd already sends them that way.
Anything else (wrong frame count, a frame that is not a `Uint8Array`, unknown
topic, wrong body length for the topic, unknown label, counter not 4 bytes)
throws `ZmqFrameError` with a `code` (see [Errors](#errors)). The subscriber
turns those into `malformed` events and keeps going.

## Gaps

The subscriber follows each topic's counter. The first message sets the
baseline; any later value other than previous + 1 (mod 2^32) is a `gap` event
with `expected`, `received` and, for a forward jump, `missed`. A repeated or
backwards counter, usually a qbitd restart, is a gap without `missed`: how many
messages were lost is unknown. Counters are kept when the subscriber replaces
its socket, and the first message on each topic after a replacement is always
a gap without `missed`, even if its counter follows on: messages published
meanwhile are lost, and a restarted qbitd's counter can happen to line up. ZMQ
is a wake-up, not a ledger: on a gap, read the chain over RPC.

## Health

`health()` returns `{ status, lastMessageAt?, messages, gaps, malformed, reconnects }`:

- `unknown` until a valid message arrives on the current socket, and again
  as soon as the connection drops. Silence is not health: qbitd may be down,
  the address wrong, or the topic not enabled.
- `receiving` after one, while it is no older than `staleAfterMs` (default
  10 minutes, about ten blocks).
- `stale` when the last message is older than `staleAfterMs`, for example when
  qbitd has nothing to publish on the subscribed topics, or hangs without
  dropping the connection while heartbeats are off. With them on, a hung qbitd
  is dropped within 30 s and health is `unknown` (see
  [Heartbeats and TCP keepalive](#heartbeats-and-tcp-keepalive)).
- `closed` after `close()`, or once the iteration has ended with a
  `ZmqSetupError`. The counters are kept.

The age of the last message is measured on the monotonic clock
(`performance.now()`), so a step in the wall clock (an NTP correction, a manual
change) does not make a fresh subscriber `stale` or an old one `receiving`.
`lastMessageAt`, like an event's `receivedAt`, is this process's wall-clock
receipt time (`Date.now()`), for display, not a node timestamp: after a step,
`Date.now() - lastMessageAt` is not the message's age. `health(now)` reports
the status at the wall-clock time `now` (default the present), shifting the
measured age by `now - Date.now()`. On Linux the monotonic clock stops while
the host is suspended, so time asleep does not count towards `staleAfterMs`.
Tests that simulate time must fake `performance` as well as `Date`, for
example `vi.useFakeTimers({ toFake: ['Date', 'performance'] })`.

## Connection handling

The subscriber replaces its socket when the connection to the publisher
drops (`reason: 'disconnected'`: qbitd stopped or restarted) or a receive fails
(`reason: 'failed'`), yielding a `reconnect` event, waiting `reconnectDelayMs`
(default 1 s) and starting again. A failure to make or connect the socket is
retried the same way (`reason: 'failed'`, with the error's `code`), unless it
is a `ZmqSetupError`. libzmq does not reconnect the socket by itself
(`ZMQ_RECONNECT_IVL` -1, see [Heartbeats and TCP
keepalive](#heartbeats-and-tcp-keepalive)), so a connection attempt that fails
is retried the same way too, as `reason: 'failed'` without a `code`: a node that
is down, from the start or after a drop, refuses at once, and a host name that
does not resolve, or a publisher that accepts the TCP connection but never
answers the ZMTP greeting, is given up after the handshake deadline,
`heartbeatIntervalMs + heartbeatTimeoutMs` (30 s by default) from `connect()`,
or 30 s without heartbeats. So while qbitd is down there is a `reconnect` every
`reconnectDelayMs` or so, `attempt` counting up, and health stays `unknown`
until messages arrive. `close()` closes the socket and ends the iteration at
once, also during that wait; breaking out of `for await` closes the socket too.
One consumer at a time.

A failure that retrying cannot fix ends the iteration instead: the iteration
throws a `ZmqSetupError` with a `code` (see [Errors](#errors)) and the original
error as `cause`, no `reconnect` is yielded for it, the socket is closed, and the
subscriber is closed.

A custom `socketFactory` can throw a `ZmqSetupError` itself to stop instead of
being retried. If `close()` comes first, the iteration ends without an error.

`maxMessageSize` (default 2,065,536 bytes: qbit's 2,000,000-byte block limit
plus 64 KiB of headroom) caps each inbound message part.
libzmq drops a connection that sends more, and does not reconnect it itself;
the subscriber replaces the socket, so the oversized message is never
buffered. A custom `socketFactory` receives `{ maxMessageSize, ipv6,
heartbeatIntervalMs, heartbeatTimeoutMs, heartbeatTtlMs, handshakeIntervalMs
}`, and the `tcpKeepalive` options that are set, and must apply them all and
set `reconnectInterval` to -1; `createZeromqSocket(settings)` does. If its
socket has `events`, they include `disconnect`, `close` and `handshake`, as
`zeromq`'s do. For a socket with `events` and no `handshake`, the first message
counts as one: it is replaced at the handshake deadline only if no message has
come by then. The receive queue keeps zeromq's default high-water mark of
1,000 messages.

### Heartbeats and TCP keepalive

A qbitd that stops answering without closing the connection (hung, stopped
with `SIGSTOP`, its VM paused, its host or the network path gone) leaves the
TCP connection open: without heartbeats, nothing arrives and only
`staleAfterMs` (10 minutes) flags it. So the subscriber sends libzmq's ZMTP
heartbeats:

| Option | Default | Meaning |
| --- | --- | --- |
| `heartbeatIntervalMs` | 10,000 | Send a PING every this many ms (`ZMQ_HEARTBEAT_IVL`). 0 sends none. Otherwise 100 to 3,600,000. |
| `heartbeatTimeoutMs` | 20,000 | Drop the connection when nothing, a PONG or a message, arrives within this many ms of a PING (`ZMQ_HEARTBEAT_TIMEOUT`). 100 to 3,600,000. |
| `heartbeatTtlMs` | 30,000, or twice `heartbeatIntervalMs` rounded up to a multiple of 100 when longer; 0 without heartbeats | Ask qbitd to drop the connection when it hears nothing from the subscriber for this many ms (`ZMQ_HEARTBEAT_TTL`). 0 for no limit, or up to 6,553,500. libzmq rounds it down to a multiple of 100, and the result must be at least twice `heartbeatIntervalMs`: with an interval of 155, 310 is sent as 300 and refused, and 400 is the least accepted. |

Without heartbeats (`heartbeatIntervalMs: 0`) the timeout and the TTL are
unused: each may then be 0, or a value in its range.

qbitd's libzmq answers each PING. A publisher that stops answering is dropped
within `heartbeatIntervalMs + heartbeatTimeoutMs`, 30 s by default (25 and
29 s against a regtest qbitd stopped with `SIGSTOP`), and not much before
`heartbeatTimeoutMs`: the subscriber yields a `reconnect` with `reason:
'disconnected'`, health is `unknown`, and the socket is replaced. Heartbeats
run only once the ZMTP handshake is done, so the subscriber also sets libzmq's
handshake interval (`ZMQ_HANDSHAKE_IVL`, 30 s by default) to the same bound and
gives up a socket whose handshake has not completed that long after
`connect()`: a replacement that reaches a qbitd that is still hung, whose kernel
accepts the connection while qbitd never greets, is dropped as `reason:
'failed'` within that bound too, not after libzmq's 30 s. Once qbitd answers
again, messages resume, with a `gap` on each topic.

What they cost: a PING of a few bytes every 10 s, and qbitd's PONG. qbitd
answers from its ZMQ I/O thread, so a node busy validating a block still
answers.

A `reconnect` with `reason: 'disconnected'` does not always mean the publisher
stopped answering: it can mean the consumer fell behind. When the loop over the
subscriber, or anything else blocking the event loop, leaves the receive queue
full (1,000 messages) for longer than `heartbeatTimeoutMs`, libzmq stops
reading the connection, PONGs included, and drops a healthy publisher: the
queued messages are lost, and a `gap` follows on each topic. Without
heartbeats, qbitd would drop what does not fit in its own queue instead, which
is a `gap` all the same. So when `reconnect`s come while qbitd is known to be
up, or right after a burst (a reorg, a full mempool on `rawtx`), treat them as
back-pressure: keep the loop body short, and hand slow work (RPC calls,
database writes) to a queue of your own rather than awaiting it per message;
reconcile over RPC on the `gap` as for any other; and raise
`heartbeatTimeoutMs` for a consumer that is expected to pause longer. Set
`heartbeatIntervalMs: 0` for a publisher that does not answer heartbeats, which
would otherwise be dropped every 30 s.

`heartbeatTtlMs` is for qbitd's side: a subscriber whose process stops (paused
or hung, so its ZMQ I/O thread sends no PING) for longer than the TTL, 30 s by
default, is dropped by qbitd, which frees its queue. When the process runs
again it reconnects, and the sequence tracker reports a `gap` on each topic. qbitd restarts the limit at each PING, so a TTL shorter than
the interval drops a healthy subscriber (seen on regtest); the constructor
refuses one under twice the interval.

libzmq 4.3.5, the one `zeromq` 6.5.0 bundles, aborts the process (`Assertion
failed: _input_stopped`, libzmq #3596 and #4841) when a socket whose receive
queue filled up is read after libzmq has reconnected it by itself, as after a
missed heartbeat while the event loop was blocked. A receive already pending
then reads it before any handler can close the socket. So a
`createZeromqSocket` socket never reconnects by itself (`ZMQ_RECONNECT_IVL`
-1), and the subscriber replaces it on `disconnect` and `close` instead: no new
connection is ever attached to a full queue. Code that reads a
`createZeromqSocket` socket itself must likewise replace it on `disconnect` or
`close`, and when no `handshake` comes.

TCP keepalive is left to the operating system (off on Linux) unless set
(`ZMQ_TCP_KEEPALIVE` and the three below):

| Option | Default | Meaning |
| --- | --- | --- |
| `tcpKeepalive` | the OS's | `true` turns it on, `false` off. |
| `tcpKeepaliveIdleSeconds` | the OS's (7,200 on Linux) | Idle time before the first probe, 1 to 32,767. |
| `tcpKeepaliveIntervalSeconds` | the OS's (75 on Linux) | Time between probes, 1 to 32,767. |
| `tcpKeepaliveCount` | the OS's (9 on Linux) | Unanswered probes before the connection drops, 1 to 127. |

The last three need `tcpKeepalive: true`, and all four a `tcp://` url. Keepalive detects a host or network
path that is gone, not a qbitd that hangs (its kernel answers the probes), and
probes only an idle connection, which heartbeats keep busy. It is for a
publisher that does not answer heartbeats: with `{ heartbeatIntervalMs: 0,
tcpKeepalive: true, tcpKeepaliveIdleSeconds: 60, tcpKeepaliveIntervalSeconds:
10, tcpKeepaliveCount: 3 }`, a gone host is dropped about 90 s after the last
traffic. Probes are empty TCP segments. It does not apply to `ipc://`.

qbitd's ZMQ publisher has no authentication: keep it on loopback or a private
network.

## Public API

`etc/zmq.api.md` is the package's API report: every export and its declaration,
generated by API Extractor from the built declarations. CI fails when the
CommonJS or ESM declarations differ from it, so every change to the public API
shows up in review as a change to that file. To update it after an intended
change, see the [repository README](../../README.md#the-api-report).

The package exports `QbitZmqSubscriber` with its option, event and health
types, `parseZmqMessage` for a socket you read yourself, the error classes, and
`createZeromqSocket`, the default `socketFactory`, for a custom factory that
wraps it (to observe the socket, say) instead of building its own. The topic
list, the sequence tracker behind `gap` events and the defaults of
`maxMessageSize`, `staleAfterMs` and the heartbeats are internal: the `ZmqTopic` type names the topics, the
subscriber reports gaps as events, and the defaults are documented above.

## Errors

Recognize an error with `ZmqFrameError.is(error)` or `ZmqSetupError.is(error)`,
which also recognise one from the package's other build (CommonJS or ESM), where
`instanceof` does not. Every `code` here is a string, on the errors and the event
alike, and a `malformed` event's `error` is a `ZmqFrameError`.

| Error | Value | Meaning | What to do |
| --- | --- | --- | --- |
| `ZmqFrameError` | `code: 'frame_count'` | The message does not have three frames. | From the subscriber, a `malformed` event: it keeps going. Treat many as a publisher that is not qbitd. |
| `ZmqFrameError` | `code: 'frame_type'` | A frame is not a `Uint8Array`, such as `null`, a string or a hole of a sparse array, when `parseZmqMessage` is called directly. | Pass each frame as a `Uint8Array` or `Buffer`. |
| `ZmqFrameError` | `code: 'topic'` | The first frame is not a topic qbit Core publishes. | As for `frame_count`. |
| `ZmqFrameError` | `code: 'body_length'` | The body has the wrong length for its topic. | As for `frame_count`. |
| `ZmqFrameError` | `code: 'label'` | A `sequence` body has an unknown label. | As for `frame_count`. |
| `ZmqFrameError` | `code: 'sequence_length'` | The counter frame is not 4 bytes. | As for `frame_count`. |
| `ZmqSetupError` | `code: 'module_load'` | `zeromq` or its native addon cannot be loaded, at the first iteration; or a custom `socketFactory` throws `MODULE_NOT_FOUND`, `ERR_MODULE_NOT_FOUND` or `ERR_DLOPEN_FAILED`. | Add `zeromq`, an optional peer dependency, to the application in the range `package.json` gives (`npm install zeromq@^6.5.0`), with the prebuilt addon for this platform, or build it. |
| `ZmqSetupError` | `code: 'invalid_address'` | The socket's `connect()` throws `EINVAL`, or `ENAMETOOLONG` for an `ipc://` path too long for a Unix socket (over 107 bytes on Linux). | Fix the url. |
| `ZmqSetupError` | `code: 'unsupported_protocol'` | `connect()` throws `EPROTONOSUPPORT`: this libzmq lacks the transport. | Use one it supports, such as `tcp://`. |
| `reconnect` event | `reason: 'disconnected'` | A connection to the publisher dropped after its handshake: qbitd stopped or restarted, sent a message over `maxMessageSize`, or missed a heartbeat, which a consumer that falls behind causes too. No `code`. | Nothing: the socket is replaced. The next message on each topic is a `gap`. If they come while qbitd is up, speed up the consumer (see [Heartbeats and TCP keepalive](#heartbeats-and-tcp-keepalive)). |
| `reconnect` event | `reason: 'failed'` | Without a `code`, no connection was made: qbitd is down (refused), the host name did not resolve, or no ZMTP handshake came within the handshake deadline. With one, making, connecting or receiving on the socket failed. | Nothing while qbitd is down or restarting: the socket is replaced every `reconnectDelayMs`. If it lasts without a `code`, check the url and that qbitd runs with `-zmqpub…`; for a `code`, see the codes below. |
| `reconnect` event | `code: 'EMFILE'` | Out of file descriptors, or of libzmq sockets: making the socket failed. | Raise the limit, or close what holds them. |
| `reconnect` event | `code: 'EMTHREAD'` | libzmq has no I/O thread for `connect()`. | Give `zeromq`'s context at least one (`ioThreads`, 1 by default). |
| `reconnect` event | `code: 'EFAULT'` | `zeromq`'s context is closed: making the socket failed. | Do not close the context while subscribing. |
| `reconnect` event | `code: 'ETERM'` | `zeromq`'s context is being terminated, as at process exit. | Stop subscribing. |
| `reconnect` event | `code: 'EINVAL'` | Making or subscribing the socket refused a value. From `connect()` it is `invalid_address` above instead. | Check a custom `socketFactory`. |
| `reconnect` event | `code: 'EINTR'` | A signal interrupted a subscribe. | Nothing unless it repeats. |
| `reconnect` event | `code: 'EAGAIN'` | A receive could not finish, as when something else closed the socket during it. | Check a custom `socketFactory` that shares its socket. |
| `reconnect` event | `code: 'EBADF'` | The socket was closed before `connect()` or a receive. | As for `EAGAIN`. |
| `reconnect` event | `code: 'ENOTSOCK'` | The socket was closed before a subscribe. | As for `EAGAIN`. |
| `reconnect` event | `code: 'EBUSY'` | Another receive was in progress on the socket, or a bind or unbind. | As for `EAGAIN`. |

A `reconnect` event's `code` is typed `ZmqReconnectCode`: these values and any other
string, since it is whatever code the failed call's error had, passed on as it is. A
custom `socketFactory` can raise others, and libzmq may too. The `EMFILE`, `EAGAIN`,
`EBADF`, `ENOTSOCK` and `EBUSY` rows were observed on `zeromq` 6.5.0; the others come
from libzmq's documentation for these calls.
