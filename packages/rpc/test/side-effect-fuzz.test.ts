import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { QbitRpcClient, requests, RpcResponseError, RpcTransportError, RpcUnknownOutcomeError } from '../src'
import { QBIT_GENESIS_HASHES } from '../src/capabilities'
import { parseJsonLossless } from '../src/json'
import { ResultIssue } from '../src/validate'
import { FakeNode, type RpcCall } from './helpers/fake-node'
import { fuzz, FUZZ_TIMEOUT_MS } from './helpers/fuzz'
import { clientArgs, clone, loadFixtures, mutate, paths, REMOVE, replyValue, type Fixture } from './helpers/replies'

// The side-effecting payment steps, end to end through a fake node whose
// replies are mutated: the node has acted by the time a reply arrives, so a
// reply that fails is always an RpcUnknownOutcomeError, with the failure as
// its cause, and one that validates gives exactly what the validator makes
// of it. Never a definite error, a raw exception or another value.

const fixtures = new Map(loadFixtures().map(f => [f.name, f]))
const targets = ['walletcreatefundedpsbt', 'walletprocesspsbt', 'sendrawtransaction'].map(name => fixtures.get(name)!)
const checkResults: Record<string, string> = {
  getblockchaininfo: JSON.stringify(fixtures.get('getblockchaininfo')!.result),
  getblockhash: JSON.stringify(QBIT_GENESIS_HASHES.regtest),
  getnetworkinfo: JSON.stringify(fixtures.get('getnetworkinfo')!.result),
}

/** What the fake node sends for the call under test, given its JSON-RPC id. */
interface Reply {
  readonly status: number
  readonly body: (id: unknown) => string
}

let node: FakeNode
let reply: Reply
/** The body last sent for a call under test, and the id of the request it answered. */
let sent = ''
let requestId: unknown
let rpc: QbitRpcClient

beforeAll(async () => {
  node = await FakeNode.start()
  node.handler = (request, response) => {
    const body = JSON.parse(request.body) as RpcCall | RpcCall[]
    response.setHeader('content-type', 'application/json')
    if (Array.isArray(body)) {
      // The chain check, answered as the regtest node the fixtures came from.
      const items = body.map(
        call => `{"jsonrpc":"2.0","result":${checkResults[call.method]},"id":${JSON.stringify(call.id)}}`
      )
      response.end(`[${items.join(',')}]`)
      return
    }
    response.statusCode = reply.status
    requestId = body.id
    sent = reply.body(body.id)
    response.end(sent)
  }
  rpc = new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities: ['wallet-write', 'broadcast'],
  })
  await rpc.confirmChain()
})
afterAll(async () => {
  await node.close()
})

const envelope = (resultText: string) => (id: unknown) =>
  `{"jsonrpc":"2.0","result":${resultText},"id":${JSON.stringify(id)}}`

async function send(f: Fixture): Promise<{ value: unknown } | { error: unknown }> {
  const method = (rpc as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[f.builder]!
  return method.apply(rpc, clientArgs(f)).then(
    value => ({ value }),
    (error: unknown) => ({ error })
  )
}

/** The unknown outcome's cause, after checking it is one and names the txid it can. */
function unknownCause(f: Fixture, outcome: { value: unknown } | { error: unknown }): unknown {
  expect(outcome).toHaveProperty('error')
  const error = (outcome as { error: unknown }).error
  expect(RpcUnknownOutcomeError.is(error)).toBe(true)
  const unknown = error as RpcUnknownOutcomeError
  expect(unknown.method).toBe(f.method)
  if (f.method === 'sendrawtransaction') expect(unknown.txid).toBe(f.result)
  else expect(unknown.txid).toBeUndefined()
  return unknown.cause
}

/** What the validator makes of a result, or the ResultIssue it throws. */
function validated(f: Fixture, result: unknown): { value: unknown } | { issue: ResultIssue } {
  const request = (requests as unknown as Record<string, (...args: unknown[]) => { parse(v: unknown): unknown }>)[
    f.builder
  ]!(...f.args)
  try {
    return { value: request.parse(clone(result)) }
  } catch (error) {
    if (error instanceof ResultIssue) return { issue: error }
    throw error
  }
}

describe('side-effecting calls with mutated replies', () => {
  it('accept each captured reply', async () => {
    for (const f of targets) {
      reply = { status: 200, body: envelope(JSON.stringify(f.result)) }
      expect(await send(f)).toEqual({ value: (validated(f, f.result) as { value: unknown }).value })
    }
  })

  it(
    'give a mutated result the validator refuses as RpcUnknownOutcomeError, caused by its RpcResponseError',
    async () => {
      const mutation = fc.constantFrom(...targets).chain(f =>
        fc.tuple(
          fc.constant(f),
          fc.array(fc.tuple(fc.constantFrom(...paths(f.result)), fc.oneof(replyValue, fc.constant(REMOVE))), {
            minLength: 1,
            maxLength: 3,
          })
        )
      )
      await fc.assert(
        fc.asyncProperty(mutation, async ([f, edits]) => {
          let result: unknown = f.result
          for (const [path, replacement] of edits) {
            try {
              result = mutate(result, path, replacement)
            } catch {
              // An earlier edit removed this path's parent: the edit has nothing to change.
            }
          }
          if (result === REMOVE) return
          reply = { status: 200, body: envelope(JSON.stringify(result)) }
          const outcome = await send(f)
          const expected = validated(f, result)
          if ('value' in expected) {
            expect(outcome).toEqual({ value: expected.value })
            return
          }
          const cause = unknownCause(f, outcome)
          expect(RpcResponseError.is(cause)).toBe(true)
          expect(cause).toMatchObject({ reason: 'validation', path: expected.issue.path })
        }),
        fuzz(300)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'give a corrupted body or a proxy error RpcUnknownOutcomeError, or the value a still-valid body holds',
    async () => {
      const corruption = fc.oneof(
        fc.nat().map(at => ({ kind: 'truncate' as const, at })),
        fc
          .tuple(fc.nat(), fc.integer({ min: 0x20, max: 0x7e }))
          .map(([at, code]) => ({ kind: 'flip' as const, at, code })),
        fc.string({ maxLength: 8 }).map(text => ({ kind: 'append' as const, text })),
        fc.string({ maxLength: 40 }).map(text => ({ kind: 'replace' as const, text })),
        fc.constantFrom(
          { kind: 'wrong-id' as const },
          { kind: 'no-result' as const },
          { kind: 'batch' as const },
          { kind: 'status' as const, status: 500 },
          { kind: 'status' as const, status: 502 },
          { kind: 'status' as const, status: 503 }
        )
      )
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...targets), corruption, async (f, c) => {
          const good = envelope(JSON.stringify(f.result))
          const body = (id: unknown): string => {
            const text = good(id)
            switch (c.kind) {
              case 'truncate':
                return text.slice(0, c.at % text.length)
              case 'flip': {
                const at = c.at % text.length
                return `${text.slice(0, at)}${String.fromCharCode(c.code)}${text.slice(at + 1)}`
              }
              case 'append':
                return `${text}${c.text}`
              case 'replace':
                return c.text
              case 'wrong-id':
                return good(typeof id === 'number' ? id + 1 : 'other')
              case 'no-result':
                return `{"jsonrpc":"2.0","id":${JSON.stringify(id)}}`
              case 'batch':
                return `[${text}]`
              case 'status':
                return text
            }
          }
          reply = { status: c.kind === 'status' ? c.status : 200, body }
          const outcome = await send(f)
          if ('value' in outcome) {
            // Only a body that is still a reply to this call, with a result that validates.
            expect(c.kind).not.toBe('status')
            expect((JSON.parse(sent) as { id: unknown }).id).toEqual(requestId)
            const { result } = parseJsonLossless(sent) as { result: unknown }
            expect(outcome).toEqual({ value: (validated(f, result) as { value: unknown }).value })
            return
          }
          const cause = unknownCause(f, outcome)
          expect(RpcResponseError.is(cause) || RpcTransportError.is(cause)).toBe(true)
        }),
        fuzz(300)
      )
    },
    FUZZ_TIMEOUT_MS
  )
})
