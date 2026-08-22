# Runtime foundation and contract generation

Type: task
Status: resolved
Blocked by: 15
Spec: ../spec.md#module-boundary

## Outcome

Create the production Rust workspace, deep-core boundary, generated protocol/Server types, and
in-memory conformance model without authentication or network behavior.

## Work

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

## Comments

### 2026-08-22 — implementation

Added the production `packages/client-runtime` Rust workspace with a deep, host-independent
`bittery-client-core`, shallow native UniFFI projections, and the explicit Web `wasm-bindgen`
adapter selected by Ticket 15. The Core depends on the unchanged `bittery-crypto-core`; this ticket
made no cryptographic or persisted-format changes.

The first protocol is closed and Account-scoped. `Runtime::request` is asynchronous from its first
production definition. `CreateLoginItem` accepts a plaintext Login draft aligned to the existing
`DecryptedItemData` subset, including optional strings and the existing Custom field shape
`{ id, label, value, type: text | password | email | url }`. External projections are decrypted and
carry `Pending`/`Authoritative`/`Failed` status. Ciphertext and the simulated sealed fixture remain
internal to Replica records; real encryption and AAD replace that fixture in Ticket 21. Unique-marker
tests prove requests, projections, and binding Debug output do not reveal credentials or Login
plaintext.

The in-memory conformance implementation provides one process-wide Runtime, isolated per-Account
state/failure, atomic guarded plans, explicit `Missing` and `Stale` results, and Operation acceptance
independent of caller cancellation. Cancellation after acceptance returns typed `Cancelled` to stop
the caller wait while the Operation remains. Per-observation delivery serializes strictly increasing
full projections; close waits for foreign-thread delivery, permits reentrant self-close, and
suppresses later callbacks. Sign-in intentionally returns
`AuthenticationUnavailable`; storage, transport, authentication, and real sealing remain later
vertical slices.

Native values/enums are foreign-wire projections rather than a second behavioral model. Each enum
conversion exhaustively matches all variants; output records destructure all Core fields without
`..`, and opaque inputs use complete Core struct literals. Core additions therefore fail the binding
build until the wire projection is reconciled. Web uses the Core Serde types directly and owns only
JavaScript callback buffering. Generated Kotlin and
Swift expose headless Runtime construction, async `request`/`shutdown`, observation handles, optional
Login fields, and the corrected Custom field shape without Activity, Compose, UIKit, SwiftUI, Scene,
or application ownership. Web exposes async `request_json`, `cancel`, `observe_json`, `unobserve`,
and idempotent `close`; a Node test instantiates the generated WASM and verifies its initial full
snapshot and async request result.

`shutdown` is deliberately only the raw UniFFI transport spelling for semantic Runtime `close`.
UniFFI 0.31.2 generates a synchronous Kotlin `AutoCloseable.close()` for foreign-handle disposal;
also exporting the asynchronous Runtime operation as `close()` produces a conflicting Kotlin API.
Checked-in Kotlin and Swift facades now expose the stable protocol's asynchronous, idempotent
`close()` and delegate to `shutdown()`. A generated-signature gate requires Kotlin
`suspend shutdown()` and Swift async `shutdown()`, and rejects a generated Kotlin `suspend close()`
so the collision cannot return. Web exports `close(): Promise<void>` directly.

Secret strings, Login drafts, Custom fields, and decrypted Login projections use opaque UniFFI
objects. Generated Kotlin data-class and Swift value stringification therefore sees only object
identity, while explicit accessors retain intentional UI access. Tests inspect the actual generated
artifacts and fail if these types return to synthesized value records or custom plaintext
stringification. Replica/plan internals are crate-private or test-only, fixture constructors live only
in Core tests, and the premature boolean `RecordOutcome` mutation was removed until Ticket 21 defines
the closed immutable reconciliation semantics.

Added a deterministic recursive OpenAPI-to-Rust allowlist generator for the initial authentication,
bootstrap, create, refresh, and Sync schemas. Stable Rust PascalCase identifiers handle names such as
`CursorPage_AuthVaultKeyResponse`; tagged variant fields retain exact camelCase wire names; ALL_CAPS
enum values map to valid Rust identifiers while round-tripping their original values. Generated
Server wire types intentionally do not derive `Debug`. Committed output, native bindings, and Web
bindings have drift checks; the generated Server module compiles under Clippy `-D warnings` without
a blanket lint allowance.

Commands that passed from the repository root:

```text
cargo test --manifest-path packages/client-runtime/Cargo.toml -p bittery-client-core \
  cancellation_after_acceptance_stops_waiting_but_preserves_operation
node --test packages/client-runtime/scripts/generate-server-contract.test.mjs
cargo test --manifest-path packages/client-runtime/Cargo.toml --workspace
cargo clippy --manifest-path packages/client-runtime/Cargo.toml --workspace --all-targets -- \
  -D warnings
cargo clippy --manifest-path packages/client-runtime/Cargo.toml \
  --target wasm32-unknown-unknown -p bittery-client-bindings -- -D warnings
./packages/client-runtime/scripts/check-native-bindings.sh
./packages/client-runtime/scripts/check-web-bindings.sh
pnpm --filter @bittery/client-runtime check
git diff --check -- packages/client-runtime package.json pnpm-lock.yaml .github/workflows/ci.yml \
  planning/evolutionary-rust-runtime/issues/16-runtime-foundation-and-contract-generation.md
```

The camelCase protocol test was observed failing before `rename_all_fields = "camelCase"` was added
to tagged Runtime enums, then passed. The Runtime workspace passes format, all-target Clippy, 14 Rust
tests, generator tests, both binding drift gates, and the actual Node/WASM adapter test. CI now runs
the package gate, root Rust CI includes it, and root contract checks include OpenAPI drift.

The root `pnpm check:ci:rust` composite was also attempted, but stopped before reaching the Runtime
gate because concurrent Ticket 17 Server work was not yet `cargo fmt --check` clean in
`apps/server/src/domains/operations/mod.rs` and `apps/server/src/domains/vaults/items.rs`. Those
unrelated files were left untouched; the composite gate must be rerun after Ticket 17 settles.

Verified locally with Rust/Cargo 1.97.1, Node 24.18.1, wasm-bindgen 0.2.126, and
`wasm32-unknown-unknown`. This Linux machine has no Java, Kotlin compiler, Android NDK, Swift
compiler, or Apple SDK, so generated Kotlin/Swift source and native Rust metadata/builds are the
current native gate. Android and iOS application link tests remain host-slice acceptance work.
