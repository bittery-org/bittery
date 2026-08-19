# Tauri + React + Typescript

# Bittery Desktop App

Native desktop application for Bittery password manager with biometric authentication support (Touch ID on macOS, Windows Hello on Windows).

## Features

- ✅ **Native Biometric Authentication** - Unlock your vault using Touch ID (macOS) or Windows Hello (Windows)
- ✅ **Secure Storage** - Encrypted vault keys stored in system keychain
- ✅ **Zero-Knowledge Architecture** - Your master password never leaves your device
- ✅ **Cross-Platform** - Built with Tauri 2.0 for macOS and Windows

## Prerequisites

Before you can build and run the desktop app, you need:

1. **Rust** - Install from [https://rustup.rs/](https://rustup.rs/)
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **Node.js & pnpm** - Already configured in workspace
3. **Xcode Command Line Tools** (macOS) - Required for building

## Development

1. **Install Rust** (if not already installed):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source $HOME/.cargo/env
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Start the development server**:
   ```bash
   # From workspace root
   pnpm dev:desktop
   
   # Or from this directory
   pnpm tauri dev
   ```

## Building

Build the production app:

```bash
# From workspace root
pnpm build:desktop

# Or from this directory
pnpm build
pnpm tauri build
```

This will create:
- **macOS**: `.dmg` installer in `src-tauri/target/release/bundle/dmg/`
- **Windows**: `.msi` installer in `src-tauri/target/release/bundle/msi/`

## Architecture

### Biometric Authentication

The desktop app uses native biometric APIs:
- **macOS**: Touch ID via Secure Enclave
- **Windows**: Windows Hello via TPM/Biometric devices

### Storage Adapter

Located at `packages/crypto/src/storage-tauri.ts`, provides:
- `authenticateWithBiometric()` - Prompt for Touch ID/Windows Hello
- `isBiometricAvailable()` - Check if biometric hardware exists
- `enableBiometric()` / `disableBiometric()` - User preferences
- `unlockWithBiometric()` - Main unlock flow with biometric

### Key Storage

1. **Secret Key** - Stored plaintext (useless without password)
2. **Master Unlock Key** - Encrypted with device key, stored in system keychain
3. **Device Key** - Generated per-device, protected by Secure Enclave/TPM
4. **Vault Keys** - Encrypted with MUK, cached in memory

## Environment Variables

Create `.env` file:

```bash
VITE_SERVER_URL=http://localhost:3000
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
