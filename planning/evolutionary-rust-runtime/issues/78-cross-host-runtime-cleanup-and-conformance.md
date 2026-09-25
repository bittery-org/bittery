# Cross-host Runtime cleanup and conformance

Type: task
Status: needs-triage
Blocked by: 77
Spec: ../desktop-extension/spec.md

## Contract

Regenerate executable whole-repository caller inventories, delete zero-caller transitional modules/exports, and compare shared SQLite/IndexedDB guarded-history behavior across migrated hosts. Retain Mobile and actual remaining Web ceremony dependencies with explicit ownership and follow-up scope.

Ticket105 owns authenticated Web Team-page reads after Runtime Sign-in stops populating the legacy
token store.107 records the remaining recipient/Rotation private-key, transport and convergence
closure. Keep those callers and their direct API-contract dependencies visible in the executable
inventory until105/107 and101 complete their migration and acceptance. These follow-ups do not
authorize credential mirroring or a generic authenticated proxy. Other Web-only Team/account
ceremonies remain separate inventory items; passing101 does not establish all Web administration.

## Acceptance

No application-local replaced owner or new copied Runtime policy remains. Shared module deletion has zero remaining executable callers, not just no direct package imports. Repeat affected real acceptance plus pnpm check:ci and pnpm check:ci:rust after cleanup, with independent review and simplification. Record residual Web/Mobile scope honestly.

## Comments

2026-09-23 residual Web ownership frontier observed during107 browser acceptance: an added
same-profile second tab performed Quick Unlock, after which the original tab's authenticated Team
reads returned401 and resend was refused before HTTP. Web's Runtime client identity comes from
`getOrCreateClientId(window.localStorage)`; Server Session creation replaces the previous Session
for the same User/platform/client ID. The accepted per-context Worker and exact Session fences do
not specify normal cross-tab Session handoff or refresh arbitration. Recovery's requirement to
close other tabs does not establish that policy for ordinary authentication.

The original invitation test used one page rather than concurrent same-profile Runtime owners.
107's bounded fixture correction uses a separate browser context, normal full Sign-in and the
same public invite-route Quick Unlock assertions, preserving independent device identity and the
admin Runtime's captured Session. This does not prove same-profile tab coexistence. Keep that
capability in the residual Web inventory and resolve its ownership/acceptance contract before
implementing it; do not weaken current Session fencing or infer a shared credential owner.

2026-09-08: dependency-ordered delivery scope recorded. No implementation or acceptance is claimed.

2026-09-09 progress checks before application cutover: root ran full `pnpm check:ci` four times.
The latest run passed the repository checks, all package type/test tasks, root script tests and the
first eight actual Chromium Runtime test files. It failed the joined Create-Vault browser fixture,
which still served the obsolete point-authority reader and refused the Bootstrap requests required
by ticket89's retained receipt/refresh contract
(`/tmp/bittery-desktop-extension-progress-check-ci-4.log`). Ticket89 owns that fixture correction and
verification of dependent Import admission. Earlier runs exposed an obsolete public-capability
assertion, an in-progress Rust declaration, and an overbroad Account-status fixture edit; those
specific issues were corrected, but none of these runs is a full CI pass.

The full literal `pnpm check:ci:rust` passed Server checks, crypto Core151/API11, Runtime formatting
and workspace/all-target Clippy, and bindings49/private-contract5 tests. Its Core suite passed867 and
failed three tests: Move artifact receipt mismatch, obsolete-generation shared Vault key retention,
and old Create-Vault point-authority failure expectations. Each requires inspection against87/89;
the gate stopped before Runtime generation checks and Desktop checks
(`/tmp/bittery-desktop-extension-progress-check-ci-rust.log`). The run used a disposable copy of the
Git index containing the current generated changes for the final Desktop drift check, which was not
reached. The real index was untouched and the disposable index was removed. No full Rust pass is claimed.

These are progress checks, not ticket78 implementation or application acceptance. Desktop's production
caller cutover and acceptance still precede Extension composition/cutover/acceptance. Final cleanup
must rerun both complete gates on its final files and retain any actual remaining Web/Mobile callers.

2026-09-09 fresh progress gate: full `pnpm check:ci` now passes (exit0), including all repository
checks, 14 package type tasks, 14 package test tasks,27 root script tests and all nine actual Chromium
files (`/tmp/bittery-desktop-extension-progress-check-ci-5.log`). The joined Worker/Core binary was
rebuilt from current source. Ticket89's final lifecycle test passes194 assertions; the separate real
Import hook passes70. The second full Rust run remains ongoing; no Rust pass or Desktop/Extension
production acceptance is inferred. New source transport generation was baselined in the disposable
index before Desktop generation checking; the real Git index remains untouched.

The second full Rust run exited1 at production Web-binding drift
(`/tmp/bittery-desktop-extension-progress-check-ci-rust-2.log`). Server checks, crypto151/API11,
Runtime formatting/all-target Clippy, bindings49/private-contract5, all880 Core tests (325.25 seconds),
physical conformance, contract generation and native bindings passed. The final Web glue differed
only in its generated closure shim-index comment; the production bundle predated the current Core
source. It is being regenerated through `pnpm build:crypto-wasm`, not hand-edited. Desktop checks were
not reached in that literal command. A separate Desktop format check found two routine formatting
differences, assigned to its owner. The disposable index was removed; no whole Rust pass is claimed.

The source freeze is ending after binding refresh so authorized70 work can proceed. Final whole-phase
`pnpm check:ci` and `pnpm check:ci:rust` still must rerun after implementation and cleanup.

Affected follow-up gates: production binding regeneration passed
(`/tmp/bittery-runtime-production-bindings-refresh.log`). Desktop formatting and all-target Clippy
passed after scoped formatting and boxing a large internal transport response enum. Full Desktop
tests passed189 library tests with4 ignored and52 native-host tests; generated Desktop drift passed
against the disposable baseline (`/tmp/bittery-native-source-desktop-tests.log`,
`/tmp/bittery-native-source-generated-drift.log`). These targeted follow-ups supplement the
failed literal Rust run; the final whole-phase gate remains required.

The regenerated production combined-Web binding regression suite passes11 with1 explicitly skipped
(`/tmp/bittery-production-combined-bindings-regressions.log`), without rebuilding against later70
source edits. This validates the refreshed pre70 binding artifact; it is not the final source gate.
