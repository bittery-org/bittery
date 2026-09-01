# Add the Import outcome foundation

Type: task
Status: resolved
Blocked by: 54
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#2026-08-30--final-web-item-and-import-frontier-resolved)

## Outcome

Server persistence and generated consumers understand the closed `import_items` retained outcome,
while the one reachable Import route keeps its legacy contract and no production Runtime Import
writer exists.

## Work

- Create a new migration for the `import_items` kind, exact applied payload
  `{ vaultId, importedCount }`, and rejection set `invalid_ciphertext`, `vault_access_denied`,
  `vault_read_only`, and `item_id_conflict`.
- Extend the one tagged lookup union, schema constraints, OpenAPI source, generated API contract,
  and Rust consumer parsing. Reject malformed, cross-kind, and unknown payloads without treating
  consumer awareness as dispatch eligibility.
- Preserve the current `POST /api/v1/vaults/{vaultId}/item-imports` behavior, its callers, and the
  empty-list response. Add no second route or production Runtime request.

## Path ownership and failure domain

This slice owns its immutable Server migration, operation outcome model/lookup, OpenAPI and
`packages/api-contract` generation, and narrow client-runtime outcome-consumer generation. It owns
schema constraints, tagged parsing, and drift failures only. It does not own the Import handler,
Runtime batch acceptance, `apps/web/src/hooks/use-vault-import.ts`, provider parsing, or caller
reachability.

## Verification

- Start with failing database/generated tests for the applied payload, every rejection, empty
  imported count, wrong kind, malformed payload, unknown kind, exact identity, and rollback.
- Prove the legacy route and every production caller are unchanged and no Runtime path can accept or
  dispatch `import_items`.
- Run focused Server tests, `pnpm check:server`, OpenAPI/API/client-runtime generation checks,
  affected type checks, `pnpm check:ci`, `pnpm check:ci:rust`, and `git diff --check`.

## Comments

### 2026-09-01 — ready for agent

Ticket 54 is resolved in commit `08684f43d72e801398f85e8a8560b11f5e735541` with independent final
standards and specification approval. It was this ticket's sole declared dependency, and the parent
Ticket 28 E6-E10 frontier is already decision-complete. The existing `ready-for-agent` status is
therefore now fully unblocked: this slice can add the closed `import_items` outcome foundation while
preserving the legacy Import route and keeping production Runtime Import dispatch closed.

### 2026-09-01 — resolved

Commit `c14aa81eeea87b9bad8e7cf86ee345cf08fb41c2` adds the closed `import_items` retained-outcome
foundation across the immutable Server migration, tagged lookup and constraints, OpenAPI and API
contract, generated Rust consumer, and Sync consumer. Applied outcomes carry the exact
`{ vaultId, importedCount }` payload, including zero, and rejected outcomes are limited to
`invalid_ciphertext`, `vault_access_denied`, `vault_read_only`, and `item_id_conflict`; malformed,
cross-kind, and unknown payloads remain closed failures.

This foundation does not accept or dispatch a Runtime Import Operation, change the legacy
`POST /api/v1/vaults/{vaultId}/item-imports` route, or cut over the Web Import workflow. Independent
final standards and specification reviews both approved the implementation with no remaining
findings.

Green verification covered the Server Operation suite (14 tests), Runtime outcome suite (50 tests)
and focused Import outcome test (1), Sync suite (17), generator suite (35), `server_contract` (5),
migrations (27), contracts generation/check, `pnpm check:server`, Clippy, `pnpm check:ci:rust`,
affected type checks, targeted Biome, and `git diff --check`. Root `pnpm check:ci` is not claimed
green: its remaining host-cutover failures belong to Ticket 58. The unrelated pre-existing API
fixture check also remains at 35 passing and 1 failing and is not attributed to this slice.
