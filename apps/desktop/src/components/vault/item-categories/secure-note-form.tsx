import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { VaultOption } from "../types";

export interface SecureNoteFormData {
	title: string;
	note: string;
}

interface SecureNoteFormProps {
	initialData?: Partial<SecureNoteFormData>;
	onSubmit: (data: SecureNoteFormData, vaultId: string) => Promise<void> | void;
	onCancel: () => void;
	submitLabel?: string;
	isSubmitting?: boolean;
	vaults?: VaultOption[];
	selectedVaultId?: string;
}

export function SecureNoteForm({
	initialData,
	onSubmit,
	onCancel,
	submitLabel = "Save",
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: SecureNoteFormProps) {
	const [currentVaultId, setCurrentVaultId] = useState<string>(
		selectedVaultId || vaults[0]?.id || "",
	);

	const selectedVault = vaults.find((v) => v.id === currentVaultId);

	const form = useForm({
		defaultValues: {
			title: initialData?.title || "",
			note: initialData?.note || "",
		},
		onSubmit: async ({ value }) => {
			try {
				await onSubmit(value, currentVaultId);
				toast.success("Note saved successfully");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Failed to save note";
				toast.error(errorMessage);
			}
		},
	});

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				form.handleSubmit();
			}}
			className="flex flex-1 flex-col overflow-hidden"
		>
			<div className="flex-1 space-y-4 overflow-y-auto py-1 pr-2">
				<div>
					<form.Field name="title">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Title *</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="My Secure Note"
									required
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="note">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Note Content *</Label>
								<textarea
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="Write your secure note here..."
									rows={12}
									required
									className="flex min-h-60 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
								/>
							</div>
						)}
					</form.Field>
				</div>
			</div>

			{/* Footer with Vault Selector */}
			<div className="mt-4 flex items-center justify-between gap-3 border-t bg-background pt-4">
				{vaults.length > 0 && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="outline" size="sm">
								{selectedVault?.name || "Select vault"}
								<ChevronDown className="ml-2 size-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							{vaults.map((vault) => (
								<DropdownMenuItem
									key={vault.id}
									onClick={() => setCurrentVaultId(vault.id)}
								>
									{vault.name}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				<div className="flex flex-1 justify-end gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={onCancel}
						disabled={isSubmitting}
					>
						Cancel
					</Button>
					<Button type="submit" disabled={isSubmitting}>
						{isSubmitting ? "Saving..." : submitLabel}
					</Button>
				</div>
			</div>
		</form>
	);
}
