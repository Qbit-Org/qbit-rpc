# Repository rulesets

These files are this repository's GitHub rulesets. Step 4 of "One-time setup"
in [RELEASING.md](../../RELEASING.md#one-time-setup) says what each one
enforces. `pnpm rulesets check` compares them with GitHub and
`pnpm rulesets apply` applies them.
[CONTRIBUTING.md](../../CONTRIBUTING.md#pull-requests) says how a pull request
lands as one signed commit, which is what the `signed-landing` check
([`../workflows/signed-landing.yml`](../workflows/signed-landing.yml)) waits
for.
