import type { CompiledMessages } from "@bittery/i18n";
import { useI18n } from "@bittery/i18n/react";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import {
	IconChevronLeftOutlineDuo18,
	IconChevronRightOutlineDuo18,
	IconCreditCardLockOutlineDuo18,
	IconFileLockOutlineDuo18,
	IconIdBadge2OutlineDuo18,
	IconKeyOutlineDuo18,
	IconMobileOutlineDuo18,
} from "../../icons";
import { useState } from "react";
import { Button } from "../button";
import { DialogBrandAccent } from "../dialog";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "../sheet";
import { toast } from "../sonner";
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
	m: CompiledMessages,
) {
	switch (category) {
		case "login":
			return m.vaults_detail_items_category_login_title();
		case "totp":
			return m.vaults_detail_items_category_totp_title();
		case "secure-note":
			return m.vaults_detail_items_category_secure_note_title();
		case "credit-card":
			return m.vaults_detail_items_category_credit_card_title();
		case "identity":
			return m.vaults_detail_items_category_identity_title();
		default:
			return category;
	}
}

function getCategoryDescription(
	category: ItemCategory,
	m: CompiledMessages,
) {
	switch (category) {
		case "login":
			return m.vaults_detail_items_create_sheet_category_login_description();
		case "totp":
			return m.vaults_detail_items_create_sheet_category_totp_description();
		case "secure-note":
			return m.vaults_detail_items_create_sheet_category_secure_note_description();
		case "credit-card":
			return m.vaults_detail_items_create_sheet_category_credit_card_description();
		case "identity":
			return m.vaults_detail_items_create_sheet_category_identity_description();
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

	const SelectedCategoryIcon =
		categories.find((category) => category.type === selectedCategory)?.icon ??
		IconKeyOutlineDuo18;

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
				m.vaults_detail_items_create_sheet_toast_no_vault_selected(),
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
			setTimeout(handleReset, 200);
		}
	};

	return (
		<Sheet
			open={open}
			onOpenChange={(newOpen) => {
				onOpenChange(newOpen);
				if (!newOpen) {
					setTimeout(handleReset, 200);
				}
			}}
		>
			<SheetContent
				className="flex flex-col gap-0 overflow-hidden p-0 sm:w-[65vw] sm:max-w-2xl"
				data-testid="create-item-sheet"
			>
				<DialogBrandAccent />

				<SheetHeader className="relative space-y-0 border-b px-6 pt-5 pb-4">
					{step === 1 ? (
						<div className="flex flex-col gap-1 pr-8">
							<SheetTitle>
								{m.vaults_detail_items_create_sheet_title_default()}
							</SheetTitle>
							<SheetDescription>
								{m.vaults_detail_items_create_sheet_description_default()}
							</SheetDescription>
						</div>
					) : (
						<div className="flex items-center gap-3 pr-8">
							<Button
								type="button"
								variant="ghost"
								size="icon"
								onClick={handleBack}
								aria-label={m.vaults_detail_items_create_sheet_action_back()}
								data-testid="create-item-back-button"
								className="-ml-1.5 size-7 shrink-0 text-muted-foreground"
							>
								<IconChevronLeftOutlineDuo18 className="size-4" />
							</Button>
							<span
								aria-hidden
								className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-foreground/3 text-foreground shadow-[0_0_20px_color-mix(in_oklab,var(--color-primary-deep)_16%,transparent)] dark:shadow-[0_0_24px_color-mix(in_oklab,var(--color-primary-deep)_28%,transparent)]"
							>
								<SelectedCategoryIcon className="size-4.5" />
							</span>
							<div className="flex min-w-0 flex-col gap-0.5">
								<SheetTitle className="truncate">
									{m.vaults_detail_items_create_sheet_title_selected({
										category: getCategoryTitle(selectedCategory, m),
									})}
								</SheetTitle>
								<SheetDescription className="truncate">
									{m.vaults_detail_items_create_sheet_description_selected()}
								</SheetDescription>
							</div>
						</div>
					)}
				</SheetHeader>

				{step === 1 ? (
					<div className="flex-1 overflow-y-auto px-6 py-5">
						<div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border bg-card">
							{categories.map((category) => (
								<button
									key={category.type}
									type="button"
									onClick={() => handleCategorySelect(category.type)}
									data-testid={`item-category-${category.type}`}
									className="group flex items-center gap-3.5 px-4 py-3 text-left transition-colors hover:bg-foreground/4 focus-visible:bg-foreground/4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:ring-inset"
								>
									<span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-foreground/3 text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground">
										<category.icon className="size-4.5" />
									</span>
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="font-medium text-foreground text-sm">
											{getCategoryTitle(category.type, m)}
										</span>
										<span className="text-muted-foreground text-xs">
											{getCategoryDescription(category.type, m)}
										</span>
									</span>
									<IconChevronRightOutlineDuo18 className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="flex min-h-0 flex-1 flex-col">
						<ItemForm
							category={selectedCategory}
							onSubmit={handleSubmit}
							onCancel={handleCancel}
							submitLabel={m.vaults_detail_items_form_action_create()}
							cancelLabel={m.vaults_detail_items_create_sheet_action_back()}
							isSubmitting={isSubmitting}
							vaults={vaults}
							selectedVaultId={selectedVaultId}
						/>
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}
