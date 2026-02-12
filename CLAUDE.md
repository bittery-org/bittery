# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bittery is a zero-knowledge password manager with multi-platform support (web, desktop via Tauri, browser extension, mobile via React Native/Expo). All sensitive data is encrypted client-side using AES-256-GCM before reaching the server. Authentication uses the SRP-6a protocol — the server never sees plaintext passwords or encryption keys.

**Security model:** Dual-key architecture (account password + Secret Key in A3-XXXXXX format). Master Unlock Key derived via PBKDF2 (310k iterations) + HKDF. RSA-4096 key pairs for vault sharing. 14-day encrypted session persistence with device keys.

## Development Commands

```bash
# Setup
pnpm install                    # Install dependencies
pnpm run db:start               # Start PostgreSQL in Docker
pnpm run db:migrate             # Apply migrations

# Development
pnpm run dev                    # All apps (web + server + desktop + extension)
pnpm run dev:web                # Web app only (port 3001)
pnpm run dev:server             # API server only (port 3000)
pnpm run dev:desktop            # Desktop app (Tauri)
pnpm run dev:extension          # Browser extension
pnpm run dev:mobile             # Mobile app (Expo)

# Quality
pnpm run check                  # Biome linting and formatting
pnpm run check-types            # TypeScript type checking across all packages
pnpm run build                  # Build all apps and packages
pnpm run test                   # Run tests via Turbo

# Database
pnpm run db:studio              # Open Drizzle Studio UI
pnpm run db:generate            # Generate migrations from schema changes
pnpm run db:migrate             # Run migrations
pnpm run db:watch               # Watch mode for DB schema changes
pnpm run db:test:setup          # Set up test database
pnpm run db:stop                # Stop database container
pnpm run db:down                # Stop and remove database container

# Building
pnpm run build:desktop          # Tauri desktop binary
pnpm run build:web              # Web app (builds WASM first)
pnpm run build:server           # Server (builds NAPI first)
pnpm run build:extension        # Chrome extension
pnpm run build:mobile           # EAS production build
pnpm run build:crypto-wasm      # Rebuild WASM bindings
pnpm run build:crypto-napi      # Rebuild NAPI bindings
pnpm run build:crypto-android   # Rebuild Android crypto bindings
pnpm run build:crypto-ios       # Rebuild iOS crypto bindings
pnpm run build:crypto           # Rebuild all crypto targets
pnpm run start:server           # Start production server
```

## Architecture

### Monorepo Structure

```
bittery/
├── apps/
│   ├── server/           # Hono + tRPC API server (Bun runtime)
│   ├── web/              # React web app (TanStack Router + Query, Vite)
│   ├── desktop/          # Tauri 2 desktop app (React frontend, Rust backend)
│   ├── extension/        # Chrome Manifest V3 extension (React)
│   └── mobile/           # React Native app (Expo)
├── packages/
│   ├── api/              # tRPC router definitions
│   ├── auth/             # Server-side SRP-6a auth + JWT sessions
│   ├── crypto/           # Unified crypto (Rust core + platform bindings)
│   │   ├── core/         # Rust workspace (bittery-crypto-core, bittery-crypto-wasm, bittery-crypto-ffi)
│   │   ├── wasm/         # Built WASM package (@bittery/crypto-wasm)
│   │   ├── napi/         # NAPI bindings for Bun/Node (@bittery/crypto-napi)
│   │   └── expo-module/  # Expo module for React Native (@bittery/crypto-nitro)
│   ├── core/             # Central business logic, services, and shared React hooks
│   ├── db/               # Drizzle ORM schema + PostgreSQL migrations
│   ├── jobs/             # Job queue and scheduler (pg-boss)
│   ├── pubsub/           # Publish-subscribe messaging abstraction
│   ├── storage/          # Platform-specific storage adapters
│   ├── sync/             # Offline sync, query invalidation, WebSocket sync manager
│   ├── shared/           # Shared utilities, tRPC client helpers, types
│   ├── types/            # Shared TypeScript type definitions (crypto types)
│   ├── ui/               # Shared UI components (Radix UI + shadcn/ui + Tailwind 4 + Icons)
│   └── config/           # Shared TypeScript configuration
```

**Key dependency flow:**
- Apps → `core`, `storage`, `shared`, `sync`, `ui`, `types` + platform-specific crypto binding
- `core` → `storage`, `shared`, `types` (platform-agnostic via `PlatformProvider` context)
- `server` → `api`, `auth`, `db`, `jobs`, `pubsub`
- `api` → `auth`, `db`
- `auth` → `db`, `crypto-napi`

### tRPC API (`packages/api/src/routers/`)

Five routers combined in `appRouter` (plus top-level `healthCheck` and `privateData` procedures):

| Router | Key procedures |
|--------|---------------|
| **auth** | `registrationStatus`, `signup`, `signupWithInvitation`, `startLogin`, `finishLogin`, `quickUnlock`, `checkEmail`, `me`, `logout`, `logoutAll`, `updateEmail`, `changePassword`, `regenerateSecretKey`, `deleteAccount`, `listDevices`, `revokeDevice`, `renameDevice`, `heartbeat` |
| **vault** | `list`, `get`, `create`, `update`, `delete`, `createImageUpload`, `stats`, item CRUD (`listItems`, `listAllItems`, `listAllDeletedItems`, `getItem`, `createItem`, `bulkImportItems`, `updateItem`, `toggleFavorite`, `deleteItem`, `listDeletedItems`, `restoreItem`, `moveItem`, `permanentlyDeleteItem`), nested `members` sub-router (`list`, `updateRole`, `remove`, `getRotationData`, `lookupUser`, `add`) |
| **team** | `list`, `get`, `create`, `update`, `delete`, `createImageUpload`, `leave`, `vaults`, nested `members` sub-router (`list`, `remove`, `deleteAccount`), nested `invitations` sub-router (`getByToken`, `list`, `send`, `cancel`, `resend`, `pending`, `accept`, `decline`) |
| **share** | `create`, `listByItem`, `get`, `revoke`, `update`, `getAccessLogs`, `getPublicInfo`, `requestEmailVerification`, `verifyEmailAndAccess`, `accessPublic` |
| **sync** | `getEventsSince`, `bootstrapItems`, `getSyncState`, `acknowledgeEvents`, `getLastAcknowledged`, `checkConflict` |

**Procedure types:** `publicProcedure` (no auth) and `protectedProcedure` (requires JWT, provides `ctx.session` with `{userId, email, sessionId}`).

### Database Schema (`packages/db/src/schema/`)

| File | Tables | Notes |
|------|--------|-------|
| `auth.ts` | `user`, `session`, `loginRateLimit`, `auditLog` | User has SRP credentials, RSA keys, `teamId` (one-to-one). Session tracks device info (platform, browser, OS). Rate limiting and audit logging. |
| `vault.ts` | `vault`, `vaultKey`, `item`, `folder`, `vaultKeyRotation` | Vault has `keyVersion`, `icon`, `imageKey`. Items have categories: `login`, `secure-note`, `credit-card`, `identity`, `totp`. VaultKey stores per-user encrypted keys with role. |
| `team.ts` | `team`, `teamMember` (deprecated, still in schema), `teamInvitation` | Team types: `personal`, `family`, `organization`. User now references team directly via `user.teamId`. |
| `sharing.ts` | `shareLink`, `shareLinkAllowedEmail`, `shareEmailVerification`, `shareAccessLog`, `shareLinkRateLimit` | Encrypted share links with email-restricted or public access, one-time use, expiration, audit logging. |
| `sync.ts` | `syncEvent`, `syncEventAck` | Event-based sync for multi-device. Event types: item/vault CRUD, member changes, key rotation. |

**Patterns:** Soft deletes via `deletedAt` timestamp. All tables have `createdAt`/`updatedAt`. Vault roles: `owner`, `admin`, `member`, `read-only`.

### Crypto Architecture

All crypto is implemented in Rust (`packages/crypto/core/crates/bittery-crypto-core/src/`) and compiled to platform-specific bindings:

| Platform | Binding | Crypto wrapper |
|----------|---------|----------------|
| Web | WASM | `apps/web/src/lib/wasm-crypto.ts` (+ `worker-crypto.ts` / `crypto.worker.ts` for web worker offloading) |
| Server | NAPI | `@bittery/crypto-napi` (used by `packages/auth/`) |
| Desktop | Tauri commands | `apps/desktop/src/lib/tauri-crypto.ts` |
| Extension | WASM | `apps/extension/src/lib/wasm-crypto.ts` (+ `crypto-adapter.ts`) |
| Mobile | Expo module | `apps/mobile/src/lib/crypto/` (wraps `@bittery/crypto-nitro`) |

**Rust core modules** (`packages/crypto/core/crates/bittery-crypto-core/src/`):
- `key_derivation.rs` — PBKDF2(SHA-256, 310k iter, salt=lowercase email) + HKDF split into `authKey` ("bittery-auth-key") and `masterUnlockKey` ("bittery-unlock-key")
- `encryption.rs` — AES-256-GCM encrypt/decrypt
- `rsa.rs` — RSA-4096 OAEP key pair generation, encrypt, decrypt
- `secret_key.rs` — A3-XXXXXX format generation/validation
- `srp6a/` — Full SRP-6a client + server implementation
- `key_rotation.rs` — Vault key rotation and re-encryption
- `passkey.rs` — WebAuthn/passkey authentication support

**Never import crypto primitives directly — always use platform-specific wrappers.**

### Encryption Layers

```
Master Unlock Key (derived from password + secretKey + email)
  ├─ Encrypts vault keys (stored per-user in vaultKey table)
  │   └─ Vault key encrypts item data (AES-256-GCM, random IV per operation)
  └─ Encrypts RSA-4096 private key

RSA key pair (per user):
  ├─ Public key: encrypts vault keys when sharing with team members
  └─ Private key: encrypted with Master Unlock Key
```

### Core Package (`packages/core`)

Central business logic and shared React hooks. All apps inject dependencies via `PlatformProvider`:

```tsx
<PlatformProvider storage={storage} crypto={crypto} sync={syncContext} autolock={autolockService}>
  {children}
</PlatformProvider>
```

Props: `storage` and `crypto` are required; `sync` and `autolock` are optional. There is also a deprecated `itemDecrypt` prop.

**Key services** (`packages/core/src/services/`): `AccountResolver`, `CacheManager`, `ItemService`, `VaultService`, `ShareService`

**Auth utilities** (`packages/core/src/services/auth-service.ts` and `packages/core/src/auth/`): `performSRPLogin`, `performSRPUnlock`, `storeLoginSession`, `storeUnlockSession`, `getSessionState`, `checkEmailExists`, `clearSession` (used by extension service worker and other non-React contexts)

**Autolock factories:** `createWebAutolockService()` (web), `createMobileAutolockService()` (mobile)

### Storage Adapters (`packages/storage`)

| Adapter | Platform | Backend | Multi-account | Biometric |
|---------|----------|---------|---------------|-----------|
| `web.ts` | Web | localStorage + sessionStorage | No | No |
| `chrome.ts` | Extension | chrome.storage.local/session | No | No |
| `tauri.ts` | Desktop | Tauri Store + OS Keychain | Yes | Yes |
| `react-native.ts` | Mobile | SecureStore + SQLite | Yes | Yes |

All implement `IStorageAdapter` interface. Master Unlock Key is kept in memory only — never persisted unencrypted.

## Development Guidelines

**Security:** All sensitive data must be encrypted client-side before API calls. Never log Master Unlock Key, vault keys, or decrypted passwords.

**Database:** Use Drizzle migrations (`pnpm run db:generate` then `pnpm run db:migrate`). Soft deletes via `deletedAt`. Always include `createdAt`/`updatedAt`.

**tRPC:** Router changes in `packages/api` auto-propagate types to all clients. Use `protectedProcedure` for authenticated endpoints.

**Cross-platform:** Never import crypto primitives directly — use app-specific wrappers. All apps use `@bittery/core` with `PlatformProvider` for shared logic.

**Item types:** Categories: `login`, `secure-note`, `credit-card`, `identity`, `totp`. All sensitive item data is stored in `encryptedData` (AES-256-GCM). Each item has `encryptionIv` and `encryptionAlgorithm` columns. Always generate random IV per encryption.

**UI:** Components in `packages/ui` use Radix UI + shadcn/ui + Tailwind CSS 4 + CVA for variants.

## Environment Setup

Required in `apps/server/.env` (see `.env.example`):
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bittery
JWT_SECRET=<random-secret>
CORS_ORIGIN=http://localhost:3000,http://localhost:8080,http://localhost:5173,http://localhost:3001,http://localhost:3002
WEB_APP_URL=http://localhost:3001
BITTERY_MODE=cloud              # "cloud" or "self-hosted"

# S3-compatible storage (for image uploads)
BITTERY_STORAGE_ENDPOINT
BITTERY_STORAGE_BUCKET
BITTERY_STORAGE_ACCESS_KEY_ID
BITTERY_STORAGE_SECRET_ACCESS_KEY
BITTERY_STORAGE_REGION         # default: "auto"
BITTERY_STORAGE_CDN_URL        # or BITTERY_STORAGE_PUBLIC_URL
```
