#!/usr/bin/env node
// Compile and load the packed packages the way a consumer does.
//
// Packs both packages (`npm pack` runs `prepack`, a fresh tsup build) and
// unpacks the tarballs into a throwaway project outside the workspace. Then:
//
// 1. Type-checks a Node.js consumer (`lib: ["ES2022"]`, `types: ["node"]`, no
//    DOM lib) against the packed declarations with `skipLibCheck: false`. A
//    `.mts` and a `.cts` file resolve the `import` and `require` export
//    conditions, so both `lib/index.d.mts` and `lib/index.d.ts` are checked,
//    and the run must resolve exactly those files for each package. It runs
//    twice: with the workspace's TypeScript and `@types/node`, and at the
//    floors the package READMEs state, TypeScript 5.0 and `@types/node`
//    22.0.0 (the root `typescript-floor` and `types-node-floor` aliases), so a
//    declaration that needs a newer version of either fails here.
// 2. Loads the CommonJS and the ESM build of each package side by side and
//    checks that each error class's `is()` recognizes an error from the other
//    build, where `instanceof` cannot, and that both builds work.
// 3. Bundles consumers with esbuild (tsup's, from this workspace): a bare
//    import of each package must bundle to nothing, as `"sideEffects": false`
//    allows, and a bundle of a few named exports must keep their error brands
//    and still recognize errors from the packed CommonJS build.
// 4. Installs `@qbit-oss/zmq` without its optional peer `zeromq`: it must
//    type-check and parse, and a subscriber must fail with `module_load`.
//
// Works offline: TypeScript, `@types/node`, esbuild and `zeromq` come from
// this workspace's install, at the versions the lockfile pins.
// Adapted from Qbit-Org/qbit-js scripts/check-packed-consumer.mjs.
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const rpcDir = join(repoRoot, 'packages', 'rpc')
const zmqDir = join(repoRoot, 'packages', 'zmq')
const requireFromRpc = createRequire(join(rpcDir, 'package.json'))
const requireFromRoot = createRequire(join(repoRoot, 'package.json'))
const zeromq = realpathSync(join(zmqDir, 'node_modules', 'zeromq'))
const esbuild = createRequire(realpathSync(join(rpcDir, 'node_modules', 'tsup', 'package.json')))('esbuild')

// One type-check run each: the TypeScript to run, and the `@types/node` it
// sees, linked in as `<typeRoot>/node`.
const TOOLCHAINS = [
  {
    label: 'workspace',
    typescript: dirname(requireFromRpc.resolve('typescript/package.json')),
    typesNode: realpathSync(join(rpcDir, 'node_modules', '@types', 'node')),
  },
  {
    label: 'floor',
    typescript: dirname(requireFromRoot.resolve('typescript-floor/package.json')),
    typesNode: dirname(requireFromRoot.resolve('types-node-floor/package.json')),
  },
]

const PACKAGES = { rpc: '@qbit-oss/rpc', zmq: '@qbit-oss/zmq' }

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`)
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

const CONSUMER = `
import {
  QbitRpcClient,
  RpcChainGuardError,
  RpcError,
  RpcUnknownOutcomeError,
  formatQbt,
  requests,
  type BatchItem,
  type QbitRpcClientOptions,
} from '@qbit-oss/rpc'
import {
  QbitZmqSubscriber,
  ZmqFrameError,
  ZmqSetupError,
  parseZmqMessage,
  type ZmqEvent,
  type ZmqFrameErrorCode,
  type ZmqReconnectCode,
  type ZmqSetupErrorCode,
} from '@qbit-oss/zmq'

const options: QbitRpcClientOptions = {
  url: 'http://127.0.0.1:48352/',
  auth: { cookieFile: '/var/lib/qbit/testnet4/.cookie' },
  expectedChain: 'testnet4',
  capabilities: ['wallet-read'],
}
export const client = new QbitRpcClient(options)
export const amount: string = formatQbt(1n)

export async function heights(): Promise<BatchItem<string>[]> {
  const [a, b] = await client.batch([requests.getBlockHash(1), requests.getBlockHash(2)])
  return [a, b]
}

export async function send(hex: string): Promise<string | undefined> {
  try {
    return await client.sendRawTransaction(hex)
  } catch (error) {
    if (RpcUnknownOutcomeError.is(error)) return error.txid
    throw error
  }
}

export function nodeCode(error: unknown): number | undefined {
  return RpcError.is(error) ? error.rpcCode : undefined
}

export function recheckFailure(error: unknown): unknown {
  return RpcChainGuardError.is(error) && error.reason === 'check_failed' ? error.cause : undefined
}

export function frameCode(error: unknown): ZmqFrameErrorCode | undefined {
  return ZmqFrameError.is(error) ? error.code : undefined
}

export function reconnectCode(event: ZmqEvent): ZmqReconnectCode | undefined {
  return event.kind === 'reconnect' ? event.code : undefined
}

export async function first(): Promise<ZmqEvent | ZmqSetupErrorCode | undefined> {
  const subscriber = new QbitZmqSubscriber({ url: 'tcp://127.0.0.1:28332', topics: ['hashblock'] })
  try {
    for await (const event of subscriber) return event
  } catch (error) {
    if (error instanceof ZmqSetupError) return error.code
    throw error
  }
  return undefined
}
export const parsed = parseZmqMessage
`

const BRAND_CHECK = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as rpcEsm from '@qbit-oss/rpc'
import * as zmqEsm from '@qbit-oss/zmq'

const require = createRequire(import.meta.url)
const rpcCjs = require('@qbit-oss/rpc')
const zmqCjs = require('@qbit-oss/zmq')

for (const [from, to] of [[rpcCjs, rpcEsm], [rpcEsm, rpcCjs]]) {
  assert.notEqual(from.RpcError, to.RpcError, 'the two builds share one RpcError class')
  const error = new from.RpcError('getblockhash', -8, 'Block height out of range')
  assert.equal(error instanceof to.RpcError, false)
  assert.equal(to.RpcError.is(error), true, 'RpcError.is misses the other build')
  assert.equal(to.QbitRpcError.is(error), true, 'QbitRpcError.is misses the other build')
  assert.equal(to.RpcUnknownOutcomeError.is(error), false)
  assert.equal(error.rpcCode, -8)
  assert.equal('code' in error, false, 'RpcError still has a code')
  const refused = new from.RpcChainGuardError('walletlock', 'check_failed', 'regtest', {
    cause: new from.RpcTimeoutError('getblockchaininfo', 5),
  })
  assert.equal(to.RpcChainGuardError.is(refused), true, 'RpcChainGuardError.is misses the other build')
  assert.equal(to.RpcTimeoutError.is(refused.cause), true, 'a check_failed cause is not recognized in the other build')
  const unknown = new from.RpcUnknownOutcomeError('sendrawtransaction', new from.RpcTimeoutError('sendrawtransaction', 5))
  assert.equal(to.RpcUnknownOutcomeError.is(unknown), true)
  assert.equal(to.parseQbt('90071992.54740993'), 9007199254740993n)
  const client = new to.QbitRpcClient({ url: 'http://127.0.0.1:1/', auth: { username: 'u', password: 'secret' }, expectedChain: 'regtest' })
  assert.equal(JSON.stringify(client).includes('secret'), false)
  await assert.rejects(client.walletLock(), e => to.RpcCapabilityError.is(e) && e.reason === 'not_enabled')
}
console.log('rpc dual-build error brands and behaviour: PASS')

const frames = [Buffer.from('hashblock'), Buffer.alloc(32, 1), Buffer.from([1, 0, 0, 0])]
for (const zmq of [zmqEsm, zmqCjs]) {
  assert.deepEqual(zmq.parseZmqMessage(frames), { topic: 'hashblock', sequence: 1, hash: '01'.repeat(32) })
  assert.throws(() => zmq.parseZmqMessage([]), e => e instanceof zmq.ZmqFrameError && e.code === 'frame_count')
  const socket = await zmq.createZeromqSocket()
  assert.equal(typeof socket.receive, 'function', 'zeromq did not load from the packed build')
  socket.close()
  assert.throws(() => new zmq.QbitZmqSubscriber({ url: 'tcp://*:28332', topics: ['hashblock'] }), TypeError)
  const missing = Object.assign(new Error("Cannot find module 'zeromq'"), { code: 'MODULE_NOT_FOUND' })
  const subscriber = new zmq.QbitZmqSubscriber({
    url: 'tcp://127.0.0.1:28332',
    topics: ['hashblock'],
    socketFactory: () => {
      throw missing
    },
  })
  await assert.rejects(
    subscriber[Symbol.asyncIterator]().next(),
    e => e instanceof zmq.ZmqSetupError && e.name === 'ZmqSetupError' && e.code === 'module_load' && e.cause === missing
  )
  assert.equal(subscriber.health().status, 'closed')
}
for (const [from, to] of [
  [zmqCjs, zmqEsm],
  [zmqEsm, zmqCjs],
]) {
  const frame = new from.ZmqFrameError('frame_count')
  assert.equal(frame instanceof to.ZmqFrameError, false)
  assert.equal(to.ZmqFrameError.is(frame), true, 'ZmqFrameError.is misses the other build')
  assert.equal(to.ZmqSetupError.is(frame), false)
  assert.throws(() => from.parseZmqMessage([]), e => to.ZmqFrameError.is(e) && e.code === 'frame_count')
  const foreign = new from.ZmqSetupError('module_load', 'from the other build')
  assert.equal(foreign instanceof to.ZmqSetupError, false)
  assert.equal(to.ZmqFrameError.is(foreign), false)
  assert.equal(to.ZmqSetupError.is(foreign), true, 'ZmqSetupError.is misses the other build')
  const subscriber = new to.QbitZmqSubscriber({
    url: 'tcp://127.0.0.1:28332',
    topics: ['hashblock'],
    socketFactory: () => {
      throw foreign
    },
  })
  await assert.rejects(subscriber[Symbol.asyncIterator]().next(), e => e === foreign)
  assert.equal(subscriber.health().status, 'closed')
}
console.log('zmq dual-build parser, zeromq load, address check, ZmqFrameError and ZmqSetupError: PASS')
`

// A bare import: nothing of either package may be left in the bundle.
const BARE_IMPORT = `
import '@qbit-oss/rpc'
import '@qbit-oss/zmq'
`

const NAMED_IMPORT = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { RpcError, RpcTimeoutError } from '@qbit-oss/rpc'
import { ZmqFrameError, parseZmqMessage } from '@qbit-oss/zmq'

const require = createRequire(import.meta.url)
const rpcCjs = require('@qbit-oss/rpc')
const zmqCjs = require('@qbit-oss/zmq')
assert.equal(RpcError.is(new rpcCjs.RpcError('getblockhash', -8, 'out of range')), true)
assert.equal(rpcCjs.RpcError.is(new RpcError('getblockhash', -8, 'out of range')), true)
assert.equal(rpcCjs.RpcTimeoutError.is(new RpcTimeoutError('getblockhash', 5)), true)
assert.equal(RpcTimeoutError.is(new RpcError('getblockhash', -8, 'out of range')), false)
assert.throws(() => parseZmqMessage([]), e => zmqCjs.ZmqFrameError.is(e) && e.code === 'frame_count')
assert.equal(ZmqFrameError.is(new zmqCjs.ZmqFrameError('topic')), true)
console.log('bundled named imports keep their error brands: PASS')
`

const NO_ZEROMQ = `
import { QbitZmqSubscriber, ZmqSetupError, parseZmqMessage, type ZmqEvent } from '@qbit-oss/zmq'

export const parsed = parseZmqMessage
export async function first(): Promise<ZmqEvent | undefined> {
  const subscriber = new QbitZmqSubscriber({ url: 'tcp://127.0.0.1:28332', topics: ['hashblock'] })
  try {
    for await (const event of subscriber) return event
  } catch (error) {
    if (ZmqSetupError.is(error) && error.code === 'module_load') return undefined
    throw error
  }
  return undefined
}
`

const NO_ZEROMQ_CHECK = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as zmqEsm from '@qbit-oss/zmq'

const require = createRequire(import.meta.url)
assert.throws(() => require.resolve('zeromq'), { code: 'MODULE_NOT_FOUND' }, 'zeromq is installed after all')
const frames = [Buffer.from('hashblock'), Buffer.alloc(32, 1), Buffer.from([1, 0, 0, 0])]
for (const zmq of [zmqEsm, require('@qbit-oss/zmq')]) {
  assert.deepEqual(zmq.parseZmqMessage(frames), { topic: 'hashblock', sequence: 1, hash: '01'.repeat(32) })
  await assert.rejects(zmq.createZeromqSocket(), e => zmq.ZmqSetupError.is(e) && e.code === 'module_load')
  const subscriber = new zmq.QbitZmqSubscriber({ url: 'tcp://127.0.0.1:28332', topics: ['hashblock'] })
  await assert.rejects(
    subscriber[Symbol.asyncIterator]().next(),
    e => zmq.ZmqSetupError.is(e) && e.code === 'module_load' && e.cause !== undefined
  )
  assert.equal(subscriber.health().status, 'closed')
}
console.log('zmq without zeromq: parser works, subscriber fails with module_load: PASS')
`

function bundle(entry, cwd) {
  const outfile = join(cwd, entry.replace(/\.mjs$/, '.bundle.mjs'))
  console.log(`+ esbuild ${entry} --bundle --platform=node --format=esm --outfile=${outfile}`)
  // A bare import of a side-effect-free package draws a warning, which is the point.
  esbuild.buildSync({
    absWorkingDir: cwd,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['zeromq'],
    logLevel: 'error',
  })
  return outfile
}

function typeCheck(tscPath, tsconfig, cwd) {
  console.log(`+ ${process.execPath} ${tscPath} -p ${tsconfig} --listFiles  (cwd: ${cwd})`)
  try {
    return execFileSync(process.execPath, [tscPath, '-p', tsconfig, '--listFiles'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  } catch (error) {
    // tsc writes its diagnostics to stdout, among the files it lists.
    const diagnostics = String(error.stdout ?? '')
      .split('\n')
      .filter(line => line !== '' && !existsSync(line))
    console.error(diagnostics.join('\n'))
    throw error
  }
}

// The real path: on macOS the temporary directory is reached through a symlink
// (/var to /private/var), and tsc lists files by their real paths.
const stage = realpathSync(mkdtempSync(join(tmpdir(), 'qbit-rpc-packed-consumer-')))
let passed = false
try {
  const consumerDir = join(stage, 'consumer')
  const modules = join(consumerDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  symlinkSync(zeromq, join(modules, 'zeromq'), 'dir')

  for (const [dir, name] of Object.entries(PACKAGES)) {
    const packDir = join(stage, `pack-${dir}`)
    mkdirSync(packDir)
    run('npm', [
      'pack',
      join(repoRoot, 'packages', dir),
      '--pack-destination',
      packDir,
      '--silent',
      '--ignore-scripts=false',
    ])
    const tarball = readdirSync(packDir).find(file => file.endsWith('.tgz'))
    if (!tarball) throw new Error(`npm pack produced no tarball for packages/${dir}`)
    const target = join(modules, ...name.split('/'))
    mkdirSync(target, { recursive: true })
    run('tar', ['-xzf', join(packDir, tarball), '-C', target, '--strip-components=1'])
  }

  writeFileSync(join(consumerDir, 'package.json'), `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`)
  writeFileSync(join(consumerDir, 'consumer.mts'), CONSUMER)
  writeFileSync(join(consumerDir, 'consumer.cts'), CONSUMER)
  // Each toolchain's compiler options, with its @types/node linked in as <typeRoot>/node.
  const setups = TOOLCHAINS.map(toolchain => {
    const typeRoot = join(stage, `types-${toolchain.label}`)
    mkdirSync(typeRoot)
    symlinkSync(toolchain.typesNode, join(typeRoot, 'node'), 'dir')
    const compilerOptions = {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022'],
      types: ['node'],
      typeRoots: [typeRoot],
      strict: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: false,
      noEmit: true,
    }
    return { toolchain, compilerOptions, tscPath: join(toolchain.typescript, 'bin', 'tsc') }
  })
  for (const { toolchain, compilerOptions, tscPath } of setups) {
    const version = name => JSON.parse(readFileSync(join(toolchain[name], 'package.json'), 'utf8')).version
    const versions = `TypeScript ${version('typescript')}, @types/node ${version('typesNode')}`
    const tsconfig = `tsconfig.${toolchain.label}.json`
    writeFileSync(
      join(consumerDir, tsconfig),
      `${JSON.stringify({ compilerOptions, files: ['consumer.mts', 'consumer.cts'] }, null, 2)}\n`
    )
    const listed = typeCheck(tscPath, tsconfig, consumerDir).split('\n')
    if (!listed.some(file => file.startsWith(`${realpathSync(toolchain.typesNode)}/`))) {
      throw new Error(`the ${toolchain.label} run did not use @types/node from ${toolchain.typesNode}`)
    }
    for (const name of Object.values(PACKAGES)) {
      const lib = `${realpathSync(join(modules, ...name.split('/'), 'lib'))}/`
      const resolved = listed
        .filter(file => file.startsWith(lib))
        .map(file => file.slice(lib.length))
        .sort()
      if (JSON.stringify(resolved) !== JSON.stringify(['index.d.mts', 'index.d.ts'])) {
        throw new Error(
          `the consumer resolved ${name} lib/${resolved.join(', lib/')}, not lib/index.d.mts and lib/index.d.ts`
        )
      }
      console.log(`${name} consumer types (lib/${resolved.join(', lib/')}) with ${versions}: PASS`)
    }
  }

  writeFileSync(join(consumerDir, 'brand-check.mjs'), BRAND_CHECK)
  run(process.execPath, ['brand-check.mjs'], { cwd: consumerDir })

  writeFileSync(join(consumerDir, 'bare-import.mjs'), BARE_IMPORT)
  const bare = readFileSync(bundle('bare-import.mjs', consumerDir), 'utf8')
  for (const marker of ['qbit-rpc.', 'qbit-zmq.', 'QbitRpcClient', 'QbitZmqSubscriber']) {
    if (bare.includes(marker)) throw new Error(`a bare import bundled ${marker}: "sideEffects": false is not in effect`)
  }
  console.log(`bare import bundles to ${bare.length} bytes, without either package: PASS`)
  writeFileSync(join(consumerDir, 'named-import.mjs'), NAMED_IMPORT)
  // Bundled, the error classes still recognize errors from the packed CommonJS build. Such a bundle still
  // holds the whole client: esbuild keeps a class with a computed method key, as [inspect.custom]() is.
  run(process.execPath, [bundle('named-import.mjs', consumerDir)], { cwd: consumerDir })

  // Without the optional peer: only @qbit-oss/zmq, its declarations and
  // @types/node, in a directory no zeromq is reachable from.
  const bareDir = join(stage, 'consumer-without-zeromq')
  const bareZmq = join(bareDir, 'node_modules', '@qbit-oss', 'zmq')
  mkdirSync(dirname(bareZmq), { recursive: true })
  cpSync(join(modules, '@qbit-oss', 'zmq'), bareZmq, { recursive: true })
  writeFileSync(join(bareDir, 'package.json'), `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`)
  writeFileSync(join(bareDir, 'consumer.mts'), NO_ZEROMQ)
  for (const { toolchain, compilerOptions, tscPath } of setups) {
    const tsconfig = `tsconfig.${toolchain.label}.json`
    writeFileSync(join(bareDir, tsconfig), `${JSON.stringify({ compilerOptions, files: ['consumer.mts'] }, null, 2)}\n`)
    typeCheck(tscPath, tsconfig, bareDir)
    console.log(`@qbit-oss/zmq consumer types without zeromq, ${toolchain.label} toolchain: PASS`)
  }
  writeFileSync(join(bareDir, 'check.mjs'), NO_ZEROMQ_CHECK)
  run(process.execPath, ['check.mjs'], { cwd: bareDir })
  passed = true
} finally {
  if (passed) {
    rmSync(stage, { recursive: true, force: true })
  } else {
    console.error(`packed consumer check failed; left ${stage} for inspection`)
  }
}
console.log('packed consumer check: PASS')
