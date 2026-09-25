# Durable Vault authority retirement foundation

Type: task
Status: resolved
Blocked by: 65, 69
Spec: ../desktop-extension/vault-retirement.md

## Contract

Implement one guarded all-generation Vault authority purge and idempotent Replica cleanup journal,
retaining only accepted encrypted work and its indispensable non-secret category witness. Preserve
request fingerprints, receipts, preparations and artifact dependencies. Add guarded Session replacement
that prevents stale refresh from reinstalling retired wrapped keys, retaining native provenance.

The linked frontier is resolved by accepted erasure decision 65 and actual Replica/outcome/Session
inspection. No new product decision is needed for this foundation. Prerequisites are resolved.
Runtime capability drains and production integration remain 70/71 with dependency 86.

## Acceptance

Guarded persistence and reload prove all-generation removal, accepted-work preservation, stale and
failed completion behavior, current same-ID/different-Vault isolation and encrypted recovery.
Valid present Move outcome reconciles after overlay erasure using its original typed witness;
contradictory category fails. Stale independent/borrowed Session writeback cannot revive pruned keys.
Run affected Rust/conformance/binding checks, independent review and simplification before closure.
Do not claim complete Travel/deletion erasure or application acceptance from this foundation.

## Comments

2026-09-09: root and independent review resolved the frontier before implementation. Existing
Bootstrap only promotes a pointer, and current Item completion relies on an overlay that erasure
must destroy. The spec records one shared domain helper, default-empty journal, minimal typed
accepted category witness, exact Session replacement and later 86 capability integration. Test-first
implementation begins with the existing guarded persistence and Runtime outcome seams.

2026-09-09 Session first vertical: the stale independent refresh test reproduced restoration of a
pruned wrapped Vault key (`/tmp/bittery-vault-retirement-session-red.log`), then passed after renewal
reused exact independent-document replacement under Account execution
(`/tmp/bittery-vault-retirement-session-green.log`). The replacement preserves Account/incarnation
and native provenance. Existing native transfer's real SQLite fixture independently passed pruning
borrowed S2, refusing its stale renewal and preserving dormant stored S1 byte-for-byte in
`existing_account_transfer_preserves_independent_session_and_pending_sqlite_work` (native 14-test
run 82072). Wider Account refresh, full journal/recovery and current Runtime integration remain open.

2026-09-09 native-reply review refinement: a queued transfer could otherwise acquire a new Account
delivery token after selective purge without changing lock epoch. The spec now records the accepted
source-only key-authorization generation, implemented in existing ticket-68 private control and
called by later 70/71 retirement integration. It binds source export/final encoding and destination
matching without changing cryptographic transfer material or revoking grants on every snapshot.
The real distributed boundary is explicit: delayed replies are fenced after newer authority arrives;
no local code claims knowledge of an undelivered remote revocation.

2026-09-09 physical journal refinement before recovery implementation: review found that embedding
the essential duty in rebuildable Bootstrap control would unnecessarily remove existing recovery
behavior when that control is corrupt. The accepted placement is now a separate closed
`vault-retirements` row in the existing Replica metadata store, while keeping the same logical
snapshot field and pure transition. No physical table/store or cryptographic format changes.
Valid absent journal means empty; malformed journal cannot be dropped. Re-Bootstrap preserves this
essential row while rebuilding corrupt Bootstrap control, and Repair proves journal equality.

2026-09-09 Session widening: all 17 Account-refresh checks passed, including stale-key refusal and
normal renewal retaining the remaining Vault. A further held-read test reproduced a credential
write after owner-close intent (`/tmp/bittery-vault-retirement-session-owner-close-red.log`);
rechecking owner lifetime after the primitive comparison fixes that race. The compiled Core test
binary, newer than both changed Session source/test files, then passed all 18 Account-refresh tests
(`/tmp/bittery-vault-retirement-session-owner-close-compiled-green.log`). Two intervening Cargo
attempts encountered concurrent test-first fixture compile gaps in other lanes and are not recorded
as passing builds. Independent review of both independent and borrowed replacement seams found no
remaining issue. The separate journal/recovery work and accumulated whole-worktree checks remain open.

2026-09-09 pure Replica and recovery foundation: the first actual Bootstrap test reproduced retained
hidden Vault wrappers in older generations. The shared purge now removes all-generation Vault/Item
authority, affected overlays (including a Move from hidden source to visible target), and protected
Share capabilities while preserving accepted bytes, receipts, preparations and artifacts. Optional
`acceptedItemCategory` evidence is populated at Item admission/backfilled from exact owned overlays,
propagated through Move preparation/finalization, and validated independently of HTTP fingerprints.
Actual Core Import remains a batch without optimistic Item rows; its five categories remain in the
unchanged immutable request. Current authority for the same Item ID in another visible Vault survives.

The dedicated journal survives SQLite file reopen and same-Account incarnation replacement. Duplicate
journal rows reproduced lost cleanup identity, then were rejected before assignment
(`/tmp/bittery-vault-retirement-duplicate-red.log`). Completion never rebases a captured drain result;
a physical stale-commit race proves a second retirement remains pending. A composed receipt plus
retirement plan reproduced premature completion-revision validation, then passed after validating
retirement's full next snapshot after the guarded revision increment
(`/tmp/bittery-vault-retirement-composed-red.log`). Independent review also refined Import backfill
scope and reused the same sorted/unique identity validator across domain and persistence.

Targeted evidence: all 92 Replica tests passed after the final composed-plan fix, including the shared
InMemory/SQLite corpus, SQLite write-failure matrix and migration histories
(`/tmp/bittery-vault-retirement-replica-tests.log`); all 59 Runtime Item-outcome tests passed, including
a valid visible-target Move completed from an old pre-retirement Operation clone after overlay erasure
(`/tmp/bittery-vault-retirement-outcome-suite.log`). The updated generated histories passed both
IndexedDB tests and 13,558 assertions, including historical database migrations
(`/tmp/bittery-retirement-indexeddb.log`). All 72 recovery tests passed, including encrypted archive
round-trip with exact journal preservation, refusal of older duties, malformed-journal refusal,
re-Bootstrap of corrupt old control while preserving the journal, and accepted Move/Import/artifact
coverage (`/tmp/bittery-vault-retirement-recovery-tests.log`). The final composed-plan change only
moves pure validation to the commit's completed revision and was covered by the subsequent92-test run.

Core library check passed. The first all-target Clippy run reported only concurrently staged native
source-generation/selective foreground APIs and a Share test style finding in tickets68/86; their
owners were notified (`/tmp/bittery-vault-retirement-clippy.log`). Final shared Clippy/format/full-root
gates remain to be recorded. These are Core/persistence/recovery capability results: actual Runtime
capability drains, plaintext publication fences, retry/readmission integration and Desktop/Extension
UI/OS acceptance remain70/71/86 and the application acceptance tickets. Frontier88 separately records
retained work whose current authority changed or became unavailable; no compilation or mock result
is claimed as production acceptance.

2026-09-09 final targeted lint: Core all-target Clippy passed with warnings denied after the parallel
staged API/test findings were corrected (`/tmp/bittery-vault-retirement-clippy.log`, 1m02s). This
completes the targeted pure-foundation checks above; whole-worktree format/full CI and application
acceptance remain under the phase owner.

2026-09-09: root independently reviewed dedicated journal persistence/recovery, exact-head cleanup
completion, category/Import invariants, Session replacement and the composed receipt/purge fix.
Final-state durable-work validation runs after revision advancement in both guarded plans and full
Bootstrap promotion. Targeted Replica92, outcome59, recovery72, IndexedDB2/13,558 assertions and
Core all-target Clippy pass as recorded above. This closes only87’s foundation; selective drains,
key erasure integration, retained-work convergence and real application acceptance remain70/71/89.
