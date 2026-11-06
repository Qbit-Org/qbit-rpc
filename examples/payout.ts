// A minimal illustration of the calls a payout makes, not a payout system.
// Idempotent payouts in production belong in `@qbit-oss/payments`.
//
// A payout from a testnet4 wallet: fund a PSBT, check the PQC signature budget
// of every key it spends from, sign, store the signed transaction, and only then
// broadcast it. Each payout is stored under the id of the payment request it
// pays, so running the same request again, after a crash or a lost reply
// (RpcUnknownOutcomeError), reconciles the stored transaction by its txid and
// never pays again.
//
//   QBIT_COOKIE_FILE=<the node's .cookie> node payout.ts <request id> <address> <amount in QBT>
//
// See docs/rpc/payments.md. CI type-checks this file against the packed packages.
import { mkdir, open, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseQbt, QbitRpcClient, RpcError, RpcUnknownOutcomeError } from '@qbit-oss/rpc'

/** Confirmations either way before a payout is settled for good: a shallow reorg can reverse fewer. */
const FINAL = 6

/** A signed payout, as stored before it is broadcast, under the id of the payment request it pays. */
export interface SignedPayout {
  readonly requestId: string
  readonly address: string
  readonly amountBits: bigint
  readonly txid: string
  readonly hex: string
}

/** `refused`: the node refused the stored transaction and the wallet does not know it, so it paid nothing; a person decides. */
export type PayoutState = 'signed' | 'confirmed' | 'conflicted' | 'refused'

/** Where payouts are kept: implement it over your database. */
export interface PayoutStore {
  /**
   * Claim a payment request before it is funded, once and atomically: false when another run claimed
   * it, so two runs at once can never both pay it.
   */
  claim(requestId: string): Promise<boolean>
  /** The payout stored for a payment request, settled or not. */
  get(requestId: string): Promise<(SignedPayout & { readonly state: PayoutState }) | undefined>
  /** Store a signed payout. It must be durable once this resolves: a lost reply, or a crash, is reconciled from it. */
  saveSigned(payout: SignedPayout): Promise<void>
  /** The payouts stored and not yet settled. */
  unsettled(): Promise<SignedPayout[]>
  /**
   * Settle a payout: confirmed in a block, or conflicted (a transaction spending
   * the same coins was mined instead), each at FINAL confirmations.
   */
  settle(requestId: string, outcome: Exclude<PayoutState, 'signed'>): Promise<void>
}

/** A {@link PayoutStore} in a directory, one JSON file per payment request: enough for this example. */
export function directoryStore(dir: string): PayoutStore {
  // Hex, so request ids that differ only in case stay apart on a case-insensitive file system.
  const file = (requestId: string): string => join(dir, `${Buffer.from(requestId, 'utf8').toString('hex')}.json`)
  type Stored = Omit<SignedPayout, 'amountBits'> & { readonly amountBits: string; readonly state: PayoutState }
  const parse = (stored: Stored): SignedPayout & { readonly state: PayoutState } => ({
    ...stored,
    amountBits: BigInt(stored.amountBits),
  })
  const read = async (path: string): Promise<Stored> => JSON.parse(await readFile(path, 'utf8')) as Stored
  // Written to a temporary file, flushed, then renamed over the record: a crash leaves the old record or the new one.
  const write = async (stored: Stored): Promise<void> => {
    const path = file(stored.requestId)
    // A temporary file of its own, so two runs writing one record at once do not take each other's.
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(stored), { flush: true })
    await rename(temporary, path)
    // The rename itself is durable once the directory is flushed; not every platform can open one.
    await open(dir, 'r').then(
      handle => handle.sync().finally(() => handle.close()),
      () => undefined
    )
  }
  return {
    async claim(requestId) {
      await mkdir(dir, { recursive: true })
      // 'wx': created only if it does not exist yet, which the file system decides once.
      const claimed = await open(`${file(requestId)}.claim`, 'wx').then(
        handle => handle.close().then(() => true),
        (error: unknown) => {
          if ((error as { code?: unknown }).code === 'EEXIST') return false
          throw error
        }
      )
      return claimed
    },
    async get(requestId) {
      const stored = await read(file(requestId)).catch(() => undefined)
      return stored === undefined ? undefined : parse(stored)
    },
    async saveSigned(payout) {
      await mkdir(dir, { recursive: true })
      await write({ ...payout, amountBits: payout.amountBits.toString(), state: 'signed' })
    },
    async unsettled() {
      const names = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.json'))
      const stored = await Promise.all(names.map(name => read(join(dir, name))))
      return stored.filter(payout => payout.state === 'signed').map(parse)
    },
    async settle(requestId, outcome) {
      await write({ ...(await read(file(requestId))), state: outcome })
    },
  }
}

/** Fund, check, sign and store a payout. Nothing is broadcast yet. */
async function prepare(
  rpc: QbitRpcClient,
  store: PayoutStore,
  requestId: string,
  address: string,
  amountBits: bigint
): Promise<SignedPayout> {
  const funded = await rpc.walletCreateFundedPsbt({
    outputs: [{ address, amountBits }],
    // Locked, so a run paying another request at the same time funds from other coins.
    options: { feeRateBitsPerKvB: 1_000n, changeType: 'p2mr', lockUnspents: true }, // 1 bit/vB
  })
  // An exhausted PQC key signs nothing and raises no error, so count first what signing takes from each key.
  const plan = await rpc.checkPqcSigning(funded.psbt) // PqcSigningError if a PQC key cannot sign each input it holds
  for (const warning of plan.warnings) console.warn(warning) // a critical key: move its coins on now
  // Each signature counts against its key's budget, broadcast or not: never sign the same payout twice.
  const signed = await rpc.walletProcessPsbt(funded.psbt) // checks again first, by default
  if (!signed.complete || signed.hex === undefined) throw new Error('the wallet did not sign every input')
  const [preflight] = await rpc.testMempoolAccept([signed.hex])
  if (preflight?.allowed !== true) throw new Error(`the mempool would refuse it: ${preflight?.rejectReason}`)
  const payout = { requestId, address, amountBits, txid: preflight.txid, hex: signed.hex }
  await store.saveSigned(payout)
  return payout
}

/**
 * Send the stored hex again, which is harmless: the node keeps one copy, and refuses one it cannot accept.
 * Returns the node's refusal (RpcError); an unknown outcome again is reconciled on the next run.
 */
async function resend(rpc: QbitRpcClient, payout: SignedPayout): Promise<RpcError | undefined> {
  return rpc.sendRawTransaction(payout.hex).then(
    () => undefined,
    (error: unknown) => {
      if (RpcError.is(error)) return error
      throw error
    }
  )
}

/**
 * Where a stored payout stands, from the wallet's view of its txid. When the
 * wallet does not know the transaction, or knows it but it is in no block and
 * not in the mempool, the stored hex is sent again, which is harmless where
 * building the payment again would pay twice. A payout settles only at FINAL
 * confirmations either way.
 */
async function reconcile(
  rpc: QbitRpcClient,
  store: PayoutStore,
  payout: SignedPayout
): Promise<Exclude<PayoutState, 'signed'> | 'pending'> {
  const known = await rpc.getTransaction(payout.txid).catch((error: unknown) => {
    if (RpcError.is(error) && error.rpcCode === -5) return undefined // not a transaction of this wallet
    throw error
  })
  if (known === undefined) {
    const refusal = await resend(rpc, payout)
    if (refusal === undefined) return 'pending'
    // The wallet never had it and the node will not take it: it paid nothing, and is not tried again.
    console.error(
      `${payout.requestId}: ${payout.txid} refused (${refusal.message}): check before paying this request another way`
    )
    await store.settle(payout.requestId, 'refused')
    return 'refused'
  }
  if (known.confirmations >= FINAL) {
    await store.settle(payout.requestId, 'confirmed')
    return 'confirmed'
  }
  if (known.confirmations <= -FINAL) {
    // A transaction spending the same coins is FINAL deep. If it is a fee bump of this payout, the
    // recipient was paid: check walletConflicts before paying this request again.
    await store.settle(payout.requestId, 'conflicted')
    return 'conflicted'
  }
  if (known.confirmations === 0) {
    // The wallet keeps a transaction the mempool evicted or a restarted node did not reload.
    const inMempool = await rpc.getMempoolEntry(payout.txid).then(
      () => true,
      (error: unknown) => {
        if (RpcError.is(error) && error.rpcCode === -5) return false
        throw error
      }
    )
    if (!inMempool) {
      const refusal = await resend(rpc, payout)
      // The wallet has it: a refusal now (an input spent elsewhere) shows as negative confirmations later.
      if (refusal !== undefined) console.warn(`${payout.requestId}: ${payout.txid} not taken back: ${refusal.message}`)
    }
  }
  return 'pending'
}

/** Broadcast a stored payout. A lost reply is reconciled by the stored txid, which is also the error's `txid`. */
async function broadcast(
  rpc: QbitRpcClient,
  store: PayoutStore,
  payout: SignedPayout
): Promise<Exclude<PayoutState, 'signed'> | 'pending'> {
  try {
    await rpc.sendRawTransaction(payout.hex)
    return 'pending'
  } catch (error) {
    // Anything else is definite: refused before sending, or the node's own answer (RpcError).
    if (!RpcUnknownOutcomeError.is(error)) throw error
    console.warn(`${payout.txid}: the node may have it (${error.message}): reconciling`)
    return reconcile(rpc, store, payout)
  }
}

async function main(): Promise<void> {
  const [requestId, address, amount] = process.argv.slice(2)
  const cookieFile = process.env.QBIT_COOKIE_FILE
  if (requestId === undefined || address === undefined || amount === undefined || cookieFile === undefined) {
    throw new Error('usage: QBIT_COOKIE_FILE=<the node .cookie> node payout.ts <request id> <address> <amount in QBT>')
  }
  const amountBits = parseQbt(amount)
  const rpc = new QbitRpcClient({
    url: 'http://127.0.0.1:48352/', // testnet4's RPC port
    wallet: 'payouts',
    auth: { cookieFile },
    expectedChain: 'testnet4',
    capabilities: ['wallet-read', 'wallet-write', 'broadcast'],
  })
  const store = directoryStore('payouts')

  await rpc.confirmChain() // wallet-write and broadcast calls are refused until this matches
  // First what an earlier run left: stored, and perhaps never sent (a crash, a lost reply).
  // One that fails is reported, and the others are still reconciled.
  for (const payout of await store.unsettled()) {
    await reconcile(rpc, store, payout).then(
      outcome => console.log(payout.requestId, outcome),
      (error: unknown) => console.error(`${payout.requestId}: not reconciled this time:`, error)
    )
  }
  // A request already paid, or being paid, is never funded again: the run above reconciled it.
  const existing = await store.get(requestId)
  if (existing !== undefined) {
    if (existing.address !== address || existing.amountBits !== amountBits) {
      throw new Error(`request ${requestId} is already stored for another address or amount: use a new request id`)
    }
    console.log(requestId, existing.txid, existing.state === 'signed' ? 'pending' : existing.state)
  } else {
    // Claimed before funding: a second run of this request at the same time stops here.
    if (!(await store.claim(requestId))) {
      throw new Error(
        `request ${requestId} is claimed but has no stored payout: another run is paying it, or one stopped before storing it. Check the wallet before removing its .claim file`
      )
    }
    // One payout at a time: two funded at once could pick the same coins.
    const payout = await prepare(rpc, store, requestId, address, amountBits)
    console.log(requestId, payout.txid, await broadcast(rpc, store, payout))
  }
  rpc.close()
}

// Run when started as a program; a test imports the store without running it.
// Node names the main module by its real path, so compare against the argument's, symlinks resolved.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main()
