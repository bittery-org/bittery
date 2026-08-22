# Binding compile spike

Type: task
Status: claimed
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
