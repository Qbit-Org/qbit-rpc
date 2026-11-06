# Errors

`@qbit-oss/zmq` does not throw for bad input from the publisher: malformed
messages, sequence gaps and socket failures arrive as `malformed`, `gap` and
`reconnect` events, and `health()` reports `unknown` until a message arrives
and again as soon as the connection drops. The table below lists every error
class, `code` and event `reason`; a test keeps it equal to the code.

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
| `reconnect` event | `reason: 'disconnected'` | A connection to the publisher dropped after its handshake: qbitd stopped or restarted, sent a message over `maxMessageSize`, or missed a heartbeat, which a consumer that falls behind causes too. No `code`. | Nothing: the socket is replaced. The next message on each topic is a `gap`. If they come while qbitd is up, speed up the consumer (see [Heartbeats and TCP keepalive](connection.md#heartbeats-and-tcp-keepalive)). |
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
