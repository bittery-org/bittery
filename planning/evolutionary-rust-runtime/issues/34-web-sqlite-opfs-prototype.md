# Web SQLite/OPFS feasibility prototype

Type: prototype
Status: resolved
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
- Test Chromium and Firefox plus real supported Safari/macOS and Safari/iOS versions on devices or
  representative hosted devices; a generic WebKit runner is not acceptance evidence for Safari's
  OPFS and sub-worker behavior. If device coverage is unavailable, record Safari/iOS as unproved
  rather than treating WebKit as a substitute. Audit the COOP/COEP effect on auth, share links,
  cross-origin assets, iframes, development, self-hosting, and production deployment.
- Run ticket 31's exact history corpus and ticket 32's browser acceptance scenario against the
  candidate. Do not change either test's semantics to accommodate SQLite.
- Record the verdict, then remove all throwaway implementation and generated artifacts.

## Verification

The verdict names the supported browser/deployment matrix, VFS, concurrency/owner model, durability
and corruption behavior, measured costs, and every failed gate. Production replacement remains
blocked on the deployment decision in ticket 39. Success here does not authorize Extension adoption.

## Verdict and completion

2026-09-08: [Final comparison](../web-sqlite-prototype-verdict.md) and
[independent deployment audit](../web-sqlite-platform-audit.md) record both candidates, measured
costs, successful and failed gates. Official OPFS passes the exact corpus and unchanged ticket-32
application scenario in Chromium and Firefox, with 226 rollback and 226 actual Worker-crash
boundaries per browser. Its deployment gates remain unmet; real Safari/iOS is unproved. The Rust
SAH-pool alternative passes the corpus but fails simultaneous-tab ownership. Ticket 39 still owns
the engine decision; no production storage or header change is authorized here.

Independent implementation, evidence and simplification reviews approved the result. The private
fixture canonicalizer removes duplicated comparison logic; native SQL/migrations are reused without
a new ownership framework. Corrupt-header refusals preserve exact damaged bytes, with recovery policy
still reserved to ticket 42.

Reproduction source, pinned dependencies, measured artifacts and reports are captured on local branch
`prototype/ticket34-sqlite-20260908`, commit `dc89aa72d98a409af794183ec6f19bf17e3360ab`.
After hash-checked capture, all throwaway code/generated output and owned profile/build caches were
removed. The three existing application files were restored byte for byte; production WASM and the
exact corpus are unchanged. Normal Web uses IndexedDB; no prototype paths remain reachable.
Post-restoration dependent types passed (11 cached tasks), links and diff checks passed.
Full CI was waived and was not run.
