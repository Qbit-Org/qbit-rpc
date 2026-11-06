// Tests for pack-checks.mjs. Run by `pnpm test:scripts`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  authorProblem,
  CHANGELOG_URL,
  linksLeavingPackage,
  mapProblems,
  peerProblems,
  readmeProblems,
  sizeProblem,
} from './pack-checks.mjs'

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

describe('readmeProblems', () => {
  const changelog = `See the [changelog](${CHANGELOG_URL}).`

  it('passes absolute links, anchors and links inside the package, with the changelog linked', () => {
    const readme = [
      changelog,
      '[site](https://example.com/x) [mail](mailto:a@example.com) [up](#install) [lib](lib/index.d.ts)',
      '[ref]: https://example.com/ref',
      '<img src="https://img.shields.io/badge/x"> <a href="//example.com/">x</a>',
    ].join('\n')
    assert.deepEqual(readmeProblems(readme), [])
  })

  it('finds a relative link that leaves the package, inline, by reference or in HTML', () => {
    for (const link of [
      '[root](../../README.md)',
      '[root](<../../README.md>)',
      '[a](../x#y)',
      '[abs](/README.md)',
      '[ref]: ../../LICENSE',
      '<a href="../../SECURITY.md">x</a>',
      "<img src='../logo.png'>",
      '<a href=../../SECURITY.md>x</a>',
      '<img src=../logo.png>',
      '[enc](%2e%2e/%2e%2e/LICENSE)',
    ]) {
      assert.equal(linksLeavingPackage(link).length, 1, link)
      assert.match(readmeProblems(`${changelog}\n${link}`)[0] ?? '', /links outside the package/, link)
    }
  })

  it('does not read code as links: fenced blocks and inline code', () => {
    const readme = [changelog, '```ts', 'handlers[k](../x)', '```', 'Call `fn[0](../y)` once.'].join('\n')
    assert.deepEqual(readmeProblems(readme), [])
  })

  it('fails a README that does not link the changelog by its absolute URL', () => {
    assert.deepEqual(readmeProblems('No changelog here. [c](../../CHANGELOG.md)').length, 2)
    assert.deepEqual(readmeProblems('No changelog here.'), [`README.md does not link ${CHANGELOG_URL}`])
  })
})

describe('authorProblem', () => {
  it('passes a name with an https URL', () => {
    assert.equal(authorProblem({ name: 'Qbit', url: 'https://github.com/Qbit-Org' }), undefined)
  })

  it('fails a string, a missing name or URL, or a URL that is not https', () => {
    for (const author of [
      'Qbit <https://github.com/Qbit-Org>',
      undefined,
      { name: 'Qbit' },
      { url: 'https://github.com/Qbit-Org' },
      { name: 'Qbit', url: 'http://github.com/Qbit-Org' },
      { name: '', url: 'https://github.com/Qbit-Org' },
      { name: 'Qbit', url: 'https://' },
    ]) {
      assert.notEqual(authorProblem(author), undefined, JSON.stringify(author))
    }
  })
})
