import { storage } from "@/lib/storage";
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
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useState } from "react";

export function DeleteAccountDialog({ userEmail }: { userEmail: string }) {
	const [open, setOpen] = useState(false);
	const [confirmEmail, setConfirmEmail] = useState("");
	const [confirmText, setConfirmText] = useState("");
	const trpcClient = useTRPCClient();
	const navigate = useNavigate();

	const deleteAccountMutation = useMutation({
		mutationFn: (input: { confirmEmail: string }) =>
			trpcClient.auth.deleteAccount.mutate(input),
		onSuccess: async () => {
			await storage.clearAllStoredData();
			toast.success("Account deleted successfully");
			navigate({ to: "/" });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleDelete = () => {
		if (confirmEmail.toLowerCase() !== userEmail.toLowerCase()) {
			toast.error("Email does not match your account email");
			return;
		}
		if (confirmText !== "DELETE MY ACCOUNT") {
			toast.error("Please type 'DELETE MY ACCOUNT' to confirm");
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
					Delete Account
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete Account</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-3">
							<p>
								This action is <strong>permanent and cannot be undone</strong>.
								Deleting your account will:
							</p>
							<ul className="list-inside list-disc space-y-1 text-sm">
								<li>Remove all your vaults and stored items</li>
								<li>Remove your team memberships</li>
								<li>Delete all your session data</li>
								<li>Permanently erase all account information</li>
							</ul>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="grid gap-4 py-4">
					<div className="grid gap-2">
						<Label htmlFor="confirmEmail">
							Enter your email to confirm:{" "}
							<span className="font-mono text-muted-foreground">
								{userEmail}
							</span>
						</Label>
						<Input
							id="confirmEmail"
							type="email"
							value={confirmEmail}
							onChange={(e) => setConfirmEmail(e.target.value)}
							placeholder="Enter your email"
						/>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="confirmText">
							Type{" "}
							<span className="font-mono font-semibold">DELETE MY ACCOUNT</span>{" "}
							to confirm
						</Label>
						<Input
							id="confirmText"
							value={confirmText}
							onChange={(e) => setConfirmText(e.target.value)}
							placeholder="DELETE MY ACCOUNT"
						/>
					</div>
				</div>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={
							deleteAccountMutation.isPending ||
							confirmEmail.toLowerCase() !== userEmail.toLowerCase() ||
							confirmText !== "DELETE MY ACCOUNT"
						}
					>
						{deleteAccountMutation.isPending
							? "Deleting..."
							: "Delete Account Permanently"}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
