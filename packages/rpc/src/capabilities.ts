import { belowClass } from './method-classes'
import { argOptions } from './own'

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
 * - `broadcast`: `testmempoolaccept`, `sendrawtransaction` and `submitpackage`.
 * - `mining`: `getblocktemplate`, `submitblock`, `createauxblock` and `submitauxblock`.
 * - `wallet-admin`: create, load, unload, back up and re-key wallets, import
 *   descriptors, rescan and refill keypools (`createwallet`, `importdescriptors`,
 *   `rescanblockchain`, `walletpassphrasechange`, `keypoolrefill`, ...).
 * - `node-admin`: node administration (`stop`, `setban`, `addnode`,
 *   `pruneblockchain`, `savemempool`, `ping`, ...). No allowlisted method needs
 *   it: a client opens these through `extraMethods` only. Its calls wait for
 *   the chain guard, by the chain's identity only, and none goes in a batch.
 */
export type Capability = 'wallet-read' | 'wallet-write' | 'broadcast' | 'mining' | 'wallet-admin' | 'node-admin'

export const CAPABILITIES: readonly Capability[] = [
  'wallet-read',
  'wallet-write',
  'broadcast',
  'mining',
  'wallet-admin',
  'node-admin',
]

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
  /**
   * The least deadline of a call whose call options leave `timeoutMs` unset:
   * it replaces the client's 30 s default, and a shorter client `timeoutMs`.
   * Set only where qbit Core was measured to need longer.
   */
  readonly timeoutMs?: number
  /**
   * The node holds the request for a wait the caller chose. It is refused in
   * a batch: the batch's other calls would wait behind it, under one deadline.
   */
  readonly longPoll?: boolean
}

const READ: MethodPolicy = { capability: 'read', sideEffects: false }
const WALLET_READ: MethodPolicy = { capability: 'wallet-read', sideEffects: false }
const WALLET_WRITE: MethodPolicy = { capability: 'wallet-write', sideEffects: true }
const LONG_POLL: MethodPolicy = { capability: 'read', sideEffects: false, longPoll: true }
const MINING_WRITE: MethodPolicy = { capability: 'mining', sideEffects: true }
const WALLET_ADMIN: MethodPolicy = { capability: 'wallet-admin', sideEffects: true }

/**
 * The default deadline of `walletpassphrase` and `walletlock`. qbit Core v1.0.0
 * defers the keypool top-up of a wallet created with a passphrase (`-keypool`,
 * default 1,000 keys per descriptor) to its first unlock, which runs it before
 * answering (`CWallet::Unlock` and `RunPendingInitialKeyPoolTopUp`,
 * src/wallet/wallet.cpp). On regtest that unlock took 25 to 31 s on a shared
 * host and 49 s on a GitHub-hosted `ubuntu-latest` runner, against 0.2 s for
 * later ones; 120 s leaves more than twice the slowest. A `walletlock` sent
 * meanwhile waits for it, and missing its deadline would leave the caller not
 * knowing whether the wallet is locked.
 */
const FIRST_UNLOCK_TIMEOUT_MS = 120_000

/**
 * The default deadline of the wallet-admin calls that derive PQC keys before
 * answering, as the first unlock does: on a chain that allows only P2MR
 * outputs, each key took 18 to 21 ms on regtest on a loaded shared host.
 *
 * - `keypoolrefill` tops every active descriptor (a receiving and a change one
 *   by default) up to `newsize` keys, or `-keypool` (1,000), under the wallet's
 *   lock (`CWallet::TopUpKeyPoolResult`, src/wallet/wallet.cpp). On a new
 *   wallet, which holds 16 keys per descriptor until its deferred top-up runs,
 *   the default refill took 41 s; 500 more keys per descriptor took 21 s.
 * - `importdescriptors` derives a ranged descriptor's range, and at least
 *   `-keypool` keys past its next index even when inactive
 *   (`DescriptorScriptPubKeyMan::TopUp`, src/wallet/scriptpubkeyman.cpp), then
 *   rescans from the earliest timestamp. A receiving and a change descriptor
 *   imported with timestamp 0 took 35 s.
 * - `rescanblockchain` reads every block from `start_height`
 *   (`CWallet::ScanForWalletTransactions`, src/wallet/wallet.cpp): 1,010
 *   regtest blocks took 0.25 s. Each used address it finds past the keypool's
 *   low watermark derives replacement keys inside the scan
 *   (`DescriptorScriptPubKeyMan::MarkUnusedAddresses`).
 * - `unloadwallet` answers once every call still running on the wallet has
 *   ended (`WaitForDeleteWallet`): sent during that refill, it took 36 s.
 * - `loadwallet` tops up the keypool, unless the wallet defers its first
 *   top-up (`CWallet::Create`, src/wallet/wallet.cpp), and attaches it to the
 *   chain, rescanning from its last synced block (`CWallet::AttachChain`), so
 *   it does the work of `keypoolrefill` and `rescanblockchain` before it
 *   answers.
 *
 * 120 s leaves more than twice the slowest, as for `walletpassphrase`. What
 * grows with the chain (blocks to scan) or with `newsize` and the range (keys
 * to derive) needs the call's own `timeoutMs`.
 */
const KEY_DERIVATION_TIMEOUT_MS = 120_000

/**
 * qbit Core v1.0.0's methods that sign and broadcast in one step, so a caller
 * cannot store the signed transaction before it leaves the node, and a lost
 * reply leaves no txid to reconcile by. Build with `walletcreatefundedpsbt`
 * (or `psbtbumpfee` to bump a fee), sign with `walletprocesspsbt`, store the
 * hex, then `sendrawtransaction`.
 */
const SIGN_AND_BROADCAST: readonly string[] = ['sendmany', 'sendtoaddress', 'send', 'sendall', 'bumpfee']

/**
 * The allowlist. Every method, typed or sent through `call()`, must be listed
 * here or in the client's `extraMethods`; anything else is refused before a
 * request is made. Each name exists in qbit Core v1.0.0.
 *
 * Deliberately absent, and refused in `extraMethods` too: SIGN_AND_BROADCAST.
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
  getblock: READ,
  getchaintips: READ,
  getmempoolinfo: READ,
  getrawmempool: READ,
  gettxspendingprevout: READ,
  waitfornewblock: LONG_POLL,
  waitforblockheight: LONG_POLL,
  getmininginfo: READ,
  // Descriptor reads touch no wallet, but may carry private keys: see requests.getDescriptorInfo.
  getdescriptorinfo: READ,
  deriveaddresses: READ,
  // Further reads, untyped: use call().
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
  submitpackage: { capability: 'broadcast', sideEffects: true },

  // getblocktemplate changes nothing, but it is gated with the submission it
  // leads to: hashing a template from the wrong chain is wasted work, and it
  // assembles a block under the node's main lock.
  getblocktemplate: { capability: 'mining', sideEffects: false },
  submitblock: MINING_WRITE,
  // createauxblock holds its candidate in the node's cache, for submitauxblock.
  createauxblock: MINING_WRITE,
  submitauxblock: MINING_WRITE,

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
  walletpassphrase: { ...WALLET_WRITE, timeoutMs: FIRST_UNLOCK_TIMEOUT_MS },
  walletlock: { ...WALLET_WRITE, timeoutMs: FIRST_UNLOCK_TIMEOUT_MS },
  getrawchangeaddress: WALLET_WRITE,
  lockunspent: WALLET_WRITE,
  getnewaddress: WALLET_WRITE,
  // psbtbumpfee returns an unsigned PSBT and signs and broadcasts nothing, but
  // it can take change keys from the keypool for good (no change in the
  // original, or outputs that drop the change), so it counts as side-effecting.
  psbtbumpfee: WALLET_WRITE,
  // Each signature counts against the key's PQC signature budget.
  signdatapqchash: WALLET_WRITE,

  // Wallet administration: every one changes a wallet, the node's wallet list
  // or a file on the node's host, apart from listwalletdir, which is gated
  // with them as the step before loadwallet.
  createwallet: WALLET_ADMIN,
  loadwallet: { ...WALLET_ADMIN, timeoutMs: KEY_DERIVATION_TIMEOUT_MS },
  unloadwallet: { ...WALLET_ADMIN, timeoutMs: KEY_DERIVATION_TIMEOUT_MS },
  listwalletdir: { capability: 'wallet-admin', sideEffects: false },
  importdescriptors: { ...WALLET_ADMIN, timeoutMs: KEY_DERIVATION_TIMEOUT_MS },
  rescanblockchain: { ...WALLET_ADMIN, timeoutMs: KEY_DERIVATION_TIMEOUT_MS },
  // It overwrites a file at the destination.
  backupwallet: WALLET_ADMIN,
  walletpassphrasechange: WALLET_ADMIN,
  keypoolrefill: { ...WALLET_ADMIN, timeoutMs: KEY_DERIVATION_TIMEOUT_MS },
})

/** A name `extraMethods` may hold: every qbit Core v1.0.0 method is lowercase letters and digits. */
const METHOD_NAME = /^[a-z][a-z0-9]{0,63}$/

/** An object literal, or one made with `Object.create(null)`: not an array, a `Map` or a class instance. */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** The keys of an `extraMethods` entry. */
const POLICY_KEYS = ['capability', 'sideEffects'] as const

/**
 * The policies of a client's `extraMethods` option, a plain object, checked
 * against the capabilities it enables. Each name must have the form of a
 * method name and be neither allowlisted (its own policy stands, and may only
 * be restated) nor in SIGN_AND_BROADCAST. Each entry is a plain object holding,
 * as its own properties, exactly a known `capability`, which the client
 * enables unless it is `read`, and an explicit `sideEffects`; one with side
 * effects needs a capability of GUARDED_CAPABILITIES, so a client without them
 * stays unable to change state, and the chain guard covers every such call;
 * `node-admin`, which administers the node, is behind the guard too, by the
 * chain's identity only, and is never batched. A method
 * qbit Core v1.0.0 has, listed by `help` or hidden, must not be declared below
 * what it does (METHOD_CLASSES, HIDDEN_METHOD_CLASSES): a wallet method needs a wallet capability, and one that
 * changes state needs side effects under its own kind's capability. Throws a
 * `TypeError` for the first entry that fails. The result is a copy: changing
 * the option's object afterwards changes nothing.
 */
export function extraMethodPolicies(value: unknown, enabled: ReadonlySet<Capability>): Map<string, MethodPolicy> {
  const policies = new Map<string, MethodPolicy>()
  if (value === undefined) return policies
  // A Map, say, has no own enumerable keys: it would open nothing, silently.
  if (!isPlainObject(value)) {
    throw new TypeError('extraMethods must be a plain object of method names to { capability, sideEffects }')
  }
  // Own enumerable keys only, each read once: a key on a polluted prototype opens nothing.
  for (const [name, entry] of Object.entries(value)) {
    const path = `extraMethods.${name}`
    if (!METHOD_NAME.test(name)) {
      throw new TypeError(
        `extraMethods key ${JSON.stringify(name)} is not a method name: lowercase letters and digits, from a letter, at most 64`
      )
    }
    if (SIGN_AND_BROADCAST.includes(name)) {
      throw new TypeError(
        `${path}: ${name} signs and broadcasts in one step, so the signed transaction cannot be stored before it leaves the node; ` +
          'build with walletcreatefundedpsbt or psbtbumpfee, sign with walletprocesspsbt, store the hex, then sendrawtransaction'
      )
    }
    if (!isPlainObject(entry)) {
      throw new TypeError(`${path} must be a plain object, { capability, sideEffects }`)
    }
    // Strict, and read as own properties: a polluted capability or sideEffects is refused, never a default.
    const own = argOptions(entry, path, POLICY_KEYS)
    const capability = own['capability']
    if (capability !== 'read' && !(CAPABILITIES as readonly unknown[]).includes(capability)) {
      throw new TypeError(`${path}.capability must be one of read, ${CAPABILITIES.join(', ')}`)
    }
    const sideEffects = own['sideEffects']
    if (typeof sideEffects !== 'boolean') {
      throw new TypeError(
        `${path}.sideEffects must be true or false, whether a call can change node or wallet state: it has no default`
      )
    }
    const policy: MethodPolicy = Object.freeze({ capability: capability as MethodPolicy['capability'], sideEffects })
    // An allowlisted method keeps its own policy. Restating it is accepted, so a service that
    // opened a method keeps working once a release allowlists it the same way; any other is refused.
    const builtIn = methodPolicy(name)
    if (
      builtIn !== undefined &&
      (builtIn.capability !== policy.capability || builtIn.sideEffects !== policy.sideEffects)
    ) {
      throw new TypeError(
        `${path}: ${name} is allowlisted already as { capability: '${builtIn.capability}', sideEffects: ${builtIn.sideEffects} }, which extraMethods cannot change`
      )
    }
    // What a method help lists does decides first, so a node method's message names node-admin.
    const below = belowClass(name, policy)
    if (below !== undefined) throw new TypeError(`${path}: ${below}`)
    if (sideEffects && !guarded(policy)) {
      throw new TypeError(
        `${path}: a method with side effects needs the ${guardedList()} capability, which puts it behind the chain guard, or node-admin to administer the node`
      )
    }
    // Restated or not: an entry no call can use is a mistake either way.
    if (policy.capability !== 'read' && !enabled.has(policy.capability)) {
      throw new TypeError(`${path} needs the '${policy.capability}' capability, which this client does not enable`)
    }
    if (builtIn === undefined) policies.set(name, policy)
  }
  return policies
}

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
  // It ignores every key it does not read: these would sign without the usage
  // fields asked for, or with whichever leaf the wallet picks.
  signdatapqchash: {
    param: 2,
    typed: 'signDataPqcHash',
    keys: { includePqcUsage: 'include_pqc_usage', leafScript: 'leaf_script', controlBlock: 'control_block' },
  },
})

/**
 * The capabilities whose calls wait for the chain guard: the one list the
 * guard, the batch rule and `extraMethods` read. `mining` is here because a
 * block on the wrong chain is wasted work, and a pool's payouts depend on its
 * blocks being on the right one; `wallet-admin` because importing descriptors,
 * rescanning or creating a wallet on the wrong chain is a misconfiguration;
 * `node-admin` by the chain's identity only (no qbit Core version refuses
 * it): a client that expects regtest never stops, bans or invalidates on a
 * mainnet node it was pointed at by mistake. A batch is sent as a read,
 * without the guard, so it carries no call needing one of these.
 */
export const GUARDED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'wallet-write',
  'broadcast',
  'mining',
  'wallet-admin',
  'node-admin',
])

/** Whether a call waits for the chain guard: its capability is one of GUARDED_CAPABILITIES. */
export function guarded(policy: MethodPolicy): boolean {
  return policy.capability !== 'read' && GUARDED_CAPABILITIES.has(policy.capability)
}

/** The capabilities that change a wallet, the mempool or blocks, as a message lists them: `wallet-write, broadcast, mining or wallet-admin`. */
function guardedList(): string {
  const names = [...GUARDED_CAPABILITIES].filter(name => name !== 'node-admin')
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)!}`
}

export function methodPolicy(method: string): MethodPolicy | undefined {
  return Object.hasOwn(METHOD_POLICIES, method) ? METHOD_POLICIES[method] : undefined
}
