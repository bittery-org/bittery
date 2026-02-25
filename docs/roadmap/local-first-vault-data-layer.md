# Local-First Vault Data Layer

## TL;DR

Replace the current server-first, React Query-based data flow with a local-first architecture. A `VaultRepository` (one per account) holds decrypted items in memory, backed by dumb storage adapters. Mutations write to the repository instantly (UI updates via `useSyncExternalStore`), then an `OutboundQueue` drains them to the server in the background. Inbound sync (SSE) writes encrypted items into the repository. React Query is removed from the vault data read path entirely — it stays only for server communication in non-vault contexts (teams, shares, account settings). Last-write-wins, no conflict UI, fully transparent to the user.

---

## Implementation Status (Updated February 25, 2026)

### Phase 1 — VaultRepository (foundation)
- [x] `VaultRepository` created (`packages/core/src/services/vault-repository.ts`)
- [x] `VaultRepositoryCoordinator` created (`packages/core/src/services/vault-repository-coordinator.ts`)
- [x] Shared vault key utility added (`packages/shared/src/vault-key-crypto.ts`)
- [ ] Unit tests for repository/coordinator are not added yet

### Phase 2 — OutboundQueue
- [x] `OutboundQueue` implemented (`packages/sync/src/outbound-queue.ts`)
- [x] `enqueue`, `drain`, `compact`, `rewritePendingIds`, `restore`, and per-account persistence are implemented
- [x] Queue is wired through sync and mutation hooks
- [ ] Dedicated unit tests for queue behavior are not added yet

### Phase 3 — Move Vault Key Decryption Out of Storage Adapters
- [x] Duplicated `isAesEncryptedVaultKey()` logic removed from adapters in favor of shared utility
- [x] Adapter-level `getDecryptedVaultKey()` / `decryptVaultKey()` removed from interface and adapters
- [ ] Adapter crypto constructor dependency removal is not complete
- [x] Caller migration to shared vault-key utilities is complete for current app/core paths

### Phase 4 — Headless SyncOrchestrator + Wire to VaultRepository
- [x] `SyncOrchestrator` implemented (`packages/sync/src/sync-orchestrator.ts`)
- [x] `useSync()` now delegates orchestration to `SyncOrchestrator`
- [x] `performDeltaSync()` updated to support repository-style cache methods
- [x] SSE/catch-up skips inbound updates when pending outbound exists
- [x] Reconnect flow runs catch-up + queue compact/drain + temp ID replacement

### Phase 5 — Replace UI Hooks with `useSyncExternalStore`
- [x] `use-items`, `use-vault-items`, `use-item`, and `use-deleted-items` migrated to `useSyncExternalStore`
- [x] Hydration-aware loading behavior added via coordinator
- [x] `use-vault-search` remains compatible through `useItems()`
- [x] `use-all-vault-keys` now reads from coordinator-backed repository state

### Phase 6 — Local-First Mutation Hooks
- [x] `useCreateItem`, `useUpdateItem`, `useDeleteItem`, `usePermanentDeleteItem`, `useRestoreItem`, `useToggleFavorite`, and `useMoveItem` now support local-first writes + queue enqueue
- [x] Synchronous account resolution uses coordinator (`findAccountForItem`/`findAccountForVault`)
- [x] Server-first fallback path remains when queue is unavailable

### Phase 7 — Delete CacheManager + Slim ItemService
- [x] Added pure helper methods to `ItemService` (`encryptItemData`, `mergeItemUpdate`, `reEncryptForVault`)
- [x] Added coordinator to core context
- [x] `CacheManager` deleted and removed from core context/hooks
- [ ] Legacy read/mutation methods still remain in `ItemService` for backward compatibility
- [x] Cache write paths now go through repositories/coordinator

### Phase 8 — Cleanup
- [x] Item/vault local query-key invalidation path removed from sync event mapping
- [x] `OfflineOperation` replaced with `PendingMutation` exports/types
- [x] `SyncStatus.pendingChanges` is wired to queue pending count
- [x] Shared vault-key format utility reused by storage adapters
- [x] Web/desktop/mobile sync provider/hook integration updated for coordinator + outbound queue
- [x] Extension sync cache integration now writes through coordinator-backed cache adapter

---

## Current Architecture (what we're replacing)

**Server-first mutations:** Every item create/update/delete encrypts locally, then `await`s the tRPC server call. Only on success does the local cache update. Offline = broken.

**Dual cache with manual coherence:** `CacheManager` stores encrypted items in platform storage (IndexedDB/SQLite/Tauri Store). React Query caches decrypted items in memory. Every mutation must update both independently — `cache.onItemX()` + `invalidator.invalidateX()`.

**Re-decryption on every invalidation:** When React Query invalidates `["items"]`, `fetchAndDecryptItems()` reads all encrypted items from cache and re-decrypts the entire list.

**Sync engine coupled to React:** `useSync()` is a React hook that orchestrates SSE, delta sync, catch-up, *and* React Query invalidation.

**Key files involved:**

- `packages/core/src/services/item-service.ts` — 1000-line god service: fetch, decrypt, encrypt, create, update, move, delete
- `packages/core/src/services/cache-manager.ts` — encrypted item cache, read-modify-write per mutation
- `packages/core/src/hooks/use-items.ts` — React Query `useQuery` with 5-min staleTime
- `packages/core/src/hooks/items/` — mutation hooks, each manually updates cache + invalidates queries
- `packages/sync/src/use-sync.ts` — React hook wiring SSE → delta sync → query invalidation
- `packages/sync/src/delta-sync.ts` — fetches changed entity via tRPC, upserts into storage adapter
- `packages/sync/src/query-invalidation.ts` — maps sync events to React Query key invalidation
- `packages/storage/src/adapter.ts` — `IStorageAdapter` with optional item cache + vault key decryption baked in
- Storage implementations: `packages/storage/src/web.ts`, `chrome.ts`, `tauri.ts`, `react-native.ts`

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  UI Components                                               │
│    useSyncExternalStore(coordinator.subscribe, selector)     │
├─────────────────────────────────────────────────────────────┤
│  VaultRepositoryCoordinator                                  │
│    Aggregates per-account VaultRepository instances           │
│    getAll() / getByVault() / getById() / subscribe()        │
├─────────────────────────────────────────────────────────────┤
│  VaultRepository (one per account)                           │
│    In-memory Map<itemId, DecryptedItem>                      │
│    Encrypt/decrypt via ICrypto + vault keys                  │
│    upsertEncrypted() / upsertLocal() / remove() / hydrate() │
├──────────────┬──────────────────────────────┬───────────────┤
│  Storage     │  OutboundQueue               │  SyncOrchestrator │
│  Adapter     │  Persisted pending mutations  │  SSE + catch-up   │
│  (dumb I/O)  │  Drains to server on connect │  Writes to repo   │
└──────────────┴──────────────────────────────┴───────────────┘
```

**Mutation flow (local-first):**

1. Hook encrypts data, calls `vaultRepository.upsertLocal(item)` → memory updated → subscribers notified → UI re-renders instantly
2. `outboundQueue.enqueue(pendingMutation)` → persisted to storage
3. Background: queue drains FIFO → tRPC call to server → on success, remove from queue
4. On failure: retry on next reconnect. Last-write-wins — no conflict UI.

**Inbound sync flow:**

1. SSE event arrives → `SyncOrchestrator` runs `performDeltaSync()`
2. Delta sync fetches the changed entity via tRPC, calls `vaultRepository.upsertEncrypted(item)`
3. Repository decrypts, updates memory, notifies subscribers → UI re-renders
4. If the item has a pending outbound mutation, skip the inbound update (local version takes precedence)

**Read flow:**

1. `useSyncExternalStore(coordinator.subscribe, coordinator.getAll)` — synchronous, no async, no re-decryption
2. On cold start, `coordinator.hydrate()` reads encrypted items from storage, decrypts into memory

---

## Phase 1 — VaultRepository (foundation)

**New file: `packages/core/src/services/vault-repository.ts`**

One instance per account. Constructor: `(crypto: ICrypto, storage: IStorageAdapter, email?: string)`

Internal state:

- `items: Map<string, DecryptedItem>` — keyed by item ID
- `vaults: Map<string, VaultMetadata>` — vault metadata
- `vaultKeys: Map<string, Uint8Array>` — decrypted vault key cache
- `listeners: Set<() => void>` — `useSyncExternalStore` subscribers
- `snapshot: number` — incremented on every state change

Public read API (all synchronous):

- `getAll(): DecryptedItem[]`
- `getById(id: string): DecryptedItem | undefined`
- `getByVault(vaultId: string): DecryptedItem[]`
- `getDeleted(): DecryptedItem[]`
- `getSnapshot(): number`
- `subscribe(listener: () => void): () => void`

Public write API (async, handles encrypt/decrypt + persistence):

- `upsertEncrypted(item: CachedEncryptedItem): Promise<void>` — decrypt → update memory → persist → notify. Used by inbound sync.
- `upsertLocal(item: DecryptedItem, encryptedPayload: EncryptedPayload): Promise<void>` — update memory with decrypted data → persist encrypted → notify. Used by local mutations (already have both forms).
- `softDelete(itemId: string): Promise<void>` — set `deletedAt` in memory + storage → notify
- `restore(itemId: string): Promise<void>` — clear `deletedAt` → notify
- `removeItem(itemId: string): Promise<void>` — remove from memory + storage → notify
- `replaceItemId(tempId: string, realId: string): void` — swap key in map after server assigns real ID → notify
- `updateFavorite(itemId: string, favorite: boolean): Promise<void>` → notify
- `moveItem(itemId: string, targetVaultId: string, newEncryptedPayload: EncryptedPayload): Promise<void>` — update vaultId + data → notify

Hydration:

- `hydrate(): Promise<void>` — read `storage.getCachedItems()`, decrypt all, populate memory
- `hydrateFromServer(trpcClient): Promise<void>` — paginate `sync.bootstrapItems`, populate memory + storage
- `clear(): void` — wipe memory (lock/logout)

Internal:

- `decryptVaultKey(vaultId): Promise<Uint8Array>` — reads encrypted vault key from storage, decrypts with MUK via `ICrypto`, caches result
- `decryptItem(item: CachedEncryptedItem): Promise<DecryptedItem>` — uses cached vault key
- `persistItem(item: CachedEncryptedItem): Promise<void>` — writes to storage adapter

Implements `ItemCacheAdapter` from `packages/sync/src/types.ts` so the sync engine can write to it.

**New file: `packages/core/src/services/vault-repository-coordinator.ts`**

- `repos: Map<email, VaultRepository>`
- `getOrCreate(email, crypto, storage): VaultRepository`
- `remove(email): void`
- `getAll(): DecryptedItem[]` — aggregates across active repos
- `getByVault(vaultId): DecryptedItem[]` — finds correct repo
- `getById(id): DecryptedItem | undefined` — scans repos
- `getDeleted(): DecryptedItem[]` — aggregates
- `findAccountForItem(itemId): { email, repo } | undefined`
- `subscribe(listener): unsubscribe` — fans out to all active repos
- `getSnapshot(): number` — sum/hash of all repo snapshots
- `hydrate(): Promise<void>` — hydrate all active repos
- `clear(): void` — clear all repos

**New standalone utility: `decryptVaultKey(encryptedKey, muk, crypto)`**

Extract from the duplicated logic in all 4 storage adapters (each has identical `isAesEncryptedVaultKey()` + AES/RSA branching). Shared by VaultRepository and login/unlock flows.

**Ship criteria:** VaultRepository exists with unit tests. Nothing consumes it yet. No behavior change.

---

## Phase 2 — OutboundQueue

**New file: `packages/sync/src/outbound-queue.ts`**

Types:

```ts
interface PendingMutation {
  id: string;                    // uuid
  type: "create" | "update" | "delete" | "permanent_delete" | "restore" | "move" | "toggle_favorite";
  entityId: string;              // itemId (temp client ID for creates)
  vaultId: string;
  targetVaultId?: string;        // for moves
  category?: string;             // for creates
  encryptedPayload?: {           // encrypted data ready to send
    encryptedData: string;
    encryptionIv: string;
    encryptionAlgorithm: string;
  };
  favorite?: boolean;            // for toggle_favorite
  baseVersion: number;           // item version at mutation time
  accountEmail: string;
  timestamp: number;
  retryCount: number;
}
```

Constructor: `(storage: SyncStorage, clientId: string)`

Methods:

- `enqueue(mutation: PendingMutation): void` — append to queue, persist to `SyncStorage` under `bittery_pending_mutations_{email}`, increment pending count
- `drain(getClient: (email) => TrpcClient): Promise<void>` — process FIFO:
  - For each op, call the corresponding tRPC mutation
  - `create` → `vault.createItem.mutate()` → on success, record `tempId → realId` mapping
  - `update` → `vault.updateItem.mutate()`
  - `delete` → `vault.deleteItem.mutate()`
  - `permanent_delete` → `vault.permanentlyDeleteItem.mutate()`
  - `restore` → `vault.restoreItem.mutate()`
  - `move` → `vault.moveItem.mutate()`
  - `toggle_favorite` → `vault.toggleFavorite.mutate()`
  - On success: remove from queue, persist
  - On network error: stop draining, increment retry count, leave in queue
  - On 409/conflict: last-write-wins — force-push (retry without version check). Server accepts the latest write.
  - On other server error (400, 404): discard the operation (item may have been deleted by another device), log
- `rewritePendingIds(tempId: string, realId: string): void` — after a create succeeds, rewrite any queued ops that reference `tempId` to use `realId`
- `compact(): void` — optimize queue: collapse delete + permanent_delete into just permanent_delete; drop updates to items that have a pending delete; collapse sequential updates to same item into latest
- `getPendingCount(): number`
- `hasPendingForItem(itemId: string): boolean`
- `getPendingForItem(itemId: string): PendingMutation | undefined`
- `restore(): Promise<void>` — on app start, load persisted queue from storage
- `clear(email?: string): void` — wipe queue (logout)

**Ship criteria:** OutboundQueue exists with unit tests for enqueue/drain/compact/tempId rewrite/persistence. No consumers yet.

---

## Phase 3 — Move Vault Key Decryption Out of Storage Adapters

Remove `getDecryptedVaultKey()`, `decryptVaultKey()`, and `isAesEncryptedVaultKey()` from:

- `packages/storage/src/adapter.ts` (interface)
- `packages/storage/src/web.ts`
- `packages/storage/src/chrome.ts`
- `packages/storage/src/tauri.ts`
- `packages/storage/src/react-native.ts`

Remove `CryptoProvider` constructor dependency from all adapters. Storage adapters no longer import or know about crypto.

Callers migrate:

- VaultRepository uses its internal `decryptVaultKey()` method (Phase 1)
- Login/unlock flows in `packages/core/src/services/auth-service.ts` and `packages/core/src/auth/` use the standalone `decryptVaultKey()` utility
- `packages/core/src/services/share-service.ts` uses the standalone utility or goes through VaultRepository
- `isAesEncryptedVaultKey()` extracted to `packages/shared/src/` or `packages/types/src/`

**Ship criteria:** `pnpm run check-types` passes. Storage adapters have no crypto imports. All vault key decryption still works via new paths.

---

## Phase 4 — Headless SyncOrchestrator + Wire to VaultRepository

**New file: `packages/sync/src/sync-orchestrator.ts`**

Extracts all non-React logic from `useSync()`. Constructor deps: `SyncManagerOptions`, `trpcClient`, `VaultRepository` (as `ItemCacheAdapter`), `OutboundQueue`.

Responsibilities:

- Owns `SyncManager` (SSE connection lifecycle)
- On SSE event: check `queue.hasPendingForItem(entityId)` — if yes, skip (local version wins). Otherwise, call `performDeltaSync()` which fetches the entity via tRPC and calls `vaultRepository.upsertEncrypted()`.
- On reconnect (`status → "connected"`): run `runCatchUp()` first (with same pending-item skip), then `queue.compact()`, then `queue.drain(client)`. After drain completes, call `queue.rewritePendingIds()` for any creates, then notify VaultRepository to `replaceItemId()`.
- Exposes: `connect()`, `disconnect()`, `reconnect()`, `status` (observable)
- No React imports

**Modify `packages/sync/src/delta-sync.ts`:**

- `performDeltaSync()` writes to VaultRepository (which implements `ItemCacheAdapter`). No change to its signature — VaultRepository is passed as the `ItemCacheAdapter` param.
- VaultRepository's `upsertEncrypted()` handles decrypt + memory update + subscriber notification, so the delta sync path now automatically updates the UI.

**Slim `packages/sync/src/use-sync.ts`:**

- Instantiates `SyncOrchestrator`, subscribes to its status for displaying connection state if needed
- No longer manages delta sync, catch-up, or query invalidation for item data
- Still handles query invalidation for non-vault data (teams, shares, members) via `getQueryKeysForEvent()`

**Modify `packages/sync/src/query-invalidation.ts`:**

- Remove all item/vault data query keys: `["items"]`, `["vault-items"]`, `["decrypted-item"]`, `["decrypted-item-account"]`, `["deleted-items"]`, `["all-vault-keys"]`
- Keep team, share, member invalidation keys

**Ship criteria:** Sync events flow through VaultRepository. SSE → delta sync → repository → UI without React Query. Queue drains on reconnect.

---

## Phase 5 — Replace UI Hooks with `useSyncExternalStore`

**Rewrite `packages/core/src/hooks/use-items.ts`:**

- Before: `useQuery(["items", emails], () => core.items.fetchAndDecryptItems(...))`
- After: `useSyncExternalStore(coordinator.subscribe, coordinator.getAll)`
- Still depends on `useAccountsInfo()` to know which accounts are active (this triggers hydration if needed)
- Add a `isHydrating` check: if VaultRepository hasn't hydrated yet, show loading state

**Rewrite `packages/core/src/hooks/use-vault-items.ts`:**

- After: `useSyncExternalStore(coordinator.subscribe, () => coordinator.getByVault(vaultId))`
- Memoize the selector with `useCallback` to avoid creating new function references

**Rewrite `packages/core/src/hooks/use-item.ts`:**

- After: `useSyncExternalStore(coordinator.subscribe, () => coordinator.getById(id))`
- If item not found (deep link before hydration), trigger hydration and return loading

**Rewrite `packages/core/src/hooks/use-deleted-items.ts`:**

- After: `useSyncExternalStore(coordinator.subscribe, coordinator.getDeleted)`

**`packages/core/src/hooks/use-vault-search.ts`:**

- Minimal change — already derives from `useItems()` via `useMemo`. Same pattern, new data source.

**`packages/core/src/hooks/use-all-vault-keys.ts`:**

- Can read from VaultRepository's vault metadata instead of calling `storage.getVaultKeys()` per account

**Ship criteria:** All item/vault read hooks use `useSyncExternalStore`. No `useQuery` for local vault data. UI behavior identical.

---

## Phase 6 — Local-First Mutation Hooks

Rewrite all mutation hooks in `packages/core/src/hooks/items/`.

The `useMutation` wrapper stays (for loading/error state), but the flow changes:

**`useCreateItem`:**

1. Generate temp client ID (`crypto.randomUUID()`)
2. Get decrypted vault key from VaultRepository
3. Encrypt item data → `encryptedPayload`
4. Call `vaultRepository.upsertLocal(tempItem, encryptedPayload)` → UI updates instantly
5. Call `outboundQueue.enqueue({ type: "create", entityId: tempId, ... })`
6. Return `{ itemId: tempId }` immediately

**`useUpdateItem`:**

1. Read current item from VaultRepository (sync, in-memory — no server fetch)
2. Merge data (password history for login items via `ItemService.mergeItemUpdate()`)
3. Encrypt → `encryptedPayload`
4. Call `vaultRepository.upsertLocal(updatedItem, encryptedPayload)` → UI updates instantly
5. Call `outboundQueue.enqueue({ type: "update", entityId, baseVersion: item.version, ... })`

**`useDeleteItem`:**

1. Call `vaultRepository.softDelete(itemId)` → UI updates instantly
2. Call `outboundQueue.enqueue({ type: "delete", entityId: itemId, ... })`

**`usePermanentDeleteItem`:**

1. Call `vaultRepository.removeItem(itemId)` → UI updates instantly
2. Call `outboundQueue.enqueue({ type: "permanent_delete", entityId: itemId, ... })`

**`useRestoreItem`:**

1. Call `vaultRepository.restore(itemId)` → UI updates instantly
2. Call `outboundQueue.enqueue({ type: "restore", entityId: itemId, ... })`

**`useToggleFavorite`:**

1. Call `vaultRepository.updateFavorite(itemId, !current)` → UI updates instantly
2. Call `outboundQueue.enqueue({ type: "toggle_favorite", entityId: itemId, favorite: !current, ... })`

**`useMoveItem`:**

1. Get source + target vault keys from VaultRepository (or coordinator for cross-account)
2. Decrypt with source key, re-encrypt with target key
3. Call `vaultRepository.moveItem(itemId, targetVaultId, newPayload)` → UI updates instantly
4. Call `outboundQueue.enqueue({ type: "move", ... })`

No `onSuccess` cache updates needed. No `invalidator` calls. `useSyncExternalStore` subscribers fire automatically when VaultRepository state changes.

Remove account resolution via `useItems()` from mutation hooks. Replace with `coordinator.findAccountForItem(itemId)` — synchronous, in-memory.

**Ship criteria:** All item mutations are instant. Network calls happen in background via queue. UI works identically offline and online.

---

## Phase 7 — Delete CacheManager + Slim ItemService

**Delete `packages/core/src/services/cache-manager.ts`**

All logic absorbed by VaultRepository.

**Slim `packages/core/src/services/item-service.ts`:**

Remove:

- `fetchAndDecryptItems()`, `fetchVaultItems()`, `fetchAndDecryptItem()` — absorbed by VaultRepository hydration
- `deleteItem()`, `restoreItem()`, `permanentDeleteItem()`, `toggleFavorite()` — trivial, handled inline by hooks + queue
- CacheManager dependency

Keep / refactor into pure functions:

- `encryptItemData(data, vaultKey, crypto): EncryptedPayload` — used by mutation hooks
- `mergeItemUpdate(existing, update, category): MergedData` — password history logic for logins
- `reEncryptForVault(encryptedData, sourceKey, targetKey, crypto): EncryptedPayload` — used by moves
- `bulkImportItems()` — stays as-is, used for CSV import (server-first is fine for bulk)

Update `packages/core/src/core-context.ts`:

- Remove `cache: CacheManager` from `CoreContext`
- Add `vaultCoordinator: VaultRepositoryCoordinator`
- Keep `items: ItemService` but slimmed

**Ship criteria:** CacheManager gone. ItemService is a pure encryption/logic service. `pnpm run check-types` passes.

---

## Phase 8 — Cleanup

1. Remove stale React Query keys from `packages/sync/src/query-invalidation.ts`: `["items"]`, `["vault-items"]`, `["decrypted-item"]`, `["decrypted-item-account"]`, `["deleted-items"]`
2. Remove unused `OfflineOperation` type from `packages/sync/src/types.ts`, replace with `PendingMutation`
3. Wire `SyncStatus.pendingChanges` to `queue.getPendingCount()` internally (not exposed to UI, but useful for debugging)
4. Remove `isAesEncryptedVaultKey()` duplication from all 4 storage adapters, use shared import
5. Audit all apps (`apps/web/`, `apps/desktop/`, `apps/extension/`, `apps/mobile/`) for direct `storage.getCachedItems()` / `storage.setCachedItems()` calls outside VaultRepository — redirect them
6. Update `apps/web/src/hooks/use-web-sync.ts` and `apps/web/src/providers/sync-provider.tsx` to instantiate `SyncOrchestrator` + `OutboundQueue` + `VaultRepositoryCoordinator` and pass them through context
7. Same for desktop, extension, mobile sync integration points

---

## Verification

- `pnpm run check-types` after each phase
- `pnpm run check` (Biome) passes
- `pnpm run test` passes
- Playwright E2E in `apps/web/tests` and `apps/extension/tests`
- Manual: create item → appears instantly (no spinner/network wait)
- Manual: airplane mode → create 3 items, edit 1, delete 1 → all reflected in UI instantly → go online → items sync to server silently
- Manual: edit same item on two offline devices → both go online → last one wins silently, no error
- Manual: create item offline → immediately edit it → go online → create drains first (gets real ID), then update drains with rewritten ID
- Manual: kill app with pending mutations → restart → queue persisted → drains on connect
- Manual: lock → unlock → items still in memory from hydration, pending queue intact
- Manual: multi-account with 2 unlocked accounts → items from both shown, mutations route to correct account
- Manual: SSE event arrives for item with pending local edit → local version preserved, not overwritten

---

## Decisions

- **Last-write-wins, silent:** No conflict UI, no sync status badges, no pending indicators. If two devices edit the same item, the last one to push wins. The user never sees conflict state.
- **One VaultRepository per account + coordinator:** Clean boundaries, no vault key mixing across accounts.
- **Vault key decryption moves out of storage adapters:** Adapters become pure key-value stores. Standalone utility for login/unlock flows.
- **VaultRepository tracks soft-deleted items:** Single source of truth, `getDeleted()` method.
- **Items only for local-first:** Vault/team/share mutations stay server-first (infrequent, need server coordination).
- **Queue drains on reconnect (batch, FIFO):** After catch-up completes. No continuous background retry.
- **Encryption at enqueue time:** Queue stores encrypted payloads. No vault key needed at drain time.
- **Incremental phases:** Each independently shippable.

---

## Edge Cases

- **Hydration race:** `useSyncExternalStore` returns `[]` until `hydrate()` completes. Coordinator exposes `isHydrating` boolean. Hooks return a loading state during hydration.
- **Vault key rotation:** `vault_key_rotated` sync event → VaultRepository clears its key cache for that vault → re-decrypts affected items with new key. `refreshVaultKeys()` must trigger repository re-hydration for that vault.
- **Stale encryption in queue:** If vault keys rotate while ops are pending, queued payloads use the old key. Server stores whatever ciphertext it receives. Items re-encrypt during the key rotation flow (existing behavior).
- **Cross-account move:** Coordinator bridges two VaultRepository instances — decrypt from source repo's key, re-encrypt with target repo's key.
- **Temp ID → real ID:** Queue tracks mapping. `replaceItemId()` in VaultRepository swaps the Map key. Any queued ops referencing the temp ID get rewritten via `queue.rewritePendingIds()`.
- **Auth token expiry offline:** Queue can't drain until re-auth. Existing `getAuthToken()` flow handles token refresh.
- **Queue compaction:** Before drain, collapse: delete + permanent_delete → permanent_delete; drop updates to items with pending delete; sequential updates to same item → keep latest only.
- **Extension service worker:** Uses `SyncManager` directly (not React). The headless `SyncOrchestrator` is directly usable — validate this path.
- **`storeVaultKeys` on login:** After login, `refreshVaultKeys()` stores encrypted vault keys. VaultRepository must be notified to load and decrypt them — wire into unlock flow.
