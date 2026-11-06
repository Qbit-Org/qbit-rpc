import type { Capability, MethodPolicy } from './capabilities'

/**
 * What a qbit Core v1.0.0 method does, read from its source
 * (src/rpc/*.cpp, src/wallet/rpc/*.cpp):
 *
 * - `read`: reads the chain, the mempool, the network or the node, or
 *   computes from its arguments alone.
 * - `wallet-read`: reads a wallet.
 * - `wallet-write`: signs with a wallet's keys, or changes a wallet: takes a
 *   key, locks or labels coins, abandons a transaction, unlocks or locks it.
 * - `wallet-admin`: creates, loads, unloads, restores, migrates, backs up,
 *   encrypts or re-keys a wallet, imports into it, refills its keypool,
 *   rescans or stops a rescan, or returns its private keys.
 * - `broadcast`: hands a transaction to the mempool and the network, or tests
 *   whether the mempool would take it.
 * - `mining`: builds or submits blocks, headers or AuxPoW work, or changes
 *   what a block template holds.
 * - `node`: changes what the node stores, which chain it follows or whom it
 *   connects to, or stops it.
 */
type MethodKind = 'read' | 'wallet-read' | 'wallet-write' | 'wallet-admin' | 'broadcast' | 'mining' | 'node'

/** A method's kind, and whether a call can change state. */
interface MethodClass {
  readonly kind: MethodKind
  readonly sideEffects: boolean
}

const READ: MethodClass = { kind: 'read', sideEffects: false }
const WALLET_READ: MethodClass = { kind: 'wallet-read', sideEffects: false }
const WALLET_WRITE: MethodClass = { kind: 'wallet-write', sideEffects: true }
const WALLET_ADMIN: MethodClass = { kind: 'wallet-admin', sideEffects: true }
/** Returns the wallet's private keys when asked (`private: true`): a backup, not a read. */
const WALLET_SECRETS: MethodClass = { kind: 'wallet-admin', sideEffects: false }
const BROADCAST: MethodClass = { kind: 'broadcast', sideEffects: true }
const MINING: MethodClass = { kind: 'mining', sideEffects: true }
const NODE: MethodClass = { kind: 'node', sideEffects: true }

/**
 * Every method qbit Core v1.0.0's `help` lists (161), in its categories. The
 * regtest smoke test compares the names with `help` on the node, so a release
 * that adds, renames or drops one fails it until this table follows. `help`
 * leaves out hidden methods: those are in HIDDEN_METHOD_CLASSES.
 */
export const METHOD_CLASSES: Readonly<Record<string, MethodClass>> = Object.freeze({
  // == Blockchain ==
  dumptxoutset: NODE, // writes a file, and with `rollback` rolls the chain back and forward
  getbestblockhash: READ,
  getblock: READ,
  getblockchaininfo: READ,
  getblockcount: READ,
  getblockfilter: READ,
  getblockfrompeer: NODE, // asks a peer for a block and stores it
  getblockhash: READ,
  getblockheader: READ,
  getblockstats: READ,
  getchainstates: READ,
  getchaintips: READ,
  getchaintxstats: READ,
  getconfirmationtarget: READ,
  getdeploymentinfo: READ,
  getdescriptoractivity: READ,
  getdifficulty: READ,
  getmempoolancestors: READ,
  getmempooldescendants: READ,
  getmempoolentry: READ,
  getmempoolinfo: READ,
  getorphanmetrics: READ,
  getrawmempool: READ,
  gettxout: READ,
  gettxoutproof: READ,
  gettxoutsetinfo: READ,
  gettxspendingprevout: READ,
  importmempool: NODE,
  loadtxoutset: NODE,
  preciousblock: NODE,
  pruneblockchain: NODE,
  savemempool: NODE, // writes mempool.dat
  scanblocks: READ, // `abort` stops only a scan
  scantxoutset: READ, // as scanblocks
  verifychain: READ,
  verifytxoutproof: READ,
  waitforblock: READ,
  waitforblockheight: READ,
  waitfornewblock: READ,
  // == Control ==
  getmemoryinfo: READ,
  getrpcinfo: READ,
  help: READ,
  logging: NODE, // turns log categories on and off
  stop: NODE,
  uptime: READ,
  // == Mining ==
  createauxblock: MINING, // keeps the block it builds, for submitauxblock
  getblocktemplate: { kind: 'mining', sideEffects: false },
  getmininginfo: READ,
  getnetworkhashps: READ,
  getprioritisedtransactions: READ,
  prioritisetransaction: MINING, // changes a transaction's fee for block templates
  submitauxblock: MINING,
  submitblock: MINING,
  submitheader: MINING,
  // == Network ==
  addnode: NODE,
  clearbanned: NODE,
  disconnectnode: NODE,
  getaddednodeinfo: READ,
  getaddrmaninfo: READ,
  getarchivepeers: READ,
  getconnectioncount: READ,
  getnettotals: READ,
  getnetworkinfo: READ,
  getnodeaddresses: READ,
  getpeerinfo: READ,
  listbanned: READ,
  ping: NODE, // queues a ping to every peer
  setban: NODE,
  setnetworkactive: NODE,
  // == Rawtransactions ==
  analyzepsbt: READ,
  combinepsbt: READ,
  combinerawtransaction: READ,
  converttopsbt: READ,
  createpsbt: READ,
  createrawtransaction: READ,
  decodepsbt: READ,
  decoderawtransaction: READ,
  decodescript: READ,
  descriptorprocesspsbt: READ, // signs with the keys in its arguments, not a wallet's
  finalizepsbt: READ,
  fundrawtransaction: WALLET_WRITE, // a wallet's coins and change key, and `lockUnspents`
  getdefaultctvhash: READ,
  getrawtransaction: READ,
  joinpsbts: READ,
  sendrawtransaction: BROADCAST,
  signrawtransactionwithkey: READ, // as descriptorprocesspsbt
  submitpackage: BROADCAST,
  testmempoolaccept: { kind: 'broadcast', sideEffects: false },
  utxoupdatepsbt: READ,
  // == Signer ==
  enumeratesigners: READ, // runs the operator's -signer command, which lists devices
  // == Util ==
  createmultisig: READ,
  deriveaddresses: READ,
  estimatesmartfee: READ,
  getdescriptorinfo: READ,
  getindexinfo: READ,
  signmessagewithprivkey: READ,
  validateaddress: READ,
  verifydatapqchash: READ,
  verifymessage: READ,
  // == Wallet ==
  abandontransaction: WALLET_WRITE,
  abortrescan: WALLET_ADMIN,
  backupwallet: WALLET_ADMIN,
  bumpfee: WALLET_WRITE,
  createwallet: WALLET_ADMIN,
  createwalletdescriptor: WALLET_ADMIN,
  encryptwallet: WALLET_ADMIN,
  exportpubkeydb: WALLET_READ, // returns public keys only
  getaddressesbylabel: WALLET_READ,
  getaddressinfo: WALLET_READ,
  getbalance: WALLET_READ,
  getbalances: WALLET_READ,
  gethdkeys: WALLET_SECRETS,
  getnewaddress: WALLET_WRITE,
  getnextpubkeydbaddress: WALLET_WRITE, // moves the imported pool's cursor
  getrawchangeaddress: WALLET_WRITE,
  getreceivedbyaddress: WALLET_READ,
  getreceivedbylabel: WALLET_READ,
  gettransaction: WALLET_READ,
  getwalletinfo: WALLET_READ,
  importdescriptors: WALLET_ADMIN,
  importprunedfunds: WALLET_ADMIN,
  importpubkeydb: WALLET_ADMIN,
  keypoolrefill: WALLET_ADMIN,
  listaddressgroupings: WALLET_READ,
  listdescriptors: WALLET_SECRETS,
  listlabels: WALLET_READ,
  listlockunspent: WALLET_READ,
  listpubkeydbstatus: WALLET_READ,
  listreceivedbyaddress: WALLET_READ,
  listreceivedbylabel: WALLET_READ,
  listsinceblock: WALLET_READ,
  listtransactions: WALLET_READ,
  listunspent: WALLET_READ,
  listwalletdir: WALLET_READ,
  listwallets: WALLET_READ,
  loadwallet: WALLET_ADMIN,
  lockunspent: WALLET_WRITE,
  migratewallet: WALLET_ADMIN,
  psbtbumpfee: WALLET_WRITE,
  removeprunedfunds: WALLET_ADMIN,
  rescanblockchain: WALLET_ADMIN,
  restorewallet: WALLET_ADMIN,
  send: WALLET_WRITE,
  sendall: WALLET_WRITE,
  sendmany: WALLET_WRITE,
  sendtoaddress: WALLET_WRITE,
  setlabel: WALLET_WRITE,
  settxfee: WALLET_WRITE,
  setwalletflag: WALLET_ADMIN,
  signdatapqchash: WALLET_WRITE, // spends one of the key's PQC signatures
  signmessage: WALLET_WRITE, // as signdatapqchash
  signrawtransactionwithwallet: WALLET_WRITE,
  simulaterawtransaction: WALLET_READ,
  unloadwallet: WALLET_ADMIN,
  walletcreatefundedpsbt: WALLET_WRITE,
  walletdisplayaddress: WALLET_READ, // shows an address on the external signer
  walletlock: WALLET_WRITE,
  walletpassphrase: WALLET_WRITE,
  walletpassphrasechange: WALLET_ADMIN,
  walletprocesspsbt: WALLET_WRITE,
  // == Zmq ==
  getzmqnotifications: READ,
})

/**
 * qbit Core v1.0.0's hidden methods (18), which `help` does not list but each
 * name's `help <name>` describes, as the regtest smoke test checks: classed as
 * the listed ones are, so `invalidateblock` cannot be opened as a read either.
 * `extraMethods` takes the caller's policy only for a method in neither table,
 * such as one a later release adds.
 */
export const HIDDEN_METHOD_CLASSES: Readonly<Record<string, MethodClass>> = Object.freeze({
  addconnection: NODE, // opens a connection to a peer (regtest)
  addpeeraddress: NODE, // adds an address to the address manager
  echo: READ,
  echoipc: READ,
  echojson: READ,
  estimaterawfee: READ,
  generate: MINING, // replaced by generatetoaddress: it only returns an error, classed with them
  generateblock: MINING,
  generatetoaddress: MINING,
  generatetodescriptor: MINING,
  getorphantxs: READ,
  getrawaddrman: READ,
  invalidateblock: NODE, // changes which chain the node follows
  mockscheduler: NODE, // moves the scheduler's clock (regtest)
  reconsiderblock: NODE, // as invalidateblock
  sendmsgtopeer: NODE,
  setmocktime: NODE, // sets the node's clock (regtest)
  syncwithvalidationinterfacequeue: READ,
})

/**
 * The capability each kind needs. Node administration has its own,
 * `node-admin`, which no allowlisted method needs, so a client that broadcasts
 * cannot stop the node or ban a peer by stating `broadcast`. wallet-admin has
 * no capability of its own yet: wallet administration needs `wallet-write`.
 */
const KIND_CAPABILITY: Readonly<Record<MethodKind, 'read' | Capability>> = Object.freeze({
  read: 'read',
  'wallet-read': 'wallet-read',
  'wallet-write': 'wallet-write',
  'wallet-admin': 'wallet-write',
  broadcast: 'broadcast',
  mining: 'mining',
  node: 'node-admin',
})

const WALLET_CAPABILITIES: readonly ('read' | Capability)[] = ['wallet-read', 'wallet-write']

/** What the kind does, for the message of a policy below it. */
const KIND_DOES: Readonly<Record<MethodKind, string>> = Object.freeze({
  read: 'only reads',
  'wallet-read': 'reads a wallet',
  'wallet-write': "signs with a wallet's keys or changes the wallet",
  'wallet-admin': 'administers a wallet or returns its private keys',
  broadcast: 'hands a transaction to the mempool and the network, or tests one for it',
  mining: 'builds or submits blocks or AuxPoW work, or changes what a block template holds',
  node: 'changes what the node stores, follows or connects to, or stops it',
})

/**
 * Why `policy` is below what qbit Core v1.0.0's `method` does, or `undefined`
 * when it is not, or neither table holds the method. A read takes any policy;
 * a wallet read, any wallet capability; anything else, its own capability,
 * with `sideEffects: true` when a call can change state.
 */
export function belowClass(method: string, policy: MethodPolicy): string | undefined {
  const known = Object.hasOwn(METHOD_CLASSES, method)
    ? METHOD_CLASSES[method]
    : Object.hasOwn(HIDDEN_METHOD_CLASSES, method)
      ? HIDDEN_METHOD_CLASSES[method]
      : undefined
  if (known === undefined) return undefined
  const capability = KIND_CAPABILITY[known.kind]
  if (capability === 'read' && (policy.sideEffects || !known.sideEffects)) return undefined
  if (capability === 'wallet-read') {
    if (WALLET_CAPABILITIES.includes(policy.capability)) return undefined
    return `qbit Core v1.0.0's ${method} ${KIND_DOES[known.kind]}, so it needs a wallet capability (${WALLET_CAPABILITIES.join(', ')})`
  }
  if (policy.capability === capability && (policy.sideEffects || !known.sideEffects)) return undefined
  return `qbit Core v1.0.0's ${method} ${KIND_DOES[known.kind]}, so it needs { capability: '${capability}', sideEffects: ${known.sideEffects} }`
}
