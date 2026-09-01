# Atomically cut create-Vault over to Server and Web Runtime ownership

Type: task
Status: resolved
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

## Comments

### 2026-08-31 — Import target creation parks before Ticket 55

The Import create-target branch accepts the new Vault only through the Runtime in this ticket, but
does not continue through the transitional Core importer. The Runtime deliberately projects no
Vault-key plaintext, and Ticket 54 does not preempt Ticket 55's durable `import_items` ownership.
After Vault acceptance, Web therefore retains the still-unaccepted Import draft and presents an
explicit parked state until Ticket 55 can resume it through the Runtime. It must not report Import
success, lose the draft, or fall back to the legacy Vault writer or key path.

### 2026-08-31 — ready for agent

Ticket 53 is resolved in commit `17c23478` with independent approval and complete Rust/generated
verification. It is this ticket's sole declared dependency, and the parent Ticket 28 E6 frontier is
already decision-complete. The existing `ready-for-agent` status is therefore now fully unblocked;
implementation must still preserve this ticket's atomic Server/Web cutover and whole-repository
reachability gate rather than opening only part of the production path.

### 2026-09-01 — resolved

Commit `08684f43d72e801398f85e8a8560b11f5e735541` atomically replaces the create-Vault Server and Web
path with the durable Runtime `create_vault` Operation. It delivers retained applied and rejected
outcomes, exact image-staging and upload binding, durable retry/recovery/reconciliation and cleanup,
the shared writable-Vault catalog and Web create wrappers, and the explicit parked Import-target
state. The legacy Core writer and native create affordances are removed, Extension has no caller,
and the executable production-entry graph closes the remaining legacy reachability paths.

The final corrections preserve no-spin parking, browser-valid signed uploads, in-transaction User
and Team authority, canonical input validation, exact rollback and contention histories, Extension
popup reachability, production-presigned Chromium verification, and closed correlated Rust-defined
staging MIME/status contracts in generated consumers. Independent final standards and specification
reviews both approved the implementation with no remaining findings.

Final green gates were: Server create 17/17; Runtime recovery 26/26 plus lock 1/1; Import parking
Chromium 7/7; graph/wiring 9/9; generator 7/7; `server_contract` 4/4; `contracts:check`;
`pnpm check:ci:rust`; canonical Chromium 20/20 across nine files; root Chromium wiring 4/4; targeted
Biome; and `git diff --check`. Root `pnpm check:ci` is not claimed green: it stopped solely on the
preserved Ticket 58 Web/Item/Attachment host-cutover errors, while the Ticket 54-targeted checks
passed.
