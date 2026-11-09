#!/usr/bin/env node
// Compare the repository's rulesets with .github/rulesets/*.json, or apply them.
//
// Usage: node scripts/rulesets.mjs [plan | check | apply] [--team <slug> | --team-id <id>] [--repo <owner/name>]
//   plan   (default) prints what apply would create or update, and changes nothing.
//   check  exits 1 unless every ruleset on GitHub matches its file.
//   apply  creates or updates the rulesets, in the order below, then checks them.
//
// Run it with `gh` logged in as a repository admin who can read the team. The
// files leave the release approvers team's `actor_id` as null; it is looked up
// from --team (default release-maintainers) when the script runs, since it
// differs between organisations and is not readable by every token; --team-id
// gives it directly, for a token that cannot read the team.
// RELEASING.md, step 4 of the one-time setup, says what each ruleset is for.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The managed rulesets, in the order apply writes them. Creation rules come
 * first, so that `release-tags-fixed`, which drops the creation rule the
 * existing `v*` ruleset holds, never leaves tag creation open in between.
 * `signed-commits` comes next, so the signature rule is in force before the
 * branch rulesets allow merge commits only.
 */
export const ORDER = [
  'release-tag-creation',
  'release-branch-creation',
  'signed-commits',
  'release-branches',
  'main',
  'release-tags-fixed',
]

/** Rulesets renamed by a file: matched on GitHub by an earlier name when the new one is not there yet. */
export const PREVIOUS_NAMES = { 'release-tags-fixed': ['v*'] }

/** The fields of a ruleset that the files manage; GitHub's other fields (id, links, dates) are ignored. */
const FIELDS = ['name', 'target', 'enforcement', 'conditions', 'rules', 'bypass_actors']

/** Read every ruleset file in `dir`, and fail unless they are exactly the ones in ORDER. */
export function loadRulesets(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  const rulesets = files.map(f => {
    const ruleset = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    if (`${ruleset.name}.json` !== f) throw new Error(`${f}: its name is ${JSON.stringify(ruleset.name)}`)
    return ruleset
  })
  const names = rulesets.map(r => r.name).sort()
  if (JSON.stringify(names) !== JSON.stringify([...ORDER].sort())) {
    throw new Error(`${dir} holds ${names.join(', ')}; expected ${[...ORDER].sort().join(', ')}`)
  }
  return ORDER.map(name => rulesets.find(r => r.name === name))
}

/** A copy of `ruleset` with every Team bypass actor's null `actor_id` set to `teamId`. */
export function fillTeam(ruleset, teamId) {
  if (!Number.isSafeInteger(teamId) || teamId <= 0) throw new Error(`not a team id: ${teamId}`)
  return {
    ...ruleset,
    bypass_actors: ruleset.bypass_actors.map(a =>
      a.actor_type === 'Team' && a.actor_id === null ? { ...a, actor_id: teamId } : a
    ),
  }
}

/** Sort the arrays whose order GitHub does not keep, so two equal rulesets compare equal. */
function normalize(value, key) {
  if (Array.isArray(value)) {
    const items = value.map(v => normalize(v))
    const sortKey = {
      rules: r => r.type,
      required_status_checks: c => `${c.context}\0${c.integration_id ?? ''}`,
      bypass_actors: a => `${a.actor_type}\0${a.actor_id}`,
    }[key]
    return items.sort((a, b) => {
      const [x, y] = sortKey ? [sortKey(a), sortKey(b)] : [JSON.stringify(a), JSON.stringify(b)]
      return x < y ? -1 : x > y ? 1 : 0
    })
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]))
  }
  return value
}

/**
 * Where `live` differs from `desired`, as a list of paths. An object in `live`
 * may hold keys the file leaves out (GitHub adds defaults such as
 * `required_reviewers: []`), but every array must match in full, so a rule,
 * check or bypass actor that is on GitHub and not in the file is reported.
 */
export function diffRuleset(desired, live) {
  const out = []
  const walk = (want, have, path) => {
    if (Array.isArray(want)) {
      if (!Array.isArray(have) || have.length !== want.length) {
        out.push(`${path}: ${JSON.stringify(have)} -> ${JSON.stringify(want)}`)
        return
      }
      want.forEach((w, i) => walk(w, have[i], `${path}[${i}]`))
    } else if (want !== null && typeof want === 'object') {
      if (have === null || typeof have !== 'object' || Array.isArray(have)) {
        out.push(`${path}: ${JSON.stringify(have)} -> ${JSON.stringify(want)}`)
        return
      }
      for (const k of Object.keys(want)) walk(want[k], have[k], path ? `${path}.${k}` : k)
    } else if (want !== have) {
      out.push(`${path}: ${JSON.stringify(have)} -> ${JSON.stringify(want)}`)
    }
  }
  for (const f of FIELDS) walk(normalize(desired[f], f), normalize(live?.[f], f), f)
  return out
}

/**
 * For each desired ruleset, in order: `create`, `update` (with the live id and
 * the differences) or `unchanged`. `live` is GitHub's rulesets with full
 * details. Also returns the live rulesets that no file manages.
 */
export function planRulesets(desired, live) {
  const used = new Set()
  const actions = desired.map(want => {
    const names = [want.name, ...(PREVIOUS_NAMES[want.name] ?? [])]
    const have = names.map(n => live.find(r => r.name === n && r.target === want.target)).find(Boolean)
    if (!have) return { action: 'create', name: want.name, ruleset: want }
    used.add(have.id)
    const diff = diffRuleset(want, have)
    return {
      action: diff.length ? 'update' : 'unchanged',
      name: want.name,
      id: have.id,
      was: have.name === want.name ? undefined : have.name,
      diff,
      ruleset: want,
    }
  })
  const unmanaged = live.filter(r => !used.has(r.id)).map(r => ({ id: r.id, name: r.name }))
  return { actions, unmanaged }
}

function gh(args, input) {
  const out = execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  return JSON.parse(out)
}

function fetchLive(repo) {
  const list = gh(['--paginate', '--slurp', `repos/${repo}/rulesets?includes_parents=false`]).flat()
  return list.map(r => gh([`repos/${repo}/rulesets/${r.id}`]))
}

function printPlan({ actions, unmanaged }) {
  for (const a of actions) {
    const from = a.was === undefined ? '' : ` (renamed from ${JSON.stringify(a.was)})`
    console.log(`${a.action.padEnd(9)} ${a.name}${a.id === undefined ? '' : ` #${a.id}`}${from}`)
    for (const d of a.diff ?? []) console.log(`            ${d}`)
  }
  for (const u of unmanaged) console.log(`unmanaged ${u.name} #${u.id}: not in .github/rulesets, left as it is`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const option = (flag, fallback) => {
    const i = args.indexOf(flag)
    if (i === -1) return fallback
    const [value] = args.splice(i, 2).slice(1)
    if (value === undefined) throw new Error(`${flag} needs a value`)
    return value
  }
  const team = option('--team', 'release-maintainers')
  const givenId = option('--team-id', undefined)
  const repo = option('--repo', 'Qbit-Org/qbit-rpc')
  const [command = 'plan', ...rest] = args
  if (!['plan', 'check', 'apply'].includes(command) || rest.length) {
    console.error(
      'usage: node scripts/rulesets.mjs [plan | check | apply] [--team <slug> | --team-id <id>] [--repo <owner/name>]'
    )
    process.exit(2)
  }
  const org = repo.split('/')[0]
  const teamId = givenId === undefined ? gh([`orgs/${org}/teams/${team}`]).id : Number(givenId)
  console.log(givenId === undefined ? `team ${org}/${team}: id ${teamId}` : `team id ${teamId}, as given`)
  const desired = loadRulesets(fileURLToPath(new URL('../.github/rulesets/', import.meta.url))).map(r =>
    fillTeam(r, teamId)
  )
  const plan = planRulesets(desired, fetchLive(repo))
  printPlan(plan)

  if (command === 'apply') {
    for (const a of plan.actions) {
      if (a.action === 'unchanged') continue
      const body = JSON.stringify(a.ruleset)
      if (a.action === 'create') {
        const made = gh(['-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], body)
        console.log(`created   ${a.name} #${made.id}`)
      } else {
        gh(['-X', 'PUT', `repos/${repo}/rulesets/${a.id}`, '--input', '-'], body)
        console.log(`updated   ${a.name} #${a.id}`)
      }
    }
  }
  if (command !== 'plan') {
    const after = command === 'apply' ? planRulesets(desired, fetchLive(repo)) : plan
    const drift = after.actions.filter(a => a.action !== 'unchanged')
    if (command === 'apply' && drift.length) printPlan(after)
    if (drift.length) {
      console.error(`${drift.length} ruleset(s) differ from .github/rulesets: ${drift.map(a => a.name).join(', ')}`)
      process.exit(1)
    }
    console.log('every managed ruleset matches .github/rulesets')
  }
}
