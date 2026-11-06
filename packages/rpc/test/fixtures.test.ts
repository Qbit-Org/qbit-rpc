import { readdirSync, readFileSync } from 'node:fs'

import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { JsonNumber, QbitRpcClient, requests, RpcResponseError, RpcUnknownOutcomeError, type RpcRequest } from '../src'
import { methodPolicy, QBIT_GENESIS_HASHES } from '../src/capabilities'
import { stringifyRequest } from '../src/json'
import { ResultIssue } from '../src/validate'
import { FakeNode, type RpcCall } from './helpers/fake-node'
import { fuzz, FUZZ_TIMEOUT_MS } from './helpers/fuzz'
import {
  clone,
  get,
  loadFixtures,
  mutate,
  pathName,
  paths,
  REMOVE,
  replacements,
  replyValue,
  type Fixture,
  type Path,
} from './helpers/replies'

// Real qbit Core v1.0.0 replies, captured on regtest by
// scripts/capture-rpc-fixtures.mjs, as the seeds of the validator tests: each
// must validate, and each mutation of one field must either validate or fail
// as a ResultIssue, which the client reports as an RpcResponseError. Any
// other exception is a validator bug.

const fixtures = loadFixtures()
// Typed methods with no captured reply yet; #44 captures them. Only ever removed from.
const NOT_YET_CAPTURED: readonly string[] = [
  'backupWallet',
  'checkBlockProposal',
  'createAuxBlock',
  'createWallet',
  'deriveAddresses',
  'getBlock',
  'getBlockHex',
  'getBlockTemplate',
  'getBlockWithTransactions',
  'getChainTips',
  'getDescriptorInfo',
  'getMempoolInfo',
  'getMiningInfo',
  'getRawMempool',
  'getRawMempoolSequence',
  'getRawMempoolVerbose',
  'getTxSpendingPrevout',
  'importDescriptors',
  'keypoolRefill',
  'listWalletDir',
  'loadWallet',
  'rescanBlockchain',
  'signDataPqcHash',
  'submitAuxBlock',
  'submitBlock',
  'submitPackage',
  'unloadWallet',
  'waitForBlockHeight',
  'waitForNewBlock',
  'walletPassphraseChange',
]
const byName = new Map(fixtures.map(f => [f.name, f]))
type Builder = (...args: unknown[]) => RpcRequest<unknown>
const build = (f: Fixture): RpcRequest<unknown> =>
  (requests as unknown as Record<string, Builder>)[f.builder]!(...f.args)

/** The validator's outcome: its value, or the ResultIssue it threw. Anything else is thrown on. */
function validate(request: RpcRequest<unknown>, result: unknown): { value: unknown } | { issue: ResultIssue } {
  try {
    return { value: request.parse(result) }
  } catch (error) {
    if (error instanceof ResultIssue) return { issue: error }
    throw error
  }
}

/** Whether `inner` is `outer` or inside it. */
const within = (inner: string, outer: string): boolean =>
  inner === outer || inner.startsWith(`${outer}.`) || inner.startsWith(`${outer}[`)

/**
 * The fields of one object each field's check reads besides its own: a
 * mutation of the key may be reported at one of these siblings. Each pair is a
 * rule a validator states (a header's version and versionHex, a block's place
 * given together, and so on); nothing else is accepted.
 */
const DEPENDS: Readonly<Record<string, readonly string[]>> = {
  // getblockheader: versionHex must be version's hex, and the genesis block
  // alone has no previousblockhash; getnetworkinfo: subversion shows version.
  version: ['versionHex', 'subversion'],
  height: ['previousblockhash'],
  // validateaddress: an address when valid, an error when not.
  isvalid: ['address', 'error'],
  // gettxout: a coinbase output's confirmations.
  coinbase: ['confirmations'],
  // A wallet transaction's block fields come with its blockhash, or not at all.
  blocktime: ['blockhash'],
  blockindex: ['blockhash'],
  blockheight: ['blockhash'],
}

/** How a refused mutation of `path` was located: at the field, at a sibling it depends on, or not at all. */
function located(path: Path, issuePath: string, replacement: unknown): 'field' | 'sibling' | 'container' | undefined {
  if (within(issuePath, pathName(path))) return 'field'
  const key = path.at(-1)
  const parent = pathName(path.slice(0, -1))
  if (typeof key === 'string' && DEPENDS[key]?.some(sibling => within(issuePath, `${parent}.${sibling}`))) {
    return 'sibling'
  }
  // An array item removed: the array is shorter than its request says (one testmempoolaccept entry per transaction).
  if (typeof key === 'number' && replacement === REMOVE && issuePath === parent) return 'container'
  return undefined
}

/** Each field-by-field mutation of `f` the validator refuses, and how its issue was located. */
function refusals(f: Fixture): { mutated: string; issue: string; where: ReturnType<typeof located> }[] {
  const request = build(f)
  const out: { mutated: string; issue: string; where: ReturnType<typeof located> }[] = []
  for (const path of paths(f.result)) {
    for (const replacement of replacements(get(f.result, path))) {
      const outcome = validate(request, mutate(f.result, path, replacement))
      if ('issue' in outcome) {
        out.push({
          mutated: pathName(path),
          issue: outcome.issue.path,
          where: located(path, outcome.issue.path, replacement),
        })
      }
    }
  }
  return out
}

describe('captured regtest replies', () => {
  it('cover every typed method', () => {
    const typed = Object.keys(requests).filter(name => name !== 'raw')
    const captured = new Set(fixtures.map(f => f.builder))
    for (const name of NOT_YET_CAPTURED) {
      expect(typed, `${name} is not a builder`).toContain(name)
      expect(captured.has(name), `${name} is captured: drop it from NOT_YET_CAPTURED`).toBe(false)
    }
    expect([...captured].sort()).toEqual(typed.filter(name => !NOT_YET_CAPTURED.includes(name)).sort())
    expect(fixtures.length).toBeGreaterThanOrEqual(40)
    for (const name of [
      'gettransaction-send',
      'gettransaction-replaced',
      'gettransaction-immature',
      'gettransaction-generate',
    ]) {
      expect(byName.has(name)).toBe(true)
    }
  })

  it('hold nothing host-specific', () => {
    const dir = new URL('fixtures/regtest/', import.meta.url)
    for (const file of readdirSync(dir)) {
      const text = readFileSync(new URL(file, dir), 'utf8')
      expect(text, file).not.toMatch(/\/home\/|\/tmp\/|\/Users\/|[A-Z]:\\\\|\.cookie/)
    }
  })

  it.each(fixtures.map(f => [f.name, f] as const))(
    '%s: the builder sends the captured params, and the reply validates',
    (_name, f) => {
      const request = build(f)
      expect(request.method).toBe(f.method)
      expect(stringifyRequest(request.params)).toBe(JSON.stringify(f.params))
      expect(validate(request, clone(f.result))).toHaveProperty('value')
    }
  )

  it('records what each kind of wallet transaction looks like', () => {
    const categories = (name: string): unknown[] => {
      const value = validate(build(byName.get(name)!), byName.get(name)!.result) as {
        value: { details: { category: string }[]; confirmations: number }
      }
      return [...value.value.details.map(d => d.category), value.value.confirmations > 0]
    }
    expect(categories('gettransaction-send')).toEqual(['send', true])
    expect(categories('gettransaction-generate')).toEqual(['generate', true])
    expect(categories('gettransaction-immature')).toEqual(['immature', true])
    const replaced = validate(
      build(byName.get('gettransaction-replaced')!),
      byName.get('gettransaction-replaced')!.result
    )
    expect(replaced).toMatchObject({ value: { confirmations: 0, walletConflicts: [expect.any(String)] } })
  })

  it.each(fixtures.map(f => [f.name, f] as const))(
    '%s: each field-by-field mutation validates or is a ResultIssue at that field',
    (_name, f) => {
      const refused = refusals(f)
      // The error names the field that is wrong, or one of the same object its
      // check reads (DEPENDS), or, for an array item removed, the array.
      const misplaced = refused.filter(r => r.where === undefined).map(r => `${r.mutated} reported at ${r.issue}`)
      expect(misplaced).toEqual([])
      expect(refused.length).toBeGreaterThan(0)
    }
  )

  it('locates those refusals at the field itself, but for a few stated dependencies', () => {
    const tally = { field: 0, sibling: 0, container: 0 }
    for (const f of fixtures) for (const { where } of refusals(f)) if (where !== undefined) tally[where] += 1
    // With the fixtures of qbit Core v1.0.0: 12,762 at the field, 35 at a
    // sibling in DEPENDS, 2 at the array an item left.
    expect(tally.field).toBeGreaterThan(10_000)
    expect(tally.sibling + tally.container).toBeLessThan(tally.field / 100)
  })

  it.each(fixtures.map(f => [f.name, f] as const))('%s: an unknown field in any object is ignored', (_name, f) => {
    const request = build(f)
    const expected = validate(request, clone(f.result))
    for (const path of paths(f.result)) {
      const node = get(f.result, path)
      if (typeof node !== 'object' || node === null || Array.isArray(node) || node instanceof JsonNumber) continue
      const extended = mutate(f.result, [...path, 'qbit_rpc_unknown_field'], { nested: [1] })
      expect(validate(request, extended)).toEqual(expected)
    }
  })
})

describe('mutated replies through the client', () => {
  let node: FakeNode
  let reply: { text: string }
  const checkResults: Record<string, string> = {
    getblockchaininfo: JSON.stringify(byName.get('getblockchaininfo')!.result),
    getblockhash: JSON.stringify(QBIT_GENESIS_HASHES.regtest),
    getnetworkinfo: JSON.stringify(byName.get('getnetworkinfo')!.result),
  }

  beforeAll(async () => {
    node = await FakeNode.start()
    expect(QBIT_GENESIS_HASHES.regtest).toBe(byName.get('getblockhash')!.result)
    // The chain check is a batch; the call under test is sent alone.
    node.handler = (request, response) => {
      const body = JSON.parse(request.body) as RpcCall | RpcCall[]
      const text = Array.isArray(body)
        ? `[${body
            .map(call => `{"jsonrpc":"2.0","result":${checkResults[call.method]},"id":${JSON.stringify(call.id)}}`)
            .join(',')}]`
        : `{"jsonrpc":"2.0","result":${reply.text},"id":${JSON.stringify(body.id)}}`
      response.setHeader('content-type', 'application/json')
      response.end(text)
    }
  })
  afterAll(async () => {
    await node.close()
  })

  const client = (): QbitRpcClient =>
    new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
      capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
    })
  const send = (rpc: QbitRpcClient, f: Fixture): Promise<unknown> =>
    (rpc as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[f.builder]!(...f.args)
  /** What the client method resolves with for a validated value: these four resolve with nothing. */
  const returned = (f: Fixture, value: unknown): unknown =>
    ['lockUnspent', 'unlockUnspent', 'walletPassphrase', 'walletLock'].includes(f.builder) ? undefined : value

  it('returns each captured reply as its validator converts it', async () => {
    const rpc = client()
    await rpc.confirmChain()
    for (const f of fixtures) {
      reply = { text: JSON.stringify(f.result) }
      expect(await send(rpc, f)).toEqual(returned(f, (validate(build(f), clone(f.result)) as { value: unknown }).value))
    }
  })

  it(
    'turns any mutated field into a validated value or an RpcResponseError at the field the validator names',
    async () => {
      const rpc = client()
      await rpc.confirmChain()
      const mutation = fc
        .constantFrom(...fixtures)
        .chain(f =>
          fc.tuple(fc.constant(f), fc.constantFrom(...paths(f.result)), fc.oneof(replyValue, fc.constant(REMOVE)))
        )
      await fc.assert(
        fc.asyncProperty(mutation, async ([f, path, replacement]) => {
          const mutated = mutate(f.result, path, replacement)
          if (mutated === REMOVE) return
          const expected = validate(build(f), clone(mutated))
          reply = { text: JSON.stringify(mutated) }
          const outcome = await send(rpc, f).then(
            value => ({ value }),
            (error: unknown) => ({ error })
          )
          if ('value' in expected) {
            expect(outcome).toEqual({ value: returned(f, expected.value) })
            return
          }
          expect(outcome).toHaveProperty('error')
          let error = (outcome as { error: unknown }).error
          // The node acted on a side-effecting call before its reply failed validation.
          if (methodPolicy(f.method)!.sideEffects) {
            expect(RpcUnknownOutcomeError.is(error)).toBe(true)
            error = (error as RpcUnknownOutcomeError).cause
          }
          expect(RpcResponseError.is(error)).toBe(true)
          expect(error).toMatchObject({ reason: 'validation', path: expected.issue.path })
        }),
        fuzz(300)
      )
    },
    FUZZ_TIMEOUT_MS
  )
})
