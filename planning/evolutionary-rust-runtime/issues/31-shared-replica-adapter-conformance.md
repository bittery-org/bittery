# Shared Replica adapter conformance

Type: task
Status: resolved
Blocked by: 22
Spec: ../spec.md#shared-replica-conformance

## Delivered

Delivered Rust SQLite and one Rust-generated history corpus replayed by in-memory, SQLite, and
IndexedDB adapters. [Ticket 37](37-sqlite-complete-failure-matrix.md) completed SQLite's failure
matrix. [Ticket 38](38-replica-persistence-evolution.md) owns remaining schema evolution work.

## Contract

- Add the first Rust SQLite Replica adapter behind the existing closed persistence contract. The host
  supplies an application-owned database location; no SQL or table identity crosses the host seam.
- Define one adapter-neutral plan-history fixture format from the Rust logical plans and expected
  visible state, including Account scope, incarnation, revision, lock epoch, tagged Cursor, staged
  Bootstrap, Operations, outcomes, overlays, and receipts.
- Run those histories against the in-memory interpreter, IndexedDB executor, and SQLite adapter.
  Reuse the generated persistence contract rather than restating its domain model in TypeScript.
- Inject a failure at each write boundary and prove old-or-new atomicity. Cover stale/missing guards,
  Account remove-and-readd, lock races, retry/replay, and no known plaintext marker in durable rows.
- Keep physical migration lifecycle work in ticket 38; IndexedDB already preserves the v6-to-v7
  upgrade delivered with Share acceptance.

## Verification

The shared history corpus proves equivalent responses and Account-scoped durable state across
in-memory, SQLite, and IndexedDB. Failure injection verifies old-or-new state; ticket 37 supplies
the completed SQLite matrix. Both full CI gates passed at delivery.
