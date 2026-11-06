# Contributing

Changes are listed in [CHANGELOG.md](CHANGELOG.md); report vulnerabilities as
[SECURITY.md](SECURITY.md) describes, not in a public issue. Who can approve
and publish a release is in [RELEASING.md](RELEASING.md).

## Setup and checks

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

`verify` runs `format:check`, `build`, `api:check`, `test`, `test:release`
(which needs `gpg`), `test:scripts`, `typecheck`, `typecheck:test`,
`pack:check` and `consumer:check`, as `.github/workflows/ci.yml` does, on each
Node.js line. Which lines and platforms CI covers is in
[Compatibility](docs/compatibility.md).

To install a build of this checkout into another project, pack each package
(`npm pack` runs `prepack`, a fresh build) and install the tarballs:

```sh
(cd packages/rpc && npm pack)   # qbit-oss-rpc-<version>.tgz
(cd packages/zmq && npm pack)   # qbit-oss-zmq-<version>.tgz
npm install /path/to/qbit-oss-rpc-<version>.tgz /path/to/qbit-oss-zmq-<version>.tgz zeromq@^6.5.0
```

There is no ESLint: Prettier formats, and `tsc` in strict mode checks the code.

## The API report

Each package's public API is recorded in `packages/<package>/etc/<package>.api.md`,
an [API Extractor](https://api-extractor.com/) (`@microsoft/api-extractor`
7.59.4) report of every export and its declaration, made from the built
declarations, `lib/index.d.ts` and `lib/index.d.mts`. `api:check` compares both
builds' declarations with the checked-in report and fails on any difference, so
a change to the public API, breaking or not, cannot reach `main` without a
change to that file in the same pull request. The report holds no paths and
does not depend on the Node.js version: every line of the CI matrix checks the
same file. A public type that names an unexported one fails the check too.
What each package exports, and what it keeps internal, is in its docs:
[`@qbit-oss/rpc`](docs/rpc/README.md#public-api) and
[`@qbit-oss/zmq`](docs/zmq/README.md#public-api).

After an intended API change:

```sh
corepack pnpm api:update   # builds, then rewrites packages/*/etc/*.api.md
git diff packages/*/etc    # review what changed
```

Commit the reports with the change, and list a breaking change in
[CHANGELOG.md](CHANGELOG.md) with how a caller migrates. `api:check` alone
(after `corepack pnpm build`) runs the check without writing anything.

## The regtest smoke test

The live smoke test starts a throwaway regtest node (loopback only, temporary
data directory) from a verified qbit Core release, and runs both packages
against it, including every ZMQ topic, a qbitd restart and an oversized
message. CI's `regtest smoke` job runs it on every pull request and push to
`main`. Its encrypted test wallets are first unlocked by the tests, with
`walletPassphrase`'s default deadline: qbitd runs a new encrypted wallet's
deferred keypool top-up inside that first unlock, 25 to 49 s. To run it locally:

```sh
bin="$(node scripts/qbit-release.mjs fetch "$(mktemp -d)/qbit-core")"
QBIT_BIN_DIR="$bin" scripts/regtest-smoke.sh
```

`scripts/qbit-release.mjs` downloads `SHA256SUMS` and `SHA256SUMS.asc` from
the release on `github.com/Qbit-Org/qbit`, and verifies them with `gpg` in a
temporary GnuPG home holding only the keys in `scripts/qbit-release-keys/`:
copies of qbit's own `contrib/keys/operator-keys/` at the release tag, which
its `README.md` names. Every signature must be good and by a listed signing
key, and the distinct signers must meet the release line's quorum in
`keys.json` (3 of 5 for `mainnet`, which v1.0.0 is). Only then does it take
the tarball's SHA-256 from `SHA256SUMS`, and it extracts the tarball only if
it has that hash. CI caches the tarball under that hash, and checks a
restored one again before use.

The release under test is named in one place, `scripts/qbit-core-release.mjs`;
the tag, asset names and cache key follow from it, and the smoke script
refuses a `QBIT_BIN_DIR` of another version. The versions `@qbit-oss/rpc`
supports are defined in one place too, `packages/rpc/src/version.ts`; widen
them only after the smoke test passes against the new release, and say so in
[CHANGELOG.md](CHANGELOG.md). A release signed under a newer
key policy also needs `scripts/qbit-release-keys/` updated, as its `README.md`
describes.

## Property tests and fixtures

The parsers and validators are also tested with
[fast-check](https://fast-check.dev/) properties: amounts, `JsonNumber`, the
txid computation, every result validator, `parseZmqMessage` and the sequence
tracker. Each validator starts from real replies in
`packages/rpc/test/fixtures/regtest/`, which a mutation changes field by field:
it must validate, or fail as `RpcResponseError`, and on a side-effecting call
as `RpcUnknownOutcomeError`. In `test` each property runs a fixed number of
times from a fixed seed, so the run is the same everywhere and takes a few
seconds. For a longer fuzz, set the number of runs; each property then starts
from a random seed, which a failure prints, and `QBIT_FUZZ_SEED` replays it:

```sh
QBIT_FUZZ_RUNS=20000 corepack pnpm test
QBIT_FUZZ_RUNS=20000 QBIT_FUZZ_SEED=-428120168 corepack pnpm test
```

The fixtures come from a throwaway regtest node, as for the smoke test. To
capture them again, after a qbit Core release or a new typed method:

```sh
corepack pnpm build
QBIT_BIN_DIR="$bin" node scripts/capture-rpc-fixtures.mjs
```

It rewrites every fixture, and refuses one holding a path, or the host name as
a whole word of 4 or more characters. On a failure, Ctrl-C or SIGTERM it stops
the node, killing it after 60 s, and removes its data directory. Prettier
leaves the fixtures alone, so each keeps qbit Core's number text.

## Dependency policy

What the packages ship and depend on today is in
[Packaging and dependencies](docs/packaging.md). The rules for changing it:

### Other `@qbit-oss/*` packages

There are none yet. When one is added (say `@qbit-oss/protocol`, to check
addresses or decode `rawtx`):

- Use a caret range, never an exact pin, so an application can share one copy
  and take a fix without a release of these packages. On `0.x`, `^0.3.1` means
  `>=0.3.1 <0.4.0`, so a minor release is a breaking one.
- A plain dependency when it is used internally; a peer dependency when its
  types or classes appear in this package's API, so the application and this
  package see the same ones.
- The floor is the oldest version that works: raise it when using an API
  added later. Never `workspace:` or `file:` in a published manifest.
- The lockfile resolves the newest version in range, which every CI run tests.
  Add a CI job with the first such dependency to test the floor too: install
  with `pnpm install --no-frozen-lockfile --config.resolution-mode=lowest-direct`,
  which resolves each direct dependency to the lowest version its range
  allows, and run `pnpm verify`. A peer follows the `zeromq` rule instead:
  the dev pin is the floor. `pack:check` refuses any runtime dependency today,
  so the first one changes it as well.

### Updates

`.github/dependabot.yml` opens version update pull requests every Monday at
06:00 UTC, two days after a release at the earliest (pnpm refuses one younger
than a day): one for minor and patch updates of the dev tooling, one per major
update, one for each `zeromq` update, which moves the pin only: move the peer
range's floor by hand in that pull request (Dependabot does not update
`peerDependencies`, and `pack:check` fails until the two agree), and one for the
GitHub Actions, which stay pinned by SHA. Major updates of
`@types/node`, which follows the oldest supported Node.js line, are ignored.
Each runs the same CI as any pull request.
