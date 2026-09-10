# Conditional Web SQLite implementation

Type: task
Status: wontfix
Blocked by: 39
Decision: 39

## Outcome

If ticket 39 selects SQLite, Web swaps only the Replica executor behind the unchanged closed Rust
persistence contract and preserves the same Runtime ownership and observable behavior.

## Work

- Use the VFS, browser floor, headers, and ownership model selected in ticket 39.
- Keep the combined Runtime/Crypto Worker as the sole per-context Runtime owner.
- Migrate the existing IndexedDB Replica explicitly or make the coordinated no-user reset a recorded
  release choice; never dynamically fail over between two authorities.
- Run ticket 31's exact corpus and ticket 32's browser scenario before removing IndexedDB.

## Verification

The selected browser matrix, two-tab contention, crash recovery, offline restart, migration, quota,
and storage-denial cases pass. A reachability audit proves one Web Replica authority per Account.

## Conditional status

2026-09-08: The maintainer explicitly declined this implementation after selecting IndexedDB in
[resolved ticket 39](39-web-sqlite-deployment-decision.md). No SQLite executor, migration, reset or
deployment-header change is introduced. The prototype was removed after capture; simplification
keeps the existing IndexedDB path without a dormant alternate writer. Recovery remains in
[ticket 42](42-browser-replica-recovery.md).

Independent Standards/Spec and simplification review passed; both links and diff checks passed.
This declined branch has no production implementation to test. Full CI was waived and not run.
