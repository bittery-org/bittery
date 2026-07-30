# Building Bittery Crypto

This document describes how to build the Rust crypto packages for different platforms.

## Prerequisites

### Rust Toolchain
```bash
# Install Rust via rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Verify installation
rustc --version
cargo --version
```

### WASM Target (for web/extension)
```bash
# Install wasm-pack
cargo install wasm-pack

# Add WASM target
rustup target add wasm32-unknown-unknown
```

### Node.js/pnpm (for NAPI builds)
```bash
# The repo's toolchain targets Node.js 24 (see the README prerequisites).
# The published @bittery/crypto-napi addon itself still supports Node.js 18+.
node --version  # Should be >= 24

# Install pnpm globally
npm install -g pnpm
```

## Quick Start

From the repository root:

```bash
# Install dependencies
pnpm install

# Build both WASM and NAPI packages
pnpm run build:crypto

# Or build them separately:
pnpm run build:crypto-wasm   # WASM for web/extension
pnpm run build:crypto-napi   # Native addon for server
```

## Package Overview

| Package | Target | Used By |
|---------|--------|---------|
| `@bittery/crypto-wasm` | WASM (web target) | Web app, Browser extension |
| `@bittery/crypto-napi` | Native Node addon | Node.js/Bun runtimes |

## Build Commands

### WASM Package (`@bittery/crypto-wasm`)

```bash
# From repository root
pnpm run build:crypto-wasm

# Or manually
cd packages/bittery-crypto
./build-wasm.sh
```

**Output:** `packages/bittery-crypto/pkg/`
- `bittery_crypto.js` - JavaScript bindings
- `bittery_crypto.d.ts` - TypeScript declarations
- `bittery_crypto_bg.wasm` - WASM binary

### NAPI Package (`@bittery/crypto-napi`)

```bash
# From repository root
pnpm run build:crypto-napi

# Or manually
cd packages/bittery-crypto
./build-napi.sh
```

**Output:** `packages/bittery-crypto/crates/bittery-crypto-napi/`
- `bittery-crypto.darwin-arm64.node` (on macOS ARM)
- `bittery-crypto.darwin-x64.node` (on macOS Intel)
- `bittery-crypto.linux-x64-gnu.node` (on Linux x64)
- etc.

## Running Tests

```bash
# Run all Rust tests
cd packages/bittery-crypto
cargo test

# Run tests for specific crate
cargo test -p bittery-crypto-core    # Core crypto logic
cargo test -p bittery-crypto-napi    # NAPI bindings
cargo test -p bittery-crypto-wasm    # WASM bindings
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Build Crypto Packages

on:
  push:
    paths:
      - 'packages/bittery-crypto/**'
  pull_request:
    paths:
      - 'packages/bittery-crypto/**'

jobs:
  build-wasm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust
        uses: dtolnay/rust-action@stable
        with:
          targets: wasm32-unknown-unknown

      - name: Install wasm-pack
        run: cargo install wasm-pack

      - name: Build WASM
        run: pnpm run build:crypto-wasm

      - name: Upload WASM artifact
        uses: actions/upload-artifact@v4
        with:
          name: crypto-wasm
          path: packages/bittery-crypto/pkg/

  build-napi:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: macos-13
            target: x86_64-apple-darwin
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust
        uses: dtolnay/rust-action@stable
        with:
          targets: ${{ matrix.target }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'

      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 10

      - name: Install dependencies
        run: pnpm install

      - name: Build NAPI
        working-directory: packages/bittery-crypto/crates/bittery-crypto-napi
        run: |
          pnpm exec napi build --platform --release --target ${{ matrix.target }}

      - name: Upload NAPI artifact
        uses: actions/upload-artifact@v4
        with:
          name: crypto-napi-${{ matrix.target }}
          path: packages/bittery-crypto/crates/bittery-crypto-napi/*.node

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust
        uses: dtolnay/rust-action@stable

      - name: Run tests
        working-directory: packages/bittery-crypto
        run: cargo test --all
```

## Development Workflow

### After modifying Rust code:

1. **Run tests first:**
   ```bash
   cd packages/bittery-crypto
   cargo test
   ```

2. **Rebuild affected packages:**
   ```bash
   # If you modified core crypto or WASM bindings:
   pnpm run build:crypto-wasm

   # If you modified core crypto or NAPI bindings:
   pnpm run build:crypto-napi
   ```

3. **Run TypeScript type check:**
   ```bash
   pnpm run check-types
   ```

### Adding new functions:

1. Add to `bittery-crypto-core/src/lib.rs` or relevant module
2. Export in `bittery-crypto-wasm/src/lib.rs` (for web)
3. Export in `bittery-crypto-napi/src/lib.rs` (for server)
4. Update TypeScript declarations in `index.d.ts`
5. Rebuild and test

## Troubleshooting

### WASM build fails with "wasm-pack not found"
```bash
cargo install wasm-pack
```

### NAPI build fails with "@napi-rs/cli not found"
```bash
cd packages/bittery-crypto/crates/bittery-crypto-napi
pnpm add -D @napi-rs/cli
```

### "Cannot find module '@bittery/crypto-napi'"
Ensure the package is linked in pnpm workspace:
```bash
pnpm install
```

### Tests fail after modifying SRP code
The SRP implementation must be compatible across all platforms. Run:
```bash
cargo test -p bittery-crypto-core -- srp
cargo test -p bittery-crypto-napi
```

## Architecture

```
packages/bittery-crypto/
├── Cargo.toml                    # Workspace manifest
├── build-wasm.sh                 # WASM build script
├── build-napi.sh                 # NAPI build script
├── crates/
│   ├── bittery-crypto-core/      # Core Rust crypto (shared)
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── encryption.rs     # AES-256-GCM
│   │       ├── key_derivation.rs # PBKDF2 + HKDF
│   │       ├── rsa.rs            # RSA-4096 OAEP
│   │       ├── secret_key.rs     # A3-XXXXXX format
│   │       └── srp6a/            # SRP-6a protocol
│   │
│   ├── bittery-crypto-wasm/      # WASM bindings (wasm-bindgen)
│   │   └── src/lib.rs            # All functions for web
│   │
│   ├── bittery-crypto-napi/      # NAPI bindings (napi-rs)
│   │   ├── src/lib.rs            # SRP server functions
│   │   ├── index.js              # Module loader
│   │   └── index.d.ts            # TypeScript types
│   │
│   └── bittery-crypto-ffi/       # C FFI (for React Native)
│       └── src/lib.rs
│
└── pkg/                          # Built WASM output (@bittery/crypto-wasm)
```

## Performance Notes

- **NAPI** provides ~2-5x faster SRP operations compared to WASM on the server
- **WASM** is cross-platform and works in all browsers
- The core Rust implementation is shared, ensuring identical behavior
