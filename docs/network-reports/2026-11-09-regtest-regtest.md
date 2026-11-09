# Network verification: regtest on regtest

Result: **PASS**, 0 failures.

| | |
| --- | --- |
| date | 2026-11-09 |
| mode | regtest |
| qbit-rpc commit | 3c9b8c40b69a |
| @qbit-oss/rpc | 0.0.0 |
| @qbit-oss/zmq | 0.0.0 |
| Node.js | v24.22.2 |
| capabilities | wallet-read, wallet-write, broadcast |
| endpoint | loopback http |
| node version | /qbit:1.0.0/ (10000) |
| supported by @qbit-oss/rpc | true |
| chain | regtest |
| blocks | 1020 |
| headers | 1020 |
| initial block download | false |
| pruned | false |
| verification progress | 1 |
| connections | 0 |
| reachable networks | ipv4, ipv6 |
| warnings | none |
| duration | 57 s |

## Block walk

Blocks 721 to 1020: `getblockhash`, `getblockheader`, `getblock` and `getrawtransaction` (verbose) for every transaction, and one transaction a block compared with `call()`'s amounts.

| blocks | transactions | largest block (tx) | AuxPoW-version blocks | amount checks | amount mismatches |
| --- | --- | --- | --- | --- | --- |
| 300 | 300 | 1 | 0 | 300 | 0 |

## Samples

Every 5 s: the mempool (up to 200 entries), up to 20 outputs from the walk, `estimatesmartfee` 1 to 1008, and `getconfirmationtarget` at each security level for 1 QBT.

| at | mempool | entries read | entries gone | outputs read | fee estimates with a rate | fee estimates without | distinct fee rates | confirmation targets (low/medium/high/maximum) | hashrate source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-09T20:00:18.504Z | 0 | 0 | 0 | 20 | 0 | 1008 | 0 | 100000/100000/100000/100000 | fallback_merge_mining_pct |

## Self-send

Funded with `walletcreatefundedpsbt`, signed with `walletprocesspsbt`, finalized, preflighted with `testmempoolaccept`, broadcast with `sendrawtransaction` to a new address of the same wallet, and looked up by its txid.

| txid | amount | fee | outcome | in mempool | confirmations | PQC state |
| --- | --- | --- | --- | --- | --- | --- |
| 827a2be4c879942d262a8da2b674b0bd48db5ebb62939a55d68ee240e7c404ae | 0.00010000 | 0.00038610 | sent | true | 0 | normal |

## ZMQ soak

45 s on every topic. Each `hashblock` is looked up with `getblockheader`; at the end, every block since the start is walked back from the tip and matched against the `hashblock`s received. Health is sampled every 5 s.

| hashblock | hashtx | rawblock | rawtx | sequence | gaps | messages missed | malformed | reconnects (disconnected/failed) | largest rawblock (bytes) | hashblocks found over RPC | new blocks | blocks no message named | of them outside a blind window | health |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 13 | 14 | 13 | 14 | 13 | 5 | 0 | 0 | 1/0 | 4122 | 13 | 13 | 1 | 0 | receiving 8, unknown 1 |

## Fault injection (regtest)

Each against a throwaway regtest node on 127.0.0.1, through an HTTP proxy in front of qbitd where a gateway is simulated. A block is mined after each.

| fault | expected | observed | result |
| --- | --- | --- | --- |
| a node of another chain | confirmChain() and the broadcast refused with RpcChainGuardError, nothing sent | confirmChain: RpcChainGuardError mismatch (mismatch); send: RpcChainGuardError mismatch; the transaction is unknown to the node | as expected |
| a gateway answering 502 to a read | RpcTransportError http_status 502 | RpcTransportError http_status 502 | as expected |
| a gateway answering 504 after forwarding sendrawtransaction | RpcUnknownOutcomeError with the txid; reconciled: in the mempool | RpcUnknownOutcomeError (cause RpcTransportError http_status 504), txid matches; the transaction is in the mempool | as expected |
| a gateway answering 502 without forwarding sendrawtransaction | RpcUnknownOutcomeError; reconciled: unknown to the node, sent again by the same hex | RpcUnknownOutcomeError; the node did not have it, and took the same hex again | as expected |
| an abort during a read | RpcAbortedError | RpcAbortedError | as expected |
| an abort after sendrawtransaction was forwarded | RpcUnknownOutcomeError (cause RpcAbortedError) with the txid; reconciled: in the mempool | RpcUnknownOutcomeError (cause RpcAbortedError); the transaction is in the mempool | as expected |
| qbitd killed (SIGKILL) just after accepting sendrawtransaction | RpcUnknownOutcomeError with the txid; after a restart, reconciled by the txid, sent again if lost | RpcUnknownOutcomeError (cause RpcTransportError network ECONNRESET); after the restart the node had it in the mempool | as expected |
| a qbitd restart, which rotates the cookie | a read fails while it is down; afterwards the same client reads, re-checks the chain and broadcasts | while down: RpcTransportError credentials ENOENT; cookie rotated; then height 1041, chain confirmed, broadcast accepted | as expected |

## Failures

None.

## Record

```json
{
  "options": {
    "mode": "regtest",
    "blocks": 300,
    "durationMs": 45000,
    "intervalMs": 5000,
    "sendAmount": "0.0001",
    "confirmations": 0
  },
  "summary": {
    "date": "2026-11-09",
    "mode": "regtest",
    "qbit-rpc commit": "3c9b8c40b69a",
    "@qbit-oss/rpc": "0.0.0",
    "@qbit-oss/zmq": "0.0.0",
    "Node.js": "v24.22.2",
    "capabilities": "wallet-read, wallet-write, broadcast",
    "endpoint": "loopback http",
    "node version": "/qbit:1.0.0/ (10000)",
    "supported by @qbit-oss/rpc": true,
    "chain": "regtest",
    "blocks": 1020,
    "headers": 1020,
    "initial block download": false,
    "pruned": false,
    "verification progress": 1,
    "connections": 0,
    "reachable networks": "ipv4, ipv6",
    "warnings": "none",
    "duration": "57 s"
  },
  "node": {
    "endpoint": "loopback http",
    "node version": "/qbit:1.0.0/ (10000)",
    "supported by @qbit-oss/rpc": true,
    "chain": "regtest",
    "blocks": 1020,
    "headers": 1020,
    "initial block download": false,
    "pruned": false,
    "verification progress": 1,
    "connections": 0,
    "reachable networks": "ipv4, ipv6",
    "warnings": "none"
  },
  "walk": {
    "from": 721,
    "to": 1020,
    "blocks": 300,
    "transactions": 300,
    "auxpowVersionBlocks": 0,
    "amountChecks": 300,
    "amountMismatches": 0,
    "maxBlockTx": 1
  },
  "samples": [
    {
      "at": "2026-11-09T20:00:18.504Z",
      "entries": 0,
      "entriesGone": 0,
      "txOuts": 20,
      "feeRates": 0,
      "feeErrors": 1008,
      "mempoolSize": 0,
      "distinctFeeRates": 0,
      "hashrateSource": "fallback_merge_mining_pct",
      "targets": "100000/100000/100000/100000"
    }
  ],
  "pendingTxid": "827a2be4c879942d262a8da2b674b0bd48db5ebb62939a55d68ee240e7c404ae",
  "send": {
    "found": true,
    "txid": "827a2be4c879942d262a8da2b674b0bd48db5ebb62939a55d68ee240e7c404ae",
    "amount": "0.00010000",
    "fee": "0.00038610",
    "outcome": "sent",
    "inMempool": true,
    "confirmations": 0,
    "pqcOverallLimitState": "normal",
    "warnings": []
  },
  "zmqRestart": "2026-11-09T20:00:31.173Z",
  "zmq": {
    "counts": {
      "hashblock": 13,
      "hashtx": 14,
      "rawblock": 13,
      "rawtx": 14,
      "sequence": 13
    },
    "gaps": 5,
    "missed": 0,
    "malformed": {},
    "reconnects": {
      "disconnected": 1,
      "failed": 0
    },
    "maxRawBlock": 4122,
    "sequence": {
      "block_connected": 13
    },
    "hashblockMissed": 0,
    "hashblockUnsizedGaps": 1,
    "sequenceGaps": 1,
    "checks": {
      "confirmed": 13,
      "unknown": 0,
      "tipAtOnce": 13
    },
    "blocksSinceStart": 13,
    "unannounced": 1,
    "uncovered": 0,
    "blind": [
      {
        "from": 1023,
        "to": 1025
      }
    ],
    "health": {
      "receiving": 8,
      "unknown": 1
    }
  },
  "faults": [
    {
      "fault": "a node of another chain",
      "expected": "confirmChain() and the broadcast refused with RpcChainGuardError, nothing sent",
      "observed": "confirmChain: RpcChainGuardError mismatch (mismatch); send: RpcChainGuardError mismatch; the transaction is unknown to the node",
      "result": "as expected"
    },
    {
      "fault": "a gateway answering 502 to a read",
      "expected": "RpcTransportError http_status 502",
      "observed": "RpcTransportError http_status 502",
      "result": "as expected"
    },
    {
      "fault": "a gateway answering 504 after forwarding sendrawtransaction",
      "expected": "RpcUnknownOutcomeError with the txid; reconciled: in the mempool",
      "observed": "RpcUnknownOutcomeError (cause RpcTransportError http_status 504), txid matches; the transaction is in the mempool",
      "result": "as expected"
    },
    {
      "fault": "a gateway answering 502 without forwarding sendrawtransaction",
      "expected": "RpcUnknownOutcomeError; reconciled: unknown to the node, sent again by the same hex",
      "observed": "RpcUnknownOutcomeError; the node did not have it, and took the same hex again",
      "result": "as expected"
    },
    {
      "fault": "an abort during a read",
      "expected": "RpcAbortedError",
      "observed": "RpcAbortedError",
      "result": "as expected"
    },
    {
      "fault": "an abort after sendrawtransaction was forwarded",
      "expected": "RpcUnknownOutcomeError (cause RpcAbortedError) with the txid; reconciled: in the mempool",
      "observed": "RpcUnknownOutcomeError (cause RpcAbortedError); the transaction is in the mempool",
      "result": "as expected"
    },
    {
      "fault": "qbitd killed (SIGKILL) just after accepting sendrawtransaction",
      "expected": "RpcUnknownOutcomeError with the txid; after a restart, reconciled by the txid, sent again if lost",
      "observed": "RpcUnknownOutcomeError (cause RpcTransportError network ECONNRESET); after the restart the node had it in the mempool",
      "result": "as expected"
    },
    {
      "fault": "a qbitd restart, which rotates the cookie",
      "expected": "a read fails while it is down; afterwards the same client reads, re-checks the chain and broadcasts",
      "observed": "while down: RpcTransportError credentials ENOENT; cookie rotated; then height 1041, chain confirmed, broadcast accepted",
      "result": "as expected"
    }
  ]
}
```
