#!/bin/bash
# Build the native messaging host binary

set -e

echo "🔨 Building native messaging host binary..."

cd "$(dirname "$0")/../apps/desktop/src-tauri"

cargo build --release --bin bittery-native-host

BINARY_PATH="target/release/bittery-native-host"
if [ -f "$BINARY_PATH" ]; then
    echo "✅ Native host binary built successfully!"
    echo "📍 Location: $(pwd)/$BINARY_PATH"
    
    # Make it executable
    chmod +x "$BINARY_PATH"
    
    echo ""
    echo "Next step: Run the desktop app to auto-install the native messaging host"
    echo "  cd apps/desktop && pnpm tauri dev"
else
    echo "❌ Failed to build native host binary"
    exit 1
fi
