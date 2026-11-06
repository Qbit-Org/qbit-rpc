# Wallet administration

`wallet-admin` lets a client create, load, unload and list wallets, back them
up, change their passphrase, import descriptors, rescan and refill keypools.
It is apart from `wallet-write`: a payout service that signs needs none of it,
and a tool that sets wallets up signs nothing. Every `wallet-admin` call waits
for the [chain guard](chain-guard.md), `listWalletDir()` included, since
importing descriptors, rescanning or creating a wallet on the wrong chain is a
misconfiguration worth refusing, and none goes in a batch. All but
`listWalletDir()` have side effects: never retried, on a fresh connection, and
an `RpcUnknownOutcomeError` when it may have run.

```ts
const admin = new QbitRpcClient({ url, auth, expectedChain: 'testnet4', capabilities: ['wallet-admin'] })
await admin.confirmChain()
await admin.createWallet('payouts', { passphrase, loadOnStartup: true })
// The calls about one wallet go to its endpoint.
const payouts = new QbitRpcClient({ url, auth, wallet: 'payouts', expectedChain: 'testnet4', capabilities: ['wallet-admin'] })
await payouts.confirmChain()
await payouts.backupWallet('/var/backups/qbit/payouts.dat') // a path on the node's host
```

`createWallet`, `loadWallet`, `unloadWallet` and `listWalletDir` act on the
node's wallet list, from any endpoint; with a client `wallet`, `unloadWallet`'s
name must be that wallet's (`RpcError` -8 otherwise). The others act on the
client's wallet, as the wallet-write methods do.

| Method | A lost reply: what to look at | Calling it again |
| --- | --- | --- |
| `createWallet` | `listWalletDir()` lists it once created | -4 (`Database already exists`) once it exists |
| `loadWallet` | `call('listwallets')` (`wallet-read`) | -35 once it is loaded |
| `unloadWallet` | `call('listwallets')` | -18 once it is unloaded |
| `importDescriptors` | `getAddressInfo(address).isMine`, for an address `deriveAddresses` gives; `getWalletInfo().scanning` while it still rescans | can be -4 (`new range must include current range`): an import widens the range to the keypool's lookahead |
| `rescanBlockchain` | `getWalletInfo().scanning`, `false` once no rescan runs | -4 while one runs; afterwards it rescans again |
| `backupWallet` | the file on the node's host | writes the same backup again |
| `walletPassphraseChange` | keep both passphrases until you know | -14 once the old one no longer applies |
| `keypoolRefill` | `getWalletInfo().keypoolSize`, which waits for a refill still running | harmless: it derives only what is missing |

**Deadlines.** On a chain that allows only P2MR outputs (every chain, unless
regtest runs with `-p2mronly=0`), qbit Core v1.0.0 derives each key of a
keypool or a descriptor range before it answers, at 18 to 21 ms a key on a
loaded shared host. Five methods have a default deadline of 120 s, as
`walletPassphrase` has; a client `timeoutMs` shorter than that does not
shorten it, a longer one applies, and a call's own `timeoutMs` always wins:

- `keypoolRefill` tops each active descriptor, a receiving and a change one by
  default, up to `newSize` (default `-keypool`, 1,000) under the wallet's
  lock. A new wallet holds 16 keys a descriptor until its deferred top-up runs
  (in the background from 30 s after it is created, or inside an encrypted
  one's first unlock), so refilling it takes as long as that first unlock: 41
  s on regtest; 500 more keys a descriptor took 21 s. The time grows with
  `newSize`: about 40 ms for each one above the keypool's size on that host,
  as both descriptors grow.
- `importDescriptors` derives each ranged descriptor's `range`, and at least
  `-keypool` keys past its next index even when it is not active (17.8 s for
  one descriptor imported with `range: [0, 9]`), then rescans once from the
  earliest timestamp: a receiving and a change descriptor imported with
  timestamp 0 took 35 s.
- `rescanBlockchain` reads every block from `startHeight` to the tip (1,010
  regtest blocks: 0.25 s), and derives replacement keys for each used address
  it finds past the keypool's low watermark, inside the scan.
- `unloadWallet` answers once every call still running on the wallet has
  ended: sent during that 41 s refill, it took 36 s.
- `loadWallet` does both kinds of work before it answers: it tops up the
  keypool, unless the wallet defers its first top-up (`CWallet::Create`,
  src/wallet/wallet.cpp), and attaches the wallet to the chain, rescanning
  from the last block it saw (`CWallet::AttachChain`). Loading a wallet that
  is up to date with a full keypool took 0.1 s; one that missed many blocks,
  or holds fewer keys than `-keypool`, takes as long as that rescan or refill.

What grows with the chain or with the keys asked for has no default that fits:
a rescan of a long chain from an early height, an import with an early
`timestamp` (qbit Core warns it "can take over an hour"), or a large `newSize`
or `range`. Give those calls a `timeoutMs` for the work, measured on your node
(`getWalletInfo().scanning` shows a rescan's `duration` and `progress`), or
import with `timestamp: 'now'`, which scans the last 2 hours of blocks only, and
rescan from the height you need. A call that
misses its deadline is an `RpcUnknownOutcomeError`, and the node goes on with
it: reconcile as the table says before you call again. The other wallet-admin
methods keep 30 s: on that host `createWallet` took 0.6 s (1.1 s with a
passphrase), `walletPassphraseChange` 0.4 s and `backupWallet` of a 1.5 MB
wallet 0.02 s.

**Encrypted wallets.** `createWallet` with a `passphrase` creates the wallet
with 16 keys a descriptor and leaves the rest of its keypool to its first
unlock, which takes 25 to 49 s (see
[unlocking an encrypted wallet](wallet.md#unlocking-an-encrypted-wallet)); unlock it once
right after creating it, before it serves anything. An empty `passphrase` is
refused, as qbit Core creates an unencrypted wallet for one, with only a
warning, and so is a `passphrase` with `disablePrivateKeys`, which qbit Core
refuses. `walletPassphraseChange` does not run the deferred top-up, and leaves
the wallet locked if it was. `keypoolRefill`, `importDescriptors` and
`rescanBlockchain` need an encrypted wallet unlocked (`RpcError` -13).

**Secrets.** `createWallet`'s passphrase and `walletPassphraseChange`'s two
travel only in the request body, as `walletPassphrase`'s does: no message or
property this package writes holds them, nor `toJSON()` or a log line. A
descriptor can hold private keys, and on a P2MR chain a ranged one must
(`pqc(<xprv>/...)`): it is treated the same way by `importDescriptors`,
`getDescriptorInfo` and `deriveAddresses`, and the argument checks never quote
it. qbit Core's own messages do quote descriptors: a malformed key in its error
(`key '...' is not valid`), and a refused import a whole descriptor (`Could not
add descriptor '...'`, live). So the client redacts every run of 16 or more
letters and digits of the call's descriptors, which every key encoding is,
in any case, as the node may print hex in another, from the node's messages
about these three methods, typed, through `call()` or in a batch, before it
caps them at 1,000 characters: an `RpcError`'s `message`, and each
`DescriptorImportResult`'s `error.message` and `warnings`, read `[redacted]`
there. The descriptors are read from the request body the client sends, so a
copied or hand-built batch entry, params changed after `requests.raw()`, and a
descriptor passed as a `String` or behind `toJSON()` are redacted all the
same. Through `call('importdescriptors')` the result is the
node's as it is, and can quote a descriptor in full: use `importDescriptors`.
The request objects `requests` builds hold the secrets in `params`, as they are
sent: do not log them.

**Backups.** `backupWallet(destination)` copies the wallet to a file on the
node's host, which it overwrites if it exists. Pass an absolute path: a
relative one is resolved against `qbitd`'s working directory, not its data
directory. qbit Core v1.0.0 refuses a directory, despite its help text, and a
path whose directory does not exist, with `RpcError` -4 (`Wallet backup
failed!`; the reason is in `debug.log`). An empty destination is refused
before sending: qbit Core answers it with success, and writes nothing.

## Descriptors

`importDescriptors`, `deriveAddresses` and `getDescriptorInfo` check each
descriptor before sending it: descriptor characters only, and at most one `#`,
then its 8-character checksum (BIP 380), which the client computes and
compares. `importDescriptors` and `deriveAddresses` need the checksum, as qbit
Core does; `getDescriptorInfo` returns it. A descriptor is ranged when a key
path ends in `*`, and multipath when it has `<0;1>`: the client reads both from
the text, as nothing else in a descriptor uses those characters.

- `getDescriptorInfo(descriptor)` needs no capability. `descriptor` is the
  canonical form, with its own checksum, which is checked, and without private
  keys (`hasPrivateKeys` says whether the input had any); `checksum` must be
  the input's, and `isRange` must match its `*`. For a multipath descriptor,
  `multipathExpansion` lists each path's descriptor.
- `deriveAddresses(descriptor, { range })` needs no capability either. A ranged
  descriptor needs `range`, and any other refuses it, as qbit Core does:
  `end`, from 0, or `[begin, end]`, both included, from 0 to 2,147,483,647 and
  at most 1,000,000 indexes, in either form, as qbit Core checks (`end` at
  most 999,999). The reply must hold one address per index
  (`combo()`, several). A multipath descriptor is refused: derive each of
  `getDescriptorInfo()`'s `multipathExpansion`.
- `importDescriptors(descriptors)` takes `{ desc, timestamp, active?, range?,
  nextIndex?, internal?, label? }` per descriptor and answers one result per
  descriptor, in order: a refused one does not stop the others, so the client
  refuses before sending what qbit Core would refuse or silently ignore for
  one: `range`, `nextIndex` or `active` without `*`, a `nextIndex` outside
  `range`, or without one (qbit Core's default range is the node's first
  `-keypool` indexes, which the client cannot check it against), a `label` on
  a ranged, multipath or internal descriptor or of `*`, and `internal` on a
  multipath one. `timestamp` is Unix time in seconds, 0
  for the whole chain, or `'now'`, the tip's median time; one above 2^32 - 1,
  most likely in milliseconds, is refused. The node scans from 2 hours before
  the earlier of the earliest timestamp and the tip's time (`TIMESTAMP_WINDOW`,
  src/chain.h), so every import scans the last 2 hours of blocks at least: on a
  young regtest chain, all of them, whatever the timestamp (live). A wallet with private keys takes a descriptor only
  with its private keys (`pqc(<xprv>/...)`). A watch-only one
  (`disablePrivateKeys`) takes one P2MR key, `mr(pk(<32-byte PQC key>))`, but no
  ranged public P2MR descriptor, as `pqc(<xpub>/...)` cannot derive PQC keys:
  for that qbit Core offers `exportpubkeydb` and `importpubkeydb`, which are not
  allowlisted.
