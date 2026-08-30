# Add the create-Vault outcome foundation

Type: task
Status: resolved
Blocked by: 49
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#2026-08-30--final-web-item-and-import-frontier-resolved)

## Outcome

Server persistence and generated consumers understand the closed `create_vault` retained outcome,
but the reachable create-Vault PUT keeps its legacy behavior and no production Runtime
`create_vault` Operation can yet be accepted or dispatched.

## Work

- Create a new migration with `pnpm run db:create -- <name>` for the `create_vault` operation kind,
  its applied `{ vaultId }` payload constraints, and its closed rejection codes:
  `vault_id_conflict`, `team_membership_required`, `vault_sharing_entitlement_denied`, and
  `shared_vault_limit_reached`.
- Extend the one tagged `OperationOutcome` lookup union, Server serialization, OpenAPI source, API
  contract, and Rust consumer parsing. Unknown kinds and malformed or cross-kind payloads remain
  fail-closed; consumer support must not imply acceptance eligibility.
- Add schema/transaction fixtures proving exact applied and rejection constraints, rollback, and
  lookup identity. Do not add a second route or alter the reachable PUT response, middleware,
  caller graph, or object-store behavior.

## Path ownership and failure domain

This slice owns its new immutable file under `apps/server/migrations`, the operation outcome model
under `apps/server/src/domains/operations`, the OpenAPI source and generated
`packages/api-contract` artifacts, and only the narrow outcome-consumer/generator paths under
`packages/client-runtime`. It owns outcome persistence, tagged parsing, and generation drift. It
does not own `apps/server/src/domains/vaults/http/catalog.rs` create execution, Runtime Operation
acceptance/scheduling, image staging, `packages/core` create services, or any host caller.

## Verification

- Start with failing database and generated-contract tests for every closed payload and rejection,
  wrong-kind payloads, unknown kinds, rollback, and exact lookup identity.
- Prove the production PUT and its reachable callers are byte-for-byte/behaviorally unchanged and
  that no Runtime request can accept or dispatch `create_vault`.
- Run the focused Server outcome tests, `pnpm check:server`, OpenAPI/API-contract and
  client-runtime generation checks, affected type checks, `pnpm check:ci`,
  `pnpm check:ci:rust`, and `git diff --check`.

## Comments

### 2026-08-31 — resolved

Commit `66ccd776` adds migration
`20260830224707_create_vault_operation_outcome.sql` and extends the single retained outcome union,
OpenAPI/API contract, and Rust consumer with the closed `create_vault` result: applied carries
exactly `{ vaultId }`; rejected carries exactly one of `vault_id_conflict`,
`team_membership_required`, `vault_sharing_entitlement_denied`, or
`shared_vault_limit_reached`. Malformed, unknown, and cross-kind combinations fail closed, while
rollback and User-scoped lookup preserve exact outcome identity. The production catalog PUT and its
reachable callers are unchanged, and Runtime still cannot accept or dispatch `create_vault`.

An independent review approved the implementation without findings and independently passed the
contract drift, generator, and diff checks; its environment lacked `DATABASE_URL`, so it relied on
the recorded real-Postgres result for that suite. Verification passed 12/12 focused Operation tests,
3/3 database-enum drift tests, 6/6 OpenAPI/server-contract generator tests, 3/3 Rust server-contract
tests, affected TypeScript checks, `pnpm check:server`, `pnpm check:ci:rust`, and
`git diff --check`. The Rust gate covered Server format/clippy/check, Crypto Core's 139 tests and 9
vectors, Client Runtime's 516 Core tests, 45 binding tests, 31 generator tests, all generated and
native/Web binding checks, and Desktop's 89 and 50 test suites. Root `pnpm check:ci` did not complete:
it stopped only on preserved Ticket 58/global Biome debt, with no Ticket 50-owned diagnostic; this
ticket therefore does not claim a clean-tree root CI pass.
