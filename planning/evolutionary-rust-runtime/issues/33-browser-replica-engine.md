# Browser Replica engine

Type: grilling
Status: resolved
Blocked by:
Research: ../sqlite-everywhere-research-2026-08-24.md

## Question

Should the migration replace Web and Extension storage with SQLite WASM over OPFS?

## Decision

Keep IndexedDB for Web and Extension now; use Rust SQLite for native hosts. Shared semantics come
from the Rust-owned closed Replica contract and generated conformance corpus, not a common file format.

[Ticket 34](34-web-sqlite-opfs-prototype.md) is the optional Web prototype.
[Ticket 41](41-extension-runtime-placement-decision.md) separately decides Extension placement.
Tickets 38–42 own persistence evolution, conditional deployment, and recovery.

## Rationale

At the recorded platform review, OPFS VFS choices traded single-context ownership against
cross-origin isolation and explicit contention handling. Chrome MV3 synchronous OPFS also required
an offscreen document and dedicated Worker, while Firefox/Safari had different background models.
The prototype must recheck these platform constraints; Web success alone cannot decide Extension use.
