// Tests for network-verification.mjs, the parts of verify-network.mjs that
// need no node. Run by `pnpm test:scripts`, after `pnpm build`: the send-amount
// policy is tested with the package's own parseQbt.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  describeEndpoint,
  formatBits,
  MAX_SEND_BITS,
  parseArgs,
  parseDuration,
  preview,
  readNodeEnv,
  renderReport,
  sendPolicy,
  valueAtPath,
  hideAll,
  hostOf,
  MAX_DURATION_MS,
  BlockAccounting,
  soakFailures,
} from './network-verification.mjs'

const { parseQbt } = await import(new URL('../packages/rpc/lib/index.mjs', import.meta.url))

describe('parseArgs', () => {
  it('reads a mode and its flags, with defaults per mode', () => {
    assert.deepEqual(parseArgs(['read']), {
      mode: 'read',
      blocks: 2000,
      durationMs: 0,
      intervalMs: 60_000,
      sendAmount: undefined,
      confirmations: 0,
      report: undefined,
    })
    assert.equal(parseArgs(['zmq']).durationMs, 3_600_000)
    assert.equal(parseArgs(['regtest']).blocks, 300)
    const send = parseArgs(['send', '--send-amount', '0.0001', '--confirmations=1', '--report', 'r.md'])
    assert.equal(send.sendAmount, '0.0001')
    assert.equal(send.confirmations, 1)
    assert.equal(send.report, 'r.md')
    assert.equal(parseArgs(['read', '--duration', '24h', '--interval', '90s']).durationMs, 86_400_000)
  })

  it('refuses a URL, credentials, a wallet or a chain on the command line, naming the variable', () => {
    for (const [flag, variable] of [
      ['--url', 'QBIT_RPC_URL'],
      ['--password', 'QBIT_RPC_PASSWORD'],
      ['--rpcpassword', 'QBIT_RPC_PASSWORD'],
      ['--user', 'QBIT_RPC_USER'],
      ['--cookie-file', 'QBIT_RPC_COOKIE_FILE'],
      ['--wallet', 'QBIT_RPC_WALLET'],
      ['--chain', 'QBIT_EXPECTED_CHAIN'],
    ]) {
      assert.throws(() => parseArgs(['read', flag, 'x']), new RegExp(variable), flag)
      assert.throws(() => parseArgs(['read', `${flag}=x`]), new RegExp(variable), flag)
    }
  })

  it('refuses an unknown mode or flag, a repeated or valueless flag, and a stray argument', () => {
    assert.throws(() => parseArgs([]), /mode/)
    assert.throws(() => parseArgs(['write']), /mode/)
    assert.throws(() => parseArgs(['read', '--fast', '1']), /unknown flag/)
    assert.throws(() => parseArgs(['read', '--blocks', '1', '--blocks', '2']), /twice/)
    assert.throws(() => parseArgs(['read', '--blocks']), /needs a value/)
    assert.throws(() => parseArgs(['read', 'http://127.0.0.1/']), /unexpected argument/)
  })

  it('takes --send-amount only where something is sent, and --confirmations only for send', () => {
    for (const mode of ['read', 'zmq', 'faults']) {
      assert.throws(() => parseArgs([mode, '--send-amount', '0.0001']), /send and regtest modes only/)
    }
    assert.equal(parseArgs(['regtest', '--send-amount', '0.0001']).sendAmount, '0.0001')
    assert.throws(() => parseArgs(['read', '--confirmations', '1']), /send mode only/)
  })

  it('refuses malformed and out-of-range numbers and durations', () => {
    for (const args of [
      ['read', '--blocks', '-1'],
      ['read', '--blocks', '1.5'],
      ['read', '--blocks', '1e3'],
      ['read', '--blocks', '1000001'],
      ['send', '--confirmations', '7'],
      ['read', '--interval', '500ms'],
      ['read', '--duration', '31d'],
      ['read', '--duration', '1.5h'],
      ['read', '--duration', ''],
    ]) {
      assert.throws(() => parseArgs(args), RangeError, args.join(' '))
    }
  })
})

describe('parseDuration', () => {
  it('reads ms, s, m and h, and a bare number as seconds', () => {
    assert.equal(parseDuration('250ms', 'x'), 250)
    assert.equal(parseDuration('90', 'x'), 90_000)
    assert.equal(parseDuration('10m', 'x'), 600_000)
    assert.equal(parseDuration('576h', 'x'), MAX_DURATION_MS)
    // Past Node's 2^31-1 ms timer limit a soak would end at once.
    assert.ok(MAX_DURATION_MS <= 2 ** 31 - 1)
    assert.throws(() => parseDuration('577h', 'x'), RangeError)
    assert.throws(() => parseDuration('720h', 'x'), RangeError)
    assert.throws(() => parseDuration(undefined, 'x'), RangeError)
  })
})

describe('readNodeEnv', () => {
  const base = { QBIT_RPC_URL: 'http://127.0.0.1:8332/', QBIT_RPC_COOKIE_FILE: '/c', QBIT_EXPECTED_CHAIN: 'main' }

  it('reads cookie or Basic credentials, and the per-mode variables', () => {
    assert.deepEqual(readNodeEnv(base, 'read').auth, { cookieFile: '/c' })
    const basic = readNodeEnv({ ...base, QBIT_RPC_COOKIE_FILE: '', QBIT_RPC_USER: 'u', QBIT_RPC_PASSWORD: 'p' }, 'read')
    assert.deepEqual(basic.auth, { username: 'u', password: 'p' })
    assert.equal(readNodeEnv({ ...base, QBIT_ZMQ_URL: 'tcp://127.0.0.1:28332' }, 'zmq').zmqUrl, 'tcp://127.0.0.1:28332')
    assert.equal(readNodeEnv({ ...base, QBIT_RPC_WALLET: 'w' }, 'send').wallet, 'w')
  })

  it('refuses missing, empty or contradictory settings without quoting a value', () => {
    for (const [env, mode, pattern] of [
      [{ ...base, QBIT_RPC_URL: '' }, 'read', /QBIT_RPC_URL/],
      [{ ...base, QBIT_RPC_COOKIE_FILE: undefined }, 'read', /QBIT_RPC_COOKIE_FILE, or both/],
      [{ ...base, QBIT_RPC_COOKIE_FILE: undefined, QBIT_RPC_USER: 'u' }, 'read', /or both/],
      [{ ...base, QBIT_RPC_USER: 'u', QBIT_RPC_PASSWORD: 'secret-value' }, 'read', /not both/],
      [{ ...base, QBIT_EXPECTED_CHAIN: 'mainnet' }, 'read', /QBIT_EXPECTED_CHAIN/],
      [{ ...base, QBIT_EXPECTED_CHAIN: undefined }, 'read', /QBIT_EXPECTED_CHAIN/],
      [base, 'zmq', /QBIT_ZMQ_URL/],
      [base, 'send', /QBIT_RPC_WALLET/],
    ]) {
      assert.throws(
        () => readNodeEnv(env, mode),
        error => pattern.test(error.message) && !error.message.includes('secret-value'),
        pattern.source
      )
    }
  })
})

describe('sendPolicy', () => {
  it('gives read and zmq no capability, on mainnet as anywhere', () => {
    for (const mode of ['read', 'zmq']) {
      for (const chain of ['main', 'regtest']) {
        assert.deepEqual(sendPolicy({ mode, chain }, parseQbt), { capabilities: [], sendBits: undefined })
      }
    }
  })

  it('refuses the send mode without --send-amount: no wallet-write without it', () => {
    for (const chain of ['main', 'testnet4', 'regtest']) {
      assert.throws(() => sendPolicy({ mode: 'send', chain }, parseQbt), /needs --send-amount/)
    }
  })

  it('takes a send amount above 0 and at most the cap, read by parseQbt', () => {
    const policy = sendPolicy({ mode: 'send', chain: 'main', sendAmount: '0.0001' }, parseQbt)
    assert.deepEqual(policy, { capabilities: ['wallet-read', 'wallet-write', 'broadcast'], sendBits: 10_000n })
    assert.equal(sendPolicy({ mode: 'send', chain: 'main', sendAmount: '0.001' }, parseQbt).sendBits, MAX_SEND_BITS)
    assert.equal(sendPolicy({ mode: 'send', chain: 'main', sendAmount: '0.00000001' }, parseQbt).sendBits, 1n)
  })

  it('refuses an amount over the cap, zero, negative, malformed or with more than 8 decimals', () => {
    for (const sendAmount of [
      '0.00100001',
      '1',
      '21000000',
      '0',
      '0.00000000',
      '-0.0001',
      '1e-4',
      'NaN',
      'Infinity',
      '0.000000001',
      '',
      ' 0.0001',
      '0,0001',
    ]) {
      assert.throws(() => sendPolicy({ mode: 'send', chain: 'main', sendAmount }, parseQbt), RangeError, sendAmount)
    }
  })

  it('runs faults and regtest on regtest only', () => {
    assert.deepEqual(sendPolicy({ mode: 'faults', chain: 'regtest' }, parseQbt).capabilities, [
      'wallet-read',
      'wallet-write',
      'broadcast',
    ])
    for (const mode of ['faults', 'regtest']) {
      assert.throws(() => sendPolicy({ mode, chain: 'main', sendAmount: '0.0001' }, parseQbt), /regtest node only/)
    }
  })
})

describe('report helpers', () => {
  it('describes an endpoint without its host', () => {
    assert.equal(describeEndpoint('http://127.0.0.1:8332/'), 'loopback http')
    assert.equal(describeEndpoint('http://[::1]:8332/'), 'loopback http')
    assert.equal(describeEndpoint('http://localhost:8332/'), 'loopback http')
    assert.equal(describeEndpoint('https://node.private.example:8443/wallet/w'), 'remote https')
  })

  it('formats bits as QBT', () => {
    assert.equal(formatBits(100_000n), '0.00100000')
    assert.equal(formatBits(-150_000_001n), '-1.50000001')
  })

  it('finds the value at a validation path, or nothing', () => {
    const raw = { vout: [{ value: 1 }, { value: 2 }], a: { b: 'x' } }
    assert.equal(valueAtPath(raw, 'result.vout[1].value'), 2)
    assert.equal(valueAtPath(raw, 'result.a.b'), 'x')
    assert.equal(valueAtPath(raw, 'result.vout[5].value'), undefined)
    assert.equal(valueAtPath(raw, 'params[0]'), undefined)
    assert.equal(valueAtPath(raw, 'result.a.toString'), undefined)
  })

  it('previews big numbers exactly, and cuts long values', () => {
    assert.equal(preview({ v: 2n ** 64n }), '{"v":"18446744073709551616n"}')
    assert.equal(preview('x'.repeat(300)).length, 201)
    assert.equal(preview(undefined), 'undefined')
  })

  it('renders a report with its tables, failures and record, escaping cells', () => {
    const text = renderReport({
      mode: 'read',
      chain: 'main',
      passed: false,
      summary: { endpoint: 'remote https' },
      sections: [{ title: 'Walk', text: 'about', rows: [{ a: 'x|y', b: 2n }] }],
      failures: ['getblock: RpcResponseError'],
      record: { amount: 5n },
    })
    assert.match(text, /^# Network verification: read on main\n/)
    assert.match(text, /Result: \*\*FAIL\*\*, 1 failures/)
    assert.match(text, /\| x\\\|y \| 2 \|/)
    assert.match(text, /- getblock: RpcResponseError/)
    assert.match(text, /"amount": "5"/)
  })
})

describe('hideAll and hostOf', () => {
  it("hides a remote node's URL whole, then its host, in any message", () => {
    const url = 'tcp://node.example.com'
    const hidden = [url, hostOf(url), 'https://rpc.example.com:8443/', hostOf('https://rpc.example.com:8443/')]
    assert.equal(hostOf(url), 'node.example.com')
    assert.equal(hostOf('not a url'), undefined)
    // A bracketed name does not parse as a URL, and is still found.
    assert.equal(hostOf('tcp://[Node.Example.com]'), 'Node.Example.com')
    assert.equal(hostOf('tcp://[2001:DB8::1]'), '2001:db8::1')
    assert.equal(
      hideAll(`ZmqSetupError: ${url} needs a port; then node.example.com and rpc.example.com refused`, hidden),
      'ZmqSetupError: <node address> needs a port; then <node address> and <node address> refused'
    )
    assert.equal(hideAll('nothing to hide', [undefined, '']), 'nothing to hide')
  })
  it('hides whole tokens only, in one pass, so other text and the placeholder stay whole', () => {
    // A host that is a word of the placeholder does not rewrite it.
    assert.equal(hideAll('node refused', ['node', 'address']), '<node address> refused')
    // An address inside a longer one is not one.
    assert.equal(hideAll('from 11.2.3.45 and 1.2.3.4', ['1.2.3.4']), 'from 11.2.3.45 and <node address>')
    // At the end of a sentence, and before a port, it is still hidden.
    assert.equal(
      hideAll('refused by node.example.com. Then node.example.com:8332', ['node.example.com']),
      'refused by <node address>. Then <node address>:8332'
    )
    assert.equal(hideAll('a [special] host', ['[special]']), 'a <node address> host')
    // In any case: an error message keeps the case the address was given in.
    assert.equal(hideAll('use [2001:DB8::1]:28332', [hostOf('tcp://[2001:DB8::1]')]), 'use [<node address>]:28332')
  })
})

const quietSoak = { messages: 10, malformed: 0, unknown: 0, uncovered: 0 }

describe('soakFailures', () => {
  const quiet = quietSoak
  it('passes a soak where every block was named', () => {
    assert.deepEqual(soakFailures(quiet), [])
  })
  it('fails a soak where nothing arrived', () => {
    assert.match(soakFailures({ ...quiet, messages: 0 })[0], /no ZMQ message arrived/)
  })
  it('fails any block no message named outside a blind window', () => {
    assert.match(soakFailures({ ...quiet, uncovered: 1 })[0], /1 new blocks no hashblock or block_connected named/)
  })
  it('fails a soak where blocks arrived but a topic stayed silent', () => {
    const counts = { hashblock: 3, hashtx: 5, rawblock: 0, rawtx: 5, sequence: 9 }
    assert.match(soakFailures({ ...quiet, counts, blocksSeen: 3 })[0], /3 blocks arrived but nothing on rawblock/)
    assert.deepEqual(soakFailures({ ...quiet, counts: { ...counts, rawblock: 3 }, blocksSeen: 3 }), [])
    // With no block in the window, a quiet topic says nothing.
    assert.deepEqual(soakFailures({ ...quiet, counts, blocksSeen: 0 }), [])
  })
  it('fails malformed messages and unknown blocks', () => {
    assert.equal(soakFailures({ ...quiet, malformed: 1, unknown: 1 }).length, 2)
  })
})

describe('BlockAccounting', () => {
  // An in-memory chain of headers, on the active chain or not.
  const chainOf = blocks => ({
    header: async hash => {
      const found = blocks[hash]
      if (found === undefined) throw new Error(`unknown block ${hash}`)
      return found
    },
  })
  const block = (height, previousBlockHash) => ({ height, previousBlockHash })
  const hashblock = hash => ({ topic: 'hashblock', hash })
  const connected = hash => ({ topic: 'sequence', event: 'block_connected', hash })
  const disconnected = hash => ({ topic: 'sequence', event: 'block_disconnected', hash })
  const started = () => Object.assign(new BlockAccounting(), { started: true })
  const feed = (accounting, ...messages) => {
    for (const message of messages) accounting.message(message)
  }
  const settle = (accounting, blocks, lastTip) =>
    accounting.settle(chainOf(blocks), { startTip: 's', startHeight: 100, lastTip })

  it('counts blocks connected in one tip update, with a hashblock for the tip only', async () => {
    const blocks = { s: block(100, 'p'), a: block(101, 's'), b: block(102, 'a'), c: block(103, 'b') }
    const accounting = started()
    // A catch-up: three blocks connect, and qbitd announces the new tip once.
    feed(accounting, connected('a'), connected('b'), connected('c'), hashblock('c'))
    const settled = await settle(accounting, blocks, 'c')
    assert.deepEqual(settled, { walked: 3, unannounced: 0, uncovered: 0, windows: [] })
    assert.deepEqual(soakFailures({ ...quietSoak, uncovered: settled.uncovered }), [])
  })

  it('counts the blocks a reorg connects, with a hashblock for the new tip only', async () => {
    // a was announced; a reorg replaces it with x, y, z in one tip update.
    const blocks = {
      s: block(100, 'p'),
      a: block(101, 's'),
      x: block(101, 's'),
      y: block(102, 'x'),
      z: block(103, 'y'),
    }
    const accounting = started()
    feed(accounting, connected('a'), hashblock('a'), disconnected('a'))
    feed(accounting, connected('x'), connected('y'), connected('z'), hashblock('z'))
    const settled = await settle(accounting, blocks, 'z')
    assert.deepEqual(settled, { walked: 3, unannounced: 0, uncovered: 0, windows: [] })
  })

  it('still fails a block no message named, outside a blind window', async () => {
    const blocks = { s: block(100, 'p'), a: block(101, 's'), b: block(102, 'a') }
    const accounting = started()
    accounting.message(hashblock('b')) // nothing named a
    const settled = await settle(accounting, blocks, 'b')
    assert.equal(settled.uncovered, 1)
    assert.equal(soakFailures({ ...quietSoak, uncovered: settled.uncovered }).length, 1)
  })

  it('covers the blocks a reorg while blind connected, down to where the chains meet', async () => {
    const blocks = { s: block(100, 'p'), a: block(101, 's'), x: block(101, 's'), y: block(102, 'x') }
    const accounting = started()
    accounting.message(hashblock('a'))
    accounting.reconnect() // qbitd restarts; meanwhile x and y replace a
    accounting.gap({ topic: 'hashblock', expected: 2, received: 1 })
    accounting.message(hashblock('y'))
    const settled = await settle(accounting, blocks, 'y')
    assert.deepEqual(settled.windows, [{ from: 100, to: 102 }])
    assert.equal(settled.uncovered, 0)
  })

  it('keeps a window open to the end of the soak when no hashblock followed a reconnect', async () => {
    const blocks = { s: block(100, 'p'), a: block(101, 's'), b: block(102, 'a') }
    const accounting = started()
    accounting.message(hashblock('a'))
    accounting.reconnect() // b is found while qbitd is down, and the soak ends
    const settled = await settle(accounting, blocks, 'b')
    assert.deepEqual(settled.windows, [{ from: 101, to: 102 }])
    assert.equal(settled.uncovered, 0)
  })

  it('covers a reorg to a shorter chain, its last block announced above the new tip', async () => {
    const blocks = { s: block(100, 'p'), z: block(101, 's'), a: block(102, 'z'), x: block(101, 's') }
    const accounting = started()
    accounting.message(hashblock('a'))
    accounting.reconnect()
    const settled = await settle(accounting, blocks, 'x')
    assert.deepEqual(settled.windows, [{ from: 100, to: 101 }])
    assert.equal(settled.uncovered, 0)
  })

  it('keeps the check on topics on when only block_connected named the blocks', () => {
    // No -zmqpubhashblock: sequence covers every block, and the silent topic must still fail.
    const accounting = new BlockAccounting()
    feed(accounting, connected('a'), connected('b'))
    assert.equal(accounting.seen, 2)
    const counts = { hashblock: 0, hashtx: 5, rawblock: 2, rawtx: 5, sequence: 9 }
    assert.match(
      soakFailures({ ...quietSoak, counts, blocksSeen: accounting.seen })[0],
      /2 blocks arrived but nothing on hashblock/
    )
    accounting.message(hashblock('b'))
    assert.equal(accounting.seen, 2) // a block named on both topics counts once
  })

  it('asks for each block header once, however many windows walk over it', async () => {
    // 200 blocks above s, a sequence gap before each block_connected: 200 windows over one chain.
    const blocks = { s: block(100, 'p') }
    let previous = 's'
    const accounting = started()
    for (let i = 1; i <= 200; i += 1) {
      blocks[`b${i}`] = block(100 + i, previous)
      previous = `b${i}`
      accounting.gap({ topic: 'sequence', expected: i, received: i + 1, missed: 1 }, `b${i}`)
      feed(accounting, connected(`b${i}`), hashblock(`b${i}`))
    }
    let calls = 0
    const counting = {
      header: async hash => {
        calls += 1
        return chainOf(blocks).header(hash)
      },
    }
    const settled = await accounting.settle(counting, { startTip: 's', startHeight: 100, lastTip: previous })
    assert.equal(settled.uncovered, 0)
    assert.equal(settled.windows.length, 200)
    // At most one call per distinct block: 200 above s, and s itself.
    assert.ok(calls <= 201, `${calls} header calls for 201 blocks`)
  })

  // #84: the gap accounting under lost sequence messages.
  it('excuses only the blocks connected while blind, not a reorg after the window closed (#84, 1)', async () => {
    // a announced, a reconnect, b's hashblock closes the window [a, b]. Later, while connected, a reorg
    // forks at s: x and y are never named (their block_connected lost without a gap), z is announced.
    const blocks = {
      s: block(100, 'p'),
      a: block(101, 's'),
      b: block(102, 'a'),
      x: block(101, 's'),
      y: block(102, 'x'),
      z: block(103, 'y'),
    }
    const accounting = started()
    accounting.message(hashblock('a'))
    accounting.reconnect()
    accounting.message(hashblock('b'))
    accounting.message(hashblock('z'))
    const settled = await settle(accounting, blocks, 'z')
    // The window spans a..b on its own chain: x and y, at the same heights on another, are not in it.
    assert.deepEqual(settled.windows, [{ from: 101, to: 102 }])
    assert.equal(settled.uncovered, 2)
    assert.equal(soakFailures({ ...quietSoak, uncovered: settled.uncovered }).length, 1)
  })

  it('lets a sequence gap excuse the blocks whose block_connected it lost (#84, 2)', async () => {
    // A catch-up connects a, b and c. The block_connected of a and b are lost, which the subscriber
    // reports as a sequence gap before c's; hashblock names only c.
    const blocks = { s: block(100, 'p'), a: block(101, 's'), b: block(102, 'a'), c: block(103, 'b') }
    const accounting = started()
    accounting.gap({ topic: 'sequence', expected: 1, received: 3, missed: 2 }, 'c')
    feed(accounting, connected('c'), hashblock('c'))
    const settled = await settle(accounting, blocks, 'c')
    assert.equal(settled.uncovered, 0)
    assert.equal(accounting.sequenceGaps, 1)
    // A later gap opens at the last block_connected: a was named, b is excused, nothing below a is.
    const later = started()
    feed(later, connected('a'), hashblock('a'))
    later.gap({ topic: 'sequence', expected: 5, received: 7, missed: 2 }, 'c')
    feed(later, connected('c'), hashblock('c'))
    const settledLater = await settle(later, blocks, 'c')
    assert.deepEqual(settledLater.windows, [{ from: 101, to: 103 }])
    assert.equal(settledLater.uncovered, 0)
  })

  it('lets a sized sequence gap excuse no more blocks than it lost messages', async () => {
    const blocks = { s: block(100, 'p'), a: block(101, 's'), b: block(102, 'a'), c: block(103, 'b') }
    // One lost message, a mempool event or a block's, while two blocks went unnamed before c.
    const accounting = started()
    accounting.gap({ topic: 'sequence', expected: 1, received: 2, missed: 1 }, 'c')
    feed(accounting, connected('c'), hashblock('c'))
    assert.equal((await settle(accounting, blocks, 'c')).uncovered, 1)
  })

  it('covers a sequence gap still open at the end only up to the tip when it was reported', async () => {
    const blocks = { s: block(100, 'p'), a: block(101, 's'), b: block(102, 'a'), c: block(103, 'b') }
    // One lost message reported at a, then nothing on any topic while b and c connect: neither is excused.
    const silent = started()
    feed(silent, connected('a'), hashblock('a'))
    silent.gap({ topic: 'sequence', expected: 5, received: 6, missed: 1 }, 'a')
    const settled = await settle(silent, blocks, 'c')
    assert.equal(settled.uncovered, 2)
    assert.equal(soakFailures({ ...quietSoak, uncovered: settled.uncovered }).length, 1)
    // b's own messages lost, which a later mempool event reports once b is the tip: b is excused.
    const reported = started()
    feed(reported, connected('a'), hashblock('a'))
    reported.gap({ topic: 'sequence', expected: 5, received: 6, missed: 1 }, 'b')
    assert.equal((await settle(reported, { s: blocks.s, a: blocks.a, b: blocks.b }, 'b')).uncovered, 0)
    // Without the tip at the gap, an open sequence window excuses nothing.
    const untold = started()
    feed(untold, connected('a'), hashblock('a'))
    untold.gap({ topic: 'sequence', expected: 5, received: 6, missed: 1 })
    assert.equal((await settle(untold, { s: blocks.s, a: blocks.a, b: blocks.b }, 'b')).uncovered, 1)
  })

  it('lets no sequence gap, sized or not, excuse blocks connected after it was reported', async () => {
    // A gap at a (unsized, as after a reconnect, or a large mempool-driven one), then block_connected stops
    // while hashblock goes on: a catch-up connects b, c and d, and hashblock names only d.
    const blocks = {
      s: block(100, 'p'),
      a: block(101, 's'),
      b: block(102, 'a'),
      c: block(103, 'b'),
      d: block(104, 'c'),
    }
    for (const missed of [undefined, 300]) {
      const accounting = started()
      feed(accounting, connected('a'), hashblock('a'))
      accounting.gap({ topic: 'sequence', expected: 5, received: 2, ...(missed === undefined ? {} : { missed }) }, 'a')
      accounting.message(hashblock('d'))
      assert.equal((await settle(accounting, blocks, 'd')).uncovered, 2, `missed ${missed}`)
    }
  })

  it("spends a sequence gap's allowance on a block whose hashblock came without its block_connected", async () => {
    // s → a → b → c: a's hashblock arrives, a gap of 1, then c's block_connected and hashblock. a and b both
    // lack block_connected, and one lost message cannot explain both: b fails.
    const blocks = { s: block(100, 'p'), a: block(101, 's'), b: block(102, 'a'), c: block(103, 'b') }
    const accounting = started()
    feed(accounting, connected('s'), hashblock('a'))
    accounting.gap({ topic: 'sequence', expected: 2, received: 3, missed: 1 }, 'c')
    feed(accounting, connected('c'), hashblock('c'))
    assert.equal((await settle(accounting, blocks, 'c')).uncovered, 1)
  })

  it("charges a sequence gap only for hashblock-only blocks after its window's start (#90)", async () => {
    // A gap of 1 for b's lost messages, reported at b. Then x's hashblock comes without its block_connected,
    // and nothing reports that: x is not this gap's loss, so b is still excused.
    const blocks = { s: block(100, 'p'), a: block(101, 's'), b: block(102, 'a'), x: block(103, 'b') }
    const later = started()
    feed(later, connected('a'), hashblock('a'))
    later.gap({ topic: 'sequence', expected: 5, received: 6, missed: 1 }, 'b')
    later.message(hashblock('x'))
    assert.equal((await settle(later, blocks, 'x')).uncovered, 0)
    // a's hashblock came before the first sequence message set the counter's baseline: not this gap's either.
    const before = started()
    before.message(hashblock('a'))
    before.message({ topic: 'sequence', event: 'mempool_added', hash: 't1' })
    before.gap({ topic: 'sequence', expected: 2, received: 3, missed: 1 }, 'b')
    assert.equal((await settle(before, { s: blocks.s, a: blocks.a, b: blocks.b }, 'b')).uncovered, 0)
  })

  it('ends a closed sequence window at the tip when its gap was reported, not at the block_connected that closed it', async () => {
    // A gap of 1 reported at b, then block_connected stops until e, after a catch-up c, d, e that hashblock
    // names only at e. c and d connected after the gap: not excused.
    const blocks = {
      s: block(100, 'p'),
      a: block(101, 's'),
      b: block(102, 'a'),
      c: block(103, 'b'),
      d: block(104, 'c'),
      e: block(105, 'd'),
    }
    const accounting = started()
    feed(accounting, connected('a'), hashblock('a'))
    accounting.gap({ topic: 'sequence', expected: 5, received: 6, missed: 1 }, 'b')
    feed(accounting, connected('e'), hashblock('e'))
    const settled = await settle(accounting, blocks, 'e')
    assert.equal(settled.uncovered, 2)
    assert.deepEqual(settled.windows, [{ from: 101, to: 102 }])
  })

  it('covers the blind blocks on the final chain when a reorg in the end grace closed the window (#90)', async () => {
    // Blind after a reconnect following a; b and c connect, so lastTip is c. In the grace, a reorg to b', c', d'
    // and d''s hashblock closes the window. b and c were blind too.
    const blocks = {
      s: block(100, 'p'),
      a: block(101, 's'),
      b: block(102, 'a'),
      c: block(103, 'b'),
      b2: block(102, 'a'),
      c2: block(103, 'b2'),
      d2: block(104, 'c2'),
    }
    const accounting = started()
    accounting.message(hashblock('a'))
    accounting.reconnect()
    accounting.ended() // lastTip c is read here
    accounting.message(hashblock('d2'))
    assert.equal((await settle(accounting, blocks, 'c')).uncovered, 0)
  })

  it('opens no window for an unsized sequence gap, and charges a later sized one only for losses after it', async () => {
    // a named; b's hashblock comes but its block_connected is lost as the connection drops; a reconnect,
    // and c connects while down; the first sequence message after it is an unsized gap; e's hashblock
    // closes the reconnect window, its block_connected lost; f loses both, and a gap of 2 is reported at f.
    const blocks = {
      s: block(100, 'p'),
      a: block(101, 's'),
      b: block(102, 'a'),
      c: block(103, 'b'),
      e: block(104, 'c'),
      f: block(105, 'e'),
    }
    const accounting = started()
    feed(accounting, connected('a'), hashblock('a'), hashblock('b'))
    accounting.reconnect()
    accounting.gap({ topic: 'sequence', expected: 9, received: 1 })
    accounting.message(hashblock('e'))
    accounting.gap({ topic: 'sequence', expected: 2, received: 4, missed: 2 }, 'f')
    // The gap of 2 lost e's and f's block_connected: b's loss came before the counter began again.
    assert.equal((await settle(accounting, blocks, 'f')).uncovered, 0)
    // An unsized gap alone excuses nothing.
    const alone = started()
    feed(alone, connected('a'), hashblock('a'))
    alone.gap({ topic: 'sequence', expected: 9, received: 1 }, 'c')
    assert.equal((await settle(alone, { s: blocks.s, a: blocks.a, b: blocks.b, c: blocks.c }, 'c')).uncovered, 2)
  })

  it('lets a sized hashblock gap excuse no block that no message named (#84, 3)', async () => {
    // A hashblock gap of 1 stood for b, whose block_connected arrived. d, which nothing named, is outside
    // every window, and fails: the gap's allowance no longer covers it.
    const blocks = { s: block(100, 'p'), a: block(101, 's'), b: block(102, 'a'), d: block(103, 'b') }
    const accounting = started()
    feed(accounting, connected('a'), hashblock('a'), connected('b'))
    accounting.gap({ topic: 'hashblock', expected: 2, received: 3, missed: 1 })
    const settled = await settle(accounting, blocks, 'd')
    assert.equal(accounting.hashblockMissed, 1)
    assert.equal(settled.uncovered, 1)
    assert.equal(soakFailures({ ...quietSoak, uncovered: settled.uncovered }).length, 1)
  })
})
