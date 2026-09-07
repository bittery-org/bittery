# Add the Import outcome foundation

Type: task
Status: resolved
Blocked by: 54
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#final-web-item-and-import-frontier)

## Delivered

Delivered in `c14aa81e`. The contract below records this foundation's scope; later cutovers
are tracked separately.

The Server Import route was subsequently replaced in `87386201`; [ticket 57](57-import-atomic-cutover.md)
still owns production Runtime dispatch and Web integration.

Recorded validation: focused checks and `pnpm check:ci:rust` passed. A clean root `pnpm check:ci`
pass was not established at delivery; final integration verification remains ticket 58's gate. The
recorded API fixture check also retained one unrelated failure.

## Contract

- Create a new migration for the `import_items` kind, exact applied payload
  `{ vaultId, importedCount }`, and rejection set `invalid_ciphertext`, `vault_access_denied`,
  `vault_read_only`, and `item_id_conflict`.
- Extend the one tagged lookup union, schema constraints, OpenAPI source, generated API contract,
  and Rust consumer parsing. Reject malformed, cross-kind, and unknown payloads without treating
  consumer awareness as dispatch eligibility.
- Preserve the current `POST /api/v1/vaults/{vaultId}/item-imports` behavior, its callers, and the
  empty-list response. Add no second route or production Runtime request.

## Verification

- Start with failing database/generated tests for the applied payload, every rejection, empty
  imported count, wrong kind, malformed payload, unknown kind, exact identity, and rollback.
- Prove the legacy route and every production caller are unchanged and no Runtime path can accept or
  dispatch `import_items`.
- Run focused Server tests, `pnpm check:server`, OpenAPI/API/client-runtime generation checks,
  affected type checks, `pnpm check:ci`, `pnpm check:ci:rust`, and `git diff --check`.
