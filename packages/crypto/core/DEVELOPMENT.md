# Crypto development workflow

`bittery-crypto-core` is the only implementation of Bittery's cryptographic algorithms and
persisted formats. `bittery-crypto-api` is the UniFFI surface shared by the generated WASM and
React Native bindings. Do not implement cryptographic behavior in an adapter or generated file.

## Internal algorithm changes

Change code and tests under `crates/bittery-crypto-core`. The server links this crate directly;
client bindings reach it through `bittery-crypto-api`.

From `packages/crypto/core`, run:

```bash
cargo fmt --all
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

If a change could affect encryption, wrapping, SRP, recovery, passkey, or another persisted or
cross-client format, add a vector to `crates/bittery-crypto-api/tests/format_vectors.rs`. Do not
change an existing vector merely to accept accidental drift. An intentional format change needs
an explicit migration and architectural decision.

Rebuild each client target that needs local testing:

```bash
pnpm run build:crypto-wasm
pnpm run build:crypto-android
pnpm run build:crypto-ios
```

An implementation-only change should not normally alter generated source, although it will
produce new ignored binaries.

## Exported API changes

Add the primitive to `bittery-crypto-core`, then expose it from
`crates/bittery-crypto-api/src/lib.rs` using UniFFI records, errors, objects, and asynchronous
exports.

If every client needs the operation, update `packages/crypto/port/src/crypto-port.ts` and the
shared marshalling in `packages/crypto/port/src/uniffi-bindings.ts`. The compiler-enforced
forwarded-member lists in the WASM and WASM-worker adapters must also include the new member.
React Native reuses the same handle adapter and marshalling.

Regenerate all bindings after changing the exported surface:

```bash
pnpm run build:crypto-wasm
pnpm run build:crypto-android
pnpm run build:crypto-ios
```

Never edit generated bindings manually. Change the Rust API or `ubrn.config.yaml`, regenerate,
and review the resulting diff.

## Binding and generator changes

Generator configuration lives in `ubrn.config.yaml`. Generator and runtime versions are pinned
in the workspace manifests and `patches/uniffi-bindgen-react-native@0.31.0-3.patch`; update them
together to avoid UniFFI metadata version skew. The patch also makes the generated WASM
entrypoint use a standard asset URL because Vite does not support raw WASM ES module imports.
Remove that part once ubrn emits a bundler-compatible URL itself.

Regenerate the affected targets after changing generator configuration, pins, platform
scaffolding, or the patch. Run all three builds before merging a change shared by every target.

## Generated files

Commit generated source and scaffolding, including TypeScript declarations, Kotlin, C++,
Objective-C++, generated Rust crate sources, and generated lockfiles. This keeps clean checkouts
type-checkable and makes binding changes reviewable.

Do not commit reproducible build products or caches:

- `packages/crypto/wasm/crate/target/`;
- the generated `.wasm` binary;
- Android `jniLibs/`;
- iOS `.xcframework/` directories;
- `node_modules`, Turbo logs, or other tool caches.

The package-local `.gitignore` files enforce this boundary. Check `git status --ignored` if a
new generator version introduces another output directory.

## Verification before merging

Run the repository checks after regenerating:

```bash
pnpm check-types
pnpm test
pnpm test:server
```

Run Biome only on changed handwritten JavaScript and TypeScript files:

```bash
pnpm biome check --write <changed-files>
```

Do not format generated sources by hand. CI independently tests the Rust workspace and format
vectors, lints and builds WASM, builds all four Android ABIs, generates the iOS device and
simulator XCFramework, runs CryptoPort conformance, and runs web E2E.

For any persisted-format change, also prove old-build/new-build compatibility in both directions
for item encryption, rotated vault keys, and share links. Platform changes additionally require
the relevant desktop or mobile device flows, including credential-provider and biometric paths.
