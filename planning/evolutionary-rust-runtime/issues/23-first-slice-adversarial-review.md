# First-slice adversarial review

Type: task
Status: resolved
Blocked by: 22, 31, 32, 36, 37
Spec: ../spec.md#verification

## Outcome

Independently challenge the completed Web slice against every fixed cryptographic, transaction,
retry, cross-Account, generated-contract, and cleanup invariant before Desktop migration begins.

## Work

- Review implementation against every spec statement and resolved decision ticket.
- Run fault injection and full applicable CI from a clean process state.
- Search for duplicate policy, hidden finite retries, plaintext persistence/logging, implicit Active
  account scope, response-cache idempotency, second Worker ownership, and reachable dual writers.
- File precise blocking tickets for every discrepancy; fix only when separately claimed to preserve
  independent review.

## Verification

The review report maps every acceptance criterion to code and a passing test or names a blocker. The
slice advances only with zero unresolved correctness/security blockers and green full checks.

## Comments

### 2026-08-24 — adversarial review filed two blockers

The independent Standards and Spec reviews used `legacy-v0.5.2` as the fixed point. The primary
agent verified every reported claim rather than treating either review as a verdict. The complete
criterion map and command evidence are in [the review report](../review-2026-08-24.md).

Two claims are real blockers:

- [Ticket 31](31-shared-replica-adapter-conformance.md) records the missing Rust SQLite adapter and
  shared logical plan-history conformance suite. There is no SQLite dependency or implementation in
  `packages/client-runtime`, and the IndexedDB tests construct transport requests independently from
  the Rust in-memory histories.
- [Ticket 32](32-first-slice-end-to-end-acceptance.md) records the missing end-to-end acceptance
  scenario. Source-text assertions and component/unit tests do not exercise Worker termination,
  offline restart, more than five failures, Session renewal, duplicate dispatch, lost response, and
  final client/Server reconciliation as one Web path.

The reviewers' other source-text-test findings were evidence for ticket 32 rather than separate
defects: the whole-entry-graph reachability audit already structurally closes ownership reachability,
while the missing browser scenario is the actual uncovered product behavior. Generator and
Desktop/Mobile duplication findings were non-blocking design judgements outside this slice.

Focused searches found no hidden finite Operation retry, per-Operation discard, persisted/logged
plaintext, implicit Runtime Account scope, second Web Worker owner, reachable Web Sync dual writer,
or response-cache execution on Item routes. The remaining `idempotency::execute` calls are exactly
the five Rotation call sites already assigned to ticket 29.

Both `pnpm check:ci` and `pnpm check:ci:rust` passed from a clean tree with the documented database
environment. Ticket 23 stays open until tickets 31 and 32 land and this review is rerun over them.

### 2026-08-24 — blocker rerun filed two remaining proof gaps

The rerun over `704ec422..HEAD` confirmed that tickets 31, 32, and their empty-Vault blocker landed
without a new ownership, retry, Account-scope, plaintext, or generated-contract defect. The primary
agent reran the Web reachability audit (11 passing tests), the complete browser scenario, and both
full gates from a clean tree.

Two Spec-review claims are real blockers and are filed rather than fixed under this review:

- [Ticket 36](36-web-offline-authority-read.md) records the missing behavioral Web proof that a
  previously bootstrapped authoritative Login Item renders from the encrypted local Replica after
  Worker restart, online unlock, and subsequent transport disconnection. Ticket 32 proves durable
  Operation restoration and reconciliation, but its fresh Vault contains no prior authoritative
  Item and raw IndexedDB inspection is not the specified offline read.
- [Ticket 37](37-sqlite-complete-failure-matrix.md) records the incomplete SQLite failure matrix.
  SQLite rollback is proved for the three writes of one accept Commit, while the resolved ticket 31
  claims injected boundaries for Install, reconciliation Commit, and Lock as well.

A stale Server comment and one JSON-token corpus assertion were non-blocking documentation/test-style
observations; neither substitutes for behavior or demonstrates a correctness/security discrepancy.
Ticket 23 remains open until tickets 36 and 37 land and their delta receives a final rerun.

### 2026-08-24 — resolved after final blocker delta review

The final independent Standards and Spec reviews over `1d60d73c...5f014624` found no remaining
issue. Ticket 36 landed the post-restart offline authoritative Web read in `bb4ec003`; ticket 37
landed the complete SQLite write-boundary failure matrix in `2976d505`. The primary agent verified
the focused browser and Rust paths, the 11-test whole-entry Web reachability audit, and both full CI
gates from a clean tree. The complete criterion map and command evidence are in the linked review
report.

Deliberately left open: ticket 28 owns the already-classified transitional Web mutation holdouts,
ticket 29 owns Rotation protocol/storage decisions, and ticket 30 owns SSE reconnect/backoff. The
review found no hidden finite Operation retry or discard, plaintext persistence/logging, implicit
Runtime Account scope, second Web Runtime owner, reachable Web create/Sync dual writer, or
source-text/self-certifying acceptance test in the delivered first slice.
