# Add the Server Vault-image staging foundation

Type: task
Status: resolved
Blocked by: 51
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#2026-08-30--final-web-item-and-import-frontier-resolved)

## Outcome

The Server can durably bind, grant, confirm, inspect, expire, and clean one deterministic
User/Operation-scoped Vault-image staging object behind a test transport, while public routes and
all reachable create-Vault callers remain unchanged.

## Work

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

## Path ownership and failure domain

This slice owns a new immutable migration, staging Domain/repository code under
`apps/server/src/domains/vaults`, the necessary object-store integration primitives under
`apps/server/src/integrations`, and lease/cleanup job code under `apps/server/src/jobs`, plus
Server-only tests. It owns database/object-store binding, quota, lease, and cleanup failures. It does
not own public HTTP/OpenAPI, Runtime code, Web/host code, or create-Vault finalization.

## Verification

- Start with failing Server tests for exact replay, changed binding, all quota edges including
  64/128-MiB inclusive limits, lease renewal by each and only each allowed exchange, expiry,
  generation fencing, length/digest/content-type mismatch, and every database/object-store failure.
- Prove exact replay consumes no extra quota, an expired row cannot let delayed cleanup delete a new
  generation, cleanup converges after restart, and no semantic outcome is retained.
- Prove the public image-grant and create-Vault routes, OpenAPI, and production caller graph are
  unchanged. Run targeted Cargo tests, `pnpm check:server`, `pnpm check:ci`,
  `pnpm check:ci:rust`, and `git diff --check`.

## Comments

### 2026-08-31 — resolved

Commit `28e69e0c` adds private Server Vault-image staging bound immutably to User, Operation, Vault,
canonical object key, lowercase digest, exact length and MIME, state, and generation. Exact grant,
status, and confirmation renew a rolling 24-hour lease from the authoritative database clock;
upload traffic, mismatched confirmation, and cleanup do not. Exact exchanges replay idempotently,
changed bindings fail as `OPERATION_ID_REUSED`, and no staging path records a semantic Operation
outcome. Exact upload credentials and confirmation bind length, MIME, SHA-256, and the provider
checksum.

Per-User advisory locking serializes concurrent quota admission and exact replay. The inclusive
64-slot and 128-MiB limits are enforced together; because every valid image is at most 2 MiB, 64
maximal valid rows are mathematically exactly 128 MiB, while separate small-row and concurrent-edge
tests prove the slot limit independently. Durable generation identity fences expired-unconfirmed and
`cleanup_pending` deletion from later reuse. Database mutation, deferred-commit, object credential,
HEAD/confirmation, delete, restart, generation-advance, and concurrent replay/quota failure matrices
all preserve exact retry authority and converge without generation drift.

The implementation remains behind private Domain/repository and test transport seams. It adds no
public route, OpenAPI or API-contract change, reachable create-Vault caller change, Runtime/Web/host
behavior, or create-Vault finalization. Fresh independent review reported **APPROVED** after the
database-clock, concurrent-quota, quota-equivalence, generation, and failure-matrix corrections,
with no remaining Ticket 52 finding.

Verification passed 23/23 focused staging tests and 13/13 storage tests, `pnpm check:server`,
`pnpm --filter server check`, `pnpm run db:check`, `pnpm run contracts:check`, and
`git diff --check`. `pnpm check:ci:rust` passed with exit 0, including 139 Crypto Core tests, 526
Runtime Core tests, 48 binding tests, 34 generator tests, and Desktop's 89- and 50-test suites. Root
`pnpm check:ci` stopped only on preserved Ticket 58 Biome diagnostics, so this ticket does not claim
a clean-tree root CI pass. The full Server suite passed 489/490; the sole failure was the pre-existing
Attachment Move authority expectation, reproduced in isolation, and independent review confirmed
that Ticket 52 has no call-graph relation to it.
