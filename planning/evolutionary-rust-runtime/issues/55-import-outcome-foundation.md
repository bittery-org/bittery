# Add the Import outcome foundation

Type: task
Status: ready-for-agent
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
