# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bittery is a zero-knowledge password manager with multi-platform support (web, desktop via Tauri, browser extension). The core security model ensures all sensitive data is encrypted client-side using AES-256-GCM before reaching the server. Authentication uses SRP-6a protocol, meaning the server never has access to plaintext passwords or encryption keys.

**Key Security Features:**
- Zero-knowledge authentication (SRP-6a protocol)
- Client-side AES-256-GCM encryption for vault data
- Dual-key architecture: account password + Secret Key (1Password-style A3-XXXXXX format)
- Master Unlock Key derivation using PBKDF2 (100k iterations) + HKDF key splitting
- RSA-4096 key pairs for secure vault sharing between users
- 14-day encrypted session persistence with device keys

## Development Commands

### Setup
```bash
pnpm install                    # Install dependencies
pnpm run db:generate              # Start PostgreSQL in Docker
pnpm run db:migrate               # Apply migrations to database
```

### Development
```bash
pnpm run dev                   # Run all apps (web + server + desktop + extension)
pnpm run dev:web               # Web app only (port 3001)
pnpm run dev:server            # API server only (port 3000)
pnpm run dev:desktop           # Desktop app only (Tauri)
pnpm run dev:extension         # Browser extension only
```

### Database
```bash
pnpm run db:studio             # Open Drizzle Studio UI
pnpm run db:generate           # Generate migrations from schema changes
pnpm run db:migrate            # Run migrations
pnpm run db:watch              # Watch database logs (docker compose up)
pnpm run db:stop               # Stop database container
pnpm run db:down               # Stop and remove database container
```

### Quality
```bash
pnpm run check                 # Run Biome linting and formatting
pnpm run check-types           # TypeScript type checking across all packages
pnpm run build                 # Build all apps and packages
```

### Desktop App
```bash
pnpm run build:desktop         # Build Tauri desktop app
```

### Browser Extension
```bash
pnpm run build:extension       # Build Chrome extension
```

### Mobile Native Crypto (requires Rust toolchain)
```bash
cd packages/crypto/expo-module
./scripts/build-android.sh     # Build Android .so files (requires Android NDK)
./scripts/build-ios.sh         # Build iOS xcframework (requires Xcode)
```

## Architecture Overview

### Monorepo Structure

```
bittery/
├── apps/
│   ├── server/           # Hono + tRPC API server (Bun runtime)
│   ├── web/              # React web app (TanStack Router + Query)
│   ├── desktop/          # Tauri desktop app
│   ├── extension/        # Chrome/Firefox browser extension
│   └── mobile/           # React Native app (Expo)
├── packages/
│   ├── api/              # tRPC router definitions (auth, vault, team)
│   ├── auth/             # SRP-6a authentication logic
│   ├── crypto/           # Unified crypto package
│   │   ├── core/         # Rust workspace (WASM, FFI builds)
│   │   ├── wasm/         # Built WASM package (@bittery/crypto-wasm)
│   │   ├── napi/         # Standalone NAPI package (@bittery/crypto-napi)
│   │   └── expo-module/  # Expo module for React Native (@bittery/crypto-nitro)
│   ├── db/               # Drizzle ORM schema + migrations
│   ├── storage/          # Storage Adapters for the different platforms
│   ├── hooks/            # Core React hooks for repeated logic like decryption, sign in etc.
│   ├── shared/           # Shared utilities and tRPC client helpers
│   ├── ui/               # Shared UI components (Radix UI + shadcn/ui)
│   └── config/           # Shared TypeScript configuration
```

**Dependencies between packages:**
- `api` depends on: `auth`, `db`
- `auth` depends on: `db`, `crypto-napi`
- `hooks` depends on: `storage`, `shared`
- `storage` depends on: `shared` (client-side only)
- `web`, `desktop`, `extension`, `mobile` depend on: `api`, `hooks`, `storage`, `ui`, `shared`
- `server` depends on: `api`, `auth`, `db`

### tRPC API Organization

The API is defined in `packages/api/src/routers/`:

**Auth Router** (`auth.ts`):
- `signup` - Creates user with SRP credentials, generates RSA key pair, creates initial vault
- `startLogin` - Initiates SRP challenge (returns server ephemeral)
- `finishLogin` - Completes SRP handshake, verifies proof, creates JWT session
- `quickUnlock` - Fast password-only unlock (uses stored secret key from device)
- `logout` - Invalidates session

**Vault Router** (`vault.ts`):
- `list` - Get all vaults user has access to (returns encrypted vault keys)
- `get` - Get vault details with member count
- `create` - Create new vault (personal or team)
- `update`, `delete` - Vault management
- `listItems` - List items in vault (excludes soft-deleted)
- `getItem`, `createItem`, `updateItem`, `deleteItem` - Item CRUD
- `createImageUpload` - Generate presigned S3 upload URL for vault images
- Member management endpoints

**Team Router** (`team.ts`):
- Team CRUD operations
- `inviteMember` - Send team invitation with token
- `acceptInvitation` - Accept invite and join team

**Procedure Types:**
- `publicProcedure` - No authentication required
- `protectedProcedure` - Requires valid JWT in Authorization header, provides `ctx.session`

### Authentication Flow (SRP-6a)

**Signup:**
1. Client derives authentication key and Master Unlock Key from `(password + secretKey)` using PBKDF2 + HKDF
2. Client generates SRP salt and verifier from authentication key
3. Client generates RSA-4096 key pair (private key encrypted with Master Unlock Key)
4. Server stores: `srpSalt`, `srpVerifier`, `publicKey`, `encryptedPrivateKey`
5. Initial personal vault created automatically

**Login (Zero-Knowledge):**
1. Client generates ephemeral key pair
2. Server responds with server ephemeral (challenge)
3. Client derives session proof from password
4. Server verifies client proof, derives session, generates JWT
5. Client verifies server proof (mutual authentication)

**Quick Unlock:**
- Requires stored secret key on device + valid encrypted session
- Skips full SRP flow, uses cached Master Unlock Key
- Enables fast re-authentication on same device

**Session Storage:**
- JWT token in `sessionStorage` (short-lived)
- Master Unlock Key cached in memory during session
- Encrypted session in `localStorage` (14 days, encrypted with device key)
- Secret Key stored in plaintext in `localStorage` (only useful with password)

### Database Schema

**Authentication** (`packages/db/src/schema/auth.ts`):
- `user` - Stores SRP credentials (`srpSalt`, `srpVerifier`), RSA keys, secret key hint
- `session` - JWT sessions with expiry (30 days)

**Vaults & Items** (`packages/db/src/schema/vault.ts`):
- `vault` - Vault metadata (type: "personal" | "team")
- `vaultKey` - Per-user encrypted vault encryption keys with role-based access
- `item` - Vault items with category ("login" | "secure-note" | "credit-card" | "identity")
  - `overview` - JSONB unencrypted metadata (title, url, username)
  - `encryptedData` - AES-256-GCM encrypted sensitive fields
- `folder` - Hierarchical organization (self-referential)

**Teams** (`packages/db/src/schema/team.ts`):
- `team` - Team metadata
- `teamMember` - User-team associations with roles
- `teamInvitation` - Pending invitations with encrypted vault keys

**Access Control:**
- Vault roles: `owner`, `admin`, `member`, `read-only`
- Team roles: `owner`, `admin`, `member`
- Enforced at API level before returning/modifying data

### Encryption Architecture

**Key Derivation** (`packages/crypto/src/key-derivation.ts`):
```
Input: accountPassword + secretKey + email

1. Combine: password|secretKey
2. PBKDF2(SHA-256, 100k iterations) → masterKey
3. HKDF(SHA-256) with different info strings:
   - "bittery-auth-key" → authKey (for SRP authentication)
   - "bittery-unlock-key" → masterUnlockKey (for vault encryption)
```

**Encryption Layers:**
```
Master Unlock Key (derived from password + secret key)
  ├─ Encrypts: Vault encryption keys (stored in vaultKey table)
  │   └─ Used to encrypt: Item sensitive data (AES-256-GCM)
  └─ Encrypts: RSA private key (for vault sharing)

RSA-4096 Keys (per user):
  ├─ Public key: Encrypts vault keys when sharing with team members
  └─ Private key: Encrypted with Master Unlock Key
```

**Item Encryption Flow:**
1. Retrieve encrypted vault key from `vaultKey` table
2. Decrypt vault key using Master Unlock Key
3. Encrypt item sensitive data with vault key (AES-256-GCM, random IV)
4. Send to server: `{overview, encryptedData, encryptionIv, encryptionAlgorithm}`

**Vault Sharing:**
- When user added to team vault: vault key encrypted with their RSA public key
- User decrypts vault key with their RSA private key
- No plaintext vault keys ever reach the server

### Crypto Architecture

All crypto operations use a unified Rust core (`packages/crypto/core/`) compiled to platform-specific bindings:

| Platform | Binding | Wrapper Location |
|----------|---------|------------------|
| Web | WASM | `apps/web/src/lib/wasm-crypto.ts` |
| Server | NAPI | `@bittery/crypto-napi` (used by `packages/auth/`) |
| Desktop | Tauri commands | `apps/desktop/src/lib/tauri-crypto.ts` |
| Extension | WASM | `apps/extension/src/lib/wasm-crypto.ts` |
| Mobile | Expo module | `apps/mobile/src/lib/crypto/` (wraps `@bittery/crypto-nitro`) |

**`packages/crypto/core/`** - Rust workspace with crates:
- `bittery-crypto-core` - Core crypto primitives (key derivation, AES-GCM, RSA, SRP-6a)
- `bittery-crypto-wasm` - WASM bindings via wasm-bindgen (builds to `packages/crypto/wasm/`)
- `bittery-crypto-ffi` - C FFI + JNI for React Native

**`packages/crypto/napi/`** - Standalone NAPI package:
- NAPI bindings for Bun/Node server (depends on core via path)

**Important: Master Unlock Key is kept in memory only during active session. Never persisted unencrypted.**

### Client Storage (`packages/storage`)

Platform-specific storage adapters for secure client-side data persistence. All apps use these adapters for session management, vault keys, and settings.

**`packages/storage/src/`** - Storage adapter interfaces and implementations:
- `adapter.ts` - `IStorageAdapter` interface defining the contract
- `types.ts` - Shared types (`VaultKeyData`, `StoredSessionData`, `AccountMetadata`, `ActiveAccount`)
- `crypto-provider.ts` - Interface for injecting platform crypto into storage adapters

**`packages/storage/src/adapters/`** - Platform implementations:
- `web.ts` - Web storage adapter (localStorage + sessionStorage)
- `chrome.ts` - Chrome extension storage adapter (chrome.storage.local + chrome.storage.session)
- `tauri.ts` - Desktop storage adapter (Tauri Store + OS Keychain for biometric)
- `react-native.ts` - Mobile storage adapter (SecureStore + SQLite)

**Key Features:**
- Multi-account support (desktop/mobile only): Store multiple account sessions simultaneously
- Biometric authentication (desktop/mobile only): Secure Master Unlock Key with device biometrics
- Device-specific encryption: Master Unlock Key encrypted with device key before persistence
- Session management: JWT tokens, encrypted sessions (14-day expiry), vault keys, secret keys
- Auto-lock support: Configurable timeout with Master Unlock Key cleared from memory

**Storage Hierarchy:**
```
Session Storage (in-memory + encrypted persistence):
  ├─ Master Unlock Key (memory only while unlocked)
  ├─ JWT Token (sessionStorage or chrome.storage.session)
  ├─ Encrypted Session Data (localStorage or chrome.storage.local)
  │   └─ Contains: Encrypted Master Unlock Key (with device key)
  ├─ Secret Key (plaintext in localStorage - only useful with password)
  ├─ Vault Keys (encrypted with Master Unlock Key)
  └─ Account Metadata (for multi-account: email, userId, lastActiveAt, biometricEnabled)
```

**Multi-Account Support:**
- Desktop and mobile support switching between multiple logged-in accounts
- Active account tracked via `ActiveAccount` type: `{type: "single", email}` or `{type: "all"}` or `null`
- Each account has independent session data, vault keys, and biometric settings
- Web and extension are single-account only (simpler UX)

### React Hooks (`packages/hooks`)

Shared React hooks for authentication, vault management, and item operations. Platform-agnostic - works across web, desktop, extension, and mobile by injecting platform-specific dependencies via `PlatformProvider`.

**`packages/hooks/src/`** - Hook organization:
- `context/platform-context.tsx` - `PlatformProvider` for injecting storage, crypto, sync dependencies
- `auth/` - Non-React authentication utilities (SRP login/unlock logic)
- `hooks/auth/` - React hooks for authentication (`useLogin`, `useQuickUnlock`, `useBiometricUnlock`, etc.)
- `hooks/vault/` - React hooks for vault operations (`useCreateVault`, `useUpdateVault`, `useDeleteVault`)
- `hooks/items/` - React hooks for item operations (`useCreateItem`, `useUpdateItem`, `useDeleteItem`, etc.)
- `hooks/internal/` - Internal hooks for vault key decryption and item decryption
- `services/` - Platform services (autolock implementations for web/mobile)
- `types.ts` - Shared types and interfaces

**Key Hooks:**

*Authentication:*
- `useLogin(options)` - Full SRP login flow with secret key
- `useQuickUnlock(options)` - Fast unlock with stored secret key
- `useBiometricUnlock(options)` - Biometric authentication (Touch ID/Face ID)
- `useLogout()` / `useLock()` - Session termination
- `useSessionState()` - Current session state (locked, unlocked, authenticated)
- `useAccountSwitcher()` - Multi-account management (desktop/mobile)

*Vault Operations:*
- `useCreateVault()` - Create new personal or team vault
- `useUpdateVault()` - Update vault metadata
- `useDeleteVault()` - Soft delete vault

*Item Operations:*
- `useCreateItem()` - Create encrypted vault item
- `useUpdateItem()` - Update encrypted item
- `useDeleteItem()` - Soft delete item (moves to trash)
- `usePermanentDeleteItem()` - Permanently delete from trash
- `useRestoreItem()` - Restore from trash
- `useMoveItem()` - Move item between vaults
- `useToggleFavorite()` - Toggle favorite status

*Unified Data Access:*
- `useItem(itemId)` - Fetch and decrypt single item (searches across all vaults)
- `useItems()` - Fetch and decrypt items from active vault(s)
- `useVaultItems(vaultId)` - Fetch items from specific vault
- `useVaultSearch(query)` - Search items across vaults

**PlatformProvider Pattern:**
Each app wraps its root with `PlatformProvider`, injecting platform-specific implementations:

```tsx
import { PlatformProvider } from "@bittery/hooks";
import * as crypto from "@/lib/wasm-crypto"; // or tauri-crypto, etc.
import { storage } from "@/lib/storage"; // platform storage adapter
import { useSyncContext } from "@/providers/sync-provider";

function App() {
  const syncContext = useSyncContext();
  return (
    <PlatformProvider
      storage={storage}
      crypto={crypto}
      sync={syncContext}
      autolock={autolockService}
    >
      {children}
    </PlatformProvider>
  );
}
```

**Authentication Utilities (Non-React):**
`packages/hooks/src/auth/` provides core authentication logic that can be used outside React (e.g., extension service worker):
- `performSRPLogin(input, deps)` - Execute SRP login flow
- `performSRPUnlock(input, deps)` - Execute quick unlock flow
- `storeLoginSession(result, storage, email?)` - Persist session after login
- `storeUnlockSession(result, storage, email?)` - Persist session after unlock
- `getSessionState(storage, email?)` - Check current session state
- `clearSession(storage, email?)` - Clear session data

### Cloud Storage Integration

S3-compatible storage (AWS S3, R2, MinIO) for vault attachments and images:
- Presigned upload URLs (5 min expiry) via `vault.createImageUpload`
- Presigned download URLs (5 min expiry)
- Key naming: `vaults/{userId}/{vaultId}/{uuid}-{filename}`
- CDN proxy endpoint: `GET /cdn/*` redirects to signed S3 URLs

**Environment Variables:**
```
BITTERY_STORAGE_ENDPOINT
BITTERY_STORAGE_BUCKET
BITTERY_STORAGE_ACCESS_KEY_ID
BITTERY_STORAGE_SECRET_ACCESS_KEY
BITTERY_STORAGE_REGION (default: "auto")
BITTERY_STORAGE_CDN_URL or BITTERY_STORAGE_PUBLIC_URL
```

### UI Components (`packages/ui`)

Shared component library built on:
- Radix UI primitives
- shadcn/ui patterns
- Tailwind CSS 4
- class-variance-authority (cva) for variants

Key components:
- `password-generator.tsx` - Password generation with strength indicator
- Form components: Button, Input, Label, Textarea, Select
- Overlays: Dialog, Dropdown Menu, Popover, Command palette
- Feedback: Toast (Sonner), Alert
- Layout: Card, Separator, Tabs

### Application-Specific Notes

**Desktop App** (`apps/desktop`):
- Built with Tauri 2 (Rust backend, React frontend)
- Crypto via Tauri commands in `src-tauri/src/crypto_commands.rs` (calls `bittery-crypto-core` directly)
- Biometric unlock via Tauri plugins (Touch ID/Face ID)
- Native messaging host for extension-to-desktop communication

**Browser Extension** (`apps/extension`):
- Chrome Manifest V3 extension
- Crypto via WASM loaded in service worker (`src/lib/wasm-crypto.ts`)
- Background service worker manages Master Unlock Key in memory
- Auto-lock with configurable timeout (10 min default)
- Native messaging bridge to desktop app for biometric unlock

**Web App** (`apps/web`):
- TanStack Router + TanStack Query
- Crypto via WASM (`src/lib/wasm-crypto.ts`), initialized in router
- Sign-up/sign-in flows complete with emergency kit download

**Mobile App** (`apps/mobile`):
- React Native with Expo
- Crypto via `@bittery/crypto-nitro` Expo module (Rust FFI)
- Credential Provider module (`modules/credential-provider/`) for Android autofill, uses same native crypto

### Development Guidelines

**Security:**
- All sensitive data must be encrypted client-side before API calls
- Never log or expose Master Unlock Key, vault keys, or decrypted passwords
- Use SRP authentication for all password-based operations
- Validate encrypted data structure before decryption

**Database:**
- Use Drizzle migrations for schema changes: `pnpm run db:generate`
- Soft deletes: set `deletedAt` timestamp, filter with `WHERE deletedAt IS NULL`
- Always include `createdAt`/`updatedAt` for audit trail

**tRPC:**
- Changes to routers in `packages/api` automatically propagate types to clients
- Use `protectedProcedure` for authenticated endpoints
- Context provides `ctx.session` with `{userId, email, sessionId}`

**Components:**
- Follow existing patterns in `packages/ui` for consistency
- Use cva for component variants
- Radix UI for accessible primitives

**Cross-Platform:**
- All crypto uses Rust core (`packages/crypto/core/`) with platform-specific bindings
- Each app has its own crypto wrapper (see Crypto Architecture section)
- Platform-specific storage adapters in `packages/storage/src/adapters/`
- All apps use `@bittery/hooks` for shared logic, injecting platform dependencies via `PlatformProvider`
- Never import crypto primitives directly - use app-specific wrappers

**Item Types:**
- Supported categories: `login`, `secure-note`, `credit-card`, `identity`
- `overview` contains unencrypted searchable metadata
- `encryptedData` contains all sensitive fields
- Always generate random IV for each encryption operation

### Testing Notes

- Test auth flows with full SRP handshake verification
- Verify encrypted data structure matches expected format
- Test vault sharing with RSA key encryption
- Test session expiry and quick unlock flows
- Test biometric unlock on macOS desktop app
- Test extension autofill with various website forms

### Environment Setup

Required environment variables in `apps/server/.env`:
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bittery
JWT_SECRET=<random-secret>
BITTERY_STORAGE_* (for S3 storage)
```

### Common Tasks

**Add new item field:**
1. Update schema in relevant item type (login/card/identity)
2. Update encryption/decryption in client code
3. Update form components to include new field
4. No server changes needed (encrypted blob)

**Add new tRPC endpoint:**
1. Define in `packages/api/src/routers/`
2. Use `publicProcedure` or `protectedProcedure`
3. Types automatically available in all client apps

**Database migration:**
1. Modify schema in `packages/db/src/schema/`
2. Run `pnpm run db:generate` to create migration
3. Run `pnpm run db:migrate` to apply

**Add UI component:**
1. Create in `packages/ui/src/components/`
2. Export from `packages/ui/src/index.ts`
3. Available in all apps via `@bittery/ui`
