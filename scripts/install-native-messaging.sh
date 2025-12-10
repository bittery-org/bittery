#!/bin/bash
# Build and install native messaging components

set -e

echo "🔧 Building Bittery Native Messaging Components..."

# Detect OS
OS="$(uname -s)"
case "${OS}" in
    Linux*)     PLATFORM=linux;;
    Darwin*)    PLATFORM=macos;;
    MINGW*|MSYS*|CYGWIN*)     PLATFORM=windows;;
    *)          PLATFORM="UNKNOWN:${OS}"
esac

echo "📦 Detected platform: $PLATFORM"

# Build native host binary
echo ""
echo "🛠️  Building native messaging host binary..."
cd apps/desktop/src-tauri
cargo build --release --bin bittery-native-host

NATIVE_HOST_BINARY="target/release/bittery-native-host"
if [ "$PLATFORM" = "windows" ]; then
    NATIVE_HOST_BINARY="${NATIVE_HOST_BINARY}.exe"
fi

echo "✅ Built: $NATIVE_HOST_BINARY"

# Install native messaging manifest
echo ""
echo "📝 Installing native messaging manifest..."

MANIFEST_SOURCE="../native-messaging-manifest.json"

if [ "$PLATFORM" = "macos" ]; then
    # macOS installation
    CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    EDGE_DIR="$HOME/Library/Application Support/Microsoft/Edge/NativeMessagingHosts"
    
    # Get absolute path to binary
    BINARY_PATH="$(cd "$(dirname "$NATIVE_HOST_BINARY")" && pwd)/$(basename "$NATIVE_HOST_BINARY")"
    
    # Install for Chrome
    if [ -d "$HOME/Library/Application Support/Google/Chrome" ]; then
        mkdir -p "$CHROME_DIR"
        
        # Update manifest with correct path
        jq ".path = \"$BINARY_PATH\"" "$MANIFEST_SOURCE" > "$CHROME_DIR/com.bittery.desktop.json"
        
        echo "✅ Installed manifest for Chrome: $CHROME_DIR/com.bittery.desktop.json"
    fi
    
    # Install for Edge
    if [ -d "$HOME/Library/Application Support/Microsoft/Edge" ]; then
        mkdir -p "$EDGE_DIR"
        
        # Update manifest with correct path
        jq ".path = \"$BINARY_PATH\"" "$MANIFEST_SOURCE" > "$EDGE_DIR/com.bittery.desktop.json"
        
        echo "✅ Installed manifest for Edge: $EDGE_DIR/com.bittery.desktop.json"
    fi
    
elif [ "$PLATFORM" = "linux" ]; then
    # Linux installation
    CHROME_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    EDGE_DIR="$HOME/.config/microsoft-edge/NativeMessagingHosts"
    
    # Get absolute path to binary
    BINARY_PATH="$(cd "$(dirname "$NATIVE_HOST_BINARY")" && pwd)/$(basename "$NATIVE_HOST_BINARY")"
    
    # Install for Chrome
    if [ -d "$HOME/.config/google-chrome" ]; then
        mkdir -p "$CHROME_DIR"
        
        # Update manifest with correct path
        jq ".path = \"$BINARY_PATH\"" "$MANIFEST_SOURCE" > "$CHROME_DIR/com.bittery.desktop.json"
        
        echo "✅ Installed manifest for Chrome: $CHROME_DIR/com.bittery.desktop.json"
    fi
    
    # Install for Edge
    if [ -d "$HOME/.config/microsoft-edge" ]; then
        mkdir -p "$EDGE_DIR"
        
        # Update manifest with correct path
        jq ".path = \"$BINARY_PATH\"" "$MANIFEST_SOURCE" > "$EDGE_DIR/com.bittery.desktop.json"
        
        echo "✅ Installed manifest for Edge: $EDGE_DIR/com.bittery.desktop.json"
    fi
    
elif [ "$PLATFORM" = "windows" ]; then
    echo "⚠️  Windows installation requires manual registry setup."
    echo "See NATIVE_BIOMETRIC_UNLOCK.md for instructions."
else
    echo "❌ Unsupported platform: $PLATFORM"
    exit 1
fi

echo ""
echo "🎉 Installation complete!"
echo ""
echo "⚠️  IMPORTANT: Update the extension ID in the manifest files:"
if [ "$PLATFORM" = "macos" ]; then
    echo "  - $CHROME_DIR/com.bittery.desktop.json"
    echo "  - $EDGE_DIR/com.bittery.desktop.json"
elif [ "$PLATFORM" = "linux" ]; then
    echo "  - $CHROME_DIR/com.bittery.desktop.json"
    echo "  - $EDGE_DIR/com.bittery.desktop.json"
fi
echo ""
echo "Replace 'EXTENSION_ID_PLACEHOLDER' with your actual extension ID from chrome://extensions/"
echo ""
echo "📖 See NATIVE_BIOMETRIC_UNLOCK.md for full setup instructions."
