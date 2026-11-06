# Configuration

## Client options

| Option | Default | Notes |
| --- | --- | --- |
| `url` | required | `http://` only for a loopback host: an address in `127.0.0.0/8` or `::1` (also as `::ffff:127.0.0.1`), or `localhost`, which every connection resolves and refuses unless all its addresses are loopback (see [localhost](remote-nodes.md#localhost)); anything else must be `https://`. No credentials, query or fragment in the URL. The path may name a wallet (`/wallet/<name>`). |
| `wallet` | none | Sends every call to `/wallet/<name>` (URL-encoded). Needed for wallet calls when several wallets are loaded. |
| `auth` | required | `{ username, password }` (HTTP Basic), or `{ cookieFile }` for a loopback endpoint only. The cookie is read again for every request, so `qbitd` can restart and rotate it. |
| `tls` | the system's CAs, no client certificate, the URL's host, no pin | For an `https` URL, such as a TLS terminator in front of `qbitd`: `ca`, `cert` and `key` (with `passphrase` for an encrypted key), `servername` and `pinSha256`. Each is checked at construction. Certificate verification cannot be turned off. See [Remote nodes](remote-nodes.md). |
| `connect` | none: connect to the URL's host | A function that opens the stream for each connection, such as a tunnel through a proxy; the client runs TLS over it, with every check. `https` URL and Basic credentials only. See [Proxies](remote-nodes.md#proxies-connect). |
| `expectedChain` | required | `main`, `test`, `testnet4`, `signet` or `regtest`. |
| `expectedGenesisHash` | `expectedChain`'s, see [Chain guard](chain-guard.md) | The genesis block hash every chain check expects from `getblockhash 0`: 64 hex characters, either case (compared in lowercase). Set it for a node built with other chain parameters. |
| `expectedSignetChallenge` | `51` on signet | The `signet_challenge` every chain check expects: non-empty hex of whole bytes (the challenge script), either case (compared in lowercase). Only with `expectedChain: 'signet'`. |
| `capabilities` | `[]` | Any of `wallet-read`, `wallet-write`, `broadcast`, `mining`, `wallet-admin`, `node-admin`. |
| `extraMethods` | none | Methods to allow beyond the allowlist, untyped, each `{ capability, sideEffects }`. See [opening another method](capabilities.md#opening-another-method-extramethods). |
| `timeoutMs` | 30,000; at least 120,000 for `walletPassphrase`, `walletLock`, `keypoolRefill`, `importDescriptors`, `rescanBlockchain`, `loadWallet` and `unloadWallet`; at least the wait plus 10 s for a long poll | One deadline per operation: any wait for a request slot, cookie read, every attempt and every backoff. A shorter value does not shorten those 120 s, or a [long poll](reading-the-chain.md#long-polls)'s. Override per call. See [unlocking a wallet](wallet.md#unlocking-an-encrypted-wallet) and [wallet administration](wallet-admin.md). With `connect`, it also bounds a pooled connection still opening after its read gave up (see [Proxies](remote-nodes.md#proxies-connect)). |
| `maxResponseBytes` | 16 MiB | Larger replies fail with `RpcResponseTooLargeError` (or an unknown outcome for side-effecting calls). A full block can pass the default: see [large replies](reading-the-chain.md#large-replies). Leave a few KiB at least: the chain check's batched reply (`getblockchaininfo`, `getblockhash 0` and `getnetworkinfo`, about 2 KiB from a v1.0.0 node without peers) must fit, or every check fails. |
| `readRetries` | 0 | Opt-in retries for methods without side effects (see [Errors](errors.md)). |
| `retryDelayMs` | 250 | First backoff; doubles per retry, capped at 10 s, never past the deadline. |
| `chainCheckMaxAgeMs` | 10,000 | How long a chain confirmation stays fresh before a wallet-write, broadcast, mining or wallet-admin call re-checks it. 0 re-checks before every such call. |
| `maxConcurrentRequests` | 8 | Most requests this client has open at once, on pooled and fresh connections alike (1 to 1,024); it also sizes the keep-alive pool. Further attempts wait in FIFO order under their deadline. See [the work queue](errors.md#the-work-queue). |
| `directNode` | `false` | Set when `url` reaches `qbitd` itself. `qbitd`'s HTTP 503 `Work queue depth exceeded` is then a definite failure, not an unknown outcome. Opt-in, because a proxy in between can answer 503 after forwarding the request. See [the work queue](errors.md#the-work-queue). |
| `allowUnsupportedNodeVersion` | `false` | Let wallet-write, broadcast, mining and wallet-admin calls go to a node outside qbit Core 1.0.x releases, which they are refused otherwise (`RpcChainGuardError` `reason: 'unsupported_version'`). `nodeVersion` still shows the version, and one that does not parse still fails the check. See [Versions and compatibility](versions.md). |

The options, and `tls` and `auth` within them, are read once each, when the
client is constructed, from their own enumerable properties, and the arrays in
them (`capabilities`, `tls.ca`, `tls.pinSha256`) by their own elements. An
option, or a key of `tls` or `auth`, held any other way (inherited, a class
getter, not enumerable, on a polluted `Object.prototype`, left out of the keys
a `Proxy` lists, or answered only by its `get` trap) is a `TypeError` that names
it and says to pass a plain object, and so is a hole in one of those arrays.
Read, such a value could enable a capability, pick a wallet, fill in a password
the application left out, or change whom the client trusts and how it
connects; ignored, a `tls`, `ca` or `pinSha256` would leave the client trusting
more than was asked for. So a polluted `Object.prototype` holding one of these
names fails at construction, unless the object sets that name itself. They are
strict too: any other key is a `TypeError` that names it, with the key it most
likely meant (`timeout` → `timeoutMs`, `server_name` → `tls.servername`) or the
known keys, so `walletName` cannot silently leave out the wallet. A key that is
no near miss and either is not a short identifier or sits in an array entry is
refused as "an unknown key (not shown)", so messages never quote configuration
or request data.

## Call options

Every method, `call()`, `batch()` and `confirmChain()` included, takes its call
options, `{ signal?: AbortSignal, timeoutMs?: number }`, as a separate last
argument, after the method's own options:

```ts
await rpc.getTxOut(txid, vout, { includeMempool: true }, { timeoutMs: 5_000 })
await rpc.listUnspent({ minConf: 1 }, { signal })
await rpc.sendRawTransaction(hex, undefined, { signal }) // none of its own options
```

`timeoutMs` (1 to 3,600,000) overrides the client's for this operation, and
the own default of `walletPassphrase` and `walletLock` (see [unlocking a wallet](wallet.md#unlocking-an-encrypted-wallet)),
the wallet-admin methods' (see [wallet administration](wallet-admin.md))
and a [long poll](reading-the-chain.md#long-polls)'s, and `signal` aborts it (see the [failure model](errors.md)). A method's own
options never hold call options, and the call options hold nothing else: a key
in the wrong one is a `TypeError` that says where it belongs. So a method can
gain an option named like neither without breaking a caller.

## Secrets

Credentials live in private class fields. `JSON.stringify(client)` and
`util.inspect(client)` show only the URL, chain, expected genesis hash (and,
on signet, challenge), capabilities, any `extraMethods` with their policies,
auth kind and chain status; with `tls`, whether it sets a CA and a client
certificate, its `servername` and its pins, which are public; with a `connect` function,
`connect: 'custom'`; and, once a check has read it, the node's version.
`tls.key` and `tls.passphrase`
go into Node's TLS context at construction and are not kept, and an error
about them names the option only. A `connect` function's own errors are not
kept either. Messages and
properties this package writes never include credentials, cookie contents,
request parameters or request bodies.
`RpcError.message` is the node's own text, which can quote an argument such as
an address or hash; qbit Core's `walletpassphrase` errors do not quote the
passphrase. A `check_failed` message quotes its `cause`'s, so it can carry the
node's answer to the chain check, whose requests hold no secrets. The package
does not log.

qbit Core's own results and error messages can quote private keys: a refused
`importdescriptors` quotes the private descriptor, or its xprv, in its error.
The typed methods redact key material from the node's messages, but `call()`
returns the node's result as sent, and redacts only the `RpcError` messages
about `importdescriptors`, `deriveaddresses` and `getdescriptorinfo`, so never
log a raw `call()` result, or an error about another method, for a method that
takes keys.
