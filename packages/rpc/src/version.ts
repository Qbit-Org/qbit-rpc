import type { RpcRequest } from './methods'
import { compact, field, integer, object, ResultIssue, string, type JsonObject } from './validate'

/**
 * The qbit Core releases this package supports: 1.0.x, any patch release of
 * 1.0 and no pre-release. This is the one place the range is defined; the
 * root README, docs/compatibility.md and docs/rpc/versions.md state it. A
 * minor version is added only once the regtest smoke test (CI's `regtest
 * smoke`, against the release scripts/qbit-core-release.mjs names) passes
 * against it.
 */
const SUPPORTED = { name: 'qbit', major: 1, minor: 0 } as const

/** The supported range, as messages write it. */
export const SUPPORTED_NODE_VERSIONS = `qbit Core ${SUPPORTED.major}.${SUPPORTED.minor}.x releases`

/**
 * The qbit Core version a node reports (`getnetworkinfo`), as every chain
 * check reads it: see `QbitRpcClient.nodeVersion`.
 */
export interface NodeVersion {
  /** `version`: 10000 * major + 100 * minor + patch, so 10000 for 1.0.0. */
  readonly version: number
  /**
   * `subversion`, the node's user agent: `/qbit:1.0.0/`, with a pre-release
   * suffix such as `/qbit:1.1.0-rc1/` or `/qbit:0.1.2-testnet4/`, and any
   * `-uacomment` in parentheses, `/qbit:1.0.0(ours)/`.
   */
  readonly subversion: string
  /** The major version: 1 for 1.0.0. */
  readonly major: number
  /** The minor version: 0 for 1.0.0. */
  readonly minor: number
  /** The patch version: 0 for 1.0.0. */
  readonly patch: number
  /** Whether this package supports it: a qbit Core (`qbit`) 1.0.x release, no pre-release suffix. */
  readonly supported: boolean
}

const R = 'result'

/**
 * A user agent as qbit Core v1.0.0 writes it (FormatSubVersion,
 * src/clientversion.cpp): `/<name>:<major>.<minor>.<patch>/`, the version
 * followed by an optional phase (`-testnet4`) and release candidate (`-rc1`),
 * then any `-uacomment`s in parentheses. Groups: the name, the version and the
 * suffixes.
 */
const USER_AGENT =
  /^\/([^/:()]+):((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))((?:-(?!rc)[A-Za-z]+[0-9]*)?(?:-rc[0-9]+)?)(?:\([^()]*\))?\/$/

/**
 * Read `version` and `subversion` of a `getnetworkinfo` result, and nothing
 * else. Both must be well formed and agree, as qbit Core derives both from one
 * CLIENT_VERSION: anything else is a validation failure, never a supported
 * version. The one reader of the two fields: the chain check and
 * `getNetworkInfo()` both use it, so they cannot disagree on a reply.
 */
export function readNodeVersion(o: JsonObject): NodeVersion {
  // CLIENT_VERSION is a C++ int.
  const version = field(o, 'version', R, integer(0, 0x7fff_ffff))
  const subversion = field(o, 'subversion', R, string)
  const major = Math.trunc(version / 10000)
  const minor = Math.trunc(version / 100) % 100
  const patch = version % 100
  const agent = USER_AGENT.exec(subversion)
  if (agent === null) {
    throw new ResultIssue(`${R}.subversion`, 'a user agent of the form /name:major.minor.patch/')
  }
  if (agent[2] !== `${major}.${minor}.${patch}`) {
    throw new ResultIssue(`${R}.subversion`, `the user agent of version ${version}, ${major}.${minor}.${patch}`)
  }
  const supported =
    agent[1] === SUPPORTED.name && major === SUPPORTED.major && minor === SUPPORTED.minor && agent[3] === ''
  return Object.freeze(compact<NodeVersion>({ version, subversion, major, minor, patch, supported }))
}

/** The chain check's reader: the version alone, so a change to the reply's other fields cannot fail a check. */
function parseNodeVersion(value: unknown): NodeVersion {
  return readNodeVersion(object(value, R))
}

/** The chain check's `getnetworkinfo` request. */
export function nodeVersionRequest(): RpcRequest<NodeVersion> {
  return Object.freeze({ method: 'getnetworkinfo', params: [], parse: parseNodeVersion })
}
