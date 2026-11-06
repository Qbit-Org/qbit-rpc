# Packaging and dependencies

Each tarball holds exactly `package.json`, `README.md`, `LICENSE` and, in
`lib/`, the CommonJS build (`index.js`), the ESM build (`index.mjs`), a source
map for each and the declarations for each (`index.d.ts`, `index.d.mts`). The
maps carry every source file in `sourcesContent`, so `src/` is not shipped:
run Node.js with `--enable-source-maps` to see `src/*.ts` lines in stack traces.
`@qbit-oss/rpc` is about 2.06 MB unpacked (522 KB packed), most of it the two
maps; `@qbit-oss/zmq` about 210 KB (56 KB packed). `pack:check` fails on any
other file, on a map that does not carry its sources, and above a ceiling of
2,270,000 and 280,000 bytes unpacked.

The packages set no `"type"`: `.js` is CommonJS and `.mjs` ESM. They set
`"sideEffects": false`: no module does anything at import that a consumer
relies on (the error brands are set on the packages' own prototypes, and come
with any export that is used), so a bundler may drop a package nothing is
imported from. `consumer:check` bundles both with esbuild to check that a bare
import bundles to nothing, and that bundled error classes still recognize
errors from the CommonJS build.

## `zeromq`

`@qbit-oss/rpc` has no runtime dependencies. `@qbit-oss/zmq` has one optional
peer dependency, `zeromq` `^6.5.0`, and no others. It is optional because
only `QbitZmqSubscriber`'s default socket (`createZeromqSocket`) loads it, at
the first iteration: the parser, a custom `socketFactory` and the types work
without it, and without it a subscriber fails with `ZmqSetupError`
`module_load`. A peer, not a dependency, so that the application chooses and
updates the one copy of the native addon, and an install on a platform
without a prebuilt addon (where `zeromq`'s install script tries to build
libzmq from source) fails only for those who install `zeromq`. Applications
that subscribe add it themselves (`npm install zeromq@^6.5.0`); npm and pnpm
do not install an optional peer. A bundler must leave `zeromq` external, as
for any native addon.

`zeromq` ships prebuilt addons for the platforms
[Compatibility](compatibility.md#nodejs-and-platforms) lists. Its install
script only checks that the prebuilt addon loads, and if none does, builds
libzmq from source, which needs CMake, Ninja and vcpkg and is not tested here.
A package manager that blocks dependency install scripts until approved (pnpm
10 and later, for example) needs it approved only on such a platform.

The floor of the range is the version the workspace pins as a dev dependency,
so CI tests the floor; `pack:check` fails when they differ. The range admits
newer 6.x releases, which CI does not test until the floor moves. Raise the
floor (and the pin, together) to use a newer `zeromq` API, or when an older
6.x is known not to work.
