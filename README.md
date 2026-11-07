# qbit-rpc

[![npm: @qbit-oss/rpc](https://img.shields.io/npm/v/@qbit-oss/rpc)](https://www.npmjs.com/package/@qbit-oss/rpc)
[![npm: @qbit-oss/zmq](https://img.shields.io/npm/v/@qbit-oss/zmq)](https://www.npmjs.com/package/@qbit-oss/zmq)
[![CI](https://github.com/Qbit-Org/qbit-rpc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Qbit-Org/qbit-rpc/actions/workflows/ci.yml?query=branch%3Amain)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Qbit-Org/qbit-rpc/blob/main/LICENSE)

Node.js clients for a qbit Core node you run. They complement the official
SDK, [`@qbit-oss/api`](https://github.com/Qbit-Org/qbit-js/tree/main/packages/api),
which talks to block explorers, not to `qbitd`. Nothing here is specific to one
application.

## Packages

- [`@qbit-oss/rpc`](packages/rpc/README.md): a typed JSON-RPC client. Read
  chain and wallet state, fund and sign PSBTs with the node's wallet, and
  broadcast, behind capabilities you opt into and a check that the node is on
  the expected chain. No runtime dependencies.

  ```sh
  npm install @qbit-oss/rpc
  ```

- [`@qbit-oss/zmq`](packages/zmq/README.md): a subscriber for `qbitd`'s ZMQ
  notifications (new blocks, mempool changes), which tells you when you
  missed some. It uses the native [`zeromq`](https://www.npmjs.com/package/zeromq)
  addon, an optional peer dependency you install beside it.

  ```sh
  npm install @qbit-oss/zmq zeromq@^6.5.0
  ```

A service that reacts to blocks usually wants both: ZMQ to wake up, RPC to read
what changed.

## Example

Wake up on each new block and read its header, from a testnet4 node on the
same machine:

```ts
import { QbitRpcClient } from '@qbit-oss/rpc'
import { QbitZmqSubscriber } from '@qbit-oss/zmq'

const rpc = new QbitRpcClient({
  url: 'http://127.0.0.1:48352/',
  auth: { cookieFile: '/home/qbit/.qbit/testnet4/.cookie' },
  expectedChain: 'testnet4',
})
// qbitd -testnet4 -zmqpubhashblock=tcp://127.0.0.1:28332
const zmq = new QbitZmqSubscriber({ url: 'tcp://127.0.0.1:28332', topics: ['hashblock'] })

for await (const event of zmq) {
  if (event.kind === 'gap') console.log('missed notifications: re-read the chain')
  if (event.kind === 'message' && event.message.topic === 'hashblock') {
    const header = await rpc.getBlockHeader(event.message.hash)
    console.log(`block ${header.height}: ${header.hash}`)
  }
}
```

## Requirements

Node.js `^22.13.0 || ^24.0.0 || >=26.0.0`, and qbit Core 1.0.x releases,
tested against v1.0.0. The type declarations need TypeScript 5.0 or later and
`@types/node` 22.0.0 or later. Neither package runs in a browser. See
[Compatibility](docs/compatibility.md) for what CI tests, and
[Limits](docs/limits.md).

## Versions

Both packages share one version. Below 1.0, a minor release (`0.1` → `0.2`)
can break and a patch cannot, apart from the behaviour changes
[RELEASING.md](RELEASING.md#versioning) lists. Release candidates are on npm's
`candidate` dist-tag.

## Documentation

- [`@qbit-oss/rpc`](packages/rpc/README.md) and
  [`@qbit-oss/zmq`](packages/zmq/README.md): install and quick start
- [`docs/`](docs/README.md): configuration, methods, capabilities, the chain
  guard, errors, remote nodes, payments, wallets, mining, ZMQ health and
  connection handling, packaging and limits
- [API reference](https://qbit-org.github.io/qbit-rpc/): every export and member of both
  packages, with its doc comment ([where it is published](docs/README.md#api-reference))
- [`examples/`](examples/README.md): a payout, a deposit watcher and a header
  walk, which CI compiles against the packed packages
- [CHANGELOG.md](CHANGELOG.md): changes, breaking ones included, for both
  packages

## Contributing and security

Development, checks and the regtest smoke test are in
[CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities as
[SECURITY.md](SECURITY.md) describes, not in a public issue.

What the packages protect, and what they leave to you, is in the
[threat model](docs/threat-model.md).

## License

[MIT](LICENSE)
