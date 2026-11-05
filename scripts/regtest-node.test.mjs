// Tests for regtest-node.mjs, with a stand-in process in place of qbitd: a
// node.js process that idles with a -datadir= argument, as qbitd runs. Run by
// `pnpm test:scripts`.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { hostDetailsIn, ownsDatadir, stopNode } from './regtest-node.mjs'

const made = []
const standIns = []
// Whatever a failing case left: its stand-ins, each only while its pid still
// runs with its -datadir, and its directories.
after(() => {
  for (const { pid, datadir } of standIns) {
    if (ownsDatadir(pid, datadir)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Gone since.
      }
    }
  }
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** A data directory with a stand-in qbitd that ignores SIGTERM, as a hung one would, and its pid file. */
function standIn() {
  const datadir = mkdtempSync(join(tmpdir(), 'qbit-rpc-regtest-node-test-'))
  made.push(datadir)
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", '--', `-datadir=${datadir}`],
    { stdio: 'ignore', detached: true }
  )
  child.unref()
  standIns.push({ pid: child.pid, datadir })
  const pidFile = join(datadir, 'qbitd.pid')
  writeFileSync(pidFile, `${child.pid}\n`)
  return { datadir, pidFile, pid: child.pid }
}

/** Whether `pid` still runs, not counting a zombie this process has not reaped yet. */
const alive = pid => {
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).startsWith('Z')
  } catch {
    return false
  }
}

describe('stopNode', () => {
  it('kills a qbitd that does not stop within the wait, then removes its data directory', () => {
    const { datadir, pidFile, pid } = standIn()
    let asked = 0
    const started = Date.now()
    stopNode({ datadir, pidFile, stop: () => asked++, waitMs: 500 })
    assert.equal(asked, 1)
    assert.ok(Date.now() - started >= 500, 'it waited before killing')
    assert.equal(alive(pid), false)
    assert.equal(existsSync(datadir), false)
  })

  it('kills one whose stop throws, as when its RPC no longer answers', () => {
    const { datadir, pidFile, pid } = standIn()
    stopNode({
      datadir,
      pidFile,
      stop: () => {
        throw new Error('connection refused')
      },
      waitMs: 200,
    })
    assert.equal(alive(pid), false)
    assert.equal(existsSync(datadir), false)
  })

  it('does not wait for a stale pid file, nor touch the process that now has the pid', () => {
    const datadir = mkdtempSync(join(tmpdir(), 'qbit-rpc-regtest-node-test-'))
    made.push(datadir)
    const pidFile = join(datadir, 'qbitd.pid')
    // This test's own process: alive, but not a qbitd of datadir.
    writeFileSync(pidFile, `${process.pid}\n`)
    const started = Date.now()
    stopNode({ datadir, pidFile, stop: () => {}, waitMs: 60_000 })
    assert.ok(Date.now() - started < 5_000, `it waited ${Date.now() - started} ms`)
    assert.equal(existsSync(datadir), false)
  })

  it('does not wait for, nor kill, a process whose data directory only starts with this one', () => {
    const datadir = mkdtempSync(join(tmpdir(), 'qbit-rpc-regtest-node-test-'))
    made.push(datadir)
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", '--', `-datadir=${datadir}-other`],
      { stdio: 'ignore', detached: true }
    )
    child.unref()
    standIns.push({ pid: child.pid, datadir: `${datadir}-other` })
    const pidFile = join(datadir, 'qbitd.pid')
    writeFileSync(pidFile, `${child.pid}\n`)
    const started = Date.now()
    stopNode({ datadir, pidFile, stop: () => {}, waitMs: 60_000 })
    assert.ok(Date.now() - started < 5_000, `it waited ${Date.now() - started} ms`)
    assert.equal(alive(child.pid), true)
    assert.equal(existsSync(datadir), false)
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {
      // Gone already: after() looks again.
    }
  })

  it('removes the data directory of a node that never started', () => {
    const datadir = mkdtempSync(join(tmpdir(), 'qbit-rpc-regtest-node-test-'))
    made.push(datadir)
    stopNode({ datadir, pidFile: join(datadir, 'regtest/qbitd.pid'), stop: () => {}, waitMs: 60_000 })
    assert.equal(existsSync(datadir), false)
  })
})

describe('hostDetailsIn', () => {
  const where = { datadir: '/srv/qbit-rpc-fixtures-x1', home: '/srv/me', host: 'beef' }

  it('finds the host name as a whole token, in any case', () => {
    for (const text of ['"beef"', 'node beef.', 'BEEF:8332', '{"host":"Beef-2"}']) {
      assert.deepEqual(hostDetailsIn(text, where), ['beef'], text)
    }
  })

  it('does not find it inside a longer run of letters and digits, as in hex or base64', () => {
    for (const text of ['"deadbeef00"', 'beefcafe', 'AbeefZ', '"txid": "00beef"']) {
      assert.deepEqual(hostDetailsIn(text, where), [], text)
    }
  })

  it('ignores a host name shorter than 4 characters', () => {
    assert.deepEqual(hostDetailsIn('"a1" and a1', { ...where, host: 'a1' }), [])
    assert.deepEqual(hostDetailsIn('the box', { ...where, host: 'box' }), [])
  })

  it('treats a host name as text, not a pattern', () => {
    assert.deepEqual(hostDetailsIn('xqbitylocal', { ...where, host: 'qbit.local' }), [])
    assert.deepEqual(hostDetailsIn('at qbit.local now', { ...where, host: 'qbit.local' }), ['qbit.local'])
  })

  it('still finds the data directory, the home directory and home or temporary paths anywhere', () => {
    assert.deepEqual(hostDetailsIn('x/srv/qbit-rpc-fixtures-x1/regtest', where), ['/srv/qbit-rpc-fixtures-x1'])
    assert.deepEqual(hostDetailsIn('"/srv/me/.qbit"', where), ['/srv/me'])
    assert.deepEqual(hostDetailsIn('/home/a /tmp/b /Users/c', where), ['/home/', '/tmp/', '/Users/'])
  })
})
