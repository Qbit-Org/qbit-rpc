import { createCipheriv, createHmac } from 'node:crypto'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from 'node:tls'

/** TLS alert descriptions (RFC 8446, section 6). */
export const ALERT = { handshakeFailure: 40, badCertificate: 42, unknownCa: 48 } as const

const HANDSHAKE = 22
const APPLICATION_DATA = 23
const ALERT_RECORD = 21

/** HKDF-Expand-Label of TLS 1.3 (RFC 8446, section 7.1) with SHA-256 and no context, for up to 32 bytes. */
function expandLabel(secret: Buffer, label: string, length: number): Buffer {
  const full = Buffer.from(`tls13 ${label}`)
  const info = Buffer.concat([Buffer.from([0, length, full.length]), full, Buffer.from([0, 1])])
  return createHmac('sha256', secret).update(info).digest().subarray(0, length)
}

/** A fatal alert as the server's first record under its application traffic secret, with TLS_AES_128_GCM_SHA256. */
function alertRecord(secret: Buffer, description: number): Buffer {
  const key = expandLabel(secret, 'key', 16)
  // The nonce is the IV XORed with the record's sequence number, 0 here.
  const iv = expandLabel(secret, 'iv', 12)
  const header = Buffer.from([APPLICATION_DATA, 3, 3, 0, 3 + 16])
  const cipher = createCipheriv('aes-128-gcm', key, iv).setAAD(header)
  const sealed = Buffer.concat([cipher.update(Buffer.from([2, description, ALERT_RECORD])), cipher.final()])
  return Buffer.concat([header, sealed, cipher.getAuthTag()])
}

/**
 * A TLS 1.3 terminator that refuses the client's certificate with an alert
 * once the client has finished its side of the handshake, as an OpenSSL
 * terminator such as nginx or HAProxy does. Node's own TLS server cannot: it
 * checks a client certificate after the handshake and drops the connection.
 *
 * A Node TLS server runs the handshake behind a relay. When the client's
 * second flight arrives (its certificate and Finished), the relay forwards
 * nothing more either way and answers with the alert, sealed with the
 * server's application traffic secret from the server's keylog. Nothing the
 * client sends after its ClientHello reaches a server: `requests` stays 0.
 */
export class RefusingTerminator {
  /** Client connections accepted. */
  connections = 0
  readonly #relay: Server
  readonly #tls: TlsServer
  readonly #sockets = new Set<Socket>()
  /** The server's application traffic secret, by the relay's port on the server's connection. */
  readonly #secrets = new Map<number, Buffer>()

  private constructor(relay: Server, server: TlsServer, description: number) {
    this.#relay = relay
    this.#tls = server
    server.on('keylog', (line: Buffer, socket: TLSSocket) => {
      const [label, , secret] = line.toString('latin1').trim().split(' ')
      if (label === 'SERVER_TRAFFIC_SECRET_0' && secret !== undefined && socket.remotePort !== undefined) {
        this.#secrets.set(socket.remotePort, Buffer.from(secret, 'hex'))
      }
    })
    server.on('tlsClientError', () => {})
    relay.on('connection', (client: Socket) => {
      this.connections += 1
      const upstream = connect((server.address() as AddressInfo).port, '127.0.0.1')
      for (const socket of [client, upstream]) {
        this.#sockets.add(socket)
        socket.on('error', () => {})
        socket.on('close', () => this.#sockets.delete(socket))
      }
      let refused = false
      let pending = Buffer.alloc(0)
      /** The ClientHello went through. */
      let hello = false
      upstream.on('data', (chunk: Buffer) => {
        if (!refused) client.write(chunk)
      })
      client.on('data', (chunk: Buffer) => {
        if (refused) return
        pending = Buffer.concat([pending, chunk])
        // Forward the ClientHello; the next record is the client's second flight.
        while (pending.length >= 5) {
          const length = pending.readUInt16BE(3)
          if (pending.length < 5 + length) return
          const record = pending.subarray(0, 5 + length)
          pending = pending.subarray(5 + length)
          if (!hello) {
            hello = record[0] === HANDSHAKE
            upstream.write(record)
            continue
          }
          refused = true
          const secret = this.#secrets.get(upstream.localPort!)
          upstream.destroy()
          if (secret === undefined) {
            client.destroy()
            return
          }
          client.end(alertRecord(secret, description))
          return
        }
      })
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => {
        if (!refused) client.destroy()
      })
    })
  }

  /** `key` and `cert` are the server's; `description` is the alert it refuses with. */
  static async start(options: {
    readonly key: string
    readonly cert: string
    readonly description: number
  }): Promise<RefusingTerminator> {
    const server = createTlsServer({
      key: options.key,
      cert: options.cert,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ciphers: 'TLS_AES_128_GCM_SHA256',
    })
    const relay = createServer()
    await Promise.all(
      [server, relay].map(listening => new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve)))
    )
    return new RefusingTerminator(relay, server, options.description)
  }

  get port(): number {
    return (this.#relay.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy()
    await Promise.all(
      [this.#relay, this.#tls].map(server => new Promise<void>(resolve => server.close(() => resolve())))
    )
  }
}
