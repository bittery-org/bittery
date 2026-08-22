# Web Worker and IndexedDB Replica

Type: task
Status: claimed
Blocked by: 15, 16
Spec: ../spec.md#web-binding

## Outcome

Host the production Runtime and existing crypto implementation in one process-wide Web Worker and
execute all first-slice guarded Replica plans atomically in a dedicated IndexedDB database.

## Work

- Multiplex legacy crypto calls and generated Runtime messages through one Worker instance.
- Add structured-clone guards, request correlation/cancel, observations, crash handling, and
  idempotent close.
- Implement the closed IndexedDB plan adapter with Account/incarnation/revision guards, staged
  generations, authority, overlays, Operations, outcomes, receipts, and fault injection.
- Bridge only browser storage primitives unavailable in a Worker and preserve the existing tier and
  lifetime classification.
- Run the shared logical plan suite against in-memory and IndexedDB implementations.

## Verification

Worker and IndexedDB tests prove atomic accept, promotion, Cursor, retry-state, stale guards, lock and
remove races, restart recovery, no persisted plaintext markers, and late-message handling. Existing
legacy crypto Worker behavior stays green during the transition.

## Comments

### 2026-08-23 — first bounded Worker batch

Added the process-wide Web Worker owner and channel-tagged request multiplexer before the Runtime's
real Web ports are available. The Web composition root now creates one owner and injects its `crypto`
channel into the existing WASM Worker Crypto port. The adapter's default construction remains
compatible for Desktop and existing callers. The production Worker registers only the unchanged
Crypto service in this batch; `runtime` is exercised only through a shadow test service, and there is
no second Runtime WASM artifact or claim that the production Runtime is live.

Focused tests cover colliding per-channel request IDs, reverse-order replies, cancellation routing,
unknown and late messages, crash rejection across channels, forbidden structured-clone shapes,
copied byte buffers, synchronous `postMessage` failure, unattached channels, and close ACK before
termination with idempotent repeated close. Existing Crypto Worker conformance remains unchanged.

Ticket 18 remains claimed. The real Runtime Worker service and its transport/device-storage ports,
the dedicated IndexedDB Replica adapter, shared guarded-plan conformance, observation routing, fault
injection, restart recovery, and production one-artifact integration remain for later batches.

Verified from the repository root:

```text
pnpm --filter @bittery/crypto-port test
pnpm --filter web exec bun test src/lib/crypto.test.ts
pnpm exec turbo -F @bittery/crypto-port -F '...@bittery/crypto-port' check-types
pnpm exec biome check <the nine changed TypeScript files>
git diff --check <the scoped tracked and new files>
```
