// The PQC check before signing a PSBT. qbit Core v1.0.0's wallet counts one
// signature per input against each PQC key that signs it, and an exhausted key
// signs nothing and raises no error (src/wallet/pqc_usage.{h,cpp}): with two
// inputs of a key that has one signature left, walletprocesspsbt signs the
// first and leaves the second unsigned. So the client counts, per key, the
// signatures a PSBT needs against what each key has left before it signs.

import { PqcSigningError } from './errors'
import {
  argBase64,
  parseInput,
  parseOutput,
  parseScriptPubKey,
  type AddressInfo,
  type PqcLimitState,
  type RpcRequest,
} from './methods'
import { array, compact, field, hash, object, optional, ResultIssue } from './validate'

const R = 'result'

/** One of the wallet's PQC keys a PSBT needs signatures from, as `checkPqcSigning` counts them. */
export interface PqcSigningKey {
  /** The PQC public key, as hex. */
  readonly pubkey: string
  /** The addresses of the PSBT's inputs that hold the key, each once, in input order. */
  readonly addresses: readonly string[]
  /** The signatures signing takes from the key: one for each input whose address holds it. */
  readonly needed: number
  /** Its `pqcSignaturesRemaining` before signing: at least `needed`. */
  readonly remaining: number
  /** Its `pqcLimitState` before signing. */
  readonly state: 'normal' | 'warning' | 'critical'
}

/** `checkPqcSigning`'s answer: each of the wallet's PQC keys the PSBT needs signatures from has enough left. */
export interface PqcSigningPlan {
  /** The keys, in the order of the first input that needs each; empty when no input needs one of the wallet's. */
  readonly keys: readonly PqcSigningKey[]
  /** The worst state of the keys and of their addresses; `normal` when there are none. */
  readonly state: 'normal' | 'warning' | 'critical'
  /** One line, for people, per `critical` key: stop using its addresses, and spend their coins to a new address now. */
  readonly warnings: readonly string[]
}

type SigningState = PqcSigningKey['state']
const RANK: Readonly<Record<SigningState, number>> = { normal: 0, warning: 1, critical: 2 }

const worse = (a: SigningState, b: SigningState): SigningState => (RANK[b] > RANK[a] ? b : a)

/**
 * `decodepsbt`, read for the address of the output each input spends, or
 * undefined where it names none: its `non_witness_utxo`'s output when it has
 * one, which the node checks against the input's txid and the wallet signs
 * by, else its `witness_utxo`'s.
 */
export function psbtInputAddresses(psbt: string): RpcRequest<(string | undefined)[]> {
  return Object.freeze({ method: 'decodepsbt', params: [argBase64(psbt, 'psbt')], parse: parseInputAddresses })
}

function parseInputAddresses(value: unknown): (string | undefined)[] {
  const o = object(value, R)
  const vin = field(field(o, 'tx', R, object), 'vin', `${R}.tx`, (v, p) => array(v, p, parseInput))
  const inputs = field(o, 'inputs', R, (v, p) => array(v, p, object))
  if (inputs.length !== vin.length)
    throw new ResultIssue(`${R}.inputs`, `one entry per input of tx.vin (${vin.length})`)
  return inputs.map((input, index) => {
    const path = `${R}.inputs[${index}]`
    const spends = vin[index]!
    if (!('txid' in spends)) throw new ResultIssue(`${R}.tx.vin[${index}]`, 'an input that spends an output')
    const full = optional(input, 'non_witness_utxo', path, (v, p) => {
      const tx = object(v, p)
      if (field(tx, 'txid', p, hash) !== spends.txid) {
        throw new ResultIssue(`${p}.txid`, `the txid tx.vin[${index}] spends`)
      }
      const output = field(tx, 'vout', p, (vv, pp) => array(vv, pp, parseOutput))[spends.vout]
      if (output === undefined || output.n !== spends.vout)
        throw new ResultIssue(`${p}.vout`, `output ${spends.vout}, which tx.vin[${index}] spends`)
      return { address: nonEmpty(output.scriptPubKey.address, `${p}.vout[${spends.vout}].scriptPubKey.address`) }
    })
    const witness = optional(input, 'witness_utxo', path, (v, p) => {
      const spk = field(object(v, p), 'scriptPubKey', p, parseScriptPubKey)
      return nonEmpty(spk.address, `${p}.scriptPubKey.address`)
    })
    return full === undefined ? witness : full.address
  })
}

function nonEmpty(address: string | undefined, path: string): string | undefined {
  if (address === '') throw new ResultIssue(path, 'a non-empty address')
  return address
}

/** Each input's address, refusing an input without one: what it would sign with cannot be counted. */
export function inputAddresses(addresses: readonly (string | undefined)[]): string[] {
  return addresses.map((address, inputIndex) => {
    if (address === undefined) throw new PqcSigningError('no_address', { inputIndex })
    return address
  })
}

/** `state`, when a key in it still signs; else the refusal, about `where`. */
function signingState(
  state: PqcLimitState,
  where: { readonly inputIndex: number; readonly address: string; readonly pubkey?: string }
): SigningState {
  if (Object.hasOwn(RANK, state)) return state as SigningState
  throw new PqcSigningError(state === 'exhausted' ? 'exhausted' : 'unknown_state', { ...where, state })
}

/**
 * Count, per PQC key, the signatures signing inputs that spend from `spent`
 * (one address per input, in order) needs, from the wallet's `getaddressinfo`
 * of each address in `infos`: one per input whose address holds the key, so an
 * address with several keys needs one from each. Throws `PqcSigningError`,
 * address by address in input order, for a PQC state without its keys or a
 * key or address that is exhausted or in a state this version does not know,
 * then for the first key with fewer signatures left than it needs. An address
 * without PQC fields holds no PQC key of this wallet: nothing is counted.
 */
export function planPqcSigning(spent: readonly string[], infos: ReadonlyMap<string, AddressInfo>): PqcSigningPlan {
  // Each address once, by its first input, with how many inputs spend from it.
  const inputs = new Map<string, { readonly first: number; count: number }>()
  spent.forEach((address, index) => {
    const seen = inputs.get(address)
    if (seen === undefined) inputs.set(address, { first: index, count: 1 })
    else seen.count += 1
  })
  const keys = new Map<string, { addresses: string[]; needed: number; remaining: number; state: SigningState }>()
  let overall: SigningState = 'normal'
  for (const [address, { first, count }] of inputs) {
    const info = infos.get(address)!
    const where = { inputIndex: first, address }
    const listed = info.pqcKeyStates ?? []
    const states = [info.pqcOverallLimitState, info.pqcLimitState].filter(
      (state): state is PqcLimitState => state !== undefined
    )
    if (listed.length === 0) {
      const stated =
        states.length > 0 ||
        info.pqcSignatureCount !== undefined ||
        info.pqcSignatureLimit !== undefined ||
        info.pqcSignaturesRemaining !== undefined
      if (stated) throw new PqcSigningError('no_keys', where)
      continue
    }
    for (const key of listed) {
      const state = signingState(key.pqcLimitState, { ...where, pubkey: key.pubkey })
      const tally = keys.get(key.pubkey)
      if (tally === undefined) {
        keys.set(key.pubkey, { addresses: [address], needed: count, remaining: key.pqcSignaturesRemaining, state })
        continue
      }
      // A key listed again, for this address or another: it signs once per input, with the least left it reports.
      if (tally.addresses[tally.addresses.length - 1] !== address) {
        tally.addresses.push(address)
        tally.needed += count
      }
      tally.remaining = Math.min(tally.remaining, key.pqcSignaturesRemaining)
      tally.state = worse(tally.state, state)
    }
    for (const state of states) overall = worse(overall, signingState(state, where))
  }
  const plan: PqcSigningKey[] = []
  for (const [pubkey, { addresses, needed, remaining, state }] of keys) {
    // Signing must not run a key out partway: the inputs after it would stay unsigned.
    if (needed > remaining) throw new PqcSigningError('would_run_out', { pubkey, needed, remaining })
    overall = worse(overall, state)
    plan.push(compact<PqcSigningKey>({ pubkey, addresses, needed, remaining, state }))
  }
  return compact<PqcSigningPlan>({
    keys: plan,
    state: overall,
    warnings: plan
      .filter(key => key.state === 'critical')
      .map(
        key =>
          `PQC key ${key.pubkey} is critical, with ${key.remaining} signatures left and ${key.needed} for this PSBT: stop using its addresses, and spend their coins to a new address now`
      ),
  })
}
