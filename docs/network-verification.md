# Network verification

Before `0.1.0`, and again before each minor release, both packages are run
against live qbit Core nodes, not only the CI's regtest smoke test. This file
is the plan (#7) and the record of its runs. There is no testnet4 step: the
fault injection runs on regtest, where it is scripted and repeatable, and the
first real network is mainnet, read-only, with at most one small send from a
wallet the operator funds.

`scripts/verify-network.mjs` runs every step and writes a report for the
operator to commit:

```sh
corepack pnpm verify:network <mode> [--flag value ...]
```

`verify:network` builds both packages first and runs the built `lib/`, as a
consumer would. It exits 0 when every check passed, 1 when any failed (the
report lists each), and 2 for a usage error, before anything is sent.

## What regtest does not show

The packages have run against regtest only. These shapes and conditions occur
on a real network and never there:

- `estimatesmartfee` never returns a fee rate on regtest, only `errors`, so
  `estimateSmartFee`'s `feeRateBitsPerKvB` has never parsed a real estimate.
- `getconfirmationtarget` on regtest reports `hashrate_source:
  fallback_merge_mining_pct`, no AuxPoW blocks in its window, and 100,000
  required confirmations for any value: its observed-chainwork and AuxPoW
  lanes have never been parsed.
- AuxPoW (merge-mined) blocks, as `getblockheader`, `getblock` and `rawblock`
  bodies.
- `getnetworkinfo` with peers, onion or I2P networks and local addresses;
  `getblockchaininfo` during initial block download or on a pruned node;
  non-empty `warnings`; mempool entries with real ancestor and descendant sets.
- Long-lived connections: the keep-alive race with `-rpcservertimeout`,
  cookie rotation on restart, and work-queue pressure from other clients.
- ZMQ over hours: gap accounting against RPC, high-water-mark drops in bursts,
  and real block sizes against `maxMessageSize`.

## Safety

- The node's URL and credentials come from the environment only, never the
  command line: `QBIT_RPC_URL`, and `QBIT_RPC_COOKIE_FILE` or both
  `QBIT_RPC_USER` and `QBIT_RPC_PASSWORD`. A flag such as `--url`, `--password`
  or `--cookie` is refused, naming the variable to set instead.
- `QBIT_EXPECTED_CHAIN` is required, and every mode starts with
  `confirmChain()`: a node of another chain stops the run before anything else
  is sent.
- `read` and `zmq` build their client with no capability, so no wallet-write
  or broadcast call can be made, whatever the code does.
- `send` makes wallet-write calls only with `--send-amount`, on mainnet as
  anywhere, and refuses an amount above **0.001 QBT** and a fee above
  **0.001 QBT** (`MAX_SEND_BITS` and `MAX_FEE_BITS` in
  `scripts/network-verification.mjs`; raise them only in a reviewed pull
  request). It pays a new address of the same wallet, so the send costs only
  its fee.
- `faults` and `regtest` refuse any chain but the regtest node they start
  themselves, on 127.0.0.1, in a temporary data directory, from a qbit Core
  release verified by its signing keys. They stop that node by its pid and
  remove its data directory when they end, on failure too.
- A report holds no credential, cookie, URL or host of a remote node: the
  endpoint is written as `loopback http` or `remote https`. It does hold the
  node's version and block heights, and for `send`, the txid. Remove the txid
  before committing if the wallet must not be linked to this project.

## Steps

### 1. Regtest: everything, with fault injection

Anyone can run this, on any machine, and it needs no funds:

```sh
bin="$(node scripts/qbit-release.mjs fetch "$(mktemp -d)/qbit-core")"
QBIT_BIN_DIR="$bin" corepack pnpm verify:network regtest
```

It starts a regtest node with every ZMQ topic, creates and funds a wallet
(1,010 blocks), and runs, against it, the read sweep (the last 300 blocks and
one sample), a send of 0.0001 QBT, a 45 s ZMQ soak with a block every 3 s
and a qbitd restart, and the faults below. `faults` runs the faults alone.
Each fault is checked against the outcome it must have, and every
`RpcUnknownOutcomeError` is reconciled through its `txid`:

| Fault | Expected |
| --- | --- |
| A node of another chain (`expectedChain: 'main'` against regtest) | `confirmChain()` and a broadcast refused with `RpcChainGuardError`; the transaction never reaches the node |
| A gateway answering 502 to a read | `RpcTransportError` `http_status` 502 |
| A gateway answering 504 after forwarding `sendrawtransaction` | `RpcUnknownOutcomeError` with the txid, `cause` the 504; the transaction is in the mempool |
| A gateway answering 502 without forwarding `sendrawtransaction` | `RpcUnknownOutcomeError`; the node does not have the transaction, and takes the same hex again |
| An abort during a read (`waitForNewBlock`) | `RpcAbortedError` |
| An abort after `sendrawtransaction` was forwarded | `RpcUnknownOutcomeError` with `cause` `RpcAbortedError`; the transaction is in the mempool |
| qbitd killed (SIGKILL) just after accepting `sendrawtransaction` | `RpcUnknownOutcomeError` with the txid, `cause` a reset; after a restart the transaction is found by its txid, or sent again by the same hex |
| A qbitd restart, which rotates the cookie | A read fails while it is down; afterwards the same client reads, re-checks the chain and broadcasts |

The gateway is an HTTP proxy the script runs on 127.0.0.1 in front of qbitd.

### 2. Mainnet: read-only sweep

On a synced mainnet node (`qbit-cli getblockchaininfo` shows
`initialblockdownload: false`), running qbit Core v1.0.0. `-txindex` is not
needed: the sweep passes each block's hash. Run it on the node's host, so the
URL is loopback and the cookie can be used:

```sh
export QBIT_RPC_URL=http://127.0.0.1:8352/   # mainnet's default -rpcport
export QBIT_RPC_COOKIE_FILE=~/.qbit/.cookie
export QBIT_EXPECTED_CHAIN=main
corepack pnpm verify:network read --blocks 2000 --duration 1h --interval 60s
```

It walks the last 2,000 blocks (`getblockhash`, `getblockheader`, `getblock`,
and `getrawtransaction` verbose for every transaction, in batches), compares
one transaction a block with `call()`'s `JsonNumber` amounts, and then every
minute for an hour reads the chain and network state, up to 200 mempool
entries, 20 outputs with `gettxout`, `estimatesmartfee` for every target from
1 to 1008, and `getconfirmationtarget` at each security level. Every
`RpcResponseError` is recorded with its method and `path`, and the raw value
there from `call()`.

To make the sweep unable to change anything even through a bug, give it an RPC
user that may call only these methods. In the node's configuration, with a
password hash from `share/rpcauth/rpcauth.py verify` in the qbit Core release:

```ini
rpcauth=verify:<salt>$<hash>
rpcwhitelist=verify:estimatesmartfee,getbestblockhash,getblock,getblockchaininfo,getblockcount,getblockhash,getblockheader,getchaintips,getconfirmationtarget,getmempoolentry,getmempoolinfo,getmininginfo,getnetworkinfo,getrawmempool,getrawtransaction,gettxout
# Keeps every other user, the cookie's included, as it was: without this line
# a whitelist for one user leaves the others with none.
rpcwhitelistdefault=0
```

Then use `QBIT_RPC_USER=verify` and `QBIT_RPC_PASSWORD` in place of
`QBIT_RPC_COOKIE_FILE`. The ZMQ soak needs the same list.

A remote node is reached over HTTPS only, through a TLS terminator; put its CA
in a PEM file and set `QBIT_RPC_CA_FILE`.

### 3. Mainnet: ZMQ soak

With the node publishing every topic (`-zmqpubhashblock`, `-zmqpubhashtx`,
`-zmqpubrawblock`, `-zmqpubrawtx`, `-zmqpubsequence`, all on one address), and
the same environment:

```sh
export QBIT_ZMQ_URL=tcp://127.0.0.1:28332
corepack pnpm verify:network zmq --duration 24h --interval 60s
```

It counts each topic's messages, gaps, malformed messages and reconnects,
looks up each `hashblock` with `getblockheader`, and at the end walks the
chain back from the tip to where it started, counting blocks that no
`hashblock` announced (each must fall in a reported gap). It samples
`health()` every minute and records the largest `rawblock` against
`maxMessageSize` (2,065,536 bytes). During the soak, restart qbitd once
(`qbit-cli stop`, then start it): the report must show a reconnect, `unknown`
health while it is down, and a gap per topic after. ZMQ has no
authentication: keep it on loopback, or tunnel it (`ssh -L`).

### 4. Mainnet: one small send (optional)

From a wallet the operator funds with at least the amount plus 0.001 QBT, and
unlocks for the run if it is encrypted, outside this script, which never
takes a passphrase. Read the passphrase from standard input, so it is in
neither the shell's history nor the process list:
`qbit-cli -stdinwalletpassphrase -rpcwallet=<name> walletpassphrase 600`, then
type it and press Enter.

The send needs wallet calls that step 2's read-only `verify` user may not
make: go back to the cookie, or to a user that may make them, first.

```sh
unset QBIT_RPC_USER QBIT_RPC_PASSWORD
export QBIT_RPC_COOKIE_FILE=<the node's .cookie> QBIT_RPC_WALLET=<name>
corepack pnpm verify:network send --send-amount 0.0001 --confirmations 1
```

It waits until the wallet signs (after a start, qbitd validates the wallet's
plaintext PQC keys first: `getwalletinfo`'s `pqc_key_validation`), funds a
payment to a new address of the same wallet with `walletcreatefundedpsbt`,
refuses a fee above 0.001 QBT, signs, finalizes, preflights with
`testmempoolaccept`, writes the txid down, broadcasts, reconciles an unknown
outcome by the txid, and waits for the confirmations asked for, up to 2 hours.
A transaction of qbit Core's P2MR outputs is about 3.9 kvB, so the fee cap
holds up to about 25 bits/vB.

### 5. Record the results

Commit each report under `docs/network-reports/` (the default path,
`<date>-<chain>-<mode>.md`) and list it below. Every failure in a report is
fixed, or explained here. Then update the `0.1.0` section's known limitations
in `CHANGELOG.md`, and the networks and qbit Core versions verified in the
README.

## Results

| Date | Step | Node | Commit | Report | Result |
| --- | --- | --- | --- | --- | --- |
| 2026-11-05 | 1, regtest, every mode (from a working tree) | qbit Core v1.0.0, regtest | `f655a1b` with this change | not committed: a rehearsal of the script | pass |

Findings so far:

- On regtest, every fault above has the expected outcome, and every
  `RpcUnknownOutcomeError` reconciled by its txid. In the SIGKILL case the
  transaction was in the mempool again after the restart.
- After a restart, qbit Core v1.0.0 refuses to sign from an unencrypted
  wallet until it has validated the wallet's plaintext PQC keys
  (`signing_blocked` in `getwalletinfo`'s `pqc_key_validation`), with
  `RpcError` "plaintext PQC wallet key validation is still in progress". An
  application that signs right after starting qbitd must wait for it, as the
  script does.
- Steps 2 to 4 have not been run.
