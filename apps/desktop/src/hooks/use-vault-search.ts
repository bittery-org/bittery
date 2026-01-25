import { decrypt } from "../lib/tauri-crypto";
import { storage } from "@/lib/storage";
import { useTRPC } from "@bittery/shared/trpc";
import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useDecryptedItems } from "./use-decrypted-items";

interface SearchResult {
	vaults: Array<{
		id: string;
		name: string;
		type: "personal" | "team";
		icon: string | null;
		imageUrl: string | null;
	}>;
	items: Array<{
		id: string;
		vaultId: string;
		vaultName: string;
		category: ItemCategory;
		title: string;
		url?: string;
		username?: string;
		notes?: string;
	}>;
}

/**
 * Hook to perform client-side search across all vaults and items.
 * Searches through decrypted item data for true zero-knowledge search.
 */
export function useVaultSearch(query: string): SearchResult {
	const trpc = useTRPC();

	// Get all vaults for vault name search
	const { data: vaults = [] } = useQuery({
		...trpc.vault.list.queryOptions(),
	});

	// Fetch all items from all vaults in a single request
	const { data: allRawItems = [] } = useQuery({
		...trpc.vault.listAllItems.queryOptions(),
	});

	// Decrypt all items
	const { data: allDecryptedItems = [] } = useQuery({
		queryKey: ["all-decrypted-items"],
		queryFn: async (): Promise<
			Array<
				DecryptedItem & {
					vaultName: string;
				}
			>
		> => {
			if (allRawItems.length === 0) return [];

			// Decrypt all items in parallel
			const decrypted = await Promise.all(
				allRawItems.map(async (item) => {
					try {
						// Get vault key for decryption
						const vaultKey = await storage.decryptVaultKey(
							item.vault.encryptedVaultKey,
						);

						// Decrypt item data
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
							vaultName: item.vault.name,
							category: item.category,
							favorite: item.favorite,
							createdAt: item.createdAt,
							updatedAt: item.updatedAt,
							...parsedData,
						} as DecryptedItem & { vaultName: string };
					} catch (error) {
						console.error(`Failed to decrypt item ${item.id}:`, error);
						return {
							id: item.id,
							vaultId: item.vaultId,
							vaultName: item.vault.name,
							category: item.category,
							favorite: item.favorite,
							createdAt: item.createdAt,
							updatedAt: item.updatedAt,
							title: "[Decryption Failed]",
						} as DecryptedItem & { vaultName: string };
					}
				}),
			);

			return decrypted;
		},
		enabled: allRawItems.length > 0,
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});

	return useMemo(() => {
		if (!query || query.trim() === "") {
			return { vaults: [], items: [] };
		}

		const lowerQuery = query.toLowerCase();

		// Filter vaults by name
		const matchingVaults = vaults
			.filter((v) => v.name.toLowerCase().includes(lowerQuery))
			.slice(0, 5) // Limit vault results
			.map((v) => ({
				id: v.id,
				name: v.name,
				type: v.type,
				icon: v.icon,
				imageUrl: v.imageUrl,
			}));

		// Search through decrypted items
		const matchingItems = allDecryptedItems
			.filter((item) => {
				const searchable = [
					item.title,
					item.url,
					item.username,
					item.notes,
					item.note,
					item.email,
				]
					.filter(Boolean)
					.join(" ")
					.toLowerCase();

				return searchable.includes(lowerQuery);
			})
			.slice(0, 10)
			.map((item) => ({
				id: item.id,
				vaultId: item.vaultId,
				vaultName: item.vaultName,
				category: item.category,
				title: item.title,
				url: item.url,
				username: item.username,
				notes: item.notes || item.note,
			}));

		return {
			vaults: matchingVaults,
			items: matchingItems,
		};
	}, [query, vaults, allDecryptedItems]);
}

/**
 * Simplified search hook that only searches within a single vault.
 * Use this for vault-specific search.
 */
export function useSingleVaultSearch(vaultId: string, query: string) {
	const trpc = useTRPC();

	// Get vault info
	const { data: vaults = [] } = useQuery({
		...trpc.vault.list.queryOptions(),
	});

	const currentVault = vaults.find((v) => v.id === vaultId);

	// Get decrypted items
	const { items: decryptedItems } = useDecryptedItems(vaultId);

	return useMemo(() => {
		if (!query || query.trim() === "") {
			return { items: [] };
		}

		const lowerQuery = query.toLowerCase();

		// Search through decrypted item data
		const matchingItems = decryptedItems
			.filter((item) => {
				const searchable = [
					item.title,
					item.url,
					item.username,
					item.notes,
					item.note,
					item.email,
				]
					.filter(Boolean)
					.join(" ")
					.toLowerCase();

				return searchable.includes(lowerQuery);
			})
			.slice(0, 10)
			.map((item) => ({
				id: item.id,
				vaultId: item.vaultId,
				vaultName: currentVault?.name || "",
				category: item.category,
				title: item.title,
				url: item.url,
				username: item.username,
				notes: item.notes || item.note,
			}));

		return { items: matchingItems };
	}, [query, decryptedItems, currentVault]);
}
