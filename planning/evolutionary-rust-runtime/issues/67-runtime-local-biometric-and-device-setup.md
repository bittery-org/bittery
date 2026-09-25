# Runtime local biometric unlock and device setup

Type: task
Status: resolved
Blocked by: 63
Spec: ../desktop-extension/native-capabilities.md#local-access-contract

## Contract

Move existing Desktop biometric enrollment, unlock availability, password re-entry, auto-lock policy and scoped device-setup disclosure into shared Core. Preserve existing wrapped material, OS-keychain Session persistence, one prompt for explicit unlock-all Accounts and per-Account partial results. The OS adapter only reports availability and performs a cancellable prompt; Core owns every access transition. Device setup preserves the current QR/link format without exposing a general credential-storage interface.

## Acceptance

Pin legacy re-entry/grace boundaries and cancellation/lock/remove races; no biometric Server Session creation or new login secret. Generate all added closed protocol values and verify Core/native capability contracts. Production caller wiring belongs to ticket 66; real supported OS prompt, restart, local offline access and Account isolation remain mandatory ticket 73 production acceptance gates. These later gates do not make the capability depend on the renderer that consumes it.

## Comments

2026-09-08: local-access frontier resolved from ADR 0015 and actual storage/unlock/autolock callers;
the linked specification records exact legacy boundaries, scoped commands, OS capability ownership
and real-host acceptance. Core/native capability implementation depends on foundation 63, not UI
ticket 66; it can now proceed independently. Actual UI cutover and supported-OS evidence remain
explicit acceptance gates and are not replaced by capability doubles.

2026-09-09: native prompt primitive implemented in the pinned `tauri-plugin-biometry` 0.2.8
[vendor patch](../../../apps/desktop/src-tauri/vendor/tauri-plugin-biometry/BITTERY-PATCH.md), retaining
its MIT license, published-crate checksum and upstream commit. Existing authenticate callers remain
compatible; macOS cancellation invalidates the retained LAContext and drains the evaluation callback,
while Windows cancellation retains its verification operation and observes completion. Typed
`Error::code()` replaces native Display-text parsing. The adapter
[biometry.rs](../../../apps/desktop/src-tauri/src/runtime_host/biometry.rs) forwards Core cancellation
and future Drop to the primitive and keeps its semaphore permit in the blocking native job until
completion. No plugin data-store API is called. The copied macOS/Windows data-store and cryptographic
method bodies are byte-identical to the published crate.

Actual evidence for this bounded capability slice:

- Plugin cancellation/drain test reproduced red (native cancellation was never requested), then
  all three plugin unit tests passed, including typed error codes and disconnected callbacks:
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -p tauri-plugin-biometry --lib`.
- Native dropped-awaiter test reproduced red, then all four native biometric adapter tests passed:
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib runtime_host::biometry::tests`.
  Real threads and task cancellation prove permit/drain ownership here; the OS callback is
  controlled, so these are not biometric hardware acceptance results.
- Plugin `cargo check` passed for both `x86_64-pc-windows-gnu` and `aarch64-apple-darwin`, using
  `--manifest-path apps/desktop/src-tauri/Cargo.toml -p tauri-plugin-biometry --lib --target <target>`.
  The first Apple check failed because Linux GCC rejects Apple target flags. A temporary extracted
  Clang 19/llvm-ar toolchain fixed that tooling prerequisite, and the real macOS source then checked
  successfully. Four upstream deprecation warnings remain in unchanged legacy keychain methods.
- Independent review confirmed callback draining, late-success rejection and permit ownership;
  review also found that Windows' `get()` fallback could repeat a failed callback registration.
  The fallback now observes terminal operation status directly after requesting cancellation.

Acceptance remains open: the production renderer is not cut over by this primitive; actual macOS
Touch ID and Windows Hello prompt dismissal, supported-OS restart/offline unlock, enrollment changes,
Account isolation, and Desktop–Extension lock behavior require real application evidence. Windows
cancellation is an OS request and must be observed on the supported application; cross-compilation
and controlled callback tests do not prove it. This entry does not close ticket 67 or substitute for
its Core policy, device-setup, UI and full CI gates.

2026-09-09: shared Core capability completed and independently reviewed. Core now owns biometric
enrollment and local release using retained Session material, password re-entry/grace boundaries,
explicit multi-Account password/biometric unlock with partial results, per-Account inactivity
preferences and Core-clock activity receipts, and scoped device-setup disclosure. Existing wrapping
algorithms, persisted ciphertext and QR/link format are unchanged. Shared Account display identity
projects existing metadata. Automatic inactivity activation is scoped to configured Desktop; it
does not introduce a second timer into the still-transitional Web host. Existing profile preference
and credential admission is tracked separately in ticket 82 before Desktop startup cutover.

Device-setup conversion reuses Core's existing guarded delivery lease; stale retained responses
fail after pending retirement, lock or Account replacement. Biometric preflight registration and
Account replacement share generation retirement, so stale work cannot start or retain a prompt.
Unavailable or changed Travel authority fails closed; the actual hidden-Vault erasure capability
remains ticket 71. Hosts neither decide key release nor implement an alternate password ceremony.

Actual verification, with final source distinctions preserved:

- All 28 Core local-access tests passed, including four independently reported lifecycle races
  reproduced red before their fixes: pending Lock disclosure, enrollment against a replacement
  Account, stale preflight starting a prompt, and Account replacement failing to cancel its prompt.
  Command: `cargo test --manifest-path packages/client-runtime/Cargo.toml -p bittery-client-core --lib runtime::authenticated_installation_tests::biometric -- --nocapture`.
- The full Core suite passed 768 tests before those final four regression tests and fixes. This is
  useful earlier evidence, not a claim that the final expanded suite or phase-wide CI has run.
- Final Core and bindings all-target Clippy passed with warnings denied:
  `cargo clippy --manifest-path packages/client-runtime/Cargo.toml -p bittery-client-core -p bittery-client-bindings --all-targets -- -D warnings`.
- Protocol and native binding generation passed. The native secret-buffer hardening tests passed
  all three cases, including the added secret disclosure return path. The final
  `pnpm --filter @bittery/client-runtime build:bindings:web` completed successfully after the
  lifecycle corrections and typed guarded-delivery failure handling.
- `pnpm exec turbo -F @bittery/client-runtime -F web -F desktop check-types` passed all 12 tasks;
  changed binding-hardening scripts passed Biome. Independent review verified the existing
  `biometric.state` then publication lock order, atomic generation publication, and absence of
  retained synchronous guards across asynchronous waits.

Ticket 67 is resolved as a shared Core/native capability dependency. Ticket 66 still owns actual
Desktop caller and trusted native primitive composition. Ticket 73 remains open for real macOS
Touch ID/Windows Hello dismissal and restart/offline behavior, the full application matrix and
final `pnpm check:ci` / `pnpm check:ci:rust` on the accumulated migration. Controlled OS callbacks,
cross-compilation, targeted tests and this capability closure do not establish those results.
