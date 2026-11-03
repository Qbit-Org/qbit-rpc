#!/usr/bin/env bash
# Live smoke test against a throwaway qbit Core regtest node.
#
# Usage: QBIT_BIN_DIR=/path/to/qbit-1.0.0/bin scripts/regtest-smoke.sh
#
# Use the signed v1.0.0 release (verify SHA256SUMS.asc with the operator keys
# in qbit's contrib/keys, then the tarball against SHA256SUMS). The node runs
# with -regtest only, in a temporary data directory, with RPC, P2P and ZMQ
# bound to 127.0.0.1 on free ports and no outbound connections. It is stopped
# and its data directory removed on exit.
set -euo pipefail

: "${QBIT_BIN_DIR:?set QBIT_BIN_DIR to the directory holding qbitd and qbit-cli}"
QBITD="$QBIT_BIN_DIR/qbitd"
CLI_BIN="$QBIT_BIN_DIR/qbit-cli"
"$QBITD" -version | head -1

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
datadir="$(mktemp -d "${TMPDIR:-/tmp}/qbit-rpc-regtest-XXXXXX")"
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
rpc_port="$(free_port)"
zmq_port="$(free_port)"

cli() { "$CLI_BIN" -regtest -datadir="$datadir" -rpcport="$rpc_port" "$@"; }
cleanup() {
  cli stop >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do
    [ -f "$datadir/regtest/qbitd.pid" ] || break
    sleep 0.2
  done
  rm -rf "$datadir"
}
trap cleanup EXIT

"$QBITD" -regtest -daemonwait -datadir="$datadir" \
  -server=1 -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport="$rpc_port" \
  -listen=0 -connect=0 -dnsseed=0 -fixedseeds=0 \
  -zmqpubhashblock="tcp://127.0.0.1:$zmq_port" -zmqpubsequence="tcp://127.0.0.1:$zmq_port" \
  -fallbackfee=0.0001 -txindex=1

cli -rpcwait getblockchaininfo >/dev/null
cli -named createwallet wallet_name=smoke descriptors=true >/dev/null
cli -named createwallet wallet_name=locked descriptors=true passphrase=smoke-passphrase >/dev/null
mine_to="$(cli -rpcwallet=smoke getnewaddress "" p2mr)"
# qbit Core matures coinbase outputs after 1,000 blocks.
cli generatetoaddress 1010 "$mine_to" >/dev/null

export RUN_QBIT_REGTEST_SMOKE=1
export QBIT_REGTEST_RPC_URL="http://127.0.0.1:$rpc_port/"
export QBIT_REGTEST_COOKIE_FILE="$datadir/regtest/.cookie"
export QBIT_REGTEST_ZMQ_URL="tcp://127.0.0.1:$zmq_port"
export QBIT_REGTEST_CLI="$CLI_BIN -regtest -datadir=$datadir -rpcport=$rpc_port"
cd "$repo_root"
corepack pnpm test:regtest
