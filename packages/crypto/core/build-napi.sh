#!/bin/bash
set -e

# Build NAPI package with napi-rs
# Target: Native Node.js/Bun addon for current platform

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/../napi"

echo "Building NAPI package for current platform..."

# Check if @napi-rs/cli is available in local dependencies
if ! pnpm exec napi -h &> /dev/null; then
    echo "@napi-rs/cli is not available in local dependencies."
    echo "Run 'pnpm install' from the repository root and retry."
    exit 1
fi

# Build the native addon
pnpm exec napi build --platform --release

echo ""
echo "NAPI package built successfully!"
echo "Output: packages/crypto/napi/"
ls -la *.node 2>/dev/null || echo "Note: No .node files found (may need to run from correct directory)"
