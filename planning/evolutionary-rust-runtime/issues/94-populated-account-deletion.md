# Preserve populated owned-data cascade during Account deletion

Type: task
Status: resolved
Blocked by: 48
Spec: ../desktop-extension/account-deletion.md

## Contract

Correct the existing authenticated Server deletion transaction so a personal Account with owned
Vaults and Items can be deleted. Explicitly finish the already-authorized owned-Vault cascade before
removing the User, while retaining current authority, Team blocking, proof/fingerprint, replay,
audit and rollback semantics. No new route, schema, cryptographic format or broader foreign-data
cleanup policy is introduced.

## Acceptance

Make the existing 500 reproducer pass through the real isolated PostgreSQL/router fixture, verify
unrelated Account isolation and exact replay after User removal, then run the original deletion and
rollback matrices. Rerun actual native two-Account transport acceptance with completed scoped Server
and local teardown. Run affected Server checks and parent full CI gates; compilation or simulated
cleanup does not resolve this ticket.

## Evidence and readiness

2026-09-09: native run5 observed actual DELETE `/api/v1/users/me` 500 for both test-created personal
Users (`/tmp/bittery-native-source-real-accounts-e2e-5.log`). The isolated test
`account_deletion_removes_populated_personal_ownership_and_replays` reproduced 500
(`/tmp/bittery-populated-account-deletion-red-2.log`). Scoped test tracing identified
`item_last_modified_by_user_id_fk` at User deletion (`/tmp/bittery-populated-account-deletion-diagnosis.log`).
The pre-existing owned-Vault cascade defines the exact target set, so ordering those same writes
needs no new product decision. Ticket 48 is resolved. This corrective slice blocks ticket 68's actual
cleanup acceptance; it does not reopen unrelated completed Account refresh work in 84.


2026-09-09 implementation evidence: the narrow owned-Vault deletion inside the existing transaction
made the original real PostgreSQL/router reproduction pass (27856,
`/tmp/bittery-populated-account-deletion-green.log`). Expanded final matrix passed 16 tests (81389,
`/tmp/bittery-populated-account-deletion-matrix-3.log`): populated personal User/Team/Vault/key/Item and
Attachment metadata deletion, exact post-removal replay, unrelated populated Account and Session
survival, forced User-delete rollback restoring owned Vault/Item/Attachment, and foreign-reference
failure preserving both ownership scopes without a retained outcome. Existing blocking, concurrency,
telemetry and auth/session deletion cases passed too. Intermediate fixture checks exposed a wrong
HeaderMap argument and a nonexistent GET route; both fixtures were corrected before this final run.

`pnpm check:server` (71992), Server format check, all-target/all-feature Server Clippy (31886), and
`git diff --check` passed. Parent independently reviewed the existing foreign keys and exact query:
the target set and retained transaction contract are unchanged. Temporary scoped diagnosis tracing
was removed. The original native two-Account source acceptance rerun awaits the exclusive Server
window, and full phase CI remains with the parent; this ticket is not yet accepted.

2026-09-09 original native acceptance rerun passed: fresh run7
(`/tmp/bittery-native-source-real-accounts-e2e-7.log`, one selected case, 3.7 minutes) drove two
populated real Server Accounts through the actual native binary and separate Core/SQLite consumer.
Both authenticated `DELETE /api/v1/users/me` requests returned200. The test required completed scoped
Server deletion and local Runtime teardown before deleting its isolated profile and credentials;
helper PID794971 and native-host PIDs795779/795790 exited cleanly. Run6 had already observed both
deletions200 but failed an unrelated initial-transfer fixture expectation, corrected under the existing
ticket68 contract. No additional Server policy change was required. Targeted Server and original
native acceptance gates are complete; the parent still owns the literal full phase CI gates before
this ticket closes.

Final source run8 also passed on the current worktree
(`/tmp/bittery-native-source-real-accounts-e2e-8.log`, one actual case, 3.3 minutes), with both real
deletions200 and separate source/consumer cleanup proof before profile removal. Helper PID817617
and native PIDs818722/818733 exited cleanly. The added consumer marker preserves failed local
teardown evidence independently of successful Server/source cleanup; parent fixture review passed.

2026-09-09 bounded closure audit: the current Server still performs only
`DELETE FROM vault WHERE created_by_id = <authenticated User>` immediately before User deletion in
the existing retained transaction. The real populated/isolation/replay, foreign-reference refusal
and forced post-Vault-deletion rollback fixtures remain in the original auth test matrix. Their
16-case green, Server checks and run8's two actual successful User deletions plus separate scoped
source/consumer cleanup establish this ticket's targeted acceptance. This proves database Attachment
metadata cascade, not an added object-storage garbage-collection capability or broader foreign-data
deletion policy. No additional targeted capability work was identified; only the parent's literal
full phase CI gates remain before closure. Production Tauri/Chrome acceptance is outside94, and68's
separate framed cancellation coverage does not reopen this deletion correction. No heavy checks or
production changes were made in this documentation audit.

2026-09-09 capability phase completed: literal `pnpm check:ci` passed in
`/tmp/bittery-desktop-extension-progress-check-ci-10.log`, and literal `pnpm check:ci:rust`
attempt7 passed in `/tmp/bittery-desktop-extension-progress-check-ci-rust-7.log`.
[The phase record](93-protected-vault-image-artifact-storage.md) details full-suite counts,
opt-in test limits and generated-binding verification without modifying the real Git index.
Together with this ticket's recorded actual Server/native histories and independent review,
these checks resolve its capability scope. Production Desktop/Chrome/supported-OS acceptance
remains in the application tickets; this closure does not claim a production caller cutover.
