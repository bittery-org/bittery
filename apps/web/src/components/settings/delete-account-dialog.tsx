import {
	type AccountDeletionDeps,
	deleteAccountEverywhere,
} from "@bittery/core/services/account-lifecycle";
import { useApiClient } from "@bittery/shared/api";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
	Button,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { IconTrash as Trash2 } from "@bittery/ui/icons";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { lifecycleDeps } from "@/lib/lifecycle";
import {
	initializeStorage,
	refreshActiveAccountId,
	storage,
} from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

export function DeleteAccountDialog({ userEmail }: { userEmail: string }) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [confirmEmail, setConfirmEmail] = useState("");
	const [confirmText, setConfirmText] = useState("");
	const apiClient = useApiClient();
	const navigate = useNavigate();
	const confirmPhrase = m.settings_delete_account_dialog_confirm_phrase();

	const deletionDeps: AccountDeletionDeps = {
		...lifecycleDeps,
		server: {
			deleteAccount: async (input) => {
				await apiClient.auth.deleteAccount(input);
			},
		},
	};

	const deleteAccountMutation = useMutation({
		mutationFn: async (input: { confirmEmail: string }) => {
			await initializeStorage();
			const accountId = await storage.getActiveAccount();
			if (!accountId) {
				throw new Error("No active account to delete");
			}

			const outcome = await deleteAccountEverywhere(
				{ accountId, confirmEmail: input.confirmEmail },
				deletionDeps,
			);
			await refreshActiveAccountId();

			// The module reports instead of throwing, and a failed server delete aborts the
			// local wipe — the account still exists, so this has to reach the error toast.
			const serverFailure = outcome.failures.find(
				(failure) => failure.step === "delete_server_account",
			);
			if (serverFailure) {
				throw serverFailure.cause;
			}
		},
		onSuccess: () => {
			toast.success(m.settings_delete_account_dialog_toast_deleted());
			navigate({ to: "/" });
		},
		onError: () => {
			toast.error(m.settings_delete_account_dialog_toast_delete_failed());
		},
	});

	const handleDelete = () => {
		if (confirmEmail.toLowerCase() !== userEmail.toLowerCase()) {
			toast.error(m.settings_delete_account_dialog_toast_email_mismatch());
			return;
		}
		if (confirmText !== confirmPhrase) {
			toast.error(
				m.settings_delete_account_dialog_toast_confirm_phrase_required(),
			);
			return;
		}
		deleteAccountMutation.mutate({ confirmEmail });
	};

	const handleOpenChange = (newOpen: boolean) => {
		setOpen(newOpen);
		if (!newOpen) {
			setConfirmEmail("");
			setConfirmText("");
		}
	};

	return (
		<AlertDialog open={open} onOpenChange={handleOpenChange}>
			<AlertDialogTrigger asChild>
				<Button variant="destructive">
					<Trash2 className="mr-2 h-4 w-4" />
					{m.settings_delete_account_dialog_trigger()}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent data-testid="delete-account-dialog">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{m.settings_delete_account_dialog_title()}
					</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-3">
							<p>
								{m.settings_delete_account_dialog_description_prefix()}{" "}
								<strong>
									{m.settings_delete_account_dialog_description_permanent()}
								</strong>
								. {m.settings_delete_account_dialog_description_suffix()}
							</p>
							<ul className="list-inside list-disc space-y-1 text-sm">
								<li>{m.settings_delete_account_dialog_list_remove_vaults()}</li>
								<li>{m.settings_delete_account_dialog_list_remove_teams()}</li>
								<li>
									{m.settings_delete_account_dialog_list_delete_sessions()}
								</li>
								<li>{m.settings_delete_account_dialog_list_erase_account()}</li>
							</ul>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="grid gap-4 py-4">
					<div className="grid gap-2">
						<Label htmlFor="confirmEmail">
							{m.settings_delete_account_dialog_field_email_label()}{" "}
							<span className="font-mono text-muted-foreground">
								{userEmail}
							</span>
						</Label>
						<Input
							id="confirmEmail"
							type="email"
							value={confirmEmail}
							onChange={(e) => setConfirmEmail(e.target.value)}
							placeholder={m.settings_delete_account_dialog_placeholder_email()}
						/>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="confirmText">
							{m.settings_delete_account_dialog_field_confirm_phrase_label()}{" "}
							<span className="font-mono font-semibold">{confirmPhrase}</span>{" "}
							{m.settings_delete_account_dialog_field_confirm_phrase_suffix()}
						</Label>
						<Input
							id="confirmText"
							value={confirmText}
							onChange={(e) => setConfirmText(e.target.value)}
							placeholder={confirmPhrase}
						/>
					</div>
				</div>
				<AlertDialogFooter>
					<AlertDialogCancel>
						{m.settings_common_action_cancel()}
					</AlertDialogCancel>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={
							deleteAccountMutation.isPending ||
							confirmEmail.toLowerCase() !== userEmail.toLowerCase() ||
							confirmText !== confirmPhrase
						}
					>
						{deleteAccountMutation.isPending
							? m.settings_delete_account_dialog_action_deleting()
							: m.settings_delete_account_dialog_action_submit()}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
