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
	type PlatformContextValue,
	PlatformProvider,
	type PlatformProviderProps,
	usePlatform,
	usePlatformAutolock,
	usePlatformCrypto,
	usePlatformItemDecrypt,
	usePlatformStorage,
	usePlatformSync,
	useQueryInvalidator,
} from "./context/platform-context";
// Item Mutation Hooks (write operations)
export {
	type CreateItemInput,
	type CreateItemResult,
	type DeleteItemInput,
	type MoveItemInput,
	type PermanentDeleteItemInput,
	type RestoreItemInput,
	type ToggleFavoriteInput,
	type UpdateItemInput,
	useCreateItem,
	useDeleteItem,
	useMoveItem,
	usePermanentDeleteItem,
	useRestoreItem,
	useToggleFavorite,
	useUpdateItem,
} from "./hooks/items";
// Share Mutation Hooks (write operations)
export {
	type CreateShareInput,
	type CreateShareResult,
	type ShareAccessMode,
	type ShareExpirationOption,
	useCreateShare,
} from "./hooks/share";
export {
	type CrossVaultDecryptedItem,
	useAllDecryptedItems,
} from "./hooks/use-all-decrypted-items";
export {
	type CrossVaultDeletedItem,
	useAllDeletedItems,
} from "./hooks/use-all-deleted-items";
export {
	filterItemsByTags,
	useAvailableTags,
} from "./hooks/use-available-tags";
export { useCrossVaultTags } from "./hooks/use-cross-vault-tags";
export { useDecryptedItem } from "./hooks/use-decrypted-item";
// Data Hooks (read operations)
export { useDecryptedItems } from "./hooks/use-decrypted-items";
export {
	analyzePassword,
	usePasswordSecurity,
} from "./hooks/use-password-security";
export {
	type SearchResult,
	type SingleVaultSearchResult,
	useSingleVaultSearch,
	useVaultSearch,
} from "./hooks/use-vault-search";
// Vault Mutation Hooks (write operations)
export {
	type CreateVaultInput,
	type CreateVaultResult,
	type DeleteVaultInput,
	type UpdateVaultInput,
	useCreateVault,
	useDeleteVault,
	useUpdateVault,
} from "./hooks/vault";
// Services (platform-specific autolock implementations)
export {
	createMobileAutolockService,
	createWebAutolockService,
	type MobileAutolockOptions,
} from "./services";

// Types
export type {
	IAutolockService,
	ICrypto,
	IItemDecrypt,
	IQueryInvalidator,
	ISyncContext,
} from "./types";
// Utilities
export { refreshVaultKeys } from "./utils/vault-utils";
