# Desktop native binary and recovery capabilities

Type: task
Status: resolved
Blocked by: 63
Spec: ../desktop-extension/native-capabilities.md#native-files-contract

## Contract

Compose existing Core Attachment upload/download/move, Vault-image ingress, durable encrypted artifacts, Account leases, recovery transfer and teardown cleanup with native files/SQLite. Reuse Core binary contracts and stores; hosts supply bounded file sources/sinks and exact transport only.

## Acceptance

Actual native/Core/Server Attachment upload/download/rename/delete and Move survive supported
offline/restart/reconnect paths using real filesystem capabilities. Cancellation and teardown retire
scoped files; no cross-Account reuse. Native encrypted recovery export/repair/re-Bootstrap preserves
accepted work and reports partial/blocked state honestly. Ticket 66 activates renderer/file-dialog
routes after these capabilities pass; tickets 72/73 verify the production Tauri application and
supported platforms. UI acceptance is not a prerequisite of this capability ticket because 66 depends
on 69; both layers remain required for application acceptance.

## Comments

2026-09-08: native-file frontier resolved by actual Core store/facade inventory. Reuse the existing
SQLite attachment/image stores and shared scheduling; only native primitive adapters are missing.
The linked specification fixes source/sink authority, process leases, exact cleanup and acceptance.
Native capability implementation depends on foundation 63, not UI ticket 66, and can proceed now.
Actual UI/file-dialog and application recovery evidence remain explicit acceptance gates; no
implementation or acceptance is claimed by this dependency correction.

2026-09-09: implementation underway with separate bounded native transfer and file/lease work.
Real filesystem cleanup red test established missing cleanup; native Account-lease red test
established missing acquisition. The implemented kernel lock now passes a two-process exclusion,
release and per-Account isolation test, including shutdown loss signaling. Empty lease inodes remain
stable outside the ciphertext spool so cleanup cannot unlink a held lock and admit a second owner.
Native file/source/sink/transfer composition and actual application evidence are still outstanding.

2026-09-09: native binary adapters pass 11 real loopback/filesystem cases, including a 524,295-byte
streamed PUT, exact ciphertext digest/headers, bounded downloads, redirects, pending cancellation
and consumed Move-handle drop with socket/OS-file release. Native HTTP regressions (9), shared Core
integrity (1) and existing Web integrity (3) pass. Integrity validation was extracted once into Core;
Web/native reuse it. Independent review and Desktop all-target Clippy passed at that revision.

The native owner now composes the existing SQLite Attachment store and all three Core runners;
renderer-detach/shutdown/reopen test passes. Native selected-file capabilities pass five real
filesystem cases covering single-use exact scope, bounded reads, changed source length, cancellation,
late dialog/Account/caller generations, private output staging, atomic verified commit, failed output
and scoped retirement. Source/sink review and real Server facade acceptance are underway. Private
upload spools use unnamed/delete-on-close OS files; durable accepted artifacts stay in Core SQLite.
These are capability results, not production UI/file-dialog or full ticket acceptance.

2026-09-09: real native/Core/Server Attachment acceptance passed inside the opt-in native process
fixture (`BITTERY_NATIVE_FOUNDATION=1 pnpm --filter web exec playwright test
runtime-native-foundation.spec.ts --project=cloud --workers=1`, 1 case / 1.7 minutes). It uses actual
SQLite, Linux OS keychain, Server and HTTP object-storage fixture, including upload of more than
512 KiB, rename, verified byte-for-byte download and deletion, followed by lock, process restart,
password Quick Unlock and complete Account teardown. The fixture provisions the existing paid-plan
entitlement, as the existing Web Attachment acceptance does. It does not test Stripe provisioning.

The real flow exposed a native transport integration error: the actual crypto encryptor expands a
256-KiB input beyond the primitive transport chunk size. A real-encryptor/loopback reproducer failed
before the fix; native transport now chunks that same ciphertext stream through the shared integrity
validator. All 12 binary transport tests pass. Cryptographic algorithms and envelope bytes are
unchanged. This evidence uses the regenerated combined Web WASM and current native Core, not mocks;
it remains distinct from the pending Tauri UI/file-dialog, Move restart and recovery acceptance.

Native startup maintenance exclusion also passed red-to-green: holding the exclusive OS gate now
prevents normal owner opening before any SQLite file is created. Normal shutdown releases its shared
gate only after Core retirement and runner joins. Recovery capture and repair remain underway.

2026-09-09: physical recovery implementation now reuses the existing closed Rust recovery contract,
actual SQLite layouts and Core archive/accepted-work policy. Fourteen targeted Core tests pass,
including real crypto-authenticated Attachment publication across two generations, existing Core
accepted-work coverage selection, restoration into separate native files and byte-for-byte capture
after reopen. Historical published generations retain `current: false` through their existing
immutable published mapping and chunks; no new table or generation format was introduced. Published
Vault-image bytes spanning 256 KiB + 7 also reopen through the ordinary native artifact reader.
Conflicting stored bytes, cross-Account commands and cancelled restoration are refused. Foreign
historical records without a representable native mapping return explicit `Unsupported`.

Guarded Replica repair stages bounded input in disposable SQLite TEMP tables and commits one
Account transaction only after exact head and every raw source-row SHA-256 still match. Tests prove
same-head concurrent row mutation refuses installation, another Account remains unchanged, and bad
staged UTF-8 rolls back the full transaction after deletion has begun. Capture retains malformed
logical rows; unknown layouts, unexpected triggers and oversized chunks are explicit failures.
Normal artifact startup now shares the non-mutating schema barrier. The existing B1 migration
regression exposed an additional known historical layout, which is admitted explicitly and preserved.

Seven native wrapper tests pass against real SQLite/files/device leases: maintenance excludes normal
owners, another shared owner blocks entry, old scope cannot release a new lease, cancellation still
allows cleanup, staged binary reaches the closed Core command, and Leave retires claimed recovery
files before releasing the exclusive device gate. A further real-gate regression reproduced a
concurrent cancellation recreating retired file state during Leave; the existing native cancellation
mutex now fences finalization through file cleanup and gate release, and the regression passes.
A JSON-escaping regression failed before the
bounded control writer fix and now returns the existing `ControlBytes` failure without constructing
an oversized envelope. Cryptographic algorithms, encrypted archive bytes and persisted schemas are
unchanged. These scoped results do not establish encrypted native Runtime/Server recovery, accepted
Move restart/reconnect, cross-engine portability, native dialogs or full production acceptance.
The real encrypted native acceptance is underway separately; ticket status remains unchanged.

Scoped verification also passed the existing Attachment artifact store suite (29 tests), including
its original B1 migration/reopen regression, and Vault-image suite (9 tests). Core all-target Clippy
passed after these changes. Desktop all-target Clippy passed after the deterministic gate-race harness moved its held standard
mutex to a dedicated thread; the isolated race regression passed again and no lint suppression was
added.
`git diff --check` passed. Full workspace CI and production acceptance remain phase-level gates.

2026-09-09 native lifetime review follow-up: a real held renderer connection reproduced owner-Drop
failure (maintenance exclusion never released and Core remained usable). Both explicit shutdown and
Drop now start one owned shutdown job, retaining Core and native guards until retirement and runner
drain. Cancelling the shutdown waiter cannot abandon that job. Two tests pass, including dropping the
owner after its original Tokio executor has already stopped; cancelled original runners produce an
explicit failure while Core still retires and releases exclusion. Shutdown errors/panics are reported
through the completion channel rather than leaving an awaiter waiting indefinitely.

The shared native output helper now rechecks recovery cancellation after staging/sync and immediately
before atomic destination replacement. Its behavioral regression preserves the previous destination
and removes the abandoned temporary. Four filesystem tests pass, including explicit `0600` anonymous
spool permissions (the OS anonymous-file creation mode was exposed by the existing privacy assertion).
Six selected-file tests pass after adding caller-scoped release for abandoned selections. These checks
remain separate from real OS dialog and complete production application acceptance.

2026-09-09 stronger real native accepted-work recovery evidence: the opt-in Playwright/native fixture
passed one case in 1.9 minutes (`/tmp/bittery-native-move-recovery-green-2.log`, same command as above).
A real TCP proxy closes Server connections; Core reads its offline Replica and durably accepts an
Attachment Move, recording a failed preparation attempt. After Lock, Core exports its actual encrypted
V1 archive. Under the exclusive OS maintenance gate the fixture corrupts one existing derived
SQLite Item row, preserving accepted bytes. A fresh process diagnoses/repairs from an actual native
selected archive; every original Replica row, including the accepted Move preparation, matches exactly.
A third process reopens locked, Quick Unlocks, reconnects and applies the original Move; downloading
its Attachment from the destination Vault returns the exact original selected bytes. Scoped cleanup
completes. The fixture now also requires each child to report one executed passing test.

The initial real red stopped at the missing encrypted recovery implementation. A subsequent fixture
correction recognized actual accepted Move preparation (store8) before outbound Operation promotion
(store1); no synthetic accepted work was inserted. This successful case had no prepared artifact body
at export time. A stronger test now requires actual nonempty published ciphertext, damages one real
chunk and proves encrypted artifact restoration/reopen; its missing-artifact assertion has reproduced
red and its selective-transport variant is underway. No artifact-body or UI acceptance is inferred
from the earlier passed case.

2026-09-09: the stronger published-artifact case passed (`/tmp/bittery-native-move-artifact-green.log`,
one real case / 1.7 minutes). The transport fixture allows actual preparation and ciphertext upload,
then refuses the final Move request before forwarding. Core exports the accepted immutable work and
nonempty published ciphertext. Physical damage removes one real chunk and corrupts derived authority;
encrypted repair and another process restore every witnessed row, metadata value and ciphertext byte.
Reconnect then converges the original Operation and verifies the Attachment at the destination.

The expanded re-Bootstrap run subsequently failed before re-Bootstrap, at Quick Unlock with
`AccountFailed` (`/tmp/bittery-native-full-capabilities-acceptance.log`). Investigation found that a
retained Session allows dispatch while locked, but missing live keys during authoritative validation
can be misclassified as fatal Account corruption. This is an unresolved acceptance blocker; the
passing run does not close ticket 69. A deterministic Core lifecycle regression is being added before
the fix and rerun. The fixture now refuses a Locked projection carrying an Account failure.

The Core regression reproduced `Some(InvariantViolation)` while locked before the fix. Missing live
keys now return the existing typed authentication-required classification, and one shared outcome
validation helper defers reconciliation through existing bounded retry. Immutable work, authority
and overlays survive without a manufactured receipt. Invalid ciphertext and contradictory semantic
identity still fail closed. All 54 outcome tests pass, including locked applied Create, applied Move
and rejected Move followed by unlock and original-Operation completion. Independent review found no
blocker; ordinary Lock and dispatch already share the Account execution fence. The real native
recovery/re-Bootstrap rerun is pending, so this targeted result does not close acceptance.


2026-09-09 capability acceptance completed after the locked-dispatch regression fix. The exact
opt-in real-Server command above passed one case in 2.4 minutes (native test 1.9 minutes;
`/tmp/bittery-native-full-capabilities-after-locked-fix.log`). The
[native recovery acceptance](../../../apps/desktop/src-tauri/src/runtime_host/native_recovery_acceptance.rs)
and parent fixture execute four actual native processes, each required to report one passing test:

1. Real sign-in, authoritative reads, upload/rename/verified download/delete, offline Replica reads
   and accepted Attachment Move with a persisted failed attempt. Selective real HTTP forwarding
   permits actual ciphertext preparation while refusing final Move mutation; after returning offline,
   Lock and complete encrypted export include the real published multi-chunk artifact. Under the
   exclusive OS maintenance gate the fixture corrupts one existing authority row and removes one
   witnessed ciphertext chunk. It never inserts synthetic accepted work.
2. A fresh process diagnoses corruption and uses an actual selected encrypted File to repair it.
   Every original Replica row, published artifact metadata value and ciphertext byte matches the
   protected witness, including restoration of the missing chunk.
3. Another process reopens locked with exact restored ciphertext, reconnects before Quick Unlock,
   and converges the original Operation. The moved Attachment decrypts to its original selected
   bytes in the destination Vault. After pending work settles, actual native Rebootstrap clears a
   separately damaged derived authority row while preserving every accepted record byte.
4. A final process reopens locked, Quick Unlocks and rebuilds the moved Item's authoritative
   destination-Vault projection from the real Server, then completes scoped Account teardown.

Account access checks now reject a Locked/Unlocked projection carrying any Account failure. Failure
logs contain only startup/access/error classifications. The fixture preserves the production-relevant
online-before-unlock ordering; it does not hide the repaired Core lifecycle bug by rearranging calls.
Independent review covered native archive mappings, exact ciphertext restoration, Rebootstrap,
selective HTTP forwarding/socket retirement, and the shared Core outcome fix without further blocker.

Final targeted Desktop verification passed: `cargo test --manifest-path
apps/desktop/src-tauri/Cargo.toml --lib runtime_host::` reports 76 passed, 0 failed, 4 ignored
(`/tmp/bittery-native-capabilities-final-tests.log`). The ignored entries are opt-in actual keychain/
Server probes and child-process helpers; the real Server/keychain four-process path above ran
separately. Desktop all-target Clippy with `-D warnings` passed
(`/tmp/bittery-native-capabilities-final-clippy.log`); `git diff --check` passed. Core outcome
regressions report 54 passing cases, and the Web fixture's dependent types and Biome checks passed.

This resolves the native capability prerequisite for 66/70. It does not activate the production
Tauri composition or establish OS file-dialog, renderer, supported-OS biometric, cross-engine recovery,
Desktop–Extension messaging, or full Desktop production acceptance. Foreign recovery layouts remain
explicitly unsupported where native representation is unavailable. Tickets 66/72/73 retain those
application/platform gates; full workspace CI remains required before the migration phase closes.
