# Binding compile spike

Type: task
Status: resolved
Blocked by: 11, 14
Spec: ../spec.md#binding-gate

## Question and verdict

The throwaway spike tested closed cross-host values, async callbacks, observation lifetime,
caller cancellation after acceptance, headless native construction, and one combined crypto/Runtime WASM.

Native keeps UniFFI 0.31.2. Web uses a thin explicit `wasm-bindgen` adapter: UniFFI's experimental
single-threaded WASM async foreign callback failed with `E0053` because its generated future was
non-`Send` while the exported trait required `Future + Send`. Runtime ownership is unchanged.

## Evidence and limits

Native Rust tests proved headless construction, idempotent observation close, and Runtime work
continuing after caller cancellation. Generated Kotlin sealed classes and Swift enums carried the
closed values. The combined WASM executed an actual async JavaScript callback and the existing
crypto implementation.

The spike used Rust/Cargo 1.97.1, UniFFI 0.31.2, wasm-bindgen 0.2.126, and Node 24.18.1 on Linux.
Kotlin/Swift source generation and static checks passed; their language compilers and platform SDKs
were unavailable. Android/Apple application link and execution tests remain later host gates.
All throwaway source and generated artifacts were removed after recording the verdict.
