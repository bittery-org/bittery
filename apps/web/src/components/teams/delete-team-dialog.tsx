import { useTRPCClient } from "@bittery/shared/trpc";
import {
	AlertDialog,
	AlertDialogAction,
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
import { useQueryInvalidator } from "../../providers/sync-provider";

interface DeleteTeamDialogProps {
	teamId: string;
	teamName: string;
}

export function DeleteTeamDialog({ teamId, teamName }: DeleteTeamDialogProps) {
	const [open, setOpen] = useState(false);
	const [confirmText, setConfirmText] = useState("");
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();

	const deleteMutation = useMutation({
		mutationFn: () => trpcClient.team.delete.mutate({ teamId }),
		onSuccess: async () => {
			toast.success("Team deleted successfully");
			await invalidator.invalidateTeam();
			setOpen(false);
			navigate({ to: "/team" });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleDelete = () => {
		if (confirmText !== teamName) {
			toast.error("Please type the team name to confirm");
			return;
		}
		deleteMutation.mutate();
	};

	const handleOpenChange = (isOpen: boolean) => {
		setOpen(isOpen);
		if (!isOpen) {
			setConfirmText("");
		}
	};

	return (
		<AlertDialog open={open} onOpenChange={handleOpenChange}>
			<AlertDialogTrigger asChild>
				<Button variant="destructive">
					<Trash2 className="mr-2 h-4 w-4" />
					Delete Team
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete Team</AlertDialogTitle>
					<AlertDialogDescription>
						This action cannot be undone. This will permanently delete the team{" "}
						<strong>{teamName}</strong> and remove all members and invitations.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="grid gap-2 py-4">
					<Label htmlFor="confirmTeamName">
						Type <strong>{teamName}</strong> to confirm
					</Label>
					<Input
						id="confirmTeamName"
						value={confirmText}
						onChange={(e) => setConfirmText(e.target.value)}
						placeholder="Enter team name"
					/>
				</div>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={handleDelete}
						disabled={confirmText !== teamName || deleteMutation.isPending}
						className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
					>
						{deleteMutation.isPending ? "Deleting..." : "Delete Team"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
