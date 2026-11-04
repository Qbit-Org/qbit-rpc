import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  QbitRpcClient,
  requests,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcTimeoutError,
  RpcTransportError,
  RpcUnknownOutcomeError,
  type RpcRequest,
} from '../src'
import { chainResults, FakeNode, HASH_A, TX_HEX, TX_TXID } from './helpers/fake-node'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const readme = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

describe('property names', () => {
  it('keeps the node’s number in RpcError.rpcCode, in the object and its JSON form', () => {
    const error = new RpcError('getblockhash', -8, 'Block height out of range')
    expect(error.rpcCode).toBe(-8)
    expect(error).not.toHaveProperty('code')
    expect(JSON.parse(JSON.stringify(error))).toEqual({ name: 'RpcError', method: 'getblockhash', rpcCode: -8 })
  })

  it('keeps a string in RpcTransportError.code', () => {
    const error = new RpcTransportError('getblockcount', 'network', { code: 'ECONNREFUSED' })
    expect(error.code).toBe('ECONNREFUSED')
    expect(error).not.toHaveProperty('rpcCode')
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'RpcTransportError',
      method: 'getblockcount',
      reason: 'network',
      code: 'ECONNREFUSED',
    })
  })

  it('names the chains on RpcChainGuardError, in the object and its JSON form', () => {
    const error = new RpcChainGuardError('walletlock', 'mismatch', 'regtest', {
      actualChain: 'main',
      mismatch: { differs: ['chain'], expectedGenesisHash: HASH_A },
    })
    expect(error).toMatchObject({ expectedChain: 'regtest', actualChain: 'main' })
    expect(error).not.toHaveProperty('expected')
    expect(error).not.toHaveProperty('actual')
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'RpcChainGuardError',
      method: 'walletlock',
      reason: 'mismatch',
      expectedChain: 'regtest',
      actualChain: 'main',
      differs: ['chain'],
      expectedGenesisHash: HASH_A,
    })
  })

  it('carries check_failed’s failure as its cause, and leaves it out of the JSON form like any cause', () => {
    const cause = new RpcTimeoutError('getblockchaininfo', 5)
    const error = new RpcChainGuardError('walletlock', 'check_failed', 'regtest', { cause })
    expect(error.cause).toBe(cause)
    expect(error.method).toBe('walletlock')
    expect(error.message).toBe(
      'RPC method walletlock refused: its chain re-check failed (RPC getblockchaininfo timed out after 5 ms)'
    )
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'RpcChainGuardError',
      method: 'walletlock',
      reason: 'check_failed',
      expectedChain: 'regtest',
    })
  })
})

describe('a custom parse that throws', () => {
  class OddError extends Error {}
  const THROWN: [name: string, thrown: unknown][] = [
    ['a TypeError', new TypeError('not what I wanted')],
    ['a string', 'not what I wanted'],
    ['an Error subclass', new OddError('not what I wanted')],
  ]
  const throwing = (method: string, thrown: unknown): RpcRequest<never> => ({
    method,
    params: [],
    parse: () => {
      throw thrown
    },
  })

  let node: FakeNode
  beforeEach(async () => {
    node = await FakeNode.start()
    node.results({
      ...chainResults('regtest'),
      getblockcount: '10',
      sendrawtransaction: JSON.stringify(TX_TXID),
      getbestblockhash: JSON.stringify(HASH_A),
    })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await node.close()
  })

  function client(): QbitRpcClient {
    return new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      capabilities: ['broadcast'],
      readRetries: 3,
      retryDelayMs: 0,
    })
  }

  function expectWrapped(error: unknown, method: string, thrown: unknown): void {
    expect(RpcResponseError.is(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'validation', path: 'result', method })
    expect((error as Error).cause).toBe(thrown)
    // The message is this package's: what a custom parser threw stays in `cause`.
    expect((error as Error).message).not.toContain('not what I wanted')
  }

  it.each(THROWN)('fails a single read with RpcResponseError, once, for %s', async (_name, thrown) => {
    vi.spyOn(requests, 'getBlockCount').mockReturnValue(throwing('getblockcount', thrown))
    const error = await client()
      .getBlockCount()
      .catch((e: unknown) => e)
    expectWrapped(error, 'getblockcount', thrown)
    expect(node.requests).toHaveLength(1)
  })

  it.each(THROWN)('makes a side-effecting call an unknown outcome, once, for %s', async (_name, thrown) => {
    vi.spyOn(requests, 'sendRawTransaction').mockReturnValue({
      ...throwing('sendrawtransaction', thrown),
      txid: TX_TXID,
    })
    const rpc = client()
    await rpc.confirmChain()
    node.requests.length = 0
    const error = await rpc.sendRawTransaction(TX_HEX).catch((e: unknown) => e)
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'sendrawtransaction', txid: TX_TXID })
    expectWrapped((error as Error).cause, 'sendrawtransaction', thrown)
    expect(node.requests).toHaveLength(1)
  })

  it.each(THROWN)('fails only that batch item for %s', async (_name, thrown) => {
    const [good, bad, also] = await client().batch([
      requests.getBestBlockHash(),
      throwing('getblockcount', thrown),
      requests.getBestBlockHash(),
    ])
    expect(good).toEqual({ ok: true, value: HASH_A })
    expect(also).toEqual({ ok: true, value: HASH_A })
    expect(bad.ok).toBe(false)
    expectWrapped(!bad.ok && bad.error, 'getblockcount', thrown)
  })

  it('leaves the built-in validators’ failures as they were: a path and no cause', async () => {
    node.results({ getblockcount: '"ten"', getbestblockhash: '"NOT-A-HASH"' })
    const single = await client()
      .getBlockCount()
      .catch((e: unknown) => e)
    expect(single).toMatchObject({ name: 'RpcResponseError', reason: 'validation', path: 'result' })
    expect(single).not.toHaveProperty('cause')
    const [item] = await client().batch([requests.getBestBlockHash()])
    expect(!item.ok && item.error).toMatchObject({ reason: 'validation', path: 'result' })
    expect(!item.ok && item.error).not.toHaveProperty('cause')
  })
})

describe('the error API, read from the source', () => {
  const ENTRIES = { rpc: 'packages/rpc/src/index.ts', zmq: 'packages/zmq/src/index.ts' } as const
  type Package = keyof typeof ENTRIES
  /** What an error table describes: an exported error class, or a `ZmqEvent` kind. */
  interface Described {
    readonly label: string
    readonly type: ts.Type
  }
  let checker: ts.TypeChecker
  let described: Record<Package, Described[]>

  function exportsOf(entry: string, program: ts.Program): ts.Symbol[] {
    const source = program.getSourceFile(join(ROOT, entry))!
    return checker
      .getExportsOfModule(checker.getSymbolAtLocation(source)!)
      .map(symbol => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol))
  }

  function isErrorClass(type: ts.InterfaceType): boolean {
    return checker
      .getBaseTypes(type)
      .some(base => base.symbol.name === 'Error' || isErrorClass(base as ts.InterfaceType))
  }

  /** The `ZmqEvent` kinds, labelled as the table does; a kind without a `reason` or `code` has no row. */
  function eventsOf(symbols: readonly ts.Symbol[]): Described[] {
    const event = symbols.find(symbol => symbol.name === 'ZmqEvent')
    if (event === undefined) return []
    return (checker.getDeclaredTypeOfSymbol(event) as ts.UnionType).types.map(type => {
      const kind = checker.getTypeOfSymbol(type.getProperty('kind')!) as ts.StringLiteralType
      return { label: `\`${kind.value}\` event`, type }
    })
  }

  beforeAll(() => {
    const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile)
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
    const program = ts.createProgram(
      Object.values(ENTRIES).map(entry => join(ROOT, entry)),
      { ...options, noEmit: true, rootDir: ROOT, typeRoots: [join(ROOT, 'packages/rpc/node_modules/@types')] }
    )
    checker = program.getTypeChecker()
    const describedBy = (pkg: Package): Described[] => {
      const symbols = exportsOf(ENTRIES[pkg], program)
      const classes = symbols
        .filter(symbol => symbol.flags & ts.SymbolFlags.Class)
        .map(symbol => checker.getDeclaredTypeOfSymbol(symbol) as ts.InterfaceType)
        .filter(isErrorClass)
        .map(type => ({ label: `\`${type.symbol.name}\``, type }))
      return [...classes, ...eventsOf(symbols)]
    }
    described = { rpc: describedBy('rpc'), zmq: describedBy('zmq') }
    expect(described.rpc.length).toBeGreaterThanOrEqual(10)
    expect(described.zmq.length).toBeGreaterThanOrEqual(6)
  }, 120_000)

  /** The string literals `type` allows, leaving out an open `(string & {})` or plain `string`. */
  function literals(type: ts.Type): string[] {
    const parts = type.isUnion() ? type.types : [type]
    return parts.flatMap(part => (part.isStringLiteral() ? [part.value] : []))
  }

  /** The rows a table must have for `items`: one per `reason` and `code` value, or one for an item with none. */
  function rowsFromCode(items: readonly Described[]): string[] {
    return items.flatMap(({ label, type }) => {
      const props = (['reason', 'code'] as const).filter(name => type.getProperty(name) !== undefined)
      const values = props.flatMap(name =>
        literals(checker.getTypeOfSymbol(type.getProperty(name)!)).map(value => `${name}: '${value}'`)
      )
      if (values.length > 0) return values.map(value => `${label} | \`${value}\``)
      return label.endsWith('event') ? [] : [`${label} | `]
    })
  }

  /** The first two cells of each row of the one table a README may have headed `| Error |`. */
  function rowsFromTable(markdown: string): string[] {
    const lines = markdown.split('\n')
    const heads = lines.flatMap((line, index) => (line.startsWith('| Error |') ? [index] : []))
    expect(heads).toHaveLength(1)
    const rows: string[] = []
    for (let i = heads[0]! + 2; lines[i]?.startsWith('|') === true; i += 1) {
      const [first, second] = lines[i]!.split('|').slice(1, 3)
      rows.push(`${first!.trim()} | ${second!.trim()}`)
    }
    return rows
  }

  /** The type's kind for comparing properties: `code` as number on one class and string on another is the trap. */
  function category(type: ts.Type): string[] {
    const parts = type.isUnion() ? type.types : [type]
    return parts
      .filter(part => !(part.flags & ts.TypeFlags.Undefined))
      .map(part => {
        if (part.flags & ts.TypeFlags.StringLike) return 'string'
        if (part.isIntersection() && part.types.some(inner => inner.flags & ts.TypeFlags.StringLike)) return 'string'
        if (part.flags & ts.TypeFlags.NumberLike) return 'number'
        if (part.flags & ts.TypeFlags.BooleanLike) return 'boolean'
        return part.flags & ts.TypeFlags.Unknown ? 'unknown' : 'object'
      })
  }

  it.each(['rpc', 'zmq'] as const)(
    'finds every error class and reason of %s in its README table, and no other',
    pkg => {
      const expected = rowsFromCode(described[pkg]).sort()
      expect(rowsFromTable(readme(`packages/${pkg}/README.md`)).sort()).toEqual(expected)
    }
  )

  it('keeps the tables in the package READMEs, one each, and links them from the repository README', () => {
    const root = readme('README.md')
    expect(root).not.toMatch(/^\| Error \|/m)
    expect(root).toContain('packages/rpc/README.md#failure-model')
    expect(root).toContain('packages/zmq/README.md#errors')
  })

  it('gives each property one type across both packages’ error classes and zmq events', () => {
    const types = new Map<string, Set<string>>()
    for (const { type } of [...described.rpc, ...described.zmq]) {
      for (const property of type.getProperties()) {
        const seen = types.get(property.name) ?? new Set<string>()
        for (const kind of category(checker.getTypeOfSymbol(property))) seen.add(kind)
        types.set(property.name, seen)
      }
    }
    expect(types.get('code')).toEqual(new Set(['string']))
    expect(types.get('rpcCode')).toEqual(new Set(['number']))
    expect(types.get('expected')).toEqual(new Set(['number'])) // a gap's counter; the guard says expectedChain
    const twoTypes = [...types].filter(([, kinds]) => kinds.size > 1).map(([name]) => name)
    // The one left is the platform's: `Error.message` is a string, and a `message` event's `message` the notification.
    expect(twoTypes).toEqual(['message'])
  })
})
