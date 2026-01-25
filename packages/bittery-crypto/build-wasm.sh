#!/bin/bash
set -e

# Build WASM package with wasm-pack
# Target: web (for browsers, extensions, and bundlers)

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "Building WASM package..."
wasm-pack build crates/bittery-crypto-wasm \
  --target web \
  --out-dir ../../pkg \
  --out-name bittery_crypto

# Update package.json with correct name
cd pkg
cat > package.json << 'EOF'
{
  "name": "@bittery/crypto-wasm",
  "type": "module",
  "description": "WebAssembly bindings for Bittery crypto",
  "version": "0.1.0",
  "license": "MIT",
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
    "url": "https://github.com/bittery/bittery",
    "directory": "packages/bittery-crypto/pkg"
  }
}
EOF

echo "WASM package built successfully!"
echo "Output: packages/bittery-crypto/pkg"
