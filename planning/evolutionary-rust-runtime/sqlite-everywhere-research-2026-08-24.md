# SQLite everywhere: architecture research, 2026-08-24

Status: research complete

## Question and recommendation

Should Bittery replace the Web IndexedDB Replica with SQLite so that Web and browser extensions use
SQLite WASM over OPFS while Desktop, iOS, and Android use native SQLite, sharing one schema,
migrations, storage semantics, and as much Rust code as possible?

**Recommendation: do not make SQLite/OPFS the universal persistence requirement, and do not replace
the delivered IndexedDB adapter in the current migration.** Keep the existing architecture boundary:
Rust owns closed logical Replica plans and invariants; each platform has one atomic executor; a shared
adapter-neutral history suite proves semantic equivalence. Use Rust-owned SQLite on native hosts and
IndexedDB on Web and the extension.

SQLite/OPFS is technically viable for a constrained Web application, and a Rust-compiled stack is now
plausible. It is not yet the simplest reliable cross-host architecture for Bittery because:

1. the fast, header-free OPFS VFS permits only one browsing context, while Bittery Web currently
   creates one process-wide Runtime Worker **per tab**, not one origin-wide owner;
2. multi-tab SQLite requires the more complex proxy VFS, `SharedArrayBuffer`, and cross-origin
   isolation headers, with new loading and integration constraints;
3. Chrome MV3's service worker cannot use the synchronous OPFS handle and cannot spawn the dedicated
   worker which can; it needs a Chrome-specific offscreen document and another messaging/lifecycle
   boundary;
4. Firefox MV3 still uses an event page rather than `background.service_worker`, so the extension
   needs a different composition root there; and
5. the Rust WASM SQLite option which maximizes code sharing currently documents only a single-
   connection OPFS SAH-pool VFS. It does not solve Web multi-tab or Chrome MV3 placement.

The desired benefits are real on native hosts. They are already obtained without forcing SQLite into
the browser: one Rust SQLite adapter can own the native schema and migrations, while the logical-plan
contract and conformance histories remain the cross-platform source of storage semantics.

## Repository-specific current state

The premise that this decision precedes the IndexedDB ticket is stale on this branch. Ticket 18,
[Web Worker and IndexedDB Replica](issues/18-web-worker-and-indexeddb-replica.md), is resolved. Its
production pieces are present:

- `bittery-client-core` owns Account-scoped logical Replica policy, guarded plans, immutable
  Operations, retry state, outcomes, Bootstrap generations, Cursors, overlays, and receipts.
- `packages/client-runtime/src/indexeddb-executor.ts` executes the generated closed persistence
  contract in one transaction spanning dedicated stores. It does not accept arbitrary SQL or table
  names.
- `packages/client-runtime/src/web/worker-entry.ts` constructs that executor inside the same dedicated
  Worker as `WebClientRuntime` and the existing opaque Crypto key table.
- `apps/web/src/lib/runtime.worker.ts` loads the one combined Bittery Runtime/Crypto WASM artifact.
- The main-thread Web binding remains a plain structured-clone transport; React does not own the
  Worker or durable work.

The current SQLite work is ticket 31,
[Shared Replica adapter conformance](issues/31-shared-replica-adapter-conformance.md). It correctly
adds a native-only `rusqlite` adapter behind the same closed persistence contract, then requires one
Rust-owned history corpus to pass against in-memory, SQLite, and IndexedDB implementations. This is
the important sharing seam. It shares decisions and observable semantics rather than assuming that
two storage engines behave alike because their table names resemble one another.

The extension has not cut over to the Rust Runtime. It is an MV3 Chrome service worker today
(`apps/extension/manifest.config.js`, `apps/extension/src/background/index.ts`). Its transitional
`AccountStore` uses `chrome.storage.local`/`chrome.storage.session`; its encrypted item cache uses
IndexedDB. It explicitly restores in-memory state after service-worker recycling. Any SQLite design
must replace this ownership model, not merely exchange one storage library import.

## Platform facts

### OPFS and workers

OPFS is origin-private browser storage. Its files are not generally user-visible files, and its
lifetime follows the browser's origin-storage policy. `navigator.storage.getDirectory()` is broadly
available in secure contexts, but a `FileSystemSyncAccessHandle`—the API designed for synchronous
WASM database I/O—is available only in a **dedicated Web Worker** and exclusively locks its file
while open ([MDN `getDirectory()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory),
[MDN `createSyncAccessHandle()`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)).

The official SQLite WASM project supports Chromium-family browsers, Firefox 111+, and Safari 16.4+
for its required OPFS APIs. Its ordinary `opfs` VFS is unusable on Safari before 17 because of a
sub-worker storage bug; the SAH-pool alternative works on Safari 16.4+ ([SQLite persistent-storage
documentation](https://www.sqlite.org/wasm/doc/trunk/persistence.md)). Supporting older iOS/Safari
therefore needs a fallback regardless of application design.

OPFS has no stronger product-level durability promise than IndexedDB. Both are managed origin
storage, subject to quota, user clearing, best-effort eviction unless persistence is granted, and
private-browsing limitations. Private data is normally deleted when the private session ends; some
browsers make `getDirectory()` fail in private mode. Safari may proactively evict script-created
data for an origin with no recent user interaction ([MDN quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria),
[WebKit OPFS](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/)).
`navigator.storage.persist()` should be requested where available, but rejection must leave the
Runtime honest: browser storage remains a recoverable local Replica, not an irreplaceable backup.

The extension already requests `unlimitedStorage`. Chrome documents that this permission affects
extension web-storage APIs as well as `chrome.storage` and exempts them from quota restrictions and
eviction; it also recommends `navigator.storage.persist()` ([Chrome extension storage](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)).
That improves Chrome-extension durability but is not a portable guarantee for Web, Firefox, Safari,
private mode, user clearing, uninstall, or profile corruption.

### The official SQLite OPFS VFS choices

The official project exposes three relevant choices ([SQLite persistence](https://www.sqlite.org/wasm/doc/trunk/persistence.md)):

| VFS | Isolation requirement | Concurrent contexts | Consequence for Bittery |
| --- | --- | --- | --- |
| `opfs-sahpool` | No COOP/COEP | No: one installed pool/connection per origin directory | Fast and simple in one dedicated Worker, but a second Web tab fails to initialize the same pool. |
| `opfs` | `SharedArrayBuffer`, therefore COOP/COEP | Moderate multi-tab/Worker access with `SQLITE_BUSY` handling | Closest fit for Web tabs, but loads a proxy sub-worker and changes deployment headers. |
| `opfs-wl` (SQLite 3.53+) | COOP/COEP plus `Atomics.waitAsync()` | Moderate access with fair Web-Lock queuing | Newer and less portable; not a safe universal baseline yet. |

The SAH pool keeps synchronous access handles for its file pool and explicitly fails if another
browsing context has installed the same pool directory. Giving each tab a separate directory avoids
the lock only by giving each tab a different database, which violates one Device Replica and creates
reachable dual owners. A leader-election protocol or `SharedWorker` would be new distributed
ownership machinery and is not the simple architecture proposed in the question.

The ordinary `opfs` VFS releases its exclusive sync handle between operations to permit contention,
but even reads require a lock and clients must keep transactions short and handle `SQLITE_BUSY`.
SQLite explicitly warns that desktop-grade concurrency is not available in browsers. WAL does not
solve this: the WASM build requires exclusive locking for WAL and gains no concurrency benefit.

`opfs` also requires:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp   # or a carefully assessed credentialless policy
```

These headers expose `SharedArrayBuffer` but also isolate the browsing-context group and constrain
cross-origin resources. COOP can sever `window.opener`; COEP blocks no-CORS cross-origin resources
unless they opt in with CORP, or the request uses permitted CORS ([MDN COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy),
[MDN COEP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy)).
Bittery would need an asset, iframe, share-flow, auth-flow, development-server, and deployment audit
before enabling them. They are not required by the SAH pool or by the Rust single-threaded Runtime
itself.

### Manifest V3 browser extensions

Chrome extension service workers are ephemeral: Chrome normally terminates one after 30 seconds of
inactivity, caps a single request/API call at five minutes, and can stop a fetch whose response takes
over 30 seconds. Chrome tells extensions to persist state and tolerate unexpected termination
([Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).
That agrees with Bittery's durable-Operation design but rules out treating an open database handle,
timer, transaction, or in-memory Runtime as durable ownership.

More importantly, the web platform's `Worker()` constructor is unavailable in a service worker, and
sync OPFS handles are dedicated-worker-only ([MDN `Worker()`](https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker),
[MDN `createSyncAccessHandle()`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)).
SQLite/OPFS therefore cannot simply run in Bittery's current Chrome background context.

Chrome's supported route is an offscreen document with the `offscreen` permission and `WORKERS`
reason; that document can spawn a dedicated Runtime/SQLite Worker and communicate with the service
worker through `chrome.runtime` messaging. Offscreen documents have only the `runtime` extension API,
their URL must be packaged, and Chrome permits one offscreen document per profile at a time
([Chrome offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen),
[Chrome extension news](https://developer.chrome.com/blog/extension-news-july-2023)). This adds:

- service-worker -> offscreen-document -> dedicated-worker routing;
- cold recreation and correlation after any context loss;
- one more owner whose crash, update, close, and stale messages must be fenced;
- a Chrome-only manifest permission and minimum-version decision; and
- a decision about whether the Rust Runtime and its opaque key table move into that Worker or SQLite
  becomes a second Worker. The latter conflicts with the established single-owner key-handle model.

Cross-origin isolation does not rescue the service-worker design. Chrome permits extension pages to
opt in through manifest COOP/COEP keys, but explicitly notes that cross-origin isolation is not fully
implemented for service and shared workers ([Chrome extension cross-origin isolation](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation)).
The header-free SAH pool avoids this issue, but still requires the offscreen dedicated Worker and has
one-context ownership.

Firefox is architecturally different in 2026: Manifest V3 still does not support
`background.service_worker`; it runs non-persistent background scripts/event pages. Cross-browser
manifests can declare both, with Chrome choosing the service worker and Firefox the scripts
([MDN WebExtension `background`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)).
A Firefox background document can create a dedicated worker, but it is not Chrome's offscreen API.
Safari can select a background document or service worker. Consequently the extension needs
browser-specific composition and lifecycle tests even if all eventually point at the same Worker
entry.

The extension CSP is not the blocker: Bittery already declares `script-src 'self'
'wasm-unsafe-eval'`, the documented MV3 requirement for packaged WASM on current Chrome and Firefox
([MDN extension CSP](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_Security_Policy)).
Remote SQLite JS/WASM is forbidden by MV3; all JS, WASM, proxy-worker scripts, and migrations must be
bundled with the extension.

### Rust integration

There are three realistic integration shapes.

#### 1. Current Rust plans plus IndexedDB executor

Rust serializes only the closed persistence request. TypeScript validates it and executes one
IndexedDB transaction. Native Rust executes the same semantic contract through SQLite. This shares
all high-value policy—guards, outcomes, Operation durability, retry, reconciliation, Account scope,
and logical migrations—while leaving the storage-engine mechanics shallow and platform-specific.

This has the least build and lifecycle risk. IndexedDB is natively asynchronous, available in
dedicated workers and service workers, and coordinates transactions across tabs/extension contexts.
Its cost is two physical schemas and two adapter implementations. Ticket 31's shared, Rust-generated
history corpus is the correct defense against drift; matching SQL files would not prove matching
semantics.

#### 2. Official `@sqlite.org/sqlite-wasm` in the existing Web Runtime Worker

This can replace `IndexedDbReplicaExecutor` with a small JS SQL executor while preserving the closed
Rust plan seam. It is the lowest-risk SQLite experiment because the official SQLite distribution owns
the Emscripten build and OPFS VFS. The existing Worker is already the correct Web placement.

It does **not** run the native Rust `SqliteReplica`. It adds a second WASM module beside Bittery's
combined Runtime/Crypto module, keeps SQL row mapping in JS, and shares schema/migration SQL only if
the repository deliberately generates or embeds the same assets for both adapters. It also inherits
the VFS choice and deployment constraints above. For the multi-tab Web product, it requires `opfs` or
`opfs-wl`, not SAH pool.

#### 3. `rusqlite` plus `sqlite-wasm-rs` inside Bittery's combined WASM

This is now plausible, not hypothetical. Current `rusqlite` has a `wasm32-unknown-unknown` path using
`sqlite-wasm-rs`; its Connection documentation says the default WASM database is in-memory and a
persistent VFS is optional ([rusqlite `Connection`](https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html)).
`sqlite-wasm-rs` provides SQLite C bindings for that target, compiles SQLite without thread safety,
and its companion VFS offers a full-durability OPFS SAH pool and a relaxed-durability IndexedDB VFS
([`sqlite-wasm-rs` documentation](https://docs.rs/sqlite-wasm-rs/latest/sqlite_wasm_rs/)).

This option maximizes code reuse: the same Rust adapter, SQL schema, migration runner, row mapping,
and conformance tests can compile native and Web. It also avoids a second SQLite WASM instance. But it
does not remove browser restrictions:

- the documented OPFS VFS is SAH-pool, dedicated-worker, single-connection, and no multi-tab;
- the relaxed IndexedDB VFS explicitly does not claim full durability, so it is unsuitable for an
  accepted Bittery Operation;
- it is single-threaded (`SQLITE_THREADSAFE=0` and JS values are not cross-threadable);
- initialization and VFS registration are Web-specific despite shared SQL code; and
- it is a newer third-party toolchain than the official SQLite WASM distribution, expanding the
  cryptographic Runtime artifact and its supply-chain/build surface.

Rust's ordinary `wasm32-unknown-unknown` standard library cannot provide the missing filesystem or
threads: `std::fs` always errors and `std::thread::spawn` panics on that target ([Rust target
documentation](https://doc.rust-lang.org/stable/rustc/platform-support/wasm32-unknown-unknown.html)).
The VFS remains the platform adapter no matter which language owns it. SharedArrayBuffer-based Rust
threads would add cross-origin isolation and a substantially harder Worker bootstrap; Bittery does
not need them for a serialized per-Account actor.

## Schema, migrations, backup, and recovery

On native hosts, use one Rust-owned schema and forward-only transactional migration list. Hosts
supply only an application-owned database path. The adapter should set a Bittery `application_id`,
track a schema version (SQLite reserves `PRAGMA user_version` for application use), and refuse an
unknown future version ([SQLite PRAGMA documentation](https://www.sqlite.org/pragma.html)). Bundle one
SQLite version across Desktop/iOS/Android if byte-for-byte engine behavior is a product requirement;
linking each platform's system SQLite shares SQL but not necessarily feature/version behavior.

If Web later adopts SQLite, the migration assets can be the same, but migration **execution** still
needs VFS/browser crash tests. Do not use a destructive database-version bump: accepted Operations
and receipts must survive every additive migration until authoritative outcomes.

SQLite makes transactions atomic when its VFS correctly implements locking and durable flush, but
it is not immune to corruption or faulty locking ([SQLite atomic commit](https://www.sqlite.org/atomiccommit.html),
[SQLite corruption causes](https://www.sqlite.org/howtocorrupt.html)). The Runtime therefore needs an
explicit corrupt-store state and recovery policy:

- quarantine rather than overwrite an unreadable database;
- run bounded startup validation (and `integrity_check` in diagnostics/recovery, not on every hot
  read);
- permit authoritative ciphertext to re-Bootstrap only after preserving or proving the absence of
  active Operations, overlays, and receipts; and
- never translate storage corruption into successful discard of accepted work.

OPFS is opaque to ordinary file tooling. Export/import must be an application feature. The official
SAH-pool exposes `exportFile()`/`importDb()`; native SQLite provides the Online Backup API and
`VACUUM INTO` ([SQLite WASM persistence](https://www.sqlite.org/wasm/doc/trunk/persistence.md),
[SQLite Backup API](https://www.sqlite.org/backup.html)). A consistent backup must be made through
SQLite/VFS APIs, not by copying a live database and forgetting its journal/WAL. Because the Replica
contains durable Operations, a user-facing export should state whether it includes them and should
remain encrypted at the product boundary.

## Simplest viable architecture

For the current migration:

```text
                           Rust Client Runtime
                     closed Account-scoped plans
                                  |
                    generated persistence contract
                         /                       \
       Web + Extension IndexedDB             Native Rust SQLite
        one atomic transaction       Desktop / Android / iOS DB path
                         \                       /
                   Rust-owned history conformance
```

Rules:

1. Rust remains the only owner of Domain, Sync, guards, retry, reconciliation, and migrations of the
   **logical** Replica model.
2. Each Account has one durable Replica authority and one reachable adapter implementation path.
   Multiple guarded Runtime instances, such as Web tabs, may contend through that authority;
   transitional and Runtime adapter paths may not both be reachable. IndexedDB and SQLite adapters
   are dumb, closed executors.
3. The same generated history corpus, including injected failure boundaries and durable-row
   inspection, gates both engines.
4. Browser storage loss is observable and recoverable; it never silently claims an accepted
   Operation completed or was cancelled.
5. Native SQLite uses one Rust migration runner. Web IndexedDB upgrades are additive and separately
   tested because the physical schema is different.

For a future, deliberately narrower SQLite experiment, use the official SQLite JS/WASM distribution
in the existing Web Runtime Worker first. Choose `opfs` (or, after a supported-browser decision,
`opfs-wl`) because Web must tolerate multiple tabs. This prototype should not replace production
IndexedDB until it passes the gates below. A Rust-compiled SQLite prototype is worth comparing for
bundle size and code reuse, but its SAH-pool-only concurrency is currently a no-go for production Web.

Do **not** combine the Web and extension rollout. The extension requires a separate architecture
decision. A viable Chrome shape is:

```text
popup/content scripts -> MV3 service worker -> offscreen document -> one combined Runtime/SQLite Worker
```

Firefox/Safari would use their background document to own the same dedicated Worker entry. All
messages remain explicit Account-scoped protocol values. The service worker/event page is a router,
not a second Runtime or writer. This is feasible, but it is more machinery than an IndexedDB executor
inside the existing background owner and must earn its complexity with measured benefits.

## No-go and deployment-choice boundaries

SQLite/OPFS must remain unselected for that product/deployment—or the affected platform must be
declared unsupported—when any of these holds:

- no dedicated Worker `FileSystemSyncAccessHandle` support;
- private/guest browsing makes OPFS unavailable or ephemeral and the product has not explicitly
  accepted that mode;
- persistent storage cannot be obtained and product requirements demand stronger-than-best-effort
  local retention;
- a second Web tab cannot open the same Replica without creating another writer or an indefinite
  user-visible failure;
- required COOP/COEP breaks a supported auth, share, iframe, asset, or deployment path;
- Chrome extension offscreen Worker ownership cannot be restored deterministically after service-
  worker/update/crash boundaries;
- Firefox and Safari extension builds cannot provide an equivalent single dedicated Worker owner;
- the VFS offers only relaxed durability for accepted Operations;
- migration failure can delete or orphan active Operations/receipts; or
- a corrupt database recovery path overwrites the only local record of accepted work.

Never choose a VFS dynamically for an existing database and quietly create an empty database under a
different VFS. The official `opfs` and SAH-pool VFSes use different underlying files even for the same
client filename. Capability loss must be a loud storage-unavailable state with an explicit migration
or an explicit product-level choice of database. IndexedDB is the production fallback in the sense
that it remains the proven deployment choice, not a runtime failover after an OPFS Replica has been
created.

## Ticket and plan implications

No current delivery ticket needs to be rewritten for SQLite everywhere.

- **Ticket 18:** leave resolved. IndexedDB is already delivered and is the production fallback even
  if a later experiment succeeds.
- **Ticket 31:** continue as written. Its three-slice plan—native SQLite adapter, Rust-owned history
  corpus, IndexedDB consumption—is the prerequisite evidence for any later engine swap. Add schema
  migrations, backup, and corrupt-store behavior only through separately scoped tickets; do not
  broaden the adapter slice mid-flight.
- **Tickets 28–30:** unchanged. Item kinds, Rotation outcomes, and Runtime-owned live Sync are Rust
  semantic/network work and must not wait for a speculative physical-storage replacement.
- **Ticket 32:** keep the first-slice end-to-end acceptance on IndexedDB. A Web SQLite prototype must
  not erase the known-good acceptance baseline.

After the current acceptance slice, the following decision/prototype tickets are recorded in
dependency order:

1. **[Web SQLite/OPFS feasibility prototype](issues/34-web-sqlite-opfs-prototype.md).** Compare official SQLite JS/WASM and Rust
   `rusqlite`/`sqlite-wasm-rs` in the existing combined Worker. Record bundle/startup size and run
   two-tab read/write contention, `SQLITE_BUSY` recovery, crash-at-each-write, offline restart,
   migration, quota, persistent-storage denial, private mode, Safari/iOS, Firefox, Chrome, and
   export/import tests. Delete the spike code after recording the verdict.
2. **[Web deployment decision](issues/39-web-sqlite-deployment-decision.md) (German maintainer decision).** Recommend retaining IndexedDB unless
   the prototype proves a supported multi-tab VFS and the maintainer explicitly accepts the minimum
   browser versions plus COOP/COEP effects. Record whether Web may ever reject a second tab.
3. **[Web SQLite implementation](issues/40-conditional-web-sqlite-implementation.md), conditional.** Swap only the executor behind the unchanged closed
   contract. Run the exact ticket-31 corpus against IndexedDB and SQLite during rollout; remove
   IndexedDB only after a separate release/rollback decision.
4. **[Extension Runtime placement decision](issues/41-extension-runtime-placement-decision.md) (German maintainer decision).** Decide Chrome offscreen
   document + Worker versus keeping IndexedDB in the MV3 owner, and separately decide the
   Firefox/Safari background-document compositions. Recommend IndexedDB unless all supported browser
   builds prove one restorable Runtime writer.
5. **[Browser backup/corruption recovery](issues/42-browser-replica-recovery.md).** Specify quarantine, active-Operation preservation,
   authoritative re-Bootstrap, diagnostics, export/import, and the UI-visible storage-unavailable
   state for either browser engine.

The Web prototype and extension decision are separate frontiers. Success in a normal Web page is not
evidence that SQLite/OPFS is suitable for MV3.

[Replica persistence evolution](issues/38-replica-persistence-evolution.md) separately owns the
already-recorded release gate: additive IndexedDB upgrades and versioned native SQLite migrations.
Physical migrations remain engine-specific even though Rust owns the logical evolution and shared
conformance histories.

## Bottom line

SQLite everywhere is an attractive physical-storage slogan, but Bittery's correctness rests on a
deeper seam: one Rust-owned logical Replica and provably equivalent atomic executors. Native SQLite is
the right long-term design. Browser SQLite is viable only behind explicit Web and extension
feasibility gates, and today it adds concurrency, deployment, lifecycle, and toolchain risk without
removing the platform adapter. Keep IndexedDB for Web and the extension now; preserve the option to
swap the executor later without changing Runtime behavior.
