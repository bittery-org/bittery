# Browser storage durability facts

Type: research
Status: resolved
Blocked by: none

## Question

Establish, from primary sources, what durability a browser can actually guarantee to a password manager.

Required facts:

- IndexedDB and OPFS eviction behaviour under storage pressure, and what `navigator.storage.persist()` changes on Chromium, Firefox, and Safari.
- Safari's seven-day cap on script-writable storage for low-interaction sites: current rules, and whether OPFS, IndexedDB, and extension storage are each in scope.
- MV3 service-worker termination: current idle timeout, what happens to an in-flight IndexedDB transaction, and which APIs keep a worker alive.
- Whether OPFS and `crypto.subtle` are available in a non-secure context, and what a LAN-only `http://` deployment loses.
- SQLite-over-OPFS in a Worker: current state of `wa-sqlite` and the official SQLite WASM build, including whether `SharedArrayBuffer` and cross-origin isolation are required.
- `chrome.storage.local` and `browser.storage.local` durability and quota, versus IndexedDB, inside an extension.

Write findings to `planning/greenfield-decision-map/research/browser-storage-durability.md`. Facts only, each with a source URL and retrieval date. This ticket makes no decision.

## Answer

Findings: [`research/browser-storage-durability.md`](../research/browser-storage-durability.md),
1048 lines, every claim carrying a fetched URL and a 2026-08-20 retrieval date.

The headline result is that the durability `SYNC-001` demands is not obtainable in a browser at all,
on any engine. That is a fact about the platform, not a gap in the adapter, so ticket 16 is deciding
what to promise rather than how to achieve it.

- **No engine gives a web app a real "it is on disk" acknowledgement.** Chrome's own blog says
  `durability: "strict"` "does not ensure that changes are actually written immediately to disk". Over
  OPFS it is weaker still: the WHATWG spec defines `flush()` as an *attempt* that "can be a no-op",
  and deliberately leaves write ordering unspecified.
- **All three engines now default IndexedDB to `relaxed`.** Chromium switched last. The two
  first-party Chromium sources disagree on whether that was 121 or 122; both are cited. Firefox only
  implemented the `durability` option at all in Firefox 126.
- **Safari's seven-day cap is alive and unchanged in Safari 26.6** (released 2026-07-27) and names
  IndexedDB explicitly. Home Screen web apps are the only documented exemption. Three things are
  unverified in both directions: whether `persist()` exempts an ordinary tab, whether OPFS is in
  scope, and whether Safari extension storage is in scope.
- **Both official SQLite OPFS VFSes ignore the sync flags** and reduce `xSync` to `flush()`, so
  `PRAGMA synchronous` changes nothing. A third VFS, `opfs-wl`, landed in 3.53.0 (2026-04) and needs
  no `SharedArrayBuffer`, only `Atomics.waitAsync()`.
- **An MV3 service worker structurally cannot host an OPFS database.** `Worker` is not exposed in
  `ServiceWorkerGlobalScope` and sync access handles are `[Exposed=DedicatedWorker]`, so the only
  route is an offscreen document with the `WORKERS` reason. The worker also dies after 30 s idle,
  IndexedDB is not a documented keep-alive, and there is still no `waitUntil` for `chrome.*` events.
  Read alongside ticket 03: Firefox has no service worker at all, so the two engines need different
  hosting for the same replica.
- **A LAN-only `http://` origin keeps IndexedDB but loses OPFS, `crypto.subtle`, service workers, Web
  Locks and all of `navigator.storage`.** `192.168.x.x` and `*.local` are not potentially trustworthy;
  only loopback and `*.localhost` are. This is direct input to ticket 05.
- **`chrome.storage.local` has no documented atomicity, transaction, or fsync guarantee at all.** It
  is LevelDB-backed, verified in Chromium source and never stated in the docs.
- **Two npm traps:** `wa-sqlite` on npm is stuck at 1.0.0 from January 2024 while the repo is at
  v1.1.2 (2026-08-11), and `@sqlite.org/sqlite-wasm` is four bugfix releases behind SQLite 3.53.4.

This ticket surfaced facts and decided nothing. Ticket 16 owns the durability-floor decision, and
ticket 05 owns the secure-context consequence.
