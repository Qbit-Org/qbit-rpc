# qbit Core release keys

The trust root `scripts/qbit-release.mjs` verifies qbit Core releases against.

- `keys.json` and `public-keys/` are byte-for-byte copies of
  `contrib/keys/operator-keys/keys.json` and
  `contrib/keys/operator-keys/public-keys/` in `Qbit-Org/qbit` at tag `v1.0.0`
  (commit `7ebcddb622d6e639041f005a189b048ec2a221fe`). They match the mirror
  in `Qbit-Org/qbit-guix.sigs` under `operator-keys/` (commit
  `daa3a0a8bb4b5a8b16042ac0cc1d8d0f859cef82`, unchanged at
  `c18adfe292cf54cbee73ff86d0f1d3619a8ffea3`).
- `keys.json` is policy `qbit-release-keys-mainnet-000002`, sequence 2,
  effective from `v1.0.0`, SHA-256
  `f04ae262bd40cdda5c481fc18cef29b405878e66d06c33b49865ea42b38eaf9f` (the
  hash in that policy's `approvals/.../policy.SHA256`). It sets a release
  signature quorum of 3 of the 5 active signers for `mainnet` and 2 of 3 for
  `testnet`.
- `fingerprints.txt` lists each signer's primary-key and signing-subkey
  fingerprints, as gpg lists them for its certificate. The signing
  fingerprints are those in `keys.json`.

A release is `testnet` when its version contains `testnet`, and `mainnet`
otherwise, as qbit's `ci/release/validate_release_artifacts.py` decides; so
`v1.0.0` is `mainnet` and needs 3 signers.

## Key expiry

operator-01's primary key expires on 2028-06-07; the other four keys and every
signing subkey have no expiry. gpg then reports `EXPKEYSIG` for operator-01's
signatures, which the verifier refuses, and `v1.0.0`, signed by operator-01, -02
and -03 against a quorum of 3, no longer verifies. Before that date, copy the
refreshed certificate (or the next policy) from qbit as below. qbit's own
`ci/release/validate_release_artifacts.py` would still count such a signature;
this verifier is stricter on purpose.

## Updating

When qbit publishes a new policy, copy `keys.json` and `public-keys/` from the
tag that introduced it, check they match the `qbit-guix.sigs` mirror byte for
byte, check that the policy's `approvals/<policy_id>/` is signed by a quorum of
the previous policy's signers, update `fingerprints.txt` from
`gpg --with-colons --fingerprint` in an empty GnuPG home, and update the
commits above. The verifier refuses a `keys.json` and `fingerprints.txt` that
name different signers or signing keys.
