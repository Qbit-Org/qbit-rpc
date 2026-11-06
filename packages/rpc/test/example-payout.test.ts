import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Imported by a path tsc does not follow: the example is type-checked on its own, against the packed
// package (consumer:check), not under this package's test settings.
interface Payout {
  readonly requestId: string
  readonly address: string
  readonly amountBits: bigint
  readonly txid: string
  readonly hex: string
}
interface Store {
  claim(requestId: string): Promise<boolean>
  get(requestId: string): Promise<(Payout & { readonly state: string }) | undefined>
  saveSigned(payout: Payout): Promise<void>
  unsettled(): Promise<Payout[]>
  settle(requestId: string, outcome: 'confirmed' | 'conflicted'): Promise<void>
}
const EXAMPLE: string = new URL('../../../examples/payout.ts', import.meta.url).href
const { directoryStore } = (await import(EXAMPLE)) as { directoryStore: (dir: string) => Store }

// examples/payout.ts's store: a payment request is claimed once, so two runs of
// the same request at once can never both fund and broadcast it.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qbit-rpc-example-payout-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const payout = { requestId: 'invoice-42', address: 'tq1x', amountBits: 150_000_000n, txid: 'aa'.repeat(32), hex: '00' }

describe('examples/payout.ts directoryStore', () => {
  it('lets one of two overlapping runs claim a request, and only one', async () => {
    const [first, second] = [directoryStore(dir), directoryStore(dir)]
    const claims = await Promise.all([first.claim('invoice-42'), second.claim('invoice-42')])
    expect(claims.filter(Boolean)).toHaveLength(1)
    // A later run sees the claim too, before anything is stored.
    expect(await directoryStore(dir).claim('invoice-42')).toBe(false)
    expect(await first.get('invoice-42')).toBeUndefined()
    // Another request is its own claim.
    expect(await first.claim('invoice-43')).toBe(true)
  })

  it('stores, reads back and settles a payout, its amount exact, and lists it only while unsettled', async () => {
    const store = directoryStore(dir)
    await store.saveSigned(payout)
    expect(await store.get('invoice-42')).toEqual({ ...payout, state: 'signed' })
    expect(await store.unsettled()).toEqual([{ ...payout, state: 'signed' }])
    await store.settle('invoice-42', 'confirmed')
    expect(await store.unsettled()).toEqual([])
    expect((await store.get('invoice-42'))?.state).toBe('confirmed')
    // Written by rename: no temporary file is left behind.
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
