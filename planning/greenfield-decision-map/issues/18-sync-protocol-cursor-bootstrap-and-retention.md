# Sync protocol: cursor, bootstrap, and retention windows

Type: grilling
Status: ready-for-human
Blocked by: 17

## Question

The frozen server prunes sync events after **30 days** and hard-deletes trashed items after **90 days**, emitting permanent-deletion events. Neither window appears anywhere in the target corpus, and the 30-day one is a hard constraint on any offline design: a device offline longer must full-bootstrap. See [current-state verification](../research/current-state-verification.md).

Decide:

- The cursor format and its guarantees, including whether it is signed or otherwise rollback-detectable.
- Bootstrap: pagination, atomic promotion, and resumption after interruption.
- The sync-event retention window, and what a device does when its cursor has aged out.
- Tombstone semantics and compaction, such that an old offline Device cannot resurrect a permanently deleted Item.
- Trash retention: whether it is fixed or operator-configurable, given quotas are gone.
- SSE as an optional wake-up hint only, and what happens with no SSE at all.
- What the event stream leaks to the operator, checked against the closed plaintext list.

Produces: a protocol specification, `SYNC-*` and `ITEM-006` refinement, and seed scenarios 5 and 8.

## Comments

### Inherited from Operation state machine and crash safety

The exact Operation lifecycle, request fingerprint, Account-lifetime outcome ledger, and lost-response
recovery are settled in [`operations.md`](../../../docs/greenfield/target/operations.md). This ticket
defines the opaque commit-marker bytes carried by a committed `OperationOutcome` and how that marker
relates to the Sync cursor. Sync-event retention or cursor expiry may never delete or weaken the
Account-lifetime exactly-once ledger. Seed scenario 3 already proves the generic lost-response path;
this ticket may refine its marker without weakening its invariants.
