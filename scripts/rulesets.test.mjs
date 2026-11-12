import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ORDER, diffRuleset, fillTeam, loadRulesets, planRulesets } from './rulesets.mjs'

const dir = fileURLToPath(new URL('../.github/rulesets/', import.meta.url))
const TEAM = 4242

// The repository's two rulesets as GitHub returned them on 2026-11-09, before step 4.
const BEFORE = [
  {
    id: 26646830,
    name: 'main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          allowed_merge_methods: ['squash', 'rebase', 'merge'],
          dismiss_stale_reviews_on_push: false,
          dismissal_restriction: { allowed_actors: [], enabled: false },
          require_code_owner_review: false,
          require_extra_approval_for_unattributed_changes: true,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
          required_reviewers: [],
        },
      },
    ],
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
  },
  {
    id: 26646873,
    name: 'v*',
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { exclude: [], include: ['refs/tags/v*'] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'creation' }, { type: 'update' }],
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
  },
]

const desired = () => loadRulesets(dir).map(r => fillTeam(r, TEAM))

/** `rulesets` as GitHub would return them once applied: with ids, extra defaults and its own array order. */
const applied = rulesets =>
  rulesets.map((r, i) => ({
    ...structuredClone(r),
    id: 100 + i,
    source_type: 'Repository',
    rules: structuredClone(r.rules)
      .reverse()
      .map(rule =>
        rule.type === 'pull_request' ? { ...rule, parameters: { ...rule.parameters, required_reviewers: [] } } : rule
      ),
  }))

test('the files are the eight rulesets, in apply order, each restricting the release refs', () => {
  const rulesets = loadRulesets(dir)
  assert.deepEqual(
    rulesets.map(r => r.name),
    ORDER
  )
  for (const r of rulesets) {
    assert.equal(r.enforcement, 'active', r.name)
    assert.ok(
      r.bypass_actors.every(a => a.actor_type === 'Team' && a.actor_id === null),
      `${r.name}: only the release approvers team may bypass`
    )
  }
  const byName = Object.fromEntries(rulesets.map(r => [r.name, r]))
  for (const name of ['main', 'release-branches']) {
    const pr = byName[name].rules.find(r => r.type === 'pull_request').parameters
    assert.deepEqual(pr.allowed_merge_methods, ['merge'], name)
    assert.equal(pr.require_code_owner_review, true, name)
    assert.deepEqual(byName[name].bypass_actors[0].bypass_mode, 'pull_request', name)
    assert.ok(
      !byName[name].rules.some(r => r.type === 'required_status_checks'),
      `${name}: its bypass must not cover a check`
    )
  }
  for (const [name, include] of [
    ['required-checks', ['~DEFAULT_BRANCH']],
    ['required-checks-release', ['refs/heads/release/*']],
  ]) {
    assert.deepEqual(byName[name].bypass_actors, [], `${name}: no one may bypass a required check`)
    assert.deepEqual(byName[name].conditions.ref_name.include, include, name)
    assert.deepEqual(
      byName[name].rules.map(r => r.type),
      ['required_status_checks'],
      name
    )
    assert.deepEqual(
      byName[name].rules[0].parameters.required_status_checks.map(c => c.context),
      ['verify', 'regtest smoke', 'changelog', 'signed-landing'],
      name
    )
    assert.equal(byName[name].rules[0].parameters.strict_required_status_checks_policy, true, name)
    // Cutting a release branch pushes a commit that was never a pull request's head.
    assert.equal(byName[name].rules[0].parameters.do_not_enforce_on_create, name === 'required-checks-release', name)
    assert.ok(
      byName[name].rules[0].parameters.required_status_checks.every(c => c.integration_id === 15368),
      `${name}: every check must come from GitHub Actions`
    )
  }
  assert.deepEqual(byName['release-tags-fixed'].bypass_actors, [])
  assert.deepEqual(byName['signed-commits'].bypass_actors, [], 'no one may bypass the signature rule')
  assert.deepEqual(byName['signed-commits'].rules, [{ type: 'required_signatures' }])
  assert.deepEqual(byName['signed-commits'].conditions.ref_name.include, ['~DEFAULT_BRANCH', 'refs/heads/release/*'])
  assert.ok(!byName['release-tags-fixed'].rules.some(r => r.type === 'creation'))
})

test('fillTeam sets only the null team ids, and refuses a missing id', () => {
  const filled = fillTeam(loadRulesets(dir)[0], TEAM)
  assert.deepEqual(filled.bypass_actors, [{ actor_type: 'Team', actor_id: TEAM, bypass_mode: 'always' }])
  assert.throws(() => fillTeam(loadRulesets(dir)[0], undefined), /not a team id/)
})

test('against the rulesets before step 4, it creates six, updates main and renames v*', () => {
  const { actions, unmanaged } = planRulesets(desired(), BEFORE)
  assert.deepEqual(
    actions.map(a => [a.action, a.name, a.id, a.was]),
    [
      ['create', 'release-tag-creation', undefined, undefined],
      ['create', 'release-branch-creation', undefined, undefined],
      ['create', 'signed-commits', undefined, undefined],
      ['create', 'required-checks', undefined, undefined],
      ['create', 'required-checks-release', undefined, undefined],
      ['create', 'release-branches', undefined, undefined],
      ['update', 'main', 26646830, undefined],
      ['update', 'release-tags-fixed', 26646873, 'v*'],
    ]
  )
  assert.deepEqual(unmanaged, [])
  const main = actions.find(a => a.name === 'main').diff.join('\n')
  assert.match(main, /bypass_actors/)
  assert.match(main, /required_approving_review_count: 0 -> 1/)
})

test('once applied, every ruleset is unchanged, whatever order and defaults GitHub returns', () => {
  const want = desired()
  const { actions } = planRulesets(want, applied(want))
  assert.deepEqual(
    actions.map(a => [a.action, a.diff]),
    want.map(() => ['unchanged', []])
  )
})

test('a rule, check or bypass actor added on GitHub is reported', () => {
  const want = desired()
  const live = applied(want)
  const main = live.find(r => r.name === 'main')
  main.bypass_actors.push({ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' })
  const checks = live
    .find(r => r.name === 'required-checks-release')
    .rules.find(r => r.type === 'required_status_checks')
  checks.parameters.required_status_checks.pop()
  live.find(r => r.name === 'release-tags-fixed').rules.push({ type: 'creation' })
  const { actions } = planRulesets(want, live)
  assert.deepEqual(
    actions.filter(a => a.action === 'update').map(a => a.name),
    ['required-checks-release', 'main', 'release-tags-fixed']
  )
  assert.equal(
    diffRuleset(
      want.find(r => r.name === 'main'),
      main
    ).length,
    1
  )
})

test('a ruleset that no file manages is listed and left alone', () => {
  const want = desired()
  const live = [...applied(want), { id: 9, name: 'other', target: 'branch' }]
  assert.deepEqual(planRulesets(want, live).unmanaged, [{ id: 9, name: 'other' }])
})
