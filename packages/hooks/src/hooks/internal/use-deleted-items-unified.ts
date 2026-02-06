/**
 * Unified Deleted Items Hook
 *
 * Handles both single account and "All Accounts" mode with a unified implementation.
 * Uses useAccountsInfo to get account data, then fetches deleted items from all accounts in parallel.
 */

import type { ItemCategory } from "@bittery/shared/types";
import type { CachedVaultMetadata } from "@bittery/types";
import { useQuery } from "@tanstack/react-query";
import {
	usePlatformCrypto,
	usePlatformStorage,
} from "../../context/platform-context";
import type { RawEncryptedItemWithVault } from "../../types";
import { useAccountsInfo } from "./use-accounts-info";

/**
 * Deleted item with source account metadata (for multi-account mode)
 */
export interface MultiAccountDeletedItem {
	id: string;
	vaultId: string;
	category: ItemCategory;
	favorite: boolean;
	createdAt: Date;
	updatedAt: Date;
	deletedAt: Date;
	title: string;
	vault: {
		id: string;
		name: string;
		type: string;
		icon: string | null;
		imageUrl: string | null;
	};
	account?: {
		email: string;
		userId: string;
		name: string;
	};
	// Encrypted data fields
	[key: string]: any;
}

/**
 * Options for useDeletedItemsUnified hook
 */
export interface UseDeletedItemsUnifiedOptions {
	/**
	 * Whether to enable the query.
	 */
	enabled?: boolean;
}

/**
 * Hook to fetch and decrypt deleted items from active account(s).
 *
 * This unified implementation works for both single account and "All Accounts" mode.
 * In single account mode, fetches from one account.
 * In "All Accounts" mode, fetches from all unlocked accounts in parallel.
 *
 * @param options - Query options
 * @returns Object containing all deleted items, loading state, and error
 *
 * @example
 * ```tsx
 * const { items, isLoading, isAllAccountsMode } = useDeletedItemsUnified();
 *
 * // Display unified deleted items list
 * items.map(item => (
 *   <DeletedItemCard
 *     key={item.id}
 *     item={item}
 *     accountEmail={item.account?.email}
 *     vaultName={item.vault.name}
 *   />
 * ))
 * ```
 */
export function useDeletedItemsUnified(
	options: UseDeletedItemsUnifiedOptions = {},
) {
	const storage = usePlatformStorage();
	const crypto = usePlatformCrypto();

	// Get all account info using utility hook
	const {
		accountsInfo,
		isLoading: isLoadingAccounts,
		isAllAccountsMode,
	} = useAccountsInfo({ enabled: options.enabled });

	// Fetch and decrypt deleted items from all accounts IN PARALLEL
	const {
		data: items = [],
		isLoading: isLoadingItems,
		error,
		refetch,
	} = useQuery({
		queryKey: [
			"deleted-items-unified",
			accountsInfo.map((a) => a.email).sort(),
		],
		queryFn: async (): Promise<MultiAccountDeletedItem[]> => {
			if (accountsInfo.length === 0) return [];

			// Fetch from all accounts in parallel (not waterfall!)
			const results = await Promise.all(
				accountsInfo.map(async (account) => {
					try {
						let rawItems: RawEncryptedItemWithVault[];

						// Try cache-first if supported
						if (storage.supportsItemCache) {
							const [cachedItems, cachedVaults] = await Promise.all([
								storage.getCachedItems?.(account.email),
								storage.getCachedVaults?.(account.email),
							]);

							if (cachedItems && cachedVaults) {
								// Filter for deleted items only
								const deletedItems = cachedItems.filter((i) => i.deletedAt);
								if (deletedItems.length > 0) {
									const vaultMap = new Map<string, CachedVaultMetadata>();
									for (const v of cachedVaults) {
										vaultMap.set(v.id, v);
									}
									rawItems = deletedItems.map((item) => {
										const vault = vaultMap.get(item.vaultId);
										return {
											id: item.id,
											vaultId: item.vaultId,
											category: item.category,
											favorite: item.favorite,
											encryptedData: item.encryptedData,
											encryptionIv: item.encryptionIv,
											encryptionAlgorithm: item.encryptionAlgorithm,
											createdAt: item.createdAt,
											updatedAt: item.updatedAt,
											deletedAt: item.deletedAt,
											vault: vault
												? {
														id: vault.id,
														name: vault.name,
														type: vault.type,
														icon: vault.icon,
														imageUrl: vault.imageUrl,
													}
												: {
														id: item.vaultId,
														name: "Unknown",
														type: "personal",
														icon: null,
														imageUrl: null,
													},
										} as RawEncryptedItemWithVault;
									});
								} else {
									// No deleted items in cache - try server
									rawItems =
										await account.trpcClient.vault.listAllDeletedItems.query();
								}
							} else {
								rawItems =
									await account.trpcClient.vault.listAllDeletedItems.query();
							}
						} else {
							rawItems =
								await account.trpcClient.vault.listAllDeletedItems.query();
						}

						// Original fetch (kept as reference for the decryption logic below)
						// const rawItems = await account.trpcClient.vault.listAllDeletedItems.query();

						// Decrypt items with vault keys cached per account
						const vaultKeyCache = new Map<string, Uint8Array>();

						const decrypted = await Promise.all(
							rawItems.map(async (rawItem: RawEncryptedItemWithVault) => {
								try {
									// Get or cache vault key
									let vaultKey: Uint8Array | null | undefined =
										vaultKeyCache.get(rawItem.vaultId);
									if (!vaultKey) {
										vaultKey = await storage.getDecryptedVaultKey(
											rawItem.vaultId,
											account.email,
										);
										if (vaultKey) vaultKeyCache.set(rawItem.vaultId, vaultKey);
									}

									if (!vaultKey) {
										throw new Error(
											`No vault key for vault ${rawItem.vaultId}`,
										);
									}

									// Decrypt
									const decryptedData = await crypto.decrypt(
										{
											ciphertext: rawItem.encryptedData,
											iv: rawItem.encryptionIv,
											algorithm: rawItem.encryptionAlgorithm,
										},
										vaultKey,
									);

									const parsedData = JSON.parse(decryptedData);

									return {
										id: rawItem.id,
										vaultId: rawItem.vaultId,
										category: rawItem.category as ItemCategory,
										favorite: rawItem.favorite,
										createdAt: rawItem.createdAt,
										updatedAt: rawItem.updatedAt,
										deletedAt: rawItem.deletedAt,
										...parsedData,
										vault: {
											id: rawItem.vault.id,
											name: rawItem.vault.name,
											type: rawItem.vault.type,
											icon: rawItem.vault.icon,
											imageUrl: rawItem.vault.imageUrl,
										},
										// Only include account info if in multi-account mode
										...(isAllAccountsMode
											? {
													account: {
														email: account.email,
														userId: account.userId,
														name: account.name,
													},
												}
											: {}),
									} as MultiAccountDeletedItem;
								} catch (error) {
									console.error(
										`[useDeletedItemsUnified] Failed to decrypt item ${rawItem.id} for ${account.email}:`,
										error,
									);
									return null;
								}
							}),
						);

						return decrypted.filter(
							(item): item is MultiAccountDeletedItem => item !== null,
						);
					} catch (error) {
						console.error(
							`[useDeletedItemsUnified] Failed to fetch deleted items for ${account.email}:`,
							error,
						);
						return [];
					}
				}),
			);

			// Flatten results from all accounts
			return results.flat();
		},
		enabled: accountsInfo.length > 0 && options.enabled !== false,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});

	return {
		items,
		isLoading: isLoadingAccounts || isLoadingItems,
		error,
		refetch,
		isAllAccountsMode,
		// For backwards compatibility, include account metadata
		unlockedAccounts: accountsInfo,
	};
}
