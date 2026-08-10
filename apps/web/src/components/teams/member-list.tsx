import { useCoreContext, usePlatformCrypto } from "@bittery/core/hooks";
import { buildItemEncryptionContext } from "@bittery/core/services/vault-crypto";
import { useRPCClient } from "@bittery/shared/rpc";
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
	Avatar,
	AvatarFallback,
	Badge,
	Button,
	toast,
} from "@bittery/ui";
import { IconUser as UserMinus } from "@bittery/ui/icons";
import { useState } from "react";
import { formatDate } from "@/lib/i18n-format";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";
import { TeamRotationError } from "./team-rotation-error";

interface Member {
	userId: string;
	name: string;
	email: string;
	role: string;
	joinedAt: string | null;
}

interface MemberListProps {
	teamId: string;
	members: Member[];
	currentUserId?: string;
	canManageMembers: boolean;
	isSelfHostedMode?: boolean;
}

export function MemberList({
	teamId,
	members,
	currentUserId,
	canManageMembers,
	isSelfHostedMode = false,
}: MemberListProps) {
	const rpcClient = useRPCClient();
	const crypto = usePlatformCrypto();
	const { vaultCrypto } = useCoreContext();
	const invalidator = useQueryInvalidator();
	const [removingUserId, setRemovingUserId] = useState<string | null>(null);
	const [isRotating, setIsRotating] = useState(false);
	const { m } = useI18n();

	/**
	 * Handle member removal with key rotation for ALL team vaults.
	 *
	 * Steps:
	 * 1. Get the Master Unlock Key and current user ID from storage
	 * 2. Fetch team rotation data (all team vaults with members' public keys and items)
	 * 3. For each team vault: decrypt current vault key, perform key rotation
	 * 4. Submit all vault rotations to server in a single atomic call
	 * 5. Update local vault keys in storage
	 */
	const handleRemoveMember = async (userId: string) => {
		setIsRotating(true);
		setRemovingUserId(userId);

		try {
			// Step 1: Get MUK and current user ID
			const masterUnlockKey = await storage.getMasterUnlockKey();
			if (!masterUnlockKey) {
				throw new TeamRotationError("MASTER_UNLOCK_KEY_MISSING");
			}

			const currentUserId = await storage.getActiveAccountUserId();
			if (!currentUserId) {
				throw new TeamRotationError("SESSION_DATA_MISSING");
			}

			// Step 2: Fetch team rotation data from server
			const teamRotationData =
				await rpcClient.team.members.getTeamRotationData.query({
					teamId,
					excludeUserId: userId,
				});

			// Step 3: Perform key rotation for each team vault
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

			for (const vaultData of teamRotationData.vaults) {
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
							context: buildItemEncryptionContext({
								vaultId: vaultData.vaultId,
								itemId: item.id,
								version: item.version,
								userId: item.lastModifiedBy ?? currentUserId,
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

			// Step 4: Submit to server
			const result = await rpcClient.team.members.remove.mutate({
				teamId,
				userId,
				vaultRotations,
				clientId: null,
			});

			// Step 5: Update local vault keys in storage
			const vaultKeys = await storage.getVaultKeys();
			if (vaultKeys) {
				const updatedVaultKeys = vaultKeys.map((vk) => {
					// Find if this vault was rotated
					const rotationIdx = teamRotationData.vaults.findIndex(
						(v) => v.vaultId === vk.vaultId,
					);
					if (rotationIdx === -1) return vk;

					const rotation = vaultRotations[rotationIdx];
					if (!rotation) return vk;

					// Find the current user's new encrypted key
					const myNewKey = rotation.keyRotation.memberKeys.find(
						(mk) => mk.userId === currentUserId,
					);
					if (myNewKey) {
						return { ...vk, encryptedVaultKey: myNewKey.encryptedVaultKey };
					}
					return vk;
				});
				await storage.storeVaultKeys(updatedVaultKeys);
			}

			const totalItems =
				result.vaultRotations?.reduce(
					(sum, _vr, i) =>
						sum + (vaultRotations[i]?.keyRotation.reEncryptedItems.length ?? 0),
					0,
				) ?? 0;

			const rotatedVaultsLabel =
				(result.vaultRotations?.length ?? 0) === 1
					? m.team_members_toast_rotated_vaults_single({
							count: result.vaultRotations?.length ?? 0,
						})
					: m.team_members_toast_rotated_vaults_plural({
							count: result.vaultRotations?.length ?? 0,
						});

			const reEncryptedItemsLabel =
				totalItems === 1
					? m.team_members_toast_reencrypted_items_single({
							count: totalItems,
						})
					: m.team_members_toast_reencrypted_items_plural({
							count: totalItems,
						});

			toast.success(
				m.team_members_toast_removed_summary({
					rotatedVaults: rotatedVaultsLabel,
					reEncryptedItems: reEncryptedItemsLabel,
				}),
			);
			await invalidator.invalidateTeam();
		} catch (error) {
			console.error("Team member removal with key rotation failed:", error);
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
						: m.team_members_toast_remove_failed(),
				);
			}
		} finally {
			setIsRotating(false);
			setRemovingUserId(null);
		}
	};

	const getInitials = (name: string) =>
		name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);

	const getRoleLabel = (role: Member["role"]) => {
		if (isSelfHostedMode && role === "owner") {
			return m.team_members_role_owner_self_hosted();
		}
		switch (role) {
			case "owner":
				return m.team_role_owner();
			case "admin":
				return m.team_role_admin();
			default:
				return m.team_role_member();
		}
	};

	const getRoleBadgeVariant = (role: Member["role"]) => {
		if (role === "owner") return "default" as const;
		if (role === "admin") return "secondary" as const;
		return "outline" as const;
	};

	const isBusy = isRotating;

	if (members.length === 0) {
		return (
			<p className="py-8 text-center text-muted-foreground">
				{m.team_members_empty()}
			</p>
		);
	}

	return (
		<div className="grid gap-3 sm:grid-cols-2">
			{members.map((member) => {
				const isCurrentUser = member.userId === currentUserId;
				const canRemove =
					canManageMembers && !isCurrentUser && member.role !== "owner";

				return (
					<div
						key={member.userId}
						className="group relative overflow-hidden rounded-xl border border-border/70 bg-card/90 p-4 transition-all hover:-translate-y-0.5 hover:shadow-md"
						data-testid="member-row"
						data-member-id={member.userId}
						data-member-email={member.email}
					>
						<div className="flex items-start gap-3.5">
							<Avatar className="h-10 w-10 border shadow-sm">
								<AvatarFallback className="font-medium text-xs">
									{getInitials(member.name)}
								</AvatarFallback>
							</Avatar>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="truncate font-medium text-sm">
										{member.name}
									</span>
									{isCurrentUser && (
										<Badge
											variant="outline"
											className="border-primary/30 bg-primary/10 text-[10px] text-primary"
										>
											{m.team_members_badge_you()}
										</Badge>
									)}
								</div>
								<p className="truncate text-muted-foreground text-xs">
									{member.email}
								</p>
							</div>
							<Badge
								variant={getRoleBadgeVariant(member.role)}
								className="shrink-0"
							>
								{getRoleLabel(member.role)}
							</Badge>
						</div>

						<div className="mt-3 flex items-center justify-between border-t pt-3">
							<span className="text-muted-foreground text-xs">
								{member.joinedAt
									? m.team_members_joined_date({
											date: formatDate(member.joinedAt, {
												month: "short",
												day: "numeric",
												year: "numeric",
											}),
										})
									: m.team_members_joined_none()}
							</span>

							{canRemove && (
								<div className="flex items-center gap-1">
									<AlertDialog>
										<AlertDialogTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												disabled={isBusy}
												className="h-7 gap-1.5 px-2 text-muted-foreground text-xs hover:text-foreground"
											>
												<UserMinus className="h-3.5 w-3.5" />
												{m.team_members_action_remove()}
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													{m.team_members_remove_dialog_title()}
												</AlertDialogTitle>
												<AlertDialogDescription>
													{m.team_members_remove_dialog_description({
														name: member.name,
													})}
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel disabled={isBusy}>
													{m.team_common_action_cancel()}
												</AlertDialogCancel>
												<AlertDialogAction
													disabled={isBusy}
													onClick={() => handleRemoveMember(member.userId)}
												>
													{removingUserId === member.userId
														? m.team_members_remove_dialog_action_removing()
														: m.team_members_remove_dialog_action_confirm()}
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								</div>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}
