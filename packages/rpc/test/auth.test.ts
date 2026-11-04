import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QbitRpcClient, QbitRpcError, RpcTransportError, RpcUnknownOutcomeError } from '../src'
import { basicAuth, chainResults, FakeNode, HASH_A } from './helpers/fake-node'

let node: FakeNode
let dir: string

beforeEach(async () => {
  node = await FakeNode.start()
  node.results({ getbestblockhash: JSON.stringify(HASH_A), ...chainResults('regtest') })
  dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-auth-'))
})
afterEach(async () => {
  await node.close()
  await rm(dir, { recursive: true, force: true })
})

describe('basic credentials', () => {
  it('sends HTTP Basic credentials and JSON-RPC 2.0 headers', async () => {
    const rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'alice', password: 'p@ss:w0rd' },
      expectedChain: 'regtest',
    })
    await rpc.getBestBlockHash()
    const [request] = node.requests
    expect(request!.headers.authorization).toBe(basicAuth('alice', 'p@ss:w0rd'))
    expect(request!.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request!.body)).toEqual({ jsonrpc: '2.0', id: 1, method: 'getbestblockhash', params: [] })
  })

  it('sends wallet calls to /wallet/<name>, URL-encoded', async () => {
    node.results({ getbestblockhash: JSON.stringify(HASH_A) })
    const rpc = new QbitRpcClient({
      url: node.url,
      wallet: 'hot/wallet one',
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
    })
    await rpc.getBestBlockHash()
    expect(node.requests[0]!.url).toBe('/wallet/hot%2Fwallet%20one')
    const inUrl = new QbitRpcClient({
      url: `${node.url}wallet/w1`,
      auth: { username: 'u', password: 'p' },
      expectedChain: 'regtest',
    })
    await inUrl.getBestBlockHash()
    expect(node.requests[1]!.url).toBe('/wallet/w1')
    expect(
      () =>
        new QbitRpcClient({
          url: `${node.url}wallet/w1`,
          wallet: 'w2',
          auth: { username: 'u', password: 'p' },
          expectedChain: 'regtest',
        })
    ).toThrow(TypeError)
  })
})

describe('cleartext refusal', () => {
  it.each([
    'http://10.0.0.5:8352/',
    'http://node.example:48352/',
    'http://[::ffff:127.0.0.1]:8352/',
    'http://127.0.0.1.example:8352/',
  ])('refuses plain http to non-loopback %s at construction', url => {
    expect(() => new QbitRpcClient({ url, auth: { username: 'u', password: 'p' }, expectedChain: 'main' })).toThrow(
      /https unless the host is loopback/
    )
  })

  it.each(['http://127.0.0.1:8352/', 'http://127.8.9.10:8352/', 'http://localhost:8352/', 'http://[::1]:8352/'])(
    'accepts plain http to loopback %s',
    url => {
      expect(
        () => new QbitRpcClient({ url, auth: { username: 'u', password: 'p' }, expectedChain: 'main' })
      ).not.toThrow()
    }
  )

  it('accepts https anywhere, but a cookie only for loopback', () => {
    expect(
      () =>
        new QbitRpcClient({
          url: 'https://node.example/rpc',
          auth: { username: 'u', password: 'p' },
          expectedChain: 'main',
        })
    ).not.toThrow()
    expect(
      () =>
        new QbitRpcClient({ url: 'https://node.example/', auth: { cookieFile: '/x/.cookie' }, expectedChain: 'main' })
    ).toThrow(/loopback/)
  })

  it.each([
    ['credentials in the URL', 'http://u:p@127.0.0.1:8352/'],
    ['a query string', 'http://127.0.0.1:8352/?x=1'],
    ['a non-http scheme', 'ftp://127.0.0.1:8352/'],
    ['a relative URL', '/rpc'],
    ['an empty URL', ''],
  ])('rejects %s', (_label, url) => {
    expect(() => new QbitRpcClient({ url, auth: { username: 'u', password: 'p' }, expectedChain: 'main' })).toThrow(
      TypeError
    )
  })

  it.each([
    [{}],
    [{ username: 'u' }],
    [{ username: '', password: 'p' }],
    [{ username: 'a:b', password: 'p' }],
    [{ username: 'u', password: 'line\nbreak' }],
    [{ username: 'u', password: 'p', cookieFile: '/c' }],
    [{ cookieFile: '' }],
  ])('rejects malformed auth %j', auth => {
    expect(() => new QbitRpcClient({ url: node.url, auth: auth as never, expectedChain: 'main' })).toThrow(TypeError)
  })
})

describe('cookie authentication', () => {
  it('re-reads the cookie for every request, so a qbitd restart can rotate it', async () => {
    const cookieFile = join(dir, '.cookie')
    await writeFile(cookieFile, '__cookie__:first')
    const rpc = new QbitRpcClient({ url: node.url, auth: { cookieFile }, expectedChain: 'regtest' })
    await rpc.getBestBlockHash()
    await writeFile(cookieFile, '__cookie__:second\n')
    await rpc.getBestBlockHash()
    expect(node.requests.map(request => request.headers.authorization)).toEqual([
      basicAuth('__cookie__', 'first'),
      basicAuth('__cookie__', 'second'),
    ])
  })

  it('fails with a credentials error, sending nothing, while the cookie is missing or malformed', async () => {
    const cookieFile = join(dir, '.cookie')
    const rpc = new QbitRpcClient({ url: node.url, auth: { cookieFile }, expectedChain: 'regtest' })
    await expect(rpc.getBestBlockHash()).rejects.toSatisfy(
      error => RpcTransportError.is(error) && error.reason === 'credentials' && error.code === 'ENOENT'
    )
    await writeFile(cookieFile, 'no-separator')
    await expect(rpc.getBestBlockHash()).rejects.toMatchObject({ reason: 'credentials', code: 'EMALFORMED' })
    expect(node.requests).toHaveLength(0)
  })

  it('retries a read after a rotated cookie was rejected, when retries are enabled', async () => {
    const cookieFile = join(dir, '.cookie')
    await writeFile(cookieFile, '__cookie__:stale')
    let first = true
    node.handler = async (request, response) => {
      if (first) {
        first = false
        await writeFile(cookieFile, '__cookie__:fresh')
        response.statusCode = 401
        response.end()
        return
      }
      response.end(`{"jsonrpc":"2.0","result":"${HASH_A}","id":${JSON.parse(request.body).id}}`)
    }
    const rpc = new QbitRpcClient({
      url: node.url,
      auth: { cookieFile },
      expectedChain: 'regtest',
      readRetries: 1,
      retryDelayMs: 0,
    })
    expect(await rpc.getBestBlockHash()).toBe(HASH_A)
    expect(node.requests[1]!.headers.authorization).toBe(basicAuth('__cookie__', 'fresh'))
  })
})

describe('secret redaction', () => {
  const PASSWORD = 'rpc-password-6d1f'
  const COOKIE = 'cookie-secret-91ab'
  const PASSPHRASE = 'wallet-passphrase-77c2'

  function assertClean(value: unknown): void {
    for (const text of [
      inspect(value, { showHidden: true, depth: Infinity, getters: true }),
      JSON.stringify(value) ?? '',
      String(value),
    ]) {
      for (const secret of [PASSWORD, COOKIE, PASSPHRASE, Buffer.from(`u:${PASSWORD}`).toString('base64')]) {
        expect(text).not.toContain(secret)
      }
    }
  }

  it('keeps credentials out of the client, its errors, and the console', async () => {
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const err = vi.spyOn(console, 'error')
    const debug = vi.spyOn(console, 'debug')

    const cookieFile = join(dir, '.cookie')
    await writeFile(cookieFile, `__cookie__:${COOKIE}`)
    const withPassword = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: PASSWORD },
      expectedChain: 'regtest',
    })
    const withCookie = new QbitRpcClient({
      url: node.url,
      auth: { cookieFile },
      expectedChain: 'regtest',
      capabilities: ['wallet-write'],
    })
    assertClean(withPassword)
    assertClean(withCookie)
    expect(JSON.parse(JSON.stringify(withPassword))).toMatchObject({ auth: 'basic', expectedChain: 'regtest' })
    expect(inspect(withCookie)).toContain("auth: 'cookie'")

    node.handler = (_request, response) => {
      response.statusCode = 401
      response.end()
    }
    const rejected = await withPassword.getBestBlockHash().catch((e: unknown) => e)
    expect(RpcTransportError.is(rejected)).toBe(true)
    expect((rejected as RpcTransportError).status).toBe(401)
    assertClean(rejected)

    // The passphrase travels only in the request body; a lost reply must not echo it.
    node.results(chainResults('regtest'))
    await withCookie.confirmChain()
    node.handler = (_request, response) => response.destroy()
    const lost = await withCookie.walletPassphrase(PASSPHRASE, 60).catch((e: unknown) => e)
    expect(RpcUnknownOutcomeError.is(lost)).toBe(true)
    assertClean(lost)
    expect(node.requests.at(-1)!.body).toContain(PASSPHRASE)

    for (const spy of [log, warn, err, debug]) expect(spy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('names errors by class and carries no request parameters', async () => {
    node.handler = (_request, response) => response.destroy()
    const rpc = new QbitRpcClient({
      url: node.url,
      auth: { username: 'u', password: PASSWORD },
      expectedChain: 'regtest',
    })
    const error = (await rpc.validateAddress(PASSPHRASE).catch((e: unknown) => e)) as QbitRpcError
    expect(QbitRpcError.is(error)).toBe(true)
    expect(error.name).toBe('RpcTransportError')
    assertClean(error)
  })
})
