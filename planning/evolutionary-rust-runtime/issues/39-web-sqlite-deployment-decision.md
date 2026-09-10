# Web SQLite deployment decision

Type: task
Status: resolved
Blocked by: 34
Research: ../sqlite-everywhere-research-2026-08-24.md

## Question

After [ticket 34](34-web-sqlite-opfs-prototype.md), should supported Web deployments replace IndexedDB
with SQLite/OPFS, accepting its measured browser floor, concurrency, artifact cost, and header effects?

## Decision criteria

Retain IndexedDB unless the candidate passes the exact shared corpus and browser acceptance,
proves two-tab ownership, and supports the real Safari/iOS deployment matrix.
Record the selected VFS, browsers, headers, migration/reset choice, and rollback boundary.
Only an explicit SQLite decision makes ticket 40 eligible; a successful prototype alone does not.

## Decision

2026-09-08: The maintainer selected IndexedDB for Web and explicitly declined the conditional
SQLite implementation in [ticket 40](40-conditional-web-sqlite-implementation.md).
[Ticket 34's verdict](../web-sqlite-prototype-verdict.md) proves useful Chromium/Firefox durability,
but leaves real Safari/iOS and deployment gates unproved; the Rust SAH-pool candidate also fails
simultaneous-tab ownership. Those results do not justify replacing the current engine.

No SQLite VFS is selected. Existing browser support and deployment headers remain unchanged; there
is no Web storage migration or reset. The rollback boundary is the current IndexedDB implementation,
whose restored sources, production WASM and corpus were verified after prototype removal.
[Ticket 42](42-browser-replica-recovery.md) still owns recovery for IndexedDB.

Simplification retains one production engine and removes all prototype code and generated assets;
there is no dormant alternate writer, storage-selection flag or extra header path. No production
change is needed for this decision. Independent Standards/Spec and simplification review passed, with valid links and diff checks.
Full CI was waived and not run.
