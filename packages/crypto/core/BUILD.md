# Building Bittery Crypto

The cryptographic implementation lives in `crates/bittery-crypto-core`. The
`bittery-crypto-api` UniFFI crate exposes the shared asynchronous client API and is the
source for the generated web and React Native bindings.

## Prerequisites

- Rust stable with `wasm32-unknown-unknown` installed.
- Node.js 24 and the repository's pinned pnpm version.
- The repository dependencies installed with `pnpm install`.

The WASM script checks for `wasm-bindgen-cli` 0.2.126 and installs that exact version with
Cargo when it is missing or a different version is active. The ubrn generator, its
JavaScript runtime, Prettier, and Binaryen 131.0.0 are exact dependencies of
`packages/crypto/wasm`. Binaryen runs `wasm-opt -Oz` after binding generation.

```bash
rustup target add wasm32-unknown-unknown
pnpm install
```

## Web and extension WASM

From the repository root:

```bash
pnpm run build:crypto-wasm
```

The same build can be invoked directly:

```bash
packages/crypto/core/build-wasm.sh
```

The script runs the pinned ubrn web flow from `packages/crypto/wasm`, using
`packages/crypto/core/ubrn.config.yaml`. Its generated source and scaffolding are tracked so a
fresh checkout can typecheck and resolve bindings; only the WASM binary is ignored:

- `packages/crypto/wasm/crate/`: the generated wasm-bindgen Rust crate and lockfile;
- `packages/crypto/wasm/generated/bittery_crypto_api*.ts`: the UniFFI TypeScript bindings;
- `packages/crypto/wasm/generated/wasm-bindgen/`: the JavaScript and `.d.ts` emitted by
  wasm-bindgen; and
- `packages/crypto/wasm/index.ts`: the generated initialization entrypoint.

`packages/crypto/wasm/package.json` is intentionally tracked. A fresh worktree therefore
has a resolvable workspace package before generation, so `pnpm install` can install ubrn;
`scripts/setup-worktree.sh` builds the generated files afterward when the WASM binary is
absent.

### Migration size checkpoint

Release artifacts measured during the UniFFI migration:

- previous hand-written wasm-bindgen binary: 1,199,470 bytes;
- generated ubrn binary after `wasm-opt -Oz`: 790,712 bytes (34.1% smaller).

## Android

From the repository root:

```bash
pnpm run build:crypto-android
```

`build-android.sh` runs `cargo ndk` for all four shipped ABIs and then `crates/uniffi-bindgen`
— a wrapper pinned to the same `uniffi` version the crate links against — over the resulting
`.so`. Both land in `packages/crypto/android/generated`: the `.so` files are ignored build
artifacts, the Kotlin is tracked so a regeneration that changes it shows up in review.

The Tauri credential provider is the only consumer. It reaches both directories with a Gradle
`srcDir` rather than vendoring them (ADR 0012), and calls the generated Kotlin UniFFI API
directly — its explicitly audited master-unlock-key export does not pass through JavaScript.

This path used to run through `uniffi-bindgen-react-native`. That generator is still used for
the WASM target and produced byte-identical Kotlin, but it also required a React Native package
to write into, which outlived the React Native app.

## Rust checks

Run the full native workspace suite:

```bash
cd packages/crypto/core
cargo test --workspace
```

Compile the exported API with its browser randomness backends enabled:

```bash
cargo clippy --manifest-path packages/crypto/core/Cargo.toml \
  -p bittery-crypto-api --target wasm32-unknown-unknown --lib -- -D warnings
```

Both getrandom generations are intentional. `getrandom` 0.4 serves the current RustCrypto
stack and uses `wasm_js`; `getrandom` 0.2 serves `rsa` 0.9's older `rand_core` graph and
uses its `js` feature.

After changing the Rust API, rebuild the WASM package, run the crypto-port adapter tests,
then run the repository typecheck and tests.
