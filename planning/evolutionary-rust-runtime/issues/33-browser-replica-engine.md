# Browser Replica engine

Type: grilling
Status: resolved
Blocked by:
Research: ../sqlite-everywhere-research-2026-08-24.md

## Question

Should the current migration replace the delivered Web IndexedDB Replica and the Extension's browser
storage with SQLite WASM over OPFS so Web, Extension, Desktop, Android, and iOS share one physical
database engine?

## Decision

No. Keep IndexedDB for Web and the Extension during the current migration. Use the Rust SQLite
adapter for Desktop, Android, and iOS. The shared cross-host seam is the Rust-owned closed logical
Replica plan contract plus one generated conformance history corpus, not a universal physical file
format.

SQLite/OPFS remains a later Web feasibility prototype. Extension Runtime placement is a separate
frontier because Chrome MV3 needs an offscreen document and dedicated Worker for synchronous OPFS,
while Firefox and Safari use different background composition models. A successful normal-Web
prototype does not answer the Extension question.

## Why

- Web's current process-wide Runtime Worker is per tab. The header-free OPFS SAH-pool VFS permits one
  browsing context, while multi-tab access needs the proxy VFS, cross-origin isolation, and explicit
  `SQLITE_BUSY` recovery.
- Chrome MV3 service workers are ephemeral, cannot open dedicated-worker-only synchronous OPFS
  handles, and cannot spawn the required dedicated Worker. An offscreen document would add a
  Chrome-specific owner and lifecycle seam.
- Rust-compiled SQLite for `wasm32-unknown-unknown` is plausible but its durable documented OPFS VFS
  is also a single-connection SAH pool, so maximum code reuse does not remove the product constraints.
- IndexedDB already executes the closed Rust plan contract atomically in Web workers and across
  browser contexts. Ticket 31 proves semantic equivalence with native SQLite rather than trusting
  superficially similar schemas.

## Comments

### 2026-08-24 — maintainer answer

The question was asked in German with the recommendation to retain IndexedDB now and prototype
SQLite/OPFS later. The maintainer selected that recommendation. The current delivery order and tickets
28 through 32 remain unchanged; ticket 34 records the later Web-only prototype.

### 2026-08-25 — adversarial recheck and planning follow-up

A fresh review against the delivered adapters and current platform documentation upheld this
decision. The reported engine objections were not product defects: the closed Rust persistence
contract remains the deep shared seam, while OPFS multi-tab ownership and MV3 placement remain real
platform constraints.

The review did find two genuine planning defects. No ticket owned the destructive IndexedDB upgrade
gate together with versioned native SQLite migrations, and four follow-ups named by the research had
not been created. Tickets 38 through 42 now own those gaps. They do not reopen this decision or block
tickets 28 through 30.
