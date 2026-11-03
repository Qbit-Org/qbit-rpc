# @qbit-oss/zmq

> **Unaudited MVP**, not published to npm. See the [repository README](../../README.md).

A Node.js subscriber and strict parser for qbit Core v1.0.0's ZMQ
notifications. It depends on the native
[`zeromq`](https://www.npmjs.com/package/zeromq) addon, loaded only when a
subscriber starts, so the parser works without it.

```ts
import { QbitZmqSubscriber } from '@qbit-oss/zmq'

// qbitd -testnet4 -zmqpubhashblock=tcp://127.0.0.1:28332 -zmqpubsequence=tcp://127.0.0.1:28332
const zmq = new QbitZmqSubscriber({
  url: 'tcp://127.0.0.1:28332',
  topics: ['hashblock', 'sequence'],
  staleAfterMs: 10 * 60_000, // the default
})

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
```

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
- `closed` after `close()`.

`lastMessageAt` is this process's receipt time (`Date.now()`), not a node
timestamp.

## Connection handling

The subscriber replaces its socket when the connection to the publisher
drops (`reason: 'disconnected'`: qbitd stopped or restarted) or a receive fails
(`reason: 'failed'`), yielding a `reconnect` event, waiting `reconnectDelayMs`
(default 1 s) and starting again. `close()` closes the socket and ends the
iteration at once, also during that wait; breaking out of `for await` closes
the socket too. One consumer at a time.

`maxMessageSize` (default `DEFAULT_MAX_MESSAGE_SIZE`, 2,065,536 bytes: qbit's
2,000,000-byte block limit plus headroom) caps each inbound message part.
libzmq drops a connection that sends more, and does not reconnect it itself;
the subscriber replaces the socket, so the oversized message is never
buffered. A custom `socketFactory` receives `{ maxMessageSize }` and must apply
it. The receive queue keeps zeromq's default high-water mark of 1,000
messages.

qbitd's ZMQ publisher has no authentication: keep it on loopback or a private
network.
