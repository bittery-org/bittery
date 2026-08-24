import { useCreateLoginItem } from "@bittery/client-runtime/react";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useCallback } from "react";
import { refuseCreate, toLoginItemDraft } from "@/lib/runtime-items";
import { useI18n } from "@/providers/i18n-provider";

export interface AcceptLoginItemInput {
	accountId: string | null;
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
}

/**
 * Hands one create to the Runtime and answers with the Item it accepted.
 *
 * The Runtime is the writer: nothing here reaches the transitional repository, and the
 * durable Operation the Runtime accepts outlives this component. A create the first slice
 * cannot seal is refused with a localized reason, because dropping a field the user just
 * typed is data loss, and writing it somewhere the vault pages no longer read is worse.
 */
export function useAcceptLoginItem() {
	const createLoginItem = useCreateLoginItem();
	const { m } = useI18n();
	const accept = useCallback(
		async ({ accountId, vaultId, category, data }: AcceptLoginItemInput) => {
			const refusal = refuseCreate({ accountId, category, data });
			if (refusal !== null) {
				throw new Error(
					refusal.reason === "category"
						? m.vaults_detail_items_create_error_category_unsupported()
						: refusal.reason === "unsupportedFields"
							? m.vaults_detail_items_create_error_fields_unsupported({
									fields: refusal.fields.join(", "),
								})
							: m.vaults_detail_items_create_sheet_toast_no_vault_selected(),
				);
			}
			return await createLoginItem.mutateAsync({
				// `refuseCreate` already refused a missing Account.
				accountId: accountId as string,
				vaultId,
				draft: toLoginItemDraft(data),
			});
		},
		[createLoginItem, m],
	);
	return { accept, isPending: createLoginItem.isPending };
}
