import type { ServerResponse } from 'node:http'
import { inspect } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { METHOD_POLICIES } from '../src/capabilities'
import { belowClass, HIDDEN_METHOD_CLASSES, METHOD_CLASSES } from '../src/method-classes'
import {
  JsonNumber,
  QbitRpcClient,
  requests,
  RpcCapabilityError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcTimeoutError,
  RpcTransportError,
  RpcUnknownOutcomeError,
  type Capability,
  type ExtraMethodPolicy,
  type QbitRpcClientOptions,
} from '../src'
import {
  CHECK,
  chainResults,
  FakeNode,
  networkInfoJson,
  type Handler,
  type RecordedRequest,
  type RpcCall,
} from './helpers/fake-node'

type ExtraMethods = NonNullable<QbitRpcClientOptions['extraMethods']>

const READ = { capability: 'read', sideEffects: false } as const
const WALLET_READ = { capability: 'wallet-read', sideEffects: false } as const
const WALLET_WRITE = { capability: 'wallet-write', sideEffects: true } as const
const BROADCAST = { capability: 'broadcast', sideEffects: true } as const
const MINING = { capability: 'mining', sideEffects: true } as const
const WALLET_ADMIN = { capability: 'wallet-admin', sideEffects: true } as const
const NODE_ADMIN = { capability: 'node-admin', sideEffects: true } as const
const ALL: Capability[] = ['wallet-read', 'wallet-write', 'broadcast', 'mining', 'wallet-admin', 'node-admin']
const SIGN_AND_BROADCAST = ['sendmany', 'sendtoaddress', 'send', 'sendall', 'bumpfee']
const RESULTS: Record<string, string> = {
  ...chainResults('regtest'),
  getchaintxstats: '{"txcount":18446744073709551616,"window_block_count":10}',
  getbalance: '0.5',
  getblockcount: '7',
  setlabel: 'null',
  utxoupdatepsbt: '"cHNidP8="',
  prioritisetransaction: '{"package_msg":"success"}',
  // A method help does not list, as a later release's broadcast method would be: it keeps the policy given.
  futurebroadcast: 'null',
  submitheader: 'null',
  abortrescan: 'true',
  setban: 'null',
  ping: 'null',
  stop: '"qbit server stopping"',
  futurenodemethod: '"ok"',
}

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
  node.results(RESULTS)
})
afterEach(async () => {
  await node.close()
})

function client(extraMethods: unknown, options: Partial<QbitRpcClientOptions> = {}): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'user', password: 'pass' },
    expectedChain: 'regtest',
    ...options,
    extraMethods: extraMethods as ExtraMethods,
  })
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e
  )
}

async function refusal(promise: Promise<unknown>): Promise<RpcCapabilityError> {
  const error = await failure(promise)
  expect(RpcCapabilityError.is(error)).toBe(true)
  return error as RpcCapabilityError
}

/** Requests other than chain checks (and batches), which the client sends as one JSON-RPC call each. */
function singles(): RecordedRequest[] {
  return node.requests.filter(request => !request.body.startsWith('['))
}

/** Answer chain checks and batches from RESULTS, and every single call with `fail`. */
function failSingles(fail: Handler): void {
  node.results(RESULTS)
  const answer = node.handler
  node.handler = (request, response) =>
    request.body.startsWith('[') ? answer(request, response) : fail(request, response)
}

describe('extraMethods at construction', () => {
  it('refuses a malformed option or entry with a TypeError naming it, before sending anything', () => {
    const cases: [unknown, Capability[], RegExp][] = [
      ['getchaintxstats', [], /^extraMethods must be a plain object/],
      [['getchaintxstats'], [], /^extraMethods must be a plain object/],
      [null, [], /^extraMethods must be a plain object/],
      // A Map, a class instance or an object with a prototype has no own entries to read: it would open nothing.
      [new Map([['getchaintxstats', READ]]), [], /^extraMethods must be a plain object/],
      [new (class Methods {})(), [], /^extraMethods must be a plain object/],
      [Object.create({ getchaintxstats: READ }), [], /^extraMethods must be a plain object/],
      [{ getchaintxstats: new Map(Object.entries(READ)) }, [], /^extraMethods\.getchaintxstats must be a plain object/],
      [
        { getchaintxstats: Object.assign(new (class Policy {})(), READ) },
        [],
        /^extraMethods\.getchaintxstats must be a plain object/,
      ],
      [{ '': READ }, [], /^extraMethods key "" is not a method name/],
      [{ GetChainTxStats: READ }, [], /^extraMethods key "GetChainTxStats" is not a method name/],
      [{ get_chain_tx_stats: READ }, [], /"get_chain_tx_stats" is not a method name/],
      [{ '2getchaintxstats': READ }, [], /"2getchaintxstats" is not a method name/],
      [{ 'getchaintxstats ': READ }, [], /"getchaintxstats " is not a method name/],
      [{ [`a${'b'.repeat(64)}`]: READ }, [], /is not a method name: .* at most 64$/],
      [JSON.parse('{"__proto__":{"capability":"read","sideEffects":false}}'), [], /"__proto__" is not a method name/],
      [
        { getchaintxstats: undefined },
        [],
        /^extraMethods\.getchaintxstats must be a plain object, \{ capability, sideEffects \}$/,
      ],
      [
        { getchaintxstats: 'read' },
        [],
        /^extraMethods\.getchaintxstats must be a plain object, \{ capability, sideEffects \}$/,
      ],
      [
        { getchaintxstats: [READ] },
        [],
        /^extraMethods\.getchaintxstats must be a plain object, \{ capability, sideEffects \}$/,
      ],
      [
        { getchaintxstats: { ...READ, timeoutMs: 60_000 } },
        [],
        /^extraMethods\.getchaintxstats\.timeoutMs is not a known key; the known keys are capability, sideEffects$/,
      ],
      [{ getchaintxstats: { capability: 'read', sideEffect: false } }, [], /\.sideEffect is not a known key/],
      [
        { getchaintxstats: { sideEffects: false } },
        [],
        /^extraMethods\.getchaintxstats\.capability must be one of read, wallet-read, wallet-write, broadcast, mining, wallet-admin, node-admin$/,
      ],
      [{ getchaintxstats: { capability: 'admin', sideEffects: false } }, ALL, /\.capability must be one of/],
      [{ getchaintxstats: { capability: 'pool', sideEffects: false } }, ALL, /\.capability must be one of/],
      [{ getchaintxstats: { capability: 'READ', sideEffects: false } }, ALL, /\.capability must be one of/],
      [
        { getchaintxstats: { capability: 'read' } },
        [],
        /^extraMethods\.getchaintxstats\.sideEffects must be true or false, .*: it has no default$/,
      ],
      [{ getchaintxstats: { capability: 'read', sideEffects: undefined } }, [], /\.sideEffects must be true or false/],
      [{ getchaintxstats: { capability: 'read', sideEffects: 'false' } }, [], /\.sideEffects must be true or false/],
      [{ getchaintxstats: { capability: 'read', sideEffects: 0 } }, [], /\.sideEffects must be true or false/],
      // Methods neither table holds, as a later release's.
      [
        { futurenodemethod: { capability: 'read', sideEffects: true } },
        ALL,
        /^extraMethods\.futurenodemethod: a method with side effects needs the wallet-write, broadcast, mining or wallet-admin capability, which puts it behind the chain guard, or node-admin to administer the node$/,
      ],
      [
        { futureminingmethod: { capability: 'wallet-read', sideEffects: true } },
        ALL,
        /needs the wallet-write, broadcast, mining or wallet-admin/,
      ],
      // Hidden ones are classed as the listed ones are.
      [
        { invalidateblock: { capability: 'read', sideEffects: false } },
        ALL,
        /^extraMethods\.invalidateblock: qbit Core v1\.0\.0's invalidateblock changes what the node stores, follows or connects to, or stops it, so it needs \{ capability: 'node-admin', sideEffects: true \}$/,
      ],
      [{ setmocktime: { capability: 'broadcast', sideEffects: true } }, ALL, /so it needs \{ capability: 'node-admin'/],
      [
        { generatetoaddress: { capability: 'read', sideEffects: false } },
        ALL,
        /^extraMethods\.generatetoaddress: qbit Core v1\.0\.0's generatetoaddress builds or submits blocks/,
      ],
      // One help lists: its class decides first.
      [
        { submitheader: { capability: 'read', sideEffects: true } },
        ALL,
        /^extraMethods\.submitheader: qbit Core v1\.0\.0's submitheader .* so it needs \{ capability: 'mining', sideEffects: true \}$/,
      ],
      [{ setlabel: { capability: 'wallet-read', sideEffects: true } }, ALL, /needs \{ capability: 'wallet-write'/],
      [
        { getbalance: WALLET_READ },
        [],
        /^extraMethods\.getbalance needs the 'wallet-read' capability, which this client does not enable$/,
      ],
      [{ setlabel: WALLET_WRITE }, ['wallet-read', 'broadcast'], /needs the 'wallet-write' capability/],
      [{ futurebroadcast: BROADCAST }, ['wallet-read', 'wallet-write'], /needs the 'broadcast' capability/],
      [{ submitheader: MINING }, ['wallet-read', 'broadcast'], /needs the 'mining' capability/],
      [{ abortrescan: WALLET_ADMIN }, ['wallet-write'], /needs the 'wallet-admin' capability/],
      // One bad entry fails the whole option.
      [
        { getchaintxstats: READ, getblockstats: { capability: 'read' } },
        [],
        /extraMethods\.getblockstats\.sideEffects/,
      ],
    ]
    for (const [extra, capabilities, message] of cases) {
      const make = (): QbitRpcClient => client(extra, { capabilities })
      expect(make).toThrow(TypeError)
      expect(make).toThrow(message)
    }
    // The type requires both, from the known capabilities.
    const typed = (extraMethods: ExtraMethods): QbitRpcClient => client(extraMethods)
    // @ts-expect-error: sideEffects has no default.
    expect(() => typed({ getchaintxstats: { capability: 'read' } })).toThrow(TypeError)
    // @ts-expect-error: not a capability.
    expect(() => typed({ getchaintxstats: { capability: 'admin', sideEffects: false } })).toThrow(TypeError)
    expect(node.requests).toHaveLength(0)
  })

  it('refuses another policy for an allowlisted method, so it cannot be redefined or weakened', () => {
    for (const [name, entry, builtIn] of [
      // Unlocking as a read would be retried, sent on a pooled connection, and never an unknown outcome.
      ['walletpassphrase', { capability: 'wallet-write', sideEffects: false }, "'wallet-write', sideEffects: true"],
      ['sendrawtransaction', READ, "'broadcast', sideEffects: true"],
      ['psbtbumpfee', WALLET_READ, "'wallet-write', sideEffects: true"],
      ['testmempoolaccept', WALLET_WRITE, "'broadcast', sideEffects: false"],
      // Under another capability a block would pass neither the mining gate nor an operator's review of it.
      ['submitblock', BROADCAST, "'mining', sideEffects: true"],
      ['createauxblock', READ, "'mining', sideEffects: true"],
      ['submitauxblock', WALLET_WRITE, "'mining', sideEffects: true"],
      ['getblocktemplate', READ, "'mining', sideEffects: false"],
      ['getmininginfo', MINING, "'read', sideEffects: false"],
      // A service that opened keypoolrefill before wallet-admin existed must drop the entry and enable wallet-admin.
      ['keypoolrefill', WALLET_WRITE, "'wallet-admin', sideEffects: true"],
      ['listwalletdir', WALLET_READ, "'wallet-admin', sideEffects: false"],
      ['signdatapqchash', WALLET_ADMIN, "'wallet-write', sideEffects: true"],
      ['getdescriptorinfo', WALLET_READ, "'read', sideEffects: false"],
    ] as const) {
      expect(() => client({ [name]: entry }, { capabilities: ALL })).toThrow(
        `extraMethods.${name}: ${name} is allowlisted already as { capability: ${builtIn} }, which extraMethods cannot change`
      )
    }
    for (const [name, policy] of Object.entries(METHOD_POLICIES)) {
      const other = policy.sideEffects ? READ : WALLET_WRITE
      expect(() => client({ [name]: other }, { capabilities: ALL })).toThrow(/is allowlisted already as/)
    }
  })

  it('accepts an allowlisted method restated with its own policy, which then applies unchanged', () => {
    for (const [name, policy] of Object.entries(METHOD_POLICIES)) {
      const rpc = client(
        { [name]: { capability: policy.capability, sideEffects: policy.sideEffects } },
        { capabilities: ALL }
      )
      // Only methods it opens are listed: a restated one is the built-in.
      expect(JSON.parse(JSON.stringify(rpc))).not.toHaveProperty('extraMethods')
    }
  })

  it('refuses the methods that sign and broadcast in one step, saying why', async () => {
    for (const name of SIGN_AND_BROADCAST) {
      for (const entry of [WALLET_WRITE, BROADCAST, READ]) {
        const make = (): QbitRpcClient => client({ [name]: entry }, { capabilities: ALL })
        expect(make).toThrow(TypeError)
        expect(make).toThrow(
          `extraMethods.${name}: ${name} signs and broadcasts in one step, so the signed transaction cannot be stored before it leaves the node`
        )
      }
      expect((await refusal(client(undefined, { capabilities: ALL }).call(name))).reason).toBe('unknown_method')
    }
    expect(node.requests).toHaveLength(0)
  })

  it('reads only the option’s own keys, once: prototypes and later changes open nothing', async () => {
    // An option with a prototype of its own is refused, so a method on it is not opened.
    expect(() => client(Object.create({ getchaintxstats: READ }))).toThrow('extraMethods must be a plain object')
    // One without a prototype is a plain object.
    const bare = Object.assign(Object.create(null) as object, { getchaintxstats: READ })
    expect(client(bare).toJSON()['extraMethods']).toEqual({ getchaintxstats: READ })
    // Nor does a polluted Object.prototype supply a missing capability or sideEffects: it is refused.
    const proto = Object.prototype as Record<string, unknown>
    try {
      proto['sideEffects'] = false
      proto['capability'] = 'read'
      expect(() => client({ getchaintxstats: { capability: 'read' } })).toThrow(
        /^extraMethods\.getchaintxstats\.sideEffects is not an own enumerable property .*pass a plain object$/
      )
      expect(() => client({ getchaintxstats: { sideEffects: false } })).toThrow(
        /^extraMethods\.getchaintxstats\.capability is not an own enumerable property /
      )
    } finally {
      delete proto['sideEffects']
      delete proto['capability']
    }
    // Changing the option's objects after construction changes nothing.
    const entry: { capability: string; sideEffects: boolean } = { capability: 'read', sideEffects: false }
    const extra: Record<string, unknown> = { getchaintxstats: entry }
    const rpc = client(extra)
    entry.capability = 'wallet-write'
    entry.sideEffects = true
    extra['getblockstats'] = READ
    expect(rpc.toJSON()['extraMethods']).toEqual({ getchaintxstats: READ })
    expect(await rpc.call('getchaintxstats')).toBeDefined()
    expect((await refusal(rpc.call('getblockstats'))).reason).toBe('unknown_method')
  })

  it('shows the opened methods and their policies in toJSON() and util.inspect, and nothing when none', () => {
    const rpc = client(
      { getchaintxstats: READ, getbalance: WALLET_READ, setlabel: WALLET_WRITE },
      { capabilities: ['wallet-read', 'wallet-write'] }
    )
    const extraMethods = { getchaintxstats: READ, getbalance: WALLET_READ, setlabel: WALLET_WRITE }
    expect(rpc.toJSON()).toMatchObject({ capabilities: ['wallet-read', 'wallet-write'], extraMethods })
    expect(JSON.parse(JSON.stringify(rpc))).toMatchObject({ extraMethods })
    expect(inspect(rpc)).toContain("setlabel: { capability: 'wallet-write', sideEffects: true }")
    expect(client(undefined).toJSON()).not.toHaveProperty('extraMethods')
    expect(client({}).toJSON()).not.toHaveProperty('extraMethods')
  })

  // The batch rule and the chain guard rely on it: only wallet-write, broadcast, mining and wallet-admin change state.
  it('keeps every allowlisted method with side effects behind the chain guard, as extraMethods must', () => {
    for (const [name, policy] of Object.entries(METHOD_POLICIES)) {
      expect(name).toMatch(/^[a-z][a-z0-9]{0,63}$/)
      if (policy.sideEffects)
        expect(['wallet-write', 'broadcast', 'mining', 'wallet-admin']).toContain(policy.capability)
      // node-admin allowlists nothing: its methods are opened with extraMethods only.
      expect(policy.capability, name).not.toBe('node-admin')
    }
  })
})

describe('extraMethods against what each method does', () => {
  it('refuses a policy below what qbit Core does, naming the method and the class it needs', async () => {
    const cases: [string, ExtraMethodPolicy, string][] = [
      // A wallet encrypted by a read-only client, retried and batched, never an unknown outcome.
      [
        'encryptwallet',
        READ,
        "qbit Core v1.0.0's encryptwallet administers a wallet or returns its private keys, so it needs { capability: 'wallet-admin', sideEffects: true }",
      ],
      [
        'signrawtransactionwithwallet',
        READ,
        "qbit Core v1.0.0's signrawtransactionwithwallet signs with a wallet's keys or changes the wallet, so it needs { capability: 'wallet-write', sideEffects: true }",
      ],
      // The wallet capability, without side effects: retried, and a lost reply a definite failure.
      ['signrawtransactionwithwallet', { capability: 'wallet-write', sideEffects: false }, 'sideEffects: true }'],
      ['signrawtransactionwithwallet', WALLET_READ, "needs { capability: 'wallet-write', sideEffects: true }"],
      // A wallet read needs a wallet capability.
      [
        'getbalance',
        READ,
        "qbit Core v1.0.0's getbalance reads a wallet, so it needs a wallet capability (wallet-read, wallet-write, wallet-admin)",
      ],
      // The node's own state, as a read a read-only service could call.
      [
        'stop',
        READ,
        "qbit Core v1.0.0's stop changes what the node stores, follows or connects to, or stops it, so it needs { capability: 'node-admin', sideEffects: true }",
      ],
      ['setban', READ, "needs { capability: 'node-admin', sideEffects: true }"],
      // A mining method needs mining.
      ['submitheader', READ, "needs { capability: 'mining', sideEffects: true }"],
      ['prioritisetransaction', BROADCAST, "needs { capability: 'mining', sideEffects: true }"],
      // Its own kind, not another with side effects.
      ['abortrescan', BROADCAST, "needs { capability: 'wallet-admin', sideEffects: true }"],
      ['restorewallet', WALLET_WRITE, "needs { capability: 'wallet-admin', sideEffects: true }"],
      ['setban', WALLET_WRITE, "needs { capability: 'node-admin', sideEffects: true }"],
      // Broadcasting is not administering the node.
      ['stop', BROADCAST, "needs { capability: 'node-admin', sideEffects: true }"],
      ['setban', BROADCAST, "needs { capability: 'node-admin', sideEffects: true }"],
      // ping queues a ping on every peer: side effects.
      [
        'ping',
        { capability: 'node-admin', sideEffects: false },
        "needs { capability: 'node-admin', sideEffects: true }",
      ],
      // Node administration does not stand in for another kind, wallet administration included.
      ['submitheader', NODE_ADMIN, "needs { capability: 'mining', sideEffects: true }"],
      ['abortrescan', NODE_ADMIN, "needs { capability: 'wallet-admin', sideEffects: true }"],
      ['getbalance', NODE_ADMIN, 'needs a wallet capability'],
      ['getbalance', BROADCAST, 'needs a wallet capability'],
      // A key export is a backup, not a wallet read.
      [
        'listdescriptors',
        WALLET_READ,
        "administers a wallet or returns its private keys, so it needs { capability: 'wallet-admin'",
      ],
      ['fundrawtransaction', WALLET_READ, "needs { capability: 'wallet-write', sideEffects: true }"],
    ]
    for (const [name, entry, message] of cases) {
      const make = (): QbitRpcClient => client({ [name]: entry }, { capabilities: ALL })
      expect(make, name).toThrow(TypeError)
      expect(make, name).toThrow(new RegExp(`^extraMethods\\.${name}: qbit Core v1\\.0\\.0's ${name} `))
      expect(make, name).toThrow(message)
    }
    expect(node.requests).toHaveLength(0)
  })

  it('accepts a policy at or above what the method does', async () => {
    const rpc = client(
      {
        signrawtransactionwithwallet: WALLET_WRITE,
        encryptwallet: { capability: 'wallet-admin', sideEffects: true },
        getbalance: WALLET_READ,
        getreceivedbyaddress: { capability: 'wallet-write', sideEffects: false },
        listlabels: { capability: 'wallet-write', sideEffects: true },
        stop: NODE_ADMIN,
        prioritisetransaction: MINING,
        getchaintxstats: READ,
        getblockstats: WALLET_READ,
        decodescript: BROADCAST,
        listdescriptors: { capability: 'wallet-admin', sideEffects: false },
      },
      { capabilities: ALL }
    )
    expect(Object.keys(rpc.toJSON()['extraMethods'] as object)).toHaveLength(11)
    expect(await rpc.call('getbalance')).toBeDefined()
  })

  it("takes the caller's policy for a method neither table holds, and classes the hidden ones", async () => {
    // A method a later release adds: the package cannot tell what it does.
    const rpc = client({ futuremethod: READ, echo: READ, getrawaddrman: READ })
    expect(rpc.toJSON()['extraMethods']).toEqual({ futuremethod: READ, echo: READ, getrawaddrman: READ })
    node.results({ ...RESULTS, futuremethod: 'null' })
    expect(await rpc.call('futuremethod', ['00'.repeat(32)])).toBeNull()
    // qbit Core v1.0.0's hidden methods that change the node are not reads.
    for (const name of ['invalidateblock', 'reconsiderblock', 'setmocktime', 'addconnection', 'sendmsgtopeer']) {
      expect(() => client({ [name]: READ }), name).toThrow(
        `so it needs { capability: 'node-admin', sideEffects: true }`
      )
    }
    for (const name of ['generate', 'generateblock', 'generatetoaddress', 'generatetodescriptor']) {
      expect(() => client({ [name]: READ }), name).toThrow('builds or submits blocks')
    }
  })

  it('checks a restated allowlisted method against the capabilities the client enables, like any entry', () => {
    // Restated exactly, but under a capability the client lacks: every call would be refused.
    expect(() => client({ getbalances: WALLET_READ })).toThrow(
      "extraMethods.getbalances needs the 'wallet-read' capability, which this client does not enable"
    )
    expect(() => client({ sendrawtransaction: BROADCAST }, { capabilities: ['wallet-read'] })).toThrow(
      "extraMethods.sendrawtransaction needs the 'broadcast' capability"
    )
    expect(() => client({ getbalances: WALLET_READ }, { capabilities: ['wallet-read'] })).not.toThrow()
  })

  it('lists every allowlisted method in the table, and never below what the method does', () => {
    for (const [name, policy] of Object.entries(METHOD_POLICIES)) {
      expect(Object.hasOwn(METHOD_CLASSES, name), name).toBe(true)
      expect(belowClass(name, policy), name).toBeUndefined()
    }
    expect(Object.keys(METHOD_CLASSES)).toHaveLength(161)
    for (const name of Object.keys(METHOD_CLASSES)) expect(name).toMatch(/^[a-z][a-z0-9]{0,63}$/)
    // The hidden ones: none in help's table, nor allowlisted.
    expect(Object.keys(HIDDEN_METHOD_CLASSES)).toHaveLength(18)
    for (const name of Object.keys(HIDDEN_METHOD_CLASSES)) {
      expect(name).toMatch(/^[a-z][a-z0-9]{0,63}$/)
      expect(Object.hasOwn(METHOD_CLASSES, name), name).toBe(false)
      expect(Object.hasOwn(METHOD_POLICIES, name), name).toBe(false)
    }
  })
})

describe('extraMethods calls', () => {
  it('opens a wallet-admin method as an allowlisted one: behind the capability and the chain guard, never retried', async () => {
    const rpc = client(
      { abortrescan: WALLET_ADMIN },
      { capabilities: ['wallet-admin'], readRetries: 3, retryDelayMs: 0 }
    )
    expect((await refusal(client({}, { capabilities: ['wallet-write'] }).call('abortrescan'))).reason).toBe(
      'unknown_method'
    )
    expect(await failure(rpc.call('abortrescan'))).toMatchObject({ reason: 'unconfirmed' })
    expect(node.requests).toHaveLength(0)
    await rpc.confirmChain()
    expect(await rpc.call('abortrescan')).toBe(true)
    node.handler = (request, response) => (/abortrescan/.test(request.body) ? response.destroy() : response.end('[]'))
    const error = await failure(rpc.call('abortrescan'))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(node.calls().filter(call => call.method === 'abortrescan')).toHaveLength(2)
  })

  it('opens a mining method as an allowlisted one: behind the capability and the chain guard, never retried', async () => {
    const rpc = client({ submitheader: MINING }, { capabilities: ['mining'], readRetries: 3, retryDelayMs: 0 })
    expect(await failure(rpc.call('submitheader', ['00']))).toMatchObject({ reason: 'unconfirmed' })
    expect(node.requests).toHaveLength(0)
    await rpc.confirmChain()
    expect(await rpc.call('submitheader', ['00'])).toBeNull()
    node.handler = (request, response) => (/submitheader/.test(request.body) ? response.destroy() : response.end('[]'))
    const error = await failure(rpc.call('submitheader', ['00']))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(node.calls().filter(call => call.method === 'submitheader')).toHaveLength(2)
  })

  it('sends an extra read as an allowlisted read: no capability, a pooled connection, retries, unvalidated', async () => {
    const rpc = client({ getchaintxstats: READ }, { readRetries: 1, retryDelayMs: 0 })
    const stats = (await rpc.call('getchaintxstats', [10])) as { txcount: JsonNumber }
    expect(stats.txcount).toBeInstanceOf(JsonNumber)
    expect(stats.txcount.toBigInt()).toBe(2n ** 64n)
    await rpc.call('getchaintxstats')
    const [first, second] = node.requests
    expect(first!.remotePort).toBe(second!.remotePort)
    expect(node.calls()).toMatchObject([
      { method: 'getchaintxstats', params: [10] },
      { method: 'getchaintxstats', params: [] },
    ])
    // An HTTP 500 is retried under readRetries.
    let failed = 0
    failSingles((request, response) => {
      if (failed++ === 0) {
        response.statusCode = 500
        response.end()
      } else {
        node.results(RESULTS)
        void node.handler(request, response)
      }
    })
    expect(await rpc.call('getchaintxstats')).toBeDefined()
    expect(failed).toBe(2)
    // Opened for this client only.
    expect((await refusal(client(undefined).call('getchaintxstats'))).reason).toBe('unknown_method')
  })

  it('needs wallet-read for an extra wallet-read method, which no chain check precedes', async () => {
    const rpc = client({ getbalance: WALLET_READ }, { capabilities: ['wallet-read'] })
    expect(((await rpc.call('getbalance')) as JsonNumber).toBits()).toBe(50_000_000n)
    expect(node.calls().map(call => call.method)).toEqual(['getbalance'])
  })

  it('puts extra wallet-write and broadcast methods behind the chain guard', async () => {
    const rpc = client(
      {
        setlabel: WALLET_WRITE,
        utxoupdatepsbt: { capability: 'wallet-write', sideEffects: false },
        futurebroadcast: BROADCAST,
      },
      { capabilities: ['wallet-write', 'broadcast'], chainCheckMaxAgeMs: 0 }
    )
    for (const method of ['setlabel', 'utxoupdatepsbt', 'futurebroadcast']) {
      const error = await failure(rpc.call(method))
      expect(RpcChainGuardError.is(error)).toBe(true)
      expect(error).toMatchObject({ reason: 'unconfirmed', method })
    }
    expect(node.requests).toHaveLength(0)

    await rpc.confirmChain()
    // chainCheckMaxAgeMs 0: each call checks the chain again first.
    await rpc.call('setlabel', ['qbrt1zaddress', 'deposits'])
    await rpc.call('futurebroadcast')
    await rpc.call('utxoupdatepsbt', ['cHNidP8='])
    expect(node.calls().map(call => call.method)).toEqual([
      ...CHECK,
      ...CHECK,
      'setlabel',
      ...CHECK,
      'futurebroadcast',
      ...CHECK,
      'utxoupdatepsbt',
    ])

    // A failed re-check: check_failed, and the call is not sent.
    node.results({ setlabel: 'null' })
    const before = singles().length
    const failedCheck = await failure(rpc.call('setlabel'))
    expect(failedCheck).toMatchObject({ reason: 'check_failed', method: 'setlabel' })
    expect(RpcError.is((failedCheck as Error).cause)).toBe(true)
    expect(singles()).toHaveLength(before)

    // Another chain: refused until confirmChain() matches again.
    node.results(chainResults('main'))
    await failure(rpc.confirmChain())
    for (const method of ['setlabel', 'futurebroadcast']) {
      expect(await failure(rpc.call(method))).toMatchObject({ reason: 'mismatch', method, actualChain: 'main' })
    }
    expect(singles()).toHaveLength(before)
  })

  it('treats an extra call with side effects as an allowlisted one: a fresh connection, never retried, an unknown outcome', async () => {
    const rpc = client(
      { setlabel: WALLET_WRITE, futurebroadcast: BROADCAST },
      { capabilities: ['wallet-write', 'broadcast'], readRetries: 3, retryDelayMs: 0 }
    )
    await rpc.confirmChain()
    node.requests.length = 0
    await rpc.getBlockCount()
    await rpc.getBlockCount()
    await rpc.call('setlabel')
    await rpc.call('futurebroadcast')
    const [read1, read2, write1, write2] = node.requests
    expect(read1!.remotePort).toBe(read2!.remotePort)
    expect(new Set([read1!.remotePort, write1!.remotePort, write2!.remotePort]).size).toBe(3)
    expect(write1!.headers.connection).toBe('close')
    expect(write2!.headers.connection).toBe('close')

    const outcomes: [string, Handler, (cause: unknown) => boolean][] = [
      ['a dropped reply', (_request, response) => response.socket?.destroy(), RpcTransportError.is],
      [
        'an HTTP 500',
        (_request, response) => {
          response.statusCode = 500
          response.end()
        },
        RpcTransportError.is,
      ],
      ['a malformed reply', (_request, response) => response.end('{"jsonrpc"'), RpcResponseError.is],
    ]
    for (const method of ['setlabel', 'futurebroadcast']) {
      for (const [, fail, cause] of outcomes) {
        failSingles(fail)
        const before = singles().length
        const error = await failure(rpc.call(method))
        expect(RpcUnknownOutcomeError.is(error)).toBe(true)
        expect(error).toMatchObject({ method })
        expect(cause((error as Error).cause)).toBe(true)
        // Sent once, under readRetries: 3.
        expect(singles()).toHaveLength(before + 1)
      }
    }
    // A deadline that passes after sending.
    failSingles(() => undefined)
    const late = await failure(rpc.call('setlabel', [], { timeoutMs: 100 }))
    expect(RpcUnknownOutcomeError.is(late)).toBe(true)
    expect(RpcTimeoutError.is((late as Error).cause)).toBe(true)
    // The node's own error is its answer: definite.
    node.rpc(call =>
      call.method === 'setlabel'
        ? { error: { code: -5, message: 'Invalid qbit address' } }
        : { result: RESULTS[call.method]! }
    )
    const answered = await failure(rpc.call('setlabel'))
    expect(RpcError.is(answered)).toBe(true)
    expect(answered).toMatchObject({ rpcCode: -5, method: 'setlabel' })
  })

  it('refuses extra methods in a batch unless they are reads without side effects', async () => {
    const rpc = client(
      {
        getchaintxstats: READ,
        getbalance: WALLET_READ,
        setlabel: WALLET_WRITE,
        utxoupdatepsbt: { capability: 'wallet-write', sideEffects: false },
        futurebroadcast: BROADCAST,
      },
      { capabilities: ALL }
    )
    await rpc.confirmChain()
    const before = node.requests.length
    for (const method of ['setlabel', 'utxoupdatepsbt', 'futurebroadcast']) {
      const error = await refusal(rpc.batch([requests.raw('getchaintxstats'), requests.raw(method)]))
      expect(error).toMatchObject({ reason: 'not_batchable', method })
    }
    expect(node.requests).toHaveLength(before)
    const [stats, balance] = await rpc.batch([requests.raw('getchaintxstats', [10]), requests.raw('getbalance')])
    expect(stats.ok && stats.value).toMatchObject({ window_block_count: expect.any(JsonNumber) })
    expect(balance.ok && (balance.value as JsonNumber).toBits()).toBe(50_000_000n)
  })

  it('takes a request slot as any call does', async () => {
    const rpc = client(
      { setlabel: WALLET_WRITE, getchaintxstats: READ },
      {
        capabilities: ['wallet-write'],
        maxConcurrentRequests: 1,
      }
    )
    await rpc.confirmChain()
    const held: { call: RpcCall; response: ServerResponse }[] = []
    node.handler = (request, response) => {
      held.push({ call: JSON.parse(request.body) as RpcCall, response })
    }
    const reply = ({ call, response }: (typeof held)[number]): void => {
      response.end(`{"jsonrpc":"2.0","result":${RESULTS[call.method]!},"id":${String(call.id)}}`)
    }
    const write = rpc.call('setlabel')
    const read = rpc.call('getchaintxstats')
    await vi.waitFor(() => expect(held).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(held.map(({ call }) => call.method)).toEqual(['setlabel'])
    reply(held[0]!)
    await write
    await vi.waitFor(() => expect(held).toHaveLength(2))
    reply(held[1]!)
    await read
    expect(held.map(({ call }) => call.method)).toEqual(['setlabel', 'getchaintxstats'])
  })
})

describe('node-admin', () => {
  /** The methods qbit Core v1.0.0's help lists that administer the node. */
  const NODE_METHODS = Object.entries(METHOD_CLASSES)
    .filter(([, known]) => known.kind === 'node')
    .map(([name]) => name)

  it('classes node administration as node-admin, each with side effects, ping included', () => {
    expect([...NODE_METHODS].sort()).toEqual(
      [
        'addnode',
        'clearbanned',
        'disconnectnode',
        'dumptxoutset',
        'getblockfrompeer',
        'importmempool',
        'loadtxoutset',
        'logging',
        'ping',
        'preciousblock',
        'pruneblockchain',
        'savemempool',
        'setban',
        'setnetworkactive',
        'stop',
      ].sort()
    )
    for (const name of NODE_METHODS) {
      expect(METHOD_CLASSES[name]!.sideEffects, name).toBe(true)
      expect(belowClass(name, NODE_ADMIN), name).toBeUndefined()
    }
  })

  it('refuses stop, setban and every node method under any other capability, broadcast included, naming it and node-admin', () => {
    const others: ExtraMethodPolicy[] = [
      READ,
      WALLET_READ,
      WALLET_WRITE,
      BROADCAST,
      { capability: 'read', sideEffects: true },
      { capability: 'wallet-read', sideEffects: true },
      { capability: 'wallet-write', sideEffects: false },
      { capability: 'broadcast', sideEffects: false },
      { capability: 'node-admin', sideEffects: false },
    ]
    for (const name of NODE_METHODS) {
      for (const entry of others) {
        const make = (): QbitRpcClient => client({ [name]: entry }, { capabilities: ALL })
        expect(make, `${name} ${JSON.stringify(entry)}`).toThrow(TypeError)
        expect(make, `${name} ${JSON.stringify(entry)}`).toThrow(
          `extraMethods.${name}: qbit Core v1.0.0's ${name} changes what the node stores, follows or connects to, or stops it, so it needs { capability: 'node-admin', sideEffects: true }`
        )
      }
    }
    expect(node.requests).toHaveLength(0)
  })

  it('refuses a node-admin entry at construction on a client that does not enable node-admin', async () => {
    for (const capabilities of [[], ['wallet-read', 'wallet-write', 'broadcast']] as Capability[][]) {
      for (const name of ['stop', 'setban']) {
        expect(() => client({ [name]: NODE_ADMIN }, { capabilities })).toThrow(
          new TypeError(`extraMethods.${name} needs the 'node-admin' capability, which this client does not enable`)
        )
        // Without an entry, no capability opens it.
        expect((await refusal(client(undefined, { capabilities: ALL }).call(name))).reason).toBe('unknown_method')
      }
    }
    expect(node.requests).toHaveLength(0)
  })

  it('checks the chain before a node-admin call, as a side-effecting call, and never batches it', async () => {
    const rpc = client(
      { setban: NODE_ADMIN, ping: NODE_ADMIN, futurenodemethod: { capability: 'node-admin', sideEffects: false } },
      { capabilities: ['node-admin'], readRetries: 3, retryDelayMs: 0 }
    )
    expect(rpc.toJSON()).toMatchObject({ capabilities: ['node-admin'] })
    // Refused until confirmChain(), as wallet-write and broadcast calls are, and nothing is sent.
    expect(rpc.chainStatus).toBe('unconfirmed')
    expect(await failure(rpc.call('setban', ['127.0.0.2', 'add']))).toMatchObject({
      reason: 'unconfirmed',
      method: 'setban',
    })
    expect(node.requests).toHaveLength(0)
    await rpc.confirmChain()
    expect(await rpc.call('setban', ['127.0.0.2', 'add'])).toBeNull()
    expect(await rpc.call('ping')).toBeNull()
    expect(node.calls().map(call => call.method)).toEqual([...CHECK, 'setban', 'ping'])
    // Each on a connection of its own, as side-effecting calls are.
    const [first, second] = singles()
    expect(first!.remotePort).not.toBe(second!.remotePort)
    expect(first!.headers.connection).toBe('close')
    expect(second!.headers.connection).toBe('close')

    // Never batched, with side effects or without: nothing is sent.
    const before = node.requests.length
    for (const method of ['setban', 'ping', 'futurenodemethod']) {
      const error = await refusal(rpc.batch([requests.raw(method)]))
      expect(error).toMatchObject({ reason: 'not_batchable', method })
    }
    expect(node.requests).toHaveLength(before)

    // A lost reply is an unknown outcome, sent once under readRetries: 3.
    failSingles((_request, response) => response.socket?.destroy())
    const sent = singles().length
    const lost = await failure(rpc.call('setban', ['127.0.0.2', 'remove']))
    expect(RpcUnknownOutcomeError.is(lost)).toBe(true)
    expect(lost).toMatchObject({ method: 'setban' })
    expect(singles()).toHaveLength(sent + 1)
  })

  it('refuses a node-admin call on another chain, or when the chain cannot be confirmed, and sends it on an unsupported version', async () => {
    const rpc = client(
      { ping: NODE_ADMIN, stop: NODE_ADMIN },
      { capabilities: ['node-admin'], chainCheckMaxAgeMs: 0, retryDelayMs: 0 }
    )
    const sentPings = (): number => node.calls().filter(call => call.method === 'ping').length

    // Another chain: refused, as a mismatch, and nothing is sent.
    node.results({ ...RESULTS, ...chainResults('main') })
    expect(await failure(rpc.confirmChain())).toMatchObject({ reason: 'mismatch' })
    const mismatch = await failure(rpc.call('ping'))
    expect(RpcChainGuardError.is(mismatch)).toBe(true)
    expect(mismatch).toMatchObject({ reason: 'mismatch', method: 'ping', actualChain: 'main' })
    expect(sentPings()).toBe(0)

    // The expected chain on a qbit Core version this package does not support: stop and ping still go out.
    node.results({ ...RESULTS, getnetworkinfo: networkInfoJson('/qbit:1.1.0/', 10100) })
    expect(await failure(rpc.confirmChain())).toMatchObject({ reason: 'unsupported_version' })
    expect(rpc.chainStatus).toBe('unsupported_version')
    expect(await rpc.call('ping')).toBeNull()
    expect(await rpc.call('stop')).toBe('qbit server stopping')
    expect(sentPings()).toBe(1)

    // The same version, but no chain the check can confirm: every check doubted, so stale, unsent.
    node.results({ ...RESULTS, getblockchaininfo: '{}', getnetworkinfo: networkInfoJson('/qbit:1.1.0/', 10100) })
    const stale = await failure(rpc.call('ping'))
    expect(RpcChainGuardError.is(stale)).toBe(true)
    expect(stale).toMatchObject({ reason: 'stale', method: 'ping' })
    expect(sentPings()).toBe(1)

    // A node that answers no check: refused like any guarded call, unsent.
    node.handler = (request, response) => {
      response.statusCode = 500
      response.end(request.body.startsWith('[') ? 'down' : 'unexpected')
    }
    const down = await failure(rpc.call('ping'))
    expect(RpcChainGuardError.is(down)).toBe(true)
    expect(down).toMatchObject({ reason: 'check_failed', method: 'ping' })
    expect(sentPings()).toBe(1)
  })

  it('checks the chain again for a node-admin call after a doubt, on an unsupported version too', async () => {
    const rpc = client({ ping: NODE_ADMIN }, { capabilities: ['node-admin'], retryDelayMs: 0 })
    const sentPings = (): number => node.calls().filter(call => call.method === 'ping').length
    node.results({ ...RESULTS, getnetworkinfo: networkInfoJson('/qbit:1.1.0/', 10100) })
    expect(await failure(rpc.confirmChain())).toMatchObject({ reason: 'unsupported_version' })
    // Within chainCheckMaxAgeMs, the match stands: no new check.
    const checks = (): number => node.requests.filter(request => request.body.startsWith('[')).length
    const before = checks()
    expect(await rpc.call('ping')).toBeNull()
    expect(checks()).toBe(before)
    // An HTTP 401 to a read: the node behind the URL may have been replaced, here by one on main.
    const answer = node.handler
    node.handler = (_request, response) => {
      response.statusCode = 401
      response.end()
    }
    await failure(rpc.getBlockCount())
    node.handler = answer
    node.results({ ...RESULTS, ...chainResults('main') })
    const refused = await failure(rpc.call('ping'))
    expect(RpcChainGuardError.is(refused)).toBe(true)
    expect(refused).toMatchObject({ reason: 'mismatch', method: 'ping', actualChain: 'main' })
    expect(sentPings()).toBe(1)
  })

  it("checks again when a doubt comes while a node-admin call's check is in flight", async () => {
    const rpc = client({ ping: NODE_ADMIN }, { capabilities: ['node-admin'], chainCheckMaxAgeMs: 0, retryDelayMs: 0 })
    node.results({ ...RESULTS, getnetworkinfo: networkInfoJson('/qbit:1.1.0/', 10100) })
    expect(await failure(rpc.confirmChain())).toMatchObject({ reason: 'unsupported_version' })
    const answer = node.handler
    let release: (() => void) | undefined
    node.handler = (request, response) => {
      if (request.body.startsWith('[') && release === undefined) {
        release = () => answer(request, response)
        return
      }
      answer(request, response)
    }
    const ping = rpc.call('ping').catch((e: unknown) => e)
    await expect.poll(() => release).toBeDefined()
    // While the call's check is out, a read is answered with HTTP 401: the node may be another one.
    const holding = node.handler
    node.handler = (_request, response) => {
      response.statusCode = 401
      response.end()
    }
    await failure(rpc.getBlockCount())
    node.handler = holding
    // The old node answers that check with the expected chain; the URL now reaches one on main.
    release!()
    node.results({ ...RESULTS, ...chainResults('main') })
    const refused = await ping
    expect(RpcChainGuardError.is(refused)).toBe(true)
    expect(refused).toMatchObject({ reason: 'mismatch', method: 'ping', actualChain: 'main' })
    expect(node.calls().filter(call => call.method === 'ping')).toHaveLength(0)
  })

  it("sends concurrent node-admin calls on an unsupported version: no check voids another's match", async () => {
    const rpc = client({ ping: NODE_ADMIN }, { capabilities: ['node-admin'], chainCheckMaxAgeMs: 0, retryDelayMs: 0 })
    node.results({ ...RESULTS, getnetworkinfo: networkInfoJson('/qbit:1.1.0/', 10100) })
    expect(await failure(rpc.confirmChain())).toMatchObject({ reason: 'unsupported_version' })
    // Each check records the version again; none may leave another call without a match.
    expect(await Promise.all(Array.from({ length: 6 }, () => rpc.call('ping')))).toEqual(Array(6).fill(null))
    expect(node.calls().filter(call => call.method === 'ping')).toHaveLength(6)
  })

  it('sends a node-admin call once the node runs a supported version again, before any confirmChain()', async () => {
    const rpc = client({ ping: NODE_ADMIN }, { capabilities: ['node-admin'], chainCheckMaxAgeMs: 0, retryDelayMs: 0 })
    // An unsupported version recorded from a check whose chain report did not validate: no match kept.
    node.results({ ...RESULTS, getblockchaininfo: '{}', getnetworkinfo: networkInfoJson('/qbit:1.1.0/', 10100) })
    expect(await failure(rpc.confirmChain())).toMatchObject({ reason: 'unsupported_version' })
    // Upgraded to a supported release: the recorded unsupported version stands until confirmChain(),
    // which records nothing from a call's check, but the call's own check read the expected chain.
    node.results(RESULTS)
    expect(await rpc.call('ping')).toBeNull()
    expect(rpc.chainStatus).toBe('unsupported_version')
  })

  it('opens no allowlisted method to a client that enables node-admin', async () => {
    /** What a call or a one-entry batch of `method` comes to: refused, and why, or let through. */
    const outcome = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run()
        return 'let through'
      } catch (error) {
        if (RpcCapabilityError.is(error)) return `refused: ${error.reason}`
        // The chain guard decides after the capability check: the call was let through it.
        return 'let through'
      }
    }
    const methods = [...Object.keys(METHOD_POLICIES), ...NODE_METHODS]
    for (const capabilities of [[], ['wallet-read'], ['wallet-read', 'wallet-write', 'broadcast']] as Capability[][]) {
      const without = client(undefined, { capabilities })
      const withNodeAdmin = client(undefined, { capabilities: [...capabilities, 'node-admin'] })
      for (const method of methods) {
        for (const run of [
          (rpc: QbitRpcClient) => rpc.call(method),
          (rpc: QbitRpcClient) => rpc.batch([requests.raw(method)]),
        ]) {
          const expected = await outcome(() => run(without))
          expect(await outcome(() => run(withNodeAdmin)), `${method} with ${capabilities.join(', ')}`).toBe(expected)
        }
      }
      without.close()
      withNodeAdmin.close()
    }
  })
})
