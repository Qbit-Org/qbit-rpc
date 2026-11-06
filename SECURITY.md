# Security

`@qbit-oss/rpc` and `@qbit-oss/zmq` have not had a third-party security
review.

The [threat model](docs/threat-model.md) sets out what the packages protect,
against whom, and what stays with the application and the node's operator.

## Reporting a vulnerability

Do not report security vulnerabilities in public issues, pull requests or
discussions.

Report them privately, through either channel:

- **GitHub private vulnerability reporting:** open this repository's security
  tab on GitHub and choose **Report a vulnerability**. Only you and the
  maintainers can see the report, and the maintainers follow up there.
- **Email:** write to contact@qbit.org, the address qbit Core's
  [security policy](https://github.com/Qbit-Org/qbit/blob/main/SECURITY.md)
  uses, with `qbit-rpc` and the package's name in the subject.

Include:

- the affected package and its version, or the commit you tested;
- steps or code that reproduce the issue;
- the impact: what an attacker can do, and under which conditions.

## Scope

Both packages in this repository, `@qbit-oss/rpc` and `@qbit-oss/zmq`, are in
scope. Report issues in qbit Core as its
[security policy](https://github.com/Qbit-Org/qbit/blob/main/SECURITY.md)
describes, and issues in `@qbit-oss/protocol` or `@qbit-oss/api` through
[Qbit-Org/qbit-js](https://github.com/Qbit-Org/qbit-js/blob/main/SECURITY.md).

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | Yes: fixes land here |
| Published releases | None yet: both packages are `"private": true` at `0.0.0` |

At the first release this changes. Both packages share one version
([RELEASING.md](RELEASING.md#versioning)), and only the newest release line
gets security fixes: a fix ships as a patch release of both packages on it,
and the table names that line. Below 1.0 a line is one minor version, such as
`0.1.x`, and a new minor line ends fixes for the one before it. Older lines
get none: update to the newest.

## Security boundaries

`@qbit-oss/rpc` holds RPC credentials in memory and sends them only over HTTPS
or to a loopback host. It never logs, and keeps credentials, cookie contents
and request parameters out of the errors it writes (a node's own error message
is passed through). It does not hold private keys:
signing happens in the qbitd wallet, which the `wallet-write` capability lets
a client drive. Treat any process with that capability, and the node's RPC
port, as able to spend the wallet's funds. Before `walletProcessPsbt` signs, it counts the
signatures the PSBT needs from each of the wallet's PQC keys and refuses, with
nothing signed, when a key is exhausted, in a state it does not know, or would
run out partway, which would leave the PSBT half signed; `pqcCheck: false`
turns that off, and is unsafe. The check reads each input as the PSBT
describes it, so it guards PSBTs the wallet built, not one crafted to
misdescribe its inputs.

`@qbit-oss/zmq` reads unauthenticated notifications. qbitd's ZMQ publisher has
no authentication, so a notification proves nothing on its own: confirm what
it reports over RPC before acting on it.

## Releasing

Who can approve and publish a release, and the repository and npm settings
that enforce it, are in [RELEASING.md](RELEASING.md). Before each release,
also check that:

- `verify` and `regtest smoke` pass on the commit to be tagged;
- every setting RELEASING.md lists holds, or is recorded under its
  [Gaps](RELEASING.md#gaps) with the date and the reason;
- the [threat model](docs/threat-model.md) still describes the code, for every
  change in [CHANGELOG.md](CHANGELOG.md) to capabilities, the allowlist or the
  `extraMethods` classes, the chain guard, TLS, credentials, reply limits or
  the ZMQ parser;
- the lockfile's changes since the last release are reviewed, along with any
  change to `allowBuilds` or `minimumReleaseAge` in `pnpm-workspace.yaml`;
- both private channels work: `gh api repos/Qbit-Org/qbit-rpc/private-vulnerability-reporting`
  reports `"enabled": true`, and contact@qbit.org still reaches the
  maintainers;
- a release that fixes a reported vulnerability says so in CHANGELOG.md, and
  the vulnerability's advisory is published once the fixed version is on npm.

After publishing, check each version's provenance as step 10 of
[RELEASING.md's one-time setup](RELEASING.md#one-time-setup) describes.
