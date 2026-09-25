# 105 — Restore Web Team reads through the Runtime

Type: task
Status: resolved
Blocked by: 100
Spec: ../web-team-recipient-runtime.md

## Contract

Restore the current Team page through the existing Runtime's closed authenticated read interface.
Core owns Session use, request construction, bounded pagination and current Account/caller fences.
Web consumes generated typed results for Team details, Members, Invitations and entitlement
presentation. No credential export, general authenticated proxy or legacy credential mirror.

## Acceptance

Follow the focused specification's public Core lifecycle tests and actual Runtime Sign-in → Team
page browser regression. Preserve current role/entitlement conditions and distinguish failed reads
from an absent Team. Regenerate contracts, run affected types/tests, independent review and
simplification, then both full CI commands before closure.

This ticket supplies the first complete read path needed by101. Private recipient provisioning,
Key rotation and their authenticated mutation closure remain107. The full Teams/recipient browser
matrix remains outstanding until that capability is implemented; do not count this read as its
acceptance or remove the remaining transitional callers.

## Comments

2026-09-23 resolved after independent review, actual Runtime Sign-in → Team-page acceptance
and the joined95/105 literal application and Rust CI gates, both exiting0. Exact source, full
counts and immutable log hashes are recorded on
[95](95-private-credentials-and-public-item-commands.md#comments). Core-owned Team reads now
replace the failed legacy Session-dependent path while keeping failed reads distinct from an
absent Team. This completes107's final dependency; recipient provisioning, Rotation and101's
full browser matrix remain required work and are not covered by this read-path closure.

2026-09-23 joined application CI passes on the reviewed95/105 integration source: all type and
package-test tasks, 27 script tests and 63 actual Chromium cases across 12 suites. The literal
command and immutable log hash are recorded on [95](95-private-credentials-and-public-item-commands.md#comments).
The corrected literal Rust gate is still running. Ticket105 and its dependent107 remain gated
until that full run passes; no recipient mutation or Rotation acceptance is inferred here.

2026-09-22 actual browser RED: `pnpm --filter web test:e2e --project=cloud teams.spec.ts -g
'the Team plan signup names the team'` exited1 after successful test setup and Runtime Sign-in.
The test failed at `openTeamPage` waiting for the Members tab; its page snapshot contains
`No team found`. Evidence: `/tmp/bittery-runtime-105-team-page-baseline.log` and the local
`apps/web/test-results/teams-the-Team-plan-signup-84dc7-e-team-the-new-account-owns-cloud/` report.

Coordinating review of the independent caller audit found the larger proposed transport-only
closure incomplete: `InviteDialog`, `AddMemberDialog` and `useVaultKeyRotation` still require
legacy private-key and cache owners. The focused specification records this finding and the
derived read-only frontier.105 is ready with its completed100 prerequisite;107 retains every
unimplemented provisioning/rotation obligation. No105 production implementation is claimed yet.

2026-09-23 implementation checkpoint (worktree snapshot
`683cdcdbab44e4917f3c8833ec156d6b620a6440`): the closed Account-scoped Team-page read is
implemented through Core Session HTTP, generated typed protocol, and the existing Web Team page.
Focused Core lifecycle tests passed 8/8 (`/tmp/bittery-runtime-105-core-tests-retry.log`), and
the real Runtime Sign-in → Team browser regression passed 1/1
(`/tmp/bittery-runtime-105-team-page-e2e-fresh-wasm.log`). The browser used newly built WASM
SHA-256 `935358c3fe547e65f04e880105edd318de08150b0a79ff0336dc200bc40dfa5a` (2026-09-23
00:30:30 CEST); an earlier run with the September 21 WASM artifact failed as expected. The
client-runtime type check and 492 Bun tests passed. Independent review, joined ticket95
regeneration/integration, and `pnpm check:ci` plus `pnpm check:ci:rust` remain before closure.
This checkpoint does not claim ticket107 mutations or the full Teams/recipient matrix.

2026-09-23 independent review follow-up: the Runtime Team result now carries the Server-generated
closed `InvitationStatus` and `ErrorCode` enums into the generated TypeScript contract; no fallback
string conversion remains. The structured `teamPageProblem` stays an optional field on the
existing `RuntimeError` failure outcome because cancellation, authentication and transport already
use that one channel. A Team-specific response-error envelope would create a parallel failure path
for the same read and leave existing callers without one consistent error owner. The optional
field is present only for a parsed Team API problem; other Runtime errors leave it absent.
Independent re-review and joined full CI remain before changing ticket status.

2026-09-23 review-fix checkpoint (combined worktree tree
`c19373f0cc39aa13bf4a109ac7ac0e41e84579bc`): Server-generated closed
`InvitationStatus`/`ErrorCode` types now carry through the generated Runtime contract; the
Team-page result/problem are boxed in Rust to keep the shared outcomes small without changing
their JSON shape. The list kind and read lifetime are explicit, and held-read tests release their
mutex before asynchronous teardown. The combined Runtime contract generator and 19 contract
tests passed; Server generator tests passed 8/8; Team Core tests passed 8/8; dependent Web type
checks passed 11/11; strict Core all-targets Clippy passed with `-D warnings`.
`git diff --check` passed. The previously recorded fresh-WASM Team browser case remains 1/1;
these review fixes preserve its wire values and shape. Independent follow-up review found no
further issue. Joined full CI is still required before resolution.
