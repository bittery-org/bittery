import { useI18n } from "@bittery/i18n/react";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { DialogBrandAccent } from "../dialog";
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
	/**
	 * Which edge the sheet slides in from. Defaults to `"right"` — the desktop and web drawer.
	 * Phones pass `"bottom"`, which also gives the sheet an explicit height (a bottom sheet has
	 * no `h-full` to inherit) and a safe-area inset.
	 */
	side?: ComponentProps<typeof SheetContent>["side"];
}

export function EditItemSheet({
	open,
	onOpenChange,
	item,
	onUpdateItem,
	isSubmitting,
	description,
	dataTestId = "edit-item-sheet",
	side = "right",
}: EditItemSheetProps) {
	const { m } = useI18n();

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={side}
				className={cn(
					"flex flex-col gap-0 overflow-hidden p-0 sm:w-[65vw] sm:max-w-2xl",
					side === "bottom" &&
						"h-[92dvh] rounded-t-xl pb-[var(--safe-bottom,0px)]",
				)}
				data-testid={dataTestId}
			>
				<DialogBrandAccent />

				<SheetHeader className="relative space-y-0 border-b px-6 pt-5 pb-4">
					<div className="flex flex-col gap-1 pr-8">
						<SheetTitle>{m.vaults_detail_edit_item_dialog_title()}</SheetTitle>
						<SheetDescription>
							{description ?? m.vaults_detail_edit_item_dialog_description()}
						</SheetDescription>
					</div>
				</SheetHeader>

				<div className="flex min-h-0 flex-1 flex-col">
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
