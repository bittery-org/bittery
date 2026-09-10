# Web SQLite feasibility verdict

Evidence for [ticket 34](issues/34-web-sqlite-opfs-prototype.md), 2026-09-08.

The official SQLite/OPFS executor is feasible behind the unchanged Replica contract in the tested
Chromium and Firefox builds. It has not met the deployment gate: real Safari/macOS and Safari/iOS
are unproved, isolation changes affect deployed resources, and application-level contention recovery
needs acceptance. The Rust SAH-pool alternative fails simultaneous-tab ownership. Neither result
authorizes replacing IndexedDB; [ticket 39](issues/39-web-sqlite-deployment-decision.md) owns that choice.

## Candidates and evidence

Both candidates preserve one combined Runtime/Crypto owner per context. The official candidate adds
SQLite's separate WASM module and filesystem proxy sub-worker inside that composition. The Rust
candidate builds the existing native executor and migrations into the combined WASM, with no new
unsafe Send/Sync bridge. Neither adds leader election, a second Runtime, or dynamic engine fallback.

Browsers tested: Playwright 1.62.1 Chromium 151.0.7922.34 and Firefox 153.0 on Linux. These are measured
builds, not an accepted minimum-version matrix. Real Apple devices/hosted access were unavailable;
generic WebKit was not substituted. See the [independent platform audit](web-sqlite-platform-audit.md)
for current headers, browser storage lifetime, assets, auth, Share, billing, embedding and deployment.

| Gate | Official SQLite 3.53.0-build1 / `opfs` | rusqlite 0.40.2 / sqlite-wasm-rs 0.5.5 / sqlite-wasm-vfs 0.2.0 SAH pool |
| --- | --- | --- |
| Exact ticket-31/59 corpus | Both browsers: nine histories twice in isolated files, 174 requests and 228 loaded checkpoints. | Both browsers: nine histories, 87 requests and 114 loaded checkpoints; 201 comparisons. |
| Guarded rollback | Both browsers: 226 injected SQL write boundaries preserve the previous complete state. | Shared corpus passes; full WASM failure-boundary matrix unproved. |
| Actual Worker crashes | Both browsers: 226 terminations at executor SQL write checkpoints preserve old state after reopen. Chromium evidence is a separately retained full crash run. | Completed active Operation + overlay survives owner termination/reopen. In-flight SQL crashes unproved; native test hooks are absent from this artifact. |
| Two tabs and retry | Same database opens concurrently; real SQLITE_BUSY (5) with zero busy timeout; release holding transaction and explicit retry gives exactly two intended rows. Transparent application contention retry is unproved. | Second same-pool owner fails SyncAccessHandle acquisition in both browsers. Reopening after owner termination works; current simultaneous-tab model fails. |
| Migration | Both additive migration writes fail atomically with heads/rows/version preserved; subsequent migration succeeds. Future/foreign/negative metadata and versioned files without identity refuse. | Known compatible unversioned shape migrates; future/foreign metadata refuse twice with exact file bytes preserved. In-migration failure matrix unproved. |
| Restart and export/import | Active Operation + encrypted overlay and terminal receipt checkpoints survive profile restart and consistent 49,152-byte export/import. | Active checkpoint survives Worker restart and 40,960-byte export/import into a fresh directory. |
| Quota/capability denial | Chromium CDP quota override causes SQLITE_IOERR_WRITE (778), preserving old row and integrity. Equivalent Firefox quota denial unproved. Headerless opfs refuses. | Injected getDirectory denial and first actual SAH.write QuotaExceededError preserve the active checkpoint; original request retry succeeds. Actual browser quota exhaustion unproved. |
| Private/persistence | Both nonpersistent automation contexts allow writes but a fresh context loses them. Chromium persist returns false; Firefox request unanswered after 1.5 seconds. | Actual private-context retention and persistence policy unproved. |
| Header-free alternative | SAH-pool opens without isolation but rejects a simultaneous second tab in both browsers. | Header-free SAH pool; same ownership failure. |
| Exact ticket-32 application scenario | Both pass unchanged acceptance: Chromium 3.3 minutes and Firefox 4.4 minutes (one scenario each). | Unproved; full application switch was not widened after the hard ownership failure. |
| Physical corruption | Both browsers: corrupting byte zero of a populated 49,152-byte SQLite image produces SQLITE_NOTADB (26) on two fresh opens; damaged bytes remain identical after each refusal. Restoring the original bytes reopens the exact active checkpoint. | Arbitrary physical corruption unproved. |
| Real Safari/macOS and Safari/iOS | Unproved. | Unproved. |

SQL checkpoint Worker termination is not proof of every filesystem/journal boundary or OS/power loss.
CDP quota override is not a physically full disk; injected Rust API errors are narrower still.
Ephemeral automation contexts do not establish every browser's manual private-mode behavior.
Local-server engine restarts do not prove disconnected application asset loading or eviction recovery.
The single corrupt-header probe proves safe refusal and byte retention, not automatic corruption recovery.
Quarantine and recovery policy belong to
[ticket 42](issues/42-browser-replica-recovery.md).

The official application experiment substitutes only the closed physical executor, plus a test-owned
read-only SQLite inspector returning the same durable shape. All original transport faults, Session
renewal, immutable replay bytes, restart, Server-effect multiplicities and receipt assertions remain.
The first attempt was stopped after actual HTML lacked isolation headers. Corrected temporary
middleware applies COOP same-origin and COEP require-corp before route handling; actual HTML, Runtime
Worker, SQLite proxy and inspector each returned 200 with both policies. This proves experiment
coverage, not production edge coverage. Broader isolated Share/billing/assets flows remain unproved.

## Measured cost

Central sizes use Python gzip level 9, mtime 0 consistently. Production combined WASM is unchanged:
3,375,186 raw bytes / 1,186,902 gzip bytes. Official assets are additional to that artifact; the Rust
figure replaces it. JS glue and workload scopes differ, so these are not complete app or memory totals.

| Measurement | Official candidate | Rust candidate |
| --- | ---: | ---: |
| SQLite WASM / combined WASM raw | 864,752 | 4,247,180 |
| SQLite WASM / combined WASM gzip | 399,955 | 1,624,944 |
| Additional WASM raw / gzip | 864,752 / 399,955 | 871,994 / 438,042 |
| JS + proxy raw / gzip | 610,848 / 165,249 | JS glue 90,754 / 10,988 |
| Official total added browser assets raw / gzip | 1,475,600 / 565,204 | Not applicable: combined module replacement |
| Chromium fresh-Worker startup median | 128.27 ms | 135.6 ms |
| Firefox fresh-Worker startup median | 181.14 ms | 256 ms |
| Observed linear memory | SQLite module 8,388,608 bytes | Combined module 2,031,616 bytes with Replica-only probe |

Startup uses three fresh Workers per browser and may benefit from warm browser/network caches; it is
not a controlled cold-browser benchmark. Neither memory figure includes full JS heap, proxy/process
cost, or an active authenticated Runtime/Crypto workload.

Official assets are pinned prebuilt distribution files with a private executor/bundling step. Rust
requires Clang for WASM SQLite, asynchronous VFS initialization and existing WASM ?Send conventions.
The isolated build used locally extracted Clang 19, Rust 1.97.1, wasm-bindgen 0.2.126 and Binaryen 131
-Oz under the production release settings. Final generation took 155.29 seconds with dependencies
cached. Earlier pre-optimization measurements were withdrawn; only the optimized artifact is compared.

## Reproduction and disposition

Exact corpus SHA256: `6ab5b06f63ebcc5d445f944ffa0ad9612a1d6a5524c50827bb80a5a0b82ca197`.
Production WASM SHA256: `946797c7c652a8c1bf2f0c67b486eb0ac1795327942708d128956dc8ac0c30af`.
Optimized Rust candidate SHA256: `0da5d40143e34a90507095d9e0073e2c685605e347bd35f4596facca23f5d202`.

The local throwaway branch `prototype/ticket34-sqlite-20260908` captures reproducible source, pinned
dependencies, measured generated artifacts, commands and reports against the accumulated validated
working baseline. Capture commit: `dc89aa72d98a409af794183ec6f19bf17e3360ab`. Production files are restored byte for
byte; scoped removal verifies every prototype file against that commit before deleting implementation,
generated output and isolated build/profile caches. The current branch and staging index are unchanged.
The working branch retains this verdict and the platform audit.

Independent implementation reviews and simplification passes approved the closed executor, reused
native SQLite logic, one fixture canonicalizer and minimal temporary configuration. No production
abstraction was added for throwaway code. Targeted corpus, browser, build, type and formatting checks
support the scoped results above. Full CI was waived and was not run.
