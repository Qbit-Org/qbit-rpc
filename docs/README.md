# Documentation

The package READMEs cover installing and a first call:
[`@qbit-oss/rpc`](../packages/rpc/README.md) and
[`@qbit-oss/zmq`](../packages/zmq/README.md). These pages hold the details.

- [`@qbit-oss/rpc` documentation](rpc/README.md): configuration, typed
  methods, capabilities, the chain guard, errors, amounts, remote nodes,
  payments, wallets, mining and long polls.
- [`@qbit-oss/zmq` documentation](zmq/README.md): addresses, topics, gaps,
  health, connection handling and errors.
- [Compatibility](compatibility.md): the qbit Core, Node.js, platform and
  TypeScript versions supported, and what CI tests.
- [Packaging and dependencies](packaging.md): what each tarball holds, and the
  optional `zeromq` peer dependency.
- [Limits](limits.md): what the packages do not do, or cannot check.
- [Threat model](threat-model.md): what the packages protect, against whom,
  and what stays with the application and the node's operator.

## API reference

The TypeDoc reference of both packages, every export and member with its doc
comment, is published at <https://qbit-org.github.io/qbit-rpc/>, built from the
latest release. The [Docs workflow](../.github/workflows/docs.yml) builds it on
every pull request and push to `main`, and deploys it from each final release
tag, once GitHub Pages is enabled for the repository
([RELEASING.md](../RELEASING.md#github-pages-one-time)); until the first such
deploy that address answers 404. Meanwhile, download the reference as the
`api-reference` artifact of a run of the Docs workflow, or build it from a
checkout and open `api-docs/index.html`:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm docs:api
```

TypeDoc fails on any warning, such as an export or member without a doc
comment, so the build in CI keeps every one documented.

## Examples

[`examples/`](../examples/README.md) holds three programs: a payout that stores
the signed transaction before broadcasting it and reconciles a lost reply by
its txid, a deposit watcher that wakes on ZMQ and reads over RPC from a stored
cursor, and a header walk that batches its reads and follows reorgs. CI
type-checks them against the packed packages, as it does every TypeScript
block of these pages and of the READMEs.

Changes are in the [changelog](../CHANGELOG.md); security reports go as
[SECURITY.md](../SECURITY.md) describes; development is in
[CONTRIBUTING.md](../CONTRIBUTING.md).
