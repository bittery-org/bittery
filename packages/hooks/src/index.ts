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
 * import { PlatformProvider, useDecryptedItems, useAllDecryptedItems } from "@bittery/hooks";
 * import { storage } from "@/lib/storage";
 * import { itemDecrypt } from "@/lib/crypto";
 *
 * // In app root
 * <PlatformProvider storage={storage} itemDecrypt={itemDecrypt}>
 *   <App />
 * </PlatformProvider>
 *
 * // In components
 * const { items, isLoading } = useDecryptedItems(vaultId);
 * ```
 */

// Context
export {
	PlatformProvider,
	usePlatform,
	usePlatformStorage,
	usePlatformItemDecrypt,
	usePlatformAutolock,
	type PlatformContextValue,
	type PlatformProviderProps,
} from "./context/platform-context";

// Hooks
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

// Types
export type { IItemDecrypt, IAutolockService } from "./types";

// Services (platform-specific autolock implementations)
export {
	createWebAutolockService,
	createMobileAutolockService,
	type MobileAutolockOptions,
} from "./services";
