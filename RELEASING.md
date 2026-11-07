# Releasing

How `@qbit-oss/rpc` and `@qbit-oss/zmq` are versioned, branched, tagged and
published, who can cause a publish, and the settings that enforce it. Both
packages drive a qbitd wallet (`wallet-write`, `broadcast`), so a malicious
version on npm can spend consumers' funds. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md). The scheme and the workflow follow
`Qbit-Org/qbit-js`, which publishes `@qbit-oss/api` and `@qbit-oss/protocol`.

Nothing has been published yet. Before the first release, the one-time
setup below must be done, in order.

## Versioning

- [SemVer](https://semver.org). Both packages are versioned in **lockstep**:
  every release publishes both at the same version, from one release branch
  and one commit, with one CHANGELOG section, so one version names one tested
  pair. A package with no changes in a release still gets the new version.
  `pack:check` and the publish workflow fail when the two versions differ.
- Before 1.0 the version is `0.MINOR.PATCH`:
  - **MINOR** (`0.1.x` → `0.2.0`) for any breaking change: a removed or
    renamed export, an incompatible type or signature, input that used to be
    accepted and is now refused, an existing failure that now surfaces with a
    different error class, `reason` or `code`, a changed retry or outcome
    contract, a higher Node.js, TypeScript, `@types/node` or `zeromq` floor,
    or dropping a supported qbit Core version, unless it is one of the
    behaviour changes below that a patch may carry.
  - **PATCH** (`0.1.0` → `0.1.1`) for backward-compatible fixes and
    additions, such as a new typed method, a new option with a default that
    keeps today's behaviour, or support for a new qbit Core patch release.
  - **PATCH, as a behaviour change**, for a fix that changes behaviour only in
    one of these ways, and nothing else:
    - it refuses input that qbit Core refuses, or input with which the call
      could never have worked;
    - it refuses a reply that fails validation where it was accepted before,
      because the node or a proxy can send something the package misread;
    - it adds a resource limit whose default holds every legitimate use the
      docs describe;
    - it reports an outcome as the reply actually shows it, where it was
      claimed more definitely or wrongly before: `RpcUnknownOutcomeError`
      where a definite error was claimed for a reply that could not be judged;
    - it changes an error message without changing the error's class,
      `reason`, `code` or fields.

    Such a change can still make existing code fail or behave differently, so
    its CHANGELOG entry starts with **Behaviour change:**, and consumers on a
    caret range receive it with the next patch.
  - A caret range stays inside one line below 1.0 (`^0.1.0` means
    `>=0.1.0 <0.2.0`), so consumers never receive a breaking change from a
    patch update, only the behaviour changes above.
- **Deprecation.** Where it can, a minor release that removes or changes an
  export is preceded by a release that marks it `@deprecated` in its doc
  comment, with the replacement, and lists it in the CHANGELOG. A security fix
  does not wait for that.
- **Release candidates** are `X.Y.Z-rc.N`, with `N` from `0`. They are
  published under the npm dist-tag `candidate`, never `latest`, and ship what
  the `## X.Y.Z` section of CHANGELOG.md says so far. Only final releases move
  `latest`. The registry points `latest` at a new package's first version
  whatever its dist-tag, so after the first publish (`0.1.0-rc.0`, below)
  `npm install @qbit-oss/rpc` installs that candidate until `0.1.0` is
  published: keep that window short, and do not announce the packages before
  `0.1.0`.
- The workflow publishes a final release with no `--tag`, so npm applies
  `latest`. Before publishing, the npm client reads the package's versions
  from the registry and refuses (`Cannot implicitly apply the "latest" tag`)
  if a final release that is not deprecated is at or above the new version.
  A final release on an older line, such as `0.1.4` after `0.2.0`, therefore
  fails before anything is published, and needs a per-line dist-tag in the
  workflow first. The guard runs in the npm client only and is skipped if its
  registry lookup fails, so `latest` could then move backwards.
- `candidate` points at the most recently published candidate, so it can move
  backwards: `0.1.5-rc.0` published after `0.2.0-rc.1` takes it. A maintainer
  points it back from their npm account:
  `npm dist-tag add @qbit-oss/rpc@0.2.0-rc.1 candidate`, and the same for
  `@qbit-oss/zmq`.
- 1.0.0 is cut once the public API is declared stable. From then on breaking
  changes bump MAJOR.

## Branches

- `main` is the integration branch. Feature and fix pull requests target
  `main`. Both packages stay `"private": true` at `0.0.0` there, which
  `pack:check` enforces, so nothing on `main` can be published by accident.
- `release/X.Y` stabilizes one minor line. It is cut from `main` when the line
  starts stabilizing and takes only fixes, docs, and version and CHANGELOG
  updates, each through a pull request with green checks. Never merge `main`
  into a release branch. On a release branch, and for a pull request into one,
  CI runs `pack:check` in its release mode for that line.
- **Fixes flow back to `main`** through a back-merge pull request from
  `release/X.Y` into `main`, on a short-lived `backmerge/X.Y` branch cut from
  `release/X.Y` with `main` merged in. On it, run
  `corepack pnpm release:version 0.0.0`, which puts both packages back to
  `"private": true` at `0.0.0`; `pack:check` fails the back-merge until it
  does. Keep the release's CHANGELOG section. Merge a back-merge at least once
  per published version and before the next line is cut.
- A fix that lands on `main` first and is also needed on an active line is
  cherry-picked (`git cherry-pick -x`) onto `release/X.Y` in its own pull
  request.

## Versions and the changelog

- `corepack pnpm release:version <version>` sets both packages' version in one
  step: `X.Y.Z` or `X.Y.Z-rc.N` removes `"private"`, and `0.0.0` puts it back.
  It changes nothing else in the manifests, and prints what the release checks
  still find, such as a missing CHANGELOG section.
- Both `package.json` files on `release/X.Y` hold the next version to be
  published from it: `X.Y.0-rc.0` when the branch is cut.
- CHANGELOG.md has one section per release, `## X.Y.Z (unreleased)` while it
  collects entries, dated `## X.Y.Z - YYYY-MM-DD` in the pull request that
  sets the final version. Candidates have no section of their own. On `main`,
  entries go under the section of the next release they will ship in.
- Every pull request that changes `packages/*/src` adds a line to
  CHANGELOG.md; CI's `changelog` job fails it otherwise.
  `corepack pnpm changelog:check origin/main HEAD` runs the same check locally.
- `corepack pnpm release:check vX.Y.Z` runs, with Node.js only, the checks the
  publish workflow runs on a tag before it installs anything, and
  `PACK_CHECK_RELEASE=vX.Y.Z corepack pnpm pack:check` adds every check of the
  packed tarballs.

## One-time setup

Done once, by the operator, in this order. Each step says who can do it.
The state on 2026-11-05, after the repository was made public:

- a branch ruleset `main` blocks deletion and force pushes and requires a pull
  request, with no approval, code-owner review or status check, and lets the
  role "Repository admin" bypass it;
- a tag ruleset `v*` restricts creating, updating and deleting tags, and lets
  "Repository admin" bypass all of it, so any admin can push, move or delete a
  release tag;
- the `npm` environment, limited to `v*` tags, has `kiwidream` as its required
  reviewer, "Prevent self-review" off, and lets administrators bypass it;
- private vulnerability reporting is off;
- neither package exists on npm.

Steps 2 to 5 bring these to the settings below.

1. **npm organisation and 2FA.** On npmjs.com, as an owner of the `qbit-oss`
   organisation (which already publishes `@qbit-oss/api` and
   `@qbit-oss/protocol`):
   - check that your account has two-factor authentication on, for
     "Authorization and writes" (Account → Two-Factor Authentication), and
     ask every other member who can publish to the organisation's packages to
     do the same;
   - check the organisation's members and teams (Organization → Members,
     Teams), and remove anyone who should not publish. A package a member
     publishes in the scope is writable by the organisation's `developers`
     team, so that team's members can publish it with a token unless step 11
     is done.
2. **The public repository.** `Qbit-Org/qbit-rpc` was made public on
   2026-11-05: npm generates provenance only for a public repository, and
   `--provenance` fails otherwise. By a repository admin:
   - under Settings → Code security, turn on **Private vulnerability
     reporting**, which SECURITY.md sends reporters to;
   - finish the pre-public review's follow-ups: edited issue and pull request
     bodies still show their earlier text under "edited", until each such
     revision is deleted (the "edited" menu → the revision → Delete revision
     from history), which GitHub's API cannot do.
3. **The release approvers team**, by an organisation owner: create a team
   (Organization → Teams), for example `qbit-rpc-release`, of the release
   approvers, today `kiwidream` alone (see [Gaps](#gaps)). A ruleset's bypass
   list takes roles, teams and apps, not individual users, and the
   repository has other admins, a bot account among them, so the role
   "Repository admin" would admit them too.
4. **Rulesets**, by a repository admin, under Settings → Rules → Rulesets:
   edit the existing `main` and `v*` rulesets and add the others. A bypass
   actor bypasses every rule of its ruleset, so creating refs and changing
   them are separate rulesets, and no ruleset lets the role "Repository
   admin" bypass it:
   1. Branch ruleset `main`, target the default branch: Require a pull
      request before merging (1 approval, Dismiss stale pull request approvals
      when new commits are pushed, Require review from Code Owners, Require
      approval of the most recent reviewable push), Require status checks to
      pass (`verify`, `regtest smoke` and `changelog`, from GitHub Actions,
      with Require branches to be up to date), Block force pushes, Restrict
      deletions. Bypass list: the release approvers team only while there is
      one code owner ([Gaps](#gaps)), otherwise empty.
   2. Branch ruleset `release-branches`, target `release/*`: the same rules as
      `main`, with the same bypass: the release approvers team only while there
      is one code owner ([Gaps](#gaps)), otherwise empty. Without it, the only
      code owner's `release:version` pull request, which changes both
      manifests, could never merge. The workflow's release-branch check means
      "reviewed" only while every change to `release/X.Y` comes through such a
      pull request.
   3. Branch ruleset `release-branch-creation`, target `release/*`: Restrict
      creations, bypass list the release approvers team, so only they can cut
      a release branch.
   4. Tag ruleset `release-tag-creation`, target `v*`: Restrict creations,
      bypass list the release approvers team, so only they can push a tag
      that publishes.
   5. Tag ruleset `release-tags-fixed`, target `v*` (the existing `v*`
      ruleset, renamed): Restrict updates, Restrict deletions and Block force
      pushes, no bypass actors, so a tag is never moved or deleted. Today it
      also restricts creations and lets every admin bypass all of it: move
      creation to ruleset 4 and empty its bypass list.
5. **The `npm` environment**, by a repository admin (Settings → Environments
   → `npm`, which exists):
   - Required reviewers: the release approvers team, in place of the user
     `kiwidream`. Check "Prevent self-review" once there is a second approver
     ([Gaps](#gaps)).
   - Allow administrators to bypass configured protection rules: off (on
     today).
   - Deployment branches and tags: "Selected branches and tags", with the one
     tag rule `v*` and no branch rule (already so).
   - No secret, except `NPM_TOKEN` for the first publish if step 8 takes
     option A.

   Check: `gh api repos/Qbit-Org/qbit-rpc/environments/npm --jq '.protection_rules'`
   lists the reviewers.
6. **Cut `release/0.1`**, by a release approver:
   `git fetch origin && git push origin origin/main:refs/heads/release/0.1`.
   CI's run on that first commit fails `pack:check`, as both packages are
   still `0.0.0` there; that is expected. In a pull request to `release/0.1`,
   run `corepack pnpm release:version 0.1.0-rc.0` and commit the two
   manifests; CHANGELOG.md's `## 0.1.0 (unreleased)` section ships as it is.
   CI runs `pack:check` for `release/0.1` on it. Merge it.
7. **Dry run.** Actions → Publish → Run workflow, on `release/0.1`. It runs
   `build`, `smoke` and `tarballs`, which ends in `npm publish --dry-run` of
   the two tarballs, and skips `publish`. It must pass.
8. **First publish of `0.1.0-rc.0`.** npm lets a trusted publisher be set
   only for a package that exists, so the first version goes out another way.
   Take one option:
   - **A. A token for the first release only (recommended).** It runs the
     whole workflow, and `0.1.0-rc.0` gets provenance.
     1. On npmjs.com, Access Tokens → Generate New Token → Granular Access
        Token: Packages and scopes **Read and write**, limited to the scope
        `@qbit-oss`; Organizations: no access; "Bypass two-factor
        authentication" checked; the shortest expiry that covers the release,
        such as 1 day.
     2. Save it as the secret `NPM_TOKEN` of the `npm` environment (Settings →
        Environments → `npm` → Add environment secret), where only the
        approved `publish` job can read it.
     3. Push the tag, from the merge commit of step 6, as in
        [Cutting a release](#cutting-a-release), and approve the `publish`
        job after the [checklist](#approving-a-publish). With no trusted
        publisher, npm takes the token; the run still signs provenance.
     4. Delete the `NPM_TOKEN` secret and revoke the token at once. The
        workflow fails while the secret is set and both packages exist.
   - **B. A manual publish with 2FA, no token.** No token ever exists, but
     `0.1.0-rc.0` has no provenance, so step 10 needs `0.1.0-rc.1`.
     1. Push the tag as in [Cutting a release](#cutting-a-release). Let
        `build`, `smoke` and `tarballs` pass, and leave the `publish` job
        waiting.
     2. Into an empty directory, download the run's tarballs:
        `gh run download <run-id> -R Qbit-Org/qbit-rpc -n npm-tarballs -D <dir>`.
        Check `sha256sum <dir>/*.tgz` against the two lines the `build` job's
        "Pack the tarballs to publish" step printed.
     3. With npm 11 (`--provenance=false` must override the packages'
        `publishConfig`; an npm that does not refuses with `Automatic
        provenance generation not supported` and publishes nothing), publish
        each, entering your OTP:
        `npm publish <dir>/qbit-oss-rpc-0.1.0-rc.0.tgz --tag candidate --access public --provenance=false --ignore-scripts`,
        then the same for `qbit-oss-zmq-0.1.0-rc.0.tgz`.
     4. Approve the waiting `publish` job: it finds both versions on npm with
        its tarballs' integrity, skips them, and passes.
9. **Trusted publishers**, by an owner of the scope, for each of
   `@qbit-oss/rpc` and `@qbit-oss/zmq`: on npmjs.com, the package → Settings →
   Trusted publishing → GitHub Actions:
   - Organization or user: `Qbit-Org`
   - Repository: `qbit-rpc`
   - Workflow filename: `publish.yml`
   - Environment name: `npm`
   - Allowed actions: npm publish (configurations created since 2026-09-03
     allow only `npm stage publish` unless it is selected).

   With npm 11.15.0 or later and 2FA the CLI does the same:
   `npm trust github @qbit-oss/rpc --repo Qbit-Org/qbit-rpc --file publish.yml --env npm --allow-publish`.
   qbit-js found that a configuration lapses unless a publish uses it within
   2 days, so set it up just before the next tag, and again if it lapsed.
10. **Rehearse and check provenance.** Publish `0.1.0-rc.1` through trusted
    publishing (bump in a pull request to `release/0.1`, tag, approve), which
    is required after option B and recommended after option A, as it is the
    first publish with no token. Then, for each candidate published with
    provenance:
    - `npm view @qbit-oss/rpc@0.1.0-rc.1 dist.attestations --json` (and
      `@qbit-oss/zmq`) shows a provenance attestation, of predicate type
      `https://slsa.dev/provenance/v1`;
    - each package's page on npmjs.com shows the provenance, linking this
      repository, `.github/workflows/publish.yml`, the tag's commit and the
      workflow run;
    - in an empty directory, `npm init -y`,
      `npm install @qbit-oss/rpc@candidate @qbit-oss/zmq@candidate`, then
      `npm audit signatures` reports verified registry signatures and
      attestations for both;
    - `npm dist-tag ls @qbit-oss/rpc` shows `candidate` at the version (and
      `latest` too, after the first publish, as [Versioning](#versioning)
      says).
11. **Lock publishing down**, once a trusted publish has succeeded, by an owner
    of the scope, for both packages: Settings → Publishing access → "Require
    two-factor authentication and disallow tokens". Check that no
    `NPM_TOKEN` secret is left in the environment and no token from step 8
    is left on npmjs.com.
12. **Network verification** of the candidate (#7): regtest with fault
    injection, a mainnet read-only sweep and ZMQ soak, and optionally one
    small mainnet send. The network check that runs them,
    `pnpm verify:network`, lands in its own pull request, whose
    `docs/network-verification.md` gives the steps. Commit the reports, and
    fix or explain each failure, before the final release.

Then [the final release](#final-release) publishes `0.1.0`.

## Cutting a release

For a candidate `vX.Y.Z-rc.N` or a final `vX.Y.Z`, by a release approver:

1. Check that the tip of `release/X.Y` has green checks, holds the version to
   publish in both manifests (`corepack pnpm release:check vX.Y.Z-rc.N`
   passes), and that CHANGELOG.md's section lists every change on the branch.
2. Create a signed, annotated tag on that commit and push it:

   ```sh
   git fetch origin
   git tag -s vX.Y.Z-rc.N -m vX.Y.Z-rc.N origin/release/X.Y
   git push origin vX.Y.Z-rc.N
   ```

3. The [publish workflow](#the-publish-workflow) runs. Approve its `publish`
   job after the [checklist](#approving-a-publish), and check that the run
   succeeded and both versions are on npm (`npm view @qbit-oss/rpc versions`).
4. For another candidate, bump both versions to `X.Y.Z-rc.N+1` in a pull
   request to `release/X.Y`.

## Final release

1. In a pull request to `release/X.Y`: `corepack pnpm release:version X.Y.Z`,
   date the section (`## X.Y.Z - YYYY-MM-DD`), and bring its known
   limitations up to date with the network verification.
2. Merge the back-merge pull request into `main`: the READMEs link to
   `blob/main`, so `main` must hold every page they link to before npm shows
   the new READMEs.
3. [Cut](#cutting-a-release) `vX.Y.Z` from the release commit. The workflow
   publishes both packages under `latest`.
4. In a pull request to `release/X.Y`, bump both versions to
   `X.Y.(Z+1)-rc.0` and open the `## X.Y.(Z+1) (unreleased)` section.

## The publish workflow

`.github/workflows/publish.yml` publishes both packages when a `v*` tag is
pushed to `Qbit-Org/qbit-rpc`. Its jobs never run in another repository, such
as a fork, and only a tag push publishes. Run by hand on `release/X.Y`, it is
a dry run of that branch's version. It has four jobs:

1. `build` holds no secret and no `id-token`. Besides pnpm, Node.js and the
   SHA-pinned actions, it runs only code that `pnpm-lock.yaml` pins: the
   locked dev dependencies, esbuild's and zeromq's install scripts, and each
   package's `prepack`. Before installing anything, `scripts/check-release.mjs`
   checks that both packages are at the tag's version, `X.Y.Z` (dist-tag
   `latest`) or `X.Y.Z-rc.N` (`candidate`), without `"private"`, with
   `files`, `license`, a LICENSE, `engines` and `publishConfig`
   (`{ "access": "public", "provenance": true }`), that CHANGELOG.md has the
   version's section (dated, for a final release), and the workflow that the
   tagged commit is on `release/X.Y`. Then the API reports, typechecks, tests
   and `pack:check` in its release mode must pass. It packs both packages,
   prints and records the two tarballs' SHA-256 sums in the same step, and
   uploads them as the run's `npm-tarballs` artifact.
2. `smoke` runs the checks `build` does not need: `consumer:check`, and the
   regtest smoke test against qbit Core, downloaded and verified against a
   quorum of the release keys, with no cache. It can stop a release but not
   change the tarballs.
3. `tarballs` checks out nothing and installs nothing. It downloads `build`'s
   artifact by its ID and fails unless it holds exactly one tarball of the
   version per package, each matching `build`'s SHA-256; npm's own tarball
   reader reads each as that package at that version with no path twice;
   GNU tar lists only `package/` entries, with no empty, `.` or `..`
   component and one `package/package.json`; and that manifest has no
   `"private"` and the `publishConfig` above. It then runs `npm publish
   --dry-run` on each.
4. `publish` runs after all three, only for a pushed tag, in the `npm`
   environment, so it starts only once a required reviewer approves it. It is
   the only job here that can request the OIDC token for trusted publishing
   or read `NPM_TOKEN` (the only other job with `id-token` is the API
   reference's Pages deploy, below), and it checks out nothing, installs nothing and runs no
   repository or dependency code. It downloads the artifact by ID, checks the
   tarballs against the pushed tag and `build`'s sums (so they are the bytes
   `tarballs` checked), and runs `npm publish <tarball> --provenance --access
   public --ignore-scripts`, with `--tag candidate` for a candidate. A version
   already on npm is skipped if npm's integrity for it is the tarball's, and
   fails the job otherwise, so re-running the job finishes a partial publish.
   While `NPM_TOKEN` is set, it fails if both packages exist on npm, or if npm
   answers anything but `E404` when asked whether one does.

No job that runs third-party code can publish. What remains is the build
itself: a compromised locked dev dependency, pnpm, Node.js or pinned action
could alter the tarballs before `build` records their sums.

Publish only through this workflow. Both packages set
`publishConfig.provenance`, so `npm publish` from a workstation fails
(`Automatic provenance generation not supported`) unless provenance is turned
off by hand, as only step 8 B does.

### Approving a publish

The run uses the workflow file of the tagged commit, so its own checks prove
nothing if that file was edited. The approver checks, against their own
`git fetch origin --tags` rather than the run's log:

- [ ] the run is for the expected tag, and its commit (on the run page) is
      that tag's commit and is on `release/X.Y`:
      `git merge-base --is-ancestor <commit> origin/release/X.Y`;
- [ ] `.github/workflows/publish.yml` and `scripts/check-release.mjs`,
      `scripts/release-checks.mjs` and `scripts/check-pack.mjs` at that commit
      are the versions reviewed on `release/X.Y`:
      `git diff origin/release/X.Y <commit> -- .github/workflows/publish.yml scripts/`
      prints nothing;
- [ ] every commit the release adds came through an approved pull request
      to `release/X.Y`: review `git log <previous tag>..<commit>` and match
      each commit to its merged, approved pull request. For a line's first
      release, review the branch's first-parent chain back to where it was
      cut from `main`:

      ```sh
      bp=$(git rev-list --first-parent <commit> | grep -m1 -Fxf <(git rev-list --first-parent origin/main))
      git log --first-parent $bp..<commit>
      ```

- [ ] CHANGELOG.md at that commit has the `## X.Y.Z` section, listing the
      release's changes;
- [ ] `build`, `smoke` and `tarballs` passed.

If any item fails, reject the deployment; nothing is published.

## The API reference on GitHub Pages

The API reference is deployed by `.github/workflows/docs.yml` from final
release tags only (`v*` without a pre-release suffix), so the published
reference is the latest release's. Its deploy job is the only job besides
`publish` with `id-token: write`. Once, by a repository admin:

- **Settings → Pages → Build and deployment → Source:** "GitHub Actions".
- **Settings → Environments → `github-pages` → Deployment branches and
  tags:** allow the tag rule `v*`, so a release tag may deploy. GitHub creates
  the environment when Pages is enabled; add the rule there.

Until then the deploy job fails at its first release tag, and the reference's
links answer 404.

## Who can approve a release

A release is approved by the **release approvers**: the members of the team
that is the `npm` environment's required reviewer and the bypass actor for
creating `v*` tags and `release/*` branches. Nobody else can let the publish
job run, whatever their access to the repository. Today that is the GitHub
user `kiwidream`, who is also the code owner in `.github/CODEOWNERS`.

- **Grant:** an organisation owner adds the person to the team, after the
  change is agreed in a pull request or issue that names them. If they also
  review changes to the release path, add them to `.github/CODEOWNERS` in a
  pull request.
- **Remove:** an organisation owner removes them from the team, a repository
  admin from `.github/CODEOWNERS` if listed, and an owner of the `@qbit-oss`
  npm scope their publish access, if they have it.
- **Check:** `gh api repos/Qbit-Org/qbit-rpc/environments/npm --jq '.protection_rules'`
  lists the reviewers, and the team's page its members.

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
  owner, or the release approvers team's bypass on the `main` and
  `release-branches` rulesets, to merge. Remove both bypasses once a second
  code owner is in `.github/CODEOWNERS`.
- **Rulesets weaker than above (2026-11-05).** While the repository was
  private, GitHub refused rulesets. Since it went public, the `main` and `v*`
  rulesets exist but let every repository admin bypass them, `main` requires
  no approval, code-owner review or status check, so `.github/CODEOWNERS` is
  not enforced, and the `npm` environment lets admins bypass its reviewer.
  Steps 3 to 5 of the setup close this.
- **Repository admins (2026-11-05).** Four accounts are admins of the
  repository, one of them a bot. Any admin can change the rulesets and the
  `npm` environment, so the protections above hold against everyone else, not
  against an admin. Keep the admin list to the people who need it.
