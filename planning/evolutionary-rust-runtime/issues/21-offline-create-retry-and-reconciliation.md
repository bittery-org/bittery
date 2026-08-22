# Offline create, retry, and reconciliation

Type: task
Status: ready-for-agent
Blocked by: 17, 20
Spec: ../spec.md#offline-create

## Outcome

Complete the first acceptance slice with durable offline Login-Item creation, unbounded transient
retry, exactly-once Server effect, response-loss recovery, and authoritative reconciliation.

## Work

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
