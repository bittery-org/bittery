/**
 * useDecryptedItem Hook
 *
 * Fetches and decrypts a single vault item by ID.
 * The decrypted item is cached to avoid repeated decryption.
 * Context-aware: works in both single-account and "All Accounts" mode.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import type { DecryptedItemData } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import { usePlatform } from "../../context/platform-context";

export interface UseDecryptedItemOptions {
	/**
	 * Optional account email. When provided, uses that account's auth token.
	 * Useful for "All Accounts" mode where we need to fetch from a specific account.
	 */
	accountEmail?: string;
}

/**
 * Hook to fetch and decrypt a single vault item.
 * The decrypted item is cached for 5 minutes to avoid repeated decryption.
 * Context-aware: works in both single-account and "All Accounts" mode.
 *
 * @param itemId - The ID of the item to fetch and decrypt
 * @param options - Optional configuration including account email
 * @returns Object containing raw item, decrypted data, loading state, and error
 */
export function useDecryptedItem(
	itemId: string,
	options: UseDecryptedItemOptions = {},
) {
	const trpcClient = useTRPCClient();
	const { storage, crypto } = usePlatform();
	const { accountEmail } = options;

	// Check if we're in "All Accounts" mode
	const { data: activeAccount } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccount(),
		staleTime: 5 * 1000,
		enabled: storage.supportsMultiAccount && !accountEmail,
	});

	const isAllAccountsMode = activeAccount?.type === "all";

	// Fetch raw encrypted item from API
	// Strategy:
	// 1. If accountEmail is provided: Use per-account client with that account's token
	// 2. If in "All Accounts" mode: Don't fetch (we'll get it from useAllAccountsItems)
	// 3. Otherwise: Use default tRPC client (single-account mode)
	const {
		data: rawItem,
		isLoading: isLoadingRaw,
		error: rawError,
		dataUpdatedAt,
		refetch: refetchRaw,
	} = useQuery({
		queryKey: accountEmail
			? ["vault-item-account", itemId, accountEmail]
			: ["vault-item", itemId],
		queryFn: async () => {
			if (accountEmail) {
				// Use per-account client with that account's token
				const authToken = await storage.getAuthToken(accountEmail);
				if (!authToken) {
					throw new Error(`No auth token for account: ${accountEmail}`);
				}
				const serverUrl = await storage.getServerUrl(accountEmail);
				const accountClient = createAccountTrpcClient(
					authToken,
					serverUrl || "http://localhost:3000",
				);
				return accountClient.vault.getItem.query({ itemId });
			}

			return trpcClient.vault.getItem.query({ itemId });
		},
		// Enable if we have an itemId AND either:
		// - We're NOT in "All Accounts" mode (single account) OR
		// - We HAVE an accountEmail to authenticate with (specific account in multi-account mode)
		enabled: !!itemId && (!isAllAccountsMode || !!accountEmail),
	});

	// Decrypt item and cache the result
	// Use dataUpdatedAt in the key so decrypted item refetches when raw item changes
	const {
		data: decryptedData,
		isLoading: isDecrypting,
		error: decryptError,
	} = useQuery({
		queryKey: accountEmail
			? ["decrypted-item-account", itemId, accountEmail, dataUpdatedAt]
			: ["decrypted-item", itemId, dataUpdatedAt],
		queryFn: async (): Promise<DecryptedItemData | null> => {
			if (!rawItem) return null;

			try {
				// Get vault key for decryption
				// If accountEmail is provided, use it to get the vault key for that account
				const vaultKey = accountEmail
					? await storage.getDecryptedVaultKey(rawItem.vaultId, accountEmail)
					: await storage.getDecryptedVaultKey(rawItem.vaultId);

				if (!vaultKey) {
					throw new Error(
						`No vault key found for decryption${accountEmail ? ` (account: ${accountEmail})` : ""}`,
					);
				}

				const decryptedJson = await crypto.decrypt(
					{
						ciphertext: rawItem.encryptedData,
						iv: rawItem.encryptionIv,
						algorithm: rawItem.encryptionAlgorithm,
					},
					vaultKey,
				);

				return JSON.parse(decryptedJson) as DecryptedItemData;
			} catch (error) {
				console.error(`Failed to decrypt item ${itemId}:`, error);
				throw error;
			}
		},
		enabled: !!rawItem,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});

	return {
		rawItem,
		decryptedData,
		isLoading: isLoadingRaw || isDecrypting,
		error: rawError || decryptError,
		refetch: refetchRaw,
	};
}
