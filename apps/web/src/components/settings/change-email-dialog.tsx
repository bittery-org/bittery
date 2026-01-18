import { useTRPCClient } from "@bittery/shared/trpc";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Mail } from "lucide-react";
import { useState } from "react";

export function ChangeEmailDialog({ currentEmail }: { currentEmail: string }) {
	const [open, setOpen] = useState(false);
	const [newEmail, setNewEmail] = useState("");
	const [confirmEmail, setConfirmEmail] = useState("");
	const trpcClient = useTRPCClient();
	const navigate = useNavigate();

	const updateEmailMutation = useMutation({
		mutationFn: (input: { newEmail: string }) =>
			trpcClient.auth.updateEmail.mutate(input),
		onSuccess: () => {
			toast.success(
				"Email updated successfully. Please sign in with your new email.",
			);
			setOpen(false);
			// Redirect to login since all sessions are invalidated
			navigate({ to: "/login" });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!newEmail.trim()) {
			toast.error("Please enter a new email address");
			return;
		}
		if (newEmail !== confirmEmail) {
			toast.error("Email addresses do not match");
			return;
		}
		if (newEmail.toLowerCase() === currentEmail.toLowerCase()) {
			toast.error("New email must be different from current email");
			return;
		}
		updateEmailMutation.mutate({ newEmail: newEmail.trim() });
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Mail className="mr-2 h-4 w-4" />
					Change Email
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>Change Email Address</DialogTitle>
						<DialogDescription>
							Update your account email address. You will be logged out and need
							to sign in again with your new email.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="currentEmail">Current Email</Label>
							<Input
								id="currentEmail"
								value={currentEmail}
								disabled
								className="bg-muted"
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="newEmail">New Email</Label>
							<Input
								id="newEmail"
								type="email"
								value={newEmail}
								onChange={(e) => setNewEmail(e.target.value)}
								placeholder="Enter new email address"
								autoFocus
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="confirmEmail">Confirm New Email</Label>
							<Input
								id="confirmEmail"
								type="email"
								value={confirmEmail}
								onChange={(e) => setConfirmEmail(e.target.value)}
								placeholder="Confirm new email address"
							/>
						</div>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={updateEmailMutation.isPending}>
							{updateEmailMutation.isPending ? "Updating..." : "Update Email"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
