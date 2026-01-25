#!/bin/bash
set -e

# Build NAPI package with napi-rs
# Target: Native Node.js/Bun addon for current platform

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/crates/bittery-crypto-napi"

echo "Building NAPI package for current platform..."

# Check if @napi-rs/cli is available
if ! command -v napi &> /dev/null; then
    echo "Installing @napi-rs/cli..."
    pnpm add -D @napi-rs/cli
fi

# Build the native addon
pnpm exec napi build --platform --release

echo ""
echo "NAPI package built successfully!"
echo "Output: packages/bittery-crypto/crates/bittery-crypto-napi/"
ls -la *.node 2>/dev/null || echo "Note: No .node files found (may need to run from correct directory)"
