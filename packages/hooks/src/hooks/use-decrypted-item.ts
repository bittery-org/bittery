/**
 * useDecryptedItem Hook
 *
 * Fetches and decrypts a single vault item by ID.
 * The decrypted item is cached to avoid repeated decryption.
 */

import { useTRPC } from "@bittery/shared/trpc";
import type { DecryptedItemData } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import { usePlatform } from "../context/platform-context";

/**
 * Hook to fetch and decrypt a single vault item.
 * The decrypted item is cached for 5 minutes to avoid repeated decryption.
 *
 * @param itemId - The ID of the item to fetch and decrypt
 * @returns Object containing raw item, decrypted data, loading state, and error
 */
export function useDecryptedItem(itemId: string) {
	const trpc = useTRPC();
	const { storage, itemDecrypt } = usePlatform();

	// Fetch raw encrypted item from API
	const {
		data: rawItem,
		isLoading: isLoadingRaw,
		error: rawError,
		dataUpdatedAt,
		refetch: refetchRaw,
	} = useQuery({
		...trpc.vault.getItem.queryOptions({ itemId }),
		enabled: !!itemId,
	});

	// Decrypt item and cache the result
	// Use dataUpdatedAt in the key so decrypted item refetches when raw item changes
	const {
		data: decryptedData,
		isLoading: isDecrypting,
		error: decryptError,
	} = useQuery({
		queryKey: ["decrypted-item", itemId, dataUpdatedAt],
		queryFn: async (): Promise<DecryptedItemData | null> => {
			if (!rawItem) return null;

			try {
				// Get vault key for decryption
				const vaultKey = await storage.getDecryptedVaultKey(rawItem.vaultId);

				if (!vaultKey) {
					throw new Error("No vault key found for decryption");
				}

				const decryptedJson = await itemDecrypt.decrypt(
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
