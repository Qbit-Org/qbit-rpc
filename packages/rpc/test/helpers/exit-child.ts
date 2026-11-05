// A short program for test/connect.test.ts, built and run on its own: how long
// it takes to exit is what the test measures. Run with a JSON argument: the
// node's port and CA, and the scenario.
import { connect as netConnect, type Socket } from 'node:net'

import { QbitRpcClient, type RpcConnect } from '../../src'

const { port, ca, scenario } = JSON.parse(process.argv[2]!) as {
  readonly port: number
  readonly ca: string
  readonly scenario: 'parked' | 'in handshake' | 'gave up in handshake' | 'taken'
}

const inHandshake = scenario === 'gave up in handshake'

/** A tunnel that opens 100 ms after it is asked for, past the read's deadline below, or at once, before it. */
const slowly: RpcConnect = () =>
  new Promise<Socket>((resolve, reject) => {
    setTimeout(
      () => {
        const socket = netConnect(port, '127.0.0.1', () => resolve(socket))
        socket.once('error', reject)
      },
      inHandshake ? 0 : 100
    )
  })

const rpc = new QbitRpcClient({
  url: `https://node.test:${port}/`,
  auth: { username: 'u', password: 'p' },
  expectedChain: 'regtest',
  tls: { ca },
  connect: slowly,
})

/** This process's sockets that keep it alive. */
const sockets = (): number => process.getActiveResourcesInfo().filter(type => type === 'TCPSocketWrap').length

await rpc.getBestBlockHash({ timeoutMs: inHandshake ? 100 : 20 }).catch(() => {})
if (scenario === 'parked' || scenario === 'taken') {
  await new Promise(resolve => setTimeout(resolve, 400))
  console.log(`parked: ${sockets()}`)
}
if (scenario === 'taken') {
  // The node answers slowly: the connection is in use meanwhile.
  const reading = rpc.getBestBlockHash()
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log(`in use: ${sockets()}`)
  console.log(await reading)
}
