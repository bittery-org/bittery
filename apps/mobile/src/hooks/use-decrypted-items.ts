import { decrypt } from "@bittery/crypto/encryption";
import type { DecryptedItem } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useOfflineVaultContext } from "../contexts/offline-vault-context";
import { useTRPC } from "../lib/trpc";
import * as storage from "../services/storage";

/**
 * Hook to fetch and decrypt items from a vault.
 * Supports offline mode with encrypted local caching.
 * Items are cached for 5 minutes to avoid repeated decryption.
 */
export function useDecryptedItems(vaultId: string) {
	const trpc = useTRPC();
	const [isOfflineMode, setIsOfflineMode] = useState(false);
	const [offlineCachedItems, setOfflineCachedItems] = useState<DecryptedItem[]>(
		[],
	);

	// Get offline context - always available since provider wraps all routes
	const { isOnline, getCachedItems } = useOfflineVaultContext();

	// Check if we should use offline mode
	useEffect(() => {
		if (!isOnline) {
			setIsOfflineMode(true);
			// Load cached items
			getCachedItems(vaultId).then((cached) => {
				if (cached.length > 0) {
					const decrypted = cached.map((item) => {
						try {
							const data = JSON.parse(item.decryptedData);
							return {
								id: item.id,
								vaultId: item.vaultId,
								category: item.category,
								favorite: item.favorite,
								createdAt: item.createdAt,
								updatedAt: item.updatedAt,
								...data,
							} as DecryptedItem;
						} catch {
							return {
								id: item.id,
								vaultId: item.vaultId,
								category: item.category,
								favorite: item.favorite,
								createdAt: item.createdAt,
								updatedAt: item.updatedAt,
								title: "[Cached Item]",
							} as DecryptedItem;
						}
					});
					setOfflineCachedItems(decrypted);
				}
			});
		} else {
			setIsOfflineMode(false);
		}
	}, [vaultId, isOnline, getCachedItems]);

	// Fetch raw encrypted items from API (disabled when offline)
	const {
		data: rawItems = [],
		isLoading: isLoadingRaw,
		dataUpdatedAt,
		refetch,
		error: fetchError,
	} = useQuery({
		...trpc.vault.listItems.queryOptions({ vaultId }),
		enabled: !isOfflineMode, // Don't fetch when offline
		retry: isOfflineMode ? 0 : 3, // Don't retry when offline
	});

	// Decrypt items and cache the result
	const {
		data: decryptedItems = [],
		isLoading: isDecrypting,
		error: decryptError,
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

			// TODO: Add caching for offline access when cacheItems is available on context

			return decrypted;
		},
		enabled: rawItems.length > 0 && !isOfflineMode,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});

	// Determine which items to return
	const items = isOfflineMode ? offlineCachedItems : decryptedItems;
	const error = isOfflineMode ? null : decryptError || fetchError;

	return {
		items,
		isLoading: isOfflineMode ? false : isLoadingRaw || isDecrypting,
		error,
		refetch,
		isOffline: isOfflineMode,
		cachedItemsCount: offlineCachedItems.length,
	};
}
