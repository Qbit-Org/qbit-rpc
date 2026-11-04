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
//    and the run must resolve exactly those files for each package.
// 2. Loads the CommonJS and the ESM build of each package side by side and
//    checks that each error class's `is()` recognizes an error from the other
//    build, where `instanceof` cannot, and that both builds work.
//
// Works offline: TypeScript, `@types/node` and `zeromq` come from this
// workspace's install, at the versions the lockfile pins.
// Adapted from Qbit-Org/qbit-js scripts/check-packed-consumer.mjs.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const tscPath = join(dirname(requireFromRpc.resolve('typescript/package.json')), 'bin', 'tsc')
const typeRoot = join(rpcDir, 'node_modules', '@types')
const zeromq = realpathSync(join(zmqDir, 'node_modules', 'zeromq'))

const PACKAGES = { rpc: '@qbit-oss/rpc', zmq: '@qbit-oss/zmq' }

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`)
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

const CONSUMER = `
import {
  QbitRpcClient,
  RpcUnknownOutcomeError,
  formatQbt,
  requests,
  type BatchItem,
  type QbitRpcClientOptions,
} from '@qbit-oss/rpc'
import { QbitZmqSubscriber, ZmqSetupError, parseZmqMessage, type ZmqEvent, type ZmqSetupErrorCode } from '@qbit-oss/zmq'

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
  const foreign = new from.ZmqSetupError('module_load', 'from the other build')
  assert.equal(foreign instanceof to.ZmqSetupError, false)
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
console.log('zmq dual-build parser, zeromq load, address check and ZmqSetupError: PASS')
`

function typeCheck(tsconfig, cwd) {
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
  writeFileSync(
    join(consumerDir, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions, files: ['consumer.mts', 'consumer.cts'] }, null, 2)}\n`
  )
  const listed = typeCheck('tsconfig.json', consumerDir).split('\n')
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
    console.log(`${name} consumer types (lib/${resolved.join(', lib/')}): PASS`)
  }

  writeFileSync(join(consumerDir, 'brand-check.mjs'), BRAND_CHECK)
  run(process.execPath, ['brand-check.mjs'], { cwd: consumerDir })
  passed = true
} finally {
  if (passed) {
    rmSync(stage, { recursive: true, force: true })
  } else {
    console.error(`packed consumer check failed; left ${stage} for inspection`)
  }
}
console.log('packed consumer check: PASS')
