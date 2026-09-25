import type {
	EditableItemDraft,
	ItemProjection,
} from "@bittery/client-runtime/protocol";
import { useRuntimeClient } from "@bittery/client-runtime/react";
import type { PublicDecryptedItemData } from "@bittery/shared/types";
import { useRuntimeMutation } from "@bittery/ui/runtime-presentation";

export interface UpdateItemInput {
	itemId: string;
	vaultId: string;
	data: Partial<PublicDecryptedItemData>;
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
	data: Partial<PublicDecryptedItemData>,
): EditableItemDraft {
	if (item.data.category === "login") {
		if (Object.hasOwn(data, "passkeys"))
			throw new Error("Use the credential command to change a passkey");
		const { passkeys: _publicCredentials, ...editable } = item.data.data;
		return {
			category: "login",
			data: { ...editable, ...data },
		} as EditableItemDraft;
	}
	return {
		...item.data,
		data: { ...item.data.data, ...data },
	} as EditableItemDraft;
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
			if (!item.editGuard)
				throw new Error("Runtime Item edit authority is unavailable");
			return runtime.updateItem(
				{
					accountId: input.accountId,
					itemId: input.itemId,
					guard: item.editGuard,
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
