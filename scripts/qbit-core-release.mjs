// The qbit Core release that CI and scripts/regtest-smoke.sh test against.
// Change this one line to test another release: scripts/qbit-release.mjs
// derives the tag, release line, asset name and cache key from it. Check first
// that scripts/qbit-release-keys/pin.json pins the key policy in effect at that
// tag (its README says how): the verifier applies whatever policy it pins.
export const QBIT_CORE_VERSION = '1.0.0'
