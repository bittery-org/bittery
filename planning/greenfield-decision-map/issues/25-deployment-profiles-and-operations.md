# Deployment profiles and operations

Type: grilling
Status: ready-for-human
Blocked by: 22

## Question

`HOST-002` promises a simple single-node profile and a scalable profile with identical application semantics and no correctness dependency on Redis. The frozen product already ships a Docker/Caddy installer and a self-hosted mode, though the mode switch itself is no longer needed since the product is self-hosted only.

Decide:

- What the simple profile actually is: one container or several, and what an operator must run and maintain.
- Postgres operations for a home deployment, given `ARCH-SERVER-002` makes Postgres an intentional dependency.
- Object storage for Attachments: which adapters are supported, and whether local disk is first-class.
- What the scalable profile adds, and what it must not change.
- Upgrade and rollback procedure, and how migrations behave against a running deployment.
- Observability: what an operator can see without external services, and what health and metrics endpoints exist.

Produces: `HOST-002` refinement and a deployment specification.

## Comments

### Superseded by ticket 04's reopened answer

Wall-clock operational history is deliberately Server-visible. This ticket still sets documented log
retention, but no longer treats timestamps as reintroducing a forbidden database history.

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-014` requires a documented default retention bound on Server request logs. Unbounded request
logging carries wall-clock times and request paths, which reintroduces exactly the history
`PRIVACY-008` removes from the database. Set the default here, and state what a request log contains.

### Inherited from ticket 05, client delivery trust and transport

`HOST-008` puts certificate management wholly in operator hands and rules out shipping any
certificate authority or tooling. The four supported routes to a secure context land in this ticket's
deployment documentation, with a private overlay network as the recommended LAN route.

`HOST-007` means a deployment profile that cannot reach a secure context serves no Web client at all.
Decide what such a profile tells the operator, and whether the single-node profile does anything to
help (a documented reverse-proxy recipe, for instance) short of issuing certificates.

### Inherited from the reopened password authentication decision

Both deployment profiles must share Sign-in-attempt state across Server processes and atomically consume
it without sticky routing. Redis may accelerate this path but cannot own its correctness. Both profiles
must back up and restore the Server-wide OPAQUE seed and static 3DH key with the matching registration
records and Account Key Set wrappers.

### Inherited from Sync protocol: cursor, bootstrap, and retention windows

The Server publishes two privacy/operations settings: Sync-event retention defaults to 30 days with a
48-hour minimum and optional indefinite retention; Server-wide Trash retention defaults to 90 days
with a one-day minimum and optional no automatic deletion. Active 24-hour Bootstrap leases pin their
snapshot objects and Delta suffix. This ticket owns deployment configuration shape, cleanup job
operation and observability without adding per-Team or per-Vault overrides.
