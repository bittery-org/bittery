# Web Worker and IndexedDB Replica

Type: task
Status: ready-for-agent
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
