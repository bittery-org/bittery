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

## Comments

### 2026-08-24 — split into four slices

The ticket carries the whole write path, so it lands as four sequenced slices against the same
acceptance scenario:

- **A, durable accept.** Canonical Item and Operation IDs, existing crypto-core encryption and AAD,
  exact immutable method/path/headers/body bytes, the independent request fingerprint, the atomic
  accept transaction, and the encrypted optimistic overlay. `Accepted` answers only after that
  transaction commits. No network. Replaces the foundation marker in `runtime.rs` that says this
  slice supplies the real encryption.
- **B, dispatch.** The duplicate-suppressing lease, unbounded transient retry with bounded
  exponential backoff, Session-wait states, and Authorization attached from the current Session at
  dispatch rather than stored in the immutable bytes. Attempt count stays diagnostic; no terminal
  attempt limit and no per-Operation discard.
- **C, outcome and reconciliation.** Immutable matching semantic outcomes, same-ID/different-
  fingerprint as a fatal invariant violation, authoritative Item fetch, the single reconciliation
  plan that writes authority and removes Operation and overlay, the compact receipt, the exact
  Cursor advance, and terminal rejection projected onto the optimistic Item without destroying its
  ciphertext.
- **D, Web create flow.** Route the existing create-Login-Item UI at the Runtime request.

The full acceptance scenario in the specification is the gate on slice D, not on A.
