# First-slice end-to-end acceptance

Type: task
Status: claimed
Blocked by: 22
Spec: ../spec.md#end-to-end

## Outcome

One Web Playwright acceptance path proves the delivered Runtime slice from full Sign-in through
offline durable create, process loss, retry beyond five transient failures, response-loss recovery, and authoritative
client/Server reconciliation without relying on source-text assertions.

## Why this blocks the first-slice review

Ticket 23 confirmed that the specified browser scenario does not exist. Unit tests cover individual
Rust and Web components, while several Web wiring assertions read source files and match identifiers;
none drives the complete path through the Worker, IndexedDB, HTTP Server, PostgreSQL, and rendered
projection.

## Work

- Add the Playwright scenario to the Web E2E suite using the real Runtime composition root.
- Perform full Sign-in and Bootstrap, accept one Login Item while transport is offline, immediately
  terminate the Worker, restart, and prove the optimistic encrypted Operation survived.
- Force more than five transient failures, Session renewal, duplicate dispatch, and loss of the first
  successful response. Unsubscribe the initiating UI after acceptance and prove Runtime-owned work
  continues.
- Retain the structural Runtime test proving that scheduling has no attempt-terminal state and the
  closed protocol exposes no per-Operation discard; the finite browser trace complements that gate.
- Reconnect and assert one authoritative visible Item, one compact local receipt, no active Operation
  or duplicate overlay, and exactly one Server Item, audit record, Item event, retained Operation
  outcome, and `operation_resolved` event.
- Assert no plaintext draft marker appears in IndexedDB or Server diagnostic output. Keep live
  cross-device propagation in ticket 30's existing `sync.spec.ts`; this ticket tests reconciliation,
  not the still-open long-lived SSE loop.

## Verification

Start with the complete scenario failing before any harness or product fix and include that output in
the implementation report. Run the targeted cloud Playwright test with the development database,
then `pnpm check:ci` and `pnpm check:ci:rust` from a clean tree.

## Comments

### 2026-08-24 — kept as one acceptance slice

This ticket stays whole. Its one independently verifiable outcome is the complete Playwright path
through Worker, IndexedDB, HTTP Server, PostgreSQL, and rendered projection. A harness-only or
partial-trace split would not satisfy a separately observable spec statement; the targeted scenario
is therefore the red/green boundary for one implementer and one independent reviewer.
