import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { decrypt } from "@bittery/shared/crypto";
import { useTRPC } from "@bittery/shared/trpc";
import type { DecryptedItemData } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";

/**
 * Hook to fetch and decrypt a single vault item.
 * The decrypted item is cached to avoid repeated decryption.
 */
export function useDecryptedItem(itemId: string) {
	const trpc = useTRPC();

	// Fetch raw encrypted item from API
	const {
		data: rawItem,
		isLoading: isLoadingRaw,
		error: rawError,
		dataUpdatedAt,
	} = useQuery({
		...trpc.vault.getItem.queryOptions({ itemId }),
		enabled: !!itemId,
	});

	// Decrypt item and cache the result
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
				const vaultKey = await tauriStorage.getDecryptedVaultKey(
					rawItem.vaultId,
				);

				if (!vaultKey) {
					throw new Error("No vault key found for decryption");
				}

				const decryptedJson = await decrypt(
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
	};
}
