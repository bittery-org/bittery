# 101 — Runtime recipient key verification

Type: task
Status: ready-for-agent
Blocked by: 100, 105, 107

## Scope

Implement [mandatory recipient key verification](../recipient-key-verification.md) in the existing
Rust Runtime, with generated host contracts and all three existing Web sharing callers integrated.
Decision 100 is resolved. This capability does not establish Desktop/Extension production cutover.

## Acceptance

Use the focused specification's security/lifecycle obligations and five acceptance groups.
Start with a reproducing Core test. Do not claim the substitution issue fixed from an unused helper,
a host-only fingerprint check, or documentation changes. Preserve all unrelated migration work.

## Comments

2026-09-10: implementation started after the maintainer selected mandatory verification.

2026-09-10: Core policy, durable local verification, generated Runtime/native contracts, own-key
display and all three existing Web callers implemented. Independent review and simplification found
no remaining blocking findings. Five focused Core tests, fifteen focused host/rotation tests, the
invitation API integration test, all 163 Crypto tests and fifty generator tests pass. Generated
contracts/bindings and Web types are current; `git diff --check` passes.

2026-09-10: `pnpm check:ci` passed completely, including Chromium. `pnpm check:ci:rust` remains blocked
by unrelated formatting in `runtime/live_sync_session_lifetime_tests.rs`. A separate strict Clippy
run reports two `type_complexity` findings and one `unnecessary_filter_map` in `runtime/native_travel.rs`.
Those files were left untouched. See the specification's validation section for the checked scope.

2026-09-10: dedicated Teams sharing/rotation browser acceptance remains blocked **before recipient
verification**: after successful signup, own fingerprint display, team Vault creation, Item creation
and Attachment upload, in-app navigation to `/team` renders **No team found** instead of the Members
tab. Earlier runs also exposed the separate conversion failure and stale full-navigation/unlock
fixture assumptions; preparation now uses the real team-create UI and preserves/explicitly restores
the unlocked Runtime. No sharing assertions were disabled. The Teams/account presentation path
must be made usable before this scenario can validate the real verification prompt and rotation.
Do not close this ticket or advertise production acceptance yet. No production Desktop/Extension
cutover or released-client guarantee is implied.

2026-09-10 ownership follow-up: this blocker is related to the residual Web Team administration
scope already recorded under [78](78-cross-host-runtime-cleanup-and-conformance.md) and the
[caller inventory](../desktop-extension/runtime-inventory.md#remaining-web-policy-owners).
`TeamPage` uses the shared API client supplied by `apps/web/src/router.tsx`, whose Account snapshot
still reads the legacy `storage.getAuthToken`. Runtime Sign-in intentionally does not populate that
store, as covered by `runtime-session.test.ts`. The page then renders missing/error query data as
"No team found". Ticket84 is Desktop metadata refresh, not a migration of these Web callers.
There is no separate ready implementation ticket for this exact Team-page symptom;78 retains this
Web follow-up scope rather than authorizing credential mirroring or a generic authenticated proxy.

2026-09-22: [105](105-web-team-recipient-runtime-operations.md) is ready for the closed Runtime-owned
Team-page read after the actual browser failure was reproduced. The full caller audit also found
legacy private-key and cache dependencies in Invitation provisioning, Add-Member and Key rotation;
[107](107-runtime-recipient-provisioning-and-rotation.md) records their required shared-Core
workflow.101 waits for both capabilities and its original acceptance. Existing mandatory key
verification remains enforced; neither ticket authorizes a Session export or legacy key mirror.
