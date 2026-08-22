# First-slice Sync feed

Type: grilling
Status: resolved
Blocked by: 05, 06

## Question

Choose whether the first Rust-runtime slice retains the current Bootstrap/change/SSE Server contract
or replaces it with a self-contained Account transaction stream. Current changes name affected
entities and the client fetches their latest encrypted representation separately.

Decide between retaining that proven feed while adding atomic semantic Operation outcomes, inlining
encrypted authoritative entities into the current change pages, or replacing storage and transport
with a new per-Account commit stream now.

## Evidence

- Current Bootstrap captures and pins a visible Sync cursor across bounded pages.
- Current changes are bounded by count and bytes, handle deleted-Vault tombstones and expired visible
  cursors, and use opaque event IDs.
- SSE is already a non-authoritative wakeup channel.
- The Rust Replica can atomically commit a fetched authoritative entity, matching outcome, and Cursor
  even though fetching that entity requires an additional request.
- Self-contained changes reduce round trips but are not required to prove the first slice's crash
  safety or exactly-once Operation behavior.

## Answer

The first Rust slice retains the current bounded Bootstrap, change-event plus authoritative-entity
fetch, opaque Cursor, and SSE-wakeup contract. The Server adds atomic semantic Operation outcomes;
Rust atomically commits each fetched authoritative entity, matching outcome, local reconciliation,
and Cursor. A self-contained feed requires later evidence from correctness or measured cost rather
than being assumed into the migration.
