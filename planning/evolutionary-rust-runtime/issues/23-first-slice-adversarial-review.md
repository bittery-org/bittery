# First-slice adversarial review

Type: task
Status: ready-for-agent
Blocked by: 22, 31, 32
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
