import { decrypt } from "../lib/crypto";
import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useTRPC } from "../lib/trpc";
import * as storage from "../services/storage";

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

	// Track whether MUK is available in memory (without triggering biometric)
	// This prevents the query from running before auth is complete
	const [isMukReady, setIsMukReady] = useState(false);

	// Check MUK availability on mount and when items might need decryption
	// We use a polling approach to detect when MUK becomes available after biometric auth
	useEffect(() => {
		let mounted = true;

		async function checkMukAvailability() {
			try {
				// Check if MUK is in memory cache by trying to get it with skipBiometric=true
				// This avoids triggering a biometric prompt from within the query
				const muk = await storage.getMasterUnlockKey();
				if (mounted) {
					setIsMukReady(muk !== null);
				}
			} catch {
				if (mounted) {
					setIsMukReady(false);
				}
			}
		}

		// Check immediately
		checkMukAvailability();

		// Poll periodically while MUK is not ready (will detect when BiometricAuthModal succeeds)
		const interval = setInterval(() => {
			if (!isMukReady) {
				checkMukAvailability();
			}
		}, 500);

		return () => {
			mounted = false;
			clearInterval(interval);
		};
	}, [isMukReady]);

	// Fetch raw encrypted items from API (all vaults)
	const {
		data: rawItems = [],
		isLoading: isLoadingRaw,
		dataUpdatedAt,
		refetch,
	} = useQuery(trpc.vault.listAllItems.queryOptions());

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
		// Only run decryption when:
		// 1. We have items to decrypt
		// 2. MUK is available in memory (user is authenticated)
		// This prevents race conditions with the app-level biometric auth
		enabled: rawItems.length > 0 && isMukReady,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});

	// We're loading if:
	// 1. Raw items are still loading, OR
	// 2. MUK is not ready yet (waiting for authentication), OR
	// 3. We have raw items but no decrypted items yet (decryption in progress or just starting)
	const isDecryptionPending =
		rawItems.length > 0 && decryptedItems.length === 0 && !error;
	const isWaitingForAuth = rawItems.length > 0 && !isMukReady;
	const isLoadingState = isLoadingRaw || isDecrypting || isDecryptionPending || isWaitingForAuth;

	return {
		items: decryptedItems,
		isLoading: isLoadingState,
		error,
		refetch,
	};
}
