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
- Decisions are asked in German. Resulting repository artifacts are written in English.

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

## Not yet specified

- First Web slice implementation is specified in [the accepted specification](spec.md) and queued in
  [tickets 15 through 23](issues/15-binding-compile-spike.md), with the host binding
  architecture split out into [tickets 25 through 27](issues/25-runtime-protocol-contract.md).
  The remaining Item write kinds follow in
  [ticket 28](issues/28-remaining-item-write-kinds.md), which ends the Web cutover.
- The eleven remaining response-cache call sites are inventoried in
  [ticket 24](issues/24-remaining-server-operation-outcomes.md), now resolved and narrowed to the six
  Item routes, and [ticket 29](issues/29-rotation-operation-outcomes.md) for the five Rotation
  routes. Lookup answers one outcome union tagged on `kind`; rejections share a common core and add
  only genuinely new per-kind failures. Old idempotency cleanup is gated on an executable
  zero-call-site inventory in ticket 29.
- Web host integration, followed by Extension and Desktop host integration.
- Android extraction and native host responsibilities, followed by iOS host responsibilities.
- Slice gates, deletion of replaced TypeScript paths, and final cross-host conformance criteria.

## Out of scope

- Replacing current cryptographic algorithms or persisted cryptographic formats.
- Parallel public protocol versions, migration bridges for existing users, or permanent dual stacks.
- Rebuilding existing product surfaces merely to adopt the runtime.
- Android work before the existing applications prove the runtime and Sync path.
- iOS work before Android proves the native host path.
