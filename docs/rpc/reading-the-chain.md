# Reading the chain

## Large replies

qbit Core v1.0.0's largest block is 2,000,000 bytes, and its verbose JSON is many
times that: a transaction's hex, and its witness again, print at twice their
size, and each output prints its script three ways and its address. A 3.8 kB
P2MR spend prints about 16 kB, and a 1.92 MB regtest block of 8,800-output
transactions printed 21.1 MB at verbosity 2 (1.3 kB at verbosity 1, 3.8 MB at
verbosity 0), past the default `maxResponseBytes` of 16 MiB. A reply over the cap
stops at the cap as `RpcResponseTooLargeError`, which for a read changes nothing
on the node: it is not retried, and the same call will fail the same way.

A client that reads whole blocks should set `maxResponseBytes` above what it
expects, such as `64 * 1024 * 1024` (the most is 256 MiB), knowing that it holds
each reply in memory as it parses it. The limit is per client, so a scanner can
have its own. Alternatively read `getBlock` for the txids, and each transaction
with `getRawTransactionVerbose(txid, { blockHash })`. That block took 0.2 s to
answer on loopback; a slow link needs a longer `timeoutMs`, which bounds the
whole read.

`getRawMempoolVerbose()` has the same bound: an entry prints about 450 bytes, so
a mempool of some 37,000 transactions passes 16 MiB, which the default 300 MB
mempool can hold. `getRawMempool()` prints about 67 bytes per transaction.

## Long polls

`waitForNewBlock` and `waitForBlockHeight` are a fallback where
[`@qbit-oss/zmq`](../../packages/zmq/README.md) is not available. The node holds the request
until a block arrives or `waitMs` has passed, then answers with the tip, which is
not an error when the wait ran out:

```ts
let tip = await rpc.getBestBlockHash()
for (;;) {
  const next = await rpc.waitForNewBlock(60_000, { currentTip: tip })
  if (next.hash === tip) continue // the wait ran out
  tip = next.hash
}
// Below the height asked for: the wait ran out.
const { height } = await rpc.waitForBlockHeight(target, 60_000)
```

Pass `currentTip`: without it the node waits for a change from the tip when it
runs the call, and a block found between two calls is missed. For the same
reason, `waitForNewBlock` without `currentTip` is never retried, whatever
`readRetries`: a retry would wait from the tip at the retry, past a block found
since the first attempt. With `currentTip` it is safe to retry, as
`waitForBlockHeight` is.

**`waitMs` and the deadline.** `waitMs` is the node's own timeout, from 1 to
3,590,000 ms. qbit Core reads 0 as no timeout, so it is refused. The deadline
must outlast it by 10 s, for the wait for a request slot and the reply, or a
call that sees no block could only end as a timeout, so the client's
`timeoutMs` does not cut it short: unless the call gives its own, the deadline
is the longer of `waitMs` plus 10 s and the client's `timeoutMs`. A call's own
`timeoutMs` below `waitMs` plus 10 s is a `RangeError`, unsent. A 34 s wait,
longer than `qbitd`'s `-rpcservertimeout` of 30 s, answered in 34.007 s on
regtest. Each attempt asks the node to wait no longer than the deadline has
left, less those 10 s (of which a first attempt's own setup may use 1 s):
after a long wait for a request slot, or on a retry under `readRetries`, that
is less than `waitMs`, so the call answers with the tip rather than time out,
and with nothing left it ends as an `RpcTimeoutError` without sending. A long
poll is never in a batch, however its request was built. As a read, that is safe to call again.

**Other calls.** A long poll holds a [request slot](errors.md#the-work-queue) and a
`qbitd` worker for its whole wait. One leaves the other seven slots of the
default `maxConcurrentRequests` free, but `maxConcurrentRequests` long polls stop
that client's other calls, which wait behind them and can time out unsent, so give
long polls their own client, or count them in the limit. Across all clients, keep
long polls well below `-rpcthreads` (default 16): with all workers holding one,
every other request to the node waits, which is not refused.

**Giving up.** `qbitd` does not notice a client that left. A long poll aborted or
past its deadline frees its slot at once, but holds its worker until its wait ends
or a block arrives: with 16 abandoned 20 s waits on regtest, a plain read took 19 s.
Keep `waitMs` to what you would wait for anyway.

A long poll is refused in a batch (`not_batchable`), typed or raw: the batch's
other calls would wait behind it, under one deadline. Through `call()` and
`requests.raw()` the same rules apply, the wait read from the method's timeout
parameter (`waitfornewblock`'s first, `waitforblockheight`'s second): it must
be 1 to 3,590,000 ms, and absent or 0, which the node reads as a wait with no
end, it is a `RangeError` that says to pass a timeout. `waitforblock`, which
`extraMethods` can open, is bounded the same way by its second parameter.
