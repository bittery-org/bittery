# Server domain architecture and atomic command writer

Type: grilling
Status: ready-for-human
Blocked by: 04

## Question

A clean-room rewrite, with the frozen server as reference only. What is already right there: Qubit is gone, no generic repository tier exists, domains own their SQL, and real-Postgres integration tests are extensive. What is scattered: transaction-plus-sync-event pairing inside each domain. Audit and idempotency already have single writers. See [current-state verification](../research/current-state-verification.md).

Decide:

- The vertical domain list and the permitted cross-domain call rules.
- The atomic command writer interface that `ARCH-SERVER-001` demands: one transaction committing domain mutation, audit record, sync event, and idempotency outcome.
- Where authorization lives, and how it is proven per domain.
- Migration discipline: hand-authored, append-only, and what CI must verify.
- SQLx version freeze and dependency-upgrade policy.
- Whether Redis appears at all, and if so strictly as a scaling adapter.
- Which frozen subsystems are worth mining rather than rediscovering: the 19 rate-limit scopes, idempotency records, `ETag`/`If-Match` concurrency, the seven cron jobs.

Produces: `ARCH-SERVER-*` refinement and the module layout.

## Comments

### Superseded by ticket 04's reopened answer

The plaintext registry is provisional until this ticket and the public protocol/schema work close.
Ordinary operational timestamps are allowed. The final schema gate freezes the field-level registry
and activates its release-blocking check; do not inherit the old sequence-only/day-bucket design.

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-003` demotes Server-side access control to an availability and abuse control. Vault access
comes from a member wrapping the Vault key; a Server authorization record never grants it. The domain
model must not treat an ACL row as the source of truth for who can read a Vault.

`PRIVACY-006` requires a repository check that fails on any plaintext schema column absent from
`PRIVACY-007`. Decide where that check lives and what it reads.

`PRIVACY-008` removes `created_at` and `updated_at` from Item, Vault, and Attachment tables. Ordering
is a per-Vault sequence number; retention uses a day-resolution bucket.

### Inherited from the reopened password authentication decision

OPAQUE requires short-lived secret Sign-in-attempt state shared across Server processes. The protocol
fixes a random 128-bit attempt identifier and atomic first-KE3 consumption; this ticket places that
state in a transactional domain and ensures correctness depends on neither process affinity nor Redis.

Initial registration, password or Secret Key change, profile or protocol migration, and Server-identity
change must commit the OPAQUE registration and Account Key Set wrapper together. No generic credential-
replacement endpoint exists outside those named ceremonies.
