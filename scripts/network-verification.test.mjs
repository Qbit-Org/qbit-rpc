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
  soakFailures,
  uncoveredBlocks,
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
  })
})

describe('soakFailures', () => {
  const quiet = { messages: 10, malformed: 0, unknown: 0, uncovered: 0, hashblockMissed: 0 }
  it('passes a soak where every block had a hashblock', () => {
    assert.deepEqual(soakFailures(quiet), [])
  })
  it('fails a soak where nothing arrived', () => {
    assert.match(soakFailures({ ...quiet, messages: 0 })[0], /no ZMQ message arrived/)
  })
  it('lets only hashblock gaps account for blocks without a hashblock', () => {
    assert.equal(soakFailures({ ...quiet, uncovered: 2, hashblockMissed: 2 }).length, 0)
    assert.match(soakFailures({ ...quiet, uncovered: 3, hashblockMissed: 2 })[0], /hashblock gaps account for 2/)
    // A gap on another topic is not counted at all.
    assert.equal(soakFailures({ ...quiet, uncovered: 3 }).length, 1)
  })
  it('keeps the check on after a gap: an unsized one covers only the blocks while blind', () => {
    // Blind from block 100 (the last announced) to 103 (the next hashblock): a restart.
    const restart = [{ from: 100, to: 103 }]
    assert.equal(uncoveredBlocks([101, 102], restart), 0)
    // A block missed later in the soak is still found, after one unsized gap...
    assert.equal(uncoveredBlocks([101, 102, 150], restart), 1)
    assert.equal(soakFailures({ ...quiet, uncovered: uncoveredBlocks([101, 102, 150], restart) }).length, 1)
    // ...and after one sized gap, which covers its count and no more.
    assert.equal(soakFailures({ ...quiet, uncovered: uncoveredBlocks([150, 151], []), hashblockMissed: 1 }).length, 1)
    assert.equal(uncoveredBlocks([100, 104], restart), 2)
  })
  it('passes a late restart whose blocks no hashblock followed: blind to the end of the soak', () => {
    // A reconnect after block 200, a block found while qbitd was down, and the soak ended at 201.
    assert.equal(uncoveredBlocks([201], [{ from: 200, to: 201 }]), 0)
    assert.deepEqual(soakFailures({ ...quiet, uncovered: uncoveredBlocks([201], [{ from: 200, to: 201 }]) }), [])
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
