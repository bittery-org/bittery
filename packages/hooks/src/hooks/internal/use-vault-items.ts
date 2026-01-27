/**
 * useVaultItems Hook - Unified Vault-Specific Item Fetching
 *
 * Automatically detects whether we're in single-account or "All Accounts" mode
 * and fetches items from a specific vault accordingly.
 *
 * In single-account mode: uses the standard tRPC call
 * In all-accounts mode: determines which account owns the vault and uses that account's credentials
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import {
	usePlatformCrypto,
	usePlatformStorage,
} from "../../context/platform-context";
import type { RawEncryptedItem } from "../../types";

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
	const trpc = useTRPCClient();

	// Detect current mode
	const { data: activeEmail } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccountEmail(),
		staleTime: 5 * 1000,
		enabled: storage.supportsMultiAccount && options.enabled !== false,
	});

	const isAllAccountsMode = activeEmail === "all";

	// Find which account owns this vault (in all-accounts mode)
	const { data: vaultOwnerEmail } = useQuery({
		queryKey: ["vault-owner", vaultId],
		queryFn: async (): Promise<string | null> => {
			if (!isAllAccountsMode) return null;

			// Get unlocked accounts
			if (!storage.getUnlockedAccounts) return null;
			const unlockedAccounts = await storage.getUnlockedAccounts();
			if (!unlockedAccounts || unlockedAccounts.length === 0) return null;

			// Check each account's vault keys to find the one with this vaultId
			for (const email of unlockedAccounts) {
				const vaultKeys = await storage.getVaultKeys(email);
				if (vaultKeys?.some((vk) => vk.vaultId === vaultId)) {
					return email;
				}
			}

			return null;
		},
		enabled: isAllAccountsMode && !!vaultId && options.enabled !== false,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});

	// Fetch raw encrypted items from API
	// In single-account mode: use standard tRPC
	// In all-accounts mode: use account-specific tRPC client
	const {
		data: rawItems = [],
		isLoading: isLoadingRaw,
		dataUpdatedAt,
		refetch: refetchRaw,
		error: fetchError,
	} = useQuery({
		queryKey: [
			"vault-items-raw",
			vaultId,
			isAllAccountsMode ? vaultOwnerEmail : "single",
		],
		queryFn: async () => {
			if (!vaultId) return [];

			// Single account mode: use standard tRPC
			if (!isAllAccountsMode) {
				return trpc.vault.listItems.query({ vaultId });
			}

			// All accounts mode: use account-specific tRPC client
			if (!vaultOwnerEmail) {
				throw new Error("Could not determine which account owns this vault");
			}

			// Get account's JWT token
			const authToken = await storage.getAuthToken(vaultOwnerEmail);
			if (!authToken) {
				throw new Error(`No auth token for ${vaultOwnerEmail}`);
			}

			// Get server URL
			const serverUrl = await storage.getServerUrl(vaultOwnerEmail);

			// Create account-specific tRPC client
			const accountClient = createAccountTrpcClient(
				authToken,
				serverUrl || "http://localhost:3000",
			);

			return accountClient.vault.listItems.query({ vaultId });
		},
		enabled:
			!!vaultId &&
			options.enabled !== false &&
			(!isAllAccountsMode || !!vaultOwnerEmail),
		staleTime: 30 * 1000, // 30 seconds
	});

	// Decrypt items and cache the result
	const {
		data: decryptedItems = [],
		isLoading: isDecrypting,
		error: decryptError,
	} = useQuery({
		queryKey: [
			"decrypted-items",
			vaultId,
			isAllAccountsMode ? vaultOwnerEmail : "single",
			dataUpdatedAt,
		],
		queryFn: async (): Promise<DecryptedItem[]> => {
			if (rawItems.length === 0) return [];

			// Get vault key for decryption
			// In all-accounts mode, specify which account to use
			const accountEmail = isAllAccountsMode ? vaultOwnerEmail : undefined;
			const vaultKey = await storage.getDecryptedVaultKey(
				vaultId,
				accountEmail || undefined,
			);
			if (!vaultKey) {
				throw new Error("No vault key found for decryption");
			}

			// Decrypt all items in parallel
			const decrypted = await Promise.all(
				rawItems.map(async (item: RawEncryptedItem) => {
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
						console.error(`Failed to decrypt item ${item.id}:`, error);
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
		enabled: rawItems.length > 0 && options.enabled !== false,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});

	return {
		items: decryptedItems,
		isLoading: isLoadingRaw || isDecrypting,
		error: fetchError || decryptError,
		refetch: refetchRaw,
		isAllAccountsMode,
		vaultOwnerEmail: isAllAccountsMode ? vaultOwnerEmail : undefined,
	};
}
