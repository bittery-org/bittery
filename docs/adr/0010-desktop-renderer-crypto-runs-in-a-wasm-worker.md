# Desktop renderer crypto runs in a WASM worker

Amends [ADR 0001](0001-single-rust-crypto-core-for-every-platform.md) and [ADR 0009](0009-key-material-crosses-seams-as-an-opaque-keyref.md).

The desktop renderer uses `@bittery/crypto-port/adapters/wasm-worker`, the same asynchronous
WASM-worker adapter as web. Its `KeyRef`s now identify worker-local WASM handles, so live key
material does not cross the renderer's JavaScript thread during ordinary `CryptoPort` calls.
`exportKey` remains the deliberate, audited exception required by the port contract.

The former Tauri `crypto_*` invoke commands, their TypeScript adapter, and their test doubles
are removed. Maintaining a second renderer binding made the desktop renderer keep boxed key
bytes and marshal them over IPC, adding a larger command surface without providing an
independent cryptographic implementation. The Rust core remains the one implementation of
formats and primitives described by ADR 0001; the desktop renderer now reaches it through the
WASM binding rather than direct Tauri commands.

The desktop native host still needs to decrypt the encrypted desktop cache while producing the
extension's lock-state and snapshot responses required by [ADR 0004](0004-reachable-desktop-app-owns-lock-state.md). A small internal native-host module therefore retains only AES decrypt,
AAD-bound AES decrypt, and RSA decrypt, backed directly by `bittery-crypto-core`. It is not
registered with Tauri and is unavailable to the renderer. This narrowly retained dependency is
necessary for native-host behavior, not a desktop renderer crypto path.

The generated WASM loader instantiates a bundled module with `WebAssembly.instantiate` and does
not use `eval` or `new Function`. Desktop's existing `csp: null` therefore needs no
`wasm-unsafe-eval` relaxation.
