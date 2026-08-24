# SQLite complete Replica failure matrix

Type: task
Status: resolved
Blocked by: 31
Spec: ../spec.md#shared-replica-conformance

## Outcome

Failure injection at every SQLite write boundary for multi-write Install, accepted Operation Commit,
authoritative reconciliation Commit, and lock-epoch advance exposes exactly the old durable Account
or the fully committed new Account, matching the shared Replica contract.

## Why this blocks the first-slice review

Ticket 31's IndexedDB tests cover Install, reconciliation Commit, and Lock boundaries. SQLite proves
rollback only for the head, Operation, and optimistic-overlay statements of one accept Commit. The
adapter uses transactions and no partial-write defect is currently demonstrated, but the resolved
ticket claims the broader failure matrix without executable evidence.

## Work

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

Start with a targeted test that fails because the current matrix lacks these request kinds and retain
its exact output. Run the focused SQLite/core suites, corpus drift and conformance checks, followed by
both full gates from a clean tree.

## Comments

### 2026-08-24 — filed by ticket 23 rerun

This is a verification blocker, not evidence of a known SQLite transaction defect. Ticket 23 remains
open until the complete matrix is executable and independently reviewed.

### 2026-08-24 — claimed

Claimed after Ticket 36 landed. This remains one independently verifiable Rust test slice: extend
the SQLite failure-injection corpus across Install, accepted Operation Commit, authoritative
reconciliation Commit, and Lock without changing adapter semantics.

### 2026-08-24 — resolved

Commit `2976d505` completes the test-only SQLite matrix. Requests captured from Rust Domain
operations cover replacement Install, accepted Operation Commit, authoritative reconciliation
Commit, and Lock. Every head/row statement boundary receives an injected failure; the database is
then reopened and the complete canonical Account head and row bytes must equal the pre-request
state. The same request without injection must reach the complete Domain-derived post-state after
another reopen. Independent review found neither a product defect nor a fixture defect, and no
adapter semantics changed.

Deliberately left open: no new persistence behavior or retry policy is introduced; this ticket only
closes the missing executable proof. The focused matrix, SQLite module, full client-core suite,
corpus drift/conformance checks, formatting, Clippy, and both `pnpm check:ci` gates passed from a
clean tree.
