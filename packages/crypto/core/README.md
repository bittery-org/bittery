# Bittery Crypto

The Rust core is the only implementation of Bittery's crypto formats and primitives. The
`bittery-crypto-api` UniFFI crate generates the WASM bindings used by web, desktop, and the
browser extension, plus JSI/TurboModule bindings for React Native. The server links the core
crate directly; ADR 0010 documents the limited desktop native-host dependency.

## Features

- **Key Derivation**: PBKDF2-SHA256 (600k iterations) + HKDF for deriving auth and master unlock keys
- **AES-256-GCM (`AES-GCM-AAD-V1`)**: Symmetric encryption with random IVs and entity context binding support
- **RSA-4096 OAEP**: Asymmetric encryption for vault sharing
- **Secret Key Generation**: 1Password-style A3-XXXXXX format
- **SRP-6a Protocol**: Zero-knowledge password authentication (RFC 5054)
- **KDF Policy Validation**: Baseline validation + pinned-parameter downgrade detection for login challenges

## Building

### Prerequisites

- Rust stable with the `wasm32-unknown-unknown` target
- Node.js 24 and the repository's pinned pnpm version
- Xcode command line tools (for iOS)

### Core Library

```bash
cargo build --release
cargo test
```

### Web and extension WASM

```bash
pnpm run build:crypto-wasm
```

### React Native

```bash
pnpm run build:crypto-android
pnpm run build:crypto-ios
```

These commands generate the Kotlin, Objective-C++, C++, JSI, and TurboModule sources consumed
by `@bittery/crypto-react-native`. The Android command covers all shipped ABIs; the iOS command
builds device and simulator XCFrameworks. `BUILD.md` describes the generated and ignored
outputs.

## Crate Structure

```
crates/
├── bittery-crypto-core/    # Core crypto primitives (no platform deps)
└── bittery-crypto-api/     # Shared UniFFI API for web and React Native
```

## API Usage

### Rust (Native)

```rust
use bittery_crypto_core::{
    current_kdf_profile, derive_keys, encrypt, decrypt, generate_secret_key,
    srp6a::{SrpClient, SrpServer, HashAlgorithm, PrimeGroup},
};

// Key derivation
let profile = current_kdf_profile();
let keys = derive_keys("password", "A3-XXXXXX-...", "user@example.com", &profile)?;

// Encryption
let encrypted = encrypt("secret", &keys.master_unlock_key)?;
let plaintext = decrypt(&encrypted, &keys.master_unlock_key)?;

// SRP-6a
let client = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
let salt = client.generate_salt();
let private_key = client.derive_safe_private_key(&salt, "password", None);
let verifier = client.derive_verifier(&private_key);
```

## Security

All cryptographic operations use audited RustCrypto implementations:

- `aes-gcm` - AES-256-GCM authenticated encryption
- `pbkdf2` - PBKDF2-HMAC-SHA256 key derivation
- `hkdf` - HKDF-SHA256 key expansion
- `rsa` - RSA-OAEP encryption
- `sha2` - SHA-256/384/512 hashing
- `num-bigint` - BigInteger for SRP modular arithmetic

## Testing

Run the full core and generated API test suite:

```bash
cargo test
```

The workspace includes persisted-format vectors. WASM linting and native binding generation are
covered by CI; device and browser smoke checks remain required after binding changes.

## License

GPL-3.0-only. See [LICENSE](./LICENSE).

GPLv3 rather than AGPLv3 so this crate links cleanly into both the AGPLv3 server (via AGPLv3 §13) and the GPLv3 clients.
