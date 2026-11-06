# Compatibility

## Supported qbit Core versions

**qbit Core 1.0.x releases**: 1.0.0 and any later 1.0 patch release, but no
pre-release such as `1.0.1-rc1` or `0.1.2-testnet4`. Both packages are tested
against v1.0.0, the release `scripts/qbit-core-release.mjs` names, by CI's
`regtest smoke` job. A new minor version is supported only once that job passes
against it, in a release of these packages that says so.

The scripted fault injection, `corepack pnpm verify:network regtest`, runs by
hand on a throwaway regtest node. Checks against a mainnet node are planned in
[Network verification](network-verification.md), which records each run.

`@qbit-oss/rpc` checks the node's version with every chain check and exposes it
as `rpc.nodeVersion`. On another version it refuses wallet-write, broadcast, mining and wallet-admin
calls with `RpcChainGuardError` `reason: 'unsupported_version'`, unless the
client sets `allowUnsupportedNodeVersion`; reads go on, and every reply is
still validated. Which values a later qbit Core may add pass through, and which
fail validation, is in
[Versions and compatibility](rpc/versions.md).

## Node.js and platforms

`engines` accepts Node.js `^22.13.0 || ^24.0.0 || >=26.0.0`. CI runs all of
`pnpm verify` on Linux x64 (`ubuntu-latest`) for every pull request and push to
`main`, once per line: 22.13.0 exactly (the floor), and the newest 22.x, 24.x
and 26.x. It installs with `--config.engine-strict=true`, so a non-optional
locked dependency whose `engines` leaves out one of these fails CI (pnpm skips
an optional one instead). The `verify` check passes only when every Node.js
line passed.

Node.js 27 and later majors are accepted but untested. They are expected to
work: `@qbit-oss/rpc` uses only standard JavaScript (`JSON.parse` source text
access and `JSON.rawJSON`, checked when a client is created), and the `zeromq`
addon is built against Node-API, whose ABI stays the same across Node.js
majors, so the same prebuild loads without a rebuild. Node.js 23 and 25 are not
accepted.

`@qbit-oss/rpc` has no native code. CI runs its tests on Linux x64 only (the
manual arm64 jobs below load its packed builds too); it is expected to work
wherever a supported Node.js runs.

`@qbit-oss/zmq` is tested with `zeromq` 6.5.0, the floor of its peer range,
which ships a prebuilt addon for each platform below:

| Platform | Minimum | CI |
| --- | --- | --- |
| Linux x64, glibc | glibc 2.25 | All of `verify`, on each Node.js line above |
| Linux arm64, glibc | glibc 2.25 | Loads `zeromq` and the packed packages on `ubuntu-24.04-arm`, Node.js 26.x: see below |
| macOS arm64 | macOS 14 | The same, on `macos-latest` (the current image, not the minimum): see below |
| macOS x64 | macOS 13.7 | Untested |
| Linux x64 and arm64, musl (Alpine) | | Untested |
| Windows x64, arm64 and ia32 | | Untested |

The two arm64 jobs are their own workflow, `zeromq-platforms.yml`. They run on
pull requests that change `packages/zmq/`, that workflow or the lockfile,
weekly against the newest runner images, and by hand (`workflow_dispatch`).
They are not required checks, so a runner that is not available cannot block a
merge. On a platform not in the table above, `zeromq`'s install script builds
libzmq from source, which needs CMake, Ninja and vcpkg and is not tested here.

## TypeScript

The packed declarations need TypeScript 5.0 or later (`QbitRpcClient.batch`
has a `const` type parameter, which TypeScript 4.9 cannot parse) and
`@types/node` 22.0.0 or later (`@qbit-oss/rpc`'s declarations import
`node:stream` and `node:util`). Use the `@types/node` major of the Node.js
line you run.

`@types/node` is not a dependency or a peer dependency of either package, on
purpose: a TypeScript project for Node.js already has it, at the major of its
own Node.js line, and a peer range here would have to follow every Node.js
major the packages accept. JavaScript users never need it.

`consumer:check` type-checks the packed declarations with `skipLibCheck: false`
twice: with the TypeScript and `@types/node` this repository builds with, and
at the floors, TypeScript 5.0.4 and `@types/node` 22.0.0 (the root
`typescript-floor` and `types-node-floor` dev dependencies). A change that needs
a newer version of either fails CI; raising a floor is a breaking change, listed
in [CHANGELOG.md](../CHANGELOG.md).
