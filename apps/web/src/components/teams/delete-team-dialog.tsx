import { useApiClient } from "@bittery/shared/api";
import { Button, ConfirmDialog, Input, Label, toast } from "@bittery/ui";
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
		<ConfirmDialog
			open={open}
			onOpenChange={handleOpenChange}
			trigger={
				<Button variant="destructive">
					<Trash2 className="mr-2 h-4 w-4" />
					{m.team_delete_dialog_trigger()}
				</Button>
			}
			title={m.team_delete_dialog_title()}
			description={
				<>
					{m.team_delete_dialog_description_prefix()}{" "}
					<strong>{teamName}</strong>{" "}
					{m.team_delete_dialog_description_suffix()}
				</>
			}
			cancelLabel={m.team_common_action_cancel()}
			confirmLabel={
				deleteMutation.isPending
					? m.team_delete_dialog_action_deleting()
					: m.team_delete_dialog_action_confirm()
			}
			onConfirm={handleDelete}
			busy={deleteMutation.isPending}
			confirmDisabled={confirmText !== teamName}
			destructive
		>
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
		</ConfirmDialog>
	);
}
