import { isIPv6 } from 'node:net'

// What libzmq's connect() can reach a publisher at, checked against zeromq
// 6.5.0 and 6.8.0 (both libzmq 4.3.5). libzmq itself only checks the characters and that the
// text after the last ':' starts with a digit, then resolves when it opens the
// connection, retrying silently: an address it cannot resolve never connects
// and never fails. It also reads the port with atoi() into 16 bits, so it
// connects `:28332abc` to 28332 and `:93868` to 28332; those are refused here.

/** Letters, digits, `-` and `_`, in dot-separated labels; libzmq wants a letter or digit first. */
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.?$/
/** An IPv6 address, with an optional zone (`%eth0`, `%2`), in the characters libzmq allows. */
const IPV6_CHARS = /^[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_.-]+)?$/
const DECIMAL = /^[0-9]+$/
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/
const CONTROL = /[\u0000-\u001f\u007f]/

type Fail = (problem: string) => never

/**
 * Checks a subscriber address and says whether the socket needs IPv6 enabled.
 * Accepts `tcp://<host>:<port>`, with an IPv4 address, a bracketed IPv6
 * address or a host name and a port from 1 to 65535, optionally after a
 * libzmq source address (`tcp://<source>:<port>;<host>:<port>`), and
 * `ipc://<path>`. Throws a `TypeError` naming the problem otherwise.
 */
export function checkZmqAddress(url: unknown): { readonly ipv6: boolean } {
  if (typeof url !== 'string') throw new TypeError('url must be a tcp:// or ipc:// ZeroMQ address string')
  const fail: Fail = problem => {
    throw new TypeError(`url ${JSON.stringify(url)} ${problem}`)
  }
  if (url.startsWith('ipc://')) {
    const path = url.slice('ipc://'.length)
    if (path === '') fail('has no path: use ipc://<path>, for example ipc:///run/qbitd/zmq.sock')
    if (path === '@') fail('names no abstract socket after @')
    if (CONTROL.test(path)) fail('has a control character in its path')
    return { ipv6: false }
  }
  if (!url.startsWith('tcp://')) {
    fail('must start with tcp:// or ipc://, for example tcp://127.0.0.1:28332')
  }
  const rest = url.slice('tcp://'.length)
  // libzmq takes everything before the last ';' as the local address to connect from.
  const split = rest.lastIndexOf(';')
  const destination = checkEndpoint(rest.slice(split + 1), false, fail)
  const source = split === -1 ? false : checkEndpoint(rest.slice(0, split), true, fail)
  return { ipv6: destination || source }
}

/** Checks `<host>:<port>`; returns whether the host is an IPv6 address. */
function checkEndpoint(endpoint: string, source: boolean, fail: Fail): boolean {
  const what = source ? 'source address' : 'address'
  let host: string
  let port: string
  let ipv6 = false
  if (endpoint.startsWith('[')) {
    // libzmq strips the brackets, which IPv6 needs to keep its colons apart from the port's.
    const close = endpoint.indexOf(']')
    if (close === -1) fail(`has no ] after [ in its ${what}`)
    host = endpoint.slice(1, close)
    const after = endpoint.slice(close + 1)
    if (after === '') fail(`has no port in its ${what}: add one, for example ${endpoint}:28332`)
    if (!after.startsWith(':')) fail(`has ${after} after ] in its ${what}, not :<port>`)
    port = after.slice(1)
    if (host.includes(':')) {
      if (!IPV6_CHARS.test(host) || !isIPv6(host)) fail(`has [${host}] in its ${what}, not an IPv6 address`)
      ipv6 = true
    } else {
      checkHost(host, what, fail)
    }
  } else {
    const colon = endpoint.lastIndexOf(':')
    if (colon === -1) {
      fail(`has no port in its ${what}: use <host>:<port>, for example tcp://127.0.0.1:28332`)
    }
    host = endpoint.slice(0, colon)
    port = endpoint.slice(colon + 1)
    if (isIPv6(host) || isIPv6(endpoint)) {
      fail(`has an IPv6 address without brackets in its ${what}: bracket it, as in tcp://[::1]:28332`)
    }
    checkHost(host, what, fail)
  }
  if (source && port === '*') return ipv6
  const min = source ? 0 : 1
  if (port === '' || !DECIMAL.test(port) || Number(port) < min || Number(port) > 65535) {
    fail(
      `has ${port === '' ? 'no port' : `port ${port}`} in its ${what}: use a decimal number from ${min} to 65535${source ? ', or *' : ''}`
    )
  }
  return ipv6
}

function checkHost(host: string, what: string, fail: Fail): void {
  if (host === '') fail(`has no host in its ${what}`)
  if (host === '*') {
    fail(
      what === 'address'
        ? 'has host *, which binds: connect to the publisher, for example tcp://127.0.0.1:28332'
        : 'has source host *: use 0.0.0.0 for any address'
    )
  }
  if (!HOST_NAME.test(host)) fail(`has ${host} in its ${what}, not a host name, IPv4 address or bracketed IPv6 address`)
  // A dotted quad with a decimal part over 255 is a mistyped IPv4 address, not a host
  // name, whatever its other parts are. Parts with leading zeros are not judged: the
  // resolver reads them as octal.
  const parts = host.split('.')
  if (
    parts.length === 4 &&
    parts.every(part => DECIMAL.test(part)) &&
    parts.some(part => CANONICAL_DECIMAL.test(part) && Number(part) > 255)
  ) {
    fail(`has ${host} in its ${what}, not an IPv4 address: each part must be 0 to 255`)
  }
}
