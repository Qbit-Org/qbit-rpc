# @qbit-oss/zmq

[![npm: @qbit-oss/zmq](https://img.shields.io/npm/v/@qbit-oss/zmq)](https://www.npmjs.com/package/@qbit-oss/zmq)
[![CI](https://github.com/Qbit-Org/qbit-rpc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Qbit-Org/qbit-rpc/actions/workflows/ci.yml?query=branch%3Amain)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Qbit-Org/qbit-rpc/blob/main/LICENSE)

A Node.js subscriber and strict parser for qbit Core's ZMQ notifications (new
blocks, transactions and mempool changes), which tells you when you missed
some.

## Install

```sh
npm install @qbit-oss/zmq zeromq@^6.8.0
# or
pnpm add @qbit-oss/zmq zeromq@^6.8.0
# or
yarn add @qbit-oss/zmq zeromq@^6.8.0
```

[`zeromq`](https://www.npmjs.com/package/zeromq), the native ZeroMQ addon, is
an optional peer dependency: install it beside the package. Only the
subscriber's default socket needs it, loaded at the first iteration; the
parser and the types work without it, and without it a subscriber fails with
`ZmqSetupError` `code: 'module_load'`. npm and pnpm do not install an optional
peer. It ships prebuilt addons for Linux, macOS and Windows; elsewhere its
install script builds libzmq from source, and a package manager that blocks
install scripts (pnpm 10 and later) needs it approved only there. See
[Packaging and dependencies](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/packaging.md#zeromq).

Requirements:

- **Node.js** `^22.13.0 || ^24.0.0 || >=26.0.0`. CI tests 22.13.0 and the
  newest 22.x, 24.x and 26.x on Linux x64, and loads the addon on Linux arm64
  and macOS arm64; other platforms, and Node.js 27 and later, are untested.
- **qbit Core** 1.0.x releases, run with `-zmqpub…` options. Tested against
  v1.0.0.
- **TypeScript** 5.0 or later, with **`@types/node`** 22.0.0 or later, which
  you install yourself, at the major of your Node.js line.

The package ships CommonJS and ESM builds with type declarations. See
[Compatibility](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/compatibility.md)
for what CI tests.

## Quick start

Log each new block from a testnet4 node on the same machine, in an ES module
(for top-level `await`):

```ts
import { QbitZmqSubscriber, ZmqSetupError } from '@qbit-oss/zmq'

// qbitd -testnet4 -zmqpubhashblock=tcp://127.0.0.1:28332
const zmq = new QbitZmqSubscriber({ url: 'tcp://127.0.0.1:28332', topics: ['hashblock'] })

try {
  for await (const event of zmq) {
    if (event.kind === 'message' && event.message.topic === 'hashblock') console.log('block', event.message.hash)
    if (event.kind === 'gap') console.log('missed notifications: read the chain over RPC')
  }
} catch (error) {
  // A setup problem that retrying cannot fix, such as zeromq not installed.
  if (ZmqSetupError.is(error)) console.error(error.code, error.message)
  throw error
}
```

The loop runs until `zmq.close()`. A dropped connection, a qbitd restart or a
malformed message is an event, not an exception.

## What it does

- **Strict parsing.** Every topic qbit Core publishes, `hashblock`, `hashtx`,
  `rawblock`, `rawtx` and `sequence`, is parsed and checked; a message that
  does not fit is a `malformed` event.
  [Topics](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/zmq/messages.md#topics-and-messages)
- **Gap detection.** Each topic's sequence counter is followed, and a `gap`
  event says when messages were lost, and how many when that is known.
  [Gaps](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/zmq/messages.md#gaps)
- **Health.** `health()` reports `unknown`, `receiving`, `stale` or `closed`,
  measured on the monotonic clock, so silence is never taken for health.
  [Health](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/zmq/connection.md#health)
- **Reconnects and heartbeats.** The subscriber replaces its socket when qbitd
  stops, restarts or hangs, with a `reconnect` event; heartbeats find a hung
  qbitd within 30 s.
  [Connection handling](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/zmq/connection.md#connection-handling)
- **Error model.** A problem that retrying cannot fix ends the iteration with
  a `ZmqSetupError`; everything else is an event with a `code` or `reason`.
  [Errors](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/zmq/errors.md)
- **Address checks.** The constructor refuses a `url` that libzmq would take
  and then never connect to.
  [Addresses](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/zmq/messages.md#addresses)

## Limits

- ZMQ is a wake-up, not a ledger. qbitd's ZMQ publisher has no
  authentication, so keep it on loopback or a private network, and confirm
  what a notification reports over RPC, with
  [`@qbit-oss/rpc`](https://www.npmjs.com/package/@qbit-oss/rpc), before
  acting on it.
- `rawblock` and `rawtx` bodies are not decoded, and CURVE authentication is
  not supported (qbitd does not offer it).
- Node.js only: it does not run in a browser.

The full list is in
[Limits](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/limits.md).

## Links

- [Documentation](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/zmq/README.md)
  and the [API report](https://github.com/Qbit-Org/qbit-rpc/blob/main/packages/zmq/etc/zmq.api.md),
  every export and its declaration
- [API reference](https://qbit-org.github.io/qbit-rpc/): every export and member, with its
  doc comment
- [A deposit watcher](https://github.com/Qbit-Org/qbit-rpc/blob/main/examples/deposit-watcher.ts)
  that wakes on ZMQ and reads over RPC, which CI compiles against the packed
  package
- [Changelog](https://github.com/Qbit-Org/qbit-rpc/blob/main/CHANGELOG.md),
  shared with `@qbit-oss/rpc`
- [Security](https://github.com/Qbit-Org/qbit-rpc/blob/main/SECURITY.md): the
  review status, and how to report a vulnerability
- [`@qbit-oss/rpc`](https://www.npmjs.com/package/@qbit-oss/rpc), to read what
  changed
- [MIT License](https://github.com/Qbit-Org/qbit-rpc/blob/main/LICENSE)
