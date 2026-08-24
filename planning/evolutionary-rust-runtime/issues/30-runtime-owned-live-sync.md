# Runtime-owned live Sync

Type: task
Status: ready-for-agent
Blocked by: 28
Spec: ../spec.md#first-slice-sync-feed

## Outcome

The Runtime keeps an Account current on its own: it holds the Sync connection, wakes on a hint,
fetches changes, applies authoritative entities, and advances the Cursor, for as long as the Account
is unlocked. A second Device's change reaches the first without a user action.

## Problem

Rust already owns every *part* of Sync. `runtime/bootstrap.rs` has `catch_up_changes`,
`observe_sse_hint`, the pinned tagged watermark, the exact-Cursor advance, and `renew_session`.

What it does not have is a loop. Both are called only from `run_bootstrap`, which runs once inside a
Sign-in or Quick Unlock request and then returns. So the Runtime catches up exactly once per unlock
and never again, and nothing is listening when the Server emits a hint afterwards.

Ticket 22 deleted the transitional Web Sync loop, correctly: the specification forbids two active
writers for one Account, and the Runtime is the writer now. The consequence is that the Web host
currently has no live Sync at all. `apps/web/tests/e2e/sync.spec.ts` asserts live cross-device
propagation and cannot pass until this ticket lands.

## Work

- Add a long-lived Sync loop per unlocked Account, modelled on `Runtime::run_operation_dispatch`:
  a plain future the host drives, waking on a `Notify` plus a delay, returning when the Runtime
  closes. Do not spawn a runtime or import a scheduler; use the existing `device_timer` seam, which
  exists because Tokio's timer panics on `wasm32-unknown-unknown`.
- Hold the SSE connection for the Account's lifetime rather than for one request, and treat it as a
  hint only, per ticket 07. A hint wakes a changes fetch; it never carries authority.
- Reconnect with bounded backoff. A dropped connection is transient and must not fail the Account or
  end any accepted Operation.
- Keep the Cursor rules unchanged: fetch the authoritative entity outside storage, then atomically
  apply the encrypted entity or tombstone and advance from the exact expected Cursor. Fetch or commit
  failure leaves the Cursor unchanged. Stale Server versions cannot overwrite newer ciphertext.
- Stop cleanly on Lock, Sign-out, and Runtime close, releasing the connection and destroying nothing
  durable. A parked Account holds no connection and no timer.
- Interact correctly with dispatch: an `operation_resolved` event that arrives over Sync must reach
  the same reconciliation path `runtime/outcome.rs` already owns, not a second one.
- Spawn the loop from the Web binding beside the existing dispatch and observation drains.

## Verification

A change committed by a second Device reaches the first with no user action and no request in flight.
A dropped SSE connection reconnects with backoff and loses no change. A hint that arrives during a
commit does not reorder or skip a Cursor. Lock, Sign-out, and close release the connection and leave
durable state intact. `apps/web/tests/e2e/sync.spec.ts` passes. `pnpm check:ci` and
`pnpm check:ci:rust` pass.
