# Plan: Extract Business Logic into `@bittery/core`

**Implementation Status (2026-02-08):**
- ✅ Phase 1 completed
- ✅ Phase 2 completed
- ✅ Phase 3 completed
- ✅ Phase 4 completed
- ✅ Phase 5 completed
- ✅ Phase 6 completed
- ✅ Phase 7 completed
- ⏳ Phase 8 not implemented (optional)

## Context

The `@bittery/hooks` package contains ~30 React hooks that mix React Query state management with substantial business logic: account resolution, cache-first fetching, multi-account parallel decryption, encryption orchestration, and tRPC client management. This makes the code hard to test, hard to reuse outside React (the extension service worker duplicates vault decryption in `vault-utils.ts`/`vault-handlers.ts`), and hard to reason about.

Introduce `@bittery/core` — framework-agnostic TypeScript services that own all business logic. Hooks become thin React Query wrappers.

---

## Phase 1: Package Scaffold + Types

**Status:** ✅ Completed

**Goal:** Create the `@bittery/core` package and establish type ownership.

**Steps:**
1. Create `packages/core/package.json` — deps: `@bittery/types`, `@bittery/storage`, `@bittery/shared`; zero React dependency
2. Create `packages/core/tsconfig.json` extending shared config
3. Create `packages/core/src/types.ts` — move `ICrypto`, `DerivedKeys`, `SRPClientEphemeral`, `SRPServerChallenge`, `SRPClientSession` from `packages/hooks/src/types.ts`
4. Update `packages/hooks/src/types.ts` to re-export these types from `@bittery/core` (backwards compatible)
5. Create `packages/core/src/core-context.ts` — empty `CoreContext` interface + `createCoreContext()` factory (placeholder, no services yet)
6. Create `packages/core/src/index.ts` with exports
7. `pnpm install` to link the new workspace package

**Files created:**
- `packages/core/package.json`
- `packages/core/tsconfig.json`
- `packages/core/src/index.ts`
- `packages/core/src/types.ts`
- `packages/core/src/core-context.ts`

**Files modified:**
- `packages/hooks/src/types.ts` — re-export crypto types from `@bittery/core`
- `packages/hooks/package.json` — add `@bittery/core` dependency

**Verify:** ✅ `pnpm --filter @bittery/core check-types` passed; ✅ `pnpm --filter @bittery/hooks check-types` passed.

---

## Phase 2: AccountResolver

**Status:** ✅ Completed

**Goal:** Extract account resolution logic into a framework-agnostic service.

**Extracts from:**
- `packages/hooks/src/hooks/internal/use-accounts-info.ts` (lines 51-102)
- `packages/hooks/src/utils/account-helper.ts` (`getTRPCClientForAccount`, `findAccountEmailForItem`)

**Steps:**
1. Create `packages/core/src/services/account-resolver.ts`:
   - `resolveAccounts()` — gets active account config, resolves single vs all-accounts, creates per-account tRPC clients
   - `getClientForAccount(defaultClient, accountEmail?)` — wraps `getTRPCClientForAccount`
   - `findAccountForItem(itemId, items)` — wraps `findAccountEmailForItem`
2. Wire `AccountResolver` into `createCoreContext`
3. Update `PlatformProvider` (`packages/hooks/src/context/platform-context.tsx`) to create `CoreContext` and expose via `useCoreContext()` hook
4. Migrate `useAccountsInfo` to delegate to `core.accounts.resolveAccounts()`
5. Keep `utils/account-helper.ts` as thin re-exports from core (backwards compat)

**Files created:**
- `packages/core/src/services/account-resolver.ts`

**Files modified:**
- `packages/core/src/core-context.ts` — add `accounts` service
- `packages/core/src/index.ts` — export `AccountResolver`
- `packages/hooks/src/context/platform-context.tsx` — add `core: CoreContext` to context, add `useCoreContext()` hook
- `packages/hooks/src/hooks/internal/use-accounts-info.ts` — delegate to `core.accounts`
- `packages/hooks/src/utils/account-helper.ts` — delegate to core

**Verify:** ✅ `pnpm --filter @bittery/core check-types` and `pnpm --filter @bittery/hooks check-types` passed.

---

## Phase 3: CacheManager

**Status:** ✅ Completed

**Goal:** Centralize all cache read/write operations into one service.

**Extracts from:**
- Cache read logic in `use-items-unified.ts` (lines 138-184)
- Cache write logic in `onSuccess` of `use-create-item.ts` (lines 121-142), `use-update-item.ts`, `use-delete-item.ts`, `use-restore-item.ts`, `use-toggle-favorite.ts`, `use-move-item.ts`

**Steps:**
1. Create `packages/core/src/services/cache-manager.ts`:
   - `supportsCache` getter
   - `getCachedItems(email?)` / `getCachedVaults(email?)`
   - `populateFromServerResponse(items, vaults, email?)` — cache raw server data
   - `onItemCreated(...)` / `onItemUpdated(...)` / `onItemDeleted(...)` / `onItemRestored(...)` / `onItemPermanentlyDeleted(...)` / `onFavoriteToggled(...)` — mutation cache updates
2. Wire into `createCoreContext`
3. Migrate all mutation hooks' `onSuccess` handlers to use `core.cache.onXxx()`

**Files created:**
- `packages/core/src/services/cache-manager.ts`

**Files modified:**
- `packages/core/src/core-context.ts` — add `cache` service
- `packages/core/src/index.ts` — export `CacheManager`
- `packages/hooks/src/hooks/items/use-create-item.ts` — `onSuccess` uses `core.cache`
- `packages/hooks/src/hooks/items/use-update-item.ts` — `onSuccess` uses `core.cache`
- `packages/hooks/src/hooks/items/use-delete-item.ts` — `onSuccess` uses `core.cache`
- `packages/hooks/src/hooks/items/use-restore-item.ts` — `onSuccess` uses `core.cache`
- `packages/hooks/src/hooks/items/use-permanent-delete-item.ts` — `onSuccess` uses `core.cache`
- `packages/hooks/src/hooks/items/use-toggle-favorite.ts` — `onSuccess` uses `core.cache`
- `packages/hooks/src/hooks/items/use-move-item.ts` — `onSuccess` uses `core.cache`

**Verify:** ✅ `pnpm --filter @bittery/core check-types` and `pnpm --filter @bittery/hooks check-types` passed.

---

## Phase 4: ItemService (reads)

**Status:** ✅ Completed

**Goal:** Extract item fetching and decryption pipeline into a reusable service.

**Extracts from:**
- `use-items-unified.ts` — the entire `queryFn` (lines 128-282): cache-first fetch, parallel decryption, vault key caching, multi-account assembly
- `use-vault-items.ts` — vault-specific item fetch
- `use-decrypted-item.ts` — single item fetch and decrypt
- `use-deleted-items-unified.ts` — deleted items fetch

**Steps:**
1. Create `packages/core/src/services/item-service.ts` with read methods:
   - `fetchAndDecryptItems(accounts, opts?)` — full pipeline: cache check → server fetch → cache populate → decrypt → assemble
   - `fetchVaultItems(vaultId, accounts)` — single vault items
   - `fetchAndDecryptItem(itemId, accountEmail?, defaultClient?)` — single item
   - `fetchDeletedItems(accounts, opts?)` — deleted items
2. Move `buildRawItemsFromCache()` helper into `ItemService` as private method
3. Wire into `createCoreContext`
4. Migrate all four read hooks to: `queryFn: () => core.items.fetchXxx(...)`

**Files created:**
- `packages/core/src/services/item-service.ts`

**Files modified:**
- `packages/core/src/core-context.ts` — add `items` service
- `packages/core/src/index.ts` — export `ItemService`
- `packages/hooks/src/hooks/internal/use-items-unified.ts` — delegate queryFn
- `packages/hooks/src/hooks/internal/use-vault-items.ts` — delegate queryFn
- `packages/hooks/src/hooks/internal/use-decrypted-item.ts` — delegate queryFn
- `packages/hooks/src/hooks/internal/use-deleted-items-unified.ts` — delegate queryFn

**Verify:** ✅ `pnpm --filter @bittery/core check-types` and `pnpm --filter @bittery/hooks check-types` passed.  
**Pending manual smoke test:** items load in web/desktop/extension.

---

## Phase 5: ItemService (writes)

**Status:** ✅ Completed

**Goal:** Extract item mutation logic (encrypt + API call) into the service.

**Extracts from:**
- `use-create-item.ts` `mutationFn` (lines 80-119)
- `use-update-item.ts` `mutationFn`
- `use-delete-item.ts` `mutationFn`
- `use-restore-item.ts` `mutationFn`
- `use-permanent-delete-item.ts` `mutationFn`
- `use-toggle-favorite.ts` `mutationFn`
- `use-move-item.ts` `mutationFn`

**Steps:**
1. Add write methods to `ItemService`:
   - `createItem(input, client)` — get vault key, encrypt, call API
   - `updateItem(input, client)` — get vault key, re-encrypt, call API
   - `deleteItem(itemId, client)` — soft delete via API
   - `restoreItem(itemId, client)` — restore via API
   - `permanentDeleteItem(itemId, client)` — hard delete via API
   - `toggleFavorite(itemId, favorite, client)` — toggle via API
   - `moveItem(input, defaultClient)` — decrypt with source key, re-encrypt with target key, handle cross-account
2. Migrate all seven mutation hooks to: `mutationFn: () => core.items.xxx(...)`

**Files modified:**
- `packages/core/src/services/item-service.ts` — add write methods
- `packages/hooks/src/hooks/items/use-create-item.ts` — delegate mutationFn
- `packages/hooks/src/hooks/items/use-update-item.ts` — delegate mutationFn
- `packages/hooks/src/hooks/items/use-delete-item.ts` — delegate mutationFn
- `packages/hooks/src/hooks/items/use-restore-item.ts` — delegate mutationFn
- `packages/hooks/src/hooks/items/use-permanent-delete-item.ts` — delegate mutationFn
- `packages/hooks/src/hooks/items/use-toggle-favorite.ts` — delegate mutationFn
- `packages/hooks/src/hooks/items/use-move-item.ts` — delegate mutationFn

**Verify:** ✅ `pnpm --filter @bittery/core check-types` and `pnpm --filter @bittery/hooks check-types` passed.  
**Pending manual smoke test:** create/edit/delete item in web app.

---

## Phase 6: VaultService + ShareService

**Status:** ✅ Completed

**Goal:** Extract vault CRUD and share link creation.

**Extracts from:**
- `use-create-vault.ts` — vault key generation, MUK encryption, image upload, API call
- `use-update-vault.ts` — vault metadata update
- `use-delete-vault.ts` — vault deletion
- `utils/vault-utils.ts` — `refreshVaultKeys()`
- `use-create-share.ts` — share key generation, item sanitization, encryption

**Steps:**
1. Create `packages/core/src/services/vault-service.ts`:
   - `createVault(input, client)` — generate key, encrypt with MUK, handle image upload, call API
   - `updateVault(input, client)` — update metadata
   - `deleteVault(vaultId, client)` — delete
   - `refreshVaultKeys(client, accountEmail?)` — sync vault keys to storage
2. Create `packages/core/src/services/share-service.ts`:
   - `createShare(input, vaultKey, client)` — generate share key, sanitize, encrypt, call API
   - `buildShareUrl(result)` — construct share URL
3. Wire both into `createCoreContext`
4. Migrate vault hooks and share hook

**Files created:**
- `packages/core/src/services/vault-service.ts`
- `packages/core/src/services/share-service.ts`

**Files modified:**
- `packages/core/src/core-context.ts` — add `vaults` and `shares` services
- `packages/core/src/index.ts` — export both
- `packages/hooks/src/hooks/vault/use-create-vault.ts` — delegate
- `packages/hooks/src/hooks/vault/use-update-vault.ts` — delegate
- `packages/hooks/src/hooks/vault/use-delete-vault.ts` — delegate
- `packages/hooks/src/hooks/share/use-create-share.ts` — delegate
- `packages/hooks/src/utils/vault-utils.ts` — delegate to `VaultService`

**Verify:** ✅ `pnpm --filter @bittery/core check-types` and `pnpm --filter @bittery/hooks check-types` passed.

---

## Phase 7: Extension Service Worker Migration

**Status:** ✅ Completed

**Goal:** Eliminate duplicated business logic from the extension by using `@bittery/core` directly.

**Steps:**
1. Add `@bittery/core` to `apps/extension/package.json`
2. Create `apps/extension/src/background/core-instance.ts`:
   ```ts
   import { createCoreContext } from "@bittery/core";
   export const core = createCoreContext({ storage, crypto: cryptoAdapter });
   ```
3. Rewrite `vault-handlers.ts` to use `core.items.fetchAndDecryptItems()` instead of inline decrypt pipeline
4. Rewrite `credential-handlers.ts` to use `core.items.createItem()` / `core.items.updateItem()` instead of inline encryption
5. Remove duplicated functions from `vault-utils.ts` (keep extension-specific helpers like `hostnameMatches`, `getBaseDomain`)
6. Update `autofill-handlers.ts` to use items from core

**Files created:**
- `apps/extension/src/background/core-instance.ts`

**Files modified:**
- `apps/extension/package.json` — add `@bittery/core` dependency
- `apps/extension/src/background/vault-handlers.ts` — use `core.items`
- `apps/extension/src/background/vault-utils.ts` — remove duplicated decrypt/cache logic
- `apps/extension/src/background/credential-handlers.ts` — use `core.items`
- `apps/extension/src/background/autofill-handlers.ts` — use items from core

**Verify:** ✅ `pnpm --filter extension check-types` passed; ✅ `pnpm run build:extension` passed.  
**Pending manual smoke test:** autofill, save credential, multi-account.

---

## Phase 8 (Optional): Move Auth Utilities to Core

**Status:** ⏳ Not implemented (optional)

**Goal:** Consolidate all framework-agnostic business logic under `@bittery/core`.

**Steps:**
1. Create `packages/core/src/services/auth-service.ts` — move `performSRPLogin`, `performSRPUnlock`, `storeLoginSession`, `storeUnlockSession`, `getSessionState`, `clearSession` from `packages/hooks/src/auth/`
2. Update `packages/hooks/src/auth/index.ts` to re-export from `@bittery/core` (backwards compat)
3. Update extension to import from `@bittery/core` directly

**Files created:**
- `packages/core/src/services/auth-service.ts`

**Files modified:**
- `packages/hooks/src/auth/srp-login.ts` — move to core
- `packages/hooks/src/auth/srp-unlock.ts` — move to core
- `packages/hooks/src/auth/session-utils.ts` — move to core
- `packages/hooks/src/auth/index.ts` — re-export from `@bittery/core`

---

## Architecture Summary

```
@bittery/core (NEW - zero React dependency)
  ├── AccountResolver    ← from useAccountsInfo + account-helper.ts
  ├── ItemService        ← from use-items-unified, use-create-item, etc.
  ├── VaultService       ← from use-create-vault, vault-utils.ts
  ├── ShareService       ← from use-create-share
  └── CacheManager       ← from onSuccess handlers across all mutation hooks

@bittery/hooks (SIMPLIFIED - thin React Query wrappers)
  ├── PlatformProvider   ← creates CoreContext, exposes via useCoreContext()
  ├── useItemsUnified    ← queryFn: () => core.items.fetchAndDecryptItems(...)
  ├── useCreateItem      ← mutationFn: () => core.items.createItem(...)
  └── ...                   (all hooks follow same delegation pattern)

Extension service worker  ← imports createCoreContext directly, no React needed
```

**Dependency graph (no circular deps):**
```
@bittery/core → @bittery/types, @bittery/storage, @bittery/shared
@bittery/hooks → @bittery/core, @bittery/storage, @bittery/shared, react, @tanstack/react-query
apps/* → @bittery/hooks (React apps) OR @bittery/core (service workers)
```

## What Stays in Hooks (NOT extracted)

- Auth hooks (`useLogin`, `useQuickUnlock`, etc.) — already thin wrappers around extracted pure functions
- Search hooks (`useVaultSearch`) — trivial client-side filtering
- Session hooks (`useSessionState`) — thin wrapper around `getSessionState()`
- Account switcher (`useAccountSwitcher`) — React Query orchestration
- `IQueryInvalidator`, `ISyncContext`, `IAutolockService` — React/sync-specific
