import { createHash } from 'node:crypto'

import fc from 'fast-check'

/** A transaction as its fields, serialized by {@link serialize}. */
export interface TxFields {
  readonly version: number
  readonly inputs: readonly {
    readonly prevout: Uint8Array
    readonly vout: number
    readonly script: Uint8Array
    readonly sequence: number
  }[]
  readonly outputs: readonly { readonly value: bigint; readonly script: Uint8Array }[]
  /** One stack per input, or undefined for the legacy serialization without a witness. */
  readonly witness?: readonly (readonly Uint8Array[])[]
  readonly locktime: number
}

/** Bitcoin's CompactSize, always in its shortest form. */
export function compactSize(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n])
  if (n <= 0xffff) {
    const b = Buffer.alloc(3)
    b[0] = 0xfd
    b.writeUInt16LE(n, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = 0xfe
  b.writeUInt32LE(n, 1)
  return b
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const bytesWithLength = (bytes: Uint8Array): Buffer => Buffer.concat([compactSize(bytes.length), bytes])

/** The serialization, with the witness marker and flag when `witness` is set. */
export function serialize(tx: TxFields, { withWitness = true } = {}): Buffer {
  const parts: Buffer[] = [u32(tx.version)]
  const witness = withWitness ? tx.witness : undefined
  if (witness !== undefined) parts.push(Buffer.from([0, 1]))
  parts.push(compactSize(tx.inputs.length))
  for (const input of tx.inputs) {
    parts.push(Buffer.from(input.prevout), u32(input.vout), bytesWithLength(input.script), u32(input.sequence))
  }
  parts.push(compactSize(tx.outputs.length))
  for (const output of tx.outputs) {
    const value = Buffer.alloc(8)
    value.writeBigUInt64LE(output.value)
    parts.push(value, bytesWithLength(output.script))
  }
  if (witness !== undefined) {
    for (const stack of witness) {
      parts.push(compactSize(stack.length))
      for (const item of stack) parts.push(bytesWithLength(item))
    }
  }
  parts.push(u32(tx.locktime))
  return Buffer.concat(parts)
}

/** The txid, computed from the fields: double SHA-256 of the legacy serialization, byte-reversed. */
export function txidOf(tx: TxFields): string {
  const once = createHash('sha256')
    .update(serialize(tx, { withWitness: false }))
    .digest()
  return Buffer.from(createHash('sha256').update(once).digest()).reverse().toString('hex')
}

const uint32 = fc.integer({ min: 0, max: 0xffff_ffff })
/** Mostly short scripts, sometimes past 252 bytes, where CompactSize takes three bytes. */
const script = fc.oneof(
  { weight: 5, arbitrary: fc.uint8Array({ maxLength: 40 }) },
  { weight: 1, arbitrary: fc.uint8Array({ minLength: 250, maxLength: 300 }) }
)

/**
 * Transactions qbit Core's deserializer takes: at least one input (no input
 * count of 0, which reads as the witness marker), amounts within MAX_MONEY,
 * and, in the witness form, at least one non-empty stack item, since a
 * witness of empty stacks is refused as superfluous.
 */
export const transaction: fc.Arbitrary<TxFields> = fc
  .record({
    version: uint32,
    inputs: fc.array(
      fc.record({ prevout: fc.uint8Array({ minLength: 32, maxLength: 32 }), vout: uint32, script, sequence: uint32 }),
      { minLength: 1, maxLength: 4 }
    ),
    outputs: fc.array(fc.record({ value: fc.bigInt({ min: 0n, max: 2_100_000_000_000_000n }), script }), {
      maxLength: 4,
    }),
    segwit: fc.boolean(),
    stacks: fc.array(fc.array(script, { maxLength: 3 }), { minLength: 4, maxLength: 4 }),
    locktime: uint32,
  })
  .map(({ segwit, stacks, inputs, ...rest }): TxFields => {
    if (!segwit) return { ...rest, inputs }
    const witness = inputs.map((_, i) => stacks[i]!)
    if (!witness.some(stack => stack.some(item => item.length > 0))) witness[0] = [Uint8Array.of(1)]
    return { ...rest, inputs, witness }
  })
