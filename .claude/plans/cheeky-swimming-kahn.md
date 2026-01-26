# Unified Storage Adapter & Shared Hooks Architecture

## Problem Summary

1. **Storage Duplication**: 4 platform-specific storage implementations with similar logic but different APIs
2. **Hooks Duplication**: ~600+ lines of duplicate code across apps (`useDecryptedItems`, `useAllDecryptedItems`, etc.)
3. **Desktop Security Gap**: Uses Tauri Store (JSON file) instead of OS keychain for sensitive data
4. **Inconsistent Autolock**: Web has settings but no enforcement; each platform implements differently
5. **Poor Package Organization**: Storage adapters currently live in `@bittery/crypto` but aren't crypto-related

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     @bittery/hooks                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │PlatformProvider │  │ Shared Hooks    │  │ Autolock    │ │
│  │ (React Context) │  │ - useDecrypted* │  │ Service     │ │
│  └────────┬────────┘  └────────┬────────┘  └──────┬──────┘ │
└───────────┼─────────────────────┼─────────────────┼────────┘
            │                     │                 │
            ▼                     ▼                 ▼
┌─────────────────────────────────────────────────────────────┐
│              @bittery/storage (repurposed)                  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              IStorageAdapter Interface                  ││
│  └─────────────────────────────────────────────────────────┘│
│       │            │             │              │           │
│  ┌────▼───┐  ┌─────▼────┐  ┌────▼─────┐  ┌────▼─────┐     │
│  │  Web   │  │Extension │  │ Desktop  │  │  Mobile  │     │
│  │Adapter │  │ Adapter  │  │ Adapter  │  │ Adapter  │     │
│  └────────┘  └──────────┘  └──────────┘  └──────────┘     │
│                               │                            │
│                          ┌────▼─────┐                      │
│                          │ Keychain │ (OS secure storage)  │
│                          └──────────┘                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│           @bittery/crypto (Rust workspace)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │   core   │  │   wasm   │  │   napi   │  │expo-module │  │
│  │ (Rust)   │  │ (bindings│  │(bindings)│  │ (RN FFI)   │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
│                                                             │
│  Platform bindings consumed by apps via CryptoProvider:     │
│  - Web/Extension: wasm/                                     │
│  - Server: napi/                                            │
│  - Desktop: Tauri commands (uses core directly)             │
│  - Mobile: expo-module/ (FFI)                               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   @bittery/api/storage/s3                   │
│  - S3 client (moved from @bittery/storage)                  │
│  - Presigned upload/download URLs                           │
│  - Used by server/api only                                  │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Reorganize Storage Packages ✅ COMPLETED

**Status**: COMPLETED with deviation from original plan

**Original Plan**: Move S3 code to `packages/shared/src/s3/`
**Actual Implementation**: Moved S3 code to `packages/api/src/storage/s3.ts`

**Reason for deviation**: Moving S3 to `@bittery/shared` would create a cyclic dependency because:
- `@bittery/shared` depends on `@bittery/api` (for AppRouter types in trpc.ts)
- `@bittery/api` would depend on `@bittery/shared` (for S3)

Since S3 is only used by the API/server anyway, placing it directly in `@bittery/api` is cleaner.

**Changes implemented:**

1. ✅ Created `packages/api/src/storage/s3.ts` with S3 client, presigned URLs
2. ✅ Updated imports:
   - `packages/api/src/routers/auth.ts` → imports from `../storage/s3`
   - `packages/api/src/routers/vault.ts` → imports from `../storage/s3`
   - `apps/server/src/index.ts` → imports from `@bittery/api/storage/s3`
3. ✅ Updated `packages/api/package.json` - Added AWS S3 SDK dependencies
4. ✅ Updated `apps/server/package.json` - Removed `@bittery/shared` dependency
5. ✅ Reverted `packages/shared/package.json` - Removed S3 exports and deps

**Repurposed `packages/storage/` for client-side storage:**

```
packages/storage/src/
  index.ts                      # Main exports ✅
  types.ts                      # VaultKeyData, AccountMetadata, etc. ✅
  adapter.ts                    # IStorageAdapter interface ✅
  adapters/
    index.ts                    # Adapter exports ✅
    web.ts                      # Web (localStorage/sessionStorage) ✅
    chrome.ts                   # Browser extension (chrome.storage) ✅
    tauri.ts                    # Desktop (Tauri Store + Keychain) ✅
    react-native.ts             # Mobile (SecureStore + SQLite) ✅
```

**Key interface implemented (`adapter.ts`):**
```typescript
interface IStorageAdapter {
  // Identity
  readonly platform: "web" | "extension" | "desktop" | "mobile";
  readonly supportsMultiAccount: boolean;
  readonly supportsBiometric: boolean;

  // Initialization
  initialize(): Promise<void>;

  // Session Management
  getMasterUnlockKey(email?: string): Promise<Uint8Array | null>;
  setMasterUnlockKey(key: Uint8Array, email?: string): Promise<void>;
  clearMasterUnlockKey(email?: string): Promise<void>;
  storeSessionData(muk: Uint8Array, email: string, userId: string, expiryMs?: number): Promise<void>;
  tryRestoreSession(skipBiometric?: boolean, email?: string): Promise<boolean>;
  isSessionValid(email?: string): Promise<boolean>;

  // Credentials
  storeSecretKey(key: string, email?: string): Promise<void>;
  getStoredSecretKey(email?: string): Promise<string | null>;
  storeAuthToken(token: string, email?: string): Promise<void>;
  getAuthToken(email?: string): Promise<string | null>;
  storeVaultKeys(keys: VaultKeyData[], email?: string): Promise<void>;
  getVaultKeys(email?: string): Promise<VaultKeyData[] | null>;
  getDecryptedVaultKey(vaultId: string, email?: string): Promise<Uint8Array | null>;
  storeEncryptedPrivateKey(key: string, email?: string): Promise<void>;
  getEncryptedPrivateKey(email?: string): Promise<string | null>;

  // Multi-account (desktop/mobile)
  getActiveAccountEmail(): Promise<string | null>;
  setActiveAccount(email: string): Promise<void>;
  getAccountsList(): Promise<AccountMetadata[]>;
  addAccount(metadata: AccountMetadata): Promise<void>;
  removeAccount(email: string): Promise<void>;

  // Settings
  storeAutoLockTimeout(ms: number, email?: string): Promise<void>;
  getAutoLockTimeout(email?: string): Promise<number | null>;
  storeServerUrl(url: string, email?: string): Promise<void>;
  getServerUrl(email?: string): Promise<string | null>;

  // Auth state
  isAuthenticated(email?: string): Promise<boolean>;
  canQuickUnlock(email?: string): Promise<boolean>;

  // Clear
  clearSession(email?: string): Promise<void>;
  clearAllStoredData(email?: string): Promise<void>;

  // Biometric (optional)
  isBiometricAvailable?(): Promise<boolean>;
  isBiometricEnabled?(email?: string): Promise<boolean>;
  enableBiometric?(email?: string): Promise<void>;
  disableBiometric?(email?: string): Promise<void>;
  authenticateWithBiometric?(reason?: string, email?: string): Promise<boolean>;
  canBiometricUnlock?(email?: string): Promise<boolean>;
}
```

**Design decisions:**
- All methods async (chrome.storage, SecureStore, Tauri Store are async)
- Optional `email` param for multi-account platforms
- Biometric methods optional (check `supportsBiometric`)

---

### Phase 2: Desktop Keychain Integration ✅ COMPLETED

**Status**: COMPLETED

**Changes implemented:**

1. ✅ Added `keyring` crate v3 to `apps/desktop/src-tauri/Cargo.toml`
2. ✅ Created `apps/desktop/src-tauri/src/keychain.rs` with Tauri commands:
   - `keychain_set(key, value)` - Store value in OS keychain
   - `keychain_get(key)` - Retrieve value from OS keychain (returns `Option<String>`)
   - `keychain_delete(key)` - Delete entry from OS keychain
3. ✅ Registered keychain commands in `apps/desktop/src-tauri/src/lib.rs`
4. ✅ Updated `packages/storage/src/adapters/tauri.ts`:
   - Added dynamic import of `@tauri-apps/api/core` for `invoke` function
   - Updated `getDeviceKey()` to use OS keychain instead of Tauri Store
   - Added migration path: existing device keys in Tauri Store are automatically migrated to keychain
   - Added fallback: if keychain operations fail, falls back to Tauri Store
5. ✅ Added `@tauri-apps/api` as devDependency to `packages/storage/package.json` for type checking

**What goes in keychain vs Tauri Store:**
| Data | Storage | Reason |
|------|---------|--------|
| Device Key | **Keychain** | Encrypts MUK at rest, critical |
| Encrypted MUK | Tauri Store | Already encrypted |
| Secret Key | Tauri Store | Useless without password |
| JWT/Vault Keys | Memory + Tauri Store | Session data |

**Rust implementation:**
```rust
// keychain.rs
use keyring::Entry;

const SERVICE: &str = "com.bittery.desktop";

#[tauri::command]
pub fn keychain_set(key: &str, value: &str) -> Result<(), String>;

#[tauri::command]
pub fn keychain_get(key: &str) -> Result<Option<String>, String>;

#[tauri::command]
pub fn keychain_delete(key: &str) -> Result<bool, String>;
```

**Security improvements:**
- Device key is now stored in OS-level secure storage (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- Automatic migration ensures existing users get the security upgrade seamlessly
- Graceful fallback if keychain operations fail (shouldn't happen in normal operation)

### Phase 3: Migrate Storage Adapters & Cleanup ✅ COMPLETED

**Original adapters (will be deleted after all migrations complete):**
- `packages/crypto/src/session-storage.ts` → `packages/storage/src/adapters/web.ts`
- `packages/crypto/src/storage-chrome.ts` → `packages/storage/src/adapters/chrome.ts`
- `packages/crypto/src/storage-tauri.ts` → `packages/storage/src/adapters/tauri.ts`
- `packages/crypto/src/storage-react-native.ts` → `packages/storage/src/adapters/react-native.ts`

#### Phase 3a: Web App Migration ✅ COMPLETED

**Changes implemented:**

1. ✅ Created `apps/web/src/lib/storage.ts` - Singleton `WebStorageAdapter` instance
2. ✅ Added `@bittery/storage` to `apps/web/package.json` dependencies
3. ✅ Updated all web app imports from `@bittery/crypto/session-storage` to `@/lib/storage`
4. ✅ Converted all storage function calls to use the adapter's async methods:
   - `getStoredSecretKey()` → `await storage.getStoredSecretKey()`
   - `isAuthenticated()` → `await storage.isAuthenticated()`
   - `storeAuthToken()` → `await storage.storeAuthToken()`
   - etc.
5. ✅ Added missing methods to `IStorageAdapter` interface and all adapters:
   - `getActiveAccountUserId()` - Get user ID from session
   - `getAutoLockTimeoutOrDefault()` - Get timeout with fallback to default
   - `decryptVaultKey()` - Made public for direct vault key decryption

**Files updated in web app:**
- `apps/web/src/lib/storage.ts` (new)
- `apps/web/src/router.tsx`
- `apps/web/src/routes/index.tsx`
- `apps/web/src/routes/_app.tsx`
- `apps/web/src/routes/invite.$token.tsx`
- `apps/web/src/components/sign-in-form.tsx`
- `apps/web/src/components/sign-up-form.tsx`
- `apps/web/src/components/layout/sidebar.tsx`
- `apps/web/src/components/settings/auto-lock-settings.tsx`
- `apps/web/src/components/settings/change-password-dialog.tsx`
- `apps/web/src/components/settings/delete-account-dialog.tsx`
- `apps/web/src/components/settings/regenerate-secret-key-dialog.tsx`
- `apps/web/src/components/sharing/share-item-dialog.tsx`
- `apps/web/src/components/teams/invite-dialog.tsx`
- `apps/web/src/components/vaults/add-member-dialog.tsx`
- `apps/web/src/components/vaults/vault-member-list.tsx`
- `apps/web/src/hooks/use-all-decrypted-items.ts`
- `apps/web/src/hooks/use-decrypted-items.ts`
- `apps/web/src/hooks/use-web-sync.ts`
- `apps/web/src/hooks/use-vault-keys-sync.ts`

**Key patterns used:**
```typescript
// apps/web/src/lib/storage.ts
import { WebStorageAdapter } from "@bittery/storage/adapters/web";
export const storage = new WebStorageAdapter();

// Usage in components
import { storage } from "@/lib/storage";
const secretKey = await storage.getStoredSecretKey();
```

#### Phase 3b: Extension Migration ✅ COMPLETED

**Changes implemented:**

1. ✅ Created `apps/extension/src/lib/storage.ts` with `ChromeStorageAdapter` singleton
2. ✅ Added `@bittery/storage` to `apps/extension/package.json`
3. ✅ Updated all imports from `@bittery/crypto/storage-chrome` to `@/lib/storage`
4. ✅ Converted all calls to async adapter methods

**Files updated (~13 files):**
- `apps/extension/src/background/auth-handlers.ts`
- `apps/extension/src/background/autofill-handlers.ts`
- `apps/extension/src/background/credential-handlers.ts`
- `apps/extension/src/background/native-messaging.ts`
- `apps/extension/src/background/qr-scan-handlers.ts`
- `apps/extension/src/background/session-manager.ts`
- `apps/extension/src/background/sync-manager.ts`
- `apps/extension/src/background/trpc-client.ts`
- `apps/extension/src/background/vault-handlers.ts`
- `apps/extension/src/background/vault-utils.ts`
- `apps/extension/src/pages/login.tsx`
- `apps/extension/src/pages/settings.tsx`
- `apps/extension/src/popup.tsx`

#### Phase 3c: Desktop Migration ✅ COMPLETED

**Changes implemented:**

1. ✅ Created `apps/desktop/src/lib/storage.ts` with `TauriStorageAdapter` singleton
2. ✅ Added `@bittery/storage` to `apps/desktop/package.json`
3. ✅ Added path aliases to `apps/desktop/tsconfig.json` (`@/*` -> `src/*`)
4. ✅ Updated all imports from `@bittery/crypto/storage-tauri` to `@/lib/storage`
5. ✅ Added missing methods to `TauriStorageAdapter`:
   - `getLegacyServerUrl`, `clearLegacyServerUrl`, `clearServerUrl`
   - `storeWebAppUrl`, `getWebAppUrl`, `clearWebAppUrl`, `getEffectiveWebAppUrl`
   - `clearAutoLockTimeout`, `getStoredSessionData` (public)
   - `unlockWithBiometric`, `lockAllAccounts`, `hasStoredSecretKey`
   - `clearStoredSession`, `getAccountMetadata`, `getTimeUntilExpiry`
   - `clearAccountData`, `storeMasterUnlockKey`, `addAccountToList`, `removeAccountFromList`

**Files updated (~24 files):**
- `apps/desktop/src/routes/index.tsx`
- `apps/desktop/src/routes/login.tsx`
- `apps/desktop/src/routes/unlock.tsx`
- `apps/desktop/src/routes/vault/route.tsx`
- `apps/desktop/src/routes/vault/$id/index.tsx`
- `apps/desktop/src/routes/vault/$id/trash.tsx`
- `apps/desktop/src/routes/vault/$id/$itemId/index.tsx`
- `apps/desktop/src/lib/providers.tsx`
- `apps/desktop/src/lib/vault-utils.ts`
- `apps/desktop/src/contexts/account-context.tsx`
- `apps/desktop/src/components/account-avatar.tsx`
- `apps/desktop/src/components/account-settings-dialog.tsx`
- `apps/desktop/src/components/account-switcher.tsx`
- `apps/desktop/src/components/vault/import-dialog.tsx`
- `apps/desktop/src/components/vault/share-item-dialog.tsx`
- `apps/desktop/src/components/vault/share-links-list.tsx`
- `apps/desktop/src/components/vault/use-vault-item-operations.ts`
- `apps/desktop/src/components/vault/use-vault-operations.ts`
- `apps/desktop/src/hooks/use-all-decrypted-items.ts`
- `apps/desktop/src/hooks/use-all-deleted-items.ts`
- `apps/desktop/src/hooks/use-decrypted-item.ts`
- `apps/desktop/src/hooks/use-decrypted-items.ts`
- `apps/desktop/src/hooks/use-desktop-sync.ts`
- `apps/desktop/src/hooks/use-vault-search.ts`

#### Phase 3d: Mobile Migration ✅ COMPLETED

**Changes implemented:**

1. ✅ Updated `apps/mobile/src/services/storage.ts` to use `ReactNativeStorageAdapter` singleton
2. ✅ Added `@bittery/storage` to `apps/mobile/package.json`
3. ✅ Updated all imports to use new storage adapter
4. ✅ Added `BiometricAuthResult` and `BiometricErrorType` types to storage package
5. ✅ Added missing methods to `ReactNativeStorageAdapter`:
   - `getBiometricAvailabilityDetails`, `getBiometricType`
   - `lockAllAccounts`, `hasStoredSecretKey`, `getAccountMetadata`
   - `unlockWithBiometric`, `isMasterPasswordReentryRequired`
   - `storeMasterUnlockKey`, `addAccountToList`, `removeAccountFromList`, `clearAccountData`
   - `storeBackgroundTimestamp`, `getBackgroundTimestamp`, `clearBackgroundTimestamp`
   - `shouldRequireAuthAfterBackground`, `authenticateWithBiometricEnhanced`
   - `isBiometricAuthRequiredPublic`, `decryptStoredMasterUnlockKeyPublic`

**Files updated (~8 files):**
- `apps/mobile/app/(auth)/login.tsx`
- `apps/mobile/app/(auth)/unlock.tsx`
- `apps/mobile/src/components/account-switcher.tsx`
- `apps/mobile/src/components/biometric-auth-modal.tsx`
- `apps/mobile/src/contexts/account-context.tsx`
- `apps/mobile/src/contexts/biometric-auth-context.tsx`
- `apps/mobile/src/hooks/use-credential-provider-sync.ts`
- `apps/mobile/src/services/storage.ts`

#### Phase 3e: Cleanup ✅ COMPLETED

**Changes implemented:**

1. ✅ Deleted old storage files from `packages/crypto/`:
   - `packages/crypto/src/session-storage.ts`
   - `packages/crypto/src/storage-chrome.ts`
   - `packages/crypto/src/storage-tauri.ts`
   - `packages/crypto/src/storage-react-native.ts`
2. ✅ Updated `packages/crypto/package.json`:
   - Removed old storage exports (`session-storage`, `storage-chrome`, `storage-tauri`, `storage-react-native`)
   - Removed unused dependencies (`@choochmeque/tauri-plugin-biometry-api`, `@tauri-apps/plugin-store`)
   - Removed unused peer dependencies (all expo-* packages)
   - Removed `@types/chrome` devDependency
3. ✅ Verified `@bittery/crypto` and `@bittery/storage` packages type check successfully

### Phase 4: Create Shared Hooks Package ✅ COMPLETED

**Status**: COMPLETED

> **Note**: The crypto refactoring introduced `CryptoProvider` interface in `@bittery/storage/crypto-provider.ts`.
> Storage adapters now receive crypto via constructor dependency injection. Each app creates its adapter
> by injecting platform-specific crypto (e.g., `createWebStorageAdapter(cryptoProvider)`).
> This eliminates the need for a separate `ICryptoOperations` in PlatformProvider - just inject storage.

**Changes implemented:**

1. ✅ Created `packages/hooks/package.json` - Package configuration with dependencies
2. ✅ Created `packages/hooks/tsconfig.json` - TypeScript configuration
3. ✅ Created `packages/hooks/src/types.ts` - Interfaces:
   - `IItemDecrypt` - Item decryption interface for platform-specific crypto
   - `IAutolockService` - Autolock service interface
   - `RawEncryptedItem`, `RawEncryptedItemWithVault` - API response types
4. ✅ Created `packages/hooks/src/context/platform-context.tsx`:
   - `PlatformProvider` - React context provider
   - `usePlatform()` - Main hook to access context
   - `usePlatformStorage()`, `usePlatformItemDecrypt()`, `usePlatformAutolock()` - Convenience hooks
5. ✅ Created shared hooks:
   - `packages/hooks/src/hooks/use-decrypted-items.ts` - Decrypt items from single vault
   - `packages/hooks/src/hooks/use-all-decrypted-items.ts` - Decrypt items from all vaults
   - `packages/hooks/src/hooks/use-all-deleted-items.ts` - Decrypt deleted items (trash view)
   - `packages/hooks/src/hooks/use-cross-vault-tags.ts` - Extract unique tags across vaults
6. ✅ Created `packages/hooks/src/index.ts` - Main exports

**Package structure:**
```
packages/hooks/
  package.json
  tsconfig.json
  src/
    index.ts                          # Main exports
    types.ts                          # IItemDecrypt, IAutolockService interfaces
    context/
      platform-context.tsx            # PlatformProvider, usePlatform hooks
    hooks/
      use-decrypted-items.ts          # Single vault decryption
      use-all-decrypted-items.ts      # Cross-vault decryption
      use-all-deleted-items.ts        # Trash view decryption
      use-cross-vault-tags.ts         # Tag aggregation
```

**Key design decisions:**
- `IItemDecrypt` uses `EncryptedData` object (ciphertext, iv, algorithm) matching the API response
- Hooks use vault key caching to avoid repeated decryption across items
- All hooks properly type-check with `@bittery/shared/types` (DecryptedItem, ItemCategory)
- Uses efficient single-query endpoints (`listAllItems`, `listAllDeletedItems`) instead of N+1

**Usage pattern for apps:**
```typescript
// 1. Create IItemDecrypt from platform crypto
const itemDecrypt: IItemDecrypt = {
  decrypt: (encryptedData, vaultKey) => decrypt(encryptedData, vaultKey)
};

// 2. Wrap app with PlatformProvider
<PlatformProvider storage={storage} itemDecrypt={itemDecrypt} autolock={autolockService}>
  <App />
</PlatformProvider>

// 3. Use shared hooks in components
const { items, isLoading } = useDecryptedItems(vaultId);
```

### Phase 5: Autolock Service Interface ✅ COMPLETED

**Status**: COMPLETED

**Changes implemented:**

1. ✅ Created `packages/hooks/src/services/autolock-web.ts`:
   - Uses `setTimeout` for inactivity tracking
   - Uses Document Visibility API for tab switching detection
   - Tracks user activity via mousedown, mousemove, keydown, scroll, touchstart, click events
   - Calls lock callback and clears MUK when timeout expires

2. ✅ Created `packages/hooks/src/services/autolock-mobile.ts`:
   - Uses React Native AppState API for background/foreground detection
   - Uses background timestamp pattern for tracking time in background
   - Integrates with storage methods: `storeBackgroundTimestamp`, `shouldRequireAuthAfterBackground`
   - Dynamically imports react-native to avoid bundler issues

3. ✅ Created `packages/hooks/src/services/index.ts` - Service exports

4. ✅ Updated `packages/hooks/src/index.ts` - Added service exports

5. ✅ Updated `packages/hooks/package.json` - Added service export paths

**Interface (`types.ts`):**
```typescript
interface IAutolockService {
  initialize(): Promise<void>;
  recordActivity(): void;
  shouldLock(): Promise<boolean>;
  lock(): Promise<void>;
  onLock(callback: () => void): () => void;
  getTimeout(): Promise<number>;
  setTimeout(ms: number): Promise<void>;
  dispose(): void;
}
```

**Platform implementations:**
| Platform | Mechanism | Location |
|----------|-----------|----------|
| Web | setTimeout + visibility API | `packages/hooks/src/services/autolock-web.ts` ✅ |
| Extension | Uses web service | `packages/hooks/src/services/autolock-web.ts` |
| Desktop | Custom (Tauri-specific) | `apps/desktop/` (not using shared service) |
| Mobile | AppState + background timestamp | `packages/hooks/src/services/autolock-mobile.ts` ✅ |

### Phase 6: Migrate Apps to Shared Hooks ✅ COMPLETED

**Status**: COMPLETED

> **Note**: Step 1 (storage imports) was already complete from Phase 3.
> Each app already has storage adapter with injected CryptoProvider.

**Changes implemented:**

#### Web App Migration ✅ COMPLETED
1. ✅ Created `apps/web/src/providers/platform-provider.tsx` - WebPlatformProvider with WASM crypto
2. ✅ Added `@bittery/hooks` to `apps/web/package.json`
3. ✅ Updated `apps/web/src/router.tsx` - Wrapped app with WebPlatformProvider
4. ✅ Updated imports in routes to use `@bittery/hooks`:
   - `apps/web/src/routes/_app/security.tsx`
   - `apps/web/src/routes/_app/vaults/$vaultId/index.tsx`
5. ✅ Deleted old hooks:
   - `apps/web/src/hooks/use-decrypted-items.ts`
   - `apps/web/src/hooks/use-all-decrypted-items.ts`

#### Desktop App Migration ✅ COMPLETED
1. ✅ Created `apps/desktop/src/providers/platform-provider.tsx` - DesktopPlatformProvider with Tauri crypto
2. ✅ Added `@bittery/hooks` to `apps/desktop/package.json`
3. ✅ Updated `apps/desktop/src/main.tsx` - Wrapped app with DesktopPlatformProvider
4. ✅ Updated imports in 12+ route files to use `@bittery/hooks`
5. ✅ Deleted old hooks:
   - `apps/desktop/src/hooks/use-decrypted-items.ts`
   - `apps/desktop/src/hooks/use-all-decrypted-items.ts`
   - `apps/desktop/src/hooks/use-all-deleted-items.ts`
   - `apps/desktop/src/hooks/use-cross-vault-tags.ts`

#### Mobile App Migration ✅ COMPLETED
1. ✅ Created `apps/mobile/src/providers/platform-provider.tsx` - MobilePlatformProvider with native FFI crypto
2. ✅ Added `@bittery/hooks` to `apps/mobile/package.json`
3. ✅ Updated `apps/mobile/app/_layout.tsx` - Wrapped app with MobilePlatformProvider
4. ✅ Updated imports in 9+ route files to use `@bittery/hooks`
5. ✅ Updated hooks to expose `refetch` function for pull-to-refresh
6. ✅ Deleted old hooks:
   - `apps/mobile/src/hooks/use-decrypted-items.ts`
   - `apps/mobile/src/hooks/use-all-decrypted-items.ts`
   - `apps/mobile/src/hooks/use-all-deleted-items.ts`
   - `apps/mobile/src/hooks/use-cross-vault-tags.ts`

**Additional changes to shared hooks:**
- ✅ Added `refetch` to return values of `useDecryptedItems`, `useAllDecryptedItems`, `useAllDeletedItems`
- ✅ Updated mobile tags screen to derive tag counts from items locally

**Note:** Pre-existing type errors in desktop and mobile apps remain - these are related to storage adapter methods that exist on concrete implementations but not on the base `IStorageAdapter` interface. These are not related to the hooks migration.

## File Changes Summary

### Phase 1 Changes (COMPLETED)

**S3 moved to API package:**
- ✅ `packages/api/src/storage/s3.ts` - Created (S3 client, presigned URLs)
- ✅ `packages/api/src/routers/auth.ts` - Updated imports
- ✅ `packages/api/src/routers/vault.ts` - Updated imports
- ✅ `apps/server/src/index.ts` - Updated imports
- ✅ `packages/api/package.json` - Added S3 SDK dependencies
- ✅ `apps/server/package.json` - Removed @bittery/shared dependency

**Client storage package created:**
- ✅ `packages/storage/src/index.ts` - Main exports
- ✅ `packages/storage/src/types.ts` - VaultKeyData, AccountMetadata, StoredSession, etc.
- ✅ `packages/storage/src/adapter.ts` - IStorageAdapter interface
- ✅ `packages/storage/src/crypto-provider.ts` - CryptoProvider interface for DI
- ✅ `packages/storage/src/adapters/index.ts` - Adapter exports
- ✅ `packages/storage/src/adapters/web.ts` - Web adapter (takes CryptoProvider)
- ✅ `packages/storage/src/adapters/chrome.ts` - Chrome extension adapter (takes CryptoProvider)
- ✅ `packages/storage/src/adapters/tauri.ts` - Tauri desktop adapter (takes CryptoProvider)
- ✅ `packages/storage/src/adapters/react-native.ts` - React Native adapter (takes CryptoProvider)
- ✅ `packages/storage/package.json` - Updated dependencies

### Phase 2 Changes (COMPLETED)

**Desktop Keychain:**
- ✅ `apps/desktop/src-tauri/src/keychain.rs` - Created (keychain_set, keychain_get, keychain_delete commands)
- ✅ `apps/desktop/src-tauri/Cargo.toml` - Added `keyring = "3"` dependency
- ✅ `apps/desktop/src-tauri/src/lib.rs` - Registered keychain commands
- ✅ `packages/storage/src/adapters/tauri.ts` - Updated to use keychain for device key
- ✅ `packages/storage/package.json` - Added `@tauri-apps/api` as devDependency

### Phase 3 Changes (COMPLETED)

**Web app migration (COMPLETED):**
- ✅ `apps/web/src/lib/storage.ts` - Created (singleton WebStorageAdapter)
- ✅ `apps/web/package.json` - Added @bittery/storage dependency
- ✅ 21 files updated to use new storage adapter

**Storage adapter interface updates (COMPLETED):**
- ✅ `packages/storage/src/adapter.ts` - Added `getActiveAccountUserId()`, `getAutoLockTimeoutOrDefault()`, `decryptVaultKey()`
- ✅ `packages/storage/src/adapters/web.ts` - Implemented new methods
- ✅ `packages/storage/src/adapters/chrome.ts` - Implemented new methods
- ✅ `packages/storage/src/adapters/tauri.ts` - Implemented new methods
- ✅ `packages/storage/src/adapters/react-native.ts` - Implemented new methods

**All app migrations completed:**
- ✅ Extension app (~13 files)
- ✅ Desktop app (~24 files)
- ✅ Mobile app (~8 files)

### Additional Refactoring (COMPLETED - Outside Original Plan)

**Crypto package restructured to Rust-only:**
The `@bittery/crypto` package was refactored from TypeScript to a Rust workspace. Old TypeScript files (encryption.ts, key-derivation.ts, rsa.ts, srp-client.ts, etc.) were removed. The package now contains:
- `core/` - Rust crypto core library
- `wasm/` - WASM bindings for web/extension
- `napi/` - NAPI bindings for server (Bun/Node)
- `expo-module/` - Expo module for React Native (FFI)

**CryptoProvider dependency injection added:**
- ✅ `packages/storage/src/crypto-provider.ts` - Created `CryptoProvider` interface
- ✅ Storage adapters updated to receive `CryptoProvider` via constructor
- ✅ Apps create adapters by injecting platform-specific crypto:
  - Web: `createWebStorageAdapter({ encrypt, decrypt, rsaDecrypt })` from WASM
  - Extension: Same as web (WASM)
  - Desktop: Tauri crypto commands
  - Mobile: crypto-nitro Expo module

This pattern separates storage logic from crypto implementations, enabling proper platform-specific crypto usage.

### Phase 5-6 Changes (COMPLETED)

**New Package: `packages/hooks/` ✅ COMPLETED**
- ✅ `package.json`
- ✅ `tsconfig.json`
- ✅ `src/index.ts`
- ✅ `src/types.ts` - IItemDecrypt interface, IAutolockService interface
- ✅ `src/context/platform-context.tsx` - PlatformProvider (storage + itemDecrypt + autolock)
- ✅ `src/hooks/use-decrypted-items.ts`
- ✅ `src/hooks/use-all-decrypted-items.ts`
- ✅ `src/hooks/use-all-deleted-items.ts`
- ✅ `src/hooks/use-cross-vault-tags.ts`
- ✅ `src/services/autolock-web.ts`
- ✅ `src/services/autolock-mobile.ts`
- ✅ `src/services/index.ts`

**App Provider Setup ✅ COMPLETED**
- ✅ `apps/web/src/providers/platform-provider.tsx`
- ✅ `apps/desktop/src/providers/platform-provider.tsx`
- ✅ `apps/mobile/src/providers/platform-provider.tsx`

**Deleted from `packages/crypto/` ✅**
- ~~`packages/crypto/src/session-storage.ts`~~
- ~~`packages/crypto/src/storage-chrome.ts`~~
- ~~`packages/crypto/src/storage-tauri.ts`~~
- ~~`packages/crypto/src/storage-react-native.ts`~~

**Deleted duplicate hooks ✅ COMPLETED**
- ✅ ~~`apps/web/src/hooks/use-decrypted-items.ts`~~
- ✅ ~~`apps/web/src/hooks/use-all-decrypted-items.ts`~~
- ✅ ~~`apps/desktop/src/hooks/use-decrypted-items.ts`~~
- ✅ ~~`apps/desktop/src/hooks/use-all-decrypted-items.ts`~~
- ✅ ~~`apps/desktop/src/hooks/use-all-deleted-items.ts`~~
- ✅ ~~`apps/desktop/src/hooks/use-cross-vault-tags.ts`~~
- ✅ ~~`apps/mobile/src/hooks/use-decrypted-items.ts`~~
- ✅ ~~`apps/mobile/src/hooks/use-all-decrypted-items.ts`~~
- ✅ ~~`apps/mobile/src/hooks/use-all-deleted-items.ts`~~
- ✅ ~~`apps/mobile/src/hooks/use-cross-vault-tags.ts`~~

### Phase 7 Changes (COMPLETED)

**New shared hooks created:**
- [x] `packages/hooks/src/hooks/use-decrypted-item.ts` - Single item decryption
- [x] `packages/hooks/src/hooks/use-available-tags.ts` - Tag extraction & filtering utilities
- [x] `packages/hooks/src/hooks/use-vault-search.ts` - Cross-vault client-side search
- [x] `packages/hooks/src/hooks/use-password-security.ts` - Password security analysis

**Files deleted after migration:**
- [x] ~~`apps/desktop/src/hooks/use-decrypted-item.ts`~~
- [x] ~~`apps/desktop/src/hooks/use-available-tags.ts`~~
- [x] ~~`apps/desktop/src/hooks/use-vault-search.ts`~~
- [x] ~~`apps/web/src/hooks/use-vault-tags.ts`~~
- [x] ~~`apps/web/src/hooks/use-password-security.ts`~~

**App imports updated:**
- [x] Desktop: `item-detail-page.tsx`, `search-combobox.tsx`, 4 route files
- [x] Web: `security.tsx`, `item-list.tsx`, `vaults/$vaultId/index.tsx`

**Workspace Config**
- ✅ `pnpm-workspace.yaml` - Already includes `packages/*` glob, no changes needed

### Phase 7: Additional Shared Hooks

**Status**: COMPLETED

The following hooks were identified as candidates for extraction to the shared `@bittery/hooks` package:

#### 7a: `useDecryptedItem` (singular)
**Source**: `apps/desktop/src/hooks/use-decrypted-item.ts`

Hook to fetch and decrypt a single vault item by ID. Different from `useDecryptedItems` (plural) which fetches all items in a vault.

**Implementation:**
```typescript
// packages/hooks/src/hooks/use-decrypted-item.ts
export function useDecryptedItem(itemId: string) {
  // Uses trpc.vault.getItem to fetch single item
  // Decrypts using platform crypto via usePlatformItemDecrypt()
  // Caches decrypted result with staleTime
  // Returns { rawItem, decryptedData, isLoading, error }
}
```

**Files updated:**
- [x] Created `packages/hooks/src/hooks/use-decrypted-item.ts`
- [x] Exported from `packages/hooks/src/index.ts`
- [x] Updated `apps/desktop/` to import from `@bittery/hooks`
- [x] Deleted `apps/desktop/src/hooks/use-decrypted-item.ts`

#### 7b: `useAvailableTags` + `filterItemsByTags`
**Sources**:
- `apps/desktop/src/hooks/use-available-tags.ts`
- `apps/web/src/hooks/use-vault-tags.ts`

Utility hook and function for extracting unique tags from items and filtering items by tags.

**Implementation:**
```typescript
// packages/hooks/src/hooks/use-available-tags.ts
export function useAvailableTags(items: DecryptedItem[]): string[] {
  // Extracts unique tags from items array
  // Returns sorted array of tag strings
}

export function filterItemsByTags(
  items: DecryptedItem[],
  selectedTags: string[]
): DecryptedItem[] {
  // Filters items that have at least one of the selected tags
}
```

**Files updated:**
- [x] Created `packages/hooks/src/hooks/use-available-tags.ts`
- [x] Exported from `packages/hooks/src/index.ts`
- [x] Updated `apps/desktop/` to import from `@bittery/hooks`
- [x] Updated `apps/web/` to import from `@bittery/hooks`
- [x] Deleted `apps/desktop/src/hooks/use-available-tags.ts`
- [x] Deleted `apps/web/src/hooks/use-vault-tags.ts`

#### 7c: `useVaultSearch`
**Source**: `apps/desktop/src/hooks/use-vault-search.ts`

Client-side search across all vaults and items. Performs zero-knowledge search through decrypted item data.

**Implementation:**
```typescript
// packages/hooks/src/hooks/use-vault-search.ts
export function useVaultSearch(query: string): SearchResult {
  // Uses trpc.vault.list for vault search
  // Uses trpc.vault.listAllItems for items
  // Decrypts all items using platform crypto
  // Performs client-side search through title, url, username, notes, email
  // Returns { vaults: [], items: [] }
}

export function useSingleVaultSearch(vaultId: string, query: string) {
  // Simplified search within a single vault
  // Uses useDecryptedItems for that vault
  // Returns { items: [] }
}
```

**Files updated:**
- [x] Created `packages/hooks/src/hooks/use-vault-search.ts`
- [x] Exported from `packages/hooks/src/index.ts`
- [x] Updated `apps/desktop/` to import from `@bittery/hooks`
- [x] Deleted `apps/desktop/src/hooks/use-vault-search.ts`

#### 7d: `usePasswordSecurity` + `analyzePassword`
**Source**: `apps/web/src/hooks/use-password-security.ts`

Analyzes password security across all items - detects weak, reused, and old passwords. Uses zxcvbn for password strength analysis.

**Implementation:**
```typescript
// packages/hooks/src/hooks/use-password-security.ts
export function analyzePassword(password: string): PasswordAnalysis {
  // Uses zxcvbn to analyze password strength
  // Returns strength, score, crack time, feedback
}

export function usePasswordSecurity(items: DecryptedItem[]): SecurityReport {
  // Filters login items with passwords
  // Identifies weak passwords (score < threshold)
  // Identifies reused passwords (same password across items)
  // Identifies old passwords (not updated in >365 days)
  // Calculates security score (0-100)
  // Returns { totalPasswords, weakPasswords, reusedPasswords, oldPasswords, securityScore, recommendations }
}
```

**Files updated:**
- [x] Created `packages/hooks/src/hooks/use-password-security.ts`
- [x] Exported from `packages/hooks/src/index.ts`
- [x] Added `zxcvbn` and `@types/zxcvbn` as dependencies to `packages/hooks/package.json`
- [x] Updated `apps/web/` to import from `@bittery/hooks`
- [x] Deleted `apps/web/src/hooks/use-password-security.ts`

#### Summary of Phase 7 (COMPLETED)

| Hook | Desktop | Web | Mobile | Action |
|------|---------|-----|--------|--------|
| `useDecryptedItem` | ✅ migrated | - | - | Extracted to shared |
| `useAvailableTags` | ✅ migrated | ✅ migrated | - | Extracted to shared |
| `filterItemsByTags` | ✅ migrated | ✅ migrated | - | Extracted to shared |
| `useVaultSearch` | ✅ migrated | - | - | Extracted to shared |
| `useSingleVaultSearch` | ✅ migrated | - | - | Extracted to shared |
| `usePasswordSecurity` | - | ✅ migrated | - | Extracted to shared |
| `analyzePassword` | - | ✅ migrated | - | Extracted to shared |

**Completed scope:**
- 4 new files in `packages/hooks/`
- 5 files deleted after migration
- ~450 lines of duplicate code removed

## Verification Plan

1. **Unit tests**: Test each storage adapter implements interface correctly
2. **Integration tests**:
   - Login/logout flows work on all platforms
   - Vault items decrypt correctly
   - Multi-account switching (desktop/mobile)
   - Biometric unlock (desktop/mobile)
3. **Security verification**:
   - Desktop: Verify device key stored in OS keychain (not JSON file)
   - All platforms: MUK cleared from memory on lock
4. **Manual testing**:
   - Web: Full auth flow, vault operations
   - Extension: Background lock with Chrome Alarms
   - Desktop: Touch ID unlock, account switching
   - Mobile: Background lock, Face ID, 30-day password re-entry

## Estimated Scope

**Completed (All Phases 1-7):**
- 1 new package (`@bittery/hooks`)
- 1 repurposed package (`@bittery/storage` - S3 → client storage)
- ~22 new files total
- ~17 files deleted after migration (old storage adapters + duplicate hooks)
- Net reduction: ~850-950 lines of duplicate code

**Phase 7 Completed:**
- 4 new hook files in `packages/hooks/`
- 5 app-specific hook files deleted
- ~450 lines of duplicate code removed

**Phase 8 Planned:**
- 12 new files in `packages/hooks/` (3 vault hooks + 7 item hooks + 2 barrel exports + 1 utility)
- 2 app-specific files deleted
- Updates to types.ts, platform-context.tsx, and all 3 platform providers
- ~300 lines of code deduplicated
- Single-function hooks (more composable, better tree-shaking)
- No UI side effects in shared hooks (apps control toast/navigation)
- Simplified crypto integration (pass module directly, no wrapping)

### Phase 8: Extract Vault Operations Hooks (COMPLETED)

**Status**: COMPLETED

**Goal**: Extract `useVaultOperations` and `useVaultItemOperations` from desktop to the shared `@bittery/hooks` package. These hooks handle vault/item CRUD with encryption and query invalidation.

**Current state:**
- `apps/desktop/src/components/vault/use-vault-operations.ts` - Vault CRUD (create, update, delete)
- `apps/desktop/src/components/vault/use-vault-item-operations.ts` - Item CRUD with encryption

**Dependencies that need abstraction:**
1. **Query Invalidator** (`useQueryInvalidator()`) - comes from sync-provider, platform-specific
2. **Crypto operations** (`encrypt`, `generateEncryptionKey`) - same API across all platforms
3. **Storage** (`storage.getMasterUnlockKey()`, `storage.getDecryptedVaultKey()`) - already in PlatformProvider
4. **Vault utils** (`refreshVaultKeys`) - utility that needs storage

#### Phase 8a: Simplify Crypto Interface

All platform crypto modules (web WASM, desktop Tauri, mobile FFI) share **identical function signatures** since they're all wrappers around the same Rust core. Instead of creating separate interfaces, we can:

1. Replace `IItemDecrypt` with a broader `ICrypto` interface
2. Apps pass their crypto module directly (no manual wrapping needed)

**New interface (`packages/hooks/src/types.ts`):**
```typescript
import type { EncryptedData } from "@bittery/types";

/**
 * Crypto interface for platform-specific encryption operations.
 * All platforms (WASM, Tauri, FFI) already export these exact functions
 * with identical signatures - this interface just documents the contract.
 */
export interface ICrypto {
  /** Decrypt data using AES-256-GCM */
  decrypt(encryptedData: EncryptedData, key: Uint8Array): Promise<string>;

  /** Encrypt data using AES-256-GCM */
  encrypt(plaintext: string, key: Uint8Array): Promise<EncryptedData>;

  /** Generate a random 256-bit encryption key */
  generateEncryptionKey(): Promise<Uint8Array>;
}

// IItemDecrypt is now deprecated in favor of ICrypto
// Keep for backward compatibility, will be removed in future
/** @deprecated Use ICrypto instead */
export interface IItemDecrypt {
  decrypt(encryptedData: EncryptedData, vaultKey: Uint8Array): Promise<string>;
}
```

**Update PlatformContext (`packages/hooks/src/context/platform-context.tsx`):**
```typescript
export interface PlatformContextValue {
  storage: IStorageAdapter;

  /** Platform crypto module - all platforms have identical API */
  crypto: ICrypto;

  /** @deprecated Use crypto.decrypt instead */
  itemDecrypt?: IItemDecrypt;

  autolock?: IAutolockService;

  /** Sync context with query invalidator */
  sync?: ISyncContext;
}

// Convenience hooks
export function usePlatformCrypto(): ICrypto;
export function usePlatformSync(): ISyncContext | undefined;
export function useQueryInvalidator(): IQueryInvalidator;
```

**App usage becomes simpler:**
```typescript
// apps/desktop/src/providers/platform-provider.tsx
import * as crypto from "@/lib/tauri-crypto";
import { storage } from "@/lib/storage";

export function DesktopPlatformProvider({ children }) {
  return (
    <PlatformProvider
      storage={storage}
      crypto={crypto}  // Just pass the module - it satisfies ICrypto
    >
      {children}
    </PlatformProvider>
  );
}
```

#### Phase 8b: Add Sync/Invalidator to PlatformContext

Add the query invalidator from sync providers to the platform context.

**New interface (`packages/hooks/src/types.ts`):**
```typescript
/**
 * Query invalidator interface for cache invalidation after mutations.
 * Matches the return type of createQueryInvalidator() from @bittery/sync.
 */
export interface IQueryInvalidator {
  invalidateItem(itemId: string, vaultId: string): Promise<void>;
  invalidateVaultList(vaultId: string): Promise<void>;
  invalidateVaultKeys(): Promise<void>;
  invalidateDeletedItems(vaultId: string): Promise<void>;
  invalidateTeam(): Promise<void>;
  invalidateTeamInvitations(): Promise<void>;
  invalidateShare(itemId?: string): Promise<void>;
  invalidateVaultMembers(vaultId: string): Promise<void>;
}

/**
 * Sync context - subset of sync state needed by shared hooks.
 */
export interface ISyncContext {
  clientId: string;
  isConnected: boolean;
  isOnline: boolean;
  invalidator: IQueryInvalidator;
}
```

**App integration pattern:**
```typescript
// apps/desktop/src/providers/platform-provider.tsx
import * as crypto from "@/lib/tauri-crypto";
import { storage } from "@/lib/storage";
import { useSyncContext } from "@/providers/sync-provider";

export function DesktopPlatformProvider({ children }) {
  const syncContext = useSyncContext();

  const sync: ISyncContext = {
    clientId: syncContext.clientId,
    isConnected: syncContext.isConnected,
    isOnline: syncContext.isOnline,
    invalidator: syncContext.invalidator,
  };

  return (
    <PlatformProvider storage={storage} crypto={crypto} sync={sync}>
      {children}
    </PlatformProvider>
  );
}
```

**Note:** The `DesktopPlatformProvider` must be rendered inside `DesktopSyncProvider` so it can access sync context.

#### Phase 8c: Extract Single-Function Vault Hooks

Instead of one large `useVaultOperations` hook, create individual hooks for each operation. This is more composable, follows React Query patterns, and allows better tree-shaking.

**Design principles:**
1. **Single responsibility** - One hook per operation
2. **No UI side effects** - No `toast()` or `navigate()` calls in shared hooks
3. **Return mutation objects** - Apps handle success/error UI themselves
4. **Invalidation is automatic** - Hooks handle cache invalidation internally

**New files in `packages/hooks/src/hooks/vault/`:**

**`use-create-vault.ts`:**
```typescript
import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import { usePlatform, useQueryInvalidator } from "../../context/platform-context";
import { refreshVaultKeys } from "../../utils/vault-utils";

export interface CreateVaultInput {
  name: string;
  type: "personal" | "team";
  icon: string;
  imageKey?: string;
}

export function useCreateVault() {
  const trpcClient = useTRPCClient();
  const { storage, crypto } = usePlatform();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (input: CreateVaultInput) => {
      if (!input.name.trim()) {
        throw new Error("Vault name is required");
      }

      const vaultKey = await crypto.generateEncryptionKey();
      const masterUnlockKey = await storage.getMasterUnlockKey();

      if (!masterUnlockKey) {
        throw new Error("Master Unlock Key not found");
      }

      const encryptedVaultKeyData = await crypto.encrypt(
        btoa(String.fromCharCode(...vaultKey)),
        masterUnlockKey,
      );

      return trpcClient.vault.create.mutate({
        name: input.name.trim(),
        type: input.type,
        encryptedVaultKey: JSON.stringify(encryptedVaultKeyData),
        icon: input.icon,
        ...(input.imageKey && { imageKey: input.imageKey }),
      });
    },
    onSuccess: async () => {
      await refreshVaultKeys(trpcClient, storage);
      await invalidator.invalidateVaultKeys();
    },
  });
}
```

**`use-update-vault.ts`:**
```typescript
export interface UpdateVaultInput {
  vaultId: string;
  name: string;
}

export function useUpdateVault() {
  const trpcClient = useTRPCClient();
  const { storage } = usePlatform();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (input: UpdateVaultInput) => {
      if (!input.name.trim() || input.name.trim().length < 2) {
        throw new Error("Vault name must be at least 2 characters");
      }
      return trpcClient.vault.update.mutate({
        vaultId: input.vaultId,
        name: input.name.trim(),
      });
    },
    onSuccess: async () => {
      await refreshVaultKeys(trpcClient, storage);
      await invalidator.invalidateVaultKeys();
    },
  });
}
```

**`use-delete-vault.ts`:**
```typescript
export function useDeleteVault() {
  const trpcClient = useTRPCClient();
  const { storage } = usePlatform();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (vaultId: string) => {
      return trpcClient.vault.delete.mutate({ vaultId });
    },
    onSuccess: async () => {
      await refreshVaultKeys(trpcClient, storage);
      await invalidator.invalidateVaultKeys();
    },
  });
}
```

**App usage (desktop example):**
```typescript
// In a component
import { useCreateVault } from "@bittery/hooks";
import { toast } from "@bittery/ui";
import { useNavigate } from "@tanstack/react-router";

function CreateVaultDialog() {
  const navigate = useNavigate();
  const createVault = useCreateVault();

  const handleSubmit = async (data: VaultFormData) => {
    try {
      const result = await createVault.mutateAsync(data);
      toast.success("Vault created successfully");
      navigate({ to: "/vault/$id", params: { id: result.vaultId } });
    } catch (error) {
      toast.error(`Failed to create vault: ${error.message}`);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* ... */}
      <Button disabled={createVault.isPending}>
        {createVault.isPending ? "Creating..." : "Create Vault"}
      </Button>
    </form>
  );
}
```

**Files to create:**
- [ ] `packages/hooks/src/hooks/vault/use-create-vault.ts`
- [ ] `packages/hooks/src/hooks/vault/use-update-vault.ts`
- [ ] `packages/hooks/src/hooks/vault/use-delete-vault.ts`
- [ ] `packages/hooks/src/hooks/vault/index.ts` (barrel export)

#### Phase 8d: Extract Single-Function Item Hooks

Same pattern for item operations - individual hooks with no UI side effects.

**New files in `packages/hooks/src/hooks/items/`:**

**`use-create-item.ts`:**
```typescript
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";

export interface CreateItemInput {
  vaultId: string;
  category: ItemCategory;
  data: DecryptedItemData;
}

export function useCreateItem() {
  const trpcClient = useTRPCClient();
  const { storage, crypto } = usePlatform();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (input: CreateItemInput) => {
      const vaultKey = await storage.getDecryptedVaultKey(input.vaultId);
      if (!vaultKey) throw new Error("No vault key found");

      const encryptedData = await crypto.encrypt(
        JSON.stringify(input.data),
        vaultKey,
      );

      return trpcClient.vault.createItem.mutate({
        vaultId: input.vaultId,
        category: input.category,
        encryptedData: encryptedData.ciphertext,
        encryptionIv: encryptedData.iv,
        encryptionAlgorithm: encryptedData.algorithm,
      });
    },
    onSuccess: async (_data, variables) => {
      await invalidator.invalidateVaultList(variables.vaultId);
    },
  });
}
```

**`use-update-item.ts`:**
```typescript
export interface UpdateItemInput {
  itemId: string;
  vaultId: string;
  data: DecryptedItemData;
}

export function useUpdateItem() {
  const trpcClient = useTRPCClient();
  const { storage, crypto } = usePlatform();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (input: UpdateItemInput) => {
      const vaultKey = await storage.getDecryptedVaultKey(input.vaultId);
      if (!vaultKey) throw new Error("No vault key found");

      const encryptedData = await crypto.encrypt(
        JSON.stringify(input.data),
        vaultKey,
      );

      return trpcClient.vault.updateItem.mutate({
        itemId: input.itemId,
        encryptedData: encryptedData.ciphertext,
        encryptionIv: encryptedData.iv,
      });
    },
    onSuccess: async (_data, variables) => {
      await invalidator.invalidateItem(variables.itemId, variables.vaultId);
    },
  });
}
```

**`use-delete-item.ts`:**
```typescript
export interface DeleteItemInput {
  itemId: string;
  vaultId: string;
}

export function useDeleteItem() {
  const trpcClient = useTRPCClient();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (input: DeleteItemInput) => {
      return trpcClient.vault.deleteItem.mutate({ itemId: input.itemId });
    },
    onSuccess: async (_data, variables) => {
      await invalidator.invalidateVaultList(variables.vaultId);
      await invalidator.invalidateDeletedItems(variables.vaultId);
    },
  });
}
```

**`use-toggle-favorite.ts`:**
```typescript
export interface ToggleFavoriteInput {
  itemId: string;
  vaultId: string;
  favorite: boolean;
}

export function useToggleFavorite() {
  const trpcClient = useTRPCClient();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (input: ToggleFavoriteInput) => {
      return trpcClient.vault.toggleFavorite.mutate({
        itemId: input.itemId,
        favorite: input.favorite,
      });
    },
    onSuccess: async (_data, variables) => {
      await invalidator.invalidateItem(variables.itemId, variables.vaultId);
    },
  });
}
```

**`use-move-item.ts`:**
```typescript
export interface MoveItemInput {
  itemId: string;
  sourceVaultId: string;
  targetVaultId: string;
  decryptedData: DecryptedItemData;
}

export function useMoveItem() {
  const trpcClient = useTRPCClient();
  const { storage, crypto } = usePlatform();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (input: MoveItemInput) => {
      const targetVaultKey = await storage.getDecryptedVaultKey(input.targetVaultId);
      if (!targetVaultKey) {
        throw new Error("Cannot access target vault key");
      }

      const encryptedData = await crypto.encrypt(
        JSON.stringify(input.decryptedData),
        targetVaultKey,
      );

      return trpcClient.vault.moveItem.mutate({
        itemId: input.itemId,
        sourceVaultId: input.sourceVaultId,
        targetVaultId: input.targetVaultId,
        encryptedData: encryptedData.ciphertext,
        encryptionIv: encryptedData.iv,
      });
    },
    onSuccess: async (_data, variables) => {
      await invalidator.invalidateItem(variables.itemId, variables.targetVaultId);
      await invalidator.invalidateVaultList(variables.sourceVaultId);
    },
  });
}
```

**`use-restore-item.ts`:**
```typescript
export interface RestoreItemInput {
  itemId: string;
  vaultId: string;
}

export function useRestoreItem() {
  const trpcClient = useTRPCClient();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (input: RestoreItemInput) => {
      return trpcClient.vault.restoreItem.mutate({ itemId: input.itemId });
    },
    onSuccess: async (_data, variables) => {
      await invalidator.invalidateVaultList(variables.vaultId);
      await invalidator.invalidateDeletedItems(variables.vaultId);
    },
  });
}
```

**`use-permanent-delete-item.ts`:**
```typescript
export function usePermanentDeleteItem() {
  const trpcClient = useTRPCClient();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (input: { itemId: string; vaultId: string }) => {
      return trpcClient.vault.permanentDeleteItem.mutate({ itemId: input.itemId });
    },
    onSuccess: async (_data, variables) => {
      await invalidator.invalidateDeletedItems(variables.vaultId);
    },
  });
}
```

**Files to create:**
- [ ] `packages/hooks/src/hooks/items/use-create-item.ts`
- [ ] `packages/hooks/src/hooks/items/use-update-item.ts`
- [ ] `packages/hooks/src/hooks/items/use-delete-item.ts`
- [ ] `packages/hooks/src/hooks/items/use-toggle-favorite.ts`
- [ ] `packages/hooks/src/hooks/items/use-move-item.ts`
- [ ] `packages/hooks/src/hooks/items/use-restore-item.ts`
- [ ] `packages/hooks/src/hooks/items/use-permanent-delete-item.ts`
- [ ] `packages/hooks/src/hooks/items/index.ts` (barrel export)

**Files to delete after migration:**
- [ ] `apps/desktop/src/components/vault/use-vault-operations.ts`
- [ ] `apps/desktop/src/components/vault/use-vault-item-operations.ts`

#### Phase 8e: Update Platform Providers

Update each app's platform provider to supply crypto module and sync context.

**`apps/desktop/src/providers/platform-provider.tsx`:**
```typescript
import * as crypto from "@/lib/tauri-crypto";
import { storage } from "@/lib/storage";
import { PlatformProvider, type ISyncContext } from "@bittery/hooks";
import { useSyncContext } from "@/providers/sync-provider";

export function DesktopPlatformProvider({ children }: Props) {
  const syncContext = useSyncContext();

  // Sync context adapter - maps sync provider to ISyncContext
  const sync: ISyncContext = useMemo(() => ({
    clientId: syncContext.clientId,
    isConnected: syncContext.isConnected,
    isOnline: syncContext.isOnline,
    invalidator: syncContext.invalidator,
  }), [syncContext]);

  return (
    <PlatformProvider storage={storage} crypto={crypto} sync={sync}>
      {children}
    </PlatformProvider>
  );
}
```

**`apps/web/src/providers/platform-provider.tsx`:**
```typescript
import * as crypto from "@/lib/wasm-crypto";
import { storage } from "@/lib/storage";
import { PlatformProvider, type ISyncContext } from "@bittery/hooks";
import { useSyncContext } from "@/providers/sync-provider";

export function WebPlatformProvider({ children }: Props) {
  const syncContext = useSyncContext();

  const sync: ISyncContext = useMemo(() => ({
    clientId: syncContext.clientId,
    isConnected: syncContext.isConnected,
    isOnline: syncContext.isOnline,
    invalidator: syncContext.invalidator,
  }), [syncContext]);

  return (
    <PlatformProvider storage={storage} crypto={crypto} sync={sync}>
      {children}
    </PlatformProvider>
  );
}
```

**`apps/mobile/src/providers/platform-provider.tsx`:**
```typescript
import * as crypto from "@/lib/crypto";
import { storage } from "@/services/storage";
import { PlatformProvider, type ISyncContext, type IQueryInvalidator } from "@bittery/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";

// Mobile creates a simple invalidator using queryClient directly
// (doesn't have real-time sync yet)
function useSimpleInvalidator(): IQueryInvalidator {
  const queryClient = useQueryClient();

  return useMemo(() => ({
    invalidateItem: async (itemId, vaultId) => {
      await queryClient.invalidateQueries({ queryKey: trpc.vault.getItem.queryKey({ itemId }) });
      await queryClient.invalidateQueries({ queryKey: trpc.vault.listItems.queryKey({ vaultId }) });
    },
    invalidateVaultList: async (vaultId) => {
      await queryClient.invalidateQueries({ queryKey: trpc.vault.listItems.queryKey({ vaultId }) });
    },
    invalidateVaultKeys: async () => {
      await queryClient.invalidateQueries({ queryKey: ["vault-keys"] });
    },
    // ... other methods
  }), [queryClient]);
}

export function MobilePlatformProvider({ children }: Props) {
  const invalidator = useSimpleInvalidator();

  const sync: ISyncContext = {
    clientId: "mobile",  // Or generate a device ID
    isConnected: true,   // Mobile doesn't track real-time connection
    isOnline: true,      // Could use NetInfo here
    invalidator,
  };

  return (
    <PlatformProvider storage={storage} crypto={crypto} sync={sync}>
      {children}
    </PlatformProvider>
  );
}
```

#### Phase 8f: Extract refreshVaultKeys Utility

The `refreshVaultKeys` function is used by vault operations to sync vault keys after changes.

**New file:** `packages/hooks/src/utils/vault-utils.ts`

```typescript
import type { IStorageAdapter } from "@bittery/storage/adapter";

/**
 * Refresh vault keys from server and store in local storage.
 * Called after vault operations to ensure key cache is up to date.
 */
export async function refreshVaultKeys(
  trpcClient: { vault: { list: { query: () => Promise<VaultListResult[]> } } },
  storage: IStorageAdapter,
): Promise<void> {
  const vaults = await trpcClient.vault.list.query();

  await storage.storeVaultKeys(
    vaults.map((v) => ({
      vaultId: v.id,
      encryptedKey: v.encryptedKey,
      role: v.role,
    })),
  );
}
```

**Files updated:**
- [ ] Create `packages/hooks/src/utils/vault-utils.ts`
- [ ] Export from `packages/hooks/src/index.ts`
- [ ] Update imports in vault operations hooks

#### Summary of Phase 8 Changes

**Key design decisions:**
1. **Unified `ICrypto` interface** - Replaces `IItemDecrypt`. All platforms (WASM, Tauri, FFI) already export identical function signatures, so apps just pass their crypto module directly with no wrapping needed.
2. **Single-function hooks** - Instead of `useVaultOperations` returning multiple functions, create individual hooks (`useCreateVault`, `useDeleteItem`, `useToggleFavorite`, etc.). More composable, better tree-shaking.
3. **No UI side effects** - Shared hooks don't call `toast()` or `navigate()`. They return React Query mutation objects; apps handle success/error UI themselves.
4. **Automatic cache invalidation** - Hooks handle `invalidator.invalidate*()` calls in `onSuccess`, so apps don't need to worry about cache consistency.
5. **`ISyncContext` for invalidation** - Wraps each platform's sync provider to provide query invalidation to shared hooks.
6. **Provider nesting** - `PlatformProvider` must be inside `SyncProvider` to access sync context.

**New file structure:**
```
packages/hooks/src/hooks/
  vault/
    use-create-vault.ts
    use-update-vault.ts
    use-delete-vault.ts
    index.ts
  items/
    use-create-item.ts
    use-update-item.ts
    use-delete-item.ts
    use-toggle-favorite.ts
    use-move-item.ts
    use-restore-item.ts
    use-permanent-delete-item.ts
    index.ts
```

**Updated files:**
- `packages/hooks/src/types.ts` - Add `ICrypto`, `IQueryInvalidator`, `ISyncContext`; deprecate `IItemDecrypt`
- `packages/hooks/src/context/platform-context.tsx` - Replace `itemDecrypt` with `crypto`, add `sync`
- `packages/hooks/src/index.ts` - Export new hooks, types, and utilities
- `apps/desktop/src/providers/platform-provider.tsx` - Pass crypto module and sync context
- `apps/web/src/providers/platform-provider.tsx` - Pass crypto module and sync context
- `apps/mobile/src/providers/platform-provider.tsx` - Pass crypto module and create simple invalidator

**Deleted files:**
- `apps/desktop/src/components/vault/use-vault-operations.ts`
- `apps/desktop/src/components/vault/use-vault-item-operations.ts`

**Migration pattern:**
```typescript
// Before (app-specific hook with UI side effects)
const { createItem } = useVaultItemOperations();
await createItem.mutateAsync(input); // toast shown automatically

// After (shared hook, app handles UI)
const createItem = useCreateItem();
try {
  await createItem.mutateAsync(input);
  toast.success("Item created");
  navigate({ to: "/vault/$id", params: { id: vaultId } });
} catch (error) {
  toast.error(error.message);
}
```

**Provider migration:**
```typescript
// Before (Phase 6)
<PlatformProvider storage={storage} itemDecrypt={itemDecrypt}>

// After (Phase 8)
<PlatformProvider storage={storage} crypto={crypto} sync={sync}>
```

Hooks using `usePlatformItemDecrypt()` should migrate to `usePlatformCrypto().decrypt()`.

**Actual implementation:**

Files created:
- `packages/hooks/src/types.ts` - Added `ICrypto`, `IQueryInvalidator`, `ISyncContext` interfaces; deprecated `IItemDecrypt`
- `packages/hooks/src/context/platform-context.tsx` - Added `crypto` and `sync` props, `usePlatformCrypto()`, `usePlatformSync()`, `useQueryInvalidator()` hooks
- `packages/hooks/src/utils/vault-utils.ts` - `refreshVaultKeys()` function
- `packages/hooks/src/utils/index.ts` - Utils barrel export
- `packages/hooks/src/hooks/vault/use-create-vault.ts`
- `packages/hooks/src/hooks/vault/use-update-vault.ts`
- `packages/hooks/src/hooks/vault/use-delete-vault.ts`
- `packages/hooks/src/hooks/vault/index.ts`
- `packages/hooks/src/hooks/items/use-create-item.ts`
- `packages/hooks/src/hooks/items/use-update-item.ts`
- `packages/hooks/src/hooks/items/use-delete-item.ts`
- `packages/hooks/src/hooks/items/use-toggle-favorite.ts`
- `packages/hooks/src/hooks/items/use-move-item.ts`
- `packages/hooks/src/hooks/items/use-restore-item.ts`
- `packages/hooks/src/hooks/items/use-permanent-delete-item.ts`
- `packages/hooks/src/hooks/items/index.ts`

Files updated:
- `packages/hooks/src/index.ts` - Export new hooks, types, and utilities
- `packages/hooks/package.json` - Added export paths for hooks/vault, hooks/items, utils
- `apps/desktop/src/providers/platform-provider.tsx` - Pass crypto module and sync context
- `apps/desktop/src/main.tsx` - Swapped provider nesting order (SyncProvider now wraps PlatformProvider)
- `apps/web/src/providers/platform-provider.tsx` - Pass crypto module and sync context
- `apps/web/src/router.tsx` - Swapped provider nesting order (SyncProvider now wraps PlatformProvider)
- `apps/mobile/src/providers/platform-provider.tsx` - Pass crypto module and create simple invalidator

**Note:** The original desktop files `use-vault-operations.ts` and `use-vault-item-operations.ts` were NOT deleted as they are still used by components until those components are migrated to use the new shared hooks. Apps can gradually migrate to the new hooks.

**Impact:**
- 16 new files in packages/hooks/
- Single-function hooks are more composable and tree-shakeable
- Apps retain full control over UI (toasts, navigation) while hooks handle crypto, API calls, and cache invalidation
- Platform providers now pass crypto module directly (no manual wrapping)
- Backward compatibility maintained with deprecated `itemDecrypt` prop
