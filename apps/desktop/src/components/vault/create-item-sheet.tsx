import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	toast,
} from "@bittery/ui";
import {
	IconCreditCardLockOutlineDuo18,
	IconFileLockOutlineDuo18,
	IconIdBadge2OutlineDuo18,
	IconKeyOutlineDuo18,
	IconMobileOutlineDuo18,
} from "@bittery/ui/icons";
import { useState } from "react";
import { useI18n } from "../../providers/i18n-provider";
import type { VaultOption } from "./item-form";
import { ItemForm } from "./item-form";

interface CreateItemSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vaults: VaultOption[];
	selectedVaultId?: string;
	onCreateItem: (
		data: DecryptedItemData,
		vaultId: string,
		category: ItemCategory,
	) => Promise<void>;
}

const categories = [
	{
		type: "login" as const,
		icon: IconKeyOutlineDuo18,
	},
	{
		type: "totp" as const,
		icon: IconMobileOutlineDuo18,
	},
	{
		type: "secure-note" as const,
		icon: IconFileLockOutlineDuo18,
	},
	{
		type: "credit-card" as const,
		icon: IconCreditCardLockOutlineDuo18,
	},
	{
		type: "identity" as const,
		icon: IconIdBadge2OutlineDuo18,
	},
];

function getCategoryTitle(
	category: ItemCategory,
	m: ReturnType<typeof useI18n>["m"],
) {
	switch (category) {
		case "login":
			return m["vaults.detail.items.category.login.title"]();
		case "totp":
			return m["vaults.detail.items.category.totp.title"]();
		case "secure-note":
			return m["vaults.detail.items.category.secure_note.title"]();
		case "credit-card":
			return m["vaults.detail.items.category.credit_card.title"]();
		case "identity":
			return m["vaults.detail.items.category.identity.title"]();
		default:
			return category;
	}
}

function getCategoryDescription(
	category: ItemCategory,
	m: ReturnType<typeof useI18n>["m"],
) {
	switch (category) {
		case "login":
			return m["vaults.detail.items.create_sheet.category.login.description"]();
		case "totp":
			return m["vaults.detail.items.create_sheet.category.totp.description"]();
		case "secure-note":
			return m[
				"vaults.detail.items.create_sheet.category.secure_note.description"
			]();
		case "credit-card":
			return m[
				"vaults.detail.items.create_sheet.category.credit_card.description"
			]();
		case "identity":
			return m[
				"vaults.detail.items.create_sheet.category.identity.description"
			]();
		default:
			return "";
	}
}

export function CreateItemSheet({
	open,
	onOpenChange,
	vaults,
	selectedVaultId,
	onCreateItem,
}: CreateItemSheetProps) {
	const { m } = useI18n();
	const [step, setStep] = useState<1 | 2>(1);
	const [selectedCategory, setSelectedCategory] =
		useState<ItemCategory>("login");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleReset = () => {
		setStep(1);
		setSelectedCategory("login");
		setIsSubmitting(false);
	};

	const handleCategorySelect = (category: ItemCategory) => {
		setSelectedCategory(category);
		setStep(2);
	};

	const handleBack = () => {
		setStep(1);
	};

	const handleSubmit = async (data: DecryptedItemData, vaultId: string) => {
		if (!vaultId) {
			toast.error(
				m["vaults.detail.items.create_sheet.toast.no_vault_selected"](),
			);
			return;
		}

		setIsSubmitting(true);
		try {
			await onCreateItem(data, vaultId, selectedCategory);
			handleReset();
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleCancel = () => {
		if (step === 2) {
			handleBack();
		} else {
			onOpenChange(false);
			// Reset after animation
			setTimeout(handleReset, 200);
		}
	};

	return (
		<Sheet
			open={open}
			onOpenChange={(newOpen) => {
				onOpenChange(newOpen);
				if (!newOpen) {
					// Reset after animation
					setTimeout(handleReset, 200);
				}
			}}
		>
			<SheetContent className="flex flex-col overflow-hidden p-0 sm:w-[65vw] sm:max-w-4xl">
				<SheetHeader className="px-7 py-4">
					<SheetTitle className="mb-1">
						{step === 1
							? m["vaults.detail.items.create_sheet.title.default"]()
							: m["vaults.detail.items.create_sheet.title.selected"]({
									category: getCategoryTitle(selectedCategory, m),
								})}
					</SheetTitle>
					<SheetDescription>
						{step === 1
							? m["vaults.detail.items.create_sheet.description.default"]()
							: m["vaults.detail.items.create_sheet.description.selected"]()}
					</SheetDescription>
				</SheetHeader>

				<div className="flex flex-1 flex-col overflow-y-auto px-6 pb-6">
					{step === 1 ? (
						<div className="grid gap-3">
							{categories.map((category) => (
								<button
									key={category.type}
									type="button"
									onClick={() => handleCategorySelect(category.type)}
									className="group flex items-start gap-4 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-accent"
								>
									<div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
										<category.icon className="size-5" />
									</div>
									<div className="flex-1">
										<h3 className="font-medium">
											{getCategoryTitle(category.type, m)}
										</h3>
										<p className="mt-1 text-muted-foreground text-sm">
											{getCategoryDescription(category.type, m)}
										</p>
									</div>
								</button>
							))}
						</div>
					) : (
						<ItemForm
							category={selectedCategory}
							onSubmit={handleSubmit}
							onCancel={handleCancel}
							submitLabel={m["vaults.detail.items.form.action.create"]()}
							isSubmitting={isSubmitting}
							vaults={vaults}
							selectedVaultId={selectedVaultId}
						/>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
