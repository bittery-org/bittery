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

## React Native

From the repository root, generate all four Android ABIs or the iOS device and simulator
XCFrameworks:

```bash
pnpm run build:crypto-android
pnpm run build:crypto-ios
```

The pinned ubrn generator writes its TypeScript, C++, Kotlin, and Objective-C++ sources to
`packages/crypto/react-native`, whose package name is `@bittery/crypto-react-native`.
Native libraries and XCFrameworks are ignored build artifacts; generated source and module
scaffolding are tracked so React Native codegen and autolinking can resolve the package in a
fresh worktree. The mobile `android` and `ios` scripts build the corresponding artifacts;
its `eas-build-post-install` script selects the active `EAS_BUILD_PLATFORM`. CI exercises both
native generation paths independently.

Android's credential-provider module depends on that same Gradle project and calls the
generated Kotlin UniFFI API directly. Its explicitly audited master-unlock-key export does
not pass through JavaScript.

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
