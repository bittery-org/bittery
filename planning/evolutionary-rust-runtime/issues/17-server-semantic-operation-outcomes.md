# Server semantic Operation outcomes

Type: task
Status: resolved
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

## Comments

- The legacy response-cache inventory remains eleven `idempotency::execute` call sites. Six cover
  Item update, favorite, trash, restore, move, and permanent delete. Five cover the shared Rotation
  handlers for Vault-Member removal start/finalize, Team leave start/finalize, and Team-Member
  removal start/finalize (the shared departure finalizer serves two public routes).
- Those routes deliberately retain their existing response-cache contract and `idempotency_record`
  persistence in this ticket. Stripping retry protection without replacing each route with an atomic
  semantic Domain outcome would be a regression. Their conversion is a release blocker before the
  old table, errors, replay header, CORS exposure, code, and recovery documentation may be removed.
- Create Item is no longer one of those callers. Its required `Idempotency-Key` is the stable
  Operation ID, and its public response has only the retained applied/rejected semantic contract.
- Verification completed with all 402 Server tests, the strict Server format/Clippy/check gate,
  migration validation, generated-contract drift validation, the 15 API-facade tests, and the 62
  Sync-engine tests passing. The API-contract and Sync package type checks also pass.
