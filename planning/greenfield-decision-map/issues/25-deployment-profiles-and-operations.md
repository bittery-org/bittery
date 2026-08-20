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

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-014` requires a documented default retention bound on Server request logs. Unbounded request
logging carries wall-clock times and request paths, which reintroduces exactly the history
`PRIVACY-008` removes from the database. Set the default here, and state what a request log contains.
