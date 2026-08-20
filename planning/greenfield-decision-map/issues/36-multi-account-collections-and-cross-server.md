# Multi-Account, Collections, and cross-Server copy

Type: grilling
Status: ready-for-human
Blocked by: 15, 18

## Question

Settled already: **the engine is designed multi-Account and multi-Server from day one; the All Accounts aggregation UI ships in the second cut.** This ticket decides the engine-side model so the later UI is not an engine rewrite.

Decide:

- How the engine represents several Accounts across several Servers concurrently: one replica or several, one sync loop or several.
- Session and lock semantics across Accounts: whether locking one locks all.
- How provenance travels on every projection, per `ACCOUNT-004`.
- The Collection model as a local filtering construct owning no data, keys, or membership.
- Cross-Server copy as copy-then-confirm-delete, per `ACCOUNT-007`, and what makes it safe without atomicity.
- What is genuinely deferred versus what must exist in the engine now.

Produces: `ACCOUNT-*` refinement and an engine model, plus seed scenario 9.
