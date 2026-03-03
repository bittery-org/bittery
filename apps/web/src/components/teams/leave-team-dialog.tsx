import {
	getDecryptedVaultKey,
	type VaultKeyCryptoProvider,
} from "@bittery/shared";
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
	toast,
} from "@bittery/ui";
import { IconArrowDoorOutOutlineDuo18 as LogOut } from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { decrypt, performKeyRotation, rsaDecrypt } from "@/lib/wasm-crypto";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface LeaveTeamDialogProps {
	teamId: string;
	teamName: string;
}

export function LeaveTeamDialog({ teamId, teamName }: LeaveTeamDialogProps) {
	const [open, setOpen] = useState(false);
	const [isLeaving, setIsLeaving] = useState(false);
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();

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
				throw new Error(
					"Master Unlock Key not available. Please log in again.",
				);
			}

			const currentUserId = await storage.getActiveAccountUserId();
			if (!currentUserId) {
				throw new Error("Session data not available. Please log in again.");
			}

			// Fetch rotation data for all team vaults
			const leaveRotationData =
				await trpcClient.team.getLeaveRotationData.query({ teamId });

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
				const currentVaultKey = await getDecryptedVaultKey({
					vaultId: vaultData.vaultId,
					storage,
					crypto: {
						decrypt,
						rsaDecrypt,
					} as VaultKeyCryptoProvider,
				});

				if (!currentVaultKey) {
					throw new Error(
						`Could not decrypt vault key for vault "${vaultData.vaultName}". Please log in again.`,
					);
				}

				const rotationResult = await performKeyRotation(
					currentVaultKey,
					vaultData.members.map((m) => ({
						userId: m.userId,
						publicKey: m.publicKey,
					})),
					vaultData.items,
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
			}

			await trpcClient.team.leave.mutate({
				teamId,
				vaultRotations,
			});

			toast.success("You have left the team");
			await invalidator.invalidateTeam();
			setOpen(false);
			navigate({ to: "/team" });
		} catch (error) {
			console.error("Failed to leave team:", error);
			toast.error(
				error instanceof Error ? error.message : "Failed to leave team",
			);
		} finally {
			setIsLeaving(false);
		}
	};

	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>
				<Button variant="outline">
					<LogOut className="mr-2 h-4 w-4" />
					Leave Team
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Leave Team</AlertDialogTitle>
					<AlertDialogDescription>
						Are you sure you want to leave <strong>{teamName}</strong>? You will
						lose access to all team vaults, shared vault keys will be rotated,
						and you will be moved to a free personal plan. You will need to be
						re-invited to rejoin.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={handleLeave}
						disabled={isLeaving}
					>
						{isLeaving ? "Leaving & rotating keys..." : "Leave Team"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
