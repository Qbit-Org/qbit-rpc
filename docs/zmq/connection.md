# Health and connection handling

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
throws a `ZmqSetupError` with a `code` (see [Errors](errors.md)) and the original
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

libzmq 4.3.5, the one `zeromq` 6.5.0 to 6.8.0 bundle, aborts the process (`Assertion
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
