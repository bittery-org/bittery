import { decrypt } from "../lib/tauri-crypto";
import { storage } from "@/lib/storage";
import { useTRPC } from "@bittery/shared/trpc";
import type { DecryptedItem } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";

/**
 * Hook to fetch and decrypt items from a vault.
 * Items are cached for 5 minutes to avoid repeated decryption.
 */
export function useDecryptedItems(vaultId: string) {
	const trpc = useTRPC();

	// Fetch raw encrypted items from API
	const {
		data: rawItems = [],
		isLoading: isLoadingRaw,
		dataUpdatedAt,
	} = useQuery({
		...trpc.vault.listItems.queryOptions({ vaultId }),
	});

	// Decrypt items and cache the result
	// Use dataUpdatedAt in the key so decrypted items refetch when raw items change
	const {
		data: decryptedItems = [],
		isLoading: isDecrypting,
		error,
	} = useQuery({
		queryKey: ["decrypted-items", vaultId, dataUpdatedAt],
		queryFn: async (): Promise<DecryptedItem[]> => {
			if (rawItems.length === 0) return [];

			// Get vault key for decryption
			const vaultKey = await storage.getDecryptedVaultKey(vaultId);
			if (!vaultKey) {
				throw new Error("No vault key found for decryption");
			}

			// Decrypt all items in parallel
			const decrypted = await Promise.all(
				rawItems.map(async (item) => {
					try {
						const decryptedData = await decrypt(
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
							category: item.category,
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
							category: item.category,
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
		enabled: rawItems.length > 0,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes (formerly cacheTime)
	});

	return {
		items: decryptedItems,
		isLoading: isLoadingRaw || isDecrypting,
		error,
	};
}
