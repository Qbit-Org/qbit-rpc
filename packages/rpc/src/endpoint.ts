import { createPrivateKey, X509Certificate } from 'node:crypto'
import { open } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { createSecureContext, type SecureContext, type SecureContextOptions } from 'node:tls'

import { argOptions, keysOf, ownElements } from './own'

/**
 * How the client authenticates. Exactly one form:
 *
 * - `{ username, password }`: HTTP Basic credentials (`rpcuser`/`rpcpassword`
 *   or an `rpcauth` entry). Sent over HTTPS, or over HTTP to a loopback host.
 * - `{ cookieFile }`: qbitd's `.cookie` file. Only for a loopback endpoint;
 *   the file is read again for every request, so qbitd can restart and
 *   rotate it without restarting your service.
 */
export type RpcAuth =
  | {
      /** The user name: `rpcuser`, or an `rpcauth` entry's. */
      readonly username: string
      /** The password. `toJSON()` and `util.inspect` never show it. */
      readonly password: string
    }
  | {
      /** The path of qbitd's `.cookie` file, on this host. */
      readonly cookieFile: string
    }

/**
 * TLS settings for an `https` endpoint, such as a TLS terminator in front of
 * qbitd, which serves plain HTTP. Each is checked when the client is
 * constructed. The node's certificate is always verified: there is no option
 * to turn that off.
 */
export interface RpcTlsOptions {
  /**
   * PEM CA certificates to trust instead of the system's: a string or Buffer
   * holding one or more, or an array of them. Default: the system's CAs.
   */
  readonly ca?: string | Buffer | readonly (string | Buffer)[]
  /** A PEM client certificate, then any intermediate certificates, for a terminator that requires one. Needs `key`. */
  readonly cert?: string | Buffer
  /** The PEM private key of `cert`. Needs `cert`. */
  readonly key?: string | Buffer
  /** Decrypts an encrypted `key`. Used once, at construction, and not kept. */
  readonly passphrase?: string
  /**
   * The host name the node's certificate must carry, also sent in SNI, instead
   * of the URL's host: for a URL that names an address, or another name.
   * Default: the URL's host.
   */
  readonly servername?: string
  /**
   * The base64 SHA-256 of the SubjectPublicKeyInfo (the public key) the node's
   * certificate must carry, or several (the current key and the next, for
   * rotation). Checked on every connection, after the CA and name checks,
   * which still apply. Default: no pin.
   */
  readonly pinSha256?: string | readonly string[]
}

/** Where a {@link RpcConnect} function opens its stream to. */
export interface RpcConnectTarget {
  /** The URL's host: a name, or an address without brackets. */
  readonly host: string
  /** The URL's port, 443 when it names none. */
  readonly port: number
  /**
   * Fires if the client gives up before the connection is open: at the deadline
   * or abort of the side-effecting call it is opened for. A pooled connection,
   * which reads share, outlives the read it is opened for, and one Node's pool
   * opens by itself serves the request queued behind a full pool: once no
   * request waits for it, its signal fires when the client's `timeoutMs` has
   * passed since it started, or when a read that waits needs its turn, and on
   * `close()` at any time. A stream that arrives later is destroyed. It never
   * fires once the connection is in use.
   */
  readonly signal: AbortSignal
}

/**
 * Opens a new byte stream to `target` for one connection, such as a tunnel
 * through an HTTP CONNECT or SOCKS proxy. The client runs TLS over it, with
 * every check, and HTTP over that. It must return a new stream, connected or
 * connecting, on every call, stop when `target.signal` fires, and give up on
 * its own when the proxy does not answer: the client opens at most
 * `maxConcurrentRequests` plus one connections through it at once for reads,
 * and as many again for side-effecting calls. Keep an
 * `error` listener on a stream until it is returned: the client sees a stream
 * only then, and its error before that has nowhere else to go.
 */
export type RpcConnect = (target: RpcConnectTarget) => Duplex | Promise<Duplex>

export interface Endpoint {
  readonly url: URL
  /** The host is a loopback address, or the name `localhost`, which each connection resolves and checks. */
  readonly loopback: boolean
}

const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

/**
 * Whether `address` is a loopback address: in 127.0.0.0/8, `::1`, or in
 * 127.0.0.0/8 mapped to IPv6 (`::ffff:127.0.0.1`). A name is not: false.
 */
export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address)
  return family !== 0 && LOOPBACK.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/** A URL's host as a connection takes it: a name, or an address without the brackets of IPv6. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '')
}

export function parseEndpoint(rawUrl: unknown, wallet: unknown): Endpoint {
  if (typeof rawUrl !== 'string' || rawUrl === '') throw new TypeError('url must be a non-empty string')
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new TypeError('url must be an absolute http or https URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('url must use http or https')
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('url must not contain credentials: pass them as auth')
  }
  if (url.search !== '' || url.hash !== '') throw new TypeError('url must not have a query or fragment')
  // `localhost` passes by name here. Each connection then resolves it and
  // refuses it unless every address is loopback (transport.ts).
  const host = hostOf(url)
  const loopback = host === 'localhost' || isLoopbackAddress(host)
  if (url.protocol === 'http:' && !loopback) {
    throw new TypeError('url must use https unless the host is loopback: RPC credentials would travel in cleartext')
  }
  if (wallet !== undefined) {
    if (typeof wallet !== 'string') throw new TypeError('wallet must be a string')
    if (/(^|\/)wallet\//.test(url.pathname)) throw new TypeError('pass the wallet either in url or as wallet, not both')
    const base = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
    // qbit Core URL-decodes everything after /wallet/ as the wallet name.
    url.pathname = `${base}wallet/${encodeURIComponent(wallet)}`
  }
  return { url, loopback }
}

/**
 * What every TLS handshake trusts and checks, built once at construction: the
 * PEM text and the passphrase are not kept.
 */
export interface TlsSettings {
  /** The CA certificates and the client certificate; undefined for Node's defaults (the system's CAs, none). */
  readonly secureContext: SecureContext | undefined
  /** The name checked against the certificate and sent in SNI, instead of the URL's host. */
  readonly servername: string | undefined
  /** Base64 SHA-256 digests of the SubjectPublicKeyInfo the certificate may carry; undefined for no pin. */
  readonly pins: ReadonlySet<string> | undefined
  /** For `toJSON()`: what is set, with no key material. */
  readonly summary: Readonly<Record<string, unknown>>
}

const TLS_KEYS = keysOf<RpcTlsOptions>({
  ca: true,
  cert: true,
  key: true,
  passphrase: true,
  servername: true,
  pinSha256: true,
})
/** The keys of every member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never
const AUTH_KEYS = keysOf<Record<KeysOfUnion<RpcAuth>, unknown>>({ username: true, password: true, cookieFile: true })

/** The `tls` option, checked against an endpoint. Every message names the option, never its contents. */
export function parseTls(value: unknown, endpoint: Endpoint): TlsSettings | undefined {
  if (value === undefined) return undefined
  if (endpoint.url.protocol !== 'https:') throw new TypeError('tls needs an https url')
  if (typeof value === 'object' && value !== null && 'rejectUnauthorized' in value) {
    throw new TypeError(
      'tls.rejectUnauthorized is not an option: the node’s certificate is always verified; trust its CA with tls.ca'
    )
  }
  const options = argOptions(value, 'tls', TLS_KEYS)
  const ca = options['ca'] === undefined ? undefined : caList(options['ca'])
  const cert = options['cert'] === undefined ? undefined : certificates(options['cert'], 'tls.cert')
  const { key, passphrase } = options
  if ((cert === undefined) !== (key === undefined)) throw new TypeError('tls.cert and tls.key go together')
  if (passphrase !== undefined && (typeof passphrase !== 'string' || key === undefined)) {
    throw new TypeError('tls.passphrase must be a string, with tls.key')
  }
  if (key !== undefined) privateKey(key, passphrase as string | undefined)
  let secureContext: SecureContext | undefined
  if (ca !== undefined || cert !== undefined) {
    try {
      // No prototype: Node reads every option it knows from this object, `ca` among them.
      secureContext = createSecureContext(
        Object.assign(Object.create(null) as SecureContextOptions, {
          ...(ca === undefined ? {} : { ca }),
          ...(cert === undefined ? {} : { cert, key: key as string | Buffer }),
          ...(passphrase === undefined ? {} : { passphrase: passphrase as string }),
        })
      )
    } catch (error) {
      const code = codeOf(error)
      throw new TypeError(
        code === 'ERR_OSSL_X509_KEY_VALUES_MISMATCH'
          ? 'tls.key is not the key of tls.cert'
          : `tls.ca, tls.cert or tls.key was refused by TLS${code === undefined ? '' : ` (${code})`}`
      )
    }
  }
  const servername = options['servername'] === undefined ? undefined : hostName(options['servername'])
  const pins = options['pinSha256'] === undefined ? undefined : pinSet(options['pinSha256'])
  return {
    secureContext,
    servername,
    pins,
    summary: {
      ca: ca === undefined ? 'system' : 'custom',
      clientCertificate: cert !== undefined,
      ...(servername === undefined ? {} : { servername }),
      ...(pins === undefined ? {} : { pinSha256: [...pins] }),
    },
  }
}

/** The PEM text of `value`, a string or Buffer. */
function pemText(value: unknown, name: string): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('latin1')
  throw new TypeError(`${name} must be PEM text, a string or Buffer`)
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[^-]*-----END CERTIFICATE-----/g

/** PEM text with at least one certificate, each of which parses; text between them is allowed, as in CA bundles. */
function certificates(value: unknown, name: string): string {
  const text = pemText(value, name)
  const blocks = text.match(PEM_CERTIFICATE) ?? []
  if (blocks.length === 0) throw new TypeError(`${name} must hold at least one PEM certificate`)
  blocks.forEach((block, index) => {
    try {
      new X509Certificate(block)
    } catch {
      throw new TypeError(`${name} holds a PEM certificate that does not parse (number ${index + 1})`)
    }
  })
  return text
}

function caList(value: unknown): string[] {
  if (!Array.isArray(value)) return [certificates(value, 'tls.ca')]
  if (value.length === 0) throw new TypeError('tls.ca must not be an empty array: leave it out for the system’s CAs')
  return ownElements(value, 'tls.ca').map((item, index) => certificates(item, `tls.ca[${index}]`))
}

/** An encrypted PEM key: PKCS #8, or the traditional form with a Proc-Type header. */
const ENCRYPTED_KEY = /-----BEGIN ENCRYPTED PRIVATE KEY-----|^Proc-Type: 4,ENCRYPTED$/m

/** Checks that `key` is a PEM private key that `passphrase`, if any, decrypts. */
function privateKey(key: unknown, passphrase: string | undefined): void {
  if (passphrase === undefined && ENCRYPTED_KEY.test(pemText(key, 'tls.key'))) {
    throw new TypeError('tls.key is encrypted: give its tls.passphrase')
  }
  try {
    createPrivateKey({
      key: key as string | Buffer,
      format: 'pem',
      ...(passphrase === undefined ? {} : { passphrase }),
    })
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ERR_OSSL_BAD_DECRYPT') throw new TypeError('tls.passphrase does not decrypt tls.key')
    // A wrong passphrase passes OpenSSL's padding check now and then (about 1 in 256), and what it
    // decrypts to then fails to parse, with another code: for an encrypted key, say so either way.
    if (passphrase !== undefined && ENCRYPTED_KEY.test(pemText(key, 'tls.key'))) {
      throw new TypeError(
        `tls.passphrase does not decrypt tls.key, or tls.key is damaged${code === undefined ? '' : ` (${code})`}`
      )
    }
    throw new TypeError(`tls.key must be a PEM private key${code === undefined ? '' : ` (${code})`}`)
  }
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/** A DNS host name: SNI carries no addresses, and a certificate's names are compared ignoring case. */
function hostName(value: unknown): string {
  const name = typeof value === 'string' ? value.toLowerCase() : undefined
  if (name === undefined || !HOST_NAME.test(name) || isIP(name) !== 0) {
    throw new TypeError('tls.servername must be a DNS host name, not an address')
  }
  return name
}

/** One pin, or a non-empty array: each the canonical base64 of 32 bytes. */
function pinSet(value: unknown): ReadonlySet<string> {
  if (typeof value !== 'string' && (!Array.isArray(value) || value.length === 0)) {
    throw new TypeError('tls.pinSha256 must be a pin or a non-empty array of pins')
  }
  const pins = typeof value === 'string' ? [value] : ownElements(value as unknown[], 'tls.pinSha256')
  pins.forEach((pin, index) => {
    if (
      typeof pin !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(pin) ||
      Buffer.from(pin, 'base64').toString('base64') !== pin
    ) {
      throw new TypeError(
        `tls.pinSha256${typeof value === 'string' ? '' : `[${index}]`} must be the base64 SHA-256 of a SubjectPublicKeyInfo: 44 characters, the last one =`
      )
    }
  })
  return new Set(pins as string[])
}

/** The `connect` option: an https endpoint only, since the client cannot see where the function connects. */
export function parseConnect(value: unknown, endpoint: Endpoint): RpcConnect | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'function') throw new TypeError('connect must be a function')
  if (endpoint.url.protocol !== 'https:') {
    throw new TypeError(
      'connect needs an https url: the client cannot see where it connects to, so only TLS protects the credentials'
    )
  }
  return value as RpcConnect
}

/** An error's `code` when it is a string, such as Node's and OpenSSL's. */
export function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

const CONTROL = /[\u0000-\u001f\u007f]/

/** Holds the credentials in private fields, out of reach of inspection and serialization. */
export class Credentials {
  readonly kind: 'basic' | 'cookie'
  readonly #header: string | undefined
  readonly #cookieFile: string | undefined

  constructor(auth: unknown, endpoint: Endpoint) {
    if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) {
      throw new TypeError('auth must be { username, password } or { cookieFile }')
    }
    // Own properties only: a password on a polluted Object.prototype must not fill a missing one.
    const record = argOptions(auth, 'auth', AUTH_KEYS)
    const hasBasic = 'username' in record || 'password' in record
    const hasCookie = 'cookieFile' in record
    if (hasBasic === hasCookie) throw new TypeError('auth must be { username, password } or { cookieFile }')
    if (hasBasic) {
      const { username, password } = record
      if (typeof username !== 'string' || username === '' || username.includes(':') || CONTROL.test(username)) {
        throw new TypeError('auth.username must be a non-empty string without ":" or control characters')
      }
      if (typeof password !== 'string' || password === '' || CONTROL.test(password)) {
        throw new TypeError('auth.password must be a non-empty string without control characters')
      }
      this.kind = 'basic'
      this.#header = basic(username, password)
    } else {
      const { cookieFile } = record
      if (typeof cookieFile !== 'string' || cookieFile === '') throw new TypeError('auth.cookieFile must be a path')
      if (!endpoint.loopback) {
        throw new TypeError('cookie authentication is only allowed for a loopback endpoint')
      }
      this.kind = 'cookie'
      this.#cookieFile = cookieFile
    }
  }

  /**
   * The Authorization header value. A cookie is read from disk on every call.
   * Throws a {@link CookieReadFailure} carrying only an error code.
   */
  async header(signal: AbortSignal): Promise<string> {
    if (this.#header !== undefined) return this.#header
    return basic(...(await readCookie(this.#cookieFile!, signal)))
  }
}

/** Reading or parsing the cookie failed. Carries a code only, never file contents. */
export class CookieReadFailure extends Error {
  readonly code: string

  constructor(code: string) {
    super(`cookie read failed (${code})`)
    this.code = code
  }
}

const MAX_COOKIE_BYTES = 1024

async function readCookie(path: string, signal: AbortSignal): Promise<[string, string]> {
  signal.throwIfAborted()
  let text: string
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(MAX_COOKIE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_COOKIE_BYTES) throw new CookieReadFailure('ETOOBIG')
    text = buffer.subarray(0, bytesRead).toString('utf8')
  } catch (error) {
    if (error instanceof CookieReadFailure) throw error
    throw new CookieReadFailure(codeOf(error) ?? 'EREAD')
  } finally {
    await handle?.close()
  }
  signal.throwIfAborted()
  const trimmed = text.replace(/\r?\n$/, '')
  const separator = trimmed.indexOf(':')
  const user = trimmed.slice(0, separator)
  const password = trimmed.slice(separator + 1)
  if (separator <= 0 || password === '' || CONTROL.test(trimmed)) throw new CookieReadFailure('EMALFORMED')
  return [user, password]
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
}
