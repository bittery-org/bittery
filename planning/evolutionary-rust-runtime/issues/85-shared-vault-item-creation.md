# Runtime Item creation in writable shared Vaults

Type: task
Status: resolved
Blocked by: 21, 28, 60
Spec: ../desktop-extension/shared-vault-item-create.md

## Contract

Preserve Desktop creation and duplication of all five Item categories in writable shared Vaults
through the existing Core creator. Remove the obsolete first-slice personal-only restriction while
retaining current authority, role, wrapper context, Account key and durable acceptance checks.
Support existing RSA member wrappers through the same Core key opener and all current consumers;
retain encrypted private-key envelopes in the existing live Account key lifetime.

## Acceptance

Test-first existing Core request/encryption/Replica/projection paths, writable roles and categories,
read-only/hidden/foreign-key refusals, targeted regressions and independent review. Actual Desktop
and Server acceptance remain 66/72/73; the spec records the capability boundary.

## Comments

2026-09-09: actual Desktop route, shared hook/command, Core admission and wrapped-key consumers
inspected. Frontier resolved by reusing the existing creator and formats. Dependencies 21/28/60
are resolved; ready for bounded implementation. No implementation acceptance claimed yet.

2026-09-09: MUK-backed vertical reproduced the obsolete type restriction, then passed all 50
`create_tests` (one test covers 20 category/role combinations). Root independently reviewed that
bounded diff. Final actual-wrapper audit found RSA member wrappers in the legacy production path;
the focused spec is refined before further implementation. Ticket remains ready/in progress, not
resolved. Core Clippy currently reports the enlarged ticket-70 OperationRecord enum; root is boxing
the new optional intent. No actual shared-member or Desktop production acceptance claimed.

2026-09-09: RSA member capability reproduced a real behavioral failure after Core Account
installation (`wrapped Vault key is invalid`, run 75495). The shared opener now delegates both
existing formats to crypto-core; its encrypted private-key envelope follows the existing live
Account/incarnation entry through sign-in, password unlock, biometric unlock and native transfer.
All Bootstrap/Item/Import/Attachment/Move consumers share it. Bootstrap and foreground error
mapping is preserved; a missing live Account key remains typed `AuthenticationRequired`.

The widened public request test passed (35133): actual SRP fixture sign-in, RSA-4096 member
Bootstrap Item read, all five categories accepted and decrypted, Lock refusing Item projection,
new Runtime opening Locked, password Quick Unlock restoring authority and all five exact accepted
Operations. This is controlled Core/transport capability evidence, not a real Server or Desktop UI
acceptance claim. Root independently reviewed the shared crypto recipe, encrypted-envelope
lifetime, all publication paths and consumers; no remaining review finding.

Crypto workspace tests passed (57156): 151 crypto-core tests and 11 API format tests, including
Core/API RSA wrapper compatibility with legacy and contextual private-key envelopes, wrong-key
refusal and exact 32-byte key length. Crypto workspace all-target Clippy passed (84135); Runtime
Core all-target Clippy passed (24232). Full Core unit tests are running; final outcome is recorded
below before resolution. Broader required phase CI and real Desktop/shared-account acceptance
remain 66/72/73.

2026-09-09: Full Core unit run 96136 completed: **816 passed, 1 failed** out of 817, including the
RSA member integration passing. The sole failure is ticket 68's deliberately reproduced
`native_retirement_intent_discards_borrowed_material_even_if_caller_drops_wait`, whose fix is in
progress in the parallel native-authority lane. The unrelated dispatch restart fixture correction
passed. Log: `/tmp/bittery-shared-vault-core-tests.log`. Ticket 85 remains ready/in progress until
the broad Core gate is rerun against the completed lifecycle fix; no all-green suite or phase
acceptance is claimed. Formatting, relative planning links and `git diff --check` pass.

2026-09-09 capability closure: the subsequent accumulated Core snapshot (run 10157) passed 819 tests,
including the actual RSA-member path and all fourteen native-transfer lifecycle regressions. Its only
two failures were the intentionally reproducing ticket-87 tests for old-generation Vault authority
and stale Session writeback; the latter has since passed its fix and all 17 Account-refresh checks.
The ticket-68 failure that held this capability open is fixed and passed in this accumulated run.
Together with the targeted crypto/Core checks and independent review above, this resolves 85's
capability. It does not claim a wholly green current Core worktree, full root CI, or actual Desktop
shared-Vault acceptance; ticket 87 implementation and later production gates remain open.

2026-09-09 current full-Rust regression follow-up: the old-generation key test still expected an
absent Vault's wrapped key to remain after complete Bootstrap. That expectation conflicts with87's
now-implemented all-generation erasure. The test now proves the original key existed, complete
Bootstrap removes it, the exact Vault cleanup duty remains durable, and public CreateItem returns
AccessDenied without accepted work or plaintext. The targeted test passed
(`/tmp/bittery-shared-vault-bootstrap-retirement-green-3.log`). Its first revised assertion also
exposed the intended AccessDenied versus historical InvariantViolation classification; no production
code was changed to satisfy the fixture. Full Core/root gates still require rerunning after89 fixes.
