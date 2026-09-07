# First-slice end-to-end acceptance

Type: task
Status: resolved
Blocked by: 22, 35
Spec: ../spec.md#end-to-end

## Delivered

Delivered the production Worker/IndexedDB/Server/PostgreSQL browser scenario, including six
transient failures, exact durable-to-wire bytes, renewed Session, duplicate dispatch, lost response,
and one-effect/one-receipt reconciliation. Plaintext markers are checked in storage and diagnostics.
[Ticket 36](36-web-offline-authority-read.md) adds prior-authority offline read coverage; live
cross-device Sync remains [ticket 30](30-runtime-owned-live-sync.md).

## Contract

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

The complete cloud Playwright path, including durable-to-wire identity and final Server/local
multiplicities, passed with both full CI gates at delivery.
