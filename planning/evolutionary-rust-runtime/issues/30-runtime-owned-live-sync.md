# Runtime-owned live Sync

Type: task
Status: resolved
Blocked by: 28
Spec: ../spec.md#outcome-and-reconciliation

## Outcome

While an Account is unlocked, Runtime maintains Sync, reconnects after transport failure, fetches
authority on hints, and advances the Cursor. Another Device's change arrives without user action.

## Starting gap

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

## Baseline and implementation

The pre-Sync production browser baseline reproduced the missing behavior: two independent
Sign-ins hydrated the same Vault, but a writer's new Item did not reach the idle reader within
20 seconds. Implement bounded raw streaming transport beneath Rust-owned parsing, renewal,
reconnection, and reconciliation. Preserve finite HTTP behavior and lifecycle cancellation.
The user waived both full CI gates; targeted tests, acceptance, types, formatting, generation,
independent review, and the delegated simplification pass remain required.

The production browser run exposed a prerequisite: ordinary Item reconciliation fetched paid
Attachment metadata separately, so Free Accounts retried a 403 and never applied the Item. Add
`GET /api/v1/items/{itemId}/authority` using the existing complete `BootstrapItemResponse` and
Bootstrap's entitlement visibility (explicit empty Attachments for Free Accounts). Reuse bounded
row loading and Attachment composition; keep paid Attachment operations unchanged. Ordinary Sync
uses this targeted read rather than refreshing the entire Replica. The browser acceptance also
checks that an ordinary create does not issue another Bootstrap request. Verify authorization,
absence, response bounds, generated contracts, reconciliation guards, and independent simplification
review before rerunning acceptance.

The fresh browser rerun confirmed successful targeted reads but still missed the idle observer.
A native mounted-observer regression reproduced publication of a new Replica revision before the
decrypted Items refresh; the later same-revision publication was correctly deduplicated. Refresh
the projection before the terminal Cursor commit, preserving observer revision guards even with
an intervening native publication. The regression exercises that publication through the existing
pre-plaintext hook and requires delivery with strictly increasing observer revisions.

## Delivered and verified

One Runtime-owned Sync future per eligible Account holds bounded raw SSE transport, reconciles
hinted authority with guarded page Cursors, renews centrally, and reconnects with bounded backoff.
Held reads do not block mutations or a second Sign-in. Lock, Sign-out, Remove, Wipe, failure, and
close retire streams/timers while preserving the lifecycle's accepted-work contract.

All seven production Sync scenarios passed across targeted runs, including actual Worker transport
loss and real password-backed Quick Unlock. The three affected offline/restart/Attachment Move
paths passed. The joined Worker/Core harness passed 157 assertions (135 original plus 22 focused
stream-fixture assertions). Core live 21, outcome 53, Bootstrap 31, Auth HTTP 19, retirement 6,
transport/parser/guard regressions, Server authority 6, Bootstrap 14, and OpenAPI 9 passed. Dependent
types, 28 ownership-graph tests, affected generation, Web binding drift/behavior, Clippy, formatting,
and diff checks passed. Full CI was waived and not run.

Independent implementation reviews and delegated simplification passes are complete. Shared
transport admission/cancellation, existing Bootstrap DTO/visibility/bounded row loading, and private
authority parsing replace duplicated paths; redundant wrappers were removed. Browser faults use a
small exercised reader-only proxy because Playwright's offline toggle does not interrupt Worker
SSE. Fixtures await actual request-lifetime and durable-inspection events and preserve the original
replay, byte-identity, lifecycle, and single-effect assertions. No speculative framework was added.
