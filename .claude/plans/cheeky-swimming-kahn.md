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
│                   @bittery/crypto (unchanged)               │
│  - ICryptoOperations interface                              │
│  - TypeScript types for crypto                              │
│  - SRP client helpers                                       │
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

### Phase 4: Create Shared Hooks Package (NOT STARTED)

**Create `packages/hooks/`:**
```
packages/hooks/
  package.json
  src/
    index.ts
    context/
      platform-context.tsx     # PlatformProvider + ICryptoOperations
    hooks/
      use-decrypted-items.ts
      use-all-decrypted-items.ts
      use-all-deleted-items.ts
      use-cross-vault-tags.ts
    services/
      autolock-service.ts      # IAutolockService interface
```

**PlatformProvider pattern:**
```typescript
interface ICryptoOperations {
  decrypt(data: EncryptedData, key: Uint8Array): Promise<string>;
  encrypt(plaintext: string, key: Uint8Array): Promise<EncryptedData>;
  deriveKeys(password: string, secretKey: string, email: string): Promise<DerivedKeys>;
  // ... SRP operations
}

// Each app wraps with platform-specific implementations
<PlatformProvider
  storage={webStorageAdapter}
  crypto={wasmCrypto}
  autolock={webAutolockService}
>
  <App />
</PlatformProvider>

// Hooks access via context
function useDecryptedItems(vaultId: string) {
  const { storage, crypto } = usePlatform();
  // ... platform-agnostic logic
}
```

### Phase 5: Autolock Service Interface (NOT STARTED)

**Interface (`autolock-service.ts`):**
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
| Web | setTimeout + visibility API | `packages/hooks/src/services/autolock-web.ts` |
| Extension | setTimeout + Chrome Alarms | `apps/extension/src/services/autolock.ts` |
| Desktop | Tauri + activity detection | `apps/desktop/src/services/autolock.ts` |
| Mobile | AppState + background timestamp | `packages/hooks/src/services/autolock-mobile.ts` |

### Phase 6: Migrate Apps (NOT STARTED)

For each app (web → extension → desktop → mobile):
1. Update imports from `@bittery/crypto/session-storage` to `@bittery/storage`
2. Create `providers/platform-provider.tsx` with platform implementations
3. Wrap app root with `PlatformProvider`
4. Replace local hooks with `@bittery/hooks` imports
5. Test all auth flows and vault operations
6. Remove old duplicate hook files

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
- ✅ `packages/storage/src/adapters/index.ts` - Adapter exports
- ✅ `packages/storage/src/adapters/web.ts` - Web adapter
- ✅ `packages/storage/src/adapters/chrome.ts` - Chrome extension adapter
- ✅ `packages/storage/src/adapters/tauri.ts` - Tauri desktop adapter
- ✅ `packages/storage/src/adapters/react-native.ts` - React Native adapter
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

### Remaining Changes (NOT STARTED)

**New Package: `packages/hooks/`**
- `package.json`
- `tsconfig.json`
- `src/index.ts`
- `src/context/platform-context.tsx`
- `src/hooks/use-decrypted-items.ts`
- `src/hooks/use-all-decrypted-items.ts`
- `src/hooks/use-all-deleted-items.ts`
- `src/hooks/use-cross-vault-tags.ts`
- `src/services/autolock-service.ts`
- `src/services/autolock-web.ts`
- `src/services/autolock-mobile.ts`

**App Provider Setup**
- `apps/web/src/providers/platform-provider.tsx` (new)
- `apps/desktop/src/providers/platform-provider.tsx` (new)
- `apps/mobile/src/providers/platform-provider.tsx` (new)
- `apps/extension/src/providers/platform-provider.tsx` (new)

**Deleted from `packages/crypto/` ✅**
- ~~`packages/crypto/src/session-storage.ts`~~
- ~~`packages/crypto/src/storage-chrome.ts`~~
- ~~`packages/crypto/src/storage-tauri.ts`~~
- ~~`packages/crypto/src/storage-react-native.ts`~~

**Delete duplicate hooks (after migration)**
- `apps/web/src/hooks/use-decrypted-items.ts`
- `apps/web/src/hooks/use-all-decrypted-items.ts`
- `apps/desktop/src/hooks/use-decrypted-items.ts`
- `apps/desktop/src/hooks/use-all-decrypted-items.ts`
- `apps/desktop/src/hooks/use-all-deleted-items.ts`
- `apps/mobile/src/hooks/use-decrypted-items.ts`
- `apps/mobile/src/hooks/use-all-decrypted-items.ts`
- `apps/mobile/src/hooks/use-all-deleted-items.ts`

**Workspace Config**
- `pnpm-workspace.yaml` - Add `packages/hooks` (storage already exists)

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

- 1 new package (`@bittery/hooks`)
- 1 repurposed package (`@bittery/storage` - S3 → client storage)
- ~18 new files
- ~12 files deleted after migration (old storage adapters + duplicate hooks)
- Net reduction: ~400-500 lines of duplicate code
