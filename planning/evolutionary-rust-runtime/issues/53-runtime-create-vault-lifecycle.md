# Add the durable Runtime create-Vault lifecycle behind the gate

Type: task
Status: resolved
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

## Comments

### 2026-08-31 — resolved

Commit `17c23478` adds the durable `create_vault` lifecycle behind the production-dispatch gate.
Rust owns the stable Operation and Vault identities, Vault-key generation and version-1 wrapping,
immutable accepted intent, optional Ticket 51 artifact adoption, the three persisted staging
checkpoints, and exact final-request replay. Persisted unbounded scheduling shares one Session
renewal per recovery cycle and parks on a second 401. Applied and rejected outcomes reconcile
through bounded authoritative Vault and Vault-key reads into guarded authority, closed receipts, and
durable local or remote cleanup obligations. Lock, restart, Sign-out, caller cancellation, response
loss, and repeated transport failure retain accepted work; explicit Remove and Wipe perform
best-effort deduplicated remote cleanup before unconditional local destruction.

The closed Rust-defined protocol, generated Kotlin/Swift/Web shapes, Replica histories, and shared
client facade expose acceptance and the derived multi-Account writable-Vault catalog without
projecting key or image plaintext. Production dispatch remains closed, and the legacy Server route,
OpenAPI, Web, Desktop, Mobile, Extension, and reachable create-Vault callers remain unchanged for
Ticket 54. Final independent review reported **APPROVED — no severity findings** after verifying the
raw-only 4 MiB pre-decode authority-page seam and complete pagination bounds, centralized immutable
validation across guarded, serialized, and real-SQLite paths, exact boundary cases, and every prior
resource-reference, receipt, cleanup, coexistence, retry, teardown, authority, binding, redaction,
and closed-dispatch finding.

The final `pnpm check:ci:rust` passed end to end: Server format/clippy/check; 139 Crypto Core tests
plus nine vectors; 48 binding tests plus five generated-contract tests; 577 Client Runtime Core
tests plus five artifact-API, three Replica-conformance, and three Server-contract tests; 34
generator tests; all generated native/Web checks, including the Web harness's 10 passes and one
intentional skip; and Desktop's 89 application plus 50 native-host tests and generated diff. Final
`check:generated` and `git diff --check` passed. The last focused correction passed 37/37
create-Vault tests, 6/6 raw-authority matrix tests, and 16/16 SQLite tests; the already approved
teardown group passed 20/20, and the complete historical matrix is included in the 577 Core tests.
Root `pnpm check:ci` was not rerun after the final correction: an earlier run stopped only on the
preserved Ticket 58 Web/Biome overlap, so this ticket does not claim a clean-tree root CI pass.
