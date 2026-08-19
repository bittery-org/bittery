import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@bittery/ui";
import { useI18n } from "@/providers/i18n-provider";

interface RemoveAccountDialogProps {
	email: string | null;
	onConfirm: () => void;
	onCancel: () => void;
}

export function RemoveAccountDialog({
	email,
	onConfirm,
	onCancel,
}: RemoveAccountDialogProps) {
	const { m } = useI18n();

	if (!email) return null;

	return (
		<Dialog
			open={!!email}
			onOpenChange={(open: boolean) => !open && onCancel()}
		>
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>
						{m.vaults_sidebar_account_switcher_menu_remove_account()}
					</DialogTitle>
					<DialogDescription>
						{m.vaults_sidebar_account_switcher_remove_account_dialog_description_prefix()}{" "}
						<strong>{email}</strong>{" "}
						{m.vaults_sidebar_account_switcher_remove_account_dialog_description_suffix()}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={onCancel}>
						{m.settings_common_action_cancel()}
					</Button>
					<Button onClick={onConfirm} variant="destructive">
						{m.vaults_sidebar_account_switcher_menu_remove_account()}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
