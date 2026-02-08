/**
 * useCreateItem Hook
 *
 * Creates a new vault item with encryption.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";

/**
 * Input for creating a new item
 */
export interface CreateItemInput {
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
	accountEmail?: string;
}

/**
 * Result from item creation
 */
export interface CreateItemResult {
	itemId: string;
	_encryptedData?: {
		ciphertext: string;
		iv: string;
		algorithm: string;
	};
}

/**
 * Hook for creating a new vault item.
 */
export function useCreateItem() {
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: (input: CreateItemInput): Promise<CreateItemResult> =>
			core.items.createItem(input, defaultClient),
		onSuccess: async (data, variables) => {
			if (data._encryptedData) {
				await core.cache.onItemCreated({
					itemId: data.itemId,
					vaultId: variables.vaultId,
					category: variables.category,
					encryptedData: data._encryptedData,
					accountEmail: variables.accountEmail,
				});
			}
			await invalidator.invalidateVaultList(variables.vaultId);
		},
	});
}
