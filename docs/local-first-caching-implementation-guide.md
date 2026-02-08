# Local-First Item Caching: Implementation Guide

This document describes the local-first item caching system implemented for the **Tauri desktop** platform. Use it as a reference when implementing the same feature for **mobile (React Native)**, **web**, or **browser extension**.

---

## Overview

**Problem:** Every SSE sync event invalidates React Query, triggering full server refetches (`listAllItems`, `listItems`, `getItem`) even when only one item changed.

**Solution:** Store encrypted items and vault metadata locally. SSE events trigger delta fetches (only the changed entity), update local storage, then invalidate React Query. Data hooks read from local storage instead of the server.

```
OLD: SSE event → invalidate queries → React Query refetches ALL from server → slow
NEW: SSE event → delta fetch 1 entity → update local cache → invalidate queries → reads from cache → fast
```

**Security:** Cached items are stored in their encrypted form (AES-256-GCM ciphertext). They are safe at rest - decrypting them requires the vault key, which requires the Master Unlock Key, which is only in memory when the user is authenticated.

---

## Architecture

There are 4 layers that were modified:

1. **Shared types** (`packages/types`) — Cache data structures
2. **Storage adapter interface + implementation** (`packages/storage`) — Where cached data lives
3. **Sync package** (`packages/sync`) — Delta sync on SSE events + catch-up on reconnect
4. **Data hooks** (`packages/hooks`) — Cache-first reads + mutation cache updates

The shared types and sync package are **platform-agnostic** — they work for all platforms. To add caching to a new platform, you only need to:
1. Implement the cache methods in your storage adapter
2. Pass your storage adapter as `itemCacheAdapter` to `useSync`

---

## Layer 1: Shared Types (already done, shared by all platforms)

**File:** `packages/types/src/index.ts`

Three types were added:

```typescript
// The encrypted item as stored in cache (mirrors server schema)
export interface CachedEncryptedItem {
  id: string;
  vaultId: string;
  category: string;
  favorite: boolean;
  encryptedData: string;     // AES-256-GCM ciphertext
  encryptionIv: string;      // Random IV
  encryptionAlgorithm: string;
  version: number;
  lastModifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;  // Non-null = soft-deleted (in trash)
}

// Vault metadata (name, icon etc. - not sensitive)
export interface CachedVaultMetadata {
  id: string;
  name: string;
  type: string;
  icon: string | null;
  imageUrl: string | null;
}

// Tracks when cache was last fully synced
export interface ItemCacheMetadata {
  lastFullSyncAt: number;
  itemCount: number;
  cacheVersion: number;
}
```

---

## Layer 2: Storage Adapter

### Interface (already done, in `packages/storage/src/adapter.ts`)

The `IStorageAdapter` interface has a new **optional** section (same pattern as biometric methods):

```typescript
// ============================================================================
// Item Cache (optional, check supportsItemCache first)
// ============================================================================

/** Whether this adapter supports local item caching */
readonly supportsItemCache?: boolean;

/** Store all cached items (bulk, for initial sync) */
setCachedItems?(items: CachedEncryptedItem[], email?: string): Promise<void>;

/** Get all cached items */
getCachedItems?(email?: string): Promise<CachedEncryptedItem[] | null>;

/** Insert or update a single cached item */
upsertCachedItem?(item: CachedEncryptedItem, email?: string): Promise<void>;

/** Remove a single cached item */
removeCachedItem?(itemId: string, email?: string): Promise<void>;

/** Store all cached vault metadata (bulk) */
setCachedVaults?(vaults: CachedVaultMetadata[], email?: string): Promise<void>;

/** Get all cached vault metadata */
getCachedVaults?(email?: string): Promise<CachedVaultMetadata[] | null>;

/** Insert or update a single cached vault */
upsertCachedVault?(vault: CachedVaultMetadata, email?: string): Promise<void>;

/** Remove a cached vault and its items */
removeCachedVault?(vaultId: string, email?: string): Promise<void>;

/** Get item cache metadata */
getItemCacheMetadata?(email?: string): Promise<ItemCacheMetadata | null>;

/** Set item cache metadata */
setItemCacheMetadata?(metadata: ItemCacheMetadata, email?: string): Promise<void>;

/** Clear all item cache data */
clearItemCache?(email?: string): Promise<void>;
```

All methods are optional (`?`) so platforms without caching don't need changes. The `email?` parameter supports multi-account (desktop/mobile).

### Tauri Implementation (reference for other platforms)

**File:** `packages/storage/src/adapters/tauri.ts`

The Tauri adapter uses a **dual-layer cache**: in-memory Map + Tauri Store (JSON file on disk).

#### Key decisions in the Tauri implementation:

**1. In-memory cache structure:**
```typescript
interface AccountCache {
  authToken: string | null;
  vaultKeys: VaultKeyData[] | null;
  masterUnlockKey: Uint8Array | null;
  cachedItems: CachedEncryptedItem[] | null;   // ← NEW
  cachedVaults: CachedVaultMetadata[] | null;   // ← NEW
}
```

**2. Storage keys (per-account namespaced):**
```
bittery_account_{sanitized_email}_cached_items
bittery_account_{sanitized_email}_cached_vaults
bittery_account_{sanitized_email}_item_cache_meta
```

**3. Read pattern (memory → disk → null):**
```typescript
async getCachedItems(email?: string): Promise<CachedEncryptedItem[] | null> {
  const resolvedEmail = await this.resolveEmail(email);
  if (!resolvedEmail) return null;

  const cache = this.getAccountCache(resolvedEmail);
  if (cache.cachedItems) {
    return cache.cachedItems;  // Memory hit
  }

  const store = await this.getStore();
  const key = getAccountKey(resolvedEmail, "cached_items");
  const stored = await store.get<string>(key);
  if (stored) {
    try {
      cache.cachedItems = JSON.parse(stored);  // Disk hit → populate memory
    } catch {
      return null;
    }
  }
  return cache.cachedItems;
}
```

**4. Write pattern (memory + disk):**
```typescript
async setCachedItems(items: CachedEncryptedItem[], email?: string): Promise<void> {
  const resolvedEmail = await this.resolveEmail(email);
  if (!resolvedEmail) return;

  const cache = this.getAccountCache(resolvedEmail);
  cache.cachedItems = items;  // Update memory

  const store = await this.getStore();
  const key = getAccountKey(resolvedEmail, "cached_items");
  await store.set(key, JSON.stringify(items));  // Persist to disk
  await store.save();
}
```

**5. Upsert pattern (find-and-replace or append):**
```typescript
async upsertCachedItem(item: CachedEncryptedItem, email?: string): Promise<void> {
  let items = await this.getCachedItems(resolvedEmail);
  if (!items) items = [];

  const index = items.findIndex((i) => i.id === item.id);
  if (index >= 0) {
    items[index] = item;  // Replace existing
  } else {
    items.push(item);     // Append new
  }

  await this.setCachedItems(items, resolvedEmail);
}
```

**6. Remove vault also removes its items:**
```typescript
async removeCachedVault(vaultId: string, email?: string): Promise<void> {
  // Remove the vault metadata
  const vaults = await this.getCachedVaults(resolvedEmail);
  if (vaults) {
    await this.setCachedVaults(vaults.filter((v) => v.id !== vaultId), resolvedEmail);
  }
  // Also remove all items belonging to this vault
  const items = await this.getCachedItems(resolvedEmail);
  if (items) {
    await this.setCachedItems(items.filter((i) => i.vaultId !== vaultId), resolvedEmail);
  }
}
```

**7. Cleanup integration:**

- `removeAccount(email)` — deletes `cached_items`, `cached_vaults`, `item_cache_meta` storage keys
- `clearSession(email)` — calls `clearItemCache()` (items need MUK → vault key for decryption, so clear cache on session clear)
- `clearItemCache(email)` — nullifies in-memory arrays + deletes all 3 storage keys
- `lockAllAccounts()` — clears the entire in-memory `accountCaches` Map (but does NOT clear disk cache — encrypted items are safe at rest)

### What to implement for React Native

For `packages/storage/src/adapters/react-native.ts`:

- Set `readonly supportsItemCache = true`
- Storage backend options:
  - **SQLite** (recommended for large item counts) — use `expo-sqlite` or similar
  - **MMKV** — fast key-value store, good for moderate item counts
  - **AsyncStorage** — simplest but slowest for large datasets
- Follow the same dual-layer pattern: in-memory cache for hot reads, persistent store for cold starts
- Same per-account namespacing pattern with email parameter
- Same cleanup in `removeAccount()`, `clearSession()`, etc.
- `removeCachedVault` must also remove items with matching `vaultId`

### What to implement for Web / Extension

For web and extension, caching is **optional**. The hooks already handle `supportsItemCache` being falsy — they fall back to server fetches. If you want to add it:

- Web: Use `IndexedDB` (via idb library) or `localStorage` (small datasets)
- Extension: Use `chrome.storage.local`
- Set `readonly supportsItemCache = true` and implement the methods

---

## Layer 3: Sync Package (already done, shared by all platforms)

### ItemCacheAdapter interface

**File:** `packages/sync/src/types.ts`

```typescript
export interface ItemCacheAdapter {
  supportsItemCache?: boolean;
  upsertCachedItem?(item: CachedEncryptedItem, email?: string): Promise<void>;
  removeCachedItem?(itemId: string, email?: string): Promise<void>;
  upsertCachedVault?(vault: CachedVaultMetadata, email?: string): Promise<void>;
  removeCachedVault?(vaultId: string, email?: string): Promise<void>;
}
```

This is a subset of `IStorageAdapter` — just the methods needed for delta sync. The storage adapter already implements these, so you can pass it directly.

### Delta sync in useSync

**File:** `packages/sync/src/use-sync.ts`

The `useSync` hook now accepts `itemCacheAdapter` in its options:

```typescript
export interface UseSyncOptions {
  serverUrl: string;
  getAuthToken: () => Promise<string | null>;
  clientId: string;
  queryClient: QueryClient;
  storage?: SyncStorage;
  enabled?: boolean;
  itemCacheAdapter?: ItemCacheAdapter;  // ← NEW: pass your storage adapter
}
```

**What happens on an SSE event:**

1. If `itemCacheAdapter?.supportsItemCache`, call `performDeltaSync()`:
   - `item_created`/`item_updated`/`item_restored`/`item_moved` → fetch item via `trpcClient.vault.getItem.query()` → `upsertCachedItem()`
   - `item_deleted` → try to fetch (may be soft-deleted) → `upsertCachedItem()` with `deletedAt`, or `removeCachedItem()` if permanently deleted
   - `vault_created`/`vault_updated` → fetch vault → `upsertCachedVault()`
   - `vault_deleted` → `removeCachedVault()`
2. Invalidate React Query (reads from updated cache)
3. Save last sync timestamp for catch-up

**What happens on reconnect:**

When connection status becomes `"connected"` and cache is supported:
1. Read `lastSyncTimestamp` from storage
2. Call `trpcClient.sync.getEventsSince.query({ since: lastTimestamp })`
3. Process each missed event through `performDeltaSync()` (skip own events)
4. Invalidate all item queries
5. Save updated timestamp

**First app start** (no timestamp stored): Cache is empty → hooks fall through to server fetch → server response populates cache → first SSE event saves a timestamp → subsequent starts catch up from there.

### Deleted offline files

Three files were deleted because they were unused scaffolding:
- `packages/sync/src/offline-cache.ts`
- `packages/sync/src/offline-queue.ts`
- `packages/sync/src/use-offline-vault.ts`

Their exports were removed from `packages/sync/src/index.ts`.

---

## Layer 4: Data Hooks (already done, shared by all platforms)

The hooks are platform-agnostic — they use `storage.supportsItemCache` to decide whether to try cache. No per-platform changes needed.

### Cache-first read pattern

All data hooks follow the same pattern:

```typescript
// In queryFn:
if (storage.supportsItemCache) {
  const cachedItems = await storage.getCachedItems?.(account.email);
  const cachedVaults = await storage.getCachedVaults?.(account.email);

  if (cachedItems && cachedVaults && cachedItems.length > 0) {
    // Cache HIT → build items from cache, skip server
    rawItems = buildRawItemsFromCache(cachedItems, cachedVaults);
  } else {
    // Cache MISS → fetch from server, then populate cache (fire-and-forget)
    rawItems = await account.trpcClient.vault.listAllItems.query();
    storage.setCachedItems?.(itemsToCache, account.email);  // no await
    storage.setCachedVaults?.(vaultsToCache, account.email); // no await
  }
} else {
  // No cache support → always fetch from server
  rawItems = await account.trpcClient.vault.listAllItems.query();
}
```

**Hooks with cache-first reads:**

| Hook | File | Cache behavior |
|------|------|---------------|
| `useItemsUnified` | `hooks/internal/use-items-unified.ts` | Cache-first + populates cache on miss |
| `useVaultItems` | `hooks/internal/use-vault-items.ts` | Cache-first (filters by vaultId), does NOT populate cache |
| `useDecryptedItem` | `hooks/internal/use-decrypted-item.ts` | Cache-first (finds by itemId) |
| `useDeletedItemsUnified` | `hooks/internal/use-deleted-items-unified.ts` | Cache-first (filters for `deletedAt != null`) |

**Only `useItemsUnified` populates the cache on miss** — it's the "main" hook that does the initial bulk fetch. The others are narrower views that rely on the cache being populated.

### Mutation cache updates

Each mutation hook updates the cache immediately in `onSuccess`, so the next query read sees the change without waiting for SSE round-trip.

**Pattern for mutations that have encrypted data (create, update, move):**

The `mutationFn` returns the encrypted data alongside the API result:

```typescript
mutationFn: async (input): Promise<{ itemId: string; _encryptedData?: {...} }> => {
  const encryptedData = await crypto.encrypt(JSON.stringify(input.data), vaultKey);
  const result = await client.vault.createItem.mutate({ ... });
  return {
    itemId: result.id,
    _encryptedData: {  // Captured for cache update
      ciphertext: encryptedData.ciphertext,
      iv: encryptedData.iv,
      algorithm: encryptedData.algorithm,
    },
  };
},
onSuccess: async (data, variables) => {
  if (storage.supportsItemCache && data._encryptedData) {
    storage.upsertCachedItem?.({ ... }, variables.accountEmail);
  }
  await invalidator.invalidateVaultList(variables.vaultId);
},
```

**Pattern for mutations without encrypted data (delete, restore, toggle favorite):**

The `mutationFn` returns the account email, and `onSuccess` reads from cache to update:

```typescript
mutationFn: async (input): Promise<{ _accountEmail: string | undefined }> => {
  const accountEmail = findAccountEmailForItem(input.itemId, items);
  await client.vault.deleteItem.mutate({ itemId: input.itemId });
  return { _accountEmail: accountEmail };
},
onSuccess: async (data, variables) => {
  if (storage.supportsItemCache) {
    const cachedItems = await storage.getCachedItems?.(data._accountEmail);
    const existing = cachedItems?.find((i) => i.id === variables.itemId);
    if (existing) {
      storage.upsertCachedItem?.({
        ...existing,
        deletedAt: new Date().toISOString(),  // Mark as deleted
        updatedAt: new Date().toISOString(),
      }, data._accountEmail);
    }
  }
},
```

**All mutation hooks and their cache operations:**

| Hook | Cache operation in `onSuccess` |
|------|-------------------------------|
| `useCreateItem` | `upsertCachedItem` with new item (version: 1, favorite: false) |
| `useUpdateItem` | Find existing in cache → `upsertCachedItem` with new encrypted data, version+1 |
| `useDeleteItem` | Find existing → `upsertCachedItem` with `deletedAt: now` |
| `useRestoreItem` | Find existing → `upsertCachedItem` with `deletedAt: null` |
| `useToggleFavorite` | Find existing → `upsertCachedItem` with new `favorite` value |
| `useMoveItem` | Cross-account: `removeCachedItem` from source + `upsertCachedItem` in target. Same-account: find existing → `upsertCachedItem` with new vaultId + encrypted data |
| `usePermanentDeleteItem` | `removeCachedItem` (removes entirely from cache) |

---

## Platform Integration: How to Wire It Up

For each platform that supports caching, you need to pass the storage adapter to `useSync` as `itemCacheAdapter`.

### Desktop (already done)

**File:** `apps/desktop/src/hooks/use-desktop-sync.ts`

```typescript
import { storage } from "@/lib/storage";  // TauriStorageAdapter

const syncState = useSync({
  serverUrl,
  getAuthToken,
  clientId,
  queryClient,
  storage: syncStorage,
  enabled: enabled && isInitialized && !!serverUrl && !!clientId,
  itemCacheAdapter: storage,  // ← Just pass the storage adapter
});
```

### Mobile (to implement)

In whatever hook provides sync to the mobile app, add the same line:

```typescript
import { storage } from "wherever-your-rn-storage-is";

const syncState = useSync({
  // ... existing options ...
  itemCacheAdapter: storage,  // ← Add this
});
```

### Web / Extension

No changes needed. The web/extension storage adapters don't set `supportsItemCache = true`, so delta sync and cache-first reads are automatically skipped. If you later add caching, just:
1. Implement the cache methods in the adapter
2. Set `supportsItemCache = true`
3. Pass the adapter as `itemCacheAdapter`

---

## Cache Lifecycle

| Event | What happens |
|-------|-------------|
| **First login** | Cache is empty → hooks fetch from server → `useItemsUnified` populates cache on first query |
| **Subsequent app opens** | Cache returns stale data instantly → catch-up via `getEventsSince` brings it current |
| **SSE event** | Delta fetch → update cache → invalidate queries → UI reads from updated cache |
| **Lock (clear MUK)** | In-memory cache arrays cleared. Disk cache NOT cleared (encrypted, safe at rest) |
| **Logout (`clearSession`)** | `clearItemCache()` called — both memory and disk cache cleared |
| **Remove account** | All cache storage keys deleted alongside other account data |
| **Account switch** | Query keys include account emails → switching triggers re-query from correct cache |

---

## Checklist for New Platform Implementation

- [ ] Import cache types from `@bittery/types`
- [ ] Set `readonly supportsItemCache = true` on adapter
- [ ] Implement `setCachedItems` / `getCachedItems` (bulk operations)
- [ ] Implement `upsertCachedItem` / `removeCachedItem` (single-item delta operations)
- [ ] Implement `setCachedVaults` / `getCachedVaults` (bulk vault metadata)
- [ ] Implement `upsertCachedVault` / `removeCachedVault` (single-vault operations)
- [ ] Implement `getItemCacheMetadata` / `setItemCacheMetadata` (cache state tracking)
- [ ] Implement `clearItemCache` (nuclear option)
- [ ] `removeCachedVault` must also remove items with matching `vaultId`
- [ ] Update `removeAccount()` to delete cache storage keys
- [ ] Update `clearSession()` to call `clearItemCache()`
- [ ] Pass storage adapter as `itemCacheAdapter` in your platform's sync hook
- [ ] Test: fresh login → items load from server → verify cache is populated
- [ ] Test: reload app → items load from cache (no server request)
- [ ] Test: edit item on another device → SSE → only 1 `getItem` call → UI updates
- [ ] Test: logout → verify cache cleared
- [ ] Test: close app → edit on web → reopen → catch-up works

---

## Files Changed (complete list)

| File | What changed |
|------|-------------|
| `packages/types/src/index.ts` | Added `CachedEncryptedItem`, `CachedVaultMetadata`, `ItemCacheMetadata` |
| `packages/storage/src/adapter.ts` | Added optional cache methods section to `IStorageAdapter` |
| `packages/storage/src/adapters/tauri.ts` | Full cache implementation + cleanup integration |
| `packages/sync/src/offline-cache.ts` | **DELETED** |
| `packages/sync/src/offline-queue.ts` | **DELETED** |
| `packages/sync/src/use-offline-vault.ts` | **DELETED** |
| `packages/sync/src/index.ts` | Removed deleted file exports |
| `packages/sync/src/types.ts` | Added `ItemCacheAdapter` interface |
| `packages/sync/src/use-sync.ts` | Delta sync logic, catch-up on reconnect, removed offline queue |
| `packages/sync/package.json` | Added `@bittery/types` dependency |
| `apps/desktop/src/hooks/use-desktop-sync.ts` | Added `itemCacheAdapter: storage` |
| `packages/hooks/src/hooks/internal/use-items-unified.ts` | Cache-first reads + cache population |
| `packages/hooks/src/hooks/internal/use-vault-items.ts` | Cache-first reads |
| `packages/hooks/src/hooks/internal/use-decrypted-item.ts` | Cache-first reads |
| `packages/hooks/src/hooks/internal/use-deleted-items-unified.ts` | Cache-first reads |
| `packages/hooks/src/hooks/items/use-create-item.ts` | Returns `_encryptedData`, cache upsert in onSuccess |
| `packages/hooks/src/hooks/items/use-update-item.ts` | Returns `_encryptedData` + `_accountEmail`, cache upsert in onSuccess |
| `packages/hooks/src/hooks/items/use-delete-item.ts` | Returns `_accountEmail`, sets `deletedAt` in cache |
| `packages/hooks/src/hooks/items/use-restore-item.ts` | Returns `_accountEmail`, clears `deletedAt` in cache |
| `packages/hooks/src/hooks/items/use-toggle-favorite.ts` | Returns `_accountEmail`, toggles `favorite` in cache |
| `packages/hooks/src/hooks/items/use-move-item.ts` | Returns `_encryptedData` + emails, handles cross/same-account cache |
| `packages/hooks/src/hooks/items/use-permanent-delete-item.ts` | Returns `_accountEmail`, `removeCachedItem` in cache |
| `apps/mobile/src/components/conflict-resolution-modal.tsx` | Fixed `SyncConflict` import (was from deleted file) |
