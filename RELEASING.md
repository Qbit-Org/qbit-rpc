# Releasing

`@qbit-oss/rpc` and `@qbit-oss/zmq` drive a qbitd wallet (`wallet-write`,
`broadcast`), so a malicious version on npm can spend consumers' funds. This
file records who can cause a publish and the settings that enforce it. The
publish workflow and the release steps themselves come with #4; until then
both packages stay `"private": true` at `0.0.0`, and `pack:check` fails
otherwise.

## Who can approve a release

A release is approved by the **release approvers**: the required reviewers set
on the repository's `npm` environment (below). Nobody else can let the publish
job run, whatever their access to the repository.

The release approver is the GitHub user `kiwidream`, who is also the code
owner in `.github/CODEOWNERS`. With one approver, two of the settings below
cannot hold yet, and are recorded under [Gaps](#gaps): "Prevent self-review"
on the `npm` environment, and code-owner review of `kiwidream`'s own pull
requests to the release path.

- **Grant:** a repository admin adds the person, or a team, under Settings →
  Environments → `npm` → Required reviewers, after the change is agreed in a
  pull request or issue that names them. If they also review changes to the
  release path, add them to `.github/CODEOWNERS` in a pull request.
- **Remove:** a repository admin removes them from the environment's required
  reviewers, and from `.github/CODEOWNERS` if listed, and an owner of the
  `@qbit-oss` npm scope removes their publish access, if they have it.
- **Check:** `gh api repos/Qbit-Org/qbit-rpc/environments/npm --jq '.protection_rules'`
  lists the reviewers.

## Repository settings

Set by a repository admin; none of these live in the repository. Which of
them GitHub offers depends on the visibility decided in #4: on 2026-11-05
rulesets were refused on this private repository ("Upgrade to GitHub Pro or
make this repository public"). Anything the plan does not allow is a gap:
write it under [Gaps](#gaps) with the reason.

### `main`

A ruleset (or branch protection) on `main` that:

- requires a pull request before merging, with one approval, and review from
  code owners (`.github/CODEOWNERS`, covering `.github/`, `scripts/`,
  `package.json`, `packages/*/package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, `packages/*/tsup.config.ts`, the tsconfigs and this
  file);
- dismisses stale approvals when new commits are pushed;
- requires the `verify` and `regtest smoke` status checks to pass, on an
  up-to-date branch;
- blocks force pushes and deletion;
- lets only repository admins bypass it, and only while there is one code
  owner (see [Gaps](#gaps)); once there is a second, it has no bypass list.

### Release tags

A tag ruleset on `refs/tags/v*` that restricts creation, update and deletion
to the release approvers, so nobody else can push a `v*` tag from any
commit, and a tag cannot be moved once pushed.

### The `npm` environment

Settings → Environments → New environment, named `npm`:

- **Required reviewers:** the release approvers, with "Prevent self-review"
  on, so whoever pushed the tag cannot approve its publish alone. This needs
  a second approver (see [Gaps](#gaps)).
- **Allow administrators to bypass configured protection rules:** off.
- **Deployment branches and tags:** "Selected branches and tags", with one
  tag rule, `v*`, and no branch rules.
- No environment secrets: publishing uses npm trusted publishing (OIDC), not
  a token.

The publish job in `.github/workflows/publish.yml` (#4) runs with
`environment: npm`, and is the only job with `id-token: write`.

## npm settings

For each of `@qbit-oss/rpc` and `@qbit-oss/zmq`, on npmjs.com, by an owner of
the `@qbit-oss` scope:

1. **Trusted publisher** (package → Settings → Trusted publishing → GitHub
   Actions): organisation `Qbit-Org`, repository `qbit-rpc`, workflow
   `publish.yml`, environment `npm`.
2. **After the package's first publish:** Settings → Publishing access →
   "Require two-factor authentication and disallow tokens". Then revoke any
   token used to bootstrap that first publish (npmjs.com → Access Tokens).

Check with `npm view @qbit-oss/rpc dist.attestations` (and `@qbit-oss/zmq`)
that each published version has provenance from this repository.

## Gaps

Record here any setting above that cannot hold, with the date, the reason,
and what stands in for it.

- **One release approver (2026-11-05).** `kiwidream` is the only release
  approver and the only code owner. Only approvers may push `v*` tags, so
  with "Prevent self-review" on, nobody could approve a publish: leave it off
  until there is a second approver. Until then, a release is pushed and
  approved by the same person, and the environment's review is a deliberate
  second step, not a second person. Likewise, GitHub does not count an
  author's own review, so a pull request by `kiwidream` that touches a
  code-owned path cannot meet code-owner review: it needs a second code
  owner, or an admin bypass on the `main` rule, to merge.
- **2026-11-05: one code owner; admin bypass needed until a second owner is
  added.** The `main` rule lets repository admins bypass it, for the case
  above, instead of having no bypass list. Remove the bypass once a second
  code owner is in `.github/CODEOWNERS`.
- **Rulesets refused while the repository is private (2026-11-05).** None of
  the rules above is on yet, so `.github/CODEOWNERS` is not enforced: until
  they are, a code owner's review is a convention, not a check.
