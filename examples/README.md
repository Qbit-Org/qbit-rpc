# Examples

Three programs, each one file, for a testnet4 node on the same machine:

- [`payout.ts`](payout.ts): pay out from a wallet. It funds a PSBT, reads the
  [PQC signature budget](../docs/rpc/wallet.md#pqc-signature-budgets) of every
  key it spends from, signs, stores the signed transaction, and only then
  broadcasts it. Each payout is stored under the id of the payment request it
  pays, so running the same request again, after a crash or a lost reply
  (`RpcUnknownOutcomeError`), reconciles it by its txid and never pays again:
  the stored hex is sent again if the node does not have it, or the mempool
  lost it. A run first reconciles the payouts an earlier run stored, and a
  payout settles at 6 confirmations either way. See
  [Payments](../docs/rpc/payments.md).
- [`deposit-watcher.ts`](deposit-watcher.ts): credit deposits to a wallet. ZMQ
  `hashblock` and `hashtx` wake it; a sync over RPC from a stored cursor
  (`listSinceBlock`) finds what happened, so a `gap` or a `reconnect`, and a
  minute without notifications, is one more sync, and a lost notification
  delays a deposit without losing it. A deposit is credited once its
  transaction has the confirmations `getConfirmationTarget` asks for the
  transaction's total to the wallet. A reorg can undo either outcome, so a
  conflicted deposit stays watched and a credited one whose block left the
  chain is checked again. Batches stay under the client's 1,000 requests, and
  one failing entry holds back only its own deposit.
- [`header-walk.ts`](header-walk.ts): follow the active chain header by
  header, 100 heights per `batch()`, and notice a reorg, from a block the walk
  passed leaving the active chain or a header not built on the last one, by
  walking back to the fork. Between walks a long poll (`waitForNewBlock`)
  waits for the next block.

Where a program needs storage, it says what it needs as an interface
(`PayoutStore`, `DepositStore`) and defines a stand-in: a directory of JSON
files for payouts, memory for deposits and headers. Use your database instead.

## Running one

Copy it into an ES module project (`"type": "module"`, for top-level `await`)
that depends on `@qbit-oss/rpc` (and `@qbit-oss/zmq` and `zeromq` for the
deposit watcher), and run it with Node.js's type stripping or a runner such as
`tsx`, passing the node's cookie file:

```sh
QBIT_COOKIE_FILE=<the node's .cookie> node payout.ts <request id> <address> <amount in QBT>
QBIT_COOKIE_FILE=<the node's .cookie> node deposit-watcher.ts
QBIT_COOKIE_FILE=<the node's .cookie> node header-walk.ts
```

The payout uses a wallet named `payouts`, and the deposit watcher one named
`deposits`, with ZMQ on `tcp://127.0.0.1:28332`:
`qbitd -testnet4 -zmqpubhashblock=tcp://127.0.0.1:28332 -zmqpubhashtx=tcp://127.0.0.1:28332`.

## How CI checks them

`corepack pnpm consumer:check` (part of `verify`) type-checks each program as
it is against the packed packages, in a project outside the workspace,
strictly and with `exactOptionalPropertyTypes`, at the workspace's TypeScript
and `@types/node` and at the floors the READMEs state, TypeScript 5.0 and
`@types/node` 22.0.0. A program that calls something the packages do not
export, or a helper it does not define, fails the check. CI does not run them:
that needs a funded wallet.
