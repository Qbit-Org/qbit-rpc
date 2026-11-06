// Credit deposits to a testnet4 wallet: ZMQ wakes the watcher, RPC says what
// happened. Each wake-up runs the same sync from a stored cursor
// (`listsinceblock`), and so does each gap or reconnect in the notifications,
// so a lost notification delays a deposit and never loses it. A deposit is
// credited once its transaction has the confirmations `getconfirmationtarget`
// asks for the transaction's total to the wallet. A reorg can undo either
// outcome: a conflicted deposit stays watched, and a credited one whose block
// left the chain is checked again.
//
//   qbitd -testnet4 -zmqpubhashblock=tcp://127.0.0.1:28332 -zmqpubhashtx=tcp://127.0.0.1:28332
//   QBIT_COOKIE_FILE=<the node's .cookie> node deposit-watcher.ts
//
// See docs/zmq/messages.md#gaps. CI type-checks this file against the packed packages.
import { QbitRpcClient, requests } from '@qbit-oss/rpc'
import { QbitZmqSubscriber, ZmqSetupError } from '@qbit-oss/zmq'

/** One output paying the wallet. */
interface Deposit {
  readonly txid: string
  readonly vout: number
  readonly address: string
  readonly amountBits: bigint
}

/** Where the watcher keeps its state: implement it over your database. */
interface DepositStore {
  /** The `lastBlock` of the last sync, or undefined before the first. */
  cursor(): Promise<string | undefined>
  /**
   * Record a sync's deposits and the next cursor, in one database transaction:
   * each deposit once by `txid` and `vout`, and one already settled as
   * conflicted opens again, as a reorg can bring it back.
   */
  record(seen: readonly Deposit[], cursor: string): Promise<void>
  /** The deposits not credited: pending, or conflicted and so still watched. */
  open(): Promise<Deposit[]>
  /** Credit a deposit, or mark it conflicted: a conflicting transaction is mined instead. */
  settle(deposit: Deposit, outcome: 'credited' | 'conflicted'): Promise<void>
  /** Open a credited deposit again, as its block left the chain; whether it had been credited. */
  reopen(txid: string, vout: number): Promise<boolean>
}

/** Requests per batch, under the client's limit of 1,000. */
const CHUNK = 500

function chunks<T>(items: readonly T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK))
}

async function sync(rpc: QbitRpcClient, store: DepositStore, signal: AbortSignal): Promise<void> {
  // Reads need no chain check, but crediting from the wrong chain would be worse than a delay.
  await rpc.confirmChain({ signal })
  const cursor = await store.cursor()
  const history = await rpc.listSinceBlock(cursor === undefined ? {} : { blockHash: cursor }, { signal })
  // Blocks after the cursor left the active chain: a deposit credited in one is checked again.
  for (const entry of history.removed ?? []) {
    if (entry.category === 'receive' && (await store.reopen(entry.txid, entry.vout))) {
      console.error(`${entry.txid}:${entry.vout} was credited, and its block left the chain: checking it again`)
    }
  }
  const seen = history.transactions.flatMap(entry =>
    entry.category === 'receive' && entry.address !== undefined
      ? [{ txid: entry.txid, vout: entry.vout, address: entry.address, amountBits: entry.amountBits }]
      : []
  )
  await store.record(seen, history.lastBlock)

  // One payment can arrive as several outputs: its confirmation target is for their total.
  const byTxid = new Map<string, Deposit[]>()
  for (const deposit of await store.open()) byTxid.set(deposit.txid, [...(byTxid.get(deposit.txid) ?? []), deposit])
  for (const txids of chunks([...byTxid.keys()])) {
    const totals = txids.map(txid => byTxid.get(txid)!.reduce((sum, deposit) => sum + deposit.amountBits, 0n))
    const transactions = await rpc.batch(
      txids.map(txid => requests.getTransaction(txid)),
      { signal }
    )
    const targets = await rpc.batch(
      totals.map(total => requests.getConfirmationTarget(total, { securityLevel: 'high' })),
      { signal }
    )
    for (const [i, txid] of txids.entries()) {
      const transaction = transactions[i]
      const target = targets[i]
      // One entry that fails holds back its own deposits only, until a later sync.
      if (transaction?.ok !== true || target?.ok !== true) {
        const error = transaction?.ok === false ? transaction.error : target?.ok === false ? target.error : 'no reply'
        console.error(`${txid}: not settled this time:`, error)
        continue
      }
      const { confirmations } = transaction.value
      const required = target.value.requiredConfirmations
      for (const deposit of byTxid.get(txid)!) {
        // Either outcome waits for the same depth: a shallow reorg can reverse it.
        if (confirmations >= required) await store.settle(deposit, 'credited')
        else if (confirmations <= -required) await store.settle(deposit, 'conflicted')
      }
    }
  }
}

/** A {@link DepositStore} in memory, for trying the watcher out: a restart forgets every deposit. */
function memoryStore(): DepositStore {
  let last: string | undefined
  const deposits = new Map<string, { deposit: Deposit; state: 'pending' | 'credited' | 'conflicted' }>()
  const key = (txid: string, vout: number): string => `${txid}:${vout}`
  return {
    async cursor() {
      return last
    },
    async record(seen, cursor) {
      for (const deposit of seen) {
        const entry = deposits.get(key(deposit.txid, deposit.vout))
        if (entry === undefined) deposits.set(key(deposit.txid, deposit.vout), { deposit, state: 'pending' })
        else if (entry.state === 'conflicted') entry.state = 'pending'
      }
      last = cursor
    },
    async open() {
      return [...deposits.values()].filter(entry => entry.state !== 'credited').map(entry => entry.deposit)
    },
    async settle(deposit, outcome) {
      const entry = deposits.get(key(deposit.txid, deposit.vout))
      if (entry === undefined || entry.state === outcome || entry.state === 'credited') return
      entry.state = outcome
      console.log(`${deposit.txid}:${deposit.vout} ${outcome}: ${deposit.amountBits} bits to ${deposit.address}`)
    },
    async reopen(txid, vout) {
      const entry = deposits.get(key(txid, vout))
      if (entry?.state !== 'credited') return false
      entry.state = 'pending'
      return true
    },
  }
}

const cookieFile = process.env.QBIT_COOKIE_FILE
if (cookieFile === undefined) throw new Error('usage: QBIT_COOKIE_FILE=<the node .cookie> node deposit-watcher.ts')
const rpc = new QbitRpcClient({
  url: 'http://127.0.0.1:48352/', // testnet4's RPC port
  wallet: 'deposits',
  auth: { cookieFile },
  expectedChain: 'testnet4',
  capabilities: ['wallet-read'],
})
const zmq = new QbitZmqSubscriber({ url: 'tcp://127.0.0.1:28332', topics: ['hashblock', 'hashtx'] })
const store = memoryStore()
const stop = new AbortController()

// One sync at a time; a wake-up during one runs another after it.
let running: Promise<void> | undefined
let again = false
function wake(): void {
  if (running !== undefined) {
    again = true
    return
  }
  running = (async () => {
    do {
      again = false
      await sync(rpc, store, stop.signal).catch((error: unknown) => {
        if (!stop.signal.aborted) console.error('sync failed, retried at the next wake-up:', error)
      })
    } while (again && !stop.signal.aborted)
  })().finally(() => {
    running = undefined
  })
}

// ZMQ is a wake-up, not a ledger: without notifications (qbitd down, a topic
// not enabled), a sync a minute still finds every deposit.
const timer = setInterval(() => {
  if (zmq.health().status !== 'receiving') console.warn('ZMQ', zmq.health())
  wake()
}, 60_000)
process.once('SIGINT', () => {
  stop.abort()
  clearInterval(timer)
  zmq.close()
})

wake()
try {
  for await (const event of zmq) {
    // A gap lost notifications, and a reconnect lost those published meanwhile:
    // the sync from the stored cursor finds what they announced.
    if (event.kind === 'message' || event.kind === 'gap' || event.kind === 'reconnect') wake()
    else console.warn('malformed notification:', event.error.code)
  }
} catch (error) {
  // A setup problem that retrying cannot fix, such as zeromq not installed.
  if (ZmqSetupError.is(error)) console.error(error.code, error.message)
  throw error
} finally {
  clearInterval(timer)
  await running
  rpc.close()
}
