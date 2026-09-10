# SQLite complete Replica failure matrix

Type: task
Status: resolved
Blocked by: 31
Spec: ../spec.md#shared-replica-conformance

## Delivered

Delivered in `2976d505`. Every SQLite write boundary for Install, acceptance, reconciliation, and
Lock is fault-injected; reopening proves the complete old state or complete new state. This was
missing coverage, with no adapter behavior change.

## Contract

- Generate each prepared request from Rust Domain plans rather than constructing an independent SQL
  fixture model.
- Enumerate every actual write boundary for replacement Install, accepted Operation Commit,
  authoritative reconciliation Commit, and lock-epoch advance.
- Reopen SQLite after each injected failure and compare the complete Account-scoped head and row set
  byte-for-byte with the pre-request snapshot; then prove the non-failing request reaches the complete
  new state.
- Keep the same cases executable against the in-memory expectations where useful, without changing
  adapter semantics merely to fit the fixture.

## Verification

The complete SQLite matrix, shared corpus/drift checks, and both full CI gates passed at delivery.
