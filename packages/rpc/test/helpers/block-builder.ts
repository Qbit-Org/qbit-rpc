import { createHash } from 'node:crypto'

import type { AuxBlock, BlockTemplate } from '../../src'

// What a pool does with a template or an aux candidate, enough for regtest's
// minimum difficulty: the layouts are those of qbit Core v1.0.0's
// test/functional/test_framework/auxpow.py and blocktools.py.

const MERGED_MINING_HEADER = 'fabe6d6d'

const sha256d = (data: Buffer): Buffer =>
  createHash('sha256').update(createHash('sha256').update(data).digest()).digest()
/** A hash in display order to the byte order a serialization holds. */
const internal = (displayHash: string): Buffer => Buffer.from(displayHash, 'hex').reverse()
const display = (internalHash: Buffer): string => Buffer.from(internalHash).reverse().toString('hex')

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value >>> 0)
  return out
}

function int32(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeInt32LE(value)
  return out
}

function uint64(value: bigint): Buffer {
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(value)
  return out
}

function compactSize(value: number): Buffer {
  if (value < 0xfd) return Buffer.from([value])
  const out = Buffer.alloc(3)
  out[0] = 0xfd
  out.writeUInt16LE(value, 1)
  return out
}

const sized = (data: Buffer): Buffer => Buffer.concat([compactSize(data.length), data])

/** BIP34: the height as `CScript() << height` writes it, OP_1 to OP_16 for small ones. */
function heightScript(height: number): Buffer {
  if (height >= 1 && height <= 16) return Buffer.from([0x50 + height])
  const bytes: number[] = []
  for (let rest = height; rest > 0; rest = Math.floor(rest / 256)) bytes.push(rest % 256)
  if (bytes[bytes.length - 1]! >= 0x80) bytes.push(0)
  return Buffer.from([bytes.length, ...bytes])
}

function merkleRoot(leaves: readonly Buffer[]): Buffer {
  let level = [...leaves]
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]!)
    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(Buffer.concat([level[i]!, level[i + 1]!])))
    level = next
  }
  return level[0]!
}

/** Set the header's nonce so that its hash meets `target`, or with `above`, does not. Most tries succeed on regtest. */
function grind(header: Buffer, target: bigint, above = false): void {
  for (let nonce = 0; nonce <= 0xffff_ffff; nonce += 1) {
    header.writeUInt32LE(nonce, 76)
    if (BigInt(`0x${display(sha256d(header))}`) <= target !== above) return
  }
  throw new Error('no nonce found')
}

/**
 * A block from a template: a coinbase paying `payoutScript`, with the witness
 * commitment the template gives, then the template's transactions; a header
 * solved for its target.
 */
export function buildBlock(
  template: BlockTemplate,
  payoutScript: string,
  options: { readonly coinbaseValueBits?: bigint; readonly unsolved?: boolean } = {}
): { readonly hash: string; readonly hex: string } {
  const scriptSig = Buffer.concat([heightScript(template.height), Buffer.from([0x01, 0x00])])
  const coinbase = (witness: boolean): Buffer =>
    Buffer.concat([
      int32(2),
      ...(witness ? [Buffer.from([0x00, 0x01])] : []),
      compactSize(1),
      Buffer.alloc(32),
      uint32(0xffff_ffff),
      sized(scriptSig),
      uint32(0xffff_ffff),
      compactSize(2),
      uint64(options.coinbaseValueBits ?? template.coinbaseValueBits),
      sized(Buffer.from(payoutScript, 'hex')),
      uint64(0n),
      sized(Buffer.from(template.defaultWitnessCommitment!, 'hex')),
      ...(witness ? [compactSize(1), sized(Buffer.alloc(32))] : []),
      uint32(0),
    ])
  const root = merkleRoot([sha256d(coinbase(false)), ...template.transactions.map(tx => internal(tx.txid))])
  const header = Buffer.concat([
    int32(template.version),
    internal(template.previousBlockHash),
    root,
    uint32(template.curTime),
    internal(template.bits),
    uint32(0),
  ])
  grind(header, BigInt(`0x${template.target}`), options.unsolved === true)
  return {
    hash: display(sha256d(header)),
    hex: Buffer.concat([
      header,
      compactSize(1 + template.transactions.length),
      coinbase(true),
      ...template.transactions.map(tx => Buffer.from(tx.data, 'hex')),
    ]).toString('hex'),
  }
}

/**
 * An AuxPoW proof for a candidate, in qbit's canonical layout: a parent
 * coinbase whose scriptSig commits to the candidate's hash, with no merkle
 * branches, under a parent header solved for the candidate's target.
 * `commitTo`, `chainIndex` and `unsolved` make it wrong in one way each.
 */
export function buildAuxPow(
  candidate: AuxBlock,
  options: { readonly commitTo?: string; readonly chainIndex?: number; readonly unsolved?: boolean } = {}
): string {
  const root = options.commitTo ?? candidate.hash
  const commitment = Buffer.concat([
    Buffer.from(MERGED_MINING_HEADER, 'hex'),
    candidate.commitmentOrder === 'display' ? Buffer.from(root, 'hex') : internal(root),
    uint32(1), // The merkle size: this chain alone.
    uint32(0), // The nonce, from which the chain's slot follows; slot 0 of a tree of one.
  ])
  const parentCoinbase = Buffer.concat([
    int32(1),
    compactSize(1),
    Buffer.alloc(32),
    uint32(0xffff_ffff),
    sized(sized(commitment)),
    uint32(0xffff_ffff),
    compactSize(1),
    uint64(0n),
    sized(Buffer.from([0x51])),
    uint32(0),
  ])
  const parentHeader = Buffer.concat([
    int32(1),
    Buffer.alloc(32),
    sha256d(parentCoinbase),
    uint32(0),
    internal(candidate.bits),
    uint32(0),
  ])
  grind(parentHeader, BigInt(`0x${candidate.target}`), options.unsolved === true)
  return Buffer.concat([
    parentCoinbase,
    compactSize(0),
    int32(0),
    compactSize(0),
    int32(options.chainIndex ?? 0),
    parentHeader,
  ]).toString('hex')
}
