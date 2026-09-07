# Web Worker and IndexedDB Replica

Type: task
Status: resolved
Blocked by: 15, 16
Spec: ../spec.md#web-binding

## Delivered

Delivered one combined WASM artifact, Worker composition, IndexedDB execution, platform-storage
primitives, and Account recovery. [Ticket 26](26-host-binding-architecture.md) owns the final
transport placement; [ticket 27](27-runtime-session-lifecycle.md) records restart and observation behavior.

## Contract

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
