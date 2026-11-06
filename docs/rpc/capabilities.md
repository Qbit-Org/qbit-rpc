# Capabilities and the allowlist

Every method, typed or through `call()`, must be on the allowlist below, or in
the client's [`extraMethods`](#opening-another-method-extramethods), and its
capability must be enabled. A refused call throws `RpcCapabilityError` before
any request is made. The allowlist is not exported: this table is its
documentation, and a test keeps the two equal.

| Capability | Methods |
| --- | --- |
| none (read) | `getblockchaininfo`, `getnetworkinfo`, `getbestblockhash`, `getblockcount`, `getblockhash`, `getblockheader`, `getrawtransaction`, `getmempoolentry`, `gettxout`, `getconfirmationtarget`, `estimatesmartfee`, `validateaddress`, `verifydatapqchash`, `getdescriptorinfo`, `deriveaddresses`, `getblock`, `getchaintips`, `getmempoolinfo`, `getrawmempool`, `gettxspendingprevout`, `waitfornewblock`, `waitforblockheight`, `getmininginfo`; untyped: `decoderawtransaction`, `decodepsbt`, `analyzepsbt`, `getorphanmetrics`, `getarchivepeers`, `getindexinfo`, `getzmqnotifications`, `uptime` |
| `wallet-read` | `getwalletinfo`, `gettransaction`, `listunspent`, `getaddressinfo`, `listlockunspent`, `listsinceblock`, `listtransactions`, `getbalances`; untyped: `listwallets` |
| `wallet-write` | `walletcreatefundedpsbt`, `walletprocesspsbt`, `finalizepsbt`, `psbtbumpfee`, `walletpassphrase`, `walletlock`, `getrawchangeaddress`, `lockunspent`, `getnewaddress`, `signdatapqchash` |
| `broadcast` | `testmempoolaccept`, `sendrawtransaction`, `submitpackage` |
| `mining` | `getblocktemplate`, `submitblock`, `createauxblock`, `submitauxblock` |
| `wallet-admin` | `createwallet`, `loadwallet`, `unloadwallet`, `listwalletdir`, `importdescriptors`, `rescanblockchain`, `backupwallet`, `walletpassphrasechange`, `keypoolrefill` |
| `node-admin` | none built in: node administration opens only through [extraMethods](#node-administration-node-admin) |

`sendmany`, `sendtoaddress`, `send`, `sendall` and `bumpfee` are not
allowlisted: they sign and broadcast in one step, so you cannot store the signed
transaction before it leaves the node. `psbtbumpfee` is allowlisted: it returns
an unsigned PSBT and signs and broadcasts nothing (see
[Bumping a stuck payment](payments.md#bumping-a-stuck-payment)). `finalizepsbt`,
`testmempoolaccept` and `getblocktemplate` change nothing, but are gated with the
steps they belong to, and so is `listwalletdir`, the step before `loadwallet`. See
[mining](mining.md) for why `getmininginfo` is a read and the rest of a pool's
methods need `mining`, and [wallet administration](wallet-admin.md) for
`wallet-admin`, the descriptor reads and `signdatapqchash`.

## Opening another method: `extraMethods`

qbit Core has many more methods. `extraMethods` opens one for one client,
untyped, through `call()` and `requests.raw()`, without changing the package.
Without the option no method is added.

```ts
const rpc = new QbitRpcClient({
  url,
  auth,
  expectedChain: 'testnet4',
  capabilities: ['wallet-write'],
  extraMethods: {
    getchaintxstats: { capability: 'read', sideEffects: false },
    setlabel: { capability: 'wallet-write', sideEffects: true },
  },
})
const stats = await rpc.call('getchaintxstats', [144]) // numbers as JsonNumber
```

Each entry is the policy the client applies to the method, exactly as it does
to an allowlisted method with that policy:

- `capability`: `read` (no capability needed), or `wallet-read`,
  `wallet-write`, `broadcast`, `mining`, `wallet-admin` or `node-admin`, which
  `capabilities` must enable. `wallet-write`, `broadcast`, `mining`,
  `wallet-admin` and `node-admin` calls wait for the [chain guard](chain-guard.md),
  and re-check the chain once it is stale; `node-admin` calls by the chain's
  identity only (see
  [node administration](#node-administration-node-admin)).
- `sideEffects`: required, `true` or `false`; there is no default. A method with
  side effects needs `wallet-write`, `broadcast`, `mining` or `wallet-admin`, so a client without them
  still cannot change state, and the chain guard covers every such call, or
  `node-admin`, for node administration, behind the guard too. Such a
  call is never retried, uses a fresh connection, and is an
  `RpcUnknownOutcomeError` when it may have run (see the
  [failure model](errors.md)).
- For each of the 161 methods qbit Core v1.0.0's `help` lists, the package
  knows what it does, from its source, and refuses a policy below that, so an
  entry cannot open `walletpassphrasechange` or `signrawtransactionwithwallet`
  as a read. A wallet method needs a wallet capability (`wallet-read`,
  `wallet-write` or `wallet-admin`), and one that changes state needs
  `sideEffects: true` under its own kind's capability:

  | What the method does | Least policy | For example |
  | --- | --- | --- |
  | reads the chain, mempool, network or node, or computes from its arguments | any | `getchaintxstats`, `decodescript` |
  | reads a wallet | `wallet-read`, `wallet-write` or `wallet-admin` | `getbalance`, `listlabels` |
  | signs with a wallet's keys, or changes the wallet | `wallet-write`, side effects | `signrawtransactionwithwallet`, `signmessage`, `setlabel`, `fundrawtransaction` |
  | administers a wallet, or returns its private keys | `wallet-admin`, side effects (none for `listdescriptors` and `gethdkeys`) | `encryptwallet`, `restorewallet`, `abortrescan`, `listdescriptors` |
  | hands a transaction to the mempool and the network | `broadcast`, side effects | `sendrawtransaction` |
  | builds or submits blocks, or changes a block template | `mining`, side effects (none for `getblocktemplate`) | `submitheader`, `prioritisetransaction` |
  | changes what the node stores, follows or connects to, or stops it | `node-admin`, side effects | `stop`, `setban`, `addnode`, `pruneblockchain`, `savemempool`, `ping` |

  Node administration has its own capability, `node-admin`. qbit Core
  v1.0.0's 18 hidden methods, which `help` does not list, are classed the
  same way: `invalidateblock`, `reconsiderblock` and `setmocktime` need
  `node-admin`, and `generatetoaddress` the capability mining needs. A method
  in neither table, such as one a later release adds, keeps the policy you
  give it: the package cannot tell what it does. The regtest smoke test
  compares the table with `help` on the node, and each hidden name with
  `help <name>`, so a release that changes either fails it.
- In a [batch](methods.md#batches), only `read` and `wallet-read` entries, which have no
  side effects; any other, `node-admin` included, is `RpcCapabilityError`
  `not_batchable`.
- Every call takes a request slot ([the work queue](errors.md#the-work-queue)), and the
  call's or the client's deadline (30 s by default).

The constructor throws a `TypeError` naming the entry for:

- a name that is not lowercase letters and digits, from a letter, at most 64:
  every qbit Core method name has that form;
- an option or entry that is not a plain object (an object literal, or one
  made with `Object.create(null)`): a `Map` or a class instance has no own
  entries to read, and would open nothing;
- a policy below what the method does (above), naming the method and the
  policy it needs, such as `stop` under `broadcast`, which needs `node-admin`;
- a method the package allowlists already, with any policy but its own. Its
  own policy stands, so an entry cannot turn `walletpassphrase` into a read
  that is retried and never an unknown outcome. Restating the same policy is
  accepted, and the built-in one applies: when a later release allowlists a
  method you opened the same way, nothing breaks; when it allowlists it with
  another policy, the constructor throws until you remove or correct the entry;
- `sendmany`, `sendtoaddress`, `send`, `sendall` and `bumpfee`: they sign and
  broadcast in one step, so you cannot store the signed transaction before it
  leaves the node, and a lost reply leaves no txid to reconcile by. Build, sign,
  store, then `sendrawtransaction`;
- a key other than `capability` and `sideEffects`, an unknown capability, or a
  missing or non-boolean `sideEffects`;
- a capability `capabilities` does not enable, restated allowlisted methods
  included. Every call would be refused, so it is a configuration mistake,
  found at startup rather than at the first call. Clients that share one map
  pass each its own entries.

Only the object's own keys count, read once by the constructor: changing it
afterwards changes nothing. `toJSON()` and `util.inspect(client)` list the
opened methods with their policies, so an operator can see what a client
allows.

> **Warning.** An opened method is outside what this package checks and tests:
> its parameters go unchecked and its result unvalidated. For a method `help`
> lists, the package refuses a policy below what it does, but a policy above
> it is yours: `decodescript` under `broadcast` makes a read wait for the chain
> guard and never retry. For a method neither table holds, as a later release's, the policy is entirely
> yours, which the client cannot verify: one that changes node or wallet state
> declared with `sideEffects: false` is retried under `readRetries` and sent
> on a pooled connection, so it can run twice, and a lost reply looks like a
> definite failure, and a `read` entry is open to the client whatever its
> `capabilities` (`invalidateblock` as `read` lets a read-only service change
> the chain the node follows). Declare such a method with side effects when
> unsure. Open only what the service needs, and restrict the RPC user with
> `-rpcwhitelist` as well.

## Node administration: `node-admin`

`stop`, `setban`, `clearbanned`, `addnode`, `disconnectnode`,
`setnetworkactive`, `pruneblockchain`, `savemempool`, `importmempool`,
`logging`, `dumptxoutset`, `loadtxoutset`, `getblockfrompeer`,
`preciousblock` and `ping` change what the node stores, follows or connects
to, or stop it. Like wallet administration they have a capability of their
own, `node-admin`, but no typed methods, and it allowlists nothing by default:
a client reaches one only by enabling `node-admin` and opening it in
`extraMethods`, with side effects:

```ts
const admin = new QbitRpcClient({
  url,
  auth,
  expectedChain: 'testnet4',
  capabilities: ['node-admin'],
  extraMethods: { setban: { capability: 'node-admin', sideEffects: true } },
})
await admin.call('setban', ['127.0.0.2', 'add', 3600])
```

- Under any other capability, `broadcast` included, such an entry is a
  `TypeError` that names the method and `node-admin`, so a payment service
  that broadcasts cannot stop the node or ban a peer by stating `broadcast`.
- Under `node-admin`, on a client that does not enable it, the constructor
  throws, as for any capability.
- A `node-admin` call waits for the [chain guard](chain-guard.md), as
  `wallet-write` and `broadcast` calls do, so a client that expects regtest
  never stops, bans or invalidates on a mainnet node it was pointed at by
  mistake. It is refused before `confirmChain()`, on another chain
  (`mismatch`), and when the chain cannot be confirmed (`stale`,
  `check_failed`). It needs the chain's identity only: on the expected chain
  with a qbit Core version this package does not support, which refuses the
  other guarded calls with `unsupported_version`, `stop` and `setban` still
  go out. Every client has an `expectedChain`, so there is no way round the
  guard: to administer a node whose chain cannot be confirmed, use
  `qbit-cli`.
- A `node-admin` call is never in a batch. Each has side effects: it is
  never retried, uses a fresh connection, and is an `RpcUnknownOutcomeError`
  when it may have run. `ping` too: it queues a ping on every peer.
- Enabling `node-admin` opens no allowlisted method, and no method that
  needs another capability.

A hidden method that administers the node (`invalidateblock`,
`reconsiderblock`, `setmocktime`, `addconnection`, `addpeeraddress`,
`mockscheduler`, `sendmsgtopeer`) needs `node-admin` with side effects too.
