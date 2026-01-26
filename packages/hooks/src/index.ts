/**
 * @bittery/hooks
 *
 * Shared React hooks for Bittery applications.
 * Platform-agnostic hooks that work across web, desktop, extension, and mobile.
 *
 * Usage:
 * 1. Wrap your app with PlatformProvider, injecting platform-specific implementations
 * 2. Use the shared hooks anywhere in your component tree
 *
 * ```tsx
 * import { PlatformProvider, useDecryptedItems, useCreateItem } from "@bittery/hooks";
 * import * as crypto from "@/lib/wasm-crypto";
 * import { storage } from "@/lib/storage";
 * import { useSyncContext } from "@/providers/sync-provider";
 *
 * // In app root
 * function AppPlatformProvider({ children }) {
 *   const syncContext = useSyncContext();
 *   const sync = {
 *     clientId: syncContext.clientId,
 *     isConnected: syncContext.isConnected,
 *     isOnline: syncContext.isOnline,
 *     invalidator: syncContext.invalidator,
 *   };
 *
 *   return (
 *     <PlatformProvider storage={storage} crypto={crypto} sync={sync}>
 *       {children}
 *     </PlatformProvider>
 *   );
 * }
 *
 * // In components
 * const { items, isLoading } = useDecryptedItems(vaultId);
 * const createItem = useCreateItem();
 * ```
 */

// Context
export {
	PlatformProvider,
	usePlatform,
	usePlatformStorage,
	usePlatformCrypto,
	usePlatformItemDecrypt,
	usePlatformAutolock,
	usePlatformSync,
	useQueryInvalidator,
	type PlatformContextValue,
	type PlatformProviderProps,
} from "./context/platform-context";

// Data Hooks (read operations)
export { useDecryptedItems } from "./hooks/use-decrypted-items";
export { useDecryptedItem } from "./hooks/use-decrypted-item";
export {
	useAllDecryptedItems,
	type CrossVaultDecryptedItem,
} from "./hooks/use-all-decrypted-items";
export {
	useAllDeletedItems,
	type CrossVaultDeletedItem,
} from "./hooks/use-all-deleted-items";
export { useCrossVaultTags } from "./hooks/use-cross-vault-tags";
export { useAvailableTags, filterItemsByTags } from "./hooks/use-available-tags";
export {
	useVaultSearch,
	useSingleVaultSearch,
	type SearchResult,
	type SingleVaultSearchResult,
} from "./hooks/use-vault-search";
export {
	usePasswordSecurity,
	analyzePassword,
} from "./hooks/use-password-security";

// Vault Mutation Hooks (write operations)
export {
	useCreateVault,
	useUpdateVault,
	useDeleteVault,
	type CreateVaultInput,
	type CreateVaultResult,
	type UpdateVaultInput,
	type DeleteVaultInput,
} from "./hooks/vault";

// Item Mutation Hooks (write operations)
export {
	useCreateItem,
	useUpdateItem,
	useDeleteItem,
	useToggleFavorite,
	useMoveItem,
	useRestoreItem,
	usePermanentDeleteItem,
	type CreateItemInput,
	type CreateItemResult,
	type UpdateItemInput,
	type DeleteItemInput,
	type ToggleFavoriteInput,
	type MoveItemInput,
	type RestoreItemInput,
	type PermanentDeleteItemInput,
} from "./hooks/items";

// Share Mutation Hooks (write operations)
export {
	useCreateShare,
	type CreateShareInput,
	type CreateShareResult,
	type ShareExpirationOption,
	type ShareAccessMode,
} from "./hooks/share";

// Utilities
export { refreshVaultKeys } from "./utils/vault-utils";

// Types
export type {
	ICrypto,
	IQueryInvalidator,
	ISyncContext,
	IItemDecrypt,
	IAutolockService,
} from "./types";

// Services (platform-specific autolock implementations)
export {
	createWebAutolockService,
	createMobileAutolockService,
	type MobileAutolockOptions,
} from "./services";
