# Web SQLite deployment decision

Type: task
Status: needs-info
Blocked by: 34
Research: ../sqlite-everywhere-research-2026-08-24.md

## Question

After the prototype, should supported Web deployments replace IndexedDB with SQLite WASM over the
proved OPFS VFS, accepting its measured browser floor, multi-tab behavior, artifact cost, and any
COOP/COEP effects?

## Recommendation

Retain IndexedDB unless the prototype passes the exact shared corpus and browser acceptance path,
supports two tabs without a second authority, and proves the real Safari/iOS deployment matrix.
Conduct the decision in German and record the supported browsers, VFS, headers, and rollback boundary
in English before any implementation ticket becomes ready.
