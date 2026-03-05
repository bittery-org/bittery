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
	Avatar,
	AvatarFallback,
	Badge,
	Button,
	toast,
} from "@bittery/ui";
import { IconUserOutlineDuo18 as UserMinus } from "@bittery/ui/icons";
import { useState } from "react";
import { formatDate } from "@/lib/i18n-format";
import { storage } from "@/lib/storage";
import { decrypt, performKeyRotation, rsaDecrypt } from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";
import { TeamRotationError } from "./team-rotation-error";

interface Member {
	userId: string;
	name: string;
	email: string;
	role: "owner" | "admin" | "member";
	joinedAt: string | null;
}

interface MemberListProps {
	teamId: string;
	members: Member[];
	currentUserId?: string;
	currentUserRole: string;
	isSelfHostedMode?: boolean;
}

export function MemberList({
	teamId,
	members,
	currentUserId,
	currentUserRole,
	isSelfHostedMode = false,
}: MemberListProps) {
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const [removingUserId, setRemovingUserId] = useState<string | null>(null);
	const [isRotating, setIsRotating] = useState(false);
	const { m } = useI18n();

	const canManageMembers =
		currentUserRole === "owner" || currentUserRole === "admin";

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
				await trpcClient.team.members.getTeamRotationData.query({
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
				// Decrypt the current vault key for this vault
				const currentVaultKey = await getDecryptedVaultKey({
					vaultId: vaultData.vaultId,
					storage,
					crypto: {
						decrypt,
						rsaDecrypt,
					} as VaultKeyCryptoProvider,
				});

				if (!currentVaultKey) {
					throw new TeamRotationError("VAULT_KEY_DECRYPT_FAILED", {
						vaultName: vaultData.vaultName,
					});
				}

				// Perform key rotation on client side
				const rotationResult = await performKeyRotation(
					currentVaultKey,
					vaultData.members.map((m) => ({
						userId: m.userId,
						publicKey: m.publicKey,
					})),
					vaultData.items,
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
			}

			// Step 4: Submit to server
			const result = await trpcClient.team.members.remove.mutate({
				teamId,
				userId,
				vaultRotations,
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
					? m["team.members.toast.rotated_vaults.single"]({
							count: result.vaultRotations?.length ?? 0,
						})
					: m["team.members.toast.rotated_vaults.plural"]({
							count: result.vaultRotations?.length ?? 0,
						});

			const reEncryptedItemsLabel =
				totalItems === 1
					? m["team.members.toast.reencrypted_items.single"]({
							count: totalItems,
						})
					: m["team.members.toast.reencrypted_items.plural"]({
							count: totalItems,
						});

			toast.success(
				m["team.members.toast.removed_summary"]({
					rotatedVaults: rotatedVaultsLabel,
					reEncryptedItems: reEncryptedItemsLabel,
				}),
			);
			await invalidator.invalidateTeam();
		} catch (error) {
			console.error("Team member removal with key rotation failed:", error);
			if (error instanceof TeamRotationError) {
				if (error.code === "MASTER_UNLOCK_KEY_MISSING") {
					toast.error(m["team.error.master_unlock_key_missing"]());
				} else if (error.code === "SESSION_DATA_MISSING") {
					toast.error(m["team.error.session_data_missing"]());
				} else {
					toast.error(
						m["team.error.vault_key_decrypt_failed"]({
							vaultName:
								error.params.vaultName ?? m["team.common.unknown_vault"](),
						}),
					);
				}
			} else {
				toast.error(
					error instanceof Error
						? error.message
						: m["team.members.toast.remove_failed"](),
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
			return m["team.members.role.owner_self_hosted"]();
		}
		switch (role) {
			case "owner":
				return m["team.role.owner"]();
			case "admin":
				return m["team.role.admin"]();
			default:
				return m["team.role.member"]();
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
				{m["team.members.empty"]()}
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
											{m["team.members.badge.you"]()}
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
									? m["team.members.joined.date"]({
											date: formatDate(member.joinedAt, {
												month: "short",
												day: "numeric",
												year: "numeric",
											}),
										})
									: m["team.members.joined.none"]()}
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
												{m["team.members.action.remove"]()}
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													{m["team.members.remove_dialog.title"]()}
												</AlertDialogTitle>
												<AlertDialogDescription>
													{m["team.members.remove_dialog.description"]({
														name: member.name,
													})}
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel disabled={isBusy}>
													{m["team.common.action.cancel"]()}
												</AlertDialogCancel>
												<AlertDialogAction
													disabled={isBusy}
													onClick={() => handleRemoveMember(member.userId)}
												>
													{removingUserId === member.userId
														? m["team.members.remove_dialog.action.removing"]()
														: m["team.members.remove_dialog.action.confirm"]()}
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
