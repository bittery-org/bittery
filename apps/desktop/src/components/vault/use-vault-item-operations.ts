import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { toast } from "@bittery/ui";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { storage } from "@/lib/storage";
import { encrypt } from "../../lib/tauri-crypto";
import { useQueryInvalidator } from "../../providers/sync-provider";

export interface CreateItemInput {
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
}

export interface UpdateItemInput {
	itemId: string;
	vaultId: string;
	data: DecryptedItemData;
	skipToast?: boolean;
}

export interface DeleteItemInput {
	itemId: string;
	vaultId: string;
}

export interface MoveItemInput {
	itemId: string;
	sourceVaultId: string;
	targetVaultId: string;
	decryptedData: DecryptedItemData;
}

export interface ToggleFavoriteInput {
	itemId: string;
	vaultId: string;
	favorite: boolean;
}

/**
 * Hook that provides vault item operations with encryption, API calls,
 * and cache invalidation handled automatically.
 */
export function useVaultItemOperations() {
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();

	const createItem = useMutation({
		mutationFn: async (input: CreateItemInput) => {
			// Get vault key for encryption
			const vaultKey = await storage.getDecryptedVaultKey(input.vaultId);

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
		onSuccess: (_data, variable) => {
			invalidator.invalidateVaultList(variable.vaultId);
			toast.success("Item created successfully");
		},
		onError: (error) => {
			toast.error(`Failed to create item: ${error.message}`);
		},
	});

	const updateItem = useMutation({
		mutationFn: async (input: UpdateItemInput) => {
			// Get vault key for encryption
			const vaultKey = await storage.getDecryptedVaultKey(input.vaultId);

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
		onSuccess: (_data, variables) => {
			invalidator.invalidateItem(variables.itemId, variables.vaultId);
			if (!variables.skipToast) {
				toast.success("Item updated successfully");
			}
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
			invalidator.invalidateVaultList(variables.vaultId);
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
			invalidator.invalidateItem(variables.itemId, variables.vaultId);
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
		onSuccess: (_data, variables) => {
			invalidator.invalidateVaultList(variables.vaultId);
			toast.success("Item duplicated successfully");
		},
		onError: (error) => {
			toast.error(`Failed to duplicate item: ${error.message}`);
		},
	});

	const moveItem = useMutation({
		mutationFn: async (input: MoveItemInput) => {
			// Get target vault key for re-encryption
			const targetVaultKey = await storage.getDecryptedVaultKey(
				input.targetVaultId,
			);

			if (!targetVaultKey) {
				throw new Error("Cannot access target vault key. Try unlocking again.");
			}

			// Re-encrypt with target vault key
			const encryptedData = await encrypt(
				JSON.stringify(input.decryptedData),
				targetVaultKey,
			);

			// Call API to move the item
			return await trpcClient.vault.moveItem.mutate({
				itemId: input.itemId,
				sourceVaultId: input.sourceVaultId,
				targetVaultId: input.targetVaultId,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
			});
		},
		onSuccess: (_data, variables) => {
			// Invalidate both source and target vault lists
			invalidator.invalidateItem(variables.itemId, variables.targetVaultId);
			invalidator.invalidateVaultList(variables.sourceVaultId);
			toast.success("Item moved successfully");
			// Navigate to the item in the target vault
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: variables.targetVaultId, itemId: variables.itemId },
			});
		},
		onError: (error) => {
			toast.error(`Failed to move item: ${error.message}`);
		},
	});

	return {
		createItem,
		updateItem,
		deleteItem,
		toggleFavorite,
		duplicateItem,
		moveItem,
	};
}
