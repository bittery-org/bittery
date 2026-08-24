# Conditional Web SQLite implementation

Type: task
Status: needs-info
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

## Comments

This ticket remains `needs-info` unless ticket 39 explicitly selects SQLite. If IndexedDB remains the
deployment choice, resolve this ticket as `wontfix` rather than building a dormant second writer.
