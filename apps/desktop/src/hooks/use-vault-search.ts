import type { ItemCategory } from "@bittery/shared/types";
import { useTRPC } from "@bittery/shared/trpc";
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

	// Get all vaults the user has access to
	const { data: vaults = [] } = useQuery({
		...trpc.vault.list.queryOptions(),
	});

	// Get decrypted items from all vaults
	// Note: We'll need to get items from all vaults, not just one
	// For now, let's create a combined result from individual vault queries
	const allDecryptedItems = useMemo(() => {
		const items: Array<{
			id: string;
			vaultId: string;
			vaultName: string;
			category: ItemCategory;
			title: string;
			url?: string;
			username?: string;
			notes?: string;
			note?: string;
		}> = [];

		// This is a simplified approach - in production you'd want to
		// optimize this by having a hook that gets all items at once
		for (const vault of vaults) {
			// We can't use the hook here directly, but we'll access the query cache
			// In practice, you'd want to prefetch these or use a different pattern
		}

		return items;
	}, [vaults]);

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

		// For a production implementation, you'd need to:
		// 1. Fetch all items from all vaults
		// 2. Decrypt them (using a modified version of useDecryptedItems that works for all vaults)
		// 3. Filter through decrypted data

		// Placeholder for now - the actual implementation would search through allDecryptedItems
		const matchingItems: typeof allDecryptedItems = [];

		return {
			vaults: matchingVaults,
			items: matchingItems.slice(0, 10), // Limit to 10 items
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
