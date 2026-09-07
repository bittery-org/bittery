# Remaining Server Operation outcomes: Item routes

Type: task
Status: resolved
Blocked by: 17
Spec: ../spec.md#server-operation-contract

## Delivered

The six Item mutation handlers now use retained semantic outcomes: update, favorite, trash,
restore, move, and permanent delete. Rotation was explicitly split into
[ticket 29](29-rotation-operation-outcomes.md), which owns the five remaining response-cache
call sites and final table removal.

## Contract

- One `OperationOutcome` lookup union is tagged on `kind`. Applied Item results retain
  `{ itemId, version }`, including the final validator for a permanently deleted Item.
- Require `Idempotency-Key` and normalized `If-Match`. Fingerprint method, canonical route/path,
  and exact body; bodyless mutations still bind their method and precondition.
- Commit effect or proved rejection, audit, entity event where applicable, retained outcome, and
  `operation_resolved` in one transaction.
- The specification owns the exact common and per-kind rejection sets. A stale version is retained
  `item_version_conflict`, while malformed transport/authentication/infrastructure failure retains
  no outcome.
- Update Server, generated consumers, and reachable callers together. The transitional Sync queue's
  conflict-to-412 adapter remains only for hosts that still use that queue; Web cuts reachability
  in ticket 58.

## Verification

Each route covers identical and concurrent replay, changed-fingerprint reuse, lost response and
lookup, renewed Session, User isolation, retained rejections, and transaction rollback.
The Item-route inventory forbids `idempotency::execute`; the Rotation inventory remains nonzero.
Bounded Sync, User-scoped events, and generated-contract checks passed at delivery.
