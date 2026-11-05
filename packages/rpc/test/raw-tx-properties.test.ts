import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { rawTransactionTxid } from '../src/raw-tx'
import { fuzz, FUZZ_TIMEOUT_MS } from './helpers/fuzz'
import { compactSize, serialize, transaction, txidOf } from './helpers/raw-tx'

// The txid names a broadcast in an RpcUnknownOutcomeError, so a wrong one
// sends reconciliation after the wrong transaction. The smoke test checks the
// same generator against qbit Core's decoderawtransaction.

const isTxid = (value: string | undefined): boolean => value === undefined || /^[0-9a-f]{64}$/.test(value)

describe('rawTransactionTxid properties', () => {
  it(
    'is the double SHA-256 of the serialization without witness, in either hex case',
    () => {
      fc.assert(
        fc.property(transaction, tx => {
          const hex = serialize(tx).toString('hex')
          expect(rawTransactionTxid(hex)).toBe(txidOf(tx))
          expect(rawTransactionTxid(hex.toUpperCase())).toBe(txidOf(tx))
          // The legacy form of a witness transaction has the same txid.
          expect(rawTransactionTxid(serialize(tx, { withWitness: false }).toString('hex'))).toBe(txidOf(tx))
        }),
        fuzz(500)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'is undefined for a truncated transaction or one with trailing bytes',
    () => {
      fc.assert(
        fc.property(transaction, fc.nat(), fc.uint8Array({ minLength: 1, maxLength: 8 }), (tx, cut, extra) => {
          const bytes = serialize(tx)
          const truncated = bytes.subarray(0, cut % bytes.length)
          expect(rawTransactionTxid(truncated.toString('hex'))).toBeUndefined()
          expect(rawTransactionTxid(Buffer.concat([bytes, extra]).toString('hex'))).toBeUndefined()
        }),
        fuzz(500)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'is undefined for an input count in a longer CompactSize form than needed',
    () => {
      fc.assert(
        fc.property(transaction, fc.constantFrom('fd', 'fe', 'ff'), (tx, prefix) => {
          const bytes = serialize(tx)
          const at = tx.witness === undefined ? 4 : 6
          const count = tx.inputs.length
          const wide =
            prefix === 'fd'
              ? Buffer.from([0xfd, count, 0])
              : prefix === 'fe'
                ? Buffer.from([0xfe, count, 0, 0, 0])
                : Buffer.from([0xff, count, 0, 0, 0, 0, 0, 0, 0])
          expect(compactSize(count)).toHaveLength(1)
          const mutated = Buffer.concat([bytes.subarray(0, at), wide, bytes.subarray(at + 1)])
          expect(rawTransactionTxid(mutated.toString('hex'))).toBeUndefined()
        }),
        fuzz(200)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'never throws on a corrupted transaction, and returns a txid or undefined',
    () => {
      fc.assert(
        fc.property(
          transaction,
          fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 4 }),
          (tx, flips) => {
            const bytes = Buffer.from(serialize(tx))
            for (const [at, value] of flips) bytes[at % bytes.length] = value
            expect(isTxid(rawTransactionTxid(bytes.toString('hex')))).toBe(true)
          }
        ),
        fuzz(1000)
      )
    },
    FUZZ_TIMEOUT_MS
  )

  it(
    'never throws on any string, and returns a txid only for whole-byte hex',
    () => {
      const hexish = fc.string({ unit: fc.constantFrom(...'0123456789abcdefABCDEF'), maxLength: 200 })
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            hexish,
            fc.uint8Array({ maxLength: 120 }).map(b => Buffer.from(b).toString('hex'))
          ),
          text => {
            const txid = rawTransactionTxid(text)
            expect(isTxid(txid)).toBe(true)
            if (txid !== undefined) expect(text).toMatch(/^(?:[0-9a-fA-F]{2})+$/)
          }
        ),
        fuzz(1000)
      )
    },
    FUZZ_TIMEOUT_MS
  )
})
