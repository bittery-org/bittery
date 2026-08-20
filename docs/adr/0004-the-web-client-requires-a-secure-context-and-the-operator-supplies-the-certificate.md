# The Web client requires a secure context and the operator supplies the certificate

Status: accepted

`HOST-001` calls LAN-only deployment first-class, and nothing in the corpus mentioned transport at
all. A plain `http://` origin is not a secure context, and a browser then withholds `crypto.subtle`,
the Origin Private File System, Service Workers, the Cache API, and `StorageManager.persist()`. The
carve-out covers `http://localhost` and `127.0.0.0/8` only: `http://192.168.1.50` and
`http://vault.local` are both non-secure, because the specification has no private-network exception.
A LAN attacker can also substitute the whole bundle over plain HTTP. `HOST-007` therefore makes a
secure context a precondition, and a Server refuses to serve the Web client without one.

## Considered options

Shipping certificate tooling, so the Server generates a private certificate authority on first boot
and prints it for the operator to install on each device, was rejected. It is real product surface to
build and maintain, and the failure mode is worse than the problem: a user who skips installing the
authority clicks through a certificate warning on every visit, which is corrosive training for a
password manager. Self-hosting has to stay easy, and asking someone to distribute a private
certificate authority is not easy.

Leaving transport unspecified and documenting the degradation was rejected. It undoes the posture
[ADR 0001](0001-server-visible-plaintext-is-a-closed-allowlist.md) set, and it leaves the Network
Attacker class undefended on the surface most users meet first.

## Consequences

`HOST-008` states that the product ships no certificate authority, generation, or renewal.
Documentation carries the routes instead: a private overlay network that issues publicly-trusted
certificates for its own names, a publicly-trusted certificate for an internet-reachable name, an
operator-supplied private certificate authority, and a loopback forward for one machine. The overlay
route is the recommended one for a LAN, because it delivers a real name and a real certificate with
no certificate installation.

The Server sends no HTTP Strict-Transport-Security header, and no requirement asks for one. Under
`HOST-007` the Web client already refuses to run from a non-secure origin, which is the stronger
guarantee; the header would only cover the first navigation to a typed `http://` address. Against
that narrow gain sits a sharp footgun: a browser records the header only over a connection whose
certificate already validates, so an operator who once had a valid certificate and later moves to one
the browser distrusts locks every user out for the remaining lifetime, with the certificate warning
bypass deliberately removed. Since `HOST-008` puts certificate management entirely in operator hands,
that mistake is likely enough to outweigh the benefit.

Secure context is now guaranteed for the Web client, so the Origin Private File System and
`StorageManager.persist()` are available to it. The browser durability work no longer has to plan for
their absence.
