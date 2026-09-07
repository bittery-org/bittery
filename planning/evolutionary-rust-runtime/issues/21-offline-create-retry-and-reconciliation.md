# Offline create, retry, and reconciliation

Type: task
Status: resolved
Blocked by: 17, 20
Spec: ../spec.md#offline-create

## Delivered

Delivered durable acceptance, persisted unbounded dispatch, retained-outcome reconciliation, and
the Web create flow. [Ticket 32](32-first-slice-end-to-end-acceptance.md) supplies the complete
browser proof; [ticket 28](28-remaining-item-write-kinds.md) extends the remaining write kinds.

## Contract

- Implement canonical Item/Operation IDs, existing encryption/AAD, immutable request bytes and
  independent fingerprint, atomic accept, optimistic projection, leases, and bounded backoff.
- Implement Session-wait states, mutation replay/outcome lookup, Operation Sync-event handling,
  authoritative Item fetch, terminal rejection projection, compact receipt, and atomic Cursor-aware
  reconciliation.
- Never add per-Operation discard or a finite transient-attempt terminal state.
- Wire the existing Web create-Login-Item flow to the Runtime request.

## Verification

The complete acceptance scenario passes with offline accept, immediate Worker kill, more than five
failures, restart, Session renewal, forced duplicate dispatch, dropped first success response,
unsubscribe after accept, and final one-effect/one-Item reconciliation assertions across client and
Server storage.
