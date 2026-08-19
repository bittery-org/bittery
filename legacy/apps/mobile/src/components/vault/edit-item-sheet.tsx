/**
 * The edit-item sheet, in the mobile kit's shape.
 *
 * `@bittery/ui`'s `EditItemSheet` is the same form, but its chrome is a desktop drawer:
 * slides in from the right, a corner ✕, no grabber. The form itself is `ItemForm`
 * (validation, generators, TOTP clipboard auto-paste) and is not something to fork.
 *
 * Prop-compatible with `@bittery/ui`'s `EditItemSheet` apart from `side` and
 * `dataTestId`, which a `MobileSheet` does not take, so the call site swaps only
 * its import.
 */

import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { ItemForm } from "@bittery/ui";
import { MobileSheet } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

type EditableItem = DecryptedItemData & {
	category: ItemCategory;
	vaultId: string;
};

interface EditItemSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	item: EditableItem;
	onUpdateItem: (data: DecryptedItemData) => Promise<void>;
	isSubmitting?: boolean;
	description?: string;
}

export function EditItemSheet({
	open,
	onOpenChange,
	item,
	onUpdateItem,
	isSubmitting,
	description,
}: EditItemSheetProps) {
	const { m } = useI18n();

	return (
		<MobileSheet
			open={open}
			onOpenChange={onOpenChange}
			title={m.vaults_detail_edit_item_dialog_title()}
			description={
				description ?? m.vaults_detail_edit_item_dialog_description()
			}
		>
			<div className="flex min-h-0 flex-col pb-2">
				<ItemForm
					category={item.category}
					initialData={item}
					onSubmit={async (data) => {
						await onUpdateItem(data as DecryptedItemData);
					}}
					onCancel={() => onOpenChange(false)}
					isSubmitting={isSubmitting}
					submitLabel={m.vaults_detail_edit_item_dialog_action_submit()}
					selectedVaultId={item.vaultId}
				/>
			</div>
		</MobileSheet>
	);
}
