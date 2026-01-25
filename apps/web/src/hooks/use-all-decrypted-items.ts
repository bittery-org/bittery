import { storage } from "@/lib/storage";
import { decrypt } from "@/lib/wasm-crypto";
import { useTRPC } from "@bittery/shared/trpc";
import type { DecryptedItem } from "@bittery/shared/types";
import { useQueries, useQuery } from "@tanstack/react-query";

/**
 * Hook to fetch and decrypt items from ALL vaults for security analysis.
 * This aggregates items across all accessible vaults.
 */
export function useAllDecryptedItems() {
	const trpc = useTRPC();

	// First, get all vaults
	const vaultsQuery = useQuery(trpc.vault.list.queryOptions());

	// For each vault, fetch its items
	const vaultIds = vaultsQuery.data?.map((v) => v.id) || [];

	const itemsQueries = useQueries({
		queries: vaultIds.map((vaultId) =>
			trpc.vault.listItems.queryOptions({ vaultId }),
		),
	});

	// Combine and decrypt all items
	const allItemsQuery = useQuery({
		queryKey: [
			"all-decrypted-items",
			vaultIds.join(","),
			itemsQueries.map((q) => q.dataUpdatedAt).join(","),
		],
		queryFn: async (): Promise<DecryptedItem[]> => {
			const allItems: DecryptedItem[] = [];

			for (let i = 0; i < vaultIds.length; i++) {
				const vaultId = vaultIds[i];
				const rawItems = itemsQueries[i]?.data || [];

				if (rawItems.length === 0 || !vaultId) continue;

				try {
					// Get vault key for decryption
					const vaultKey = await storage.getDecryptedVaultKey(vaultId);
					if (!vaultKey) continue;

					// Decrypt items for this vault
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
								return null;
							}
						}),
					);

					// Filter out failed decryptions
					allItems.push(
						...decrypted.filter((item): item is DecryptedItem => item !== null),
					);
				} catch (error) {
					console.error(`Failed to decrypt vault ${vaultId}:`, error);
				}
			}

			return allItems;
		},
		enabled:
			vaultIds.length > 0 && itemsQueries.every((q) => q.isSuccess || q.data),
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});

	const isLoading =
		vaultsQuery.isLoading ||
		itemsQueries.some((q) => q.isLoading) ||
		allItemsQuery.isLoading;

	return {
		items: allItemsQuery.data || [],
		vaults: vaultsQuery.data || [],
		isLoading,
		error: vaultsQuery.error || allItemsQuery.error,
	};
}
