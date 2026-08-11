import { useCoreContext, usePlatformCrypto } from "@bittery/core/hooks";
import { buildStoredItemEncryptionContext } from "@bittery/core/services/vault-crypto";
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
	toast,
} from "@bittery/ui";
import { IconLogOut as LogOut } from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";
import { TeamRotationError } from "./team-rotation-error";

interface LeaveTeamDialogProps {
	teamId: string;
	teamName: string;
}

export function LeaveTeamDialog({ teamId, teamName }: LeaveTeamDialogProps) {
	const [open, setOpen] = useState(false);
	const [isLeaving, setIsLeaving] = useState(false);
	const api = useApiClient();
	const crypto = usePlatformCrypto();
	const { vaultCrypto } = useCoreContext();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();
	const { m } = useI18n();

	/**
	 * Handle leaving the team with key rotation for all team vaults.
	 *
	 * Steps:
	 * 1. Get the Master Unlock Key and current user ID from storage
	 * 2. Fetch leave rotation data (all team vaults with remaining members' keys and items)
	 * 3. For each team vault: decrypt current vault key, perform key rotation
	 * 4. Submit all vault rotations to server
	 */
	const handleLeave = async () => {
		setIsLeaving(true);

		try {
			const masterUnlockKey = await storage.getMasterUnlockKey();
			if (!masterUnlockKey) {
				throw new TeamRotationError("MASTER_UNLOCK_KEY_MISSING");
			}

			const currentUserId = await storage.getActiveAccountUserId();
			if (!currentUserId) {
				throw new TeamRotationError("SESSION_DATA_MISSING");
			}

			// Fetch rotation data for all team vaults
			const leaveRotationData = (await api.teams.leaveRotationData(teamId))
				.data;

			// Perform key rotation for each team vault
			const vaultRotations: Array<{
				vaultId: string;
				keyRotation: {
					memberKeys: Array<{
						userId: string;
						encryptedVaultKey: string;
					}>;
					reEncryptedItems: Array<{
						itemId: string;
						encryptedData: string;
						encryptionIv: string;
					}>;
				};
			}> = [];

			for (const vaultData of leaveRotationData.vaults) {
				const currentVaultKey = await vaultCrypto.getVaultKey({
					vaultId: vaultData.vaultId,
				});

				if (!currentVaultKey) {
					throw new TeamRotationError("VAULT_KEY_DECRYPT_FAILED", {
						vaultName: vaultData.vaultName,
					});
				}

				try {
					const rotationResult = await crypto.performKeyRotation(
						currentVaultKey,
						vaultData.members.map((m) => ({
							userId: m.userId,
							publicKey: m.publicKey,
						})),
						vaultData.items.map((item) => ({
							id: item.id,
							encryptedData: item.encryptedData,
							encryptionIv: item.encryptionIv,
							encryptionAlgorithm: item.encryptionAlgorithm,
							context: buildStoredItemEncryptionContext({
								vaultId: vaultData.vaultId,
								itemId: item.id,
								encryptionVersion: item.encryptionVersion,
								encryptedByUserId: item.encryptedByUserId,
							}),
						})),
						vaultData.vaultId,
						vaultData.keyVersion + 1,
						currentUserId,
						masterUnlockKey,
					);

					vaultRotations.push({
						vaultId: vaultData.vaultId,
						keyRotation: {
							memberKeys: rotationResult.memberEncryptedKeys,
							reEncryptedItems: rotationResult.reEncryptedItems,
						},
					});
				} finally {
					// `getVaultKey` mints a fresh ref per call; the store's master unlock key
					// is not ours to touch.
					await crypto.destroyKey(currentVaultKey);
				}
			}

			await api.teams.leave(teamId, {
				vaultRotations,
			});

			toast.success(m.team_leave_dialog_toast_left());
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
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>
				<Button variant="outline">
					<LogOut className="mr-2 h-4 w-4" />
					{m.team_leave_dialog_trigger()}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{m.team_leave_dialog_title()}</AlertDialogTitle>
					<AlertDialogDescription>
						{m.team_leave_dialog_description_prefix()}{" "}
						<strong>{teamName}</strong>{" "}
						{m.team_leave_dialog_description_suffix()}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{m.team_common_action_cancel()}</AlertDialogCancel>
					<AlertDialogAction onClick={handleLeave} disabled={isLeaving}>
						{isLeaving
							? m.team_leave_dialog_action_leaving()
							: m.team_leave_dialog_action_confirm()}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
