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

### Inherited from ticket 05, client delivery trust and transport

`PRIVACY-016` adds a documented well-known path exposing the content hash of the Web client bundle
the Server serves. That is a public interface under `ARCH-SERVER-004`, so its path and response shape
belong in this ticket's versioning and OpenAPI decisions.

`ARCH-HOST-002` removes cross-origin resource sharing from the Server entirely: the Web client is
same-origin, and installed clients are not browsers. No CORS surface needs versioning.
### Inherited from ticket 06, password authentication protocol

`AUTH-009` binds the **Server identity** into the signed sign-in message, which is what stops a hostile
Server relaying a challenge issued by another Server. `ACCOUNT-001` makes that a live case, because an
installed client routinely holds credentials for several Servers. The identity this ticket defines must
therefore be stable across the lifetime of an Account, unforgeable by another Server, and representable
as bytes in a canonical length-prefixed message.

`AUTH-010` puts the **published key-derivation parameters** in the Server descriptor, so the descriptor
is fetched before any authentication and must be meaningful to a client that has never signed in.
Decide how a client detects a descriptor substituted by a Malicious Operator, given `PRIVACY-004`
already classes several operator attacks as Detectable.
