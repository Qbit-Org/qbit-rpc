# Amounts

No JS `number` carries money. Amounts are `bigint` bits (1 QBT = 100,000,000
bits; the 210,000,000 QBT cap is 2.1e16 bits, above 2^53). Fee rates are
`bigint` bits per 1,000 vbytes, qbit Core's `CFeeRate` unit: `1_000n` is
1 bit/vB.

- Replies are parsed from their source text, so `90071992.54740993` QBT becomes
  exactly `9007199254740993n`. Amounts with more than 8 decimals, negative
  amounts where the field cannot be negative, exponents and values above the
  cap fail validation.
- Outgoing amounts must be `bigint`s from 0 to the cap and are written as exact
  decimal JSON numbers (`0.00000001`). Numbers, `NaN`, `Infinity`, negative or
  oversized values are refused before sending.
- `parseQbt(text)` and `formatQbt(bits)` convert at your boundaries. `parseQbt`
  reads `-0` and `-0.00000000` as `0n`, without `allowNegative`: zero is not
  negative. It reads `allowNegative` as its options' own property: left out, the
  options read as empty, and an inherited one is a `TypeError`.
- `call()` returns every JSON number as a `JsonNumber`: use `toBits()`,
  `toBigInt()`, `toSafeInteger()` or `toNumber()`. Arithmetic on it throws.
  Pass amounts to `call()` as `formatQbt(bits)` strings, which qbit Core
  accepts, and large integers as `bigint`.
