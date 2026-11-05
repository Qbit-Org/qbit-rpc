import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  QbitRpcClient,
  requests,
  RpcCapabilityError,
  RpcChainGuardError,
  RpcError,
  RpcResponseError,
  RpcUnknownOutcomeError,
  type Capability,
  type QbitRpcClientOptions,
} from '../src'
import { METHOD_POLICIES } from '../src/capabilities'
import { chainResults, FakeNode } from './helpers/fake-node'
import { bare } from './helpers/null-prototype'

let node: FakeNode

beforeEach(async () => {
  node = await FakeNode.start()
})
afterEach(async () => {
  await node.close()
})

function client(
  capabilities: Capability[] = ['wallet-read', 'wallet-write'],
  options: Partial<QbitRpcClientOptions> = {}
): QbitRpcClient {
  return new QbitRpcClient({
    url: node.url,
    auth: { username: 'u', password: 'p' },
    expectedChain: 'regtest',
    capabilities,
    ...options,
  })
}

async function confirmed(options: Partial<QbitRpcClientOptions> = {}): Promise<QbitRpcClient> {
  const rpc = client(['wallet-read', 'wallet-write'], options)
  node.results(chainResults('regtest'))
  await rpc.confirmChain()
  return rpc
}

function params(): unknown[] {
  return node.calls().at(-1)!.params
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the call to fail'),
    (e: unknown) => e
  )
}

async function invalid(promise: Promise<unknown>, path: string): Promise<void> {
  const error = await failure(promise)
  expect(RpcResponseError.is(error)).toBe(true)
  expect(error).toMatchObject({ reason: 'validation', path })
}

/** A side-effecting call's invalid result: the node acted, so the outcome is unknown, caused by the validation error. */
async function invalidAfterSideEffect(promise: Promise<unknown>, path: string): Promise<void> {
  const error = await failure(promise)
  expect(RpcUnknownOutcomeError.is(error)).toBe(true)
  const cause = (error as Error).cause
  expect(RpcResponseError.is(cause)).toBe(true)
  expect(cause).toMatchObject({ reason: 'validation', path })
}

/** JSON text in which a `'#…'` string is written as a bare number, so amounts keep the node's exact text. */
function json(value: unknown): string {
  return JSON.stringify(value).replace(/"#([^"]*)"/g, '$1')
}

type Entry = Record<string, unknown>

function without(entry: Entry, key: string): Entry {
  const copy = { ...entry }
  delete copy[key]
  return copy
}

// Entries as a qbit Core v1.0.0 regtest node printed them, field for field.
const PEER = 'qbrt1zhmrvf3naphupc44dtzj42n49mggrrhechqmch76zv34nc0ge0glsp3m9e2'
const DEPOSIT = 'qbrt1zegxp4f67d95ud9sxajyqgfeeh8ssrfvalqra6hd5emeyevkxthvs08ztqx'
const MINER = 'qbrt1zkxtgd9m4rncrtdvrpptsz5vj85x32y693r6shpqkxcnx4wmq6sfssdqzxu'
const BLOCK_1011 = '75040d06757f999ed0fae8d0de874105a70c869eba27295f00ed341f6331a458'
const TIP = '75584f0a6791c0b924f90851f2fc5faa345fb9d3cf71ca9cbcc3e24d2593f705'

/** sendtoaddress with a comment, mined. */
const SEND: Entry = {
  address: PEER,
  category: 'send',
  amount: '#-1.50000000',
  vout: 0,
  fee: '#-0.00038610',
  confirmations: 1,
  blockhash: BLOCK_1011,
  blockheight: 1011,
  blockindex: 1,
  blocktime: 1793733321,
  txid: '32c93c3cec020bf2b49e2f7c8c4f8e6a559ab37cd37f2203321b3829c1f7e468',
  wtxid: '2ab91ea0976b6a375ffe5332cf052b27715ba42af38da25571be7a8697a52e9a',
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793733152,
  timereceived: 1793733152,
  'bip125-replaceable': 'no',
  comment: 'hello',
  to: 'bob',
  abandoned: false,
}

/** A payment to one of the wallet's own labelled addresses: a send and a receive entry for one output. */
const SELF_TXID = 'f36d051b4389393001fedebb11075a61867396e74a7bbb63467751f65ca5889f'
const SELF_WTXID = 'c55c23e613594ca16dbfeacd87ce374f4c992501b78e456582f9ca8134becb04'
const SELF_SEND: Entry = {
  address: DEPOSIT,
  category: 'send',
  amount: '#-2.25000000',
  label: 'deposit-alice',
  vout: 1,
  fee: '#-0.00038610',
  confirmations: 1,
  blockhash: BLOCK_1011,
  blockheight: 1011,
  blockindex: 2,
  blocktime: 1793733321,
  txid: SELF_TXID,
  wtxid: SELF_WTXID,
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793733152,
  timereceived: 1793733152,
  'bip125-replaceable': 'no',
  abandoned: false,
}
const RECEIVE: Entry = {
  address: DEPOSIT,
  parent_descs: [],
  category: 'receive',
  amount: '#2.25000000',
  label: 'deposit-alice',
  vout: 1,
  abandoned: false,
  confirmations: 1,
  blockhash: BLOCK_1011,
  blockheight: 1011,
  blockindex: 2,
  blocktime: 1793733321,
  txid: SELF_TXID,
  wtxid: SELF_WTXID,
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793733152,
  timereceived: 1793733152,
  'bip125-replaceable': 'no',
}

const GENERATE: Entry = {
  address: MINER,
  parent_descs: [],
  category: 'generate',
  amount: '#210.00000000',
  label: '',
  vout: 0,
  abandoned: false,
  confirmations: 1003,
  generated: true,
  blockhash: '2c115a7459d39304c6cb3195afff4d0443b495f80c868a322ee013c1c6c4fc26',
  blockheight: 8,
  blockindex: 0,
  blocktime: 1793733154,
  txid: '81712cf96601956fe7a5729be032d41c6fe0d6009095105d7f1bd5cd74b8927d',
  wtxid: '31f022d447f84cdf13a4eebaf465f3e5cc3f7edbee8ebf361e5205e967b505ae',
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793733151,
  timereceived: 1793733151,
  'bip125-replaceable': 'no',
}

const IMMATURE: Entry = {
  ...GENERATE,
  category: 'immature',
  amount: '#161.11882817',
  confirmations: 1,
  blockhash: TIP,
  blockheight: 1010,
  blocktime: 1793733321,
  txid: 'aac8225539e43aac8c9ed0eb5b45cd9cbb85fb26ad1da7487eff552f1feba873',
  wtxid: '2dfa217318349dbeeab590026f07c991e87d0e1cf1d24574435fd75dab0c252a',
}

/** A coinbase whose block was invalidated. */
const ORPHAN: Entry = {
  address: MINER,
  parent_descs: [],
  category: 'orphan',
  amount: '#161.11882817',
  label: '',
  vout: 0,
  abandoned: true,
  confirmations: 0,
  generated: true,
  trusted: false,
  txid: 'ecbc25d1e71636c657dfb03e2f810bffc868f450b17cee4ae9ee1c929d4fc48b',
  wtxid: '422b726323f8c88b110a91d52a3d6ed250bfe920deb12a4ff21c79a367772940',
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793733155,
  timereceived: 1793733155,
  'bip125-replaceable': 'unknown',
}

/** bumpfee: the original, while its replacement is in the mempool, and the replacement. */
const BUMPED = '94e2a673b8679820b364ef29613c7ff55fc28d48979fdcf40870e342b474ab56'
const BUMP = 'a5cd98f471e2be72dc0c57fd9f6608e7a991129b1ef8f0bc8fd1a9efba0a99ac'
const REPLACED: Entry = {
  address: PEER,
  category: 'send',
  amount: '#-0.50000000',
  vout: 0,
  fee: '#-0.00038610',
  confirmations: 0,
  trusted: false,
  txid: BUMPED,
  wtxid: 'ccf40896e5ba863df41e0584d8b0a40d54410748f3cc257460011dcc2453481b',
  walletconflicts: [BUMP],
  mempoolconflicts: [BUMP],
  time: 1793733153,
  timereceived: 1793733153,
  'bip125-replaceable': 'yes',
  replaced_by_txid: BUMP,
  abandoned: false,
}
const REPLACEMENT: Entry = {
  address: PEER,
  category: 'send',
  amount: '#-0.50000000',
  vout: 1,
  fee: '#-0.00057927',
  confirmations: 0,
  trusted: true,
  txid: BUMP,
  wtxid: '7ec2f88e325d6ca110d6a9d016ce29a57d26debe5fcce1c431072bfca370f862',
  walletconflicts: [BUMPED],
  mempoolconflicts: [],
  time: 1793733153,
  timereceived: 1793733153,
  'bip125-replaceable': 'yes',
  replaces_txid: BUMPED,
  abandoned: false,
}

/** A send whose double spend was mined one block ago. */
const CONFLICTED: Entry = {
  address: PEER,
  category: 'send',
  amount: '#-0.10000000',
  vout: 1,
  fee: '#-0.00007722',
  confirmations: -1,
  trusted: false,
  txid: '990e3c04d864a547afaddbb8dabcde18fb3c5068942e54635eb5b7c6a22ca30a',
  wtxid: '554bab318efca734ee906f41f41c0697850e3686313a8020e11071efbcfa3767',
  walletconflicts: ['9dd103526bc41547d9184835a4e764c162db01f580b222df5de2f53d1537b407'],
  mempoolconflicts: [],
  time: 1793733155,
  timereceived: 1793733155,
  'bip125-replaceable': 'yes',
  abandoned: false,
}

/** A deposit whose block was invalidated and a double spend mined instead, in `removed` of the receiving wallet. */
const CONFLICTED_RECEIVE: Entry = {
  address: 'qbrt1ztzlwe02rur2rle2y8kx6v43cwzw8q7eszve6rheue0dhkzuqjntq3dc5hn',
  parent_descs: [],
  category: 'receive',
  amount: '#2.00000000',
  label: 'deposit-b',
  vout: 1,
  abandoned: false,
  confirmations: -1,
  trusted: false,
  txid: 'a233910cca7756b462c89a1beb9ebc85c5e837c61d4581b164c94dd4df7811d0',
  wtxid: '87319fcf433d26ccd92e3bf885d05ead2b0e7d4384c4a17e47218079676efa1e',
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793738181,
  timereceived: 1793738181,
  'bip125-replaceable': 'yes',
}

/** gettransaction for that deposit in the receiving wallet, hex shortened: no entries in `details`. */
const CONFLICTED_RECEIVE_TX: Entry = {
  amount: '#2.00000000',
  confirmations: -1,
  trusted: false,
  txid: CONFLICTED_RECEIVE['txid'],
  wtxid: CONFLICTED_RECEIVE['wtxid'],
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793738181,
  timereceived: 1793738181,
  'bip125-replaceable': 'yes',
  details: [],
  hex: '0200000000',
  lastprocessedblock: { hash: '5f3eee1ab1f02c3d702fa43f9256a86bf47b81a884577f7681cc4a14825abb15', height: 1012 },
}

/** An OP_RETURN output: no address, a zero amount. */
const DATA: Entry = {
  category: 'send',
  amount: '#0.00000000',
  vout: 0,
  fee: '#-0.00038330',
  confirmations: 0,
  trusted: true,
  txid: '6923502422a3957b8f5b4189075c8f8a4a2f1b15a149b63a29903835df2dbff8',
  wtxid: 'f3bb59d586079717da6bdfe1d07ef91ad50dbfc202e704f70b8488a5f39b5dcc',
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793733153,
  timereceived: 1793733153,
  'bip125-replaceable': 'yes',
  abandoned: false,
}

/** Inputs from this wallet and another: the "fee" is this wallet's inputs minus all outputs, here positive. */
const PARTIAL: Entry = {
  address: 'qbrt1z8nvjxpzx89mm40768ackjnv6rrmwwkkg69dwd3g9wgqg7ehe8dsqvwy4lu',
  category: 'send',
  amount: '#-204.83922780',
  label: '',
  vout: 0,
  fee: '#0.09000000',
  confirmations: 0,
  trusted: false,
  txid: 'fec9338d450344fca7d09a641f20ac0f8e956dd52f23e28117ec18d6b9f6eaa0',
  wtxid: 'bec204996836470c74fcf0b07e4782ee280e0078a5084cdee1ef03f9f3379592',
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793733155,
  timereceived: 1793733155,
  'bip125-replaceable': 'yes',
  abandoned: false,
}

/** Received by a wallet without private keys that watches an addr() descriptor. */
const WATCHED: Entry = {
  address: 'qbrt1z4g3z7yf9rs7r4f9v0hw8ja5rn5n3pwcv64rwtxnms43llyh6mrdslq4n5f',
  parent_descs: ['addr(qbrt1z4g3z7yf9rs7r4f9v0hw8ja5rn5n3pwcv64rwtxnms43llyh6mrdslq4n5f)#89zgrq4g'],
  category: 'receive',
  amount: '#7.00000000',
  label: 'w1',
  vout: 1,
  abandoned: false,
  confirmations: 0,
  trusted: false,
  txid: 'a551e6826e422e77a77c450015058e695a1e2bc182e2de2fd222f717191d43c8',
  wtxid: '859f9c0ecef7779f9000f639d190687f569cd031cd7d3925a93570f68a8fb207',
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793733156,
  timereceived: 1793733156,
  'bip125-replaceable': 'yes',
}

/** Never broadcast (-walletbroadcast=0), then abandontransaction. */
const ABANDONED: Entry = {
  address: 'qbrt1zkdkr2wzcyme2wfqkhue57rcxmfulflp294ewyd7ahwq5h3g947ysjd9p9e',
  category: 'send',
  amount: '#-1.25000000',
  vout: 0,
  fee: '#-0.00038610',
  confirmations: 0,
  trusted: false,
  txid: '542630fe89833cb4e7d39f3f4c515fe144278918fee2371e6d653efd66c45afa',
  wtxid: '639dde0dce572a33b76c994b23c4c9ca4c6b16ab9ac6dd8663a8f5e415b915c9',
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793733508,
  timereceived: 1793733508,
  'bip125-replaceable': 'yes',
  abandoned: true,
}

/** In `removed` after its block was invalidated, and already mined again in the new branch. */
const REMINED: Entry = {
  address: 'qbrt1zlzv570q74sjvt58j396f0q8v39ks46ns7lg52pvxh8h6sf6f7vaqzxd3gd',
  category: 'send',
  amount: '#-4.00000000',
  vout: 0,
  fee: '#-0.00038610',
  confirmations: 2,
  blockhash: '69c4ce8b624698f2938f6e85891e418bdf591fa4e460767efc42d3436099bb99',
  blockheight: 1016,
  blockindex: 2,
  blocktime: 1793733322,
  txid: '8de7ff1f905ccb6aedabff8830b794ecf2e6cf774f6dd21a372c3fa48cc119ea',
  wtxid: '34f03703971b6239e40906bcd5b85e3f02be72ce8bd4f51883da9d03e7bfc0a8',
  walletconflicts: [],
  mempoolconflicts: [],
  time: 1793733154,
  timereceived: 1793733154,
  'bip125-replaceable': 'no',
  abandoned: false,
}

const ALL = [
  SEND,
  SELF_SEND,
  RECEIVE,
  GENERATE,
  IMMATURE,
  ORPHAN,
  REPLACED,
  REPLACEMENT,
  CONFLICTED,
  DATA,
  PARTIAL,
  WATCHED,
  ABANDONED,
  REMINED,
]

/** A listsinceblock reply; `removed` null leaves the array out, as with include_removed false. */
function sinceBlock(transactions: unknown[], removed: unknown[] | null = [], lastblock: unknown = TIP): string {
  return json(removed === null ? { transactions, lastblock } : { transactions, removed, lastblock })
}

const SEND_PARSED = {
  address: PEER,
  category: 'send',
  amountBits: -150_000_000n,
  vout: 0,
  feeBits: -38_610n,
  abandoned: false,
  confirmations: 1,
  blockHash: BLOCK_1011,
  blockHeight: 1011,
  blockIndex: 1,
  blockTime: 1793733321,
  txid: SEND['txid'],
  wtxid: SEND['wtxid'],
  walletConflicts: [],
  mempoolConflicts: [],
  to: 'bob',
  time: 1793733152,
  timeReceived: 1793733152,
  comment: 'hello',
  bip125Replaceable: 'no',
}

describe('listSinceBlock', () => {
  it('parses every entry shape qbit Core v1.0.0 prints, in exact signed bits', async () => {
    node.results({ listsinceblock: sinceBlock(ALL, [REMINED, ORPHAN]) })
    const history = await client().listSinceBlock({ blockHash: BLOCK_1011 })
    expect(history.lastBlock).toBe(TIP)
    const [send, selfSend, receive, generate, immature, orphan, replaced, replacement, conflicted, data, partial] =
      history.transactions
    expect(send).toStrictEqual(bare(SEND_PARSED))
    expect(selfSend).toMatchObject({ category: 'send', amountBits: -225_000_000n, label: 'deposit-alice', vout: 1 })
    expect(receive).toStrictEqual(
      bare({
        address: DEPOSIT,
        parentDescs: [],
        category: 'receive',
        amountBits: 225_000_000n,
        label: 'deposit-alice',
        vout: 1,
        abandoned: false,
        confirmations: 1,
        blockHash: BLOCK_1011,
        blockHeight: 1011,
        blockIndex: 2,
        blockTime: 1793733321,
        txid: SELF_TXID,
        wtxid: SELF_WTXID,
        walletConflicts: [],
        mempoolConflicts: [],
        time: 1793733152,
        timeReceived: 1793733152,
        bip125Replaceable: 'no',
      })
    )
    expect(generate).toMatchObject({ category: 'generate', amountBits: 21_000_000_000n, generated: true, label: '' })
    expect(generate).not.toHaveProperty('feeBits')
    expect(immature).toMatchObject({ category: 'immature', amountBits: 16_111_882_817n, blockHeight: 1010 })
    expect(orphan).toMatchObject({ category: 'orphan', abandoned: true, confirmations: 0, trusted: false })
    expect(orphan).toMatchObject({ bip125Replaceable: 'unknown' })
    expect(orphan).not.toHaveProperty('blockHash')
    expect(replaced).toMatchObject({ replacedByTxid: BUMP, walletConflicts: [BUMP], mempoolConflicts: [BUMP] })
    expect(replacement).toMatchObject({ replacesTxid: BUMPED, feeBits: -57_927n, trusted: true })
    expect(conflicted).toMatchObject({ confirmations: -1, trusted: false, feeBits: -7_722n })
    expect(conflicted).not.toHaveProperty('blockHash')
    expect(data).toMatchObject({ category: 'send', amountBits: 0n, feeBits: -38_330n })
    expect(data).not.toHaveProperty('address')
    expect(partial).toMatchObject({ amountBits: -20_483_922_780n, feeBits: 9_000_000n })
    expect(history.transactions[11]).toMatchObject({ parentDescs: WATCHED['parent_descs'], label: 'w1' })
    expect(history.transactions[12]).toMatchObject({ abandoned: true, trusted: false, confirmations: 0 })
    expect(history.removed).toHaveLength(2)
    expect(history.removed![0]).toMatchObject({ confirmations: 2, blockHeight: 1016, amountBits: -400_000_000n })
    expect(history.removed![1]).toMatchObject({ category: 'orphan' })
  })

  it('reports a double-spent deposit in removed and through getTransaction, not in transactions', async () => {
    node.results({
      listsinceblock: sinceBlock([], [CONFLICTED_RECEIVE]),
      gettransaction: json(CONFLICTED_RECEIVE_TX),
    })
    const rpc = client()
    const history = await rpc.listSinceBlock({ blockHash: BLOCK_1011 })
    expect(history.transactions).toEqual([])
    expect(history.removed![0]).toMatchObject({
      category: 'receive',
      amountBits: 200_000_000n,
      label: 'deposit-b',
      confirmations: -1,
      trusted: false,
    })
    expect(history.removed![0]).not.toHaveProperty('blockHash')
    const tx = await rpc.getTransaction(CONFLICTED_RECEIVE['txid'] as string)
    expect(tx).toMatchObject({ amountBits: 200_000_000n, confirmations: -1, trusted: false, details: [] })
  })

  it('keeps amounts above 2^53 bits and single bits exact', async () => {
    node.results({
      listsinceblock: sinceBlock([
        { ...SEND, amount: '#-90071992.54740993', fee: '#-0.00000001' },
        { ...RECEIVE, amount: '#210000000.00000000' },
        { ...RECEIVE, amount: '#0.00000001' },
      ]),
    })
    const { transactions } = await client().listSinceBlock()
    expect(transactions.map(entry => [entry.amountBits, entry.feeBits])).toEqual([
      [-9_007_199_254_740_993n, -1n],
      [21_000_000_000_000_000n, undefined],
      [1n, undefined],
    ])
  })

  it('sends its options positionally, including the payout adapter call', async () => {
    node.results({ listsinceblock: sinceBlock([]) })
    const rpc = client()
    await rpc.listSinceBlock()
    expect(params()).toEqual([])
    await rpc.listSinceBlock({ blockHash: BLOCK_1011.toUpperCase() })
    expect(params()).toEqual([BLOCK_1011])
    await rpc.listSinceBlock({ targetConfirmations: 6 })
    expect(params()).toEqual([null, 6])
    await rpc.listSinceBlock({ blockHash: BLOCK_1011, targetConfirmations: 1, includeChange: true })
    expect(params()).toEqual([BLOCK_1011, 1, null, null, true])
    await rpc.listSinceBlock({ includeWatchOnly: true, includeChange: false })
    expect(params()).toEqual([null, null, true, null, false])
    node.results({ listsinceblock: sinceBlock([], null) })
    // qbit-payments' payout adapter: listsinceblock(blockHash, 1, false, false, true).
    const adapter = await rpc.listSinceBlock({
      blockHash: BLOCK_1011,
      targetConfirmations: 1,
      includeWatchOnly: false,
      includeRemoved: false,
      includeChange: true,
    })
    expect(params()).toEqual([BLOCK_1011, 1, false, false, true])
    expect(adapter).toEqual({ transactions: [], lastBlock: TIP })
    expect(adapter).not.toHaveProperty('removed')
    await rpc.listSinceBlock({ includeRemoved: false })
    expect(params()).toEqual([null, null, null, false])
    expect(requests.listSinceBlock({ targetConfirmations: 2_147_483_647 }).params).toEqual([null, 2_147_483_647])
  })

  it('returns removed exactly when it was asked for', async () => {
    const rpc = client()
    node.results({ listsinceblock: sinceBlock([], null) })
    await invalid(rpc.listSinceBlock(), 'result.removed')
    await invalid(rpc.listSinceBlock({ includeRemoved: true }), 'result.removed')
    node.results({ listsinceblock: sinceBlock([], []) })
    expect(await rpc.listSinceBlock({ includeRemoved: true })).toEqual({
      transactions: [],
      removed: [],
      lastBlock: TIP,
    })
    await invalid(rpc.listSinceBlock({ includeRemoved: false }), 'result.removed')
  })

  it('rejects a malformed reply with the path of the offending value', async () => {
    const rpc = client()
    const cases: [string, string][] = [
      ['[]', 'result'],
      ['null', 'result'],
      [json({ removed: [], lastblock: TIP }), 'result.transactions'],
      [json({ transactions: {}, removed: [], lastblock: TIP }), 'result.transactions'],
      [json({ transactions: [], removed: null, lastblock: TIP }), 'result.removed'],
      [json({ transactions: [], removed: [] }), 'result.lastblock'],
      [sinceBlock([], [], TIP.toUpperCase()), 'result.lastblock'],
      [sinceBlock([], [], 'aa'), 'result.lastblock'],
      [sinceBlock([], [], null), 'result.lastblock'],
      [sinceBlock([SEND, 'x']), 'result.transactions[1]'],
      [sinceBlock([SEND, { ...RECEIVE, vout: -1 }]), 'result.transactions[1].vout'],
      [sinceBlock([], [SEND, { ...SEND, txid: 'aa' }]), 'result.removed[1].txid'],
    ]
    for (const [reply, path] of cases) {
      node.results({ listsinceblock: reply })
      await invalid(rpc.listSinceBlock(), path)
    }
  })

  it('checks arguments before sending anything', async () => {
    const rpc = client()
    const cases: [unknown, ErrorConstructor][] = [
      [5, TypeError],
      ['x', TypeError],
      [null, TypeError],
      [[BLOCK_1011], TypeError],
      [{ blockHash: '' }, TypeError],
      [{ blockHash: 'aa' }, TypeError],
      [{ blockHash: 'g'.repeat(64) }, TypeError],
      [{ blockHash: `${BLOCK_1011}00` }, TypeError],
      [{ blockHash: 5 }, TypeError],
      [{ blockHash: null }, TypeError],
      [{ targetConfirmations: 0 }, RangeError],
      [{ targetConfirmations: -1 }, RangeError],
      [{ targetConfirmations: 1.5 }, RangeError],
      [{ targetConfirmations: 2_147_483_648 }, RangeError],
      [{ targetConfirmations: NaN }, RangeError],
      [{ targetConfirmations: Infinity }, RangeError],
      [{ targetConfirmations: '1' }, RangeError],
      [{ targetConfirmations: null }, RangeError],
      [{ includeWatchOnly: 'false' }, TypeError],
      [{ includeRemoved: 0 }, TypeError],
      [{ includeRemoved: null }, TypeError],
      [{ includeChange: 1 }, TypeError],
    ]
    for (const [options, type] of cases) {
      await expect(rpc.listSinceBlock(options as never)).rejects.toThrow(type)
      expect(() => requests.listSinceBlock(options as never)).toThrow(type)
    }
    expect(node.requests).toHaveLength(0)
  })
})

// Each field with values qbit Core never prints there. Fields a send entry
// lacks are added with the bad value.
const MALFORMED: [string, unknown[]][] = [
  ['address', [5, null, '', 'qbrt1z with space', ['x']]],
  ['category', ['move', 'Send', '', 5, null]],
  ['amount', ['-1.5', '#-1e-8', '#-0.000000001', '#-210000000.00000001', null, true]],
  ['label', [5, null, ['x']]],
  ['vout', [-1, 1.5, '0', 4_294_967_296, '#1e0', null]],
  ['fee', ['-0.00038610', '#-0.000386101', '#-210000000.00000001', null]],
  ['abandoned', ['false', 0, null]],
  ['parent_descs', ['x', [5], null]],
  ['confirmations', [1.5, '1', '#9007199254740992', null]],
  ['generated', ['true', 1, null]],
  ['trusted', ['true', 1, null]],
  ['blockhash', [BLOCK_1011.toUpperCase(), 'aa', 5, null]],
  ['blockheight', [-1, 1.5, '1011', null]],
  ['blockindex', [-1, 1.5, null]],
  ['blocktime', [-1, 1.5, '1793733321', null]],
  ['txid', [(SEND['txid'] as string).toUpperCase(), 'aa', null]],
  ['wtxid', ['', 5, null]],
  ['walletconflicts', [null, 'x', [5], ['aa'], [BLOCK_1011.toUpperCase()]]],
  ['mempoolconflicts', [null, {}, ['aa']]],
  ['replaced_by_txid', ['aa', 5, null]],
  ['replaces_txid', ['aa', 5, null]],
  ['to', [5, null]],
  ['comment', [5, null]],
  ['time', [-1, 1.5, '1', null]],
  ['timereceived', [-1, 1.5, null]],
  ['bip125-replaceable', ['maybe', true, null]],
]

const REQUIRED = [
  'category',
  'amount',
  'vout',
  'abandoned',
  'confirmations',
  'txid',
  'wtxid',
  'walletconflicts',
  'mempoolconflicts',
  'time',
  'timereceived',
  'bip125-replaceable',
]

// Entries whose fields are well-formed but contradict each other.
const CONTRADICTORY: [string, Entry, string][] = [
  ['a positive send', { ...SEND, amount: '#1.50000000' }, 'amount'],
  ['a negative receive', { ...RECEIVE, amount: '#-2.25000000' }, 'amount'],
  ['a negative coinbase', { ...GENERATE, amount: '#-210.00000000' }, 'amount'],
  ['a negative orphan', { ...ORPHAN, amount: '#-0.00000001' }, 'amount'],
  ['a send without a fee', without(SEND, 'fee'), 'fee'],
  ['a receive with a fee', { ...RECEIVE, fee: '#-0.00038610' }, 'fee'],
  ['a block hash without a height', without(SEND, 'blockheight'), 'blockhash'],
  ['a block time alone', { ...REPLACED, blocktime: 1793733321 }, 'blockhash'],
  ['a confirmed entry with trusted', { ...SEND, trusted: true }, 'trusted'],
  ['an unconfirmed entry without trusted', without(REPLACEMENT, 'trusted'), 'trusted'],
  ['a conflicted entry without trusted', without(CONFLICTED, 'trusted'), 'trusted'],
  ['an orphan without trusted', without(ORPHAN, 'trusted'), 'trusted'],
  ['a mined entry with no confirmations', { ...SEND, confirmations: 0 }, 'confirmations'],
  ['a conflicted entry naming a block', { ...SEND, confirmations: -1 }, 'confirmations'],
  [
    'a confirmed entry without its block',
    without(without(without(without(SEND, 'blockhash'), 'blockheight'), 'blockindex'), 'blocktime'),
    'confirmations',
  ],
]

describe('wallet history entries', () => {
  it('reject each malformed field, in listSinceBlock transactions and removed and in listTransactions', async () => {
    const rpc = client()
    const check = async (entry: Entry, key: string): Promise<void> => {
      node.results({ listsinceblock: sinceBlock([RECEIVE, entry]) })
      await invalid(rpc.listSinceBlock(), `result.transactions[1].${key}`)
      node.results({ listsinceblock: sinceBlock([], [entry]) })
      await invalid(rpc.listSinceBlock(), `result.removed[0].${key}`)
      node.results({ listtransactions: json([entry]) })
      await invalid(rpc.listTransactions(), `result[0].${key}`)
    }
    const lists = ['parent_descs', 'walletconflicts', 'mempoolconflicts']
    for (const [key, values] of MALFORMED) {
      for (const value of values) {
        // A bad item of a list is reported at the item.
        await check({ ...SEND, [key]: value }, Array.isArray(value) && lists.includes(key) ? `${key}[0]` : key)
      }
    }
    for (const key of REQUIRED) await check(without(SEND, key), key)
  })

  it('reject entries whose fields contradict each other', async () => {
    const rpc = client()
    for (const [name, entry, key] of CONTRADICTORY) {
      node.results({ listtransactions: json([entry]) })
      const error = await failure(rpc.listTransactions())
      expect(error, name).toMatchObject({ reason: 'validation', path: `result[0].${key}` })
    }
  })
})

describe('listTransactions', () => {
  it('parses the entries, oldest first, with the same parser as listSinceBlock', async () => {
    node.results({ listtransactions: json([IMMATURE, SEND, ABANDONED]) })
    const entries = await client().listTransactions()
    expect(entries).toHaveLength(3)
    expect(entries[1]).toStrictEqual(bare(SEND_PARSED))
    expect(entries[2]).toMatchObject({ abandoned: true, amountBits: -125_000_000n, feeBits: -38_610n })
    node.results({ listtransactions: '[]' })
    expect(await client().listTransactions({ count: 0 })).toEqual([])
    for (const reply of ['{}', 'null', '"x"']) {
      node.results({ listtransactions: reply })
      await invalid(client().listTransactions(), 'result')
    }
  })

  it('sends its options positionally', async () => {
    node.results({ listtransactions: '[]' })
    const rpc = client()
    await rpc.listTransactions()
    expect(params()).toEqual([])
    await rpc.listTransactions({ label: 'deposit-alice' })
    expect(params()).toEqual(['deposit-alice'])
    await rpc.listTransactions({ label: '*', count: 100, skip: 20 })
    expect(params()).toEqual(['*', 100, 20])
    await rpc.listTransactions({ count: 5 })
    expect(params()).toEqual([null, 5])
    await rpc.listTransactions({ skip: 3 })
    expect(params()).toEqual([null, null, 3])
    await rpc.listTransactions({ includeWatchOnly: false })
    expect(params()).toEqual([null, null, null, false])
    // count + skip up to 2^31 - 1, with the node's default count of 10.
    await rpc.listTransactions({ count: 2_147_483_647 })
    await rpc.listTransactions({ count: 2_147_483_646, skip: 1 })
    await rpc.listTransactions({ skip: 2_147_483_637 })
    expect(params()).toEqual([null, null, 2_147_483_637])
  })

  it('checks arguments before sending anything', async () => {
    const rpc = client()
    const cases: [unknown, ErrorConstructor][] = [
      [5, TypeError],
      [null, TypeError],
      [{ label: '' }, TypeError],
      [{ label: 5 }, TypeError],
      [{ label: null }, TypeError],
      [{ count: -1 }, RangeError],
      [{ count: 1.5 }, RangeError],
      [{ count: 2_147_483_648 }, RangeError],
      [{ count: NaN }, RangeError],
      [{ count: Infinity }, RangeError],
      [{ count: '10' }, RangeError],
      [{ count: null }, RangeError],
      [{ skip: -1 }, RangeError],
      [{ skip: 0.5 }, RangeError],
      [{ skip: -Infinity }, RangeError],
      [{ skip: 10n }, RangeError],
      [{ count: 2_147_483_647, skip: 1 }, RangeError],
      [{ count: 1_073_741_824, skip: 1_073_741_824 }, RangeError],
      [{ skip: 2_147_483_638 }, RangeError],
      [{ includeWatchOnly: 'no' }, TypeError],
    ]
    for (const [options, type] of cases) {
      await expect(rpc.listTransactions(options as never)).rejects.toThrow(type)
      expect(() => requests.listTransactions(options as never)).toThrow(type)
    }
    expect(node.requests).toHaveLength(0)
  })
})

const BALANCES = {
  mine: { trusted: '#2098.49922780', untrusted_pending: '#0.00000000', immature: '#185300.48095437' },
  lastprocessedblock: { hash: TIP, height: 1010 },
}

describe('getBalances', () => {
  it('returns balances in bits, keeping an absent used balance apart from a zero one', async () => {
    const rpc = client()
    node.results({ getbalances: json(BALANCES) })
    const balances = await rpc.getBalances()
    expect(balances).toStrictEqual(
      bare({
        mine: { trustedBits: 209_849_922_780n, untrustedPendingBits: 0n, immatureBits: 18_530_048_095_437n },
        lastProcessedBlock: { hash: TIP, height: 1010 },
      })
    )
    expect(params()).toEqual([])
    // An avoid_reuse wallet.
    node.results({ getbalances: json({ ...BALANCES, mine: { ...BALANCES.mine, used: '#0.00000000' } }) })
    expect((await rpc.getBalances()).mine.usedBits).toBe(0n)
    node.results({ getbalances: json({ ...BALANCES, mine: { ...BALANCES.mine, used: '#2.00000000' } }) })
    expect((await rpc.getBalances()).mine.usedBits).toBe(200_000_000n)
    node.results({ getbalances: json({ ...BALANCES, mine: { ...BALANCES.mine, trusted: '#90071992.54740993' } }) })
    expect((await rpc.getBalances()).mine.trustedBits).toBe(9_007_199_254_740_993n)
  })

  it('rejects a malformed balance with its path, never reading it as zero', async () => {
    const rpc = client()
    const cases: [unknown, string][] = [
      [[], 'result'],
      [{ lastprocessedblock: BALANCES.lastprocessedblock }, 'result.mine'],
      [{ ...BALANCES, mine: null }, 'result.mine'],
      [{ ...BALANCES, mine: without(BALANCES.mine, 'trusted') }, 'result.mine.trusted'],
      [{ ...BALANCES, mine: without(BALANCES.mine, 'untrusted_pending') }, 'result.mine.untrusted_pending'],
      [{ ...BALANCES, mine: without(BALANCES.mine, 'immature') }, 'result.mine.immature'],
      [{ ...BALANCES, mine: { ...BALANCES.mine, trusted: '#-0.00000001' } }, 'result.mine.trusted'],
      [{ ...BALANCES, mine: { ...BALANCES.mine, trusted: '1.0' } }, 'result.mine.trusted'],
      [{ ...BALANCES, mine: { ...BALANCES.mine, trusted: null } }, 'result.mine.trusted'],
      [{ ...BALANCES, mine: { ...BALANCES.mine, untrusted_pending: '#0.000000001' } }, 'result.mine.untrusted_pending'],
      [{ ...BALANCES, mine: { ...BALANCES.mine, immature: '#210000000.00000001' } }, 'result.mine.immature'],
      [{ ...BALANCES, mine: { ...BALANCES.mine, used: null } }, 'result.mine.used'],
      [{ ...BALANCES, mine: { ...BALANCES.mine, used: '#-2.00000000' } }, 'result.mine.used'],
      [{ mine: BALANCES.mine }, 'result.lastprocessedblock'],
      [{ ...BALANCES, lastprocessedblock: { hash: 'aa', height: 1 } }, 'result.lastprocessedblock.hash'],
      [{ ...BALANCES, lastprocessedblock: { hash: TIP, height: -1 } }, 'result.lastprocessedblock.height'],
    ]
    for (const [reply, path] of cases) {
      node.results({ getbalances: json(reply) })
      await invalid(rpc.getBalances(), path)
    }
  })
})

const NEW_ADDRESS = 'qbrt1z0rp39fxhc5n2e3d8wujpeg8jt9cdthfh0dd9a6k0azavalrj4esqd3xj5k'

describe('getNewAddress', () => {
  it('sends the label and address type positionally and checks the address', async () => {
    const rpc = await confirmed()
    node.results({ getnewaddress: JSON.stringify(NEW_ADDRESS) })
    expect(await rpc.getNewAddress()).toBe(NEW_ADDRESS)
    expect(params()).toEqual([])
    expect(await rpc.getNewAddress({ label: 'deposit-alice' })).toBe(NEW_ADDRESS)
    expect(params()).toEqual(['deposit-alice'])
    await rpc.getNewAddress({ label: '' })
    expect(params()).toEqual([''])
    await rpc.getNewAddress({ addressType: 'p2mr' })
    expect(params()).toEqual([null, 'p2mr'])
    await rpc.getNewAddress({ label: 'user 7', addressType: 'p2mr' })
    expect(params()).toEqual(['user 7', 'p2mr'])
    for (const bad of ['""', '"qbrt1z with space"', '5', 'null', '["x"]']) {
      node.results({ getnewaddress: bad })
      await invalidAfterSideEffect(rpc.getNewAddress(), 'result')
    }
  })

  it('passes node errors through as definite answers', async () => {
    const rpc = await confirmed({ readRetries: 3 })
    for (const [code, message] of [
      [-5, "address type 'bech32' is not available on this chain"],
      [-11, 'Invalid label name'],
      [-4, 'Error: This wallet has no available keys'],
      [-12, "Output type 'bech32' is not available on this chain"],
    ] as const) {
      node.rpc(() => ({ error: { code, message } }))
      const before = node.requests.length
      const error = await failure(rpc.getNewAddress({ addressType: 'bech32' }))
      expect(RpcError.is(error)).toBe(true)
      expect(error).toMatchObject({ rpcCode: code, message })
      expect(node.requests).toHaveLength(before + 1)
    }
  })

  it('checks arguments before sending anything', async () => {
    const rpc = await confirmed()
    const before = node.requests.length
    const cases: [unknown, ErrorConstructor][] = [
      [5, TypeError],
      [null, TypeError],
      [{ label: 5 }, TypeError],
      [{ label: null }, TypeError],
      [{ label: '*' }, RangeError],
      [{ addressType: '' }, RangeError],
      [{ addressType: 'bogus' }, RangeError],
      [{ addressType: 'P2MR' }, RangeError],
      [{ addressType: 2 }, TypeError],
      [{ addressType: null }, TypeError],
    ]
    for (const [options, type] of cases) {
      await expect(rpc.getNewAddress(options as never)).rejects.toThrow(type)
      expect(() => requests.getNewAddress(options as never)).toThrow(type)
    }
    expect(node.requests).toHaveLength(before)
  })

  it('treats a dropped reply as an unknown outcome and never retries it', async () => {
    const rpc = await confirmed({ readRetries: 3, retryDelayMs: 1 })
    node.requests.length = 0
    node.handler = (_request, response) => response.socket?.destroy()
    const error = await failure(rpc.getNewAddress({ label: 'deposit-alice', addressType: 'p2mr' }))
    expect(RpcUnknownOutcomeError.is(error)).toBe(true)
    expect(error).toMatchObject({ method: 'getnewaddress' })
    expect(node.requests).toHaveLength(1)
  })

  it('uses a fresh connection for every call', async () => {
    const rpc = await confirmed()
    node.results({ getbalances: json(BALANCES), getnewaddress: JSON.stringify(NEW_ADDRESS) })
    node.requests.length = 0
    await rpc.getBalances()
    await rpc.getBalances()
    await rpc.getNewAddress()
    await rpc.getNewAddress()
    const [read1, read2, new1, new2] = node.requests
    expect(read1!.remotePort).toBe(read2!.remotePort)
    expect(new Set([read1!.remotePort, new1!.remotePort, new2!.remotePort]).size).toBe(3)
  })
})

describe('wallet history capabilities', () => {
  it('needs wallet-read for the reads and wallet-write and a confirmed chain for getNewAddress', async () => {
    node.results({
      ...chainResults('regtest'),
      listsinceblock: sinceBlock([]),
      listtransactions: '[]',
      getbalances: json(BALANCES),
      getnewaddress: JSON.stringify(NEW_ADDRESS),
    })
    const refusal = async (promise: Promise<unknown>): Promise<RpcCapabilityError> => {
      const error = await failure(promise)
      expect(RpcCapabilityError.is(error)).toBe(true)
      return error as RpcCapabilityError
    }
    const reader = client([])
    for (const promise of [reader.listSinceBlock(), reader.listTransactions(), reader.getBalances()]) {
      expect(await refusal(promise)).toMatchObject({ reason: 'not_enabled', required: 'wallet-read' })
    }
    for (const promise of [reader.getNewAddress(), reader.call('getnewaddress')]) {
      expect(await refusal(promise)).toMatchObject({ reason: 'not_enabled', required: 'wallet-write' })
    }
    const writer = client(['wallet-write'])
    expect(await refusal(writer.getBalances())).toMatchObject({ required: 'wallet-read' })
    expect(node.requests).toHaveLength(0)

    // Wallet reads need no chain check; getNewAddress does.
    const walletReader = client(['wallet-read'])
    expect((await walletReader.listSinceBlock()).lastBlock).toBe(TIP)
    expect(await walletReader.listTransactions()).toEqual([])
    expect((await walletReader.getBalances()).mine.trustedBits).toBe(209_849_922_780n)
    expect(await refusal(walletReader.getNewAddress())).toMatchObject({ required: 'wallet-write' })
    const sent = node.requests.length
    const guarded = await failure(writer.getNewAddress())
    expect(RpcChainGuardError.is(guarded)).toBe(true)
    expect(guarded).toMatchObject({ reason: 'unconfirmed' })
    expect(node.requests).toHaveLength(sent)
    await writer.confirmChain()
    expect(await writer.getNewAddress()).toBe(NEW_ADDRESS)

    expect(
      Object.fromEntries(
        ['listsinceblock', 'listtransactions', 'getbalances', 'getnewaddress'].map(m => [m, METHOD_POLICIES[m]])
      )
    ).toEqual({
      listsinceblock: { capability: 'wallet-read', sideEffects: false },
      listtransactions: { capability: 'wallet-read', sideEffects: false },
      getbalances: { capability: 'wallet-read', sideEffects: false },
      getnewaddress: { capability: 'wallet-write', sideEffects: true },
    })
  })

  it('batches the reads with typed results, and refuses getNewAddress in a batch', async () => {
    const rpc = client()
    node.results({
      listsinceblock: sinceBlock([SEND]),
      listtransactions: json([{ ...SEND, fee: null }]),
      getbalances: json(BALANCES),
    })
    const [since, list, balances] = await rpc.batch([
      requests.listSinceBlock({ blockHash: BLOCK_1011 }),
      requests.listTransactions({ count: 1 }),
      requests.getBalances(),
    ])
    expect(since.ok && since.value.transactions[0]).toStrictEqual(bare(SEND_PARSED))
    expect(!list.ok && list.error).toMatchObject({ reason: 'validation', path: 'result[0].fee' })
    expect(balances.ok && balances.value.mine.immatureBits).toBe(18_530_048_095_437n)
    const sent = node.requests.length
    const error = await failure(rpc.batch([requests.getBalances(), requests.getNewAddress()]))
    expect(error).toMatchObject({ reason: 'not_batchable', method: 'getnewaddress' })
    expect(node.requests).toHaveLength(sent)
  })

  it('retries the reads when readRetries allows it', async () => {
    const rpc = client(['wallet-read'], { readRetries: 2, retryDelayMs: 1 })
    let drops = 1
    node.rpc(() => ({ result: sinceBlock([SEND]) }))
    const answer = node.handler
    node.handler = (request, response) => {
      if (drops-- > 0) return void response.socket?.destroy()
      return answer(request, response)
    }
    expect((await rpc.listSinceBlock()).transactions).toHaveLength(1)
    expect(node.requests).toHaveLength(2)
  })
})
