# Web SQLite/OPFS feasibility prototype

Type: prototype
Status: ready-for-agent
Blocked by: 30, 32
Decision: 33

## Question

Can SQLite WASM over OPFS replace the Web IndexedDB executor behind the unchanged closed Replica
contract without weakening multi-tab ownership, durability, deployment compatibility, recovery, or
the first-slice acceptance path?

## Work

- Compare the official SQLite WASM distribution in the existing Runtime Worker with
  `rusqlite`/`sqlite-wasm-rs` inside Bittery's combined WASM artifact. Do not add a second Runtime or
  Crypto owner.
- Exercise two-tab read/write contention, `SQLITE_BUSY` recovery, crash at every write boundary,
  offline restart, additive migration, quota/persistence denial, private browsing, and export/import.
- Measure checked-in artifact size, startup time, memory, and build/toolchain complexity for both
  shapes.
- Test Chromium, Firefox, and WebKit coverage. Audit the COOP/COEP effect on auth, share links,
  cross-origin assets, iframes, development, self-hosting, and production deployment.
- Run ticket 31's exact history corpus and ticket 32's browser acceptance scenario against the
  candidate. Do not change either test's semantics to accommodate SQLite.
- Record the verdict, then remove all throwaway implementation and generated artifacts.

## Verification

The verdict names the supported browser/deployment matrix, VFS, concurrency/owner model, durability
and corruption behavior, measured costs, and every failed gate. Production replacement remains
blocked on a later German maintainer decision. Success here does not authorize Extension adoption.
