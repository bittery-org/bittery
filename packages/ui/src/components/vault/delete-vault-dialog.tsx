import { useI18n } from "@bittery/i18n/react";
import { useState } from "react";
import { ConfirmDialog } from "../confirm-dialog";
import { toast } from "../sonner";
import type { DeleteVaultDialogProps } from "./types";

/**
 * One implementation for web and desktop.
 *
 * `DeleteVaultDialogProps` already lived here — only the component was forked,
 * and the two copies differed in three ways: desktop surfaced the thrown
 * message, web had the e2e test ids, and their i18n import paths differed. Both
 * apps now render this and keep only the `onConfirm` they pass in, so the
 * `ui ↛ core` rule is untouched: this component never learns what a vault is
 * beyond a name and an id.
 *
 * The thrown message wins over the localized fallback, which is desktop's
 * behaviour: it is multi-server, so "could not reach <server>" is the useful
 * half of the toast and web loses nothing by gaining it.
 */
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
		} catch (error) {
			toast.error(
				error instanceof Error && error.message
					? error.message
					: m.vaults_delete_dialog_toast_delete_failed(),
			);
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title={m.vaults_delete_dialog_title()}
			description={m.vaults_delete_dialog_description({
				vaultName: vault?.name ?? "",
			})}
			cancelLabel={m.vaults_delete_dialog_action_cancel()}
			confirmLabel={
				isDeleting
					? m.vaults_delete_dialog_action_deleting()
					: m.vaults_delete_dialog_action_confirm()
			}
			onConfirm={handleDelete}
			busy={isDeleting}
			destructive
			testId="delete-vault-dialog"
			cancelTestId="delete-vault-cancel-button"
			confirmTestId="delete-vault-confirm-button"
		/>
	);
}
