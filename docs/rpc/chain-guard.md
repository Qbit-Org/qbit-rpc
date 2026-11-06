# Chain guard

Besides their capability, `wallet-write`, `broadcast`, `mining`, `wallet-admin`
and `node-admin` calls need `await rpc.confirmChain()`.
Each chain check sends `getblockchaininfo`, `getblockhash 0` and
`getnetworkinfo` as one JSON-RPC batch, so one node answers all three in one
round trip, and compares three things: `chain` with `expectedChain`, the genesis
block hash with `expectedGenesisHash`, and on signet `signet_challenge` with
`expectedSignetChallenge` (a signet node that reports no challenge differs). It
also reads the node's version, which must be a supported one (see
[Versions and compatibility](versions.md)). Until a check has
matched all three on a supported version, or after one found any of them
different, they throw `RpcChainGuardError` (`reason: 'unconfirmed'` or
`'mismatch'`) without sending anything, and after one found an unsupported
version, `reason: 'unsupported_version'`. On
`mismatch`, `differs` lists what differed (`chain`, `genesis_hash`,
`signet_challenge`), `actualChain`, `actualGenesisHash` and
`actualSignetChallenge` hold what the node reported, `expectedChain`,
`expectedGenesisHash` and `expectedSignetChallenge` what the client expects,
and the message names each
difference. A chain name or challenge that differs is recorded as a `mismatch`
even when the `getblockhash 0` reply failed; `actualGenesisHash` is then
absent. A malformed constructor value is a `TypeError`, as is
`expectedSignetChallenge` without `expectedChain: 'signet'`.

| `expectedChain` | Default `expectedGenesisHash` |
| --- | --- |
| `main` | `0000000000004d60aa5d46013991d0a0e2995d89ee98e53068ae196d763e79f2` |
| `test` | `0000c20791706c6940a43d75db44d1ae9dadeb637cedfbaa5cf293435eeaab3c` |
| `testnet4` | `000000000000796fe86bbc0bf1b66a07e4b4c0676f74b54cf7e5ce8b3f1a0090` |
| `signet` | `0000000a5698c727f05cbdaeaff3e48b48ab187aeb03414e783ea81fed14d65c` |
| `regtest` | `0ee96aa77c4b600850e349344fa21b107e805f5370ddc7a6189db12cf69acce6` |

These are the genesis hashes qbit Core v1.0.0 asserts
(`src/kernel/chainparams.cpp`); `client.toJSON()` shows the one a client
expects. `expectedSignetChallenge` defaults to `51`, the challenge of qbit
Core's default signet. What the check still cannot tell apart:

- **Any two regtest nodes.** Every regtest node has the same genesis block.
- **The default signet and a look-alike.** Every signet has the same genesis
  block, so only the challenge tells signets apart, and `51` (OP_TRUE) is an
  open challenge: anyone can mine a separate signet with it. Pin a signet by a
  challenge only its operators can meet.
- **Two nodes of the same chain behind one URL** (see the end of this section).

Where `-rpcwhitelist` applies, the RPC user needs `getblockhash` and
`getnetworkinfo` as well as `getblockchaininfo` (qbitd answers a batch holding
a method the user may not call with HTTP 403 for the whole batch), and a proxy
in between must pass JSON-RPC batches.

A confirmation goes stale after `chainCheckMaxAgeMs` (default 10 s), and at
once on a connection error (including a reset keep-alive connection whose read
then succeeded on another attempt), an HTTP 401, or a changed cookie (qbitd
writes a new one each time it starts). A wallet-write, broadcast, mining or wallet-admin call made
while it is stale first runs the check again, under the call's own deadline
and in the same attempt, with no timer of its own. If that check fails, the
call is refused without being sent, with `RpcChainGuardError` `reason:
'check_failed'`, never an unknown outcome. Its `method` is the call's, and its
`cause` is what failed: an `RpcTimeoutError`, `RpcAbortedError`,
`RpcTransportError`, `RpcError`, `RpcResponseError` or
`RpcResponseTooLargeError` about `getblockchaininfo`, or `getblockhash` or
`getnetworkinfo` for an error or an invalid reply to that request. Nothing was sent, so calling again
is safe; `cause` tells whether soon is any use (a timeout, a dropped connection
or -28 warming up usually pass, an HTTP 403 does not). `check_failed` keeps
those failures' retry rules: `finalizepsbt` and `testmempoolaccept`, which have
no side effects, are retried under `readRetries`. A mismatch is not a failed
check: a chain name or challenge that differs is a `mismatch` even when the rest
of the reply failed, and so is a mismatch another check records while the
re-check fails. If the check finds another chain, genesis block or signet
challenge, the call is refused and so is every later one until `confirmChain()`
matches again; an unsupported version is refused the same way, until
`confirmChain()` finds a supported one. `rpc.chainStatus` is `unconfirmed`,
`confirmed`, `stale`, `mismatch` or `unsupported_version`. `confirmChain()` is a
read and the check itself, so it throws what failed as it is, never
`check_failed`.

The guard decides after a call's last wait, as it hands the request to the
transport: a mismatch recorded by another check while the call read its
cookie, ran its re-check or waited between re-checks still refuses it. (Once handed over, the request is
sent; nothing recorded after that can recall it.) A guarded call reads the
cookie once per attempt and sends its re-check and itself with that header: a
confirmation counts only for calls with the cookie it was made with, and if
qbitd restarts after the read, the node rejects the call with HTTP 401 instead
of running it.

A check whose answer arrives after a connection error or an HTTP 401 on any
call may predate it, so it changes nothing: the guarded call (or
`confirmChain()`) waits `retryDelayMs` (at most 10 s, and never past the
deadline) and checks again, up to three checks
per attempt, and then fails with `RpcChainGuardError` `reason: 'stale'`,
nothing sent; try again later. So `confirmChain()` resolves only once a check
made with the cookie it read confirmed the chain, and an unconfirmed client
stays refused until then. An answer reporting another chain always stands:
only a `confirmChain()` begun after it can clear it, and one that sees a
mismatch recorded while it runs throws it, unless a `confirmChain()` begun
after that mismatch cleared it first. It returns its own last check's
`getblockchaininfo` answer, which another check may have overtaken: call
`getBlockchainInfo()` for current block data.

The check and the call are separate requests. Behind a load balancer or DNS
name that can switch nodes, they can reach different nodes of the same chain
(or the check can reach the right node and the call another one): point the
client at one node.
