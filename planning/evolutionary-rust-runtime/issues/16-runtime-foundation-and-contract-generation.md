# Runtime foundation and contract generation

Type: task
Status: resolved
Blocked by: 15
Spec: ../spec.md#module-boundary

## Delivered

Delivered the Rust workspace, generated contracts, guarded in-memory model, and shallow bindings.
Native facades expose async `close` through raw UniFFI `shutdown` to avoid Kotlin's synchronous
`AutoCloseable.close` collision. Sensitive native values use opaque redacted objects.
Native application compilation remains a later host acceptance gate.

## Contract

- Add `bittery-client-core`, shallow native UniFFI bindings, and a thin explicit Web `wasm-bindgen`
  adapter with the decided dependency direction into unchanged `bittery-crypto-core`.
- Define the first closed request, response, observation, error, and guarded-plan families in Rust.
- Add deterministic OpenAPI-to-Rust generation for the first-slice Server allowlist and drift checks.
- Implement process-wide Runtime and isolated in-memory per-Account modules, observation revisions,
  cancellation ownership, idempotent close, and `Stale`/`Missing` plan results.
- Implement the in-memory plan interpreter used by later IndexedDB and SQLite conformance tests.
- Add workspace formatting, Clippy, unit-test, binding-generation, and generated-diff CI gates.

## Verification

Tests prove closed protocol exhaustiveness, explicit Account scope, Account failure isolation,
monotonic full projections, late-callback suppression, cancellation after simulated acceptance, and
guarded-plan all-or-nothing behavior. Targeted Runtime checks and all new generation drift checks pass.
