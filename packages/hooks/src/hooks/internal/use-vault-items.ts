/**
 * useVaultItems Hook - Simplified Vault-Specific Item Fetching
 *
 * Fetches and decrypts items from a specific vault.
 * Uses useAccountsInfo to automatically handle single-account vs multi-account mode.
 */

import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import {
	usePlatformCrypto,
	usePlatformStorage,
} from "../../context/platform-context";
import type { RawEncryptedItem } from "../../types";
import { useAccountsInfo } from "./use-accounts-info";

export interface UseVaultItemsOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch and decrypt items from a specific vault.
 * Automatically handles single-account vs "All Accounts" mode.
 *
 * @param vaultId - The ID of the vault to fetch items from
 * @param options - Query options
 * @returns Items, loading state, error, and refetch function
 *
 * @example
 * ```tsx
 * const { items, isLoading } = useVaultItems(vaultId);
 *
 * items.map(item => (
 *   <ItemRow key={item.id} item={item} />
 * ))
 * ```
 */
export function useVaultItems(
	vaultId: string,
	options: UseVaultItemsOptions = {},
) {
	const storage = usePlatformStorage();
	const crypto = usePlatformCrypto();

	// Get account info (handles both single and multi-account mode)
	const {
		accountsInfo,
		isLoading: isLoadingAccounts,
		isAllAccountsMode,
	} = useAccountsInfo({ enabled: options.enabled });

	// Fetch and decrypt items from the vault
	const {
		data: items = [],
		isLoading: isLoadingItems,
		error,
		refetch,
	} = useQuery({
		queryKey: ["vault-items", vaultId, accountsInfo.map((a) => a.email).sort()],
		queryFn: async (): Promise<DecryptedItem[]> => {
			if (!vaultId || accountsInfo.length === 0) return [];

			// Find which account has this vault by checking vault keys
			let ownerAccount = null;
			for (const account of accountsInfo) {
				const vaultKeys = await storage.getVaultKeys(account.email);
				if (vaultKeys?.some((vk) => vk.vaultId === vaultId)) {
					ownerAccount = account;
					break;
				}
			}

			if (!ownerAccount) {
				throw new Error(`No account found with access to vault ${vaultId}`);
			}

			let rawItems: RawEncryptedItem[];

			// Try cache-first if supported
			if (storage.supportsItemCache) {
				const cachedItems = await storage.getCachedItems?.(ownerAccount.email);
				if (cachedItems && cachedItems.length > 0) {
					// Filter cached items for this vault (exclude deleted)
					const vaultItems = cachedItems.filter(
						(i) => i.vaultId === vaultId && !i.deletedAt,
					);
					if (vaultItems.length > 0) {
						rawItems = vaultItems.map((item) => ({
							id: item.id,
							vaultId: item.vaultId,
							category: item.category,
							favorite: item.favorite,
							encryptedData: item.encryptedData,
							encryptionIv: item.encryptionIv,
							encryptionAlgorithm: item.encryptionAlgorithm,
							createdAt: item.createdAt,
							updatedAt: item.updatedAt,
						}));
					} else {
						rawItems = await ownerAccount.trpcClient.vault.listItems.query({
							vaultId,
						});
					}
				} else {
					rawItems = await ownerAccount.trpcClient.vault.listItems.query({
						vaultId,
					});
				}
			} else {
				rawItems = await ownerAccount.trpcClient.vault.listItems.query({
					vaultId,
				});
			}

			if (rawItems.length === 0) return [];

			// Get vault key for decryption
			const vaultKey = await storage.getDecryptedVaultKey(
				vaultId,
				ownerAccount.email,
			);

			if (!vaultKey) {
				throw new Error(`No vault key found for vault ${vaultId}`);
			}

			// Decrypt all items in parallel
			const decrypted = await Promise.all(
				rawItems.map(async (item) => {
					try {
						const decryptedData = await crypto.decrypt(
							{
								ciphertext: item.encryptedData,
								iv: item.encryptionIv,
								algorithm: item.encryptionAlgorithm,
							},
							vaultKey,
						);

						const parsedData = JSON.parse(decryptedData);

						return {
							id: item.id,
							vaultId: item.vaultId,
							category: item.category as ItemCategory,
							favorite: item.favorite,
							createdAt: item.createdAt,
							updatedAt: item.updatedAt,
							...parsedData,
						} as DecryptedItem;
					} catch (error) {
						console.error(
							`[useVaultItems] Failed to decrypt item ${item.id}:`,
							error,
						);
						// Return a placeholder for failed items
						return {
							id: item.id,
							vaultId: item.vaultId,
							category: item.category as ItemCategory,
							favorite: item.favorite,
							createdAt: item.createdAt,
							updatedAt: item.updatedAt,
							title: "[Decryption Failed]",
						} as DecryptedItem;
					}
				}),
			);

			return decrypted;
		},
		enabled: !!vaultId && accountsInfo.length > 0 && options.enabled !== false,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});

	return {
		items,
		isLoading: isLoadingAccounts || isLoadingItems,
		error,
		refetch,
		isAllAccountsMode,
	};
}
