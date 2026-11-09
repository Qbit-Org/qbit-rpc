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

test('the files are the five rulesets, in apply order, each restricting the release refs', () => {
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
    assert.deepEqual(pr.allowed_merge_methods, ['merge', 'squash'], name)
    assert.equal(pr.require_code_owner_review, true, name)
    assert.deepEqual(byName[name].bypass_actors[0].bypass_mode, 'pull_request', name)
  }
  assert.deepEqual(byName['release-tags-fixed'].bypass_actors, [])
  assert.ok(!byName['release-tags-fixed'].rules.some(r => r.type === 'creation'))
})

test('fillTeam sets only the null team ids, and refuses a missing id', () => {
  const filled = fillTeam(loadRulesets(dir)[0], TEAM)
  assert.deepEqual(filled.bypass_actors, [{ actor_type: 'Team', actor_id: TEAM, bypass_mode: 'always' }])
  assert.throws(() => fillTeam(loadRulesets(dir)[0], undefined), /not a team id/)
})

test('against the rulesets before step 4, it creates three, updates main and renames v*', () => {
  const { actions, unmanaged } = planRulesets(desired(), BEFORE)
  assert.deepEqual(
    actions.map(a => [a.action, a.name, a.id, a.was]),
    [
      ['create', 'release-tag-creation', undefined, undefined],
      ['create', 'release-branch-creation', undefined, undefined],
      ['create', 'release-branches', undefined, undefined],
      ['update', 'main', 26646830, undefined],
      ['update', 'release-tags-fixed', 26646873, 'v*'],
    ]
  )
  assert.deepEqual(unmanaged, [])
  const main = actions.find(a => a.name === 'main').diff.join('\n')
  assert.match(main, /bypass_actors/)
  assert.match(main, /rules: /)
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
  const checks = live.find(r => r.name === 'release-branches').rules.find(r => r.type === 'required_status_checks')
  checks.parameters.required_status_checks.pop()
  live.find(r => r.name === 'release-tags-fixed').rules.push({ type: 'creation' })
  const { actions } = planRulesets(want, live)
  assert.deepEqual(
    actions.filter(a => a.action === 'update').map(a => a.name),
    ['release-branches', 'main', 'release-tags-fixed']
  )
  assert.equal(diffRuleset(want[3], main).length, 1)
})

test('a ruleset that no file manages is listed and left alone', () => {
  const want = desired()
  const live = [...applied(want), { id: 9, name: 'other', target: 'branch' }]
  assert.deepEqual(planRulesets(want, live).unmanaged, [{ id: 9, name: 'other' }])
})
