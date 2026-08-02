# All cryptography lives in one Rust core, compiled per platform

Every primitive — PBKDF2/HKDF derivation, `AES-GCM-AAD-V1`, RSA-4096-OAEP, SRP-6a, Secret
Key generation — is implemented once in `packages/crypto/core/crates/bittery-crypto-core`
and reached through three thin bindings: WASM (`bittery-crypto-wasm`) for web and the
extension, FFI (`bittery-crypto-ffi`, `packages/crypto/expo-module`) for mobile, and a
direct crate dependency for the Tauri desktop app and the Rust server. No JavaScript
implementation of any of it exists, not even as a fallback: a divergence between two
implementations of the same format is unrecoverable once ciphertext is at rest, and
per-platform crypto is where that divergence would appear first. (WebCrypto is used only
where nothing of ours is encrypted — the TOTP HMAC in `packages/shared/src/totp.ts` and the
passkey challenge digest in the extension page script.)

The cost is paid up front and knowingly — a Rust toolchain and platform build steps for
every client (`packages/crypto/core/BUILD.md`), a WASM payload in the browser and the MV3
service worker, and a native module in the Expo app. See `SECURITY.md` § "All Crypto in
Rust" for the binding table and the formats themselves.
