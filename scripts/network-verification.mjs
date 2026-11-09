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
  // Host names and IPv6 hex ignore case, and hostOf lowercases what it returns.
  return String(text).replace(new RegExp(`(?<![\\w-])(?:${pattern})(?![\\w-])`, 'gi'), '<node address>')
}

/**
 * A URL's host name, or undefined when it has none. When the URL does not
 * parse (`tcp://[node.example.com]`), the text between `//` and the port or
 * path, so a malformed address is hidden too.
 */
export function hostOf(url) {
  let host
  try {
    host = new URL(url).hostname
  } catch {
    host = /^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?(\[[^\]/]*\]|[^:/?#]*)/i.exec(String(url))?.[1]
  }
  host = host?.replace(/^\[|\]$/g, '')
  return host === undefined || host === '' ? undefined : host
}

/**
 * A ZMQ soak's block accounting, fed the subscriber's events in order: the
 * blocks it was told of, and where it was blind. qbitd sends one `hashblock`
 * per tip update, so blocks connected together (a catch-up or a reorg) have
 * one only for the last; `sequence`'s `block_connected` names each of them.
 *
 * A blind window runs from the last block named to the next one, and covers
 * exactly the blocks connected in between: the ancestors of its closing block
 * above where that block's chain meets its opening block's. Two kinds open:
 * - after a reconnect or an unsized `hashblock` gap, from the last `hashblock`
 *   (undefined: the start) to the next, or to the end of the soak when none
 *   came;
 * - after a `sequence` gap, from the last `block_connected` to the tip when
 *   the latest gap was reported: lost `sequence` messages can be blocks' as
 *   well as the mempool's, which share its counter, and they came before the
 *   gap was reported. A gap excuses at most as many blocks as it says it
 *   lost, less one for each block whose `hashblock` came after that last
 *   `block_connected` (or after the counter's baseline) without its own; a gap
 *   that cannot say excuses none, as the reconnect it comes with has a window
 *   of its own. Without the tip at the gap, it excuses none.
 * A block no message named passes only inside a window. A sized `hashblock`
 * gap excuses none: the block whose `hashblock` was lost is still named by its
 * `block_connected`, unless `sequence` lost it too, which a `sequence` gap
 * reports. Set `started` once the soak's first tip is fixed: a reconnect
 * before it hides no block the walk counts.
 */
export class BlockAccounting {
  announced = new Set()
  connected = new Set()
  blind = []
  hashblockMissed = 0
  hashblockUnsizedGaps = 0
  sequenceGaps = 0
  started = false
  #hashblockWindow = { open: false, from: undefined, limit: Infinity }
  #sequenceWindow = { open: false, from: undefined, limit: 0, tip: undefined, since: 0 }
  #lastAnnounced
  #lastConnected
  /** The order each block's hashblock came in, and how many had come at the last block_connected and at
   * the first sequence message: a gap counts only losses after its window's start. */
  #announcedAt = new Map()
  #announcedAtLastConnected
  #announcedAtSequenceBaseline

  /** How many blocks any message named: a missing `hashblock` publisher must not turn off the check on topics. */
  get seen() {
    return new Set([...this.announced, ...this.connected]).size
  }

  /** Opens `window` from `from`, or widens the allowance of one open: `limit` more blocks it may excuse. */
  #open(window, from, limit = Infinity) {
    if (window.open) window.limit += limit
    else Object.assign(window, { open: true, from, limit })
  }

  #ended = false

  /** Called once the soak has read its last tip: a window closed after it closed in the end grace. */
  ended() {
    this.#ended = true
  }

  #closeHashblock(to) {
    const window = this.#hashblockWindow
    if (window.open) this.blind.push({ from: window.from, to, limit: Infinity, since: -Infinity, late: this.#ended })
    window.open = false
  }

  /** A sequence window ends at the tip when its latest gap was reported, whatever block_connected closes it. */
  #closeSequence() {
    const window = this.#sequenceWindow
    if (window.open && window.tip !== undefined) {
      this.blind.push({ from: window.from, to: window.tip, limit: window.limit, since: window.since })
    }
    Object.assign(window, { open: false, tip: undefined })
  }

  message(message) {
    if (message.topic === 'sequence' && this.#announcedAtSequenceBaseline === undefined) {
      this.#announcedAtSequenceBaseline = this.#announcedAt.size
    }
    if (message.topic === 'sequence' && message.event === 'block_connected') {
      this.#closeSequence()
      this.connected.add(message.hash)
      this.#lastConnected = message.hash
      this.#announcedAtLastConnected = this.#announcedAt.size
    }
    if (message.topic !== 'hashblock') return
    this.#closeHashblock(message.hash)
    this.announced.add(message.hash)
    if (!this.#announcedAt.has(message.hash)) this.#announcedAt.set(message.hash, this.#announcedAt.size)
    this.#lastAnnounced = message.hash
  }

  /**
   * `tip`: for a `sequence` gap, the chain's tip when it was reported. The
   * messages it lost came before it, so a window still open at the end
   * covers blocks up to that tip, not the soak's last.
   */
  gap(event, tip) {
    if (event.topic === 'sequence') {
      this.sequenceGaps++
      const window = this.#sequenceWindow
      if (!window.open) window.since = this.#announcedAtLastConnected ?? this.#announcedAtSequenceBaseline ?? 0
      this.#open(window, this.#lastConnected, event.missed ?? 0)
      if (tip !== undefined) window.tip = tip
      return
    }
    if (event.topic !== 'hashblock') return
    if (event.missed !== undefined) this.hashblockMissed += event.missed
    else {
      this.hashblockUnsizedGaps++
      this.#open(this.#hashblockWindow, this.#lastAnnounced)
    }
  }

  /** Blocks found while it is down are never announced, and no hashblock may come before the end to say so. */
  reconnect() {
    if (this.started) this.#open(this.#hashblockWindow, this.#lastAnnounced)
  }

  /**
   * Walks the active chain back from `lastTip` to `startTip`. `chain` gives
   * `header(hash)` ({ height, previousBlockHash }), async, for any block the
   * node has, on the active chain or not. Returns how many blocks it walked,
   * how many no message named, how many of those fell outside every blind
   * window, and each window as the heights it spans: from where its two ends'
   * chains meet to its closing block.
   */
  async settle(source, { startTip, startHeight, lastTip }) {
    // One getblockheader per distinct block for the whole settle: windows walk the same ancestry again.
    const headers = new Map()
    const chain = {
      header: hash => {
        if (!headers.has(hash)) headers.set(hash, source.header(hash))
        return headers.get(hash)
      },
    }
    const unnamed = []
    const onTip = new Set()
    let walked = 0
    for (let hash = lastTip; hash !== undefined && hash !== startTip; walked++) {
      const header = await chain.header(hash)
      if (header.height <= startHeight || header.previousBlockHash === undefined) break
      onTip.add(hash)
      if (!this.announced.has(hash) && !this.connected.has(hash)) unnamed.push(hash)
      hash = header.previousBlockHash
    }
    // `from`'s ancestors since the start: where the chain `to` is on meets it.
    const ancestors = async from => {
      const seen = new Set()
      for (let at = from; at !== undefined && at !== startTip;) {
        const header = await chain.header(at)
        if (header.height <= startHeight) break
        seen.add(at)
        at = header.previousBlockHash
      }
      return seen
    }
    const covered = new Set()
    const windows = []
    // A reconnect's window still open runs to the end. A sequence gap's runs to the tip when the latest
    // gap was reported, with its cap: the blocks it lost connected by then, and no later one is excused.
    const open = []
    if (this.#hashblockWindow.open) {
      open.push({ from: this.#hashblockWindow.from, to: lastTip, limit: Infinity, since: -Infinity })
    }
    const sequence = this.#sequenceWindow
    if (sequence.open && sequence.tip !== undefined) {
      open.push({ from: sequence.from, to: sequence.tip, limit: sequence.limit, since: sequence.since })
    }
    // A reconnect's window closed by a block off the final chain (a reorg in the end grace, after lastTip
    // was read) leaves the blind blocks on lastTip's chain: it covers those too.
    const offTip = this.blind
      .filter(w => w.late === true && w.to !== lastTip && !onTip.has(w.to))
      .map(w => ({ ...w, to: lastTip }))
    const unnamedSet = new Set(unnamed)
    for (const { from, to, limit, since } of [...this.blind, ...open, ...offTip]) {
      if (to === undefined) continue
      const meets = from === undefined ? new Set() : await ancestors(from)
      let fork = startHeight
      // Back from `to` to the first block on `from`'s chain (`from` itself when no reorg came between).
      const segment = []
      for (let at = to; at !== undefined && at !== startTip;) {
        const header = await chain.header(at)
        if (meets.has(at)) {
          fork = header.height
          break
        }
        if (header.height <= startHeight) break
        segment.push(at)
        at = header.previousBlockHash
      }
      // A sized gap's lost messages first account for the blocks whose hashblock came but whose
      // block_connected did not; what is left excuses unnamed blocks, the nearest to its end first.
      // Only a loss after the window's start counts against it: a hashblock that came before was not this gap's.
      const charged = segment.filter(
        hash => !this.connected.has(hash) && (this.#announcedAt.get(hash) ?? -Infinity) >= since
      ).length
      let allowance = limit - charged
      for (const hash of segment) {
        if (allowance <= 0) break
        if (unnamedSet.has(hash)) {
          covered.add(hash)
          allowance--
        }
      }
      windows.push({ from: fork, to: (await chain.header(to)).height })
    }
    const uncovered = unnamed.filter(hash => !covered.has(hash)).length
    return { walked, unannounced: unnamed.length, uncovered, windows }
  }
}

/**
 * Why a ZMQ soak failed, if it did. Each new block must have been named, by
 * a `hashblock` or a `sequence` `block_connected`, or fall in a blind window
 * (see `BlockAccounting`): `uncovered` counts those that did neither. And
 * something must have arrived at all, and once blocks arrived, something on
 * every topic: each block publishes on all of them.
 */
export function soakFailures({ messages, malformed, unknown, uncovered, counts = {}, blocksSeen = 0 }) {
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
  if (uncovered > 0) {
    failures.push(`${uncovered} new blocks no hashblock or block_connected named, outside a reconnect or a gap`)
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
