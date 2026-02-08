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
 * import { PlatformProvider, useVaultItems, useCreateItem } from "@bittery/hooks";
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
 * const { items, isLoading } = useVaultItems(vaultId);
 * const createItem = useCreateItem();
 * ```
 */

export type { ActiveAccount } from "@bittery/storage/types";
// Auth Utilities (for extension service worker - non-React usage)
export {
	type CheckEmailResult,
	checkEmailExists,
	clearSession,
	getSessionState,
	type IAuthTRPCClient,
	type LoginResult,
	type LoginUserData,
	performSRPLogin,
	performSRPUnlock,
	type SessionState,
	type SRPLoginDeps,
	type SRPLoginInput,
	type SRPUnlockDeps,
	type SRPUnlockInput,
	storeLoginSession,
	storeUnlockSession,
	type UnlockResult,
} from "./auth";
// Context
export {
	type PlatformContextValue,
	PlatformProvider,
	type PlatformProviderProps,
	useCoreContext,
	usePlatform,
	usePlatformAutolock,
	usePlatformCrypto,
	usePlatformItemDecrypt,
	usePlatformStorage,
	usePlatformSync,
	useQueryInvalidator,
} from "./context/platform-context";
// Auth Hooks (React Query wrappers for login/unlock)
export {
	type BiometricUnlockError,
	type BiometricUnlockInput,
	type BiometricUnlockResult,
	type LoginInput,
	type LogoutInput,
	type QuickUnlockAllInput,
	type QuickUnlockAllResult,
	type QuickUnlockInput,
	type UseAccountSwitcherOptions,
	type UseAccountSwitcherResult,
	type UseBiometricUnlockOptions,
	type UseCheckEmailOptions,
	type UseLoginOptions,
	type UseLogoutOptions,
	type UseQuickUnlockAllOptions,
	type UseQuickUnlockOptions,
	type UseSessionStateOptions,
	useAccountSwitcher,
	useBiometricUnlock,
	useCheckEmail,
	useLock,
	useLogin,
	useLogout,
	useQuickUnlock,
	useQuickUnlockAll,
	useSessionState,
} from "./hooks/auth";
export {
	type UseAccountMetadataSyncOptions,
	useAccountMetadataSync,
	useAccountMetadataSyncAll,
} from "./hooks/auth/use-account-metadata-sync";
// Data Hooks (read operations)
export {
	type AccountInfo,
	type UseAccountsInfoOptions,
	useAccountsInfo,
} from "./hooks/use-accounts-info";
export {
	type UseAllVaultKeysOptions,
	useAllVaultKeys,
	type VaultKeyWithAccount,
} from "./hooks/use-all-vault-keys";
export {
	type DeletedItem,
	type UseDeletedItemsOptions,
	useDeletedItems,
} from "./hooks/use-deleted-items";
export {
	filterItemsByTags,
	useAvailableTags,
} from "./hooks/use-available-tags";
export { useCrossVaultTags } from "./hooks/use-cross-vault-tags";
export { type UseItemResult, useItem } from "./hooks/use-item";
export {
	type UseVaultInfoOptions,
	useVaultInfo,
	type VaultInfoWithAccount,
} from "./hooks/use-vault-info";
export {
	type UseVaultItemsOptions,
	useVaultItems,
} from "./hooks/use-vault-items";
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
	buildShareUrl,
	type CreateShareInput,
	type CreateShareResult,
	type ShareAccessMode,
	type ShareExpirationOption,
	useCreateShare,
} from "./hooks/share";
// Team Mutation Hooks (write operations)
export { useTeamAvatar } from "./hooks/team/use-team-avatar";
// Unified Data Hooks (automatically handle single-account vs "All Accounts" mode)
export {
	type UnifiedItem,
	type UseItemsUnifiedOptions,
	type UseItemsOptions,
	useItems,
	useItemsUnified,
} from "./hooks/use-items";
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
	DerivedKeys,
	IAutolockService,
	ICrypto,
	IItemDecrypt,
	IQueryInvalidator,
	ISyncContext,
	SRPClientEphemeral,
	SRPClientSession,
	SRPServerChallenge,
} from "./types";
export {
	findAccountEmailForItem,
	getItemAccountEmail,
} from "./utils/account-helper";
// Utilities
export { refreshVaultKeys } from "./utils/vault-utils";
