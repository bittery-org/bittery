# Runtime-owned live Sync

Type: task
Status: ready-for-agent
Blocked by: 28
Spec: ../spec.md#outcome-and-reconciliation

## Outcome

While an Account is unlocked, Runtime maintains Sync, reconnects after transport failure, fetches
authority on hints, and advances the Cursor. Another Device's change arrives without user action.

## Current gap

`runtime/bootstrap.rs::run_bootstrap` hydrates and catches up once during Sign-in/Quick Unlock.
It no longer opens SSE inside that request. There is no persistent live-Sync runner.
The transitional Web Sync loop was removed by ticket 22; `tests/e2e/sync.spec.ts` remains the
cross-device acceptance gate.

## Work

- Add one driven, long-lived Sync future per unlocked Account using the existing timer/wakeup seam
  and lifecycle ownership. Browser WASM cannot use Tokio's timer; do not introduce host retry policy.
- Hold SSE only while the Account is eligible. Treat events as wakeups, fetch changes independently,
  and reconnect with bounded backoff. Disconnects preserve accepted Operations and do not fail the
  Account.
- Reuse the Account execution fence and central Session renewal/reconciliation. A long-held SSE read
  must not hold the fence or block Sign-in, mutations, or teardown.
- Apply all events in a page before the exact guarded `AdvanceSyncPageCursor` commit. Fetch/commit
  failure leaves the Cursor unchanged; replay cannot overwrite newer authority.
- Route `operation_resolved` through existing exact replay/outcome reconciliation.
- Lock, Sign-out, Remove, Wipe, Account failure, and Runtime close release connections/timers and
  fence late callbacks. The Sync runner itself deletes no durable work.
- Wire the Web binding's runner beside dispatch/observation drains; other hosts reuse that behavior.

## Verification

Real second-Device changes arrive while no request is in flight. Held SSE does not block Sign-in or
mutations; dropped connections reconnect without skipped events. Hints during commits, expired
Cursors, Session renewal, repeated failures, Account isolation, and teardown races preserve page
atomicity and durable work. Run focused Runtime tests, the Web Sync E2E, and both full CI gates.
