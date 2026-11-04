/** A chain name as `getblockchaininfo.chain` reports it (qbit Core v1.0.0 `LIST_CHAIN_NAMES`). */
export type QbitChain = 'main' | 'test' | 'testnet4' | 'signet' | 'regtest'

export const QBIT_CHAINS: readonly QbitChain[] = ['main', 'test', 'testnet4', 'signet', 'regtest']

/**
 * Each chain's genesis block hash, as `getblockhash 0` reports it: the hashes
 * qbit Core v1.0.0 asserts in `src/kernel/chainparams.cpp`. Every signet has
 * the same genesis block whatever its challenge, and so does every regtest node.
 */
export const QBIT_GENESIS_HASHES: Readonly<Record<QbitChain, string>> = Object.freeze({
  main: '0000000000004d60aa5d46013991d0a0e2995d89ee98e53068ae196d763e79f2',
  test: '0000c20791706c6940a43d75db44d1ae9dadeb637cedfbaa5cf293435eeaab3c',
  testnet4: '000000000000796fe86bbc0bf1b66a07e4b4c0676f74b54cf7e5ce8b3f1a0090',
  signet: '0000000a5698c727f05cbdaeaff3e48b48ab187aeb03414e783ea81fed14d65c',
  regtest: '0ee96aa77c4b600850e349344fa21b107e805f5370ddc7a6189db12cf69acce6',
})

/**
 * The challenge of qbit Core v1.0.0's default signet (no `-signetchallenge`):
 * `51`, OP_TRUE, an open challenge that needs no signature, so anyone can mine
 * a signet with it.
 */
export const QBIT_DEFAULT_SIGNET_CHALLENGE = '51'

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
 * Deliberately absent: `sendmany`, `sendtoaddress`, `send`, `sendall` and
 * `bumpfee` sign and broadcast in one step, so a caller cannot store the
 * signed transaction before it leaves the node. Build with
 * `walletcreatefundedpsbt` (or `psbtbumpfee` to bump a fee), sign with
 * `walletprocesspsbt`, store the hex, then `sendrawtransaction`.
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
  // psbtbumpfee returns an unsigned PSBT and signs and broadcasts nothing, but
  // it can take change keys from the keypool for good (no change in the
  // original, or outputs that drop the change), so it counts as side-effecting.
  psbtbumpfee: WALLET_WRITE,
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
