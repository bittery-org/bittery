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

import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import type { AccountMetadata } from "@bittery/storage/types";
import { useQuery } from "@tanstack/react-query";
import {
	usePlatformCrypto,
	usePlatformStorage,
} from "../../context/platform-context";
import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import type { RawEncryptedItemWithVault } from "../../types";

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

	// Fetch and decrypt items from all unlocked accounts
	// Uses per-account tRPC clients to fetch each account's data with their JWT
	const {
		data: items = [],
		isLoading: isLoadingItems,
		error,
		refetch,
	} = useQuery({
		queryKey: ["all-accounts-items", unlockedEmails],
		queryFn: async (): Promise<MultiAccountItem[]> => {
			// Get all unlocked accounts
			if (!unlockedEmails || unlockedEmails.length === 0) return [];

			// For each account, fetch items with that account's JWT
			const allAccountItems = await Promise.all(
				unlockedEmails.map(async (email) => {
					try {
						// Get account's JWT token
						const authToken = await storage.getAuthToken(email);
						if (!authToken) {
							console.warn(
								`[useAllAccountsItems] No auth token for ${email}`,
							);
							return [];
						}

						// Get account metadata
						const metadata = accountMetadata.find((m) => m.email === email);
						if (!metadata) {
							console.warn(
								`[useAllAccountsItems] No metadata found for ${email}`,
							);
							return [];
						}

						// Get server URL
						const serverUrl = await storage.getServerUrl(email);

						
						const accountClient = createAccountTrpcClient(
							authToken,
							serverUrl || "http://localhost:3000",
						);

						console.log(authToken);
						

						// Fetch all items for this account
						const rawItems = await accountClient.vault.listAllItems.query();

						// Cache decrypted vault keys for this account
						const vaultKeyCache = new Map<string, Uint8Array>();

						// Helper to get or decrypt vault key
						const getVaultKey = async (
							vaultId: string,
						): Promise<Uint8Array> => {
							const cached = vaultKeyCache.get(vaultId);
							if (cached) return cached;

							const vaultKey = await storage.getDecryptedVaultKey(
								vaultId,
								email,
							);
							if (!vaultKey) {
								throw new Error(
									`No vault key found for vault ${vaultId} in account ${email}`,
								);
							}
							vaultKeyCache.set(vaultId, vaultKey);
							return vaultKey;
						};

						// Decrypt items with this account's MUK
						const decryptedItems = await Promise.all(
							rawItems.map(async (rawItem: RawEncryptedItemWithVault) => {
								try {
									// Get decrypted vault key for this vault + account
									const vaultKey = await getVaultKey(rawItem.vaultId);

									// Decrypt item data
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
											email: metadata.email,
											userId: metadata.userId,
											name: metadata.name,
										},
									} as MultiAccountItem;
								} catch (error) {
									console.error(
										`[useAllAccountsItems] Failed to decrypt item ${rawItem.id} for ${email}:`,
										error,
									);
									return null;
								}
							}),
						);

						return decryptedItems.filter(
							(item): item is MultiAccountItem => item !== null,
						);
					} catch (error) {
						console.error(
							`[useAllAccountsItems] Failed to fetch items for ${email}:`,
							error,
						);
						return [];
					}
				}),
			);

			// Flatten and merge all items
			return allAccountItems.flat();
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
			isLoadingUnlocked || isLoadingMetadata || isLoadingItems,
		error,
		refetch,
	};
}
