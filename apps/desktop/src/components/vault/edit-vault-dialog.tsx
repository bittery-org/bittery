import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { useForm } from "@tanstack/react-form";

interface EditVaultDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vault: { id: string; name: string } | null;
	onSubmit: (vaultId: string, name: string) => Promise<void>;
}

export function EditVaultDialog({
	open,
	onOpenChange,
	vault,
	onSubmit,
}: EditVaultDialogProps) {
	const form = useForm({
		defaultValues: {
			name: vault?.name || "",
		},
		onSubmit: async ({ value }) => {
			if (!vault) return;

			try {
				await onSubmit(vault.id, value.name);
				onOpenChange(false);
				toast.success("Vault renamed successfully");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Failed to rename vault";
				toast.error(errorMessage);
			}
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Rename Vault</DialogTitle>
					<DialogDescription>
						Enter a new name for this vault.
					</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						form.handleSubmit();
					}}
				>
					<div className="space-y-4 py-4">
						<form.Field name="name">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>Vault Name</Label>
									<Input
										id={field.name}
										name={field.name}
										placeholder="My Vault"
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										disabled={form.state.isSubmitting}
										required
									/>
								</div>
							)}
						</form.Field>
					</div>
					<div className="flex gap-2">
						<Button
							type="submit"
							disabled={form.state.isSubmitting}
							className="flex-1"
						>
							{form.state.isSubmitting ? "Saving..." : "Save"}
						</Button>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={form.state.isSubmitting}
						>
							Cancel
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
