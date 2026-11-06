# Versions and compatibility

This package supports **qbit Core 1.0.x releases**: 1.0.0 and any later 1.0
patch release, and no pre-release. It is tested against v1.0.0, the release
`scripts/qbit-core-release.mjs` names, by the regtest smoke test (CI's
`regtest smoke` job). A new minor version is supported only once that test
passes against it, in a release of this package that says so. The range is
defined once, in `src/version.ts`.

**The node's version.** Every chain check, `confirmChain()`'s and the re-check
before a wallet-write, broadcast, mining or wallet-admin call, reads `getnetworkinfo` in its batch, so
the version is checked as often as the chain: a guarded call checks again once
the confirmation is older than `chainCheckMaxAgeMs`, or after a sign of a qbitd
restart, as an upgrade is (a connection error, an HTTP 401, a new cookie).
`rpc.nodeVersion` holds the version from the newest check sent whose
`getnetworkinfo` reply was valid (undefined before the first), and `toJSON()`
shows it:

```ts
rpc.nodeVersion // { version: 10000, subversion: '/qbit:1.0.0/', major: 1, minor: 0, patch: 0, supported: true }
```

`version` is `getnetworkinfo.version`, 10000 × major + 100 × minor + patch, and
`subversion` the user agent, with any `-uacomment` in parentheses
(`/qbit:1.0.0(ours)/`). `supported` is true for the user agent `qbit` at 1.0.x
with no pre-release suffix: `/qbit:1.0.1/` is supported; `/qbit:1.1.0/`,
`/qbit:1.0.1-rc1/` and `/qbit:0.1.2-testnet4/` are not.

On a version that is not supported, wallet-write, broadcast, mining and wallet-admin calls are
refused (`node-admin` calls are not: they need the chain's identity only),
unsent, with `RpcChainGuardError` `reason: 'unsupported_version'` (its
`nodeVersion` says which), and `chainStatus` is `unsupported_version`. Like a
mismatch, it stands until a `confirmChain()` begun after it finds a supported
version, and `confirmChain()` throws it. It is reported even when the node's
`getblockchaininfo` reply does not validate, as a newer version may be why; a
chain that differs is reported first, and a recorded mismatch stays until a
`confirmChain()` begun after it reads a valid `getblockchaininfo` and
`getblockhash 0` that match. Reads are not refused: they still
validate every reply, so one a newer version changed fails as `RpcResponseError`,
and `nodeVersion` tells you why it may have. Set `allowUnsupportedNodeVersion:
true` to send guarded calls anyway, taking the risk that the node reads an
argument differently, which no validation catches. A version that does not
parse is never taken for a supported one: a `version` that is not an integer
from 0 to 2,147,483,647, a `subversion` not of the form `/name:major.minor.patch/`
(with qbit Core's optional `-phase` and `-rcN` suffixes and comments), or one
that disagrees with `version`, fails the check with `RpcResponseError` about
`getnetworkinfo`, whatever `allowUnsupportedNodeVersion` says: `confirmChain()`
throws it, and a guarded call is `check_failed` with it as `cause`.
`getNetworkInfo()` reads `version` and `subversion` with the same reader, so it
fails on such a reply too, at the same path.

**Values a later qbit Core may add.** A field this package reads is required
when qbit Core v1.0.0 prints it, except `paytxfee`
(`WalletInfo.payTxFeeBitsPerKvB`), which Bitcoin Core has deprecated: it is
optional, so its removal does not break `getWalletInfo()`. Fields the node adds
are dropped. An enum is open or closed:

| Value | An unknown value | Why |
| --- | --- | --- |
| `BlockchainInfo.chain` | Passed through | The chain guard compares it with `expectedChain` itself, so an unknown name is a `mismatch`. |
| `ConfirmationTarget.model.hashrateSource` | Passed through | It describes the model; the result means the same whatever it is. |
| `WalletInfo.pqcKeyValidation.status` | Passed through | `signingBlocked` says whether the wallet signs. |
| `PqcLimitState`: `pqcLimitState`, `pqcOverallLimitState` and each key's | Passed through | A signature-budget state must reach you, never be dropped or coerced: treat one you do not know as at least `critical`. |
| `BlockSubmissionReason`: a `submitBlock`, `submitAuxBlock` or `checkBlockProposal` result | Passed through | It says why the node did not answer null, and the block's fate is the same whatever the words. |
| `WalletTxCategory`: `category` | Fails validation | The sign and fee checks are per category, and so are the sums of what a wallet received and sent. |
| `bip125Replaceable` | Fails validation | Its `unknown` already means "cannot tell". |
| `ConfirmationTarget.securityLevel` | Fails validation | It names the level the call asked for. |
| `AuxBlock.commitmentOrder` | Fails validation | The proof must commit in that byte order: work under an order this package cannot name would be wasted. |

An open value is typed as its known values or `(string & {})`, so the known
ones still complete in an editor and a `switch` over them needs a `default`. It
passes through as any non-empty string, as the node sent it; an empty or
non-string one fails validation. The JSON-RPC envelope stays strict: a reply
object with a key besides the four JSON-RPC 2.0 defines (`jsonrpc`, `id`,
`result`, `error`) is an `RpcResponseError` (`reason: 'protocol'`).
