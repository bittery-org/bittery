# Replica persistence evolution

Type: task
Status: needs-info
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

- Separate Rust logical schema versions from engine physical versions.
- Add native database identity, ordered transactional forward migrations, and future-version refusal.
- Extend the existing additive IndexedDB upgrade with the decided blocked/versionchange handling.
- Test every supported old-to-new path with active Operations and receipts. Inject failure at each
  migration write boundary and prove old-or-new state on reopen.
- Run the shared corpus before/after upgrade and both full CI gates. SQLite and IndexedDB may be
  implemented as separate verified steps; neither adapter's tests substitute for the other's.
