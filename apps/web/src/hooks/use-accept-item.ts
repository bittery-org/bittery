import { useRuntimeClient } from "@bittery/client-runtime/react";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useCallback } from "react";
import { toRuntimeItemDraft } from "@/lib/runtime-items";
import { useI18n } from "@/providers/i18n-provider";
import { useRuntimeMutation } from "./use-runtime-mutation";

export interface AcceptItemInput {
	accountId: string | null;
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
}

/** Accept a typed Item draft; Runtime owns validation, encryption and durable dispatch. */
export function useAcceptItem() {
	const runtime = useRuntimeClient();
	const createItem = useRuntimeMutation({
		accountId: (input: Parameters<typeof runtime.createItem>[0]) =>
			input.accountId,
		mutationFn: (input: Parameters<typeof runtime.createItem>[0], signal) =>
			runtime.createItem(input, { signal }),
	});
	const { m } = useI18n();
	const accept = useCallback(
		async ({ accountId, vaultId, category, data }: AcceptItemInput) => {
			if (accountId === null) {
				throw new Error(
					m.vaults_detail_items_create_sheet_toast_no_vault_selected(),
				);
			}
			return await createItem.mutateAsync({
				accountId,
				vaultId,
				draft: toRuntimeItemDraft(category, data),
			});
		},
		[createItem, m],
	);
	return { accept, isPending: createItem.isPending };
}
