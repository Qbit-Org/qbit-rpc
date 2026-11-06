# Mining

A pool enables `mining`, confirms the chain, and works from a template:

```ts
const rpc = new QbitRpcClient({ url, auth, expectedChain: 'main', capabilities: ['mining'] })
await rpc.confirmChain()

const template = await rpc.getBlockTemplate() // { coinbaseValueBits, transactions, bits, target, curTime, height, ... }
// Build the coinbase, the merkle root and the header, then solve it.
await rpc.checkBlockProposal(blockHex) // optional: null, or why the node would refuse it, before any hashing
const result = await rpc.submitBlock(blockHex)
// null: accepted. duplicate: the node had it. inconclusive: stored, but its parent left the tip.
if (result !== null && result !== 'duplicate' && result !== 'inconclusive') logRefusal(result)
```

- `getMiningInfo()` is a read, needing no capability, like `getBlockchainInfo()`:
  it reads what any dashboard wants and costs the node little.
- `getBlockTemplate()` and `checkBlockProposal()` change nothing but need
  `mining`, wait for the chain guard and cannot go in a batch, as the node
  assembles or checks a whole block under its main lock, and work from another
  chain's template is wasted. Having no side effects, they are retried under
  `readRetries` and never an unknown outcome.
- `submitBlock()`, `createAuxBlock()` and `submitAuxBlock()` change node state:
  behind the chain guard, never retried, each on a fresh connection, and an
  `RpcUnknownOutcomeError` when the reply is lost.

**The guard and a block you found.** A block on the wrong chain is wasted work,
and a pool's payouts depend on its blocks being on the right one, so each of
these waits for the guard. Its re-check costs one round trip once the
confirmation is older than `chainCheckMaxAgeMs`, right before the block leaves.
A pool that cannot spare that round trip can raise `chainCheckMaxAgeMs`, or call
`confirmChain()` on a timer shorter than it, so the confirmation is fresh when
a block is found. If that re-check fails, the block was not sent: `RpcChainGuardError`
`reason: 'check_failed'` or `'stale'`. It is safe to send again, and a found
block is worth doing so at once, while its parent is the tip.

**What a result means.** Null means accepted, which does not mean it became the
tip: compare `getBestBlockHash()`. A string is a `BlockSubmissionReason`, and not
every one is a refusal. These held on a v1.0.0 regtest node:

| Result | Meaning |
| --- | --- |
| `null` | Accepted. |
| `duplicate` | The node has the block already, accepted or stored before; it says nothing of the tip. |
| `inconclusive` | Stored but not connected, as its parent is no longer the tip. Not refused; it may not win. |
| `duplicate-invalid` | The node knows the block as invalid. |
| `inconclusive-not-best-prevblk` | A proposal whose parent is not the tip. |
| `stale-prevblk` | From `submitAuxBlock`: see [merge mining](#merge-mining-auxpow). |
| `high-hash`, `bad-cb-amount`, `bad-auxpow-commitment`, ... | Refused, by the consensus check named. A later qbit Core may add others, which pass through. |

Hex that does not decode as a block is `RpcError` -22, not a result. On main,
`getBlockTemplate()` and `createAuxBlock()` are `RpcError` -9 with no peers and
-10 while the node syncs; qbit Core skips both checks on a test chain.

**A lost reply.** `RpcUnknownOutcomeError.blockHash` names the block: the hash of
the hex's 80-byte header, through `call()` too (unset when the hex is too short
to hold one), and for `submitheader`, opened with `extraMethods` under `mining`
with side effects, the hash of the header it submitted. Read it with `getBlockHeader(blockHash)`: `RpcError` -5 says the
node does not have it. Submitting the same hex again is also safe, and `duplicate`
says the node has it. A deadline that passes while the node validates the block
is the same unknown outcome: `submitBlock` has the client's deadline (30 s by
default), and a call's own `timeoutMs` overrides it.

**Long polling.** The typed `getBlockTemplate()` takes no `longpollid`. BIP22's
wait has no end of its own: the node holds the request until the tip or mempool
changes, and a request the client gave up on holds its `qbitd` worker until then.
Use the ZMQ `hashblock` topic or [`waitForNewBlock`](reading-the-chain.md#long-polls), then ask again.
`call()` and `requests.raw()` refuse a `getblocktemplate` with `longpollid` too,
with a `TypeError`, unsent, as they refuse a `waitfor` long poll with no
timeout.

On signet, qbit Core refuses a template without the `signet` rule, so with
`expectedChain: 'signet'` the client's `getBlockTemplate()` sends `rules:
['segwit', 'signet']` unless you give `rules`; `requests.getBlockTemplate()`,
which does not know the chain, needs them passed. `capabilities` is sent as
given, and qbit Core v1.0.0 does not read it.

## Merge mining (AuxPoW)

```ts
const candidate = await rpc.createAuxBlock(payoutAddress) // a P2MR address
// { hash, chainId, previousBlockHash, coinbaseValueBits, bits, height, target, commitmentOrder, ... }
// Commit to candidate.hash in the parent chain's coinbase, and mine the parent to candidate.target.
const result = await rpc.submitAuxBlock(candidate.hash, auxpowHex)
```

- `getBlockTemplate()` has no AuxPoW fields, and its `version` never signals
  AuxPoW: templates are permissionless work. `createAuxBlock()` is how merge
  mining gets its work, and the node keeps the candidate, so the pool builds no
  block itself.
- `chainId` is the AuxPoW chain id, 47 on main and 31430 on testnet, testnet4,
  signet and regtest. `commitmentOrder` is the byte order the commitment must
  use: `display` from `commitmentActivationHeight` on, which is 0 except on
  testnet4 (20,500), `internal` below it.
- The proof is qbit's canonical layout or a Dogecoin-style one, as hex
  (`auxpowHex`). A proof that does not decode is `RpcError` -22; one that decodes
  and fails is a result, such as `bad-auxpow-commitment` or
  `bad-auxpow-parent-hash`.
- `submitAuxBlock()` answers as `submitBlock()` does, null or a reason, not with
  a boolean.
- `stale-prevblk` means no candidate is cached under that hash: its parent left
  the tip, it passed `-auxpowtemplateexpiry` or `-auxpowtemplatecachelimit`, or
  **it was accepted**: the node forgets a candidate it accepts. So after a lost
  reply (`RpcUnknownOutcomeError.blockHash`, the hash you sent), read
  `getBlockHeader(blockHash)`. Do not submit again to find out.
- A lost `createAuxBlock()` reply names nothing: nothing is known but a candidate
  no one can use, which the cache drops. Ask again.
- The reply does not name the payout address, so the package cannot check it
  against the request. Read the coinbase once the block is accepted, with
  `getBlockWithTransactions(candidate.hash)`.
