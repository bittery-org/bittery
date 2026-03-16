import { useI18n } from "@bittery/i18n/react";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "../sheet";
import { ItemForm } from "./item-form";

type EditableItem = DecryptedItemData & {
	category: ItemCategory;
	vaultId: string;
};

interface EditItemSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	item: EditableItem | null;
	onUpdateItem: (data: DecryptedItemData) => Promise<void>;
	isSubmitting?: boolean;
	description?: string;
	dataTestId?: string;
}

export function EditItemSheet({
	open,
	onOpenChange,
	item,
	onUpdateItem,
	isSubmitting,
	description,
	dataTestId = "edit-item-sheet",
}: EditItemSheetProps) {
	const { m } = useI18n();

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				className="flex flex-col overflow-hidden p-0 sm:w-[65vw] sm:max-w-4xl"
				data-testid={dataTestId}
			>
				<SheetHeader className="px-7 py-4">
					<SheetTitle>{m.vaults_detail_edit_item_dialog_title()}</SheetTitle>
					<SheetDescription>
						{description ?? m.vaults_detail_edit_item_dialog_description()}
					</SheetDescription>
				</SheetHeader>

				<div className="flex flex-1 flex-col overflow-y-auto px-6 pb-6">
					{item && (
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
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
