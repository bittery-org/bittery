# Cross-host Runtime binding feasibility

Type: research
Status: resolved
Blocked by: 02, 03, 04, 06

## Question

Determine whether the closed typed `request`/`observe`/`close` Runtime seam can project through the
existing Web Worker/WASM toolchain and later generated Kotlin and Swift bindings without moving
Domain, authentication, Sync, or Replica policy into a host.

## Evidence

- Web `KeyRef` values belong to the one Worker/port instance that created them; a second Runtime
  Worker cannot consume them. The existing process-wide crypto Worker is therefore the Runtime host.
- The existing version-pinned UniFFI pipeline already generates async Kotlin calls, object lifetime
  handling, callbacks, and native libraries for the crypto API.
- The existing Tauri Android and Apple projects are WebView scaffolding rather than suitable native
  Compose or SwiftUI application foundations.
- Android already contains useful Keystore, biometric, credential-provider, and Room transaction
  evidence, but those modules currently contain policy that must move behind the Runtime seam.
- The repository has no production Swift binding pipeline yet. Generated Swift async cancellation
  does not reliably cancel the underlying Rust future, which agrees with the rule that caller
  cancellation cannot retract accepted durable work.

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

Before production binding work expands beyond `RuntimeStatus`, one compile spike must prove the pinned
toolchain can generate and execute:

1. data-carrying closed request, response, and projection variants;
2. an async host callback invoked from Rust;
3. an observation callback closed exactly once;
4. caller cancellation after durable acceptance without cancellation of Runtime-owned work;
5. one WebAssembly artifact containing the Runtime API and existing crypto implementation; and
6. headless native Runtime creation independent from an Activity or SwiftUI scene.

Failure of that spike reopens only the binding mechanism, not Runtime ownership or Domain boundaries.

## Source paths

- `packages/crypto/port/src/key-ref.ts`
- `packages/crypto/port/src/adapters/wasm-worker.ts`
- `packages/crypto/port/src/wasm.worker.ts`
- `packages/crypto/core/crates/bittery-crypto-api`
- `packages/crypto/core/build-android.sh`
- `packages/crypto/android/generated`
- `apps/mobile/src-tauri/plugins/credential-provider/android`
- `apps/mobile/src-tauri/plugins/keystore/android`
- `apps/mobile/src-tauri/gen/apple`
