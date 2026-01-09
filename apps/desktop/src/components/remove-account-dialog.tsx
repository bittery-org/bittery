import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@bittery/ui";

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
	if (!email) return null;

	return (
		<Dialog open={!!email} onOpenChange={(open: boolean) => !open && onCancel()}>
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>Remove Account</DialogTitle>
					<DialogDescription>
						Are you sure you want to remove <strong>{email}</strong> from this
						device? You will need to log in again with your email, password, and
						secret key to access this account.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={onCancel}>
						Cancel
					</Button>
					<Button
						onClick={() => onConfirm(email)}
						variant="destructive"
					>
						Remove Account
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
