import { useApiClient } from "@bittery/shared/api";
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
import { IconTrash as Trash2 } from "@bittery/ui/icons";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface DeleteTeamDialogProps {
	teamId: string;
	teamName: string;
}

export function DeleteTeamDialog({ teamId, teamName }: DeleteTeamDialogProps) {
	const [open, setOpen] = useState(false);
	const [confirmText, setConfirmText] = useState("");
	const api = useApiClient();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();
	const { m } = useI18n();

	const deleteMutation = useMutation({
		mutationFn: () => api.teams.remove(teamId),
		onSuccess: async () => {
			toast.success(m.team_delete_dialog_toast_deleted());
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
			toast.error(m.team_delete_dialog_toast_confirm_name_required());
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
					{m.team_delete_dialog_trigger()}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{m.team_delete_dialog_title()}</AlertDialogTitle>
					<AlertDialogDescription>
						{m.team_delete_dialog_description_prefix()}{" "}
						<strong>{teamName}</strong>{" "}
						{m.team_delete_dialog_description_suffix()}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="grid gap-2 py-4">
					<Label htmlFor="confirmTeamName">
						{m.team_delete_dialog_confirm_label_prefix()}{" "}
						<strong>{teamName}</strong>{" "}
						{m.team_delete_dialog_confirm_label_suffix()}
					</Label>
					<Input
						id="confirmTeamName"
						value={confirmText}
						onChange={(e) => setConfirmText(e.target.value)}
						placeholder={m.team_delete_dialog_placeholder_team_name()}
					/>
				</div>
				<AlertDialogFooter>
					<AlertDialogCancel>{m.team_common_action_cancel()}</AlertDialogCancel>
					<AlertDialogAction
						onClick={handleDelete}
						disabled={confirmText !== teamName || deleteMutation.isPending}
						className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
					>
						{deleteMutation.isPending
							? m.team_delete_dialog_action_deleting()
							: m.team_delete_dialog_action_confirm()}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
