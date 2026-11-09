# qbit Core release keys

The trust root `scripts/qbit-release.mjs` verifies qbit Core releases against.

qbit's release key policy has one source of truth: `contrib/keys/operator-keys/`
in `Qbit-Org/qbit`, read at a reviewed commit. This repository keeps no copy of
it. `pin.json` pins it instead, and the verifier downloads it from qbit and
checks every byte against the pin before it reads anything:

- `commit`: the qbit commit the policy is read from,
  `7ebcddb622d6e639041f005a189b048ec2a221fe`, the target of tag `v1.0.0`.
  Files come from
  `https://raw.githubusercontent.com/Qbit-Org/qbit/<commit>/contrib/keys/operator-keys/`.
- `policy_id` and `policy_sha256`: policy `qbit-release-keys-mainnet-000002`,
  sequence 2, effective from `v1.0.0`, whose `keys.json` has SHA-256
  `f04ae262bd40cdda5c481fc18cef29b405878e66d06c33b49865ea42b38eaf9f`. That is
  the digest qbit's `approvals/<policy_id>/policy.SHA256` holds and its
  previous signers signed, and the one qbit's release evidence records. It sets
  a release signature quorum of 3 of the 5 active signers for `mainnet` and 2
  of 3 for `testnet`.
- `signers`: for each signer `keys.json` lists, the SHA-256 of its certificate
  (`public-keys/<alias>-release.asc`), which `keys.json` does not cover, and
  its primary-key fingerprint, as gpg lists it for that certificate. A
  signature counts only when gpg's `VALIDSIG` names the signing key
  `keys.json` lists and this primary key.

A file with another digest is refused before it is written to disk. So are a
`keys.json` of another schema version or `policy_id`, one that names other
signers than the pin, lists a signer or signing key twice, has an unknown
status, or whose release line's active signers do not number its
`active_signer_set_size` or cannot reach its quorum: the checks qbit's
`ci/release/validate_key_metadata.py` makes of the fields read here. The
downloaded policy is kept in `<sums-dir>/policy/`, and checked against the pin
again each time it is used.

A pin is a trust anchor. Never replace it with a download that is not checked
against a pinned digest, and never point it at a branch.

A release is `testnet` when its version contains `testnet`, and `mainnet`
otherwise, as qbit's `ci/release/validate_release_artifacts.py` decides; so
`v1.0.0` is `mainnet` and needs 3 signers.

## Key expiry

operator-01's primary key expires on 2028-06-07; the other four keys and every
signing subkey have no expiry. gpg then reports `EXPKEYSIG` for operator-01's
signatures, which the verifier refuses, and `v1.0.0`, signed by operator-01, -02
and -03 against a quorum of 3, no longer verifies. Before that date, pin the
refreshed certificate (or the next policy) from qbit as below. qbit's own
`ci/release/validate_release_artifacts.py` would still count such a signature;
this verifier is stricter on purpose.

## Updating

Keep the pin until a release under test needs another policy: a release
signed under policy 000002, such as `v1.0.0`, keeps verifying against this pin
however qbit's policy changes later. When it does need one:

1. Find the qbit commit that introduced the policy, on a protected qbit branch
   or a signed release tag.
2. Run `node scripts/qbit-release.mjs pin <qbit-commit>`. It first asks
   GitHub's compare API whether the commit is on qbit's protected `main` or
   `1.x.x` branch, or on a release tag (`v*`), and refuses any other commit:
   raw.githubusercontent.com serves every commit in the repository network,
   forks' included. Set `GITHUB_TOKEN` if the API's unauthenticated rate limit
   is reached. It then downloads that commit's `keys.json` and certificates
   and prints a candidate `pin.json`. It refuses a policy that is neither the
   pinned one nor its direct successor: `previous_policy_sha256` must be the
   pinned `policy_sha256`, and `policy_sequence` one more than the pinned
   policy's. To skip a policy, update one sequence at a time.
3. `pin` does not check approvals. Check that the previous policy's signers
   approved the new one with qbit's own validator, in a qbit checkout `<qbit>`
   at that commit, with the pinned commit's policy extracted into an empty
   `<old-dir>`:

   ```sh
   git -C <qbit> archive <old-commit> contrib/keys/operator-keys | tar -x -C <old-dir>
   python3 <qbit>/ci/release/validate_key_metadata.py \
     --operator-policy <qbit>/contrib/keys/operator-keys/keys.json \
     --operator-keys-dir <qbit>/contrib/keys/operator-keys \
     --previous-operator-policy <old-dir>/contrib/keys/operator-keys/keys.json \
     --require-public-key-files
   ```

   It must print the new `policy_sha256`, which must equal the candidate's.
4. Commit the candidate as `pin.json`, and update the commit and policy named
   above, in the same pull request as the change of
   `scripts/qbit-core-release.mjs` that needs it.

A refreshed certificate under the same `keys.json` (an extended expiry, say)
is a new commit with the same `policy_sha256`: `pin` accepts it, and only the
certificate's `certificate_sha256` changes. Check it carries no new key.
