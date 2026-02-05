/**
 * useVaultSearch Hook
 *
 * Client-side search across all vaults and items.
 * Performs zero-knowledge search through decrypted item data.
 * Context-aware: searches across all accounts when activeAccount = "all".
 */

import type { ItemCategory } from "@bittery/shared/types";
import { useMemo } from "react";
import { useAllVaultKeys } from "./internal/use-all-vault-keys";
import type { MultiAccountItem } from "./internal/use-items-unified";
import { useVaultInfo } from "./internal/use-vault-info";
import { useVaultItems } from "./internal/use-vault-items";
import { useCrossVaultTags } from "./use-cross-vault-tags";
import { useItems } from "./use-items";

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
		teamName?: string;
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
		tags?: string[];
		cardBrand?: string;
	}>;
	tags: string[];
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
		tags?: string[];
		cardBrand?: string;
	}>;
}

/**
 * Hook to perform client-side search across all vaults and items.
 * Searches through decrypted item data for true zero-knowledge search.
 * Context-aware: searches across multiple accounts when in "All Accounts" mode.
 *
 * @param query - Search query string
 * @returns Search results containing matching vaults and items
 */
export function useVaultSearch(query: string): SearchResult {
	const { items, isAllAccountsMode } = useItems();
	const { vaultKeys } = useAllVaultKeys({});
	const { tags } = useCrossVaultTags(items);

	return useMemo(() => {
		if (!query || query.trim() === "") {
			return { vaults: [], items: [], tags: [] };
		}

		const lowerQuery = query.toLowerCase();

		// Filter vaults by name
		const matchingVaults = vaultKeys
			.filter((v) => v.vaultName.toLowerCase().includes(lowerQuery))
			.slice(0, 5) // Limit vault results
			.map((v) => ({
				id: v.vaultId,
				name: v.vaultName,
				type: v.vaultType,
				icon: v.vaultIcon || null,
				imageUrl: v.vaultImageUrl || null,
				teamName: v.accountTeamName,
			}));

		// Search through decrypted items
		const matchingItems = items
			.filter((item) => {
				const searchable = [
					item.title,
					item.url,
					item.username,
					item.notes,
					item.note,
					item.email,
					// Include tags in search
					...(item.tags || []),
					// Include account email in search for multi-account mode
					isAllAccountsMode && "account" in item
						? (item as MultiAccountItem).account?.email
						: undefined,
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
				vaultName: item.vault.name,
				category: item.category,
				title: item.title,
				url: item.url,
				username: item.username,
				notes: item.notes || item.note,
				tags: item.tags,
				cardBrand: "cardBrand" in item ? (item.cardBrand as string) : undefined,
			}));

		const matchingTags = tags
			.filter((tag) => tag.toLowerCase().includes(lowerQuery))
			.slice(0, 5);

		return {
			vaults: matchingVaults,
			items: matchingItems,
			tags: matchingTags,
		};
	}, [query, items, isAllAccountsMode, vaultKeys, tags]);
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
	// Get vault info - automatically handles single-account vs all-accounts mode
	const { vaultInfo: currentVault } = useVaultInfo(vaultId);

	// Get decrypted items for this vault
	// useVaultItems automatically handles single-account vs all-accounts mode
	const { items: decryptedItems } = useVaultItems(vaultId);

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
					// Include tags in search
					...(item.tags || []),
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
				vaultName: currentVault?.vaultName || "",
				category: item.category,
				title: item.title,
				url: item.url,
				username: item.username,
				notes: item.notes || item.note,
				tags: item.tags,
				cardBrand: "cardBrand" in item ? (item.cardBrand as string) : undefined,
			}));

		return { items: matchingItems };
	}, [query, decryptedItems, currentVault]);
}
