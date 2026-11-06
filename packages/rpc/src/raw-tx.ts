// A transaction's txid from its hex, written from public sources: BIP 144's
// serialization (https://github.com/bitcoin/bips/blob/master/bip-0144.mediawiki)
// and the checks Bitcoin Core applies when it reads one
// (UnserializeTransaction in src/primitives/transaction.h and ReadCompactSize
// in src/serialize.h), which qbit Core keeps.
// The regtest smoke test compares the result with qbit Core's
// decoderawtransaction.
import { createHash } from 'node:crypto'

/** The largest CompactSize Bitcoin Core reads (MAX_SIZE, src/serialize.h). */
const MAX_COMPACT_SIZE = 0x02000000

/** Why a read stopped: the hex is not one whole transaction. */
class Malformed extends Error {}

/** A cursor over the transaction's bytes; every read fails past the end. */
class Reader {
  offset = 0

  constructor(readonly bytes: Buffer) {}

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  skip(length: number): void {
    if (length > this.remaining) throw new Malformed()
    this.offset += length
  }

  byte(): number {
    if (this.remaining < 1) throw new Malformed()
    return this.bytes[this.offset++]!
  }

  /** A CompactSize in its shortest form, as Bitcoin Core requires, and at most MAX_SIZE. */
  compactSize(): number {
    const first = this.byte()
    let value: number
    let least: number
    if (first < 0xfd) return first
    if (first === 0xfd) {
      if (this.remaining < 2) throw new Malformed()
      value = this.bytes.readUInt16LE(this.offset)
      this.offset += 2
      least = 0xfd
    } else if (first === 0xfe) {
      if (this.remaining < 4) throw new Malformed()
      value = this.bytes.readUInt32LE(this.offset)
      this.offset += 4
      least = 0x10000
    } else {
      if (this.remaining < 8) throw new Malformed()
      const big = this.bytes.readBigUInt64LE(this.offset)
      this.offset += 8
      if (big > BigInt(MAX_COMPACT_SIZE)) throw new Malformed()
      value = Number(big)
      least = 0x100000000
    }
    if (value < least || value > MAX_COMPACT_SIZE) throw new Malformed()
    return value
  }

  /** A CompactSize length, then that many bytes. */
  varBytes(): void {
    this.skip(this.compactSize())
  }
}

/** Inputs: previous txid, output index, script, sequence. */
function readInputs(reader: Reader): number {
  const count = reader.compactSize()
  // Each input takes at least 41 bytes: a count past what is left cannot be whole.
  if (count * 41 > reader.remaining) throw new Malformed()
  for (let i = 0; i < count; i++) {
    reader.skip(36)
    reader.varBytes()
    reader.skip(4)
  }
  return count
}

/** Outputs: value, script. */
function readOutputs(reader: Reader): void {
  const count = reader.compactSize()
  // Each output takes at least 9 bytes.
  if (count * 9 > reader.remaining) throw new Malformed()
  for (let i = 0; i < count; i++) {
    reader.skip(8)
    reader.varBytes()
  }
}

/**
 * The serialization without witness data, read as Bitcoin Core's
 * UnserializeTransaction reads one that may be in BIP 144's extended format.
 * Throws Malformed unless `bytes` is one transaction exactly.
 */
function strippedSerialization(bytes: Buffer): Buffer {
  const reader = new Reader(bytes)
  reader.skip(4) // version
  let start = reader.offset
  let inputs = readInputs(reader)
  let flags = 0
  if (inputs === 0) {
    // An empty input list is BIP 144's marker; the flag byte follows.
    flags = reader.byte()
    if (flags !== 0) {
      start = reader.offset
      inputs = readInputs(reader)
      readOutputs(reader)
    }
  } else {
    readOutputs(reader)
  }
  const end = reader.offset
  if ((flags & 1) !== 0) {
    flags ^= 1
    let anyWitness = false
    for (let i = 0; i < inputs; i++) {
      const items = reader.compactSize()
      if (items > reader.remaining) throw new Malformed()
      if (items > 0) anyWitness = true
      for (let j = 0; j < items; j++) reader.varBytes()
    }
    // "Superfluous witness record": the flag with no witness data at all.
    if (!anyWitness) throw new Malformed()
  }
  // "Unknown transaction optional data".
  if (flags !== 0) throw new Malformed()
  const locktime = reader.offset
  reader.skip(4)
  if (reader.remaining !== 0) throw new Malformed()
  return Buffer.concat([bytes.subarray(0, 4), bytes.subarray(start, end), bytes.subarray(locktime)])
}

/**
 * The txid of a serialized transaction: double SHA-256 of the serialization
 * without witness data, in display (reversed) byte order. Returns undefined
 * when the hex is not a structurally complete transaction. Used to name the
 * transaction in an `RpcUnknownOutcomeError`; the node remains the judge of
 * whether the transaction is valid.
 */
export function rawTransactionTxid(hex: string): string | undefined {
  if (typeof hex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return undefined
  try {
    // One reading only: a second, legacy-only reading (as decoderawtransaction
    // may try) can take a witness transaction with stray bytes for another one.
    return displayHash(strippedSerialization(Buffer.from(hex, 'hex')))
  } catch (error) {
    if (error instanceof Malformed) return undefined
    throw error
  }
}

/**
 * The double SHA-256 of `bytes` in display (reversed) byte order, as qbit Core
 * prints a txid or a block hash.
 */
export function displayHash(bytes: Uint8Array): string {
  const first = createHash('sha256').update(bytes).digest()
  return createHash('sha256').update(first).digest().reverse().toString('hex')
}
