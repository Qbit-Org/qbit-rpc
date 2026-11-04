# @qbit-oss/zmq

> **Unaudited MVP**, not published to npm. See the [repository README](../../README.md).

A Node.js subscriber and strict parser for qbit Core v1.0.0's ZMQ
notifications. It depends on the native
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
DNS may come up later.

The socket enables IPv6 only for an IPv6 address: libzmq cannot reach one
without it, and with it resolves `localhost` to `::1` first, missing a
publisher on 127.0.0.1. So a host name resolves to IPv4 addresses only, unless
the source address is IPv6: for a publisher reachable only over IPv6, use its
bracketed address. A custom
`socketFactory` receives the setting as `settings.ipv6`, and
`createZeromqSocket(settings)` applies it.

## Topics and messages

Every message has three frames: topic, body, and a 4-byte little-endian
counter that qbitd keeps per topic. `parseZmqMessage(frames)` returns:

| Topic | Body | Parsed |
| --- | --- | --- |
| `hashblock` | 32-byte block hash | `{ topic, sequence, hash }` |
| `hashtx` | 32-byte txid | `{ topic, sequence, txid }` |
| `rawblock` | serialized block (81 to 2,000,000 bytes) | `{ topic, sequence, bytes }`, not decoded |
| `rawtx` | serialized transaction (10 to 2,000,000 bytes) | `{ topic, sequence, bytes }`, not decoded |
| `sequence` | hash + `C`/`D` (33 bytes), or hash + `A`/`R` + 8-byte mempool sequence (41 bytes) | `{ topic, sequence, event, hash, mempoolSequence? }` with `event` `block_connected`, `block_disconnected`, `mempool_added` or `mempool_removed` |

Hashes are hex in the order RPC shows them; qbitd already sends them that way.
Anything else (wrong frame count, unknown topic, wrong body length for the
topic, unknown label, counter not 4 bytes) throws `ZmqFrameError` with a
`code`. The subscriber turns those into `malformed` events and keeps going.

## Gaps

`SequenceTracker` follows each topic's counter. The first message sets the
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
  qbitd hangs without dropping the connection.
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
is one of those below. A node that is down from the start is not a failure:
libzmq keeps retrying the TCP connection itself, no `reconnect` is yielded,
health stays `unknown`, and messages arrive once qbitd listens. `close()`
closes the socket and ends the iteration at once, also during that wait;
breaking out of `for await` closes the socket too. One consumer at a time.

A failure that retrying cannot fix ends the iteration instead: the iteration
throws a `ZmqSetupError` with a `code` and the original error as `cause`, no
`reconnect` is yielded for it, the socket is closed, and the subscriber is
closed:

| `code` | When |
| --- | --- |
| `module_load` | `zeromq` or its native addon cannot be loaded, at the first iteration; or a custom `socketFactory` throws `MODULE_NOT_FOUND`, `ERR_MODULE_NOT_FOUND` or `ERR_DLOPEN_FAILED` |
| `invalid_address` | the socket's `connect()` throws `EINVAL`, or `ENAMETOOLONG` for an `ipc://` path too long for a Unix socket (over 107 bytes on Linux) |
| `unsupported_protocol` | `connect()` throws `EPROTONOSUPPORT`: this libzmq lacks the transport |

A custom `socketFactory` can throw a `ZmqSetupError` itself to stop instead of
being retried. If `close()` comes first, the iteration ends without an error.
Test for it with `ZmqSetupError.is(error)`, which also recognises one from the
package's other build (CommonJS or ESM), where `instanceof` does not.

`maxMessageSize` (default `DEFAULT_MAX_MESSAGE_SIZE`, 2,065,536 bytes: qbit's
2,000,000-byte block limit plus headroom) caps each inbound message part.
libzmq drops a connection that sends more, and does not reconnect it itself;
the subscriber replaces the socket, so the oversized message is never
buffered. A custom `socketFactory` receives `{ maxMessageSize, ipv6 }` and must
apply both. The receive queue keeps zeromq's default high-water mark of 1,000
messages.

qbitd's ZMQ publisher has no authentication: keep it on loopback or a private
network.
