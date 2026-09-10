# Evolutionary Rust runtime decision map

Label: `wayfinder:map`
Charted: 2026-08-22
Baseline: `legacy-v0.5.2` (`f021c85e1d3a9d3f3418ba67a9ff04f319987903`)

## Destination

A decision-complete migration path from the existing client architecture to one shared Rust runtime
and Sync implementation. Existing Server, Web, Desktop, and Extension behavior remains available
through the migration. Android follows as a native Compose host reusing the existing Kotlin platform
modules, then iOS follows as a native SwiftUI host.

The map is done when a specification author can define verified vertical implementation slices
without inferring runtime ownership, transaction semantics, host responsibilities, binding behavior,
or rollout order.

## Notes

### Standing constraints

- The active product baseline is `legacy-v0.5.2`; the `greenfield` branch is decision history and
  evidence rather than an implementation base.
- The existing Server and product surfaces evolve in place. There is no clean-room rewrite.
- Current SRP, KDF, encryption algorithms, key hierarchy, persisted cryptographic formats, and
  compatible Rust crypto behavior remain unchanged. Structural improvements must preserve behavior
  and pass existing and added vectors.
- There is no user compatibility period. Server schemas, OpenAPI, Sync contracts, and clients change
  together without parallel v1/v2 routes or a permanent dual stack.
- Delivery order is existing Server/Web/Desktop/Extension, Android Compose, then iOS SwiftUI.
- The external Rust runtime seam is designed once for all hosts. Platform adapters may differ; Domain
  and Sync behavior may not be reimplemented per host.

### Greenfield disposition

- Carry forward the semantic core of guarded Account-atomic Replica commits, durable local Operations,
  Account-lifetime idempotent outcomes, per-Account transaction Sync, staged Bootstrap, SSE as a hint,
  honest browser durability, closed provider access, and opaque local indexes.
- Adapt those decisions to the existing Account, Session, Vault, Item, ciphertext, key, and Server
  model. Remove dependencies on Account signatures, signed Item revisions, replacement envelopes,
  Device request signatures, and the replacement key hierarchy.
- Supersede the resolved OPAQUE/Argon2id, AES-GCM-SIV, HPKE, Ed25519 Account-key, replacement Recovery,
  signed Device, epoch rotation, and replacement quick-unlock decisions. The Greenfield
  `cryptographic-format.md` does not govern this effort.
- Retain Greenfield platform research and current-state verification as evidence.

## Decisions so far

- [Replica recovery](browser-replica-recovery.md): protected Account-scoped export includes all
  required locally retained work and files, excludes credentials, and remains available while locked.
  Maintenance pauses the Runtime; guarded repair and explicit re-Bootstrap preserve proved accepted
  work. Chromium and Firefox recovery acceptance passed. Unknown state stays explicit, with no
  automatic reset and unchanged explicit Remove/Wipe.

- [Web deployment](issues/39-web-sqlite-deployment-decision.md): retain IndexedDB and existing
  headers/browser support; the maintainer explicitly declined conditional SQLite ticket 40.
- [Extension placement](issues/41-extension-runtime-placement-decision.md): the future Chrome 116+
  cutover uses one combined Worker in an offscreen document with IndexedDB and a service-worker
  broker. Broker recycle reattaches; actual owner loss requires unlock. Desktop lock authority
  remains intact; Firefox/Safari remain roadmap document hosts pending real-host acceptance.

- [Web SQLite feasibility](web-sqlite-prototype-verdict.md): official OPFS passes the exact corpus
  and first-slice scenario in Chromium/Firefox, but real Safari/iOS and deployment gates remain
  unmet; the Rust SAH-pool candidate fails simultaneous-tab ownership. Prototypes were captured
  and removed; ticket 39 owns the production decision.

- [Rotation outcomes](issues/29-rotation-operation-outcomes.md#accepted-decision): six distinct
  creation/finalization kinds retain original non-secret plan snapshots or rotation results, with
  closed per-kind rejections; incomplete staging requires a new finalization Operation after repair.

- [Persistence evolution](issues/38-replica-persistence-evolution.md): blocked/failed Web upgrades
  expose storage-unavailable with explicit retry; versionchange closes stale connections and failed
  migrations preserve the old database.
- [Conformance reproducibility](issues/59-bootstrap-write-order-nondeterminism.md): canonicalize
  generated histories by store/key only; physical migrations do not depend on write ordering.

- [ADR 0014](../../docs/adr/0014-evolve-the-existing-product-around-a-shared-rust-runtime.md): evolve
  the existing product around one shared Rust runtime, preserve current cryptographic behavior, change
  Server and clients together in place, then deliver Android and iOS in that order.
- [First existing-application slice](issues/01-first-existing-app-slice.md): Web begins with Sign-in in
  Rust, which owns the unchanged SRP ceremony, Session creation and renewal, Account persistence,
  bootstrap, offline Replica reads, durable Login-Item creation, retry, exactly-once Server effect,
  and authoritative reconciliation for one active Account and one personal Vault.
- [Web Runtime placement](issues/02-web-runtime-placement.md): Web crypto and the Rust Runtime share
  one process-wide Worker so existing opaque key handles remain valid and durable work is independent
  from React lifecycle.
- [ClientRuntime interface shape](issues/03-clientruntime-interface-shape.md): one closed typed
  `request`/`observe`/`close` protocol carries explicit Account-scoped commands and projections across
  Web and later native bindings; host adapters add ergonomics but no behavior.
- [Replica transaction ownership](issues/04-replica-transaction-ownership.md): Rust owns logical
  Replica policy and closed guarded commit plans; IndexedDB and SQLite adapters execute them
  atomically without reimplementing Domain or Sync behavior.
- [Operation outcome retention](issues/05-operation-outcome-retention.md): the Server retains each
  successful or terminal semantic outcome until Account deletion, independent of elapsed time,
  offline duration, or Sync-event retention.
- [Network ownership](issues/06-network-ownership.md): Rust owns request construction, immutable
  request bytes, retry, outcome interpretation, and Session creation and renewal; host transport
  adapters execute HTTP and SSE without owning authentication state.
- [First-slice Sync feed](issues/07-first-slice-sync-feed.md): retain the current bounded Bootstrap,
  event-plus-authoritative-fetch, opaque Cursor, and SSE-wakeup contract while adding atomic semantic
  Operation outcomes.
- [Runtime Account ownership](issues/08-runtime-account-ownership.md): one process-wide Runtime owns
  the Device Account catalog and scheduling while isolated internal Account modules own their Replicas,
  keys, Operations, and failures; Active account remains UI-only.
- [Transient Operation retry](issues/09-transient-operation-retry.md): an accepted Operation retries
  automatically without a fixed attempt limit, using bounded backoff, until an authoritative semantic
  outcome or removal of the Account from the Device ends local ownership.
- [Accepted Operation discard](issues/10-accepted-operation-discard.md): the first Runtime offers no
  per-Operation discard after durable acceptance; Device Account removal is separate and does not
  claim to cancel or reverse any Server effect.
- [Cross-host binding feasibility](issues/11-cross-host-binding-feasibility.md): extend the existing
  Web crypto Worker, use generated UniFFI bindings for native hosts, keep keys and native SQLite
  inside Rust, and gate production expansion on one focused compile/binding spike.
- [First-slice Replica contract](issues/12-first-slice-replica-contract.md): one revision- and
  incarnation-guarded logical Replica atomically owns encrypted authority, optimistic overlays,
  durable Operations, outcomes, Bootstrap generations, and Cursor across IndexedDB and SQLite.
- [Server Operation outcome contract](issues/13-server-operation-outcome-contract.md): one
  transaction-scoped domain Operation commits a retained User-scoped semantic outcome with its Item
  effect or proved rejection, audit, and Sync records; response-cache idempotency is replaced in place.
- [Runtime module and first-slice sequence](issues/14-runtime-module-and-first-slice-sequence.md): a
  deep Rust client core plus shallow generated bindings proceeds through binding, protocol, Web
  persistence, Sign-in, Bootstrap, Server outcome, offline create, and Web cutover gates.
- [Binding compile spike](issues/15-binding-compile-spike.md): native Kotlin/Swift retain UniFFI
  0.31.2, while Web uses a thin explicit `wasm-bindgen` adapter because UniFFI's experimental
  single-threaded WASM async foreign callback has a concrete `Send`-future mismatch.
- [Browser Replica engine](issues/33-browser-replica-engine.md): keep IndexedDB for Web and the
  Extension during the current migration, use Rust SQLite on native hosts, and preserve SQLite/OPFS
  as a later Web prototype plus a separate Extension-placement frontier rather than a universal
  requirement.
- [Empty Vault Bootstrap authority](issues/35-empty-vault-bootstrap.md): keep one bounded Bootstrap
  feed, but make it explicitly two-phase: cursor-paginated standalone Vault summaries and wrapped
  keys first, then cursor-paginated Items under the same pinned watermark and promotion boundary.
- [Final Web Item and Import frontier](issues/28-remaining-item-write-kinds.md#final-web-item-and-import-frontier):
  the shared Runtime owns all five Item categories, durable Vault creation, bounded durable image
  ingress/staging, and one durable Operation per Import batch. Tickets 49–56 delivered the
  foundations and create-Vault cutover. Tickets 57–58 finish Import and Web consumers; both cutovers
  require executable whole-repository caller graphs.
- [Account removal, Wipe, and Server deletion](issues/48-runtime-account-removal-and-wipe.md):
  Runtime owns explicit local teardown and authenticated deletion transport. Web retains the
  confirmed Server-first deletion gesture and its durable exact-retry marker. Local incomplete
  teardown cannot report success or infer another Account.

## Current delivery state

Ticket delivery validated the accumulated worktree; ticket notes record its targeted evidence. The earlier documentation review used `87386201` on 2026-09-07. Historical handoffs describe
earlier sessions; current tickets govern remaining work. Ticket acceptance used an explicit full-CI
waiver; the later publication checks are recorded below.

- First Web acceptance and its blockers (15–27, 31–32, 35–37) are resolved under the
  [first-slice specification](spec.md). Attachment/lifecycle corrections (43–48) and the final
  category/Vault/Import foundations (49–56) are resolved.
- [57 — Import cutover](issues/57-import-atomic-cutover.md) is resolved after independent review,
  eight provider browser cases, and 135 joined Worker/Core assertions including existing-Vault,
  later-batch rejection, and multi-Account coverage. Targeted checks passed; full CI was waived.
- [58 — final Web host cutover](issues/58-final-web-host-cutover.md) and its parent
  [28](issues/28-remaining-item-write-kinds.md) are resolved. Independent reviews and simplification
  passes, 37 distinct production browser cases, 28 ownership-graph tests, dependent types, and
  affected generation/formatting checks passed. Full CI was waived and not run.
- [29 — Rotation outcomes](issues/29-rotation-operation-outcomes.md) is resolved: all six routes use
  retained semantic outcomes and the zero-caller response-cache cleanup is complete. Independent
  reviews and targeted checks passed; ticket 48's Account-deletion replay protocol remains intact.
- [30 — live Sync](issues/30-runtime-owned-live-sync.md) is resolved after independent review and
  simplification. Seven production Sync scenarios, three affected restart/offline paths, 157 joined
  Worker/Core assertions, and targeted Core/Server/type/generation checks passed across targeted
  runs. Full CI was waived and not run.
- [42 — Replica recovery](issues/42-browser-replica-recovery.md) is resolved after independent
  review and simplification. Chromium/Firefox recovery cases and existing durability, Attachment
  Move and Sync regressions passed across targeted runs; [validation and limits](browser-replica-recovery.md#validation-and-limits)
  distinguish real browser loss from injected faults. Full CI was waived and not run.
- [38 — persistence evolution](issues/38-replica-persistence-evolution.md) is resolved with independent
  review and targeted validation: populated v5/v6 IndexedDB upgrades, blocked/versionchange handling,
  versioned SQLite migrations, and visible storage-unavailable retry. Full CI was waived for this run.
- [59 — conformance reproducibility](issues/59-bootstrap-write-order-nondeterminism.md) is resolved
  after independent review: generator-only canonicalization is stable across fresh processes,
  and shared Bootstrap/Import histories exercise multi-Item prepared writes.

## Completion checks for this run

After each ticket, a delegated simplification pass examines the complete change for duplicated
logic, unnecessary state or wrappers, and useful shared code for later hosts. Implement worthwhile
reductions while preserving accepted behavior, architecture, and coverage; avoid speculative
abstractions. An independent subagent reviews the result, followed by the affected targeted checks.
Record the result briefly in the ticket before closing it.

The newly requested pass also applies to tickets already resolved during this run. Tickets 28, 29,
30, 34, 38, 39, 40, 41, 42, 57, 58, and 59 completed the pass and independent review. All 59 tickets
are closed: 58 resolved and conditional ticket 40 explicitly declined (`wontfix`). Historical ticket
notes retain the full-CI waiver that applied when those tickets were accepted.

## Publication checks

2026-09-08: after ticket acceptance, the user requested full checks before commit, push and a draft
PR. This later publication gate supplements the targeted evidence and preserves the historical
waiver notes above.

- `pnpm check:ci` passed locally: 14 package tasks, 445 host tests, 27 root script tests and all
  nine Chromium test files.
- `pnpm check:ci:rust` passed locally, including 728 Core tests, 151 crypto tests and 10 vectors,
  generated contracts and native/Web bindings, and 50 Desktop tests.
- The full Server suite exposed a stale Move after Attachment Rename. The
  [ticket 28 follow-up](issues/28-remaining-item-write-kinds.md#publication-check-follow-up)
  records the parent Item revision correction and the matching-Authority Sync race found by browser
  acceptance. Exact foreground convergence preserves all guards and makes no additional write.
  The complete Server suite passed (544 library and 2 binary tests), as did Server formatting,
  Clippy and compilation. Final Chromium Attachment UI and durable Attachment Move acceptance
  passed (2/2).

Full-check fixture alignment covers explicit transport failures, valid shared-key ciphertext and
current host contracts while retaining authority, durability and cancellation assertions. These are
local command results; the hosted CI matrix has not been run for this publication.

## Remaining frontiers

The tracked decision and implementation tickets are complete. The following broader migration
frontiers remain outside those 59 tickets:

- Desktop, then Extension production host integration after Web; Android Compose follows, then
  iOS SwiftUI. Native application linking and capability adapters remain host acceptance work.
- Vault update/delete/type conversion still use transitional ownership and need a separate frontier;
  Vault creation is already delivered. Other product paths outside the first-slice specification
  must be inventoried before claiming complete application migration.
- Final cross-host conformance and deletion of shared transitional modules after their last caller
  migrates.

## Out of scope

- Replacing current cryptographic algorithms or persisted cryptographic formats.
- Parallel public protocol versions, migration bridges for existing users, or permanent dual stacks.
- Rebuilding existing product surfaces merely to adopt the runtime.
- Android work before the existing applications prove the runtime and Sync path.
- iOS work before Android proves the native host path.
