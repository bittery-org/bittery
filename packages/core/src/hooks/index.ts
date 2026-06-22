/**
 * @bittery/core/hooks
 *
 * Shared React hooks for Bittery applications.
 * Platform-agnostic hooks that work across web, desktop, extension, and mobile.
 *
 * Usage:
 * 1. Wrap your app with PlatformProvider, injecting platform-specific implementations
 * 2. Use the shared hooks anywhere in your component tree
 *
 * ```tsx
 * import { PlatformProvider, useVaultItems, useCreateItem } from "@bittery/core/hooks";
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
	type IAuthClient,
	type LoginResult,
	type LoginUserData,
	performSRPLogin,
	performSRPUnlock,
	type SessionState,
	type SRPLoginDeps,
	type SRPLoginInput,
	type SRPUnlockDeps,
	type SRPUnlockInput,
	type StoreAuthSessionOptions,
	storeLoginSession,
	storeUnlockSession,
	type UnlockResult,
} from "../auth";
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
} from "../context/platform-context";
// Services (platform-specific autolock implementations)
export {
	createMobileAutolockService,
	createWebAutolockService,
	type MobileAutolockOptions,
} from "../services/autolock";
export {
	findAccountEmailForItem,
	getItemAccountEmail,
} from "../utils/account-helper";
// Utilities
export { refreshVaultKeys } from "../utils/vault-utils";
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
} from "./auth";
export {
	type UseAccountMetadataSyncOptions,
	useAccountMetadataSync,
	useAccountMetadataSyncAll,
} from "./auth/use-account-metadata-sync";
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
} from "./items";
// Share Mutation Hooks (write operations)
export {
	buildShareUrl,
	type CreateShareInput,
	type CreateShareResult,
	type ShareAccessMode,
	type ShareExpirationOption,
	useCreateShare,
} from "./share";
// Team Mutation Hooks (write operations)
export {
	TeamAvatarError,
	type TeamAvatarErrorCode,
	useTeamAvatar,
} from "./team/use-team-avatar";
// Data Hooks (read operations)
export {
	type AccountInfo,
	type UseAccountsInfoOptions,
	useAccountsInfo,
} from "./use-accounts-info";
export {
	type UseAllVaultKeysOptions,
	useAllVaultKeys,
	type VaultKeyWithAccount,
} from "./use-all-vault-keys";
export {
	filterItemsByTags,
	useAvailableTags,
} from "./use-available-tags";
export { useCrossVaultTags } from "./use-cross-vault-tags";
export {
	type DeletedItem,
	type UseDeletedItemsOptions,
	useDeletedItems,
} from "./use-deleted-items";
export { type UseItemResult, useItem } from "./use-item";
export {
	type AttachmentMeta,
	type AttachmentUploadErrorCode,
	type DecryptedAttachment,
	type FileInput,
	getAttachmentUploadErrorCode,
	useItemAttachments,
} from "./use-item-attachments";
export {
	type ItemListCategoryFilter,
	type ItemListFilterable,
	type ItemListSortDirection,
	type ItemListSortField,
	useItemListFilters,
} from "./use-item-list-filters";
// Unified Data Hooks (automatically handle single-account vs "All Accounts" mode)
export {
	type UnifiedItem,
	type UseItemsOptions,
	type UseItemsUnifiedOptions,
	useItems,
	useItemsUnified,
} from "./use-items";
export { useTravelMode } from "./use-travel-mode";
export {
	type UseVaultInfoOptions,
	useVaultInfo,
	type VaultInfoWithAccount,
} from "./use-vault-info";
export {
	type UseVaultItemsOptions,
	useVaultItems,
} from "./use-vault-items";
export {
	type SearchResult,
	type SingleVaultSearchResult,
	useSingleVaultSearch,
	useVaultSearch,
} from "./use-vault-search";
// Vault Mutation Hooks (write operations)
export {
	type ConvertVaultTypeInput,
	type ConvertVaultTypeResult,
	type CreateVaultInput,
	type CreateVaultResult,
	type DeleteVaultInput,
	type UpdateVaultInput,
	useConvertVaultType,
	useCreateVault,
	useDeleteVault,
	useUpdateVault,
} from "./vault";
