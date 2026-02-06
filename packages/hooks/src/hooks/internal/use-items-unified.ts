/**
 * Unified Items Hook
 *
 * Handles both single account and "All Accounts" mode with a unified implementation.
 * Uses useAccountsInfo to get account data, then fetches items from all accounts in parallel.
 * Supports local cache-first reads with server fallback for platforms with item caching.
 */

import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import type { CachedEncryptedItem, CachedVaultMetadata } from "@bittery/types";
import { useQuery } from "@tanstack/react-query";
import {
	usePlatformCrypto,
	usePlatformStorage,
} from "../../context/platform-context";
import type { RawEncryptedItemWithVault } from "../../types";
import { useAccountsInfo } from "./use-accounts-info";

/**
 * Decrypted item with source account metadata (for multi-account mode)
 */
export interface MultiAccountItem extends DecryptedItem {
	/** Raw encrypted data for native credential provider sync */
	_encrypted?: {
		data: string;
		iv: string;
		algorithm: string;
	};
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
}

/**
 * Options for useItemsUnified hook
 */
export interface UseItemsUnifiedOptions {
	/**
	 * Whether to enable the query.
	 */
	enabled?: boolean;
}

/**
 * Build RawEncryptedItemWithVault[] from cached items + vault metadata
 */
function buildRawItemsFromCache(
	cachedItems: CachedEncryptedItem[],
	cachedVaults: CachedVaultMetadata[],
): RawEncryptedItemWithVault[] {
	const vaultMap = new Map<string, CachedVaultMetadata>();
	for (const v of cachedVaults) {
		vaultMap.set(v.id, v);
	}

	return cachedItems
		.filter((item) => !item.deletedAt)
		.map((item) => {
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
}

/**
 * Hook to fetch and decrypt items from active account(s).
 *
 * This unified implementation works for both single account and "All Accounts" mode.
 * In single account mode, fetches from one account.
 * In "All Accounts" mode, fetches from all unlocked accounts in parallel.
 *
 * Supports cache-first reads: if the storage adapter has cached items,
 * reads from cache instead of the server. On cache miss, fetches from server
 * and populates cache for next time.
 */
export function useItemsUnified(options: UseItemsUnifiedOptions = {}) {
	const storage = usePlatformStorage();
	const crypto = usePlatformCrypto();

	// Get all account info using utility hook
	const {
		accountsInfo,
		isLoading: isLoadingAccounts,
		isAllAccountsMode,
	} = useAccountsInfo({ enabled: options.enabled });

	// Fetch and decrypt items from all accounts IN PARALLEL
	const {
		data: items = [],
		isLoading: isLoadingItems,
		error,
		refetch,
	} = useQuery({
		queryKey: ["items-unified", accountsInfo.map((a) => a.email).sort()],
		queryFn: async (): Promise<MultiAccountItem[]> => {
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

							if (cachedItems && cachedVaults && cachedItems.length > 0) {
								// Cache hit - build raw items from cache
								rawItems = buildRawItemsFromCache(cachedItems, cachedVaults);
							} else {
								// Cache miss - fetch from server
								rawItems = await account.trpcClient.vault.listAllItems.query();

								// Populate cache for next time (fire-and-forget)
								const itemsToCache: CachedEncryptedItem[] = rawItems.map(
									(item) => ({
										id: item.id,
										vaultId: item.vaultId,
										category: item.category,
										favorite: item.favorite,
										encryptedData: item.encryptedData,
										encryptionIv: item.encryptionIv,
										encryptionAlgorithm: item.encryptionAlgorithm,
										version: 0,
										lastModifiedBy: null,
										createdAt: String(item.createdAt),
										updatedAt: String(item.updatedAt),
										deletedAt: item.deletedAt ? String(item.deletedAt) : null,
									}),
								);
								const vaultsToCache: CachedVaultMetadata[] = [];
								const seenVaults = new Set<string>();
								for (const item of rawItems) {
									if (!seenVaults.has(item.vault.id)) {
										seenVaults.add(item.vault.id);
										vaultsToCache.push({
											id: item.vault.id,
											name: item.vault.name,
											type: item.vault.type,
											icon: item.vault.icon,
											imageUrl: item.vault.imageUrl,
										});
									}
								}

								storage.setCachedItems?.(itemsToCache, account.email);
								storage.setCachedVaults?.(vaultsToCache, account.email);
							}
						} else {
							// No cache support - fetch from server directly
							rawItems = await account.trpcClient.vault.listAllItems.query();
						}

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
										...parsedData,
										// Include raw encrypted data for native sync
										_encrypted: {
											data: rawItem.encryptedData,
											iv: rawItem.encryptionIv,
											algorithm: rawItem.encryptionAlgorithm,
										},
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
									} as MultiAccountItem;
								} catch (error) {
									console.error(
										`[useItemsUnified] Failed to decrypt item ${rawItem.id} for ${account.email}:`,
										error,
									);
									return null;
								}
							}),
						);

						return decrypted.filter(
							(item): item is MultiAccountItem => item !== null,
						);
					} catch (error) {
						console.error(
							`[useItemsUnified] Failed to fetch items for ${account.email}:`,
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
