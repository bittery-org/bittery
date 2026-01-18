import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { encrypt } from "@bittery/shared/crypto";
import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { toast } from "@bittery/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

export interface CreateItemInput {
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
}

export interface UpdateItemInput {
	itemId: string;
	vaultId: string;
	data: DecryptedItemData;
}

export interface DeleteItemInput {
	itemId: string;
	vaultId: string;
}

export interface ToggleFavoriteInput {
	itemId: string;
	favorite: boolean;
}

/**
 * Hook that provides vault item operations with encryption, API calls,
 * and cache invalidation handled automatically.
 */
export function useVaultItemOperations() {
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const createItem = useMutation({
		mutationFn: async (input: CreateItemInput) => {
			// Get vault key for encryption
			const vaultKey = await tauriStorage.getDecryptedVaultKey(input.vaultId);

			if (!vaultKey) {
				throw new Error("No vault key found");
			}

			// Encrypt the item data
			const encryptedData = await encrypt(JSON.stringify(input.data), vaultKey);

			return await trpcClient.vault.createItem.mutate({
				vaultId: input.vaultId,
				category: input.category,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
				encryptionAlgorithm: encryptedData.algorithm,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [["vault", "listItems"]] });
			toast.success("Item created successfully");
		},
		onError: (error) => {
			toast.error(`Failed to create item: ${error.message}`);
		},
	});

	const updateItem = useMutation({
		mutationFn: async (input: UpdateItemInput) => {
			// Get vault key for encryption
			const vaultKey = await tauriStorage.getDecryptedVaultKey(input.vaultId);

			if (!vaultKey) {
				throw new Error("No vault key found");
			}

			// Encrypt the item data
			const encryptedData = await encrypt(JSON.stringify(input.data), vaultKey);

			return await trpcClient.vault.updateItem.mutate({
				itemId: input.itemId,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [["vault", "getItem"]] });
			queryClient.invalidateQueries({ queryKey: [["vault", "listItems"]] });
			// Invalidate the decrypted item cache
			queryClient.invalidateQueries({ queryKey: ["decrypted-item"] });
			toast.success("Item updated successfully");
		},
		onError: (error) => {
			toast.error(`Failed to update item: ${error.message}`);
		},
	});

	const deleteItem = useMutation({
		mutationFn: async (input: DeleteItemInput) => {
			return await trpcClient.vault.deleteItem.mutate({ itemId: input.itemId });
		},
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({ queryKey: [["vault", "listItems"]] });
			toast.success("Item moved to trash");
			// Navigate back to vault
			navigate({ to: "/vault/$id", params: { id: variables.vaultId } });
		},
		onError: (error) => {
			toast.error(`Failed to delete item: ${error.message}`);
		},
	});

	const toggleFavorite = useMutation({
		mutationFn: async (input: ToggleFavoriteInput) => {
			return await trpcClient.vault.toggleFavorite.mutate({
				itemId: input.itemId,
				favorite: input.favorite,
			});
		},
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({ queryKey: [["vault", "listItems"]] });
			queryClient.invalidateQueries({ queryKey: [["vault", "getItem"]] });
			toast.success(
				variables.favorite ? "Added to favorites" : "Removed from favorites",
			);
		},
		onError: (error) => {
			toast.error(`Failed to update favorite: ${error.message}`);
		},
	});

	const duplicateItem = useMutation({
		mutationFn: async (_input: { itemId: string; vaultId: string }) => {
			// TODO: Implement duplicate functionality
			throw new Error("Duplicate functionality not yet implemented");
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [["vault", "listItems"]] });
			toast.success("Item duplicated successfully");
		},
		onError: (error) => {
			toast.error(`Failed to duplicate item: ${error.message}`);
		},
	});

	return {
		createItem,
		updateItem,
		deleteItem,
		toggleFavorite,
		duplicateItem,
	};
}
