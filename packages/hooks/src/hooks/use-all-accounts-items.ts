/**
 * useAllAccountsItems Hook
 *
 * For multi-account platforms: fetches and combines items from all unlocked accounts.
 * This hook manages switching between accounts to fetch their data and merges results.
 *
 * Note: This is more complex than useAllDecryptedItems because it needs to:
 * 1. Get list of unlocked accounts
 * 2. For each account, switch context and fetch items
 * 3. Merge items with source account metadata
 */

import { useTRPC } from "@bittery/shared/trpc";
import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import type { AccountMetadata } from "@bittery/storage/types";
import { useQuery } from "@tanstack/react-query";
import {
	usePlatformCrypto,
	usePlatformStorage,
} from "../context/platform-context";
import type { RawEncryptedItemWithVault } from "../types";

/**
 * Decrypted item with source account metadata
 */
export interface MultiAccountItem extends DecryptedItem {
	vault: {
		id: string;
		name: string;
		type: string;
		icon: string | null;
		imageUrl: string | null;
	};
	account: {
		email: string;
		userId: string;
		name: string;
	};
}

/**
 * Options for useAllAccountsItems hook
 */
export interface UseAllAccountsItemsOptions {
	/**
	 * Whether to enable the query.
	 */
	enabled?: boolean;

	/**
	 * Specific accounts to include. If not provided, uses all unlocked accounts.
	 */
	accountEmails?: string[];
}

/**
 * Hook to fetch and decrypt items from all unlocked accounts.
 *
 * This is designed for multi-account platforms (desktop, mobile, extension).
 * It will fetch items from each unlocked account and merge them into a unified list.
 *
 * @param options - Query options
 * @returns Object containing all items across accounts, loading state, and error
 *
 * @example
 * ```tsx
 * const { items, isLoading, unlockedAccounts } = useAllAccountsItems();
 *
 * // Display unified item list
 * items.map(item => (
 *   <ItemCard
 *     key={item.id}
 *     item={item}
 *     accountEmail={item.account.email}
 *     vaultName={item.vault.name}
 *   />
 * ))
 * ```
 */
export function useAllAccountsItems(options: UseAllAccountsItemsOptions = {}) {
	const trpc = useTRPC();
	const storage = usePlatformStorage();
	const crypto = usePlatformCrypto();

	// Get list of unlocked accounts
	const { data: unlockedEmails = [], isLoading: isLoadingUnlocked } = useQuery({
		queryKey: ["accounts", "unlocked"],
		queryFn: async () => {
			if (storage.getUnlockedAccounts) {
				return storage.getUnlockedAccounts();
			}
			// Fallback: if adapter doesn't support getUnlockedAccounts, assume single account
			const activeEmail = await storage.getActiveAccountEmail();
			return activeEmail ? [activeEmail] : [];
		},
		enabled: options.enabled !== false && storage.supportsMultiAccount,
		staleTime: 5 * 1000,
	});

	// Get account metadata for unlocked accounts
	const { data: accountMetadata = [], isLoading: isLoadingMetadata } = useQuery(
		{
			queryKey: ["accounts", "metadata", unlockedEmails],
			queryFn: async (): Promise<AccountMetadata[]> => {
				if (!storage.getAccountMetadata) return [];

				const metadata = await Promise.all(
					unlockedEmails.map(async (email) => {
						const meta = await storage.getAccountMetadata?.(email);
						return meta;
					}),
				);

				return metadata.filter((m): m is AccountMetadata => m !== null);
			},
			enabled: unlockedEmails.length > 0,
			staleTime: 30 * 1000,
		},
	);

	// Fetch raw encrypted items from API (all vaults in one query)
	const {
		data: rawItems = [],
		isLoading: isLoadingRaw,
		dataUpdatedAt,
	} = useQuery({
		...trpc.vault.listAllItems.queryOptions(),
		enabled: options.enabled !== false,
	});

	// Fetch and decrypt items from all unlocked accounts
	// Note: This is a simplified implementation that fetches from the active account only
	// A full implementation would need to switch between accounts to fetch their data
	const {
		data: items = [],
		isLoading: isLoadingItems,
		error,
		refetch,
	} = useQuery({
		queryKey: ["all-accounts-items", unlockedEmails, dataUpdatedAt],
		queryFn: async (): Promise<MultiAccountItem[]> => {
			// For now, we fetch items from the currently active account only
			// A full implementation would require:
			// 1. Storing JWT tokens for each account
			// 2. Making separate API calls with each account's token
			// 3. Decrypting with each account's MUK
			// This is a TODO for future enhancement

			const currentEmail = await storage.getActiveAccountEmail();
			if (!currentEmail) return [];

			const accountMeta = accountMetadata.find((a) => a.email === currentEmail);
			if (!accountMeta) return [];

			if (rawItems.length === 0) return [];

			// Cache decrypted vault keys
			const vaultKeyCache = new Map<string, Uint8Array>();

			// Helper to get or decrypt vault key
			const getVaultKey = async (vaultId: string): Promise<Uint8Array> => {
				const cached = vaultKeyCache.get(vaultId);
				if (cached) return cached;

				const vaultKey = await storage.getDecryptedVaultKey(
					vaultId,
					currentEmail,
				);
				if (!vaultKey) {
					throw new Error(`No vault key found for vault ${vaultId}`);
				}
				vaultKeyCache.set(vaultId, vaultKey);
				return vaultKey;
			};

			// Decrypt items
			const decrypted = await Promise.all(
				rawItems.map(async (rawItem: RawEncryptedItemWithVault) => {
					try {
						const vaultKey = await getVaultKey(rawItem.vaultId);

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
							vault: {
								id: rawItem.vault.id,
								name: rawItem.vault.name,
								type: rawItem.vault.type,
								icon: rawItem.vault.icon,
								imageUrl: rawItem.vault.imageUrl,
							},
							account: {
								email: accountMeta.email,
								userId: accountMeta.userId,
								name: accountMeta.name,
							},
						} as MultiAccountItem;
					} catch (error) {
						console.error(`Failed to decrypt item ${rawItem.id}:`, error);
						return {
							id: rawItem.id,
							vaultId: rawItem.vaultId,
							category: rawItem.category as ItemCategory,
							favorite: rawItem.favorite,
							createdAt: rawItem.createdAt,
							updatedAt: rawItem.updatedAt,
							title: "[Decryption Failed]",
							vault: {
								id: rawItem.vault.id,
								name: rawItem.vault.name,
								type: rawItem.vault.type,
								icon: rawItem.vault.icon,
								imageUrl: rawItem.vault.imageUrl,
							},
							account: {
								email: accountMeta.email,
								userId: accountMeta.userId,
								name: accountMeta.name,
							},
						} as MultiAccountItem;
					}
				}),
			);

			return decrypted;
		},
		enabled:
			options.enabled !== false &&
			unlockedEmails.length > 0 &&
			accountMetadata.length > 0,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});

	return {
		items,
		unlockedAccounts: accountMetadata,
		isLoading:
			isLoadingUnlocked || isLoadingMetadata || isLoadingRaw || isLoadingItems,
		error,
		refetch,
	};
}
