# Atomically cut create-Vault over to Server and Web Runtime ownership

Type: task
Status: ready-for-agent
Blocked by: 53
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#2026-08-30--final-web-item-and-import-frontier-resolved)

## Outcome

The existing create-Vault PUT, Server image grant, Web Vault dialog, and Import create-target branch
switch atomically to the durable Runtime `create_vault` contract; no legacy create writer is
reachable anywhere in the repository, and incompatible Desktop/Mobile affordances are explicitly
absent until their later host slices.

## Work

- Replace the existing PUT in place with the `create_vault` Operation executor. Require the exact
  confirmed staging row/key for image creation and atomically commit Vault, owner key, audit,
  `vault_created`, retained outcome, and `operation_resolved`; mark rejected staging cleanup in the
  same decision transaction.
- Evolve the public staging/status/grant/confirmation/cleanup OpenAPI in place and open Ticket 53's
  production Runtime transport/scheduling. Do not retain a legacy request/response or parallel
  route.
- Route both Web creation callers through `packages/client-runtime/src/client`; remove
  `packages/core/src/hooks/vault/use-create-vault.ts` and the underlying shared create service,
  refresh, invalidation, and cache-repair reachability.
- Remove or explicitly disable the create actions in `apps/desktop` and `apps/mobile`; do not leave
  a visible broken button. Confirm `apps/extension` has no create caller. Their Runtime UI returns
  only in the later host slices.
- Extend an executable whole-repository entry graph from all Web, Desktop, Mobile, Extension, and
  shared-package production entries. It must follow re-exports, lazy/dynamic imports, CommonJS,
  side-effect imports, and type/value ambiguity conservatively and fail if any legacy create writer
  or caller survives. This gate lands in the same atomic commit.

## Path ownership and failure domain

This vertical slice owns the create executor/public routes in `apps/server/src/domains/vaults`,
OpenAPI and `packages/api-contract` generation, production Runtime transport/composition under
`packages/client-runtime`, Web Vault/import create-target wiring, the exact retired
`packages/core` create paths, Desktop/Mobile affordance removal, and the whole-repo reachability
gate. It owns atomic route/caller compatibility, Server transaction, production staging, and host
cutover failures. It does not implement native Runtime creation, Extension placement, Import batch
execution, or unrelated Web mutation cleanup.

## Verification

- Start with failing Server and browser acceptance for personal, shared/team, image, and Import-
  default creation; all rejections; pre-accept cancellation; response loss before/after commit;
  restart at every staging checkpoint; more than five upload failures; Sign-out recovery; and
  Remove/Wipe cleanup.
- Prove exact replay/fingerprint behavior, authoritative Vault/key reconciliation, quota and lease
  behavior, no retained outcome before confirmed staging, and local/remote orphan convergence.
- Run the executable whole-repository entry gate and prove Desktop/Mobile affordances are absent and
  Extension has no caller. Run Server/OpenAPI/generator checks, focused actual-browser acceptance,
  affected type/tests, `pnpm check:ci`, `pnpm check:ci:rust`, and `git diff --check`.
