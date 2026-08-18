/**
 * The "+" flow's sheet, in the mobile kit's shape.
 *
 * `@bittery/ui`'s `CreateItemSheet` is the same two steps, but its first step is a desktop
 * picker: hover-revealed chevrons, 13px type, a bordered `bg-card` list inside a bordered
 * sheet, and a corner ✕ instead of a grabber. Step 1 is therefore rebuilt here on `MobileSheet`
 * + `ListCard`; step 2 keeps rendering `@bittery/ui`'s `ItemForm`, which is the actual form
 * logic (validation, generators, TOTP clipboard auto-paste) and not something to fork.
 *
 * Prop-compatible with `@bittery/ui`'s `CreateItemSheet` apart from `side`, which a bottom sheet
 * does not need, so a call site swaps only its import. `initialCategory` is the one addition —
 * see `useCreateItemFlow`'s QR-scan path, which had no way to skip step 1 before.
 */

import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { ItemForm, toast, type VaultOption } from "@bittery/ui";
import {
	IconContact,
	IconCreditCard,
	IconFileLock,
	IconKey,
	IconSmartphone,
} from "@bittery/ui/icons";
import { type ComponentType, useState } from "react";
import {
	IconTile,
	iconClass,
	ListCard,
	ListRow,
	MobileSheet,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

type Messages = ReturnType<typeof useI18n>["m"];

const CATEGORIES: ReadonlyArray<{
	type: ItemCategory;
	icon: ComponentType<{ className?: string }>;
}> = [
	{ type: "login", icon: IconKey },
	{ type: "totp", icon: IconSmartphone },
	{ type: "secure-note", icon: IconFileLock },
	{ type: "credit-card", icon: IconCreditCard },
	{ type: "identity", icon: IconContact },
];

function getCategoryTitle(category: ItemCategory, m: Messages) {
	switch (category) {
		case "totp":
			return m.vaults_detail_items_category_totp_title();
		case "secure-note":
			return m.vaults_detail_items_category_secure_note_title();
		case "credit-card":
			return m.vaults_detail_items_category_credit_card_title();
		case "identity":
			return m.vaults_detail_items_category_identity_title();
		default:
			return m.vaults_detail_items_category_login_title();
	}
}

function getCategoryDescription(category: ItemCategory, m: Messages) {
	switch (category) {
		case "totp":
			return m.vaults_detail_items_create_sheet_category_totp_description();
		case "secure-note":
			return m.vaults_detail_items_create_sheet_category_secure_note_description();
		case "credit-card":
			return m.vaults_detail_items_create_sheet_category_credit_card_description();
		case "identity":
			return m.vaults_detail_items_create_sheet_category_identity_description();
		default:
			return m.vaults_detail_items_create_sheet_category_login_description();
	}
}

interface CreateItemSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vaults: VaultOption[];
	selectedVaultId?: string;
	/** Pre-fills the website field of the login form. */
	initialUrl?: string;
	/** Opens straight on this category's form instead of the picker. */
	initialCategory?: ItemCategory;
	onCreateItem: (
		data: DecryptedItemData,
		vaultId: string,
		category: ItemCategory,
	) => Promise<void>;
}

export function CreateItemSheet({
	open,
	onOpenChange,
	vaults,
	selectedVaultId,
	initialUrl,
	initialCategory,
	onCreateItem,
}: CreateItemSheetProps) {
	const { m } = useI18n();
	const [category, setCategory] = useState<ItemCategory | null>(
		initialCategory ?? null,
	);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const reset = () => {
		setCategory(initialCategory ?? null);
		setIsSubmitting(false);
	};

	const handleSubmit = async (data: DecryptedItemData, vaultId: string) => {
		if (!category) return;
		if (!vaultId) {
			toast.error(m.vaults_detail_items_create_sheet_toast_no_vault_selected());
			return;
		}

		setIsSubmitting(true);
		try {
			await onCreateItem(data, vaultId, category);
			reset();
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<MobileSheet
			open={open}
			onOpenChange={(nextOpen) => {
				onOpenChange(nextOpen);
				// Reset after the close animation, so the sheet does not visibly snap back to
				// step 1 on its way out.
				if (!nextOpen) setTimeout(reset, 200);
			}}
			title={
				category
					? m.vaults_detail_items_create_sheet_title_selected({
							category: getCategoryTitle(category, m),
						})
					: m.vaults_detail_items_create_sheet_title_default()
			}
			description={
				category
					? m.vaults_detail_items_create_sheet_description_selected()
					: m.vaults_detail_items_create_sheet_description_default()
			}
		>
			{category ? (
				<div className="flex min-h-0 flex-col pb-2">
					<ItemForm
						category={category}
						initialData={
							category === "login" && initialUrl
								? { url: initialUrl }
								: undefined
						}
						onSubmit={handleSubmit}
						// Step 2's cancel is "back to the picker", unless there was no picker.
						onCancel={() =>
							initialCategory ? onOpenChange(false) : setCategory(null)
						}
						submitLabel={m.vaults_detail_items_form_action_create()}
						cancelLabel={
							initialCategory
								? m.vaults_detail_items_detail_action_cancel()
								: m.vaults_detail_items_create_sheet_action_back()
						}
						isSubmitting={isSubmitting}
						vaults={vaults}
						selectedVaultId={selectedVaultId}
					/>
				</div>
			) : (
				<div className="px-4 pt-1 pb-6">
					<ListCard>
						{CATEGORIES.map(({ type, icon: Icon }) => (
							<ListRow
								key={type}
								title={getCategoryTitle(type, m)}
								subtitle={getCategoryDescription(type, m)}
								leading={
									<IconTile>
										<Icon className={iconClass.bar} />
									</IconTile>
								}
								showChevron
								onPress={() => setCategory(type)}
							/>
						))}
					</ListCard>
				</div>
			)}
		</MobileSheet>
	);
}
