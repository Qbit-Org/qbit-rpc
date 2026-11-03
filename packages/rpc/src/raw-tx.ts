// Adapted from SwapLabsInc/qbit-faucet src/rawTransaction.js (4eac8e8).
import { createHash } from 'node:crypto'

class Malformed extends Error {}

/**
 * The txid of a serialized transaction: double SHA-256 of the serialization
 * without witness data, in display (reversed) byte order. Returns undefined
 * when the hex is not a structurally complete transaction. Used to name the
 * transaction in an `RpcUnknownOutcomeError`; the node remains the judge of
 * whether the transaction is valid.
 */
export function rawTransactionTxid(hex: string): string | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined
  const bytes = Buffer.from(hex, 'hex')
  try {
    return parse(bytes)
  } catch (error) {
    if (error instanceof Malformed) return undefined
    throw error
  }
}

function parse(bytes: Buffer): string {
  let offset = 0
  const need = (length: number): void => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) throw new Malformed()
  }
  const skip = (length: number): void => {
    need(length)
    offset += length
  }
  const byte = (): number => {
    need(1)
    return bytes[offset++]!
  }
  const compactSize = (): number => {
    const prefix = byte()
    if (prefix < 0xfd) return prefix
    if (prefix === 0xfd) {
      need(2)
      const value = bytes.readUInt16LE(offset)
      offset += 2
      if (value < 0xfd) throw new Malformed()
      return value
    }
    if (prefix === 0xfe) {
      need(4)
      const value = bytes.readUInt32LE(offset)
      offset += 4
      if (value <= 0xffff) throw new Malformed()
      return value
    }
    need(8)
    const value = bytes.readBigUInt64LE(offset)
    offset += 8
    if (value <= 0xffff_ffffn || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Malformed()
    return Number(value)
  }

  if (bytes.length < 10) throw new Malformed()
  skip(4)
  let witness = false
  if (bytes[offset] === 0) {
    witness = true
    skip(1)
    if (byte() !== 1) throw new Malformed()
  }
  const baseStart = offset
  const inputs = compactSize()
  if (inputs < 1 || inputs > Math.floor(bytes.length / 41)) throw new Malformed()
  for (let i = 0; i < inputs; i += 1) {
    skip(36)
    skip(compactSize())
    skip(4)
  }
  const outputs = compactSize()
  if (outputs > Math.floor(bytes.length / 9)) throw new Malformed()
  for (let i = 0; i < outputs; i += 1) {
    skip(8)
    skip(compactSize())
  }
  const baseEnd = offset
  if (witness) {
    for (let i = 0; i < inputs; i += 1) {
      const items = compactSize()
      if (items > bytes.length) throw new Malformed()
      for (let j = 0; j < items; j += 1) skip(compactSize())
    }
  }
  const locktimeStart = offset
  skip(4)
  if (offset !== bytes.length) throw new Malformed()

  const stripped = witness
    ? Buffer.concat([bytes.subarray(0, 4), bytes.subarray(baseStart, baseEnd), bytes.subarray(locktimeStart)])
    : bytes
  const first = createHash('sha256').update(stripped).digest()
  return Buffer.from(createHash('sha256').update(first).digest()).reverse().toString('hex')
}
