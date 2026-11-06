# Addresses, topics and gaps

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
[Connection handling](connection.md#connection-handling)), since libzmq reports nothing
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
throws `ZmqFrameError` with a `code` (see [Errors](errors.md)). The subscriber
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
