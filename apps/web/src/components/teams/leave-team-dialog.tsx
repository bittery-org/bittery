import { Button, ConfirmDialog, toast } from "@bittery/ui";
import { IconLogOut as LogOut } from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useVaultKeyRotation } from "@/hooks/use-vault-key-rotation";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/transitional-sync-provider";
import { TeamRotationError } from "./team-rotation-error";

interface LeaveTeamDialogProps {
	teamId: string;
	teamName: string;
}

export function LeaveTeamDialog({ teamId, teamName }: LeaveTeamDialogProps) {
	const [open, setOpen] = useState(false);
	const [isLeaving, setIsLeaving] = useState(false);
	const rotation = useVaultKeyRotation();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();
	const { m } = useI18n();

	const handleLeave = async () => {
		setIsLeaving(true);

		try {
			const currentUserId = await storage.getActiveAccountUserId();
			if (!currentUserId) {
				throw new TeamRotationError("SESSION_DATA_MISSING");
			}

			const outcome = await rotation.rotate({
				intent: { kind: "team-leave", teamId },
				currentUserId,
			});
			toast.success(
				m.team_leave_dialog_toast_left(),
				outcome.kind === "refresh_required"
					? { description: m.vault_key_rotation_refresh_required() }
					: undefined,
			);
			await invalidator.invalidateTeam();
			setOpen(false);
			navigate({ to: "/team" });
		} catch (error) {
			console.error("Failed to leave team:", error);
			if (error instanceof TeamRotationError) {
				if (error.code === "MASTER_UNLOCK_KEY_MISSING") {
					toast.error(m.team_error_master_unlock_key_missing());
				} else if (error.code === "SESSION_DATA_MISSING") {
					toast.error(m.team_error_session_data_missing());
				} else {
					toast.error(
						m.team_error_vault_key_decrypt_failed({
							vaultName:
								error.params.vaultName ?? m.team_common_unknown_vault(),
						}),
					);
				}
			} else {
				toast.error(
					error instanceof Error
						? error.message
						: m.team_leave_dialog_toast_leave_failed(),
				);
			}
		} finally {
			setIsLeaving(false);
		}
	};

	return (
		<ConfirmDialog
			open={open}
			onOpenChange={setOpen}
			trigger={
				<Button variant="outline">
					<LogOut className="mr-2 h-4 w-4" />
					{m.team_leave_dialog_trigger()}
				</Button>
			}
			title={m.team_leave_dialog_title()}
			description={
				<>
					{m.team_leave_dialog_description_prefix()} <strong>{teamName}</strong>{" "}
					{m.team_leave_dialog_description_suffix()}
				</>
			}
			cancelLabel={m.team_common_action_cancel()}
			confirmLabel={
				isLeaving
					? m.team_leave_dialog_action_leaving()
					: m.team_leave_dialog_action_confirm()
			}
			onConfirm={handleLeave}
			busy={isLeaving}
		/>
	);
}
