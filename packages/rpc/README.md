# @qbit-oss/rpc

[![npm: @qbit-oss/rpc](https://img.shields.io/npm/v/@qbit-oss/rpc)](https://www.npmjs.com/package/@qbit-oss/rpc)
[![CI](https://github.com/Qbit-Org/qbit-rpc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Qbit-Org/qbit-rpc/actions/workflows/ci.yml?query=branch%3Amain)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Qbit-Org/qbit-rpc/blob/main/LICENSE)

A typed Node.js JSON-RPC client for qbit Core (`qbitd`), with capability
gating, a chain guard, strict result validation and exact `bigint` amounts.
No runtime dependencies and no native code.

## Install

```sh
npm install @qbit-oss/rpc
# or
pnpm add @qbit-oss/rpc
# or
yarn add @qbit-oss/rpc
```

Requirements:

- **Node.js** `^22.13.0 || ^24.0.0 || >=26.0.0`. CI tests 22.13.0 and the
  newest 22.x, 24.x and 26.x on Linux x64; Node.js 27 and later, and other
  operating systems, are expected to work but untested.
- **qbit Core** 1.0.x releases: 1.0.0 and any later 1.0 patch release, but no
  pre-release. Tested against v1.0.0.
- **TypeScript** 5.0 or later, with **`@types/node`** 22.0.0 or later, which
  you install yourself, at the major of your Node.js line. JavaScript needs
  neither.

The package ships CommonJS and ESM builds with type declarations. See
[Compatibility](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/compatibility.md)
for what CI tests.

## Quick start

Read the chain from a testnet4 node on the same machine, in an ES module (for
top-level `await`):

```ts
import { QbitRpcClient, RpcError } from '@qbit-oss/rpc'

const rpc = new QbitRpcClient({
  url: 'http://127.0.0.1:48352/', // testnet4's RPC port
  auth: { cookieFile: '/home/qbit/.qbit/testnet4/.cookie' },
  expectedChain: 'testnet4',
})

const info = await rpc.getBlockchainInfo()
console.log(info.chain, info.blocks, info.bestBlockHash)

try {
  await rpc.getBlockHash(info.blocks + 1) // past the tip
} catch (error) {
  // The node's own answer, typed, with its JSON-RPC code: -8 Block height out of range
  if (RpcError.is(error)) console.log(error.rpcCode, error.message)
  else throw error
}
```

Reads need no capability. Calls that sign, broadcast, mine or administer a
wallet need one enabled in `capabilities`, and `await rpc.confirmChain()`
first. A worked payout, from funding a PSBT to broadcasting it, is in
[Payments](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/payments.md).

## What it does

- **Typed calls.** Typed methods for chain, mempool, wallet, mining and
  wallet-admin calls, each reply validated field by field and returned with
  camelCase names; `call()` for the other allowlisted methods, and `batch()`
  for many reads in one round trip.
  [Methods](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/methods.md)
- **Capabilities and the allowlist.** Every method is on an allowlist under a
  capability the client opts into: `wallet-read`, `wallet-write`,
  `broadcast`, `mining`, `wallet-admin` or `node-admin`. Methods that sign and
  broadcast in one step are never allowed; `extraMethods` opens others under a
  stated policy.
  [Capabilities](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/capabilities.md)
- **Chain guard.** A call that changes state goes out only once the node's
  chain name, genesis block hash, signet challenge and qbit Core version have
  been checked, and the check is repeated when it goes stale.
  [Chain guard](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/chain-guard.md)
- **Error model.** Every failure is a typed error, recognized with
  `X.is(error)` across the CommonJS and ESM builds. A side-effecting call that
  may have run rejects with `RpcUnknownOutcomeError`, which carries what you
  need to reconcile, such as the txid; any other rejection is definite.
  [Errors](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/errors.md)
- **Timeouts and retries.** One deadline per call over every wait and attempt,
  an `AbortSignal`, opt-in retries for reads only, and a limit on each
  client's open requests, to stay within qbitd's work queue.
  [Configuration](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/configuration.md)
- **TLS for remote nodes.** Credentials go in cleartext only to loopback. A
  remote node is reached through a TLS terminator, with a private CA, a client
  certificate and key pins, directly or through a proxy.
  [Remote nodes](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/remote-nodes.md)
- **Exact amounts.** Amounts are `bigint` bits, parsed from the reply's text,
  never a JavaScript `number`.
  [Amounts](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/amounts.md)
- **PQC keys checked before signing.** `walletProcessPsbt` first counts the
  signatures a PSBT needs from each PQC key, and signs nothing when an
  exhausted key, or one that would run out partway, would leave it half signed.
  [Payments](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/payments.md#checking-pqc-keys-before-signing)
- **Wallet workflows.** PSBT payouts, PQC signature budgets, fee bumps, CPFP
  packages, wallet administration and mining.
  [Wallet](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/wallet.md),
  [Mining](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/mining.md)

## Limits

- Node.js only: it does not run in a browser.
- The typed methods cover a chosen set; other methods are untyped through
  `call()`. `sendmany`, `sendtoaddress`, `send`, `sendall` and `bumpfee`
  cannot be opened at all, as they sign and broadcast in one step.
- The chain guard cannot tell two regtest nodes apart, or two nodes of the same
  chain behind one URL.

The full list is in
[Limits](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/limits.md).

## Links

- [Documentation](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/README.md)
  and the [API report](https://github.com/Qbit-Org/qbit-rpc/blob/main/packages/rpc/etc/rpc.api.md),
  every export and its declaration
- [Changelog](https://github.com/Qbit-Org/qbit-rpc/blob/main/CHANGELOG.md),
  shared with `@qbit-oss/zmq`
- [Security](https://github.com/Qbit-Org/qbit-rpc/blob/main/SECURITY.md): the
  review status, and how to report a vulnerability
- [`@qbit-oss/zmq`](https://www.npmjs.com/package/@qbit-oss/zmq), for block
  and mempool notifications
- For payouts, `@qbit-oss/payments` handles key budgets, fee caps and
  crash-safe sending;
  [Payments](https://github.com/Qbit-Org/qbit-rpc/blob/main/docs/rpc/payments.md)
  shows the raw calls
- [MIT License](https://github.com/Qbit-Org/qbit-rpc/blob/main/LICENSE)
