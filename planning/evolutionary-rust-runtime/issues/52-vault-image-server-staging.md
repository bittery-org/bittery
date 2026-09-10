# Add the Server Vault-image staging foundation

Type: task
Status: resolved
Blocked by: 51
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#final-web-item-and-import-frontier)

## Delivered

Delivered in `28e69e0c`. The contract below records this foundation's scope; later cutovers
are tracked separately. Production create-Vault is now enabled by [ticket 54](54-create-vault-atomic-cutover.md).

Recorded validation: focused checks and `pnpm check:ci:rust` passed. A clean root `pnpm check:ci`
pass was not established at delivery; final integration verification remains ticket 58's gate. The
recorded full Server run also had an unrelated Attachment Move authority test failure.

## Contract

- Add the staging migration and Domain model keyed by `(User, Operation)` with bound Vault ID,
  canonical object key, raw digest, exact length, exact allowed content type, state, generation, and
  rolling 24-hour lease. The object key is
  `vaults/{userId}/{vaultId}/create/{operationId}-{lowercaseSha256}` after canonical ID validation.
- Renew the lease only on an exact status, grant, or confirmation access. Upload traffic alone and
  cleanup do not renew it. Make status, grant, confirmation, and cleanup idempotent; a changed
  binding returns `OPERATION_ID_REUSED`.
- Enforce per User at most 64 outstanding bindings and 128 MiB total declared raw image bytes. Exact
  replay uses no additional slot or byte and renews the existing lease. Reject a new over-quota
  binding before object access and without a semantic Operation outcome.
- Bind upload credentials to exact length, content type, and SHA-256; confirm the exact object; make
  expired unconfirmed and `cleanup_pending` rows generation-fenced, idempotently sweepable, and safe
  across every database/object-store crash boundary.
- Keep all exchanges behind a test-only transport. Do not modify the public image-grant route,
  legacy create PUT, OpenAPI, or any production Runtime dispatcher.

## Verification

- Start with failing Server tests for exact replay, changed binding, all quota edges including
  64/128-MiB inclusive limits, lease renewal by each and only each allowed exchange, expiry,
  generation fencing, length/digest/content-type mismatch, and every database/object-store failure.
- Prove exact replay consumes no extra quota, an expired row cannot let delayed cleanup delete a new
  generation, cleanup converges after restart, and no semantic outcome is retained.
- Prove the public image-grant and create-Vault routes, OpenAPI, and production caller graph are
  unchanged. Run targeted Cargo tests, `pnpm check:server`, `pnpm check:ci`,
  `pnpm check:ci:rust`, and `git diff --check`.
