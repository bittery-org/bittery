import { useTRPCClient } from "@bittery/shared/trpc";
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
import { IconTrash2OutlineDuo18 as Trash2 } from "@bittery/ui/icons";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

export function DeleteAccountDialog({ userEmail }: { userEmail: string }) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [confirmEmail, setConfirmEmail] = useState("");
	const [confirmText, setConfirmText] = useState("");
	const trpcClient = useTRPCClient();
	const navigate = useNavigate();
	const confirmPhrase = m["settings.delete_account_dialog.confirm_phrase"]();

	const deleteAccountMutation = useMutation({
		mutationFn: (input: { confirmEmail: string }) =>
			trpcClient.auth.deleteAccount.mutate(input),
		onSuccess: async () => {
			await storage.clearAllStoredData();
			toast.success(m["settings.delete_account_dialog.toast.deleted"]());
			navigate({ to: "/" });
		},
		onError: () => {
			toast.error(m["settings.delete_account_dialog.toast.delete_failed"]());
		},
	});

	const handleDelete = () => {
		if (confirmEmail.toLowerCase() !== userEmail.toLowerCase()) {
			toast.error(m["settings.delete_account_dialog.toast.email_mismatch"]());
			return;
		}
		if (confirmText !== confirmPhrase) {
			toast.error(
				m["settings.delete_account_dialog.toast.confirm_phrase_required"](),
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
					{m["settings.delete_account_dialog.trigger"]()}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{m["settings.delete_account_dialog.title"]()}
					</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-3">
							<p>
								{m["settings.delete_account_dialog.description.prefix"]()}{" "}
								<strong>
									{m["settings.delete_account_dialog.description.permanent"]()}
								</strong>
								. {m["settings.delete_account_dialog.description.suffix"]()}
							</p>
							<ul className="list-inside list-disc space-y-1 text-sm">
								<li>
									{m["settings.delete_account_dialog.list.remove_vaults"]()}
								</li>
								<li>
									{m["settings.delete_account_dialog.list.remove_teams"]()}
								</li>
								<li>
									{m["settings.delete_account_dialog.list.delete_sessions"]()}
								</li>
								<li>
									{m["settings.delete_account_dialog.list.erase_account"]()}
								</li>
							</ul>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="grid gap-4 py-4">
					<div className="grid gap-2">
						<Label htmlFor="confirmEmail">
							{m["settings.delete_account_dialog.field.email_label"]()}{" "}
							<span className="font-mono text-muted-foreground">
								{userEmail}
							</span>
						</Label>
						<Input
							id="confirmEmail"
							type="email"
							value={confirmEmail}
							onChange={(e) => setConfirmEmail(e.target.value)}
							placeholder={m[
								"settings.delete_account_dialog.placeholder.email"
							]()}
						/>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="confirmText">
							{m["settings.delete_account_dialog.field.confirm_phrase_label"]()}{" "}
							<span className="font-mono font-semibold">{confirmPhrase}</span>{" "}
							{m[
								"settings.delete_account_dialog.field.confirm_phrase_suffix"
							]()}
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
						{m["settings.common.action.cancel"]()}
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
							? m["settings.delete_account_dialog.action.deleting"]()
							: m["settings.delete_account_dialog.action.submit"]()}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
