#!/bin/bash
set -e

# Build Rust library for Android
# Requires: Android NDK, Rust targets installed

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
BITTERY_CRYPTO_DIR="$(dirname "$PACKAGE_DIR")/core"
FFI_CRATE="$BITTERY_CRYPTO_DIR/crates/bittery-crypto-ffi"
OUTPUT_DIR="$PACKAGE_DIR/android/src/main/jniLibs"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building bittery-crypto-ffi for Android...${NC}"

# Check for Android NDK
if [ -z "$ANDROID_NDK_HOME" ]; then
    # Try common locations
    if [ -d "$HOME/Library/Android/sdk/ndk" ]; then
        ANDROID_NDK_HOME=$(ls -d "$HOME/Library/Android/sdk/ndk"/*/ 2>/dev/null | head -1)
    elif [ -d "/usr/local/lib/android/sdk/ndk" ]; then
        ANDROID_NDK_HOME=$(ls -d "/usr/local/lib/android/sdk/ndk"/*/ 2>/dev/null | head -1)
    fi
fi

if [ -z "$ANDROID_NDK_HOME" ] || [ ! -d "$ANDROID_NDK_HOME" ]; then
    echo -e "${RED}Error: ANDROID_NDK_HOME not set or NDK not found${NC}"
    echo "Please install Android NDK and set ANDROID_NDK_HOME"
    exit 1
fi

echo -e "${YELLOW}Using NDK: $ANDROID_NDK_HOME${NC}"

# Add Android targets if not installed
echo -e "${YELLOW}Checking Rust targets...${NC}"
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android 2>/dev/null || true

# Set up cargo-ndk if available, otherwise use manual toolchain setup
if command -v cargo-ndk &> /dev/null; then
    echo -e "${YELLOW}Using cargo-ndk for build...${NC}"

    cd "$FFI_CRATE"

    # Build for all architectures
    cargo ndk -t armeabi-v7a -t arm64-v8a -t x86 -t x86_64 -o "$OUTPUT_DIR" build --release
else
    echo -e "${YELLOW}cargo-ndk not found, using manual toolchain...${NC}"
    echo -e "${YELLOW}Installing cargo-ndk...${NC}"
    cargo install cargo-ndk

    cd "$FFI_CRATE"
    cargo ndk -t armeabi-v7a -t arm64-v8a -t x86 -t x86_64 -o "$OUTPUT_DIR" build --release
fi

# Verify output
echo -e "${GREEN}Checking output libraries...${NC}"
for abi in armeabi-v7a arm64-v8a x86 x86_64; do
    lib_path="$OUTPUT_DIR/$abi/libbittery_crypto_ffi.so"
    if [ -f "$lib_path" ]; then
        size=$(du -h "$lib_path" | cut -f1)
        echo -e "  ${GREEN}✓${NC} $abi: $size"
    else
        echo -e "  ${RED}✗${NC} $abi: Missing"
    fi
done

echo -e "${GREEN}Android build complete!${NC}"
