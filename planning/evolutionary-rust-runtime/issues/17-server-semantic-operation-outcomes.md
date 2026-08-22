# Server semantic Operation outcomes

Type: task
Status: claimed
Blocked by: 13
Spec: ../spec.md#server-operation-contract

## Outcome

Replace create Item's split HTTP idempotency with one retained semantic outcome committed atomically
with Item effect or rejection, audit, and Sync records.

## Work

- Add frozen-forward migration, closed Server types, domain Operation module, transaction-scoped
  concurrency locking, exact request fingerprinting, and final-only User-lifetime outcomes.
- Move create-Item validation and authorization inside the Operation transaction.
- Return generated applied/rejected outcome shapes and add authenticated User-scoped outcome lookup.
- Add `operation_resolved` to every repeated Sync visibility/cursor/page allowlist while preserving
  bounds and hint-only SSE.
- Regenerate OpenAPI and all current clients in place; adapt current callers to the new response.
- Convert or explicitly inventory every remaining old response-cache idempotency caller. Remove the
  old table/code/errors only when the inventory reaches zero; no second public protocol ships.

## Verification

Fault injection, concurrency, response-loss, isolation, lifetime, rejection, conflict, lookup,
changes, and Bootstrap tests listed in the spec pass. Generated contracts have no drift and targeted
Server checks pass.
