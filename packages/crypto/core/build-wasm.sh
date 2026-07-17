#!/bin/bash
set -e

# Build WASM package with wasm-pack
# Target: web (for browsers, extensions, and bundlers)

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Install wasm-pack if not available
if ! command -v wasm-pack &> /dev/null; then
  echo "wasm-pack not found, installing..."
  # Prefer cargo in CI/Docker: the curl installer downloads prebuilt binaries from
  # GitHub releases and is prone to transient 504s on GitHub Actions runners.
  if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ] || [ "${WASM_PACK_INSTALLER:-}" = "cargo" ]; then
    cargo install wasm-pack --version 0.13.1 --locked
  elif ! curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh; then
    echo "wasm-pack curl installer failed, falling back to cargo install..."
    cargo install wasm-pack --version 0.13.1 --locked
  fi
fi

echo "Building WASM package..."
wasm-pack build crates/bittery-crypto-wasm \
  --target web \
  --out-dir ../../../wasm \
  --out-name bittery_crypto

# Update package.json with correct name
cd ../wasm
cat > package.json << 'EOF'
{
  "name": "@bittery/crypto-wasm",
  "type": "module",
  "description": "WebAssembly bindings for Bittery crypto",
  "version": "0.1.0",
  "license": "GPL-3.0-only",
  "files": [
    "bittery_crypto_bg.wasm",
    "bittery_crypto_bg.wasm.d.ts",
    "bittery_crypto.js",
    "bittery_crypto.d.ts"
  ],
  "main": "bittery_crypto.js",
  "types": "bittery_crypto.d.ts",
  "exports": {
    ".": {
      "types": "./bittery_crypto.d.ts",
      "import": "./bittery_crypto.js"
    }
  },
  "sideEffects": [
    "./bittery_crypto.js"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/bittery-org/bittery",
    "directory": "packages/crypto/wasm"
  }
}
EOF

echo "WASM package built successfully!"
echo "Output: packages/crypto/wasm"
