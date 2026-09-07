# Web SQLite deployment decision

Type: task
Status: needs-info
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
