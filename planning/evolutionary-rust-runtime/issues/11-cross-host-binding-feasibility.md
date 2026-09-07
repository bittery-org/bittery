# Cross-host Runtime binding feasibility

Type: research
Status: resolved
Blocked by: 02, 03, 04, 06

## Question

Can the shared closed Runtime protocol cross Web/WASM and native bindings without host policy?

## Answer

The seam is feasible without another maintainer decision. Web extends and multiplexes the existing
process-wide crypto Worker; it does not create a second Worker or clone opaque key handles. A small
TypeScript facade maps `AbortSignal` to request identifiers, publishes immutable full snapshots with
monotonic revisions, drops late messages after unsubscribe, and makes `close` idempotent.

Android and iOS use generated UniFFI bindings around one process-wide `ClientRuntime` object. Thin
Kotlin and Swift facades map observations to `Flow` and `AsyncStream`; UI lifecycle closes observation
handles, never the Runtime or an accepted Operation. Compose and SwiftUI remain native application
projects rather than descendants of Tauri-generated projects.

Native builds compile Runtime and the unchanged crypto core into the same Rust library, so live keys
remain inside Rust. Native Runtime persistence uses a shared Rust SQLite implementation after the host
supplies an application-owned database location. Web alone implements the same closed guarded commit
plans over IndexedDB. Hosts supply primitive HTTP/SSE, secure storage, biometric, lifecycle, and
platform-feature adapters.

[Ticket 15](15-binding-compile-spike.md) completed the binding spike: native uses UniFFI,
Web uses an explicit wasm-bindgen adapter. Native application link tests remain host-slice work.
