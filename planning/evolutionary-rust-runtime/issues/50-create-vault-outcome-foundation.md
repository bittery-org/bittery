# Add the create-Vault outcome foundation

Type: task
Status: resolved
Blocked by: 49
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#final-web-item-and-import-frontier)

## Delivered

Delivered in `66ccd776`. The contract below records this foundation's scope; later cutovers
are tracked separately. Production create-Vault is now enabled by [ticket 54](54-create-vault-atomic-cutover.md).

Recorded validation: focused checks and `pnpm check:ci:rust` passed. A clean root `pnpm check:ci`
pass was not established at delivery; final integration verification remains ticket 58's gate.

## Contract

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

## Verification

- Start with failing database and generated-contract tests for every closed payload and rejection,
  wrong-kind payloads, unknown kinds, rollback, and exact lookup identity.
- Prove the production PUT and its reachable callers are byte-for-byte/behaviorally unchanged and
  that no Runtime request can accept or dispatch `create_vault`.
- Run the focused Server outcome tests, `pnpm check:server`, OpenAPI/API-contract and
  client-runtime generation checks, affected type checks, `pnpm check:ci`,
  `pnpm check:ci:rust`, and `git diff --check`.
