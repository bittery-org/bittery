# Desktop renderer crypto runs in a WASM worker

## Amendment: native Client Runtime (2026-09-08)

The maintainer accepted one Client Runtime in the Tauri Rust application process, conditional on
not duplicating code. This supersedes the renderer Worker placement and native cache-decryption
exception below as Desktop migrates. Tauri calls the existing Rust Core directly; it supplies
platform capabilities and a thin generated request/projection bridge, not another authentication,
live-key, Replica, Operation, retry, Sync, or Account lifecycle implementation. The shared Rust SQLite
adapter executes the existing guarded Replica contract. Renderer reconnection does not replace the
Runtime. Application process loss starts a new locked owner over the same durable Replica.

Native messaging reads this Runtime's Account/Item projections and requests authorized Runtime
actions. Its binary remains a transport bridge; the independent native cache decryptor is removed
when those callers migrate. ADR 0004's Desktop lock authority remains binding. Biometric release
uses existing Device-bound material locally under ADR 0015 and never persists a new login secret.
No primitive crypto or general secret-storage interface is added for the renderer. Shared Core
capabilities are extended once when missing, and reused across hosts.

Retaining a combined renderer Worker would require a native-to-renderer relay and make renderer
loss retire the Runtime; retaining native decryption beside it would preserve competing key owners.
The native placement removes that split while keeping ordinary live key material out of renderer
JavaScript. [Ticket 61](../../planning/evolutionary-rust-runtime/issues/61-desktop-runtime-placement.md)
records the accepted decision; this amendment is architecture authorization, not implementation
or production acceptance evidence.

## Historical decision

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
