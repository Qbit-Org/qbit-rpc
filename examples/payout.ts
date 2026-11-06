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
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseQbt, QbitRpcClient, RpcError, RpcUnknownOutcomeError } from '@qbit-oss/rpc'

/** Confirmations either way before a payout is settled for good: a shallow reorg can reverse fewer. */
const FINAL = 6

/** A signed payout, as stored before it is broadcast, under the id of the payment request it pays. */
interface SignedPayout {
  readonly requestId: string
  readonly address: string
  readonly amountBits: bigint
  readonly txid: string
  readonly hex: string
}

type PayoutState = 'signed' | 'confirmed' | 'conflicted'

/** Where payouts are kept: implement it over your database. */
interface PayoutStore {
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
  settle(requestId: string, outcome: 'confirmed' | 'conflicted'): Promise<void>
}

/** A {@link PayoutStore} in a directory, one JSON file per payment request: enough for this example. */
function directoryStore(dir: string): PayoutStore {
  const file = (requestId: string): string => join(dir, `${encodeURIComponent(requestId)}.json`)
  type Stored = Omit<SignedPayout, 'amountBits'> & { readonly amountBits: string; readonly state: PayoutState }
  const parse = (stored: Stored): SignedPayout & { readonly state: PayoutState } => ({
    ...stored,
    amountBits: BigInt(stored.amountBits),
  })
  const read = async (path: string): Promise<Stored> => JSON.parse(await readFile(path, 'utf8')) as Stored
  // Written to a temporary file, flushed, then renamed over the record: a crash leaves the old record or the new one.
  const write = async (stored: Stored): Promise<void> => {
    const path = file(stored.requestId)
    await writeFile(`${path}.tmp`, JSON.stringify(stored), { flush: true })
    await rename(`${path}.tmp`, path)
  }
  return {
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
    options: { feeRateBitsPerKvB: 1_000n, changeType: 'p2mr' }, // 1 bit/vB
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

/** Send the stored hex again, which is harmless: the node keeps one copy, and refuses one it cannot accept. */
async function resend(rpc: QbitRpcClient, payout: SignedPayout): Promise<void> {
  // An unknown outcome again is reconciled on the next run; a refusal (RpcError) is for a person to look at.
  await rpc.sendRawTransaction(payout.hex)
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
): Promise<'pending' | 'confirmed' | 'conflicted'> {
  const known = await rpc.getTransaction(payout.txid).catch((error: unknown) => {
    if (RpcError.is(error) && error.rpcCode === -5) return undefined // not a transaction of this wallet
    throw error
  })
  if (known === undefined) {
    await resend(rpc, payout)
    return 'pending'
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
    if (!inMempool) await resend(rpc, payout)
  }
  return 'pending'
}

/** Broadcast a stored payout. A lost reply is reconciled by the stored txid, which is also the error's `txid`. */
async function broadcast(
  rpc: QbitRpcClient,
  store: PayoutStore,
  payout: SignedPayout
): Promise<'pending' | 'confirmed' | 'conflicted'> {
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
for (const payout of await store.unsettled()) console.log(payout.requestId, await reconcile(rpc, store, payout))
// A request already paid, or being paid, is never funded again: the run above reconciled it.
const existing = await store.get(requestId)
if (existing !== undefined) {
  if (existing.address !== address || existing.amountBits !== amountBits) {
    throw new Error(`request ${requestId} is already stored for another address or amount: use a new request id`)
  }
  console.log(requestId, existing.txid, existing.state === 'signed' ? 'pending' : existing.state)
} else {
  // One payout at a time: two funded at once could pick the same coins.
  const payout = await prepare(rpc, store, requestId, address, amountBits)
  console.log(requestId, payout.txid, await broadcast(rpc, store, payout))
}
rpc.close()
