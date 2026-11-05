import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto'
import { isIP } from 'node:net'

/**
 * X.509 certificates for the TLS tests, made at test time with Node's crypto:
 * Node can sign but not build a certificate, so this writes the DER itself,
 * the few fields TLS needs. ECDSA P-256 keys, SHA-256 signatures, version 3,
 * basicConstraints and, for a leaf, subjectAltName. No openssl, no key in the
 * repository.
 */

/** A certificate and its key, as PEM, and the base64 SHA-256 of its SubjectPublicKeyInfo: its pin. */
export interface Issued {
  readonly cert: string
  readonly key: string
  readonly privateKey: KeyObject
  readonly pin: string
  readonly name: string
}

export interface IssueOptions {
  /** The subject's common name, or its organization when `subject` says so. */
  readonly name: string
  /** What the subject holds `name` as: its common name (the default), or its organization, with no common name. */
  readonly subject?: 'commonName' | 'organization'
  /** The CA that signs it; none for a self-signed CA. */
  readonly issuer?: Issued
  readonly ca?: boolean
  /** DNS names and IP addresses for subjectAltName. */
  readonly altNames?: readonly string[]
  /** Validity, from now: default one hour ago to one day ahead. */
  readonly notBefore?: Date
  readonly notAfter?: Date
  /** Reuse a key, to issue a certificate for the same key again. */
  readonly keyOf?: Issued
}

export function issue(options: IssueOptions): Issued {
  const pair =
    options.keyOf === undefined
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : { privateKey: options.keyOf.privateKey }
  const { privateKey } = pair
  const publicKey = 'publicKey' in pair ? pair.publicKey : undefined
  const spki = (publicKey ?? new X509Certificate(options.keyOf!.cert).publicKey).export({ type: 'spki', format: 'der' })
  const now = Date.now()
  const notBefore = options.notBefore ?? new Date(now - 3_600_000)
  const notAfter = options.notAfter ?? new Date(now + 86_400_000)
  const extensions = [extension('2.5.29.19', true, options.ca === true ? seq(bool(true)) : seq())]
  if (options.altNames !== undefined && options.altNames.length > 0) {
    extensions.push(extension('2.5.29.17', false, seq(...options.altNames.map(altName))))
  }
  const tbs = seq(
    der(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    ECDSA_WITH_SHA256,
    options.issuer === undefined ? name(options.name, options.subject) : name(options.issuer.name),
    seq(time(notBefore), time(notAfter)),
    name(options.name, options.subject),
    spki,
    der(0xa3, seq(...extensions))
  )
  const signature = sign('sha256', tbs, options.issuer?.privateKey ?? privateKey)
  const certificate = seq(tbs, ECDSA_WITH_SHA256, bitString(signature))
  return {
    cert: pem('CERTIFICATE', certificate),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    privateKey,
    pin: createHash('sha256').update(spki).digest('base64'),
    name: options.name,
  }
}

/** The key of `issued`, encrypted with `passphrase`. */
export function encryptedKey(issued: Issued, passphrase: string): string {
  return issued.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }).toString()
}

/**
 * A CA named after `label`, a server certificate it signs for `localhost`,
 * `node.test`, 127.0.0.1 and ::1, and a client certificate.
 */
export function testPki(label = 'qbit-rpc test'): {
  readonly ca: Issued
  readonly server: Issued
  readonly client: Issued
} {
  const ca = issue({ name: `${label} CA`, ca: true })
  return {
    ca,
    server: issue({ name: 'node.test', issuer: ca, altNames: ['localhost', 'node.test', '127.0.0.1', '::1'] }),
    client: issue({ name: `${label} client`, issuer: ca }),
  }
}

const ECDSA_WITH_SHA256 = seq(oid('1.2.840.10045.4.3.2'))

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function seq(...parts: Buffer[]): Buffer {
  return der(0x30, ...parts)
}

function bool(value: boolean): Buffer {
  return der(0x01, Buffer.from([value ? 0xff : 0]))
}

/** A non-negative INTEGER from big-endian bytes, in its shortest DER form. */
function integer(bytes: Buffer): Buffer {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0 && bytes[start + 1]! < 0x80) start += 1
  const trimmed = bytes.subarray(start)
  return der(0x02, trimmed[0]! >= 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number)
  const bytes = [first! * 40 + second!]
  for (const arc of rest) {
    const chunk = [arc & 0x7f]
    for (let value = arc >> 7; value > 0; value >>= 7) chunk.unshift(0x80 | (value & 0x7f))
    bytes.push(...chunk)
  }
  return der(0x06, Buffer.from(bytes))
}

function bitString(bytes: Buffer): Buffer {
  return der(0x03, Buffer.from([0]), bytes)
}

/** UTCTime up to 2049, GeneralizedTime after, as RFC 5280 requires. */
function time(date: Date): Buffer {
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(`${digits.slice(2)}Z`))
    : der(0x18, Buffer.from(`${digits}Z`))
}

function name(value: string, attribute: IssueOptions['subject'] = 'commonName'): Buffer {
  const type = attribute === 'commonName' ? '2.5.4.3' : '2.5.4.10'
  return seq(der(0x31, seq(oid(type), der(0x0c, Buffer.from(value, 'utf8')))))
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), der(0x04, value))
}

/** A dNSName, or an iPAddress for an IPv4 or IPv6 address. */
function altName(value: string): Buffer {
  const family = isIP(value)
  if (family === 0) return der(0x82, Buffer.from(value, 'ascii'))
  if (family === 4) return der(0x87, Buffer.from(value.split('.').map(Number)))
  const [head = '', tail = ''] = value.split('::')
  const groups = (part: string): number[] => (part === '' ? [] : part.split(':').map(group => parseInt(group, 16)))
  const left = groups(head)
  const right = groups(tail)
  const all = value.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left
  return der(0x87, Buffer.from(all.flatMap(group => [group >> 8, group & 0xff])))
}

function pem(label: string, body: Buffer): string {
  const lines = body.toString('base64').match(/.{1,64}/g)!
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}
