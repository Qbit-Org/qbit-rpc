import { open } from 'node:fs/promises'
import { isIP } from 'node:net'

import { argOptions, keysOf } from './own'

/**
 * How the client authenticates. Exactly one form:
 *
 * - `{ username, password }`: HTTP Basic credentials (`rpcuser`/`rpcpassword`
 *   or an `rpcauth` entry). Sent over HTTPS, or over HTTP to a loopback host.
 * - `{ cookieFile }`: qbitd's `.cookie` file. Only for a loopback endpoint;
 *   the file is read again for every request, so qbitd can restart and
 *   rotate it without restarting your service.
 */
export type RpcAuth = { readonly username: string; readonly password: string } | { readonly cookieFile: string }

/** The keys of every member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never
const AUTH_KEYS = keysOf<Record<KeysOfUnion<RpcAuth>, unknown>>({ username: true, password: true, cookieFile: true })

export interface Endpoint {
  readonly url: URL
  readonly loopback: boolean
}

/** Whether a URL hostname names this machine: `localhost`, 127.0.0.0/8 or `::1`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1') return true
  return isIP(host) === 4 && host.startsWith('127.')
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
  const loopback = isLoopbackHost(url.hostname)
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

// eslint-disable-next-line no-control-regex
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
    const code = (error as { code?: unknown }).code
    throw new CookieReadFailure(typeof code === 'string' ? code : 'EREAD')
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
