import { decrypt } from "../lib/tauri-crypto";
import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { useTRPC } from "@bittery/shared/trpc";
import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";

/**
 * Decrypted item with vault metadata for cross-vault views
 */
export interface CrossVaultDecryptedItem extends DecryptedItem {
	vault: {
		id: string;
		name: string;
		type: string;
		icon: string | null;
		imageUrl: string | null;
	};
}

/**
 * Hook to fetch and decrypt all items from all accessible vaults.
 * Items are cached for 5 minutes to avoid repeated decryption.
 */
export function useAllDecryptedItems() {
	const trpc = useTRPC();

	// Fetch raw encrypted items from API (all vaults)
	const {
		data: rawItems = [],
		isLoading: isLoadingRaw,
		dataUpdatedAt,
	} = useQuery({
		...trpc.vault.listAllItems.queryOptions(),
	});

	// Decrypt items and cache the result
	const {
		data: decryptedItems = [],
		isLoading: isDecrypting,
		error,
	} = useQuery({
		queryKey: ["all-decrypted-items", dataUpdatedAt],
		queryFn: async (): Promise<CrossVaultDecryptedItem[]> => {
			if (rawItems.length === 0) return [];

			// Cache decrypted vault keys to avoid repeated decryption
			const vaultKeyCache = new Map<string, Uint8Array>();

			// Helper to get or decrypt vault key
			const getVaultKey = async (vaultId: string): Promise<Uint8Array> => {
				const cached = vaultKeyCache.get(vaultId);
				if (cached) {
					return cached;
				}
				const vaultKey = await tauriStorage.getDecryptedVaultKey(vaultId);
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
							...parsedData,
							vault: {
								id: rawItem.vault.id,
								name: rawItem.vault.name,
								type: rawItem.vault.type,
								icon: rawItem.vault.icon,
								imageUrl: rawItem.vault.imageUrl,
							},
						} as CrossVaultDecryptedItem;
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
						} as CrossVaultDecryptedItem;
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
