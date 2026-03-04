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
	onConfirm: (email: string) => void;
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
						{m["vaults.sidebar.account_switcher.menu.remove_account"]()}
					</DialogTitle>
					<DialogDescription>
						{m[
							"vaults.sidebar.account_switcher.remove_account_dialog.description.prefix"
						]()}{" "}
						<strong>{email}</strong>{" "}
						{m[
							"vaults.sidebar.account_switcher.remove_account_dialog.description.suffix"
						]()}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={onCancel}>
						{m["settings.common.action.cancel"]()}
					</Button>
					<Button onClick={() => onConfirm(email)} variant="destructive">
						{m["vaults.sidebar.account_switcher.menu.remove_account"]()}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
