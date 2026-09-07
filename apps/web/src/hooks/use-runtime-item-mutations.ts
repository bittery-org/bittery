import type {
	LoginItemDraft,
	LoginItemProjection,
} from "@bittery/client-runtime/protocol";
import { useRuntimeClient } from "@bittery/client-runtime/react";
import type { DecryptedItemData } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";

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
	sourceVaultId: string;
	targetVaultId: string;
	accountId: string;
	targetAccountId: string;
}

export function mergeLoginItemDraft(
	item: LoginItemProjection,
	data: Partial<DecryptedItemData>,
): LoginItemDraft {
	const merged = { ...item, ...data };
	return {
		title: merged.title,
		...(merged.url != null ? { url: merged.url } : {}),
		...(merged.urls != null ? { urls: merged.urls } : {}),
		...(merged.username != null ? { username: merged.username } : {}),
		...(merged.password != null ? { password: merged.password } : {}),
		...(merged.notes != null ? { notes: merged.notes } : {}),
		...(merged.note != null ? { note: merged.note } : {}),
		...(merged.customFields != null ? { customFields: merged.customFields } : {}),
		...(merged.tags != null ? { tags: merged.tags } : {}),
	};
}

export function runtimeMoveTargets(
	accountId: string,
	vaults: readonly {
		id: string;
		name: string;
		type: "personal" | "team";
		icon?: string | null;
		imageUrl?: string | null;
		role: "owner" | "admin" | "member" | "read-only";
	}[],
) {
	return vaults.map((vault) => ({
		vaultId: vault.id,
		vaultName: vault.name,
		vaultType: vault.type,
		vaultIcon: vault.icon ?? null,
		vaultImageUrl: vault.imageUrl ?? null,
		role: vault.role,
		accountId,
	}));
}

export function useUpdateItem() {
	const runtime = useRuntimeClient();
	return useMutation({
		mutationFn: async (input: UpdateItemInput) => {
			const snapshot = runtime.items(input.accountId).getSnapshot();
			const item =
				snapshot.state === "ready"
					? snapshot.value.items.find(
							(candidate) => candidate.itemId === input.itemId,
						)
					: undefined;
			if (!item) throw new Error("Runtime Item authority is unavailable");
			return runtime.updateLoginItem({
				accountId: input.accountId,
				itemId: input.itemId,
				draft: mergeLoginItemDraft(item, input.data),
			});
		},
	});
}

export function useToggleFavorite() {
	const runtime = useRuntimeClient();
	return useMutation({
		mutationFn: (input: ToggleFavoriteInput) =>
			runtime.setItemFavorite({
				accountId: input.accountId,
				itemId: input.itemId,
				favorite: input.favorite,
			}),
	});
}

export function useDeleteItem() {
	const runtime = useRuntimeClient();
	return useMutation({
		mutationFn: (input: ItemAddressInput) =>
			runtime.trashItem({
				accountId: input.accountId,
				itemId: input.itemId,
			}),
	});
}

export function useRestoreItem() {
	const runtime = useRuntimeClient();
	return useMutation({
		mutationFn: (input: ItemAddressInput) =>
			runtime.restoreItem({
				accountId: input.accountId,
				itemId: input.itemId,
			}),
	});
}

export function usePermanentDeleteItem() {
	const runtime = useRuntimeClient();
	return useMutation({
		mutationFn: (input: ItemAddressInput) =>
			runtime.permanentlyDeleteItem({
				accountId: input.accountId,
				itemId: input.itemId,
			}),
	});
}

export function useMoveItem() {
	const runtime = useRuntimeClient();
	return useMutation({
		mutationFn: async (input: MoveItemInput) => {
			if (input.targetAccountId !== input.accountId)
				throw new Error("Cross-Account Item moves are unavailable");
			await runtime.moveItem({
				accountId: input.accountId,
				itemId: input.itemId,
				targetVaultId: input.targetVaultId,
			});
			return { crossAccount: false as const };
		},
	});
}
