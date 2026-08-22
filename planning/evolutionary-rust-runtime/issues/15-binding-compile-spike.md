# Binding compile spike

Type: task
Status: resolved
Blocked by: 11, 14
Spec: ../spec.md#binding-gate

## Outcome

Prove or disprove the pinned cross-host toolchain assumptions before production Runtime bindings are
designed around them.

## Work

- Create explicitly throwaway spike code under `packages/client-runtime/spikes/bindings`.
- Generate one data-carrying closed request/result/projection set.
- Invoke one async host callback from Rust and close one observation handle exactly once.
- Prove caller cancellation after simulated durable acceptance does not cancel Runtime-owned work.
- Produce one WASM artifact containing the existing crypto implementation and spike Runtime API.
- Generate/compile Kotlin and Swift bindings far enough to prove headless Runtime construction without
  Activity or SwiftUI-scene ownership; where the local machine lacks an Apple toolchain, generation and
  static contract tests are the gate and the limitation is recorded.
- Record commands, versions, verdict, and any binding-mechanism change in this ticket's comments.
- Remove spike source and generated throwaway artifacts after the verdict is captured.

## Verification

The ticket resolves only when the assumptions are either proved by runnable tests/compile checks or a
focused binding decision is reopened with concrete failure evidence. No production Runtime behavior
is implemented here.

## Comments

### 2026-08-22 — spike verdict

The spike proved the Runtime boundary and native binding shapes, but disproved one uniform binding
mechanism. Keep generated UniFFI 0.31.2 bindings for Kotlin and Swift. On Web, put a thin explicit
`wasm-bindgen` adapter between the existing Worker protocol and the same Rust types instead of
exporting async foreign callback traits through UniFFI's experimental single-threaded WASM backend.
This changes only binding mechanics; Runtime ownership and the closed protocol remain unchanged.

Concrete failure evidence: compiling `#[uniffi::export(with_foreign)]` on the async transport trait
for `wasm32-unknown-unknown` with `uniffi` 0.31.2 and `wasm-unstable-single-threaded` failed with
`E0053`: the generated WASM callback handler returned a non-`Send` future while the exported trait
required `Future + Send`. Compiling the same trait and closed data types for native UniFFI succeeded.
The Web-specific adapter then compiled and ran an actual async JavaScript callback without moving
transport policy into JavaScript.

The throwaway tests proved:

- data-carrying closed Sign-in/Create request, Signed-in/Accepted response, and Items/Runtime-status
  projection variants generated as Kotlin sealed classes and Swift enums;
- an async JavaScript host callback invoked from the Rust WASM export and returned `host-ok`;
- a Runtime-owned dispatch completed after its waiting Rust caller was aborted following simulated
  durable acceptance;
- the initial observation callback ran and calling its handle's `close` twice recorded one close;
- native `ClientRuntime(transport)` constructors and `observe`/async `request`/handle `close` symbols
  generated without Activity, Compose, UIKit, SwiftUI, or Scene dependencies; and
- one 173,061-byte WASM module ran the closed spike Runtime API and the existing
  `bittery_crypto_core::validate_secret_key` implementation. Its SHA-256 was
  `afdd6a82614f36cc34d0b1d543a570baa5b4aa82c3b13c71fdab8a1515e18785`.

Commands that passed from the repository root (the UniFFI generation commands were run from the
spike directory so `cargo metadata` resolved its throwaway workspace):

```text
cargo test --manifest-path packages/client-runtime/spikes/bindings/Cargo.toml
cargo build --release --manifest-path packages/client-runtime/spikes/bindings/Cargo.toml
cargo build --release --target wasm32-unknown-unknown \
  --manifest-path packages/client-runtime/spikes/bindings/Cargo.toml
wasm-bindgen --target web --out-dir packages/client-runtime/spikes/bindings/generated/wasm \
  packages/client-runtime/spikes/bindings/target/wasm32-unknown-unknown/release/bittery_client_binding_spike.wasm
cargo run --manifest-path packages/crypto/core/Cargo.toml -p bittery-uniffi-bindgen \
  --bin uniffi-bindgen -- generate --library <spike-native-library> \
  --language kotlin --no-format --out-dir <spike-kotlin-output>
cargo run --manifest-path packages/crypto/core/Cargo.toml -p bittery-uniffi-bindgen \
  --bin uniffi-bindgen -- generate --library <spike-native-library> \
  --language swift --no-format --out-dir <spike-swift-output>
node --input-type=module -e <instantiate-WASM-and-run-Runtime-callback-crypto-assertions>
rg <required-closed-types-callbacks-constructors> <generated-Kotlin-and-Swift>
! rg <Activity-Compose-UIKit-SwiftUI-Scene> <generated-Kotlin-and-Swift>
nm -D <spike-native-library> | rg <constructor-request-observe-close-callback-symbols>
```

The three Rust tests passed. The Node assertion printed
`combined WASM closed API + async host callback + crypto: ok`. Static generated-contract assertions
and native symbol inspection passed. The local machine had no Java, `kotlinc`, Android NDK, `swiftc`,
or Apple SDK, so it could not compile or execute the generated Kotlin/Swift source. UniFFI metadata
extraction and source generation succeeded for both; native Rust creation executed headlessly; and
the generated sources were the explicit static gate on this machine. Android and Apple application
link tests remain production binding acceptance, not a reason to move Runtime ownership into hosts.

Pinned versions used: `rustc 1.97.1`, `cargo 1.97.1`, `uniffi-bindgen 0.31.2`,
`wasm-bindgen 0.2.126`, `wasm32-unknown-unknown`, and Node `v24.18.1`, on Linux
`6.12.101+deb13-amd64` x86_64.

All source, lockfiles, native/WASM binaries, and generated Kotlin, Swift, JavaScript, and TypeScript
artifacts under `packages/client-runtime/spikes/bindings` were removed after recording this verdict.
