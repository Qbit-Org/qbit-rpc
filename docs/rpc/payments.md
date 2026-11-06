# Payments

For payouts, `@qbit-oss/payments` handles key budgets, fee caps and
crash-safe sending. This page shows the raw calls.

Build, sign, store, then broadcast: the package has no call that signs and
sends in one step (see [the allowlist](capabilities.md)), so the signed
transaction can be stored before it leaves the node, and a lost reply leaves a
txid to reconcile by.

## Paying out from a wallet

Pay out from a testnet4 wallet, saving the signed transaction before it is
broadcast. Before signing, it reads the [PQC signature budget](wallet.md#pqc-signature-budgets)
of every key the PSBT spends from; a test runs those lines as written.

```ts
import { QbitRpcClient, requests, RpcUnknownOutcomeError } from '@qbit-oss/rpc'

const rpc = new QbitRpcClient({
  url: 'http://127.0.0.1:48352/',
  wallet: 'payouts',
  auth: { cookieFile: '/home/qbit/.qbit/testnet4/.cookie' },
  expectedChain: 'testnet4',
  capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
})

await rpc.confirmChain() // wallet-write, broadcast, mining and wallet-admin calls are refused until this matches

const funded = await rpc.walletCreateFundedPsbt({
  outputs: [{ address: 'tq1...', amountBits: 150_000_000n }], // 1.5 QBT
  options: { feeRateBitsPerKvB: 1_000n, changeType: 'p2mr' },
})
// An exhausted PQC key signs nothing and raises no error: before signing, read
// the budget of each key this PSBT spends from, unconfirmed change included.
const { inputs } = (await rpc.call('decodepsbt', [funded.psbt])) as {
  inputs: { witness_utxo?: { scriptPubKey: { address?: string } } }[]
}
const addresses = inputs.map(input => input.witness_utxo?.scriptPubKey.address)
if (!addresses.every(address => address !== undefined)) throw new Error('an input without an address')
const spent = [...new Set(addresses)]
const budgets = await rpc.batch(spent.map(address => requests.getAddressInfo(address)))
const signing = new Map<string, number>() // signatures each PQC key makes here, one per input
for (const [i, info] of budgets.entries()) {
  if (!info.ok) throw info.error
  const state = info.value.pqcOverallLimitState // undefined: no PQC key of this wallet
  if (state === undefined) continue
  const known = state === 'normal' || state === 'warning' || state === 'critical'
  if (!known) throw new Error(`${spent[i]}: PQC key ${state}, rotate first`) // exhausted, or unknown
  const keys = info.value.pqcKeyStates ?? []
  if (keys.length === 0) throw new Error(`${spent[i]}: a PQC state without its keys`)
  const inputsHere = addresses.filter(address => address === spent[i]).length
  for (const { pubkey, pqcSignaturesRemaining: left } of keys) {
    const signs = (signing.get(pubkey) ?? 0) + inputsHere
    signing.set(pubkey, signs)
    // Signing must not run a key out halfway: the inputs after it would stay unsigned.
    if (left < signs) throw new Error(`PQC key ${pubkey}: ${left} signatures left, ${signs} inputs to sign`)
  }
  if (state !== 'critical') continue
  console.warn(`${spent[i]}: PQC key critical: stop using it, and spend its coins to a new address now`)
}
const signed = await rpc.walletProcessPsbt(funded.psbt)
if (!signed.complete || signed.hex === undefined) throw new Error('not fully signed')
const budget = signed.pqcOverallLimitState
if (budget !== undefined && budget !== 'normal' && budget !== 'warning') {
  // critical, exhausted, or a state a later qbit Core adds: rotate keys before the budget runs out
}
const [preflight] = await rpc.testMempoolAccept([signed.hex])
if (preflight?.allowed !== true) throw new Error(`rejected: ${preflight?.rejectReason}`)
const { txid } = preflight // the txid of this hex; nothing is broadcast yet
await saveSignedTransaction(txid, signed.hex) // your storage: persist both before broadcasting
try {
  await rpc.sendRawTransaction(signed.hex) // resolves with the same txid
} catch (error) {
  if (RpcUnknownOutcomeError.is(error)) {
    // The node may have relayed it. Reconcile by the stored txid
    // (rpc.getTransaction(txid)); resubmitting the stored hex is harmless.
    // Never rebuild the payment with new inputs.
  }
  throw error
}
```

## Fee-rate caps

`testMempoolAccept`, `sendRawTransaction` and `submitPackage` take `maxFeeRateBitsPerKvB`, the
highest fee rate to accept, in bits per 1,000 vbytes: `1n` to `99_999_999n`
(qbit Core refuses 1 QBT/kvB or more). Left out, qbit Core's default cap
applies: 0.10 QBT/kvB, `10_000_000n` (10,000 bits/vB; `DEFAULT_MAX_RAW_TX_FEE_RATE`
in v1.0.0, and `help sendrawtransaction` shows it). `0n` is refused before
sending: qbit Core reads a cap of 0 as no cap at all, the opposite of what a cap
of zero says. To send without any cap, use
`call('sendrawtransaction', [hex, 0])`.

## Submitting a package (CPFP)

`submitPackage(rawTxs)` submits 1 to 25 signed transactions together, parents
first and the child last, so that the child's fee can pay for its parents. It
needs `broadcast`, waits for the chain guard, and is never retried. Unlike
`sendRawTransaction`, a refusal is a result, and it can be partial:

```ts
const { packageMsg, txResults } = await rpc.submitPackage([parentHex, childHex])
// 'success': every transaction was accepted or was in the mempool already.
// Anything else: the node's text. Read each entry of txResults, by wtxid:
// { txid, vsize?, fees?, otherWtxid?, error? }
```

- With `packageMsg` other than `success`, the parent can be in the mempool while
  the child was refused, and transactions can have no entry, when the package
  failed before each was evaluated. Check `getMempoolEntry` for what matters.
- The node's error is a definite `RpcError` only when qbit Core v1.0.0 raises
  it before handing any transaction to the mempool (`src/rpc/mempool.cpp`):
  -28 (starting), -3 (a parameter of the wrong type, or a cap that is not an
  amount), -8 (no transaction or more than 25, or a fee-rate cap of 1 QBT/kvB
  or more), -22 (a transaction that does not decode), and -25 with one of two
  texts, `Unspendable output exceeds maximum configured by user (maxburnamount)`
  (`maxBurnAmountBits`) and `package topology disallowed. not child-with-parents
  or parents depend on each other.` (a child that is not last); and the
  JSON-RPC layer's -32700, -32600, -32601 and -32602, raised before any method
  runs. Any other error can come after part of the package was accepted: a failed relay (`transaction
  broadcast failed: ... (N transactions were broadcast successfully)`, as -25,
  -26 or -27), a mempool error (-25), or a failed internal check (-1). Each is
  an `RpcUnknownOutcomeError` whose `cause` is the node's `RpcError`, with
  `txids`.
- On qbit Core v1.0.0 a child cannot rescue a parent below the relay floor
  (`minRelayTxFeeBitsPerKvB`, 250 bits/kvB by default): that parent's `error` is
  `min relay fee not met`. What a child can pay for is a parent above that floor
  and below a mempool floor raised by a full mempool. In the source, version 3
  (TRUC) parents are the one exception; this package's tests do not cover them.
- A lost reply is an `RpcUnknownOutcomeError` too. Its `txids` hold one entry
  per transaction, in package order, typed or through `call()`: the txid
  computed from its hex, or `null` where this package cannot parse the hex,
  which is sent all the same, as `sendRawTransaction` sends it (the node
  decides). `txid` stays unset, even for one transaction. Any of them may have
  been accepted. Submitting the same hex again is harmless: a transaction in the
  mempool already counts as success.

`maxFeeRateBitsPerKvB` is checked for each transaction, and `maxBurnAmountBits`
(default `0n`) for each output of each, as for `sendRawTransaction`.

## Bumping a stuck payment

```ts
const bump = await rpc.psbtBumpFee(txid, { feeRateBitsPerKvB: 4_000n }) // 4 bits/vB
const signed = await rpc.walletProcessPsbt(bump.psbt)
if (!signed.complete) throw new Error('the wallet could not sign every input')
await store(txid, signed.hex!) // before it leaves the node
await rpc.sendRawTransaction(signed.hex!)
```

`psbtBumpFee` builds a replacement (RBF) for one of the wallet's unconfirmed
transactions, with a higher fee, and returns it as an unsigned PSBT: nothing is
signed or sent. The replacement spends every input of the original, so at most
one of the two can confirm, and it may add inputs. The outputs stay as they
were unless you pass `outputs`; the extra fee comes out of the change output the
wallet recognises, or out of `originalChangeIndex`, whatever that output pays
(pointing it at a payment makes the payment smaller). `feeRateBitsPerKvB` must
be at least the original's rate plus the node's incremental relay fee
(`RpcError` -8 otherwise). Without it the wallet estimates, and with `outputs`
that shrink the transaction the estimate can come to no more than
`originalFeeBits`, which the mempool refuses (-26): compare the two, or pass a
fee rate. qbit Core v1.0.0 also bumps a transaction that did not signal BIP 125,
and its mempool took that replacement on regtest. The wallet must be unlocked
(-13). Check `complete` after signing: with inputs of another wallet, it is
false.

It is a side-effecting wallet-write call although it signs nothing: when the
original has no change output the wallet recognises, or `outputs` leave out its
change address, each call takes change keys from the keypool for good, and each
returns another transaction. It is never retried, and a lost reply is an
`RpcUnknownOutcomeError`. That is safe to resolve by calling again, since nothing
was signed or sent; at worst it uses up more change keys. The change position is
random, so even a repeat call that takes no key can return another PSBT and
txid: never reconcile by the txid of a bump.

Reconcile by the original's txid and the txid of each replacement you actually
broadcast, which is why the signed hex is stored first. After an unknown
outcome from `sendRawTransaction`, look both up (`getTransaction`) instead of
building the payment again: they spend the same inputs, so at most one
confirms, and sending the stored hex again returns the same txid while it is in
the mempool (once it is mined, -27 while one of its outputs is unspent and -25
once all are spent, so rely on `getTransaction`). If the original confirms first, the bump
loses the race: `psbtBumpFee` rejects with -1 (an input "is already spent"), and
a replacement signed earlier is refused with -25 (`testMempoolAccept` reports
`missing-inputs`); the payment went through as it was. Once a replacement
confirms, the original has negative `confirmations`, and sending it again fails
with -25. qbit Core names the replacement (`replacedByTxid`, `replacesTxid`)
only when `bumpfee` made it: after `psbtBumpFee` and `sendRawTransaction`, the
original lists it in `walletConflicts` (and in `mempoolConflicts` while it is
in the mempool) and is no longer `trusted`. To bump again, bump the replacement you broadcast: the wallet still
bumps the original, but that fee only has to beat the original's, and the
mempool refuses it (-26) unless it beats the replacement's too.
