# First-slice Sync feed

Type: grilling
Status: resolved
Blocked by: 05, 06

## Question

Does the first slice require a new Sync feed or retain bounded Bootstrap and authoritative fetches?

## Answer

The first Rust slice retains the current bounded Bootstrap, change-event plus authoritative-entity
fetch, opaque Cursor, and SSE-wakeup contract. The Server adds atomic semantic Operation outcomes;
Rust atomically reconciles fetched authority and local work, then advances the page Cursor only
after all covered events complete. [Ticket 28](28-remaining-item-write-kinds.md#item-operations)
records that delivered page boundary. A self-contained feed requires later correctness or measured
cost evidence rather than being assumed into the migration.

[Ticket 35](35-empty-vault-bootstrap.md) specifies the delivered Vault-then-Item Bootstrap phases.
[Ticket 30](30-runtime-owned-live-sync.md) owns the remaining long-lived Sync loop.
