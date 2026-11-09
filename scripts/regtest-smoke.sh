#!/usr/bin/env bash
# Live smoke test against a throwaway qbit Core regtest node.
#
# Usage: QBIT_BIN_DIR=/path/to/qbit-1.0.0/bin scripts/regtest-smoke.sh
#
# QBIT_BIN_DIR must hold qbitd and qbit-cli from the release named in
# scripts/qbit-core-release.mjs, verified. `node scripts/qbit-release.mjs fetch
# <new directory>` downloads it, checks SHA256SUMS against a quorum of the
# release keys pinned in scripts/qbit-release-keys/ and the tarball against
# SHA256SUMS, and prints the bin directory; CI's "regtest smoke" job runs this
# script with that directory on every pull request and push to main.
#
# The node runs with -regtest only, in a temporary data directory, with RPC,
# P2P and ZMQ bound to 127.0.0.1 on free ports, every ZMQ topic on one
# address, and no outbound connections. The ZMQ smoke test stops it and starts
# it again with the same command, ports and data directory. It is stopped and
# its data directory removed on exit.
set -euo pipefail

: "${QBIT_BIN_DIR:?set QBIT_BIN_DIR to the directory holding qbitd and qbit-cli}"
QBITD="$QBIT_BIN_DIR/qbitd"
CLI_BIN="$QBIT_BIN_DIR/qbit-cli"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected="$(node --input-type=module -e 'import { pathToFileURL } from "node:url"; console.log((await import(pathToFileURL(process.argv[1]).href)).QBIT_CORE_VERSION)' \
  "$repo_root/scripts/qbit-core-release.mjs")"
version="$("$QBITD" -version)"
version="${version%%$'\n'*}"
echo "$version"
case "$version" in
  *" v$expected "* | *" v$expected") ;;
  *)
    echo "QBIT_BIN_DIR holds '$version', not qbit Core v$expected: change scripts/qbit-core-release.mjs to test another release" >&2
    exit 1
    ;;
esac

datadir="$(mktemp -d "${TMPDIR:-/tmp}/qbit-rpc-regtest-XXXXXX")"
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
rpc_port="$(free_port)"
zmq_port="$(free_port)"

cli() { "$CLI_BIN" -regtest -datadir="$datadir" -rpcport="$rpc_port" "$@"; }
cleanup() {
  local status=$? pid stopped=0
  # The ZMQ smoke test may have restarted qbitd: stop whichever one runs now.
  pid="$(cat "$datadir/regtest/qbitd.pid" 2>/dev/null || true)"
  cli stop >/dev/null 2>&1 || true
  for _ in $(seq 1 300); do
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      stopped=1
      break
    fi
    sleep 0.2
  done
  # Only a qbitd of this data directory, never a process that reused its pid:
  # -datadir= this directory as a whole argument, read with -ww, as BSD and
  # macOS ps cut a command line to about 80 columns without it.
  if [ "$stopped" = 0 ] && ps -ww -o args= -p "$pid" 2>/dev/null |
    awk -v arg="-datadir=$datadir" 'index(" " $0 " ", " " arg " ") { found = 1 } END { exit !found }'; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  # How long qbitd's deferred keypool top-ups took: an encrypted wallet's runs
  # inside its first walletpassphrase, an unencrypted one's in the background.
  grep -h 'keypool top up completed' "$datadir/regtest/debug.log" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    echo "--- the last lines of qbitd's debug.log:"
    tail -n 40 "$datadir/regtest/debug.log" 2>/dev/null || true
  fi
  rm -rf "$datadir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

qbitd_cmd=(
  "$QBITD" -regtest -daemonwait -datadir="$datadir"
  -server=1 -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport="$rpc_port"
  -listen=0 -connect=0 -dnsseed=0 -fixedseeds=0
  -fallbackfee=0.0001 -txindex=1
)
for topic in hashblock hashtx rawblock rawtx sequence; do
  qbitd_cmd+=("-zmqpub$topic=tcp://127.0.0.1:$zmq_port")
done
"${qbitd_cmd[@]}"

cli -rpcwait getblockchaininfo >/dev/null
cli -named createwallet wallet_name=smoke descriptors=true >/dev/null
# Left locked: the rpc smoke test's first walletPassphrase with the right
# passphrase (not the wrong one before it) runs its deferred keypool top-up,
# under walletPassphrase's own default deadline.
cli -named createwallet wallet_name=locked descriptors=true passphrase=smoke-passphrase >/dev/null
mine_to="$(cli -rpcwallet=smoke getnewaddress "" p2mr)"
# qbit Core matures coinbase outputs after 1,000 blocks.
cli generatetoaddress 1010 "$mine_to" >/dev/null

export RUN_QBIT_REGTEST_SMOKE=1
export QBIT_REGTEST_RPC_URL="http://127.0.0.1:$rpc_port/"
export QBIT_REGTEST_COOKIE_FILE="$datadir/regtest/.cookie"
export QBIT_REGTEST_ZMQ_URL="tcp://127.0.0.1:$zmq_port"
export QBIT_REGTEST_CLI="$CLI_BIN -regtest -datadir=$datadir -rpcport=$rpc_port"
export QBIT_REGTEST_DATADIR="$datadir"
# The command that started the node, as a JSON array, for the restart case.
QBIT_REGTEST_QBITD="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "${qbitd_cmd[@]}")"
export QBIT_REGTEST_QBITD
cd "$repo_root"
corepack pnpm test:regtest
