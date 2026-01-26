/**
 * useVaultSearch Hook
 *
 * Client-side search across all vaults and items.
 * Performs zero-knowledge search through decrypted item data.
 */

import { useTRPC } from "@bittery/shared/trpc";
import type { ItemCategory } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	type CrossVaultDecryptedItem,
	useAllDecryptedItems,
} from "./use-all-decrypted-items";
import { useDecryptedItems } from "./use-decrypted-items";

/**
 * Search result type for vault search
 */
export interface SearchResult {
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
 * Search result type for single vault search
 */
export interface SingleVaultSearchResult {
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
 * Helper function to create searchable string from item
 */
function getSearchableText(item: CrossVaultDecryptedItem): string {
	return [
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
}

/**
 * Hook to perform client-side search across all vaults and items.
 * Searches through decrypted item data for true zero-knowledge search.
 *
 * @param query - Search query string
 * @returns Search results containing matching vaults and items
 */
export function useVaultSearch(query: string): SearchResult {
	const trpc = useTRPC();

	// Get all vaults for vault name search
	const { data: vaults = [] } = useQuery({
		...trpc.vault.list.queryOptions(),
	});

	// Get all decrypted items using the shared hook
	const { items: allDecryptedItems } = useAllDecryptedItems();

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
			.filter((item) => getSearchableText(item).includes(lowerQuery))
			.slice(0, 10)
			.map((item) => ({
				id: item.id,
				vaultId: item.vaultId,
				vaultName: item.vault.name,
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
 *
 * @param vaultId - The ID of the vault to search in
 * @param query - Search query string
 * @returns Search results containing matching items
 */
export function useSingleVaultSearch(
	vaultId: string,
	query: string,
): SingleVaultSearchResult {
	const trpc = useTRPC();

	// Get vault info
	const { data: vaults = [] } = useQuery({
		...trpc.vault.list.queryOptions(),
	});

	const currentVault = vaults.find((v) => v.id === vaultId);

	// Get decrypted items for this vault
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
