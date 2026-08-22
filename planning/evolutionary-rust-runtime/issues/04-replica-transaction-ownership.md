# Replica transaction ownership

Type: grilling
Status: resolved
Blocked by: 03

## Question

Choose which side owns the logical Replica schema and atomic commit rules. A local command must store
its immutable request bytes, durable Operation state, and optimistic Item effect together. Applying a
remote outcome must reconcile the projection, Operation, and Cursor together.

Decide whether Rust constructs closed typed guarded commit plans for platform adapters, JavaScript and
native hosts implement high-level Replica policy themselves, or Rust persists one opaque full Replica
image through a primitive blob adapter.

## Evidence

- Current `AccountStore`, `ItemCache`, queue document, and Sync cursor are separate persistence
  authorities and cannot form one transaction.
- IndexedDB and SQLite, not an in-process Rust mutex, are the authorities that can commit durable
  platform state atomically.
- Web and Extension need IndexedDB-compatible storage; native hosts need SQLite. Both can execute the
  same logical mutation semantics through different adapters.
- A full opaque Replica blob has a small primitive interface but rewrites unrelated Account state and
  weakens bounded-write and large-Vault behavior.

## Answer

Rust owns the logical Replica schema, invariants, and closed typed guarded commit plans. IndexedDB and
SQLite adapters execute those plans in real platform transactions and report committed or stale
guards; they implement no Bittery Domain or Sync policy. The same logical plan therefore commits
Operation plus optimistic effect and later remote state plus outcome plus Cursor on every host.
