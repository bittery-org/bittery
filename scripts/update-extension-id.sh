#!/bin/bash
# Update native messaging manifest with your extension ID

if [ -z "$1" ]; then
    echo "Usage: ./scripts/update-extension-id.sh YOUR_EXTENSION_ID"
    echo ""
    echo "To get your extension ID:"
    echo "1. Go to chrome://extensions/"
    echo "2. Enable 'Developer mode'"
    echo "3. Find your Bittery extension"
    echo "4. Copy the ID (e.g., abcdefghijklmnopqrstuvwxyz123456)"
    echo ""
    echo "Then run:"
    echo "  ./scripts/update-extension-id.sh abcdefghijklmnopqrstuvwxyz123456"
    exit 1
fi

EXTENSION_ID="$1"

echo "🔧 Updating native messaging manifests with extension ID: $EXTENSION_ID"

# macOS Chrome
CHROME_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bittery.desktop.json"
if [ -f "$CHROME_MANIFEST" ]; then
    if command -v jq &> /dev/null; then
        jq ".allowed_origins = [\"chrome-extension://$EXTENSION_ID/\"]" "$CHROME_MANIFEST" > "$CHROME_MANIFEST.tmp"
        mv "$CHROME_MANIFEST.tmp" "$CHROME_MANIFEST"
        echo "✅ Updated Chrome manifest"
    else
        sed -i '' "s|chrome-extension://[^/]*/|chrome-extension://$EXTENSION_ID/|g" "$CHROME_MANIFEST"
        echo "✅ Updated Chrome manifest (using sed)"
    fi
fi

# macOS Edge
EDGE_MANIFEST="$HOME/Library/Application Support/Microsoft/Edge/NativeMessagingHosts/com.bittery.desktop.json"
if [ -f "$EDGE_MANIFEST" ]; then
    if command -v jq &> /dev/null; then
        jq ".allowed_origins = [\"chrome-extension://$EXTENSION_ID/\"]" "$EDGE_MANIFEST" > "$EDGE_MANIFEST.tmp"
        mv "$EDGE_MANIFEST.tmp" "$EDGE_MANIFEST"
        echo "✅ Updated Edge manifest"
    else
        sed -i '' "s|chrome-extension://[^/]*/|chrome-extension://$EXTENSION_ID/|g" "$EDGE_MANIFEST"
        echo "✅ Updated Edge manifest (using sed)"
    fi
fi

# macOS Brave
BRAVE_MANIFEST="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.bittery.desktop.json"
if [ -f "$BRAVE_MANIFEST" ]; then
    if command -v jq &> /dev/null; then
        jq ".allowed_origins = [\"chrome-extension://$EXTENSION_ID/\"]" "$BRAVE_MANIFEST" > "$BRAVE_MANIFEST.tmp"
        mv "$BRAVE_MANIFEST.tmp" "$BRAVE_MANIFEST"
        echo "✅ Updated Brave manifest"
    else
        sed -i '' "s|chrome-extension://[^/]*/|chrome-extension://$EXTENSION_ID/|g" "$BRAVE_MANIFEST"
        echo "✅ Updated Brave manifest (using sed)"
    fi
fi

echo ""
echo "🎉 Done! Restart your browser for changes to take effect."
