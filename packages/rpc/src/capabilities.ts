/** A chain name as `getblockchaininfo.chain` reports it (qbit Core v1.0.0 `LIST_CHAIN_NAMES`). */
export type QbitChain = 'main' | 'test' | 'testnet4' | 'signet' | 'regtest'

export const QBIT_CHAINS: readonly QbitChain[] = ['main', 'test', 'testnet4', 'signet', 'regtest']

/**
 * A capability a client must opt into. Without any, a client can only call
 * read methods that touch no wallet.
 *
 * - `wallet-read`: read wallet state (`getwalletinfo`, `gettransaction`, `listunspent`, ...).
 * - `wallet-write`: change wallet state or sign (`walletcreatefundedpsbt`,
 *   `walletprocesspsbt`, `walletpassphrase`, `walletlock`, ...).
 * - `broadcast`: `testmempoolaccept` and `sendrawtransaction`.
 */
export type Capability = 'wallet-read' | 'wallet-write' | 'broadcast'

export const CAPABILITIES: readonly Capability[] = ['wallet-read', 'wallet-write', 'broadcast']

/** How the client treats a method: what it needs, and whether a call can change node or wallet state. */
export interface MethodPolicy {
  /** `read` needs no capability. */
  readonly capability: 'read' | Capability
  /**
   * True when a call can change state (sign, lock coins, take a keypool key, unlock, broadcast).
   * Such a call is never retried, and a failure after the request may have
   * reached the node is an `RpcUnknownOutcomeError`.
   */
  readonly sideEffects: boolean
}

const READ: MethodPolicy = { capability: 'read', sideEffects: false }
const WALLET_READ: MethodPolicy = { capability: 'wallet-read', sideEffects: false }
const WALLET_WRITE: MethodPolicy = { capability: 'wallet-write', sideEffects: true }

/**
 * The allowlist. Every method, typed or sent through `call()`, must be listed
 * here; anything else is refused before a request is made. Each name exists in
 * qbit Core v1.0.0.
 *
 * Deliberately absent: `sendmany`, `sendtoaddress`, `send`, `sendall`,
 * `bumpfee` and `psbtbumpfee` sign and broadcast in one step, so a caller
 * cannot store the signed transaction before it leaves the node. Build with
 * `walletcreatefundedpsbt`, sign with `walletprocesspsbt`, store the hex, then
 * `sendrawtransaction`.
 */
export const METHOD_POLICIES: Readonly<Record<string, MethodPolicy>> = Object.freeze({
  // Chain and utility reads with a typed method.
  getblockchaininfo: READ,
  getnetworkinfo: READ,
  getbestblockhash: READ,
  getblockhash: READ,
  getblockheader: READ,
  getrawtransaction: READ,
  getconfirmationtarget: READ,
  estimatesmartfee: READ,
  validateaddress: READ,
  verifydatapqchash: READ,
  getblockcount: READ,
  getmempoolentry: READ,
  gettxout: READ,
  // Further reads, untyped: use call().
  getblock: READ,
  getchaintips: READ,
  getmempoolinfo: READ,
  getrawmempool: READ,
  decoderawtransaction: READ,
  decodepsbt: READ,
  analyzepsbt: READ,
  getorphanmetrics: READ,
  getarchivepeers: READ,
  getindexinfo: READ,
  getzmqnotifications: READ,
  uptime: READ,

  // testmempoolaccept changes nothing, but it is gated with sendrawtransaction
  // as the broadcast step's preflight.
  testmempoolaccept: { capability: 'broadcast', sideEffects: false },
  sendrawtransaction: { capability: 'broadcast', sideEffects: true },

  getwalletinfo: WALLET_READ,
  gettransaction: WALLET_READ,
  listunspent: WALLET_READ,
  getaddressinfo: WALLET_READ,
  listlockunspent: WALLET_READ,
  getbalances: WALLET_READ,
  listtransactions: WALLET_READ,
  listsinceblock: WALLET_READ,
  // Untyped.
  listwallets: WALLET_READ,

  walletcreatefundedpsbt: WALLET_WRITE,
  walletprocesspsbt: WALLET_WRITE,
  // finalizepsbt touches no wallet, but it is gated with the signing step it completes.
  finalizepsbt: { capability: 'wallet-write', sideEffects: false },
  walletpassphrase: WALLET_WRITE,
  walletlock: WALLET_WRITE,
  getrawchangeaddress: WALLET_WRITE,
  lockunspent: WALLET_WRITE,
  getnewaddress: WALLET_WRITE,
})

/**
 * Option keys qbit Core v1.0.0 accepts in a method's options object and then
 * ignores, so the call does something other than what was asked: with
 * `subtract_fee_from_outputs`, the wallet pays the fee meant to come out of
 * the outputs. `call()` refuses them. `param` is the options object's
 * position; each key maps to the one the node reads. Each entry was checked
 * against a live node: see test/regtest/smoke.test.ts.
 */
export const IGNORED_OPTIONS: Readonly<
  Record<string, { readonly param: number; readonly typed: string; readonly keys: Readonly<Record<string, string>> }>
> = Object.freeze({
  walletcreatefundedpsbt: {
    param: 3,
    typed: 'walletCreateFundedPsbt',
    keys: { subtract_fee_from_outputs: 'subtractFeeFromOutputs' },
  },
})

export function methodPolicy(method: string): MethodPolicy | undefined {
  return Object.hasOwn(METHOD_POLICIES, method) ? METHOD_POLICIES[method] : undefined
}
