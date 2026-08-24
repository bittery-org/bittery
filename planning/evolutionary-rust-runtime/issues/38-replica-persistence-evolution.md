# Replica persistence evolution

Type: task
Status: needs-info
Blocked by: 31
Spec: ../spec.md#shared-replica-conformance

## Outcome

Existing Replicas survive every supported physical-schema upgrade without losing accepted
Operations, optimistic overlays, outcomes, receipts, authority, or Account scope. Native SQLite
refuses an unknown future schema instead of guessing; Web reports a blocked or failed upgrade instead
of destroying the previous database.

## Decision frontier

Before implementation, ask the maintainer in German how a Web upgrade blocked by another open tab is
presented and retried, and how a failed migration transaction is retried. Recommend an explicit
storage-unavailable Runtime state with retry after the competing context closes, because silently
opening another database would create a second authority and deleting the old one would discard
accepted work. Corruption, integrity failure, quarantine, and re-Bootstrap belong only to ticket 42.

## Work

- Define Rust-owned logical schema versions independently from each engine's physical version.
- Give native SQLite a Bittery `application_id`, ordered transactional forward migrations,
  `user_version`, and unknown-future-version refusal.
- Replace IndexedDB's destructive version bump with additive `onupgradeneeded` migrations and
  explicit `blocked`/`versionchange` behavior across tabs.
- Inject crashes at every migration write boundary and prove old-or-new state, including active
  Operations and compact receipts.
- Run the shared history corpus before and after each supported upgrade.

## Verification

Split implementation into two independently green slices after the decision is recorded: native
SQLite versioning/migrations in Rust paths, then IndexedDB additive upgrades in TypeScript paths.
Each slice starts with a failing upgrade test, receives a fresh independent review, and is committed
separately. Full clean-tree gates follow the second slice.

## Comments

### 2026-08-25 — created from the SQLite-everywhere adversarial recheck

The engine decision was upheld, but the reviewer correctly found that the research described a Rust
migration runner which the delivered adapter does not yet implement, while the destructive IndexedDB
release gate existed only as comments in resolved tickets. This ticket gives that real gap one owner;
it does not block tickets 28 through 30.
