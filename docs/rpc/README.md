# `@qbit-oss/rpc` documentation

The [package README](../../packages/rpc/README.md) covers installing and a
first call. These pages hold the details:

- [Configuration](configuration.md): every client option, per-call options
  (`signal`, `timeoutMs`), and what the client keeps secret.
- [Methods, arguments and batches](methods.md): every typed method and what it
  returns, how arguments are checked, `call()` and `batch()`.
- [Capabilities and the allowlist](capabilities.md): which method needs which
  capability, opening further methods with `extraMethods`, and `node-admin`.
- [Chain guard](chain-guard.md): how the client checks that it talks to the
  expected chain before anything that changes state.
- [Errors](errors.md): every error class and reason, what to do about each,
  retries, deadlines, keep-alive and the node's work queue.
- [Amounts](amounts.md): `bigint` bits, fee-rate units and the conversion
  helpers.
- [Remote nodes](remote-nodes.md): TLS terminators, private CAs, client
  certificates, key pins, proxies, `localhost`, and a polluted
  `Object.prototype`.
- [Payments](payments.md): paying out from a wallet, fee-rate caps, packages
  (CPFP) and fee bumps.
- [Wallet](wallet.md): unlocking, PQC signature budgets, address types, wallet
  history and signing a data hash.
- [Wallet administration](wallet-admin.md): creating, loading and backing up
  wallets, descriptors and rescans.
- [Mining](mining.md): block templates, block submission and merge mining
  (AuxPoW).
- [Reading the chain](reading-the-chain.md): large replies and long polls.
- [Versions and compatibility](versions.md): the qbit Core versions supported,
  the node version check, and values a later qbit Core may add.

For the Node.js, platform and TypeScript versions, see
[Compatibility](../compatibility.md); for known limits, [Limits](../limits.md).

## Common tasks

| Task | Call |
| --- | --- |
| Check the node is on the right chain | `rpc.confirmChain()` |
| Chain tip and sync state | `rpc.getBlockchainInfo()`, `rpc.getBestBlockHash()` |
| Walk headers | `rpc.getBlockHash(height)`, `rpc.getBlockHeader(hash)` |
| Many reads in one round trip | `rpc.batch([requests.getBlockHash(1), requests.getBlockHash(2)])` |
| Confirmations to require for a deposit | `rpc.getConfirmationTarget(valueBits, { securityLevel: 'high' })` |
| Fee estimate | `rpc.estimateSmartFee(6)` → `feeRateBitsPerKvB` |
| Validate an address | `rpc.validateAddress(address)` (P2MR: `witnessVersion: 2`) |
| Wallet balance inputs | `rpc.listUnspent()`, `rpc.getWalletInfo()` |
| Look up a wallet transaction | `rpc.getTransaction(txid)` |
| Build, sign, finalize | `walletCreateFundedPsbt` → `walletProcessPsbt` (which checks the PQC keys' budgets first) → `finalizePsbt` |
| Check PQC keys can sign a PSBT | `rpc.checkPqcSigning(psbt)` → each key's `needed`, `remaining` and `state`, and `warnings`; see [checking PQC keys before signing](payments.md#checking-pqc-keys-before-signing) |
| Preflight and broadcast | `rpc.testMempoolAccept([hex])`, `rpc.sendRawTransaction(hex)` (the node's 0.10 QBT/kvB fee-rate cap, or `{ maxFeeRateBitsPerKvB }`) |
| Keep coins out of coin selection | `rpc.lockUnspent(outputs, { persistent: true })`, `rpc.unlockUnspent(outputs)` |
| Unlock an encrypted wallet | `rpc.walletPassphrase(passphrase, seconds)`, `rpc.walletLock()`; a new wallet's first unlock is slow, see [its deadline](wallet.md#unlocking-an-encrypted-wallet) |
| Sign in or attest with a wallet address | `rpc.signDataPqcHash(address, hash)` (`wallet-write`; each signature uses one of the key's PQC budget), then anyone's `rpc.verifyDataPqcHash(signed)`; see [signing a data hash](wallet.md#signing-a-data-hash) |
| Verify a data-hash PQC proof | `rpc.verifyDataPqcHash(proof)` |
| Set up and keep wallets | with `capabilities: ['wallet-admin']`: `rpc.createWallet(name, { passphrase })`, `loadWallet`, `unloadWallet`, `listWalletDir`, `backupWallet(path)`, `walletPassphraseChange`, `keypoolRefill`; some take minutes, see [wallet administration](wallet-admin.md) |
| Import descriptors, rescan | `rpc.importDescriptors([{ desc, timestamp }])`, `rpc.rescanBlockchain({ startHeight })` (`wallet-admin`); `rpc.getDescriptorInfo(desc)` and `rpc.deriveAddresses(desc, { range })` need none; see [descriptors](wallet-admin.md#descriptors) |
| Read a block, by hash | `rpc.getBlock(hash)`, `rpc.getBlockWithTransactions(hash)` (a full block can pass the default `maxResponseBytes`: [large replies](reading-the-chain.md#large-replies)), `rpc.getBlockHex(hash)` |
| Detect reorgs | `rpc.getChainTips()` |
| Fee floor and mempool | `rpc.getMempoolInfo()` → `mempoolMinFeeBitsPerKvB`, `rpc.getRawMempool()`, `rpc.getTxSpendingPrevout(outputs)` |
| Wait for a block without ZMQ | `rpc.waitForNewBlock(waitMs, { currentTip })`, `rpc.waitForBlockHeight(height, waitMs)`; see [long polls](reading-the-chain.md#long-polls) |
| Pay for a parent with its child (CPFP) | `rpc.submitPackage([parentHex, childHex])`; a refusal is in the result, see [submitting a package](payments.md#submitting-a-package-cpfp) |
| Mine a block, as a pool | with `capabilities: ['mining']`: `rpc.getBlockTemplate()`, `rpc.submitBlock(hex)`, which answers null or a reason; `rpc.getMiningInfo()` needs no capability; see [mining](mining.md) |
| Merge mine (AuxPoW) | `rpc.createAuxBlock(p2mrAddress)`, `rpc.submitAuxBlock(hash, auxpowHex)`; see [merge mining](mining.md#merge-mining-auxpow) |
| Any other allowlisted method | `rpc.call('getindexinfo')` (numbers come back as `JsonNumber`) |
| A method the package does not allowlist | open it for one client, `extraMethods: { getchaintxstats: { capability: 'read', sideEffects: false } }`, then `rpc.call('getchaintxstats')`; see [opening another method](capabilities.md#opening-another-method-extramethods) |
| Abort a call or give it its own deadline | the last argument: `rpc.getTxOut(txid, vout, { includeMempool: true }, { signal, timeoutMs: 5_000 })` |
| Convert amounts | `parseQbt('1.5')` → `150000000n`, `formatQbt(1n)` → `'0.00000001'` |
| Block and mempool notifications | [`@qbit-oss/zmq`](../zmq/README.md): `new QbitZmqSubscriber({ url, topics })`, `subscriber.health()` |

## Public API

`etc/rpc.api.md` is the package's API report: every export and its declaration,
generated by API Extractor from the built declarations. CI fails when the
CommonJS or ESM declarations differ from it, so every change to the public API
shows up in review as a change to that file. To update it after an intended
change, see [CONTRIBUTING.md](../../CONTRIBUTING.md#the-api-report).

The package exports `QbitRpcClient` with its option and result types,
`requests`, the error classes, `JsonNumber`, and the amount helpers
`parseQbt`, `formatQbt`, `BITS_PER_QBT` and `MAX_MONEY_BITS`. The allowlist,
the lists of capabilities and chains, the default genesis hashes and signet
challenge, and the supported qbit Core versions are internal: the `Capability`
and `QbitChain` types name the values, the pages above list them, the
constructor refuses anything else, `nodeVersion.supported` applies the version
range, and `toJSON()` shows what a client uses.
