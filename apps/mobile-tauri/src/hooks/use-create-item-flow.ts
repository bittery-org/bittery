import type { VaultKeyWithAccount } from "@bittery/core/hooks";
import { useCreateItem } from "@bittery/core/hooks";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { toast, type VaultOption } from "@bittery/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";

/**
 * Shared "+" create-item flow for every screen that offers it (Vaults tab, a single vault's item
 * list, All Items tab). Resolves the owning account from `vaultKeys` the same way desktop's
 * `/vault` route does (`apps/desktop/src/routes/vault/route.tsx`), then navigates to the new
 * item's detail screen in its vault on success.
 */
export function useCreateItemFlow(vaultKeys: VaultKeyWithAccount[]) {
	const { m } = useI18n();
	const navigate = useNavigate();
	const [isOpen, setIsOpen] = useState(false);
	const createItem = useCreateItem();

	const vaultOptions: VaultOption[] = vaultKeys.map((v) => ({
		id: v.vaultId,
		name: v.vaultName,
		type: v.vaultType,
		icon: v.vaultIcon,
		imageUrl: v.vaultImageUrl,
	}));

	const handleCreateItem = async (
		data: DecryptedItemData,
		vaultId: string,
		category: ItemCategory,
	) => {
		const vault = vaultKeys.find((v) => v.vaultId === vaultId);
		const accountId = vault?.accountId;
		if (!accountId) {
			toast.error(m.mob_create_item_toast_vault_required());
			return;
		}

		try {
			const result = await createItem.mutateAsync({
				vaultId,
				category,
				data,
				accountId,
			});
			setIsOpen(false);
			toast.success(m.mob_create_item_toast_success());
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: vaultId, itemId: result.itemId },
			});
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.mob_create_item_toast_failed(),
			);
			throw error;
		}
	};

	return {
		isOpen,
		setIsOpen,
		vaultOptions,
		handleCreateItem,
		isPending: createItem.isPending,
	};
}
