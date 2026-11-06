import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  QbitRpcClient,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcTimeoutError,
  RpcUnknownOutcomeError,
  type NodeVersion,
  type QbitRpcClientOptions,
} from '../src'
import {
  basicAuth,
  blockchainInfoJson,
  CHECK,
  FakeNode,
  GENESIS,
  HASH_A,
  HASH_B,
  networkInfoJson,
  TX_HEX,
  TX_TXID,
  type RpcCall,
} from './helpers/fake-node'

// The cookie is read through fs/promises' open: wrap it so a test can count reads.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

let node: FakeNode
let chain: string
let genesis: string
/** getblockchaininfo's result; by default a valid one for `chain`. */
let info: (() => string) | undefined
/** What getnetworkinfo reports: by default qbit Core v1.0.0's. */
let subversion: string
let version: number
/** getnetworkinfo's raw result text, or its error, in place of `networkInfoJson(subversion, version)`. */
let network: string | { code: number; message: string } | undefined
/** While set, chain checks are answered (as the node was when they arrived) only when released. */
let holdChecks: boolean
let held: (() => void)[]

beforeEach(async () => {
  node = await FakeNode.start()
  chain = 'regtest'
  genesis = GENESIS['regtest']!
  info = undefined
  subversion = '/qbit:1.0.0/'
  version = 10000
  network = undefined
  holdChecks = false
  held = []
  node.handler = (request, response) => {
    const parsed = JSON.parse(request.body) as RpcCall | RpcCall[]
    const calls = Array.isArray(parsed) ? parsed : [parsed]
    const reply = (call: RpcCall): string => {
      const id = JSON.stringify(call.id)
      if (call.method === 'getnetworkinfo' && typeof network === 'object') {
        return `{"jsonrpc":"2.0","error":${JSON.stringify(network)},"id":${id}}`
      }
      const result =
        call.method === 'getblockchaininfo'
          ? (info?.() ?? blockchainInfoJson(chain))
          : call.method === 'getblockhash'
            ? JSON.stringify(genesis)
            : call.method === 'getnetworkinfo'
              ? (network ?? networkInfoJson(subversion, version))
              : call.method === 'getbestblockhash'
                ? JSON.stringify(HASH_A)
                : call.method === 'sendrawtransaction'
                  ? JSON.stringify(TX_TXID)
                  : 'null'
      return `{"jsonrpc":"2.0","result":${result},"id":${id}}`
    }
    // Replies are made as the node is when the request arrives.
    const body = Array.isArray(parsed) ? `[${calls.map(reply).join(',')}]` : reply(calls[0]!)
    const answer = (): void => void response.end(body)
    if (Array.isArray(parsed) && holdChecks) return void held.push(answer)
    answer()
  }
})
afterEach(async () => {
  await node.close()
  vi.mocked(open).mockClear()
})

function client(options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
    ...options,
  })
}

const methods = (): string[] => node.calls().map(call => call.method)

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected a rejection'),
    (e: unknown) => e
  )
}

async function unsupported(promise: Promise<unknown>, method: string): Promise<RpcChainGuardError> {
  const error = await rejection(promise)
  expect(RpcChainGuardError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason: 'unsupported_version', method, expectedChain: 'regtest' })
  return error as RpcChainGuardError
}

const V1_0_0: NodeVersion = {
  version: 10000,
  subversion: '/qbit:1.0.0/',
  major: 1,
  minor: 0,
  patch: 0,
  supported: true,
}

describe('the node version', () => {
  it('is read in the chain check’s one batch, and exposed on the client, its JSON form and later errors', async () => {
    const rpc = client()
    expect(rpc.nodeVersion).toBeUndefined()
    expect(rpc.toJSON()).not.toHaveProperty('nodeVersion')
    await rpc.confirmChain()
    expect(node.requests).toHaveLength(1)
    const sent = JSON.parse(node.requests[0]!.body) as RpcCall[]
    expect(sent.map(call => [call.method, call.params])).toEqual([
      ['getblockchaininfo', []],
      ['getblockhash', [0]],
      ['getnetworkinfo', []],
    ])
    expect(rpc.nodeVersion).toEqual(V1_0_0)
    expect(Object.isFrozen(rpc.nodeVersion)).toBe(true)
    expect(Object.getPrototypeOf(rpc.nodeVersion)).toBeNull()
    expect(rpc.toJSON()).toMatchObject({ chainStatus: 'confirmed', nodeVersion: V1_0_0 })
    expect(JSON.parse(JSON.stringify(rpc))).toMatchObject({ nodeVersion: V1_0_0 })
  })

  it.each([
    ['1.0.0', '/qbit:1.0.0/', 10000],
    ['a patch release', '/qbit:1.0.1/', 10001],
    ['the last 1.0 patch number', '/qbit:1.0.99/', 10099],
    ['1.0.0 with -uacomment', '/qbit:1.0.0(probe; two)/', 10000],
  ])('supports %s (%s), and lets guarded calls through', async (_name, agent, number) => {
    subversion = agent
    version = number
    const rpc = client()
    await rpc.confirmChain()
    expect(rpc.chainStatus).toBe('confirmed')
    expect(rpc.nodeVersion).toMatchObject({ version: number, subversion: agent, supported: true })
    await rpc.walletLock()
    expect(methods()).toEqual([...CHECK, 'walletlock'])
  })

  const UNSUPPORTED: [name: string, agent: string, number: number, parts: [number, number, number]][] = [
    ['a new minor version', '/qbit:1.1.0/', 10100, [1, 1, 0]],
    ['a new major version', '/qbit:2.0.0/', 20000, [2, 0, 0]],
    ['a testnet4 pre-release', '/qbit:0.1.2-testnet4/', 102, [0, 1, 2]],
    ['a release candidate of a 1.0 patch', '/qbit:1.0.1-rc1/', 10001, [1, 0, 1]],
    ['a phase build of 1.0.0', '/qbit:1.0.0-beta1-rc2/', 10000, [1, 0, 0]],
    ['another client', '/Satoshi:1.0.0/', 10000, [1, 0, 0]],
    ['version 0', '/qbit:0.0.0/', 0, [0, 0, 0]],
  ]

  it.each(UNSUPPORTED)(
    'refuses %s (%s) on confirmChain, then every guarded call unsent, until a supported one',
    async (_name, agent, number, [major, minor, patch]) => {
      subversion = agent
      version = number
      const rpc = client()
      const error = await unsupported(rpc.confirmChain(), 'getblockchaininfo')
      const reported = { version: number, subversion: agent, major, minor, patch, supported: false }
      expect(error.nodeVersion).toEqual(reported)
      expect(error.message).toBe(
        `RPC method getblockchaininfo refused: the node runs ${agent} (version ${number}), and this client ` +
          'supports qbit Core 1.0.x releases only (see allowUnsupportedNodeVersion)'
      )
      expect(rpc.chainStatus).toBe('unsupported_version')
      expect(rpc.nodeVersion).toEqual(reported)
      expect(rpc.toJSON()).toMatchObject({ chainStatus: 'unsupported_version', nodeVersion: reported })
      // Every guarded call is refused without asking the node; reads go on.
      const later = await unsupported(rpc.sendRawTransaction(TX_HEX), 'sendrawtransaction')
      expect(later.nodeVersion).toEqual(reported)
      expect(RpcUnknownOutcomeError.is(later)).toBe(false)
      expect(await rpc.getBestBlockHash()).toBe(HASH_A)
      expect(methods()).toEqual([...CHECK, 'getbestblockhash'])
      // Back on a supported version, confirmChain() lifts it.
      subversion = '/qbit:1.0.0/'
      version = 10000
      await rpc.confirmChain()
      expect(rpc.chainStatus).toBe('confirmed')
      expect(rpc.nodeVersion).toEqual(V1_0_0)
      await rpc.walletLock()
      expect(methods().at(-1)).toBe('walletlock')
    }
  )

  it.each([
    ['walletlock', (rpc: QbitRpcClient) => rpc.walletLock()],
    ['sendrawtransaction', (rpc: QbitRpcClient) => rpc.sendRawTransaction(TX_HEX)],
  ])('refuses %s, unsent, when its re-check finds the node upgraded past 1.0.x', async (method, run) => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    subversion = '/qbit:1.1.0/'
    version = 10100
    const error = await unsupported(run(rpc), method)
    expect(error.nodeVersion).toMatchObject({ subversion: '/qbit:1.1.0/', supported: false })
    expect(methods()).toEqual([...CHECK, ...CHECK])
    expect(rpc.chainStatus).toBe('unsupported_version')
    // It stands: the next guarded call is refused without a check.
    await unsupported(rpc.walletLock(), 'walletlock')
    expect(methods()).toEqual([...CHECK, ...CHECK])
  })

  it('reports another chain before an unsupported version, and still shows the version', async () => {
    chain = 'main'
    genesis = GENESIS['main']!
    subversion = '/qbit:1.1.0/'
    version = 10100
    const error = await rejection(client().confirmChain())
    expect(error).toMatchObject({ name: 'RpcChainGuardError', reason: 'mismatch', actualChain: 'main' })
    expect((error as RpcChainGuardError).nodeVersion).toBeUndefined()
    const rpc = client()
    await rejection(rpc.confirmChain())
    expect(rpc.chainStatus).toBe('mismatch')
    expect(rpc.nodeVersion).toMatchObject({ subversion: '/qbit:1.1.0/', supported: false })
  })

  it.each([
    [
      'another chain, then a getblockchaininfo reply that does not validate',
      (): void => void (chain = 'main'),
      (): void => void (info = () => '{}'),
      ['chain'],
    ],
    [
      'another genesis block, then a getblockhash reply that does not validate',
      (): void => void (genesis = GENESIS['main']!),
      (): void => void (genesis = 'not a hash'),
      ['genesis_hash'],
    ],
  ] as const)(
    'keeps a recorded mismatch over a later unsupported version without a whole report: %s',
    async (_name, mismatch, breakReport, differs) => {
      mismatch()
      const rpc = client({ chainCheckMaxAgeMs: 0 })
      await rejection(rpc.confirmChain())
      expect(rpc.chainStatus).toBe('mismatch')
      // The node now runs 1.1.0, and the part of its chain report that differed cannot be read.
      subversion = '/qbit:1.1.0/'
      version = 10100
      breakReport()
      const error = await rejection(rpc.confirmChain())
      expect(error).toMatchObject({ name: 'RpcChainGuardError', reason: 'mismatch', differs })
      expect(rpc.chainStatus).toBe('mismatch')
      expect(await rejection(rpc.walletLock())).toMatchObject({ reason: 'mismatch', differs })
      expect(rpc.nodeVersion).toMatchObject({ subversion: '/qbit:1.1.0/', supported: false })
      // A whole report that matches lifts it: then the version is what refuses.
      chain = 'regtest'
      info = undefined
      genesis = GENESIS['regtest']!
      await unsupported(rpc.confirmChain(), 'getblockchaininfo')
      expect(rpc.chainStatus).toBe('unsupported_version')
    }
  )

  it('names an unsupported version though its getblockchaininfo reply does not validate, as it may be why', async () => {
    subversion = '/qbit:1.1.0/'
    version = 10100
    // A later qbit Core that renamed a field.
    info = () => {
      const { future_block_time: _renamed, ...rest } = JSON.parse(blockchainInfoJson('regtest')) as Record<
        string,
        unknown
      >
      return JSON.stringify(rest)
    }
    const rpc = client()
    await unsupported(rpc.confirmChain(), 'getblockchaininfo')
    expect(rpc.chainStatus).toBe('unsupported_version')
    // Allowed, the reply is the failure.
    const allowed = client({ allowUnsupportedNodeVersion: true })
    const error = await rejection(allowed.confirmChain())
    expect(RpcResponseError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'getblockchaininfo', reason: 'validation', path: 'result.future_block_time' })
    expect(allowed.chainStatus).toBe('unconfirmed')
    expect(allowed.nodeVersion).toMatchObject({ version: 10100, supported: false })
  })

  it('names it on the re-check too, when the getblockchaininfo reply does not validate', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    subversion = '/qbit:1.1.0/'
    version = 10100
    info = () => '{}'
    await unsupported(rpc.walletLock(), 'walletlock')
    expect(methods()).toEqual([...CHECK, ...CHECK])
  })
})

describe('allowUnsupportedNodeVersion', () => {
  it('lets guarded calls go to an unsupported version, which nodeVersion still shows', async () => {
    subversion = '/qbit:1.1.0/'
    version = 10100
    const rpc = client({ allowUnsupportedNodeVersion: true })
    await rpc.confirmChain()
    expect(rpc.chainStatus).toBe('confirmed')
    expect(rpc.nodeVersion).toMatchObject({ version: 10100, minor: 1, supported: false })
    expect(rpc.toJSON()).toMatchObject({ chainStatus: 'confirmed', nodeVersion: { supported: false } })
    await rpc.walletLock()
    expect(methods()).toEqual([...CHECK, 'walletlock'])
    // The re-check before a guarded call lets it through too.
    const rechecking = client({ allowUnsupportedNodeVersion: true, chainCheckMaxAgeMs: 0 })
    await rechecking.confirmChain()
    await rechecking.sendRawTransaction(TX_HEX)
    expect(methods()).toEqual([...CHECK, 'walletlock', ...CHECK, ...CHECK, 'sendrawtransaction'])
  })

  it('defaults to false, and takes only a boolean', async () => {
    subversion = '/qbit:1.1.0/'
    version = 10100
    await unsupported(client().confirmChain(), 'getblockchaininfo')
    await unsupported(client({ allowUnsupportedNodeVersion: false }).confirmChain(), 'getblockchaininfo')
    for (const value of ['yes', 1, null, {}]) {
      expect(() => client({ allowUnsupportedNodeVersion: value as boolean })).toThrow(
        new TypeError('allowUnsupportedNodeVersion must be a boolean')
      )
    }
    const unset: Record<string, unknown> = { allowUnsupportedNodeVersion: undefined }
    expect(() => client(unset as Partial<QbitRpcClientOptions>)).not.toThrow()
  })
})

describe('a malformed node version', () => {
  const object = (fields: Record<string, unknown>): string =>
    JSON.stringify({ ...(JSON.parse(networkInfoJson()) as Record<string, unknown>), ...fields })
  const MALFORMED: [name: string, result: string, path: string][] = [
    ['a version as a string', object({ version: '10000' }), 'result.version'],
    ['a negative version', object({ version: -1 }), 'result.version'],
    ['a fractional version', object({ version: 10000.5 }), 'result.version'],
    ['a version past a C++ int', object({ version: 2 ** 31 }), 'result.version'],
    ['no version', object({ version: undefined }), 'result.version'],
    ['no subversion', object({ subversion: undefined }), 'result.subversion'],
    ['a subversion that is not a string', object({ subversion: 7 }), 'result.subversion'],
    ['a subversion without slashes', object({ subversion: 'qbit:1.0.0' }), 'result.subversion'],
    ['a subversion without its last slash', object({ subversion: '/qbit:1.0.0' }), 'result.subversion'],
    ['a two-part version', object({ subversion: '/qbit:1.0/' }), 'result.subversion'],
    ['a leading zero', object({ subversion: '/qbit:01.0.0/' }), 'result.subversion'],
    ['no name', object({ subversion: '/:1.0.0/' }), 'result.subversion'],
    ['two user agents', object({ subversion: '/qbit:1.0.0/Satoshi:27.0.0/' }), 'result.subversion'],
    ['a release candidate without a number', object({ subversion: '/qbit:1.0.0-rc/' }), 'result.subversion'],
    ['a phase after the release candidate', object({ subversion: '/qbit:1.0.0-rc1-beta/' }), 'result.subversion'],
    ['a subversion of another version', object({ subversion: '/qbit:1.0.1/' }), 'result.subversion'],
    ['a version the subversion does not show', object({ version: 10100 }), 'result.subversion'],
    ['parentheses inside a comment', object({ subversion: '/qbit:1.0.0(pool(eu))/' }), 'result.subversion'],
    ['a result that is not an object', '[]', 'result'],
  ]

  it.each(MALFORMED)(
    'fails confirmChain on %s, typed, whatever allowUnsupportedNodeVersion says, and records nothing',
    async (_name, result, path) => {
      network = result
      for (const allowUnsupportedNodeVersion of [false, true]) {
        const rpc = client({ allowUnsupportedNodeVersion })
        const error = await rejection(rpc.confirmChain())
        expect(RpcResponseError.is(error)).toBe(true)
        expect(error).toMatchObject({ method: 'getnetworkinfo', reason: 'validation', path })
        expect(rpc.chainStatus).toBe('unconfirmed')
        expect(rpc.nodeVersion).toBeUndefined()
      }
    }
  )

  it.each(MALFORMED)(
    'fails getNetworkInfo() on %s at the same path, as the chain check does',
    async (_name, result, path) => {
      network = result
      const error = await rejection(client().getNetworkInfo())
      expect(RpcResponseError.is(error)).toBe(true)
      expect(error).toMatchObject({ method: 'getnetworkinfo', reason: 'validation', path })
    }
  )

  it.each(MALFORMED)('refuses a guarded call as check_failed on %s, unsent', async (_name, result, path) => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    network = result
    const error = await rejection(rpc.sendRawTransaction(TX_HEX))
    expect(error).toMatchObject({ name: 'RpcChainGuardError', reason: 'check_failed', method: 'sendrawtransaction' })
    expect((error as Error).cause).toMatchObject({ name: 'RpcResponseError', method: 'getnetworkinfo', path })
    expect(methods()).not.toContain('sendrawtransaction')
    expect(rpc.chainStatus).toBe('stale')
    // The version the last valid check read is still shown.
    expect(rpc.nodeVersion).toEqual(V1_0_0)
  })

  it('fails the check on an error for getnetworkinfo, retrying -28 under readRetries', async () => {
    network = { code: -28, message: 'Loading block index…' }
    const error = await rejection(client().confirmChain())
    expect(RpcError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'getnetworkinfo', rpcCode: -28 })
    let warming = true
    const handler = node.handler
    node.handler = (request, response) => {
      network = warming ? { code: -28, message: 'Loading block index…' } : undefined
      warming = false
      return handler(request, response)
    }
    const rpc = client({ readRetries: 1, retryDelayMs: 0 })
    await rpc.confirmChain()
    expect(rpc.chainStatus).toBe('confirmed')
    expect(node.requests).toHaveLength(3)
    node.handler = handler
    network = { code: -32601, message: 'Method not found' }
    expect(await rejection(client().confirmChain())).toMatchObject({ method: 'getnetworkinfo', rpcCode: -32601 })
  })

  it('records a mismatch from another chain though the version is malformed', async () => {
    chain = 'main'
    network = object({ subversion: 'nonsense' })
    const error = await rejection(client().confirmChain())
    expect(error).toMatchObject({ name: 'RpcChainGuardError', reason: 'mismatch', differs: ['chain'] })
  })
})

describe('the chain guard’s invariants, with the version read', () => {
  it('reads the cookie once per attempt, and sends each check, version included, as one request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-version-'))
    try {
      const cookieFile = join(dir, '.cookie')
      await writeFile(cookieFile, '__cookie__:one')
      const rpc = client({ auth: { cookieFile }, chainCheckMaxAgeMs: 0 })
      vi.mocked(open).mockClear()
      await rpc.confirmChain()
      expect(vi.mocked(open)).toHaveBeenCalledTimes(1)
      await rpc.walletLock()
      expect(vi.mocked(open)).toHaveBeenCalledTimes(2)
      expect(node.requests).toHaveLength(3)
      for (const request of node.requests) expect(request.headers.authorization).toBe(basicAuth('__cookie__', 'one'))
      expect(methods()).toEqual([...CHECK, ...CHECK, 'walletlock'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('counts the check against the guarded call’s one deadline', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    holdChecks = true
    const started = performance.now()
    const error = await rejection(rpc.walletLock({ timeoutMs: 300 }))
    expect(performance.now() - started).toBeLessThan(700)
    expect(error).toMatchObject({ name: 'RpcChainGuardError', reason: 'check_failed', method: 'walletlock' })
    expect(RpcTimeoutError.is((error as Error).cause)).toBe(true)
    expect((error as Error).cause).toMatchObject({ method: 'getblockchaininfo', timeoutMs: 300 })
    expect(methods()).toEqual([...CHECK, ...CHECK])
  })

  it('refuses a guarded call when another check records an unsupported version while its re-check is out', async () => {
    const rpc = client({ chainCheckMaxAgeMs: 0 })
    await rpc.confirmChain()
    holdChecks = true
    const call = rejection(rpc.sendRawTransaction(TX_HEX))
    await expect.poll(() => held.length).toBe(1)
    const answerRecheck = held.shift()!
    holdChecks = false
    subversion = '/qbit:1.1.0/'
    version = 10100
    await unsupported(rpc.confirmChain(), 'getblockchaininfo')
    // The re-check went out before the upgrade and found 1.0.0; its answer arrives last.
    answerRecheck()
    const error = await call
    expect(error).toMatchObject({ name: 'RpcChainGuardError', reason: 'unsupported_version' })
    expect(methods()).not.toContain('sendrawtransaction')
    expect(rpc.chainStatus).toBe('unsupported_version')
    // nodeVersion is the newest check's: the late answer, sent earlier, does not roll it back.
    expect(rpc.nodeVersion).toMatchObject({ version: 10100 })
  })

  it('makes a confirmChain in flight throw an unsupported version another check records', async () => {
    const rpc = client()
    holdChecks = true
    const confirming = rejection(rpc.confirmChain())
    await expect.poll(() => held.length).toBe(1)
    const answer = held.shift()!
    holdChecks = false
    subversion = '/qbit:2.0.0/'
    version = 20000
    await unsupported(rpc.confirmChain(), 'getblockchaininfo')
    answer()
    expect(await confirming).toMatchObject({ name: 'RpcChainGuardError', reason: 'unsupported_version' })
    expect(rpc.chainStatus).toBe('unsupported_version')
  })

  it('shows the version of the newest check sent, not of the last answered', async () => {
    const rpc = client({ allowUnsupportedNodeVersion: true })
    holdChecks = true
    const first = rpc.confirmChain()
    await expect.poll(() => held.length).toBe(1)
    holdChecks = false
    subversion = '/qbit:1.1.0/'
    version = 10100
    await rpc.confirmChain()
    expect(rpc.nodeVersion).toMatchObject({ version: 10100 })
    held.shift()!()
    await first
    expect(rpc.nodeVersion).toMatchObject({ version: 10100 })
  })

  it('does not let a confirmChain begun before an unsupported version was recorded lift it', async () => {
    const rpc = client()
    await rpc.confirmChain()
    holdChecks = true
    const early = rejection(rpc.confirmChain())
    await expect.poll(() => held.length).toBe(1)
    const answerEarly = held.shift()!
    holdChecks = false
    subversion = '/qbit:1.1.0/'
    version = 10100
    await unsupported(rpc.confirmChain(), 'getblockchaininfo')
    // Its own check found 1.0.0, but its answer may predate the upgrade.
    answerEarly()
    expect(await early).toMatchObject({ name: 'RpcChainGuardError', reason: 'unsupported_version' })
    expect(rpc.chainStatus).toBe('unsupported_version')
  })
})

describe('values a later qbit Core may add', () => {
  const confirmationTarget = (hashrateSource: unknown): string =>
    JSON.stringify({
      required_confirmations: 12,
      required_minutes: 12,
      equivalent_btc_confirmations: 6.2,
      permissionless_hashrate: 1.5e12,
      auxpow_hashrate: 0,
      total_observed_hashrate: 1.5e12,
      orphan_rate: 0.01,
      security_level: 'high',
      model: {
        btc_target_confirmations: 6,
        block_time_seconds: 60,
        hashrate_source: hashrateSource,
        hashrate_window_blocks: 120,
        permissionless_blocks_in_window: 120,
        auxpow_blocks_in_window: 0,
        merge_mining_pct: 0,
        btc_hashrate: 6e20,
        orphan_rate_penalty: 1.02,
        security_per_confirmation: 0.5,
        cadence_merged_fraction: 0.5,
      },
    })
  const walletInfo = (fields: Record<string, unknown> = {}, status: unknown = 'complete'): string =>
    JSON.stringify({
      walletname: 'w',
      walletversion: 169900,
      format: 'sqlite',
      txcount: 3,
      keypoolsize: 1000,
      private_keys_enabled: true,
      avoid_reuse: false,
      scanning: false,
      descriptors: true,
      pqc_key_validation: {
        status,
        progress: 1,
        plaintext_records: 0,
        pending_records: 0,
        validated_records: 0,
        failed_records: 0,
        signing_blocked: false,
        encryption_recommended: false,
      },
      external_signer: false,
      blank: false,
      flags: [],
      lastprocessedblock: { hash: HASH_A, height: 10 },
      ...fields,
    })
  const processed = (state: unknown): string =>
    JSON.stringify({
      psbt: 'cHNidP8=',
      complete: true,
      hex: '00',
      pqc_key_states: [
        {
          pubkey: HASH_A,
          pqc_signature_count: 1073741824,
          pqc_signature_limit: 1073741824,
          pqc_signatures_remaining: 0,
          pqc_limit_state: state,
        },
      ],
      pqc_overall_limit_state: state,
      pqc_signature_count: 1073741824,
      pqc_signature_limit: 1073741824,
      pqc_signatures_remaining: 0,
      pqc_limit_state: state,
      warnings: [],
    })
  const transaction = (fields: Record<string, unknown>, category: unknown = 'receive'): string =>
    JSON.stringify({
      amount: 0,
      confirmations: 2,
      blockhash: HASH_B,
      blockheight: 9,
      blockindex: 1,
      blocktime: 1700000000,
      txid: HASH_A,
      wtxid: HASH_A,
      walletconflicts: [],
      mempoolconflicts: [],
      time: 1700000000,
      timereceived: 1700000000,
      'bip125-replaceable': 'no',
      details: [{ address: 'rq1a', category, amount: 0, label: '', vout: 0, abandoned: false }],
      hex: '00',
      lastprocessedblock: { hash: HASH_B, height: 10 },
      ...fields,
    })

  async function invalid(promise: Promise<unknown>, path: string): Promise<void> {
    const error = await rejection(promise)
    expect(RpcResponseError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'validation', path })
  }

  it('passes an unknown chain name through, which the guard records as a mismatch', async () => {
    chain = 'testnet5'
    genesis = HASH_B
    const rpc = client()
    expect((await rpc.getBlockchainInfo()).chain).toBe('testnet5')
    const error = await rejection(rpc.confirmChain())
    expect(error).toMatchObject({
      name: 'RpcChainGuardError',
      reason: 'mismatch',
      actualChain: 'testnet5',
      differs: ['chain', 'genesis_hash'],
    })
    chain = ''
    await invalid(rpc.getBlockchainInfo(), 'result.chain')
  })

  it('passes an unknown hashrate source through, and fails an empty one', async () => {
    node.results({ getconfirmationtarget: confirmationTarget('observed_chainwork_v2') })
    const rpc = client()
    expect((await rpc.getConfirmationTarget(1n, { securityLevel: 'high' })).model.hashrateSource).toBe(
      'observed_chainwork_v2'
    )
    node.results({ getconfirmationtarget: confirmationTarget('') })
    await invalid(rpc.getConfirmationTarget(1n, { securityLevel: 'high' }), 'result.model.hashrate_source')
  })

  it('passes an unknown PQC key-validation status through, and fails a non-string one', async () => {
    node.results({ getwalletinfo: walletInfo({}, 'suspended') })
    const rpc = client()
    expect((await rpc.getWalletInfo()).pqcKeyValidation).toMatchObject({ status: 'suspended', signingBlocked: false })
    node.results({ getwalletinfo: walletInfo({}, null) })
    await invalid(rpc.getWalletInfo(), 'result.pqc_key_validation.status')
  })

  it('never drops or coerces an unknown PQC limit state, in any of the three fields', async () => {
    const rpc = client()
    await rpc.confirmChain()
    node.results({ walletprocesspsbt: processed('depleted') })
    expect(await rpc.walletProcessPsbt('cHNidP8=', { pqcCheck: false })).toMatchObject({
      pqcOverallLimitState: 'depleted',
      pqcLimitState: 'depleted',
      pqcKeyStates: [{ pubkey: HASH_A, pqcLimitState: 'depleted' }],
    })
    // A state that is not a string still fails; after signing that is an unknown outcome.
    node.results({ walletprocesspsbt: processed(3) })
    const error = await rejection(rpc.walletProcessPsbt('cHNidP8=', { pqcCheck: false }))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect((error as Error).cause).toMatchObject({
      reason: 'validation',
      path: 'result.pqc_key_states[0].pqc_limit_state',
    })
  })

  it('keeps paytxfee optional, as Bitcoin Core has deprecated it', async () => {
    const rpc = client()
    node.results({ getwalletinfo: walletInfo() })
    expect(await rpc.getWalletInfo()).not.toHaveProperty('payTxFeeBitsPerKvB')
    node.results({ getwalletinfo: walletInfo({ paytxfee: 0.0001 }) })
    expect((await rpc.getWalletInfo()).payTxFeeBitsPerKvB).toBe(10_000n)
    node.results({ getwalletinfo: walletInfo({ paytxfee: null }) })
    await invalid(rpc.getWalletInfo(), 'result.paytxfee')
  })

  it('fails an unknown transaction category, BIP 125 answer or security level: they stay closed', async () => {
    const rpc = client()
    node.results({ gettransaction: transaction({}, 'burn') })
    await invalid(rpc.getTransaction(HASH_A), 'result.details[0].category')
    node.results({ gettransaction: transaction({ 'bip125-replaceable': 'maybe' }) })
    await invalid(rpc.getTransaction(HASH_A), 'result.bip125-replaceable')
    node.results({ getconfirmationtarget: confirmationTarget('observed_chainwork').replace('"high"', '"extreme"') })
    await invalid(rpc.getConfirmationTarget(1n, { securityLevel: 'high' }), 'result.security_level')
  })
})
