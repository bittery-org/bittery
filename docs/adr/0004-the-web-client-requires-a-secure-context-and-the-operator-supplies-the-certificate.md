# The Web client requires a secure context and the operator supplies the certificate

Status: accepted

Reconfirmed with an HSTS amendment by Wayfinder ticket 05 on 2026-08-20.

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

The earlier decision to omit HSTS was wrong: refusing to run the real client over HTTP does not stop a
Network Attacker from replacing the refusal page. Every secure Web-client response therefore sends
`Strict-Transport-Security: max-age=31536000`, scoped to the exact host with no `includeSubDomains` and
no preload. This protects later navigation after the browser receives the policy while avoiding an
irreversible preload or policy over unrelated subdomains. The first HTTP visit remains unprotected and
the documentation says so.

Secure context is now guaranteed for the Web client, so the Origin Private File System and
`StorageManager.persist()` are available to it. The browser durability work no longer has to plan for
their absence.
