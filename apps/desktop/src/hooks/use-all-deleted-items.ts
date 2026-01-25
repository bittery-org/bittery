import { decrypt } from "../lib/tauri-crypto";
import { storage } from "@/lib/storage";
import { useTRPC } from "@bittery/shared/trpc";
import type { ItemCategory } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import type { CrossVaultDecryptedItem } from "./use-all-decrypted-items";

/**
 * Deleted item with deletion timestamp
 */
export interface CrossVaultDeletedItem extends CrossVaultDecryptedItem {
	deletedAt: string;
}

/**
 * Hook to fetch and decrypt all deleted items from all accessible vaults.
 * Used for cross-vault trash view.
 */
export function useAllDeletedItems() {
	const trpc = useTRPC();

	// Fetch raw encrypted deleted items from API (all vaults)
	const {
		data: rawItems = [],
		isLoading: isLoadingRaw,
		dataUpdatedAt,
	} = useQuery({
		...trpc.vault.listAllDeletedItems.queryOptions(),
	});

	// Decrypt items and cache the result
	const {
		data: decryptedItems = [],
		isLoading: isDecrypting,
		error,
	} = useQuery({
		queryKey: ["all-deleted-items", dataUpdatedAt],
		queryFn: async (): Promise<CrossVaultDeletedItem[]> => {
			if (rawItems.length === 0) return [];

			// Cache decrypted vault keys to avoid repeated decryption
			const vaultKeyCache = new Map<string, Uint8Array>();

			// Helper to get or decrypt vault key
			const getVaultKey = async (vaultId: string): Promise<Uint8Array> => {
				const cached = vaultKeyCache.get(vaultId);
				if (cached) {
					return cached;
				}
				const vaultKey = await storage.getDecryptedVaultKey(vaultId);
				if (!vaultKey) {
					throw new Error(`No vault key found for vault ${vaultId}`);
				}
				vaultKeyCache.set(vaultId, vaultKey);
				return vaultKey;
			};

			// Decrypt all items in parallel
			const decrypted = await Promise.all(
				rawItems.map(async (rawItem) => {
					try {
						const vaultKey = await getVaultKey(rawItem.vaultId);

						const decryptedData = await decrypt(
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
							deletedAt: rawItem.deletedAt ?? "",
							...parsedData,
							vault: {
								id: rawItem.vault.id,
								name: rawItem.vault.name,
								type: rawItem.vault.type,
								icon: rawItem.vault.icon,
								imageUrl: rawItem.vault.imageUrl,
							},
						} as CrossVaultDeletedItem;
					} catch (error) {
						console.error(`Failed to decrypt item ${rawItem.id}:`, error);
						return {
							id: rawItem.id,
							vaultId: rawItem.vaultId,
							category: rawItem.category as ItemCategory,
							favorite: rawItem.favorite,
							createdAt: rawItem.createdAt,
							updatedAt: rawItem.updatedAt,
							deletedAt: rawItem.deletedAt ?? "",
							title: "[Decryption Failed]",
							vault: {
								id: rawItem.vault.id,
								name: rawItem.vault.name,
								type: rawItem.vault.type,
								icon: rawItem.vault.icon,
								imageUrl: rawItem.vault.imageUrl,
							},
						} as CrossVaultDeletedItem;
					}
				}),
			);

			return decrypted;
		},
		enabled: rawItems.length > 0,
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});

	return {
		items: decryptedItems,
		isLoading: isLoadingRaw || isDecrypting,
		error,
	};
}
