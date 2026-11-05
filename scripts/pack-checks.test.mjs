// Tests for pack-checks.mjs. Run by `pnpm test:scripts`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mapProblems, peerProblems, sizeProblem } from './pack-checks.mjs'

describe('sizeProblem', () => {
  it('passes a size under its ceiling, and fails one over it', () => {
    assert.equal(sizeProblem(100, 200), undefined)
    assert.match(sizeProblem(201, 200), /over the ceiling of 200/)
  })

  it('fails without a ceiling or a size, rather than passing', () => {
    for (const [size, ceiling] of [
      [100, undefined],
      [undefined, 200],
      [100, Number.NaN],
      ['100', 200],
      [100, '200'],
    ]) {
      assert.notEqual(sizeProblem(size, ceiling), undefined, `${size} against ${ceiling}`)
    }
  })
})

describe('mapProblems', () => {
  const text = { '../src/index.ts': 'index', '../src/a.ts': 'a', '../src/v1..2.ts': 'v' }
  const read = source => text[source]
  const map = sources => ({ sources, sourcesContent: sources.map(read) })

  it('passes a map of every expected file, a name holding .. included', () => {
    const all = ['../src/index.ts', '../src/a.ts', '../src/v1..2.ts']
    assert.deepEqual(mapProblems('m', map(all), all, read), [])
  })

  it('fails a map with no sources, empty or missing', () => {
    assert.deepEqual(mapProblems('m', map([]), ['../src/a.ts'], read), ['m has no sources'])
    assert.deepEqual(mapProblems('m', {}, ['../src/a.ts'], read), ['m has no sources'])
  })

  it('fails a map that leaves out a file of the build', () => {
    assert.deepEqual(mapProblems('m', map(['../src/index.ts']), ['../src/index.ts', '../src/a.ts'], read), [
      'm does not map ../src/a.ts',
    ])
  })

  it('fails a source outside src/, through a .. or . segment, or not TypeScript', () => {
    for (const source of [
      '../src/../a.ts',
      '../src/x/../../a.ts',
      '../src/./a.ts',
      '/abs/src/a.ts',
      '../node_modules/z/i.ts',
      '../src/a.js',
    ]) {
      assert.deepEqual(mapProblems('m', map([source]), [], read), [`m maps to ${source}, outside src/`], source)
    }
  })

  it('fails a source that is not in src/, rather than throwing', () => {
    const missing = source => {
      if (source in text) return text[source]
      throw Object.assign(new Error(`ENOENT: ${source}`), { code: 'ENOENT' })
    }
    assert.deepEqual(mapProblems('m', { sources: ['../src/gone.ts'], sourcesContent: ['x'] }, [], missing), [
      'm maps to ../src/gone.ts, which is not in src/',
    ])
  })

  it('fails a source whose content differs from the file', () => {
    assert.deepEqual(mapProblems('m', { sources: ['../src/a.ts'], sourcesContent: ['old'] }, [], read), [
      'm does not carry ../src/a.ts as it is in sourcesContent',
    ])
  })
})

describe('peerProblems', () => {
  const manifest = (peer, pin) => ({
    peerDependencies: { zeromq: peer },
    peerDependenciesMeta: { zeromq: { optional: true } },
    devDependencies: { zeromq: pin },
  })

  it('passes an optional caret peer whose floor is the dev pin', () => {
    assert.deepEqual(peerProblems(manifest('^6.5.0', '6.5.0')), [])
  })

  it('says to move the floor by hand when Dependabot moved only the pin', () => {
    const [problem] = peerProblems(manifest('^6.5.0', '6.6.0'))
    assert.match(problem, /must pin the peer range's floor, 6\.5\.0, not 6\.6\.0/)
    assert.match(problem, /Dependabot updates only the pin, so move the peer floor by hand in the same pull request/)
  })

  it('fails a peer that is not optional or not a caret range', () => {
    assert.equal(peerProblems({ ...manifest('^6.5.0', '6.5.0'), peerDependenciesMeta: {} }).length, 1)
    assert.deepEqual(peerProblems(manifest('>=6.5.0', '6.5.0')), [
      'peer dependency zeromq must be a caret range (^x.y.z), not >=6.5.0',
    ])
  })
})
