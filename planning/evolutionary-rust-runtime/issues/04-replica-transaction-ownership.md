# Replica transaction ownership

Type: grilling
Status: resolved
Blocked by: 03

## Question

Who owns the logical Replica schema and atomic commit rules across IndexedDB and SQLite?

## Answer

Rust owns the logical Replica schema, invariants, and closed typed guarded commit plans. IndexedDB and
SQLite adapters execute those plans in real platform transactions and report committed or stale
guards; they implement no Bittery Domain or Sync policy. Acceptance commits Operation plus
optimistic effect atomically. Reconciliation commits authority, outcome, and local completion
atomically; a guarded page commit advances the Cursor only after every covered event completes
(see [ticket 28](28-remaining-item-write-kinds.md#item-operations)).
