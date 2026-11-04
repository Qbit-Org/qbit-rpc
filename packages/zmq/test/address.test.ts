import { lookup } from 'node:dns/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'
import { Publisher, Subscriber } from 'zeromq'

import { QbitZmqSubscriber } from '../src'

// Each address form is checked three ways: the constructor, libzmq's own
// connect() on a real zeromq 6.5.0 Subscriber, and whether a subscriber on it
// receives from a publisher. `{P}` stands for the publisher's port, and
// `{DIR}` for a temporary directory holding its ipc socket.

const HASH = Buffer.alloc(32, 0x12)
const hashblock = (): Buffer[] => [Buffer.from('hashblock'), HASH, Buffer.from([1, 0, 0, 0])]
const linuxLoopback = process.platform === 'linux' && networkInterfaces()['lo'] !== undefined
const dir = mkdtempSync(join(tmpdir(), 'qbit-zmq-address-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const fill = (url: string, port = 28332): string =>
  url
    .replaceAll('{P+65536}', String(port + 65536))
    .replaceAll('{P}', String(port))
    .replaceAll('{DIR}', dir)

const V4 = 'tcp://127.0.0.1:0'
const V6 = 'tcp://[::1]:0'

interface Accepted {
  readonly url: string
  /** Where a test publisher binds, to show the form receives; omitted for forms that need a real network. */
  readonly bind?: string
}

const ACCEPTED: readonly Accepted[] = [
  { url: 'tcp://127.0.0.1:{P}', bind: V4 },
  { url: 'tcp://localhost:{P}', bind: V4 },
  { url: 'tcp://127.1:{P}', bind: V4 }, // the resolver's shorthand for 127.0.0.1
  { url: 'tcp://127.0.0.1:0{P}', bind: V4 }, // a leading zero is still decimal
  { url: 'tcp://[::1]:{P}', bind: V6 },
  { url: 'tcp://[::ffff:127.0.0.1]:{P}', bind: V4 },
  { url: 'tcp://[127.0.0.1]:{P}', bind: V4 }, // libzmq strips the brackets
  { url: 'tcp://[localhost]:{P}', bind: V4 },
  { url: 'tcp://127.0.0.1:0;127.0.0.1:{P}', bind: V4 }, // libzmq's source;destination form
  { url: 'tcp://127.0.0.1:*;localhost:{P}', bind: V4 },
  { url: 'tcp://0.0.0.0:0;127.0.0.1:{P}', bind: V4 },
  { url: 'tcp://[::1]:0;[::1]:{P}', bind: V6 },
  ...(linuxLoopback
    ? [
        { url: 'tcp://lo:0;127.0.0.1:{P}', bind: V4 }, // an interface name as the source
        { url: 'tcp://[::1%lo]:{P}', bind: V6 }, // an IPv6 zone
      ]
    : []),
  { url: 'ipc://{DIR}/pub.sock', bind: 'ipc://{DIR}/pub.sock' },
  { url: 'ipc://{DIR}/with space.sock', bind: 'ipc://{DIR}/with space.sock' },
  ...(process.platform === 'linux'
    ? [{ url: `ipc://@qbit-zmq-test-${process.pid}`, bind: `ipc://@qbit-zmq-test-${process.pid}` }] // abstract namespace
    : []),
  { url: 'tcp://qbit-node.internal:28332' },
  { url: 'tcp://qbit_node:28332' }, // underscores, as in container names
  { url: 'tcp://node.example.com.:28332' },
  { url: 'tcp://10.0.0.7:1' },
  { url: 'tcp://10.0.0.7:65535' },
  { url: 'tcp://[2001:db8::7]:28332' },
  { url: 'tcp://[fe80::1%eth0]:28332' },
  { url: 'ipc:///run/qbitd/zmq.sock' },
  { url: 'ipc://qbitd.sock' },
]

/** What libzmq does with a rejected form: its connect() throws, or it never receives, or it receives from a port other than the one written. */
type Libzmq = 'EINVAL' | 'EPROTONOSUPPORT' | 'ENOCOMPATPROTO' | 'never receives' | 'receives from {P}'

interface Rejected {
  readonly url: string
  readonly problem: RegExp
  readonly libzmq: Libzmq
  readonly bind?: string
  /** Enable IPv6 on the libzmq socket. */
  readonly ipv6?: boolean
}

const REJECTED: readonly Rejected[] = [
  // The issue's three: each yielded `reconnect` with EINVAL, forever.
  { url: 'tcp://127.0.0.1', problem: /has no port in its address/, libzmq: 'EINVAL' },
  { url: 'tcp://127.0.0.1:notaport', problem: /has port notaport in its address: use a decimal/, libzmq: 'EINVAL' },
  { url: 'tcp://*:28332', problem: /has host \*, which binds/, libzmq: 'EINVAL' },
  { url: 'tcp://127.0.0.1:', problem: /has no port in its address/, libzmq: 'EINVAL' },
  { url: 'tcp://127.0.0.1:*', problem: /has port \* in its address/, libzmq: 'EINVAL' },
  { url: 'tcp://127.0.0.1:-1', problem: /has port -1/, libzmq: 'EINVAL' },
  { url: 'tcp://-qbit:28332', problem: /has -qbit in its address, not a host name/, libzmq: 'EINVAL' },
  { url: 'tcp://qbit node:28332', problem: /not a host name/, libzmq: 'EINVAL' },
  { url: 'tcp://user@qbit:28332', problem: /not a host name/, libzmq: 'EINVAL' },
  { url: 'tcp://127.0.0.1:28332/', problem: /has port 28332\//, libzmq: 'EINVAL' },
  { url: 'tcp://127.0.0.1:28332 ', problem: /has port 28332 /, libzmq: 'EINVAL' },
  { url: 'tcp://*:0;127.0.0.1:28332', problem: /source host \*: use 0\.0\.0\.0/, libzmq: 'EINVAL' },
  { url: 'ipc://', problem: /has no path/, libzmq: 'EINVAL' },
  { url: 'ipc://@', problem: /names no abstract socket/, libzmq: 'EINVAL' },
  { url: 'TCP://127.0.0.1:28332', problem: /must start with tcp:\/\/ or ipc:\/\//, libzmq: 'EPROTONOSUPPORT' },
  { url: ' tcp://127.0.0.1:28332', problem: /must start with/, libzmq: 'EPROTONOSUPPORT' },
  { url: 'http://127.0.0.1:28332', problem: /must start with/, libzmq: 'EPROTONOSUPPORT' },
  { url: 'udp://127.0.0.1:28332', problem: /must start with/, libzmq: 'ENOCOMPATPROTO' },
  // libzmq's connect() accepts these, then never connects: it only resolves
  // when it opens the connection, and retries silently.
  {
    url: 'tcp://127.0.0.1:0',
    problem: /has port 0 in its address: use a decimal number from 1 to 65535/,
    libzmq: 'never receives',
    bind: V4,
  },
  { url: 'tcp://127.0.0.1:65536', problem: /has port 65536/, libzmq: 'never receives', bind: V4 }, // 16 bits: port 0
  { url: 'tcp://:{P}', problem: /has no host in its address/, libzmq: 'never receives', bind: V4 },
  { url: 'tcp://qbit..node:{P}', problem: /not a host name/, libzmq: 'never receives', bind: V4 },
  {
    url: 'tcp://300.0.0.1:{P}',
    problem: /not an IPv4 address: each part must be 0 to 255/,
    libzmq: 'never receives',
    bind: V4,
  },
  { url: 'tcp://[::1:{P}', problem: /has no \] after \[/, libzmq: 'never receives', bind: V6, ipv6: true },
  { url: 'tcp://[]:{P}', problem: /has no host/, libzmq: 'never receives', bind: V4 },
  {
    url: 'tcp://[::1]',
    problem: /has no port in its address: add one/,
    libzmq: 'never receives',
    bind: V6,
    ipv6: true,
  },
  { url: 'tcp://[::1]x:{P}', problem: /has x:\d+ after \]/, libzmq: 'never receives', bind: V6, ipv6: true },
  {
    url: 'tcp://[::g]:{P}',
    problem: /has \[::g\] in its address, not an IPv6 address/,
    libzmq: 'never receives',
    bind: V6,
    ipv6: true,
  },
  { url: 'tcp://127.0.0.1:{P}:{P}', problem: /not a host name/, libzmq: 'never receives', bind: V4 },
  {
    url: 'tcp://127.0.0.1;127.0.0.1:{P}',
    problem: /has no port in its source address/,
    libzmq: 'never receives',
    bind: V4,
  },
  { url: 'tcp://127.0.0.1:0;;127.0.0.1:{P}', problem: /source address/, libzmq: 'never receives', bind: V4 },
  {
    url: 'ipc://{DIR}/never.sock\n',
    problem: /control character/,
    libzmq: 'never receives',
    bind: 'ipc://{DIR}/never.sock',
  },
  // libzmq reads the port with atoi() into 16 bits, and connects somewhere
  // the url does not say.
  { url: 'tcp://127.0.0.1:{P+65536}', problem: /has port \d+ in its address/, libzmq: 'receives from {P}', bind: V4 },
  { url: 'tcp://127.0.0.1:{P}abc', problem: /has port \d+abc/, libzmq: 'receives from {P}', bind: V4 },
  { url: 'tcp://127.0.0.1:{P}.5', problem: /has port \d+\.5/, libzmq: 'receives from {P}', bind: V4 },
  // libzmq takes the last colon as the port's, but an unbracketed IPv6
  // address reads either way: tcp://2001:db8::1:5 might mean port 5.
  { url: 'tcp://::1:{P}', problem: /IPv6 address without brackets/, libzmq: 'receives from {P}', bind: V6, ipv6: true },
  { url: 'tcp://::1', problem: /IPv6 address without brackets/, libzmq: 'never receives', bind: V6, ipv6: true },
]

interface Reader {
  /** Whether a message arrived before `close()`. */
  readonly received: Promise<boolean>
  close(): void
}

function viaSubscriber(url: string): Reader {
  const subscriber = new QbitZmqSubscriber({ url, topics: ['hashblock'], reconnectDelayMs: 50 })
  const received = subscriber[Symbol.asyncIterator]()
    .next()
    .then(next => !next.done && next.value.kind === 'message')
  return { received, close: () => subscriber.close() }
}

function viaLibzmq(url: string, ipv6: boolean): Reader {
  const socket = new Subscriber()
  socket.ipv6 = ipv6
  socket.connect(url)
  socket.subscribe('')
  const received = socket.receive().then(
    () => true,
    () => false
  )
  return { received, close: () => socket.close() }
}

/** Binds a publisher at `bind`, reads `url` with `read`, and publishes until a message arrives or `ms` pass. */
async function receives(bind: string, url: string, read: (url: string) => Reader, ms = 1500): Promise<boolean> {
  const publisher = new Publisher()
  publisher.ipv6 = bind.startsWith('tcp://[')
  await publisher.bind(fill(bind))
  const port = bind.startsWith('tcp:')
    ? Number(publisher.lastEndpoint!.slice(publisher.lastEndpoint!.lastIndexOf(':') + 1))
    : 0
  const reader = read(fill(url, port))
  let done = false
  const received = reader.received.finally(() => {
    done = true
  })
  try {
    for (const deadline = Date.now() + ms; !done && Date.now() < deadline;) {
      await publisher.send(hashblock())
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  } finally {
    reader.close()
    publisher.close()
  }
  return received
}

describe('subscriber addresses', () => {
  it("rejects the issue's three addresses in the constructor", () => {
    const options = { topics: ['hashblock'] as const }
    expect(() => new QbitZmqSubscriber({ ...options, url: 'tcp://127.0.0.1' })).toThrow(
      new TypeError(
        'url "tcp://127.0.0.1" has no port in its address: use <host>:<port>, for example tcp://127.0.0.1:28332'
      )
    )
    expect(() => new QbitZmqSubscriber({ ...options, url: 'tcp://127.0.0.1:notaport' })).toThrow(
      new TypeError(
        'url "tcp://127.0.0.1:notaport" has port notaport in its address: use a decimal number from 1 to 65535'
      )
    )
    expect(() => new QbitZmqSubscriber({ ...options, url: 'tcp://*:28332' })).toThrow(
      new TypeError(
        'url "tcp://*:28332" has host *, which binds: connect to the publisher, for example tcp://127.0.0.1:28332'
      )
    )
    for (const url of [undefined, 28332, null, { href: 'tcp://127.0.0.1:28332' }]) {
      expect(() => new QbitZmqSubscriber({ ...options, url: url as never })).toThrow(
        new TypeError('url must be a tcp:// or ipc:// ZeroMQ address string')
      )
    }
  })

  it.each(ACCEPTED.map(form => form.url))('accepts %j, and so does libzmq', url => {
    expect(() => new QbitZmqSubscriber({ url: fill(url), topics: ['hashblock'] })).not.toThrow()
    const socket = new Subscriber()
    try {
      expect(() => socket.connect(fill(url))).not.toThrow()
    } finally {
      socket.close()
    }
  })

  it.each(REJECTED.map(form => [form.url, form] as const))('rejects %j', (url, { problem, libzmq }) => {
    expect(() => new QbitZmqSubscriber({ url: fill(url), topics: ['hashblock'] })).toThrow(problem)
    expect(() => new QbitZmqSubscriber({ url: fill(url), topics: ['hashblock'] })).toThrow(TypeError)
    const socket = new Subscriber()
    try {
      if (libzmq === 'never receives' || libzmq === 'receives from {P}') {
        expect(() => socket.connect(fill(url))).not.toThrow()
      } else {
        expect(() => socket.connect(fill(url))).toThrow(expect.objectContaining({ code: libzmq }))
      }
    } finally {
      socket.close()
    }
  })

  it('receives on each accepted form, with IPv6 enabled only for an IPv6 address', async () => {
    const forms = ACCEPTED.filter(form => form.bind !== undefined)
    const results = await Promise.all(forms.map(form => receives(form.bind!, form.url, viaSubscriber, 3000)))
    expect(Object.fromEntries(forms.map((form, i) => [form.url, results[i]]))).toEqual(
      Object.fromEntries(forms.map(form => [form.url, true]))
    )
  }, 10_000)

  it('pins what libzmq does with each rejected form it accepts', async () => {
    const forms = REJECTED.filter(form => form.bind !== undefined)
    const results = await Promise.all(
      forms.map(form => receives(form.bind!, form.url, url => viaLibzmq(url, form.ipv6 === true)))
    )
    expect(
      Object.fromEntries(forms.map((form, i) => [form.url, results[i] ? 'receives from {P}' : 'never receives']))
    ).toEqual(Object.fromEntries(forms.map(form => [form.url, form.libzmq])))
  })

  it('needs IPv6 enabled for an IPv6 address, and off for localhost to reach 127.0.0.1', async () => {
    expect(await receives(V6, 'tcp://[::1]:{P}', url => viaLibzmq(url, false))).toBe(false)
    // With IPv6 enabled, libzmq resolves localhost to ::1 when the hosts file lists it.
    if ((await lookup('localhost', { family: 6 }).catch(() => undefined))?.address === '::1') {
      expect(await receives(V4, 'tcp://localhost:{P}', url => viaLibzmq(url, true))).toBe(false)
    }
  })
})
