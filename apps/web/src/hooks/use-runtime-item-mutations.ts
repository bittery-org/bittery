import type {
	ItemDraft,
	ItemProjection,
} from "@bittery/client-runtime/protocol";
import { useRuntimeClient } from "@bittery/client-runtime/react";
import type { DecryptedItemData } from "@bittery/shared/types";
import { useRuntimeMutation } from "./use-runtime-mutation";

export interface UpdateItemInput {
	itemId: string;
	vaultId: string;
	data: Partial<DecryptedItemData>;
	accountId: string;
}

export interface ToggleFavoriteInput {
	itemId: string;
	vaultId: string;
	accountId: string;
	favorite: boolean;
}

export interface ItemAddressInput {
	itemId: string;
	vaultId: string;
	accountId: string;
}

export interface MoveItemInput {
	itemId: string;
	targetVaultId: string;
	accountId: string;
	targetAccountId: string;
}

export function mergeRuntimeItemDraft(
	item: ItemProjection,
	data: Partial<DecryptedItemData>,
): ItemDraft {
	return { ...item.data, data: { ...item.data.data, ...data } } as ItemDraft;
}

export function useUpdateItem() {
	const runtime = useRuntimeClient();
	return useRuntimeMutation({
		accountId: (input: UpdateItemInput) => input.accountId,
		mutationFn: async (input: UpdateItemInput, signal) => {
			const snapshot = runtime.items(input.accountId).getSnapshot();
			const item =
				snapshot.state === "ready"
					? snapshot.value.items.find(
							(candidate) => candidate.itemId === input.itemId,
						)
					: undefined;
			if (!item) throw new Error("Runtime Item authority is unavailable");
			return runtime.updateItem(
				{
					accountId: input.accountId,
					itemId: input.itemId,
					draft: mergeRuntimeItemDraft(item, input.data),
				},
				{ signal },
			);
		},
	});
}

export function useToggleFavorite() {
	const runtime = useRuntimeClient();
	return useRuntimeMutation({
		accountId: (input: ToggleFavoriteInput) => input.accountId,
		mutationFn: (input: ToggleFavoriteInput, signal) =>
			runtime.setItemFavorite(
				{
					accountId: input.accountId,
					itemId: input.itemId,
					favorite: input.favorite,
				},
				{ signal },
			),
	});
}

export function useDeleteItem() {
	const runtime = useRuntimeClient();
	return useRuntimeMutation({
		accountId: (input: ItemAddressInput) => input.accountId,
		mutationFn: (input: ItemAddressInput, signal) =>
			runtime.trashItem(
				{
					accountId: input.accountId,
					itemId: input.itemId,
				},
				{ signal },
			),
	});
}

export function useRestoreItem() {
	const runtime = useRuntimeClient();
	return useRuntimeMutation({
		accountId: (input: ItemAddressInput) => input.accountId,
		mutationFn: (input: ItemAddressInput, signal) =>
			runtime.restoreItem(
				{
					accountId: input.accountId,
					itemId: input.itemId,
				},
				{ signal },
			),
	});
}

export function usePermanentDeleteItem() {
	const runtime = useRuntimeClient();
	return useRuntimeMutation({
		accountId: (input: ItemAddressInput) => input.accountId,
		mutationFn: (input: ItemAddressInput, signal) =>
			runtime.permanentlyDeleteItem(
				{
					accountId: input.accountId,
					itemId: input.itemId,
				},
				{ signal },
			),
	});
}

export function useMoveItem() {
	const runtime = useRuntimeClient();
	return useRuntimeMutation({
		accountId: (input: MoveItemInput) => input.accountId,
		mutationFn: async (input: MoveItemInput, signal) => {
			if (input.targetAccountId !== input.accountId)
				throw new Error("Cross-Account Item moves are unavailable");
			return runtime.moveItem(
				{
					accountId: input.accountId,
					itemId: input.itemId,
					targetVaultId: input.targetVaultId,
				},
				{ signal },
			);
		},
	});
}
