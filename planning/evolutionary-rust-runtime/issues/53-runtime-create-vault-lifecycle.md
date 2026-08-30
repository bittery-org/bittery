# Add the durable Runtime create-Vault lifecycle behind the gate

Type: task
Status: ready-for-agent
Blocked by: 52
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#2026-08-30--final-web-item-and-import-frontier-resolved)

## Outcome

Client Runtime owns durable create-Vault acceptance, optional image staging, retry, exact replay,
authoritative reconciliation, receipts, and cleanup through adapter/in-memory tests, while
production create-Vault dispatch remains unreachable.

## Work

- Add the closed request with explicit Account, bounded trimmed name, personal/shared type, icon,
  and optional opaque image-source capability. Rust generates the Operation ID, Vault ID, Vault key,
  version-1 wrapped key, request fingerprint, and retry state.
- For an image, consume Ticket 51's exact published artifact before one guarded acceptance commits
  the immutable intent and `PendingVaultCreation`. Accepted work never reads the host capability
  again. Image-free work freezes its final body at acceptance.
- Persist `artifact_ready`, `remote_upload_confirmed`, and `final_request_frozen`; use Ticket 52's
  exact status/grant/confirmation binding; stage the deterministic object; and freeze the final PUT
  only after exact confirmation. Grant URLs and attempts are not checkpoints.
- Implement persisted unbounded scheduling, one-renewal recovery cycles, exact PUT replay, tagged
  outcome validation, bounded authoritative Vault/key fetch, guarded applied/rejected receipts, and
  durable local/remote cleanup obligations. Preserve accepted work across Lock, restart, Sign-out,
  response loss, and caller cancellation; integrate explicit Remove/Wipe teardown.
- Expose Rust-defined generated bindings and a shared client facade, including a derived
  multi-Account writable-Vault catalog. Keep production dispatch closed and leave every reachable
  legacy caller untouched.

## Path ownership and failure domain

This slice owns create-Vault policy in
`packages/client-runtime/crates/bittery-client-core`, narrow binding/generated protocol additions,
Replica/conformance histories, and `packages/client-runtime/src/client`. It may consume the fixed
artifact/source and test staging ports but does not edit their implementations. It owns local
acceptance, scheduling, validation, reconciliation, and cleanup-obligation failures. It must not
change `apps/server` public routes/OpenAPI, `packages/core` create services, `apps/web`, Desktop,
Mobile, Extension, or production Worker dispatch eligibility.

## Verification

- Start with failing shared histories for ID/key ownership, exact wrapping, image/no-image
  acceptance, artifact publication/acceptance crashes, every checkpoint, restart, Lock, Sign-out,
  Remove, Wipe, caller cancellation, more than five failures at every exchange, response loss,
  exact/changed replay, every semantic rejection, stale guarded commit, and cleanup failure at every
  primitive.
- Prove one Session renewal across each complete recovery cycle, second-401 reauthentication
  parking, no Operation outcome before final body, no host capability after acceptance, no key/image
  plaintext projection, and convergence of local/remote orphans.
- Prove production dispatch and all legacy callers remain unreachable. Run focused Core/binding/
  adapter/conformance/generator/client tests, affected type checks, `pnpm check:ci`,
  `pnpm check:ci:rust`, and `git diff --check`.
