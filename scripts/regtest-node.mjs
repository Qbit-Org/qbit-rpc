// What scripts/capture-rpc-fixtures.mjs needs to stop its throwaway regtest
// qbitd and to keep host details out of its fixtures, apart so
// scripts/regtest-node.test.mjs can test it without a node. Stopping follows
// scripts/regtest-smoke.sh: ask, wait a bounded time while the process lives,
// then kill it, and only a qbitd of this data directory.
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'

/** Block for `ms`: cleanup also runs from a signal handler, synchronously. */
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether `pid` runs with `-datadir=<datadir>` as a whole argument: never a
 * process that reused the pid of one that exited, nor one whose data directory
 * only starts with this one. `-ww`, as BSD and macOS `ps` cut a command line
 * to the terminal's width, or about 80 columns, without it.
 */
export function ownsDatadir(pid, datadir) {
  try {
    const args = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new RegExp(`(?:^|\\s)${escapeRegExp(`-datadir=${datadir}`)}(?:\\s|$)`).test(args)
  } catch {
    return false // ps exits 1 when there is no such process
  }
}

/**
 * Stop the qbitd of `datadir`, whose pid is in `pidFile`, and remove
 * `datadir`. `stop` asks it to stop (`qbit-cli stop`, with its own timeout),
 * and may throw when nothing answers. Waits up to `waitMs` for the process to
 * exit, then kills it. A missing or stale pid file, or a pid another process
 * now has, is not waited for. Throws, leaving `datadir`, if the process is
 * still there after the kill.
 */
export function stopNode({ datadir, pidFile, stop, waitMs = 60_000 }) {
  let pid
  try {
    pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
  } catch {
    // Never started, or already gone.
  }
  try {
    stop()
  } catch {
    // Not answering: the wait and the kill below decide.
  }
  if (Number.isSafeInteger(pid) && pid > 0) {
    for (const deadline = Date.now() + waitMs; ownsDatadir(pid, datadir) && Date.now() < deadline;) sleep(200)
    if (ownsDatadir(pid, datadir)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error // ESRCH: it exited after the last check
      }
      for (let i = 0; i < 50 && ownsDatadir(pid, datadir); i++) sleep(100)
      if (ownsDatadir(pid, datadir)) throw new Error(`qbitd ${pid} survived SIGKILL; ${datadir} is left in place`)
    }
  }
  rmSync(datadir, { recursive: true, force: true })
}

/**
 * The host-specific strings `text` holds: the data directory, the home
 * directory, a home or temporary path prefix, or the host name. The host name
 * counts only as a whole token, not inside a longer run of letters and digits,
 * and only from 4 characters: a fixture is full of hex and base64, which a
 * short or hex-like host name would match by chance.
 */
export function hostDetailsIn(text, { datadir, home, host }) {
  const found = [datadir, home, '/home/', '/tmp/', '/Users/'].filter(word => word.length > 1 && text.includes(word))
  if (host.length >= 4) {
    if (new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(host)}(?![A-Za-z0-9])`, 'i').test(text)) found.push(host)
  }
  return found
}
