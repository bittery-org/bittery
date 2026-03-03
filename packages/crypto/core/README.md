# Bittery Crypto

Unified Rust cryptographic core for the Bittery password manager. Compiles to multiple targets:

- **WASM** - Web browsers, browser extensions, Node.js/Bun
- **FFI** - React Native via Nitro Module
- **Native Rust** - Tauri desktop app

## Features

- **Key Derivation**: PBKDF2 (100k iterations) + HKDF for deriving auth and master unlock keys
- **AES-256-GCM**: Symmetric encryption with random IVs
- **RSA-4096 OAEP**: Asymmetric encryption for vault sharing
- **Secret Key Generation**: 1Password-style A3-XXXXXX format
- **SRP-6a Protocol**: Zero-knowledge password authentication (RFC 5054)

## Building

### Prerequisites

- Rust 1.70+
- wasm-pack (for WASM target)
- cargo-ndk (for Android)
- Xcode command line tools (for iOS)

### Core Library

```bash
cargo build --release
cargo test
```

### WASM

```bash
wasm-pack build crates/bittery-crypto-wasm --target web --release
```

### Android (.so)

```bash
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o ./jniLibs build --release
```

### iOS (.a)

```bash
cargo build --target aarch64-apple-ios --release
cargo build --target aarch64-apple-ios-sim --release
```

## Crate Structure

```
crates/
├── bittery-crypto-core/    # Core crypto primitives (no platform deps)
├── bittery-crypto-wasm/    # WASM bindings via wasm-bindgen
└── bittery-crypto-ffi/     # C FFI for React Native Nitro Module
```

## API Usage

### TypeScript (WASM)

```typescript
import init, {
  deriveKeys,
  encrypt,
  decrypt,
  generateSecretKey,
  JsSrpClient,
  JsSrpServer,
} from '@bittery/crypto-wasm';

await init();

// Key derivation
const keys = deriveKeys('password', 'A3-XXXXXX-...', 'user@example.com');
console.log(keys.auth_key, keys.master_unlock_key);

// Encryption
const key = generateEncryptionKey();
const encrypted = encrypt('secret data', key);
const decrypted = decrypt(encrypted, key);

// SRP-6a Authentication
const client = new JsSrpClient('SHA-256', 4096);
const salt = client.generateSalt();
const privateKey = client.deriveSafePrivateKey(salt, 'password');
const verifier = client.deriveVerifier(privateKey);
```

### Rust (Native)

```rust
use bittery_crypto_core::{
    derive_keys, encrypt, decrypt, generate_secret_key,
    srp6a::{SrpClient, SrpServer, HashAlgorithm, PrimeGroup},
};

// Key derivation
let keys = derive_keys("password", "A3-XXXXXX-...", "user@example.com")?;

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

Run the full test suite:

```bash
cargo test
```

Test vectors are verified against the existing TypeScript implementation to ensure compatibility.

## License

FSL-1.1-ALv2
