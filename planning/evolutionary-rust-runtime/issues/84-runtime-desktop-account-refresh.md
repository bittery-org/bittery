# Runtime Desktop Account refresh

Type: task
Status: resolved
Blocked by: 63, 67
Spec: ../desktop-extension/account-refresh.md

## Contract

Move the mounted Desktop Account metadata refresh and retained-Session validation into Core's
existing background driver. Preserve locked/restart revocation detection, Team display updates,
Account isolation and exact-generation retirement without exposing credentials or another host
policy owner. The linked frontier resolves routine preservation against actual callers.

## Acceptance

Test-first Core driver/observation tests with controlled Device time and HTTP/storage boundaries;
verify Session renewal/refusal, metadata publication, stale-result fences and unchanged Web
activation. Independent review, targeted Core checks and generated Server-contract drift checks
are capability evidence. Real application wiring and Server acceptance remain 66/73.

## Comments

2026-09-09: completeness audit found two authenticated production paths absent from Core despite
existing display fields and unlocked live Sync. Frontier resolved and dependencies 63/67 complete;
ready for bounded implementation. No implementation or production acceptance claimed yet.

2026-09-09 implementation evidence: the configured Desktop Core now runs Account refresh inside
its existing dispatch driver, using generated `MeResponse`, the existing authenticated transport,
and the existing Account lock lifecycle. No renderer owner was activated. Test-first failures
covered the missing startup read, missing refused-Session retirement, locked/unlocked cadence,
failed and ambiguously successful credential deletion, and two lifecycle races. The final targeted
`cargo test --manifest-path packages/client-runtime/Cargo.toml -p bittery-client-core account_refresh_tests -- --nocapture`
run passed all 15 tests, including actual same-store `Core.open` after refusal: Quick Unlock still
restores Locked access, the refused Session stays absent, and accepted Operations survive.
Controlled boundary tests also cover successful renewal, malformed/offline reads, two independent
Accounts, replacement, Lock, removal, owner close, and unchanged Web activation.

Independent root review found that a stale background refusal could register retirement intent
before proving its Session current. A reproducer held the lifecycle lock while exercising actual
DeviceSetup disclosure; another reproducer held a platform Session read across Lock and observed
an unwanted authentication refresh. Both failed before the fixes and pass after guarded intent
registration and a post-read scope check. Root re-review found no further 84 blocker. The native
authority retirement hook runs only after the same exact-current proof for background refusal.

Supporting checks: startup tests 15 passed; authenticated HTTP tests 19 passed; Server-contract
generator tests 8 passed; Core all-target Clippy with `-D warnings`, generated contract drift check,
generator Biome check, documentation link validation, and `git diff --check` passed. The existing
local-access suite initially passed 27 tests and exposed one stale driver fixture which allowed
only travel-mode HTTP. That single driver test now explicitly allows the Account metadata GET,
while retaining its strict prohibition on login/refresh POSTs; the rerun passed all 28 local-access
tests. The final Account refresh rerun after the native authority hook passed all 15 tests again.
The separately
recorded real native/Server four-process recovery acceptance also ran
with this lane enabled, but does not prove periodic metadata or revocation behavior in the Desktop
UI. Required full phase CI and actual Desktop wiring/OS/UI acceptance remain with 66/73; this
ticket does not claim them from controlled capabilities.
