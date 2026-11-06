// Tests for release-checks.mjs, set-version.mjs and check-changelog.mjs. Run
// by `pnpm test:scripts`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { missingChangelogEntry, readChange } from './check-changelog.mjs'
import {
  changelogProblems,
  devManifestProblems,
  lockstepProblems,
  parseReleaseRef,
  parseVersion,
  PUBLISH_CONFIG,
  publishConfigProblems,
  releaseManifestProblems,
  releaseProblems,
} from './release-checks.mjs'
import { withVersion } from './set-version.mjs'

const manifest = (overrides = {}) => ({
  name: '@qbit-oss/rpc',
  version: '0.1.0-rc.0',
  description: 'x',
  files: ['lib/**/*', 'README.md'],
  engines: { node: '^22.13.0 || ^24.0.0 || >=26.0.0' },
  publishConfig: { ...PUBLISH_CONFIG },
  license: 'MIT',
  ...overrides,
})

const CHANGELOG = `# Changelog

## 0.1.0 (unreleased)

### Added

- Everything.
`

const inputs = (version, changelog = CHANGELOG, extra = {}) => ({
  manifests: {
    rpc: { manifest: manifest({ version, ...extra }), hasLicenseFile: true },
    zmq: { manifest: manifest({ name: '@qbit-oss/zmq', version, ...extra }), hasLicenseFile: true },
  },
  changelog,
})

describe('parseVersion', () => {
  it('reads a final release and a candidate, with their dist-tag and line', () => {
    assert.deepEqual(parseVersion('0.1.0'), {
      version: '0.1.0',
      final: true,
      distTag: 'latest',
      line: '0.1',
      release: '0.1.0',
    })
    assert.deepEqual(parseVersion('1.12.3-rc.10'), {
      version: '1.12.3-rc.10',
      final: false,
      distTag: 'candidate',
      line: '1.12',
      release: '1.12.3',
    })
  })

  it('refuses 0.0.0 and anything but X.Y.Z and X.Y.Z-rc.N', () => {
    for (const version of [
      '0.0.0',
      '0.1',
      '01.0.0',
      '0.1.0-rc',
      '0.1.0-rc.01',
      '0.1.0-beta.0',
      '0.1.0+build',
      'v0.1.0',
      ' 0.1.0',
      '',
      undefined,
      1,
    ]) {
      assert.equal(parseVersion(version), undefined, String(version))
    }
  })
})

describe('parseReleaseRef', () => {
  it('reads a tag as its exact version, and a release branch as its line', () => {
    assert.equal(parseReleaseRef('v0.1.0-rc.0').kind, 'tag')
    assert.equal(parseReleaseRef('v0.1.0-rc.0').version, '0.1.0-rc.0')
    assert.deepEqual(parseReleaseRef('release/0.1'), { kind: 'branch', ref: 'release/0.1', line: '0.1' })
  })

  it('refuses any other ref', () => {
    for (const ref of [
      '0.1.0',
      'v0.0.0',
      'v0.1',
      'main',
      'release/0.1.0',
      'release/0',
      'release/x.y',
      'refs/tags/v0.1.0',
      '',
    ]) {
      assert.equal(parseReleaseRef(ref), undefined, ref)
    }
  })
})

describe('devManifestProblems', () => {
  it('passes only "private": true at 0.0.0', () => {
    assert.deepEqual(devManifestProblems({ version: '0.0.0', private: true }), [])
    for (const m of [
      { version: '0.1.0', private: true },
      { version: '0.0.0' },
      { version: '0.0.0', private: 'true' },
    ]) {
      assert.equal(devManifestProblems(m).length, 1, JSON.stringify(m))
    }
  })
})

describe('publishConfigProblems', () => {
  it('passes exactly public access with provenance', () => {
    assert.deepEqual(publishConfigProblems(manifest()), [])
    for (const publishConfig of [
      undefined,
      null,
      [],
      { access: 'public' },
      { access: 'restricted', provenance: true },
      { access: 'public', provenance: 'true' },
      { access: 'public', provenance: true, tag: 'latest' },
      Object.create({ access: 'public', provenance: true }),
    ]) {
      assert.equal(publishConfigProblems(manifest({ publishConfig })).length, 1, JSON.stringify(publishConfig))
    }
  })
})

describe('releaseManifestProblems', () => {
  const tag = parseReleaseRef('v0.1.0-rc.0')
  const branch = parseReleaseRef('release/0.1')

  it('passes a manifest ready to publish for the tag or on the branch line', () => {
    assert.deepEqual(releaseManifestProblems(manifest(), tag, true), [])
    assert.deepEqual(releaseManifestProblems(manifest({ version: '0.1.4' }), branch, true), [])
  })

  it('fails a version that is not the tag, or not on the branch line', () => {
    assert.match(releaseManifestProblems(manifest({ version: '0.1.0-rc.1' }), tag, true)[0], /not the tag's/)
    assert.match(releaseManifestProblems(manifest({ version: '0.1.0' }), tag, true)[0], /not the tag's/)
    assert.match(releaseManifestProblems(manifest({ version: '0.2.0' }), branch, true)[0], /line 0\.1/)
    assert.match(releaseManifestProblems(manifest({ version: '0.0.0' }), branch, true)[0], /line 0\.1/)
  })

  it('fails "private" in any form, and a missing files, license, LICENSE or engines', () => {
    for (const value of [true, false]) {
      assert.match(releaseManifestProblems(manifest({ private: value }), tag, true)[0], /"private"/)
    }
    assert.match(releaseManifestProblems(manifest({ files: undefined }), tag, true)[0], /"files"/)
    assert.match(releaseManifestProblems(manifest({ files: [] }), tag, true)[0], /"files"/)
    assert.match(releaseManifestProblems(manifest({ license: undefined }), tag, true)[0], /"license"/)
    assert.match(releaseManifestProblems(manifest(), tag, false)[0], /LICENSE/)
    assert.match(releaseManifestProblems(manifest({ engines: {} }), tag, true)[0], /"engines"/)
    assert.match(releaseManifestProblems(manifest({ engines: undefined }), tag, true)[0], /"engines"/)
  })
})

describe('lockstepProblems', () => {
  it('passes one shared version and fails two', () => {
    assert.deepEqual(lockstepProblems({ rpc: '0.1.0', zmq: '0.1.0' }), [])
    assert.match(lockstepProblems({ rpc: '0.1.0', zmq: '0.1.1' })[0], /rpc 0\.1\.0, zmq 0\.1\.1/)
  })
})

describe('changelogProblems', () => {
  it('passes a candidate against its release section, in any state', () => {
    assert.deepEqual(changelogProblems(CHANGELOG, parseVersion('0.1.0-rc.0')), [])
    assert.deepEqual(changelogProblems('## 0.1.0\n\n- x\n', parseVersion('0.1.0-rc.3')), [])
  })

  it('needs a dated heading for a final release', () => {
    assert.match(changelogProblems(CHANGELOG, parseVersion('0.1.0'))[0], /'## 0\.1\.0 - YYYY-MM-DD'/)
    assert.deepEqual(changelogProblems('## 0.1.0 - 2026-11-20\n\n- x\n', parseVersion('0.1.0')), [])
    for (const heading of [
      '## 0.1.0 - 2026-02-30',
      '## 0.1.0 - 2026-13-01',
      '## 0.1.0 - 20261120',
      '## 0.1.0 - 2026-11-20 x',
    ]) {
      assert.equal(changelogProblems(`${heading}\n\n- x\n`, parseVersion('0.1.0')).length, 1, heading)
    }
  })

  it('fails a missing, repeated or empty section, and does not take another version for it', () => {
    assert.match(changelogProblems('## 0.1.1\n\n- x\n', parseVersion('0.1.0'))[0], /exactly one/)
    assert.match(changelogProblems('## 0.1.0-rc.0\n\n- x\n', parseVersion('0.1.0-rc.0'))[0], /exactly one/)
    assert.match(changelogProblems('## 0.1.00\n\n- x\n', parseVersion('0.1.0-rc.0'))[0], /exactly one/)
    assert.match(changelogProblems('### 0.1.0\n\n- x\n', parseVersion('0.1.0-rc.0'))[0], /exactly one/)
    assert.match(
      changelogProblems('## 0.1.0\n- x\n## 0.1.0 (again)\n- y\n', parseVersion('0.1.0-rc.0'))[0],
      /exactly one/
    )
    assert.match(
      changelogProblems('## 0.1.0 (unreleased)\n\n\n## 0.0.9\n\n- x\n', parseVersion('0.1.0-rc.0'))[0],
      /empty/
    )
  })

  it('takes an empty section where content is not required, as on a release branch', () => {
    const empty = '## 0.1.1 (unreleased)\n\n## 0.1.0 - 2026-11-20\n\n- x\n'
    assert.deepEqual(changelogProblems(empty, parseVersion('0.1.1-rc.0'), { requireContent: false }), [])
    assert.match(changelogProblems(empty, parseVersion('0.1.1-rc.0'))[0], /empty/)
  })
})

describe('releaseProblems', () => {
  it('passes a rehearsal version against its tag and its branch', () => {
    for (const ref of ['v0.1.0-rc.0', 'release/0.1']) {
      const { version, problems } = releaseProblems(inputs('0.1.0-rc.0'), ref)
      assert.deepEqual(problems, [], ref)
      assert.equal(version.distTag, 'candidate')
    }
  })

  it('fails a wrong tag, a wrong line, a malformed ref, and the private/0.0.0 state', () => {
    assert.match(releaseProblems(inputs('0.1.0-rc.0'), 'v0.1.0-rc.1').problems.join('\n'), /not the tag's/)
    assert.match(releaseProblems(inputs('0.1.0-rc.0'), 'release/0.2').problems.join('\n'), /line 0\.2/)
    assert.match(releaseProblems(inputs('0.1.0-rc.0'), 'main').problems[0], /no release tag/)
    const dev = releaseProblems(inputs('0.0.0', CHANGELOG, { private: true }), 'v0.1.0-rc.0').problems.join('\n')
    assert.match(dev, /not the tag's/)
    assert.match(dev, /"private"/)
  })

  it('fails versions out of lockstep, and a release without its changelog section', () => {
    const split = inputs('0.1.0-rc.0')
    split.manifests.zmq.manifest.version = '0.1.0-rc.1'
    assert.match(releaseProblems(split, 'release/0.1').problems.join('\n'), /lockstep/)
    assert.match(releaseProblems(inputs('0.1.0-rc.0', '# Changelog\n'), 'v0.1.0-rc.0').problems[0], /'## 0\.1\.0'/)
  })

  it('takes an empty section on a release branch, but not for a tag', () => {
    const empty = '## 0.1.1 (unreleased)\n\n## 0.1.0 - 2026-11-20\n\n- x\n'
    assert.deepEqual(releaseProblems(inputs('0.1.1-rc.0', empty), 'release/0.1').problems, [])
    assert.match(releaseProblems(inputs('0.1.1-rc.0', empty), 'v0.1.1-rc.0').problems[0], /empty/)
  })

  it('fails a manifest without publishConfig', () => {
    const { problems } = releaseProblems(inputs('0.1.0-rc.0', CHANGELOG, { publishConfig: undefined }), 'v0.1.0-rc.0')
    assert.equal(problems.length, 2)
    assert.match(problems[0], /^packages\/rpc: .*publishConfig/)
  })
})

describe('withVersion', () => {
  const dev = { name: 'a', version: '0.0.0', private: true, description: 'x' }

  it('sets a release version and drops "private", keeping the key order', () => {
    const out = withVersion(dev, '0.1.0-rc.0')
    assert.deepEqual(Object.keys(out), ['name', 'version', 'description'])
    assert.equal(out.version, '0.1.0-rc.0')
  })

  it('puts "private": true back, after version, for 0.0.0', () => {
    const out = withVersion({ name: 'a', version: '0.1.0', description: 'x' }, '0.0.0')
    assert.deepEqual(Object.entries(out), Object.entries(dev))
  })

  it('refuses any other version, and a manifest without one', () => {
    for (const version of ['0.1', 'v0.1.0', '0.1.0-beta.1', '']) {
      assert.throws(() => withVersion(dev, version), TypeError, version)
    }
    assert.throws(() => withVersion({ name: 'a' }, '0.1.0'), TypeError)
  })
})

describe('missingChangelogEntry', () => {
  it('needs a changelog line for a source change only', () => {
    assert.equal(
      missingChangelogEntry({ files: ['README.md', 'packages/rpc/test/a.test.ts'], changelogAdded: 0 }),
      undefined
    )
    assert.equal(missingChangelogEntry({ files: ['packages/rpc/src/a.ts'], changelogAdded: 1 }), undefined)
    assert.match(
      missingChangelogEntry({ files: ['packages/zmq/src/a.ts'], changelogAdded: 0 }),
      /packages\/zmq\/src\/a\.ts/
    )
    assert.equal(missingChangelogEntry({ files: ['packages/rpc/srcs/a.ts', 'src/a.ts'], changelogAdded: 0 }), undefined)
  })

  it('names at most five files', () => {
    const files = Array.from({ length: 7 }, (_, i) => `packages/rpc/src/${i}.ts`)
    assert.match(missingChangelogEntry({ files, changelogAdded: 0 }), /4\.ts, and 2 more/)
  })
})

describe('readChange', () => {
  it('reads both sides of a rename, and only lines added to CHANGELOG.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qbit-rpc-changelog-'))
    try {
      const git = (...args) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgSign=false', ...args],
          {
            cwd: dir,
            encoding: 'utf8',
          }
        ).trim()
      git('init', '-q')
      mkdirSync(join(dir, 'packages/rpc/src'), { recursive: true })
      writeFileSync(join(dir, 'packages/rpc/src/a.ts'), 'export const a = 1\n')
      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n- one\n')
      git('add', '.')
      git('commit', '-q', '-m', 'base')
      git('mv', 'packages/rpc/src/a.ts', 'packages/rpc/b.ts')
      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n')
      git('commit', '-q', '-am', 'rename, and remove a changelog line')
      const change = readChange('HEAD~1', 'HEAD', dir)
      assert.deepEqual(change.files.sort(), ['CHANGELOG.md', 'packages/rpc/b.ts', 'packages/rpc/src/a.ts'])
      assert.equal(change.changelogAdded, 0)
      assert.match(missingChangelogEntry(change), /packages\/rpc\/src\/a\.ts/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
