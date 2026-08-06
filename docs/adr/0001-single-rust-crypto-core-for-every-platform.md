# All cryptography lives in one Rust core, compiled per platform

Every primitive — PBKDF2/HKDF derivation, `AES-GCM-AAD-V1`, RSA-4096-OAEP, SRP-6a, Secret
Key generation — is implemented once in `packages/crypto/core/crates/bittery-crypto-core`
and reached through generated UniFFI bindings: the WASM worker (`@bittery/crypto-wasm`) for
web and desktop, direct WASM for the extension, and JSI/TurboModule bindings
(`@bittery/crypto-react-native`) for mobile. The Rust server uses a direct crate dependency.
ADR 0010 records the narrow desktop native-host exception. No JavaScript
implementation of any of it exists, not even as a fallback: a divergence between two
implementations of the same format is unrecoverable once ciphertext is at rest, and
per-platform crypto is where that divergence would appear first. (WebCrypto is used only
where nothing of ours is encrypted — the TOTP HMAC in `packages/shared/src/totp.ts` and the
passkey challenge digest in the extension page script.)

The cost is paid up front and knowingly — a Rust toolchain and platform build steps for
every client (`packages/crypto/core/BUILD.md`), a WASM payload in the browser and the MV3
service worker, and a native module in the Expo app. See `SECURITY.md` § "All Crypto in
Rust" for the binding table and the formats themselves.
