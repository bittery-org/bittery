import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	toast,
} from "@bittery/ui";
import { CreditCard, FileText, KeyRound, User } from "lucide-react";
import { useState } from "react";
import type { VaultOption } from "./item-form";
import { ItemForm } from "./item-form";

interface DecryptedItemData {
	title: string;
	url?: string;
	username?: string;
	password?: string;
	notes?: string;
	note?: string;
}

interface CreateItemDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vaults: VaultOption[];
	selectedVaultId?: string;
	onCreateItem: (data: DecryptedItemData, vaultId: string, category: CategoryType) => Promise<void>;
}

type CategoryType = "login" | "secure-note" | "credit-card" | "identity";

const categories = [
	{
		type: "login" as const,
		title: "Login",
		description: "Save website credentials",
		icon: KeyRound,
	},
	{
		type: "secure-note" as const,
		title: "Secure Note",
		description: "Store sensitive information",
		icon: FileText,
	},
	{
		type: "credit-card" as const,
		title: "Credit Card",
		description: "Save payment details",
		icon: CreditCard,
	},
	{
		type: "identity" as const,
		title: "Identity",
		description: "Store personal information",
		icon: User,
	},
];

export function CreateItemDialog({
	open,
	onOpenChange,
	vaults,
	selectedVaultId,
	onCreateItem,
}: CreateItemDialogProps) {
	const [step, setStep] = useState<1 | 2>(1);
	const [selectedCategory, setSelectedCategory] =
		useState<CategoryType>("login");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleReset = () => {
		setStep(1);
		setSelectedCategory("login");
		setIsSubmitting(false);
	};

	const handleCategorySelect = (category: CategoryType) => {
		setSelectedCategory(category);
		setStep(2);
	};

	const handleBack = () => {
		setStep(1);
	};

	const handleSubmit = async (data: DecryptedItemData, vaultId: string) => {
		if (!vaultId) {
			toast.error("No vault selected");
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
		<Dialog
			open={open}
			onOpenChange={(newOpen) => {
				onOpenChange(newOpen);
				if (!newOpen) {
					// Reset after animation
					setTimeout(handleReset, 200);
				}
			}}
		>
			<DialogContent className="flex max-h-[98svh] max-w-2xl flex-col overflow-hidden p-0">
				<DialogHeader className="px-6 py-6">
					<DialogTitle>
						{step === 1 ? "Create New Item" : `Create ${categories.find(c => c.type === selectedCategory)?.title}`}
					</DialogTitle>
					<DialogDescription>
						{step === 1
							? "Choose the type of item you want to create."
							: "Fill in the details for your new item."}
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-1 flex-col overflow-hidden px-6 pb-6">
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
										<h3 className="font-medium">{category.title}</h3>
										<p className="mt-1 text-muted-foreground text-sm">
											{category.description}
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
							submitLabel="Create"
							isSubmitting={isSubmitting}
							vaults={vaults}
							selectedVaultId={selectedVaultId}
						/>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
