import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	toast,
} from "@bittery/ui";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";

interface DeleteVaultDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vault: { id: string; name: string } | null;
	onConfirm: (vaultId: string) => Promise<void>;
}

export function DeleteVaultDialog({
	open,
	onOpenChange,
	vault,
	onConfirm,
}: DeleteVaultDialogProps) {
	const { m } = useI18n();
	const [isDeleting, setIsDeleting] = useState(false);

	const handleDelete = async () => {
		if (!vault) return;

		setIsDeleting(true);
		try {
			await onConfirm(vault.id);
			onOpenChange(false);
		} catch {
			toast.error(m.vaults_delete_dialog_toast_delete_failed());
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent data-testid="delete-vault-dialog">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{m.vaults_delete_dialog_title()}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{m.vaults_delete_dialog_description({
							vaultName: vault?.name ?? "",
						})}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel
						disabled={isDeleting}
						data-testid="delete-vault-cancel-button"
					>
						{m.vaults_delete_dialog_action_cancel()}
					</AlertDialogCancel>
					<AlertDialogAction
						onClick={handleDelete}
						disabled={isDeleting}
						className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						data-testid="delete-vault-confirm-button"
					>
						{isDeleting
							? m.vaults_delete_dialog_action_deleting()
							: m.vaults_delete_dialog_action_confirm()}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
