// What scripts/verify-network.mjs reads from its environment and command line,
// what it may do with them, and how it writes its report, apart so
// scripts/network-verification.test.mjs can test them without a node.
// docs/network-verification.md describes the plan these serve.

/** The modes, and whether each starts its own regtest node from QBIT_BIN_DIR. */
export const MODES = {
  read: { ownNode: false },
  zmq: { ownNode: false },
  send: { ownNode: false },
  faults: { ownNode: true },
  regtest: { ownNode: true },
}

/**
 * The most `--send-amount` may be, in bits: 0.001 QBT. The send is to an
 * address of the same wallet, so it costs only the fee, which is capped at
 * {@link MAX_FEE_BITS}. Raise either only in a reviewed pull request.
 */
export const MAX_SEND_BITS = 100_000n
/** The most fee the send may pay, in bits: 0.001 QBT. */
export const MAX_FEE_BITS = 100_000n

const CHAINS = ['main', 'test', 'testnet4', 'signet', 'regtest']

// Configuration that must come from the environment: a flag of this name is
// refused with a pointer to the variable, so no URL, credential or path to one
// lands in shell history or a process listing.
const ENV_ONLY = {
  url: 'QBIT_RPC_URL',
  'rpc-url': 'QBIT_RPC_URL',
  user: 'QBIT_RPC_USER',
  username: 'QBIT_RPC_USER',
  password: 'QBIT_RPC_PASSWORD',
  cookie: 'QBIT_RPC_COOKIE_FILE',
  'cookie-file': 'QBIT_RPC_COOKIE_FILE',
  rpcuser: 'QBIT_RPC_USER',
  rpcpassword: 'QBIT_RPC_PASSWORD',
  wallet: 'QBIT_RPC_WALLET',
  'zmq-url': 'QBIT_ZMQ_URL',
  chain: 'QBIT_EXPECTED_CHAIN',
}

const FLAGS = ['blocks', 'duration', 'interval', 'send-amount', 'confirmations', 'report']

const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }

/** A duration such as `90s`, `10m` or `24h`, in milliseconds; a bare number is seconds. */
export function parseDuration(text, flag) {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(text ?? '')
  const ms = match === null ? Number.NaN : Number(match[1]) * UNITS[match[2] ?? 's']
  // Node's timers fire at once past 2^31-1 ms (24.8 days): a longer soak would end as it starts.
  if (!Number.isSafeInteger(ms) || ms > MAX_DURATION_MS) {
    throw new RangeError(
      `--${flag} must be a whole number of ms, s, m or h, at most 24 days, not ${JSON.stringify(text)}`
    )
  }
  return ms
}

/** The longest --duration or --interval: 24 days, under Node's timer limit of 2^31-1 ms. */
export const MAX_DURATION_MS = 24 * 24 * UNITS.h

/**
 * `text` with every one of `hidden` (a node's URL and host name) replaced, so
 * a report, which is committed to a public repository, never names a remote
 * node. Longer values first, so a URL is hidden whole before its host.
 */
export function hideAll(text, hidden) {
  const values = [...new Set(hidden)].filter(v => typeof v === 'string' && v !== '').sort((a, b) => b.length - a.length)
  if (values.length === 0) return String(text)
  // Whole tokens only, so 1.2.3.4 leaves 11.2.3.45 alone, and in one pass, so a placeholder is never
  // rewritten by a shorter value. A dot may follow: a host ends a sentence, or names a parent domain.
  const pattern = values.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return String(text).replace(new RegExp(`(?<![\\w-])(?:${pattern})(?![\\w-])`, 'g'), '<node address>')
}

/** A URL's host name, or undefined when it does not parse. */
export function hostOf(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host === '' ? undefined : host
  } catch {
    return undefined
  }
}

/**
 * How many of `heights`, blocks no `hashblock` announced, fall outside every
 * window `{ from, to }`: above `from` and at most `to`, where the subscriber
 * was blind after a reconnect or a `hashblock` gap of unknown size.
 */
export function uncoveredBlocks(heights, windows) {
  return heights.filter(height => !windows.some(({ from, to }) => height > from && height <= to)).length
}

/**
 * Why a ZMQ soak failed, if it did. Each new block must have had a
 * `hashblock`, or fall in a `hashblock` gap: one that says how many it
 * skipped covers that many, and one that cannot (a publisher restart, its
 * counter begun again) covers only the blocks while it was blind, which
 * `uncoveredBlocks` leaves out of `uncovered`. Gaps on other topics cover none.
 * And something must have arrived at all, and once blocks arrived, something
 * on every topic: each block publishes on all of them.
 */
export function soakFailures({
  messages,
  malformed,
  unknown,
  uncovered,
  hashblockMissed,
  counts = {},
  blocksSeen = 0,
}) {
  const failures = []
  if (messages === 0) failures.push('no ZMQ message arrived during the soak: check QBIT_ZMQ_URL and -zmqpub')
  if (blocksSeen > 0) {
    const silent = Object.entries(counts)
      .filter(([, count]) => count === 0)
      .map(([topic]) => topic)
    if (silent.length > 0)
      failures.push(`${blocksSeen} blocks arrived but nothing on ${silent.join(', ')}: check each -zmqpub<topic>`)
  }
  if (malformed > 0) failures.push(`${malformed} malformed ZMQ messages`)
  if (unknown > 0) failures.push(`${unknown} hashblock messages named a block the node does not know`)
  if (uncovered > hashblockMissed) {
    failures.push(
      `${uncovered} new blocks had no hashblock outside a reconnect, and hashblock gaps account for ${hashblockMissed}`
    )
  }
  return failures
}

function parseCount(text, flag, max) {
  if (!/^\d+$/.test(text ?? '') || Number(text) > max) {
    throw new RangeError(`--${flag} must be a whole number from 0 to ${max}, not ${JSON.stringify(text)}`)
  }
  return Number(text)
}

/**
 * The command line: a mode, then `--flag value` or `--flag=value` pairs, each
 * at most once. A flag naming a URL, credential, wallet or chain is refused:
 * those come from the environment only.
 */
export function parseArgs(argv) {
  const [mode, ...rest] = argv
  if (!Object.hasOwn(MODES, mode ?? '')) {
    throw new TypeError(`the first argument must be a mode: ${Object.keys(MODES).join(', ')}`)
  }
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(rest[i])
    if (match === null) throw new TypeError(`unexpected argument ${JSON.stringify(rest[i])}`)
    const [, name, inline] = match
    if (Object.hasOwn(ENV_ONLY, name)) {
      throw new TypeError(`--${name} is not taken on the command line: set ${ENV_ONLY[name]} in the environment`)
    }
    if (!FLAGS.includes(name)) throw new TypeError(`unknown flag --${name}; the flags are --${FLAGS.join(', --')}`)
    if (Object.hasOwn(flags, name)) throw new TypeError(`--${name} is given twice`)
    const value = inline ?? rest[++i]
    if (value === undefined) throw new TypeError(`--${name} needs a value`)
    flags[name] = value
  }
  const own = MODES[mode].ownNode
  const options = {
    mode,
    blocks: parseCount(flags.blocks ?? (own ? '300' : '2000'), 'blocks', 1_000_000),
    durationMs: parseDuration(flags.duration ?? (mode === 'zmq' ? '1h' : own ? '45s' : '0'), 'duration'),
    intervalMs: parseDuration(flags.interval ?? (own ? '5s' : '60s'), 'interval'),
    sendAmount: flags['send-amount'],
    confirmations: parseCount(flags.confirmations ?? '0', 'confirmations', 6),
    report: flags.report,
  }
  if (options.intervalMs < 1_000) throw new RangeError('--interval must be at least 1s')
  if (options.sendAmount !== undefined && mode !== 'send' && mode !== 'regtest') {
    throw new TypeError(`--send-amount applies to the send and regtest modes only, not ${mode}`)
  }
  if (flags.confirmations !== undefined && mode !== 'send')
    throw new TypeError('--confirmations applies to the send mode only')
  return options
}

/**
 * The node to verify, from the environment: `QBIT_RPC_URL`, either
 * `QBIT_RPC_COOKIE_FILE` or both `QBIT_RPC_USER` and `QBIT_RPC_PASSWORD`,
 * `QBIT_EXPECTED_CHAIN`, and for some modes `QBIT_ZMQ_URL`, `QBIT_RPC_WALLET`
 * and `QBIT_RPC_CA_FILE` (a PEM file of CAs for an https URL). Throws a
 * TypeError naming what is missing or contradictory, never a value.
 */
export function readNodeEnv(env, mode) {
  const get = name => (typeof env[name] === 'string' && env[name] !== '' ? env[name] : undefined)
  const url = get('QBIT_RPC_URL')
  if (url === undefined) throw new TypeError('set QBIT_RPC_URL to the node’s RPC URL')
  const cookieFile = get('QBIT_RPC_COOKIE_FILE')
  const username = get('QBIT_RPC_USER')
  const password = get('QBIT_RPC_PASSWORD')
  if (cookieFile !== undefined && (username !== undefined || password !== undefined)) {
    throw new TypeError('set either QBIT_RPC_COOKIE_FILE or QBIT_RPC_USER and QBIT_RPC_PASSWORD, not both')
  }
  if (cookieFile === undefined && (username === undefined || password === undefined)) {
    throw new TypeError('set QBIT_RPC_COOKIE_FILE, or both QBIT_RPC_USER and QBIT_RPC_PASSWORD')
  }
  const expectedChain = get('QBIT_EXPECTED_CHAIN')
  if (!CHAINS.includes(expectedChain)) {
    throw new TypeError(`set QBIT_EXPECTED_CHAIN to the node’s chain: ${CHAINS.join(', ')}`)
  }
  const zmqUrl = get('QBIT_ZMQ_URL')
  if (mode === 'zmq' && zmqUrl === undefined) throw new TypeError('set QBIT_ZMQ_URL for the zmq mode')
  const wallet = get('QBIT_RPC_WALLET')
  if (mode === 'send' && wallet === undefined)
    throw new TypeError('set QBIT_RPC_WALLET to the wallet the send mode spends from')
  return {
    url,
    auth: cookieFile !== undefined ? { cookieFile } : { username, password },
    expectedChain,
    zmqUrl,
    wallet,
    caFile: get('QBIT_RPC_CA_FILE'),
  }
}

/**
 * The capabilities a mode's client gets, and the amount it may send. read and
 * zmq get none, so no wallet-write or broadcast call can be made. send gets
 * wallet-read, wallet-write and broadcast only with `--send-amount`, a QBT
 * amount `parseQbt` (the package's own parser) reads, above 0 and at most
 * {@link MAX_SEND_BITS}: on mainnet as anywhere. faults and regtest run only
 * on the regtest node they start.
 */
export function sendPolicy({ mode, chain, sendAmount }, parseQbt) {
  if (MODES[mode].ownNode && chain !== 'regtest') {
    throw new TypeError(`the ${mode} mode runs on its own regtest node only, not on ${chain}`)
  }
  if (sendAmount === undefined) {
    if (mode === 'send')
      throw new TypeError('the send mode needs --send-amount <QBT>: no wallet-write call is made without it')
    return { capabilities: mode === 'faults' ? ['wallet-read', 'wallet-write', 'broadcast'] : [], sendBits: undefined }
  }
  let bits
  try {
    bits = parseQbt(sendAmount)
  } catch {
    throw new RangeError('--send-amount must be a QBT amount such as 0.0001, with at most 8 decimals')
  }
  if (bits <= 0n || bits > MAX_SEND_BITS) {
    throw new RangeError(`--send-amount must be above 0 and at most ${formatBits(MAX_SEND_BITS)} QBT`)
  }
  return { capabilities: ['wallet-read', 'wallet-write', 'broadcast'], sendBits: bits }
}

/** Bits as a QBT decimal with 8 places, without the package's formatter. */
export function formatBits(bits) {
  const sign = bits < 0n ? '-' : ''
  const abs = bits < 0n ? -bits : bits
  return `${sign}${abs / 100_000_000n}.${String(abs % 100_000_000n).padStart(8, '0')}`
}

/**
 * What the report says about an RPC URL: whether it is loopback, and its
 * scheme. The host of a remote node is not written down: the report is
 * committed to a public repository.
 */
export function describeEndpoint(url) {
  const { protocol, hostname } = new URL(url)
  const host = hostname.replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host) || /^::ffff:127\./i.test(host)
  return `${loopback ? 'loopback' : 'remote'} ${protocol.replace(':', '')}`
}

/** `value` at a validation error's `path` (`result.vout[0].value`) in a raw reply, or undefined. */
export function valueAtPath(raw, path) {
  const parts = path.match(/[^.[\]]+|\[\d+\]/g) ?? []
  if (parts[0] !== 'result') return undefined
  let value = raw
  for (const part of parts.slice(1)) {
    const key = part.startsWith('[') ? Number(part.slice(1, -1)) : part
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = value[key]
  }
  return value
}

/** A short, single-line rendering of a reply value for the report, with big numbers kept exact. */
export function preview(value, max = 200) {
  let text
  try {
    text = JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v))
  } catch {
    text = String(value)
  }
  text ??= String(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** `YYYY-MM-DD` in UTC. */
export const utcDate = date => date.toISOString().slice(0, 10)

/** The default report path, under docs/network-reports/: `<date>-<chain>-<mode>.md`. */
export const defaultReportPath = (date, chain, mode) => `docs/network-reports/${utcDate(date)}-${chain}-${mode}.md`

const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')

/**
 * The report as Markdown: a summary, one table per check, the failures, and
 * the full record as JSON. `report` holds no secret: the URL is described,
 * not written, and credentials are never read into it.
 */
export function renderReport(report) {
  const lines = [
    `# Network verification: ${report.mode} on ${report.chain}`,
    '',
    `Result: **${report.passed ? 'PASS' : 'FAIL'}**, ${report.failures.length} failures.`,
    '',
    '| | |',
    '| --- | --- |',
    ...Object.entries(report.summary).map(([key, value]) => `| ${cell(key)} | ${cell(value)} |`),
    '',
  ]
  for (const section of report.sections) {
    lines.push(`## ${section.title}`, '')
    if (section.text) lines.push(section.text, '')
    if (section.rows.length > 0) {
      const columns = Object.keys(section.rows[0])
      lines.push(`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`)
      for (const row of section.rows) lines.push(`| ${columns.map(column => cell(row[column] ?? '')).join(' | ')} |`)
      lines.push('')
    }
  }
  lines.push('## Failures', '')
  if (report.failures.length === 0) lines.push('None.', '')
  for (const failure of report.failures) lines.push(`- ${failure}`)
  if (report.failures.length > 0) lines.push('')
  lines.push(
    '## Record',
    '',
    '```json',
    JSON.stringify(report.record, (_key, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    '```',
    ''
  )
  return lines.join('\n')
}
