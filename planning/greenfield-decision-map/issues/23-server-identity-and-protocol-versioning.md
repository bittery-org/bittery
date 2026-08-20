# Server identity, protocol versioning, and OpenAPI compatibility

Type: grilling
Status: ready-for-human
Blocked by: 22

## Question

`ACCOUNT-002` scopes local Account identity by stable Server identity rather than URL, and `ARCH-SERVER-004` makes OpenAPI and the documented encrypted formats public interfaces third parties may implement.

Decide:

- What a Server identity is cryptographically, how a client pins it, and what happens when it changes.
- How a client detects that it is talking to a different Server at the same URL.
- Protocol versioning and capability negotiation, and how far back compatibility runs.
- Whether the bundled Web client must always match its Server, and what enforces that.
- What third-party clients are guaranteed, and what may change without notice.
- The `ETag`/`If-Match` and idempotency contracts as public protocol rather than implementation detail.

Produces: `ACCOUNT-002` and `ARCH-SERVER-004` refinement, plus a versioning policy.
## Comments

### Inherited from the 2026-08-20 consistency audit

`AUTH-009` cannot claim challenge-relay resistance merely by signing a Server identity. This ticket
must define how a client obtains, authenticates, pins, backs up, restores, and changes that identity,
and how the Web client differs when its serving operator is the adversary. Ticket 06 is reopened and
must expose this dependency in the authentication design.

### Inherited from ticket 05, client delivery trust and transport

**Superseded in part:** `PRIVACY-016` no longer requires or trusts a Server-reported well-known hash.
Published hashes verify release artifacts but cannot prove what bytes a Malicious Operator delivered.

`PRIVACY-016` adds a documented well-known path exposing the content hash of the Web client bundle
the Server serves. That is a public interface under `ARCH-SERVER-004`, so its path and response shape
belong in this ticket's versioning and OpenAPI decisions.

`ARCH-HOST-002` removes cross-origin resource sharing from the Server entirely: the Web client is
same-origin, and installed clients are not browsers. No CORS surface needs versioning.
### Inherited from ticket 06, password authentication protocol

`AUTH-009` uses the stable **Server identity** twice: inside the canonical OPRF input and as OPAQUE's
server identity. It must be available as canonical bytes before KE1. Relay resistance is conditional on
this ticket defining how a client obtains, authenticates, pins, backs up, restores, and changes those
bytes; the Web client cannot claim more than its serving-operator limitation permits.

An identity change changes OPAQUE's export key and therefore uses `AUTH-014`'s atomic replacement of
the OPAQUE registration and Account Key Set wrapper before the old identity is refused. Authentication
versions are one-byte, append-only, client-pinned, printed on the Emergency Kit, and never negotiated or
walked automatically. This ticket must keep general API capability negotiation separate from that rule.
