# Bittery Browser Extension

Chrome extension (Manifest V3) for the Bittery password manager with secure autofill capabilities.

## Features

- **Zero-knowledge architecture**: Master Unlock Key never leaves your device
- **Secure autofill**: Shadow DOM + iframe isolation (1Password pattern)
- **Quick unlock**: Password-only unlock for 14 days after full login
- **Time-based re-authentication**: 5-minute window for autofill security
- **Hot reload development**: Fast development with @crxjs/vite-plugin

## Architecture

### Components

- **Popup UI** (`popup.tsx`): React app with TanStack Router for vault management
  - `/login` - Full login with email, password, and Secret Key
  - `/unlock` - Quick unlock with password only
  - `/vault` - Browse and search vault items
  - `/item/:id` - View and copy item details

- **Background Service Worker** (`background.ts`): 
  - Manages Master Unlock Key in memory
  - Handles all cryptographic operations
  - Proxies tRPC calls to API server
  - Tracks autofill authentication state

- **Content Script** (`content.ts`):
  - Detects password/username/email fields
  - Injects shadow DOM with iframe for autofill UI
  - Filters items by hostname
  - Keyboard navigation (↑↓ Enter Esc)

- **Autofill Iframe** (`autofill-iframe.tsx`):
  - Isolated React app for credential selection
  - Secure communication via postMessage
  - Keyboard navigation support

### Storage

Uses `chrome.storage` APIs via adapter in `@bittery/crypto`:

- **chrome.storage.local**: Secret Key, encrypted session data, device key
- **chrome.storage.session**: JWT token, encrypted vault keys
- **Memory**: Master Unlock Key (service worker lifecycle)

### Security Features

- **14-day quick unlock window**: Secret Key stored on device, encrypted Master Unlock Key
- **5-minute autofill re-auth**: Requires re-authentication if >5min since last autofill
- **Shadow DOM isolation**: Autofill UI isolated from page scripts
- **iframe security**: Additional isolation layer for credential display

## Development

### Prerequisites

```bash
pnpm install
```

### Run in development mode

```bash
cd apps/extension
pnpm dev
```

This will:
1. Build the extension with hot reload enabled
2. Output to `dist/` directory
3. Watch for changes and rebuild automatically

### Load in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `apps/extension/dist` directory

### Build for production

```bash
pnpm build
```

The production-ready extension will be in `dist/`.

## Project Structure

```
apps/extension/
├── manifest.json           # Extension manifest (MV3)
├── popup.html             # Popup entry point
├── autofill-iframe.html   # Autofill iframe entry point
├── src/
│   ├── popup.tsx          # Popup app entry
│   ├── background.ts      # Service worker
│   ├── content.ts         # Content script
│   ├── autofill-iframe.tsx # Autofill UI
│   ├── routes/            # TanStack Router routes
│   │   ├── __root.tsx
│   │   ├── index.tsx
│   │   ├── login.tsx
│   │   ├── unlock.tsx
│   │   ├── vault.tsx
│   │   └── item.$itemId.tsx
│   └── pages/             # Page components
│       ├── login.tsx
│       ├── unlock.tsx
│       ├── vault.tsx
│       └── item-detail.tsx
└── icons/                 # Extension icons
```

## Shared Packages

The extension uses shared packages:

- **@bittery/ui**: shadcn components (Button, Input, Card, etc.)
- **@bittery/shared**: Utilities (crypto wrappers, favicon, tRPC)
- **@bittery/crypto**: Core cryptography (including chrome.storage adapter)
- **@bittery/api**: tRPC router types

## Configuration

### API Server URL

Update the tRPC client URL in:
- `src/popup.tsx` (line ~20)
- `src/background.ts` (line ~20)

Default: `http://localhost:3000/trpc`

## Permissions

The extension requires:

- `storage`: For chrome.storage APIs
- `activeTab`: For content script injection
- `scripting`: For dynamic script injection
- `clipboardWrite`: For copy-to-clipboard features
- `<all_urls>`: For autofill on any website

## Notes

- Icons need to be added to `icons/` directory (16x16, 32x32, 48x48, 128x128)
- Extension popup is 375px wide by default
- Master Unlock Key is cleared when service worker is terminated
- Session data is encrypted with device-specific key
