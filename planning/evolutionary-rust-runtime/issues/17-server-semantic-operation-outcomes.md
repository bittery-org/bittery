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

- Reopened after Spec review found missing current-client outcome lookup/reconciliation, failed
  optimistic-Item persistence, bounded Sync-page regression coverage, and replay SSE suppression.

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
- Spec-review verification passes all 403 Server library tests plus both migration tests, the strict
  Server format/Clippy/check gate, migration validation, generated-contract drift validation, all 35
  API-contract tests, all 80 focused Sync tests, all 38 focused Core repository tests, and the 7
  Sync-cache plus 1 outbound-drain Extension tests. The dependent 13-task TypeScript check passes.
- `pnpm check:ci` passes in full. Generated Runtime bindings are excluded from Biome and remain
  covered by their dedicated deterministic drift, Clippy, and executable binding gates.
- `pnpm check:ci:rust` passes in full, including Server, Crypto Core/API, native and Web
  client-runtime generation/contracts, and Desktop checks and tests.
