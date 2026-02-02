#!/bin/bash
set -e

# Build Rust library for iOS
# Creates xcframework with device and simulator architectures

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
BITTERY_CRYPTO_DIR="$(dirname "$PACKAGE_DIR")/core"
FFI_CRATE="$BITTERY_CRYPTO_DIR/crates/bittery-crypto-ffi"
OUTPUT_DIR="$PACKAGE_DIR/ios"
BUILD_DIR="$PACKAGE_DIR/build/ios"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building bittery-crypto-ffi for iOS...${NC}"

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Add iOS targets if not installed
echo -e "${YELLOW}Checking Rust targets...${NC}"
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim 2>/dev/null || true

cd "$FFI_CRATE"

# Build for iOS device (arm64)
echo -e "${YELLOW}Building for iOS device (aarch64-apple-ios)...${NC}"
cargo build --target aarch64-apple-ios --release

# Build for iOS simulator (arm64 - Apple Silicon)
echo -e "${YELLOW}Building for iOS simulator arm64 (aarch64-apple-ios-sim)...${NC}"
cargo build --target aarch64-apple-ios-sim --release

# Build for iOS simulator (x86_64 - Intel)
echo -e "${YELLOW}Building for iOS simulator x86_64 (x86_64-apple-ios)...${NC}"
cargo build --target x86_64-apple-ios --release

# Get target directory
TARGET_DIR="$BITTERY_CRYPTO_DIR/target"

# Copy static libraries
echo -e "${YELLOW}Creating combined libraries...${NC}"
mkdir -p "$BUILD_DIR/device" "$BUILD_DIR/simulator"

# Device library
cp "$TARGET_DIR/aarch64-apple-ios/release/libbittery_crypto_ffi.a" "$BUILD_DIR/device/"

# Combine simulator libraries (arm64 + x86_64) using lipo
lipo -create \
    "$TARGET_DIR/aarch64-apple-ios-sim/release/libbittery_crypto_ffi.a" \
    "$TARGET_DIR/x86_64-apple-ios/release/libbittery_crypto_ffi.a" \
    -output "$BUILD_DIR/simulator/libbittery_crypto_ffi.a"

# Copy header file
echo -e "${YELLOW}Copying header file...${NC}"
mkdir -p "$BUILD_DIR/include"
cp "$FFI_CRATE/include/bittery_crypto.h" "$BUILD_DIR/include/"

# Create xcframework
echo -e "${YELLOW}Creating xcframework...${NC}"
rm -rf "$OUTPUT_DIR/BitteryCrypto.xcframework"

xcodebuild -create-xcframework \
    -library "$BUILD_DIR/device/libbittery_crypto_ffi.a" \
    -headers "$BUILD_DIR/include" \
    -library "$BUILD_DIR/simulator/libbittery_crypto_ffi.a" \
    -headers "$BUILD_DIR/include" \
    -output "$OUTPUT_DIR/BitteryCrypto.xcframework"

# Create module map for Swift
echo -e "${YELLOW}Creating module map...${NC}"
for arch_dir in "$OUTPUT_DIR/BitteryCrypto.xcframework"/*/; do
    if [ -d "$arch_dir/Headers" ]; then
        cat > "$arch_dir/Headers/module.modulemap" << 'EOF'
module BitteryCryptoFFI {
    header "bittery_crypto.h"
    export *
}
EOF
    fi
done

# Verify output
echo -e "${GREEN}Checking xcframework...${NC}"
if [ -d "$OUTPUT_DIR/BitteryCrypto.xcframework" ]; then
    echo -e "  ${GREEN}✓${NC} BitteryCrypto.xcframework created"
    ls -la "$OUTPUT_DIR/BitteryCrypto.xcframework/"
else
    echo -e "  ${RED}✗${NC} Failed to create xcframework"
    exit 1
fi

# Clean up build directory
rm -rf "$BUILD_DIR"

echo -e "${GREEN}iOS build complete!${NC}"
