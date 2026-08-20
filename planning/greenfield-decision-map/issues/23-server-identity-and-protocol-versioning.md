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
