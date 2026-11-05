# Security

`@qbit-oss/rpc` and `@qbit-oss/zmq` have not had a third-party security
review.

## Reporting a vulnerability

Do not report security vulnerabilities in public issues, pull requests or
discussions.

Report them privately through GitHub private vulnerability reporting: open
this repository's security tab on GitHub and choose **Report a
vulnerability**. Only you and the maintainers can see the report, and the
maintainers follow up there.

Include:

- the affected package and the commit you tested;
- steps or code that reproduce the issue;
- the impact: what an attacker can do, and under which conditions.

## Scope

Both packages in this repository, `@qbit-oss/rpc` and `@qbit-oss/zmq`, are in
scope. Report issues in qbit Core as its
[security policy](https://github.com/Qbit-Org/qbit/blob/main/SECURITY.md)
describes, and issues in `@qbit-oss/protocol` or `@qbit-oss/api` through
[Qbit-Org/qbit-js](https://github.com/Qbit-Org/qbit-js/blob/main/SECURITY.md).

## Supported versions

Nothing has been released. Fixes land on `main`.

## Security boundaries

`@qbit-oss/rpc` holds RPC credentials in memory and sends them only over HTTPS
or to a loopback host. It never logs, and keeps credentials, cookie contents
and request parameters out of the errors it writes (a node's own error message
is passed through). It does not hold private keys:
signing happens in the qbitd wallet, which the `wallet-write` capability lets
a client drive. Treat any process with that capability, and the node's RPC
port, as able to spend the wallet's funds.

`@qbit-oss/zmq` reads unauthenticated notifications. qbitd's ZMQ publisher has
no authentication, so a notification proves nothing on its own: confirm what
it reports over RPC before acting on it.
