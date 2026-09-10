# Replica persistence evolution

Type: task
Status: resolved
Blocked by: 31
Spec: ../spec.md#shared-replica-conformance

## Outcome

Supported physical-schema upgrades preserve accepted Operations, overlays, outcomes, receipts,
authority, and Account scope. Unknown future SQLite schemas and blocked/failed Web upgrades are
reported explicitly without resetting a Replica.

## Current gap

IndexedDB v6-to-v7 preservation is already delivered: `indexeddb-executor-internal.ts` adds missing
stores without deleting existing ones, and `indexeddb-executor.test.ts` covers that upgrade.
Remaining work is explicit migration/version policy and blocked/versionchange/failure lifecycle.

Native `replica/sqlite.rs` currently uses `CREATE TABLE IF NOT EXISTS` without Bittery
`application_id`, `user_version`, or an ordered migration runner.

## Decision frontier

Record how a Web upgrade blocked by another tab is presented/retried and how failed migrations
recover. The recommendation is a visible storage-unavailable state with retry after the competing
context closes, preserving the old database. Corruption/quarantine/export remain
[ticket 42](42-browser-replica-recovery.md). Prepared-write reproducibility is tracked in
[ticket 59](59-bootstrap-write-order-nondeterminism.md); no dependency on this ticket is assumed.

## Work after the decision

Maintainer decision (2026-09-07): expose storage-unavailable on blocked/failed Web upgrades;
retry explicitly after the competing context closes, close stale connections on versionchange,
and preserve the old database on migration failure. Corruption/export stays in ticket 42.
Full CI is waived for this run; targeted migration, conformance, type, and generation checks remain.

- Separate Rust logical schema versions from engine physical versions.
- Add native database identity, ordered transactional forward migrations, and future-version refusal.
- Extend the existing additive IndexedDB upgrade with the decided blocked/versionchange handling.
- Test every supported old-to-new path with active Operations and receipts. Inject failure at each
  migration write boundary and prove old-or-new state on reopen.
- Run the shared corpus before/after upgrade and both full CI gates. SQLite and IndexedDB may be
  implemented as separate verified steps; neither adapter's tests substitute for the other's.

## Implementation (2026-09-07; independently reviewed)

- SQLite physical version 1 uses Bittery `application_id` (`0x42545259`) and ordered migrations
  in one immediate transaction. Empty files and the exact former unversioned Replica schema
  upgrade without rewriting rows. Foreign, unknown-future, and incompatible schemas fail closed.
  Physical versions do not version Rust logical Replica payloads.
- IndexedDB supports the exact v5 (`c463ab3a`) and v6 (`2059ed62`) physical schemas, upgrading
  additively to 7 with store/key/index validation. v5 has the receipt store; v6 additionally has
  Attachment Move preparations. Versions 1–4 used earlier logical formats and are refused
  unchanged as storage-unavailable; this slice does not invent logical-format migrations.
  Blocked opens
  reject explicitly and abort if later unblocked; only a new invocation retries. Connections
  close on versionchange. Failed upgrades preserve the previous database.
- `STORAGE_UNAVAILABLE` crosses generated Runtime/native/Web contracts without exposing host
  diagnostics. Web startup renders a localized storage-unavailable screen with an explicit
  reload/retry action; it does not remove or reset persisted work.
- Passed targeted SQLite tests (16, including the shared corpus at every migration checkpoint),
  IndexedDB migration/lifecycle tests, existing executor tests (26), populated shared-corpus
  checkpoint migration and continuation under both historical schemas, Web rendering/retry tests
  (2), and production WASM startup error propagation (1).
  Rust Clippy, protocol/persistence/native generation checks, formatting, and diff checks passed.
  Full CI was waived and was not run. Final affected type-check result is in the review handoff.

Review correction: the earlier empty-v6 corpus run did not prove preservation. The new test
seeds each representable populated Rust checkpoint into independently defined historical v5/v6
stores, verifies its pre-upgrade contents, injects failure at every migration write boundary,
verifies unchanged old-version contents, upgrades, verifies the same loaded state, then executes
the rest of that history. Both paths explicitly require active-Operation and retained-receipt
checkpoints. Historical fixture evidence is recorded in `src/testing/legacy-replica-database.ts`
under `packages/client-runtime`; unsupported schemas are never relabeled or reset.

Independent standards and specification reviews passed. Reviewer reran migration/conformance:
9 tests, 8,310 assertions passed. Affected Runtime/Web type checks passed all 11 tasks.

## Simplification pass

Shared private step/state assertions replace duplicate conformance execution and apply the same
schema and plaintext checks to migrated histories. Historical schemas and every failure checkpoint
remain independent and intact. Independent review approved the reduction; 9 tests with 11,310
assertions, package types, formatting, and diff checks passed. Production behavior is unchanged.
