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
import { storage } from "@/lib/storage";
import { decrypt, performKeyRotation, rsaDecrypt } from "@/lib/wasm-crypto";
import { useQueryInvalidator } from "../../providers/sync-provider";

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
				throw new Error(
					"Master Unlock Key not available. Please log in again.",
				);
			}

			const currentUserId = await storage.getActiveAccountUserId();
			if (!currentUserId) {
				throw new Error("Session data not available. Please log in again.");
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
					throw new Error(
						`Could not decrypt vault key for vault "${vaultData.vaultName}". Please log in again.`,
					);
				}

				// Perform key rotation on client side
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

			const totalItems = result.vaultRotations?.reduce(
				(sum, _vr, i) =>
					sum + (vaultRotations[i]?.keyRotation.reEncryptedItems.length ?? 0),
				0,
			) ?? 0;

			toast.success(
				`Member removed. ${result.vaultRotations?.length ?? 0} vault(s) rotated, ${totalItems} item(s) re-encrypted.`,
			);
			await invalidator.invalidateTeam();
		} catch (error) {
			console.error("Team member removal with key rotation failed:", error);
			toast.error(
				error instanceof Error ? error.message : "Failed to remove member",
			);
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
			return "Admin (Super)";
		}
		return role;
	};

	const getRoleBadgeVariant = (role: Member["role"]) => {
		if (role === "owner") return "default" as const;
		if (role === "admin") return "secondary" as const;
		return "outline" as const;
	};

	const isBusy = isRotating;

	if (members.length === 0) {
		return (
			<p className="py-8 text-center text-muted-foreground">No members found</p>
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
											You
										</Badge>
									)}
								</div>
								<p className="truncate text-muted-foreground text-xs">
									{member.email}
								</p>
							</div>
							<Badge
								variant={getRoleBadgeVariant(member.role)}
								className="shrink-0 capitalize"
							>
								{getRoleLabel(member.role)}
							</Badge>
						</div>

						<div className="mt-3 flex items-center justify-between border-t pt-3">
							<span className="text-muted-foreground text-xs">
								{member.joinedAt
									? `Joined ${new Date(member.joinedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
									: "Joined —"}
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
												Remove
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>Remove Member</AlertDialogTitle>
												<AlertDialogDescription>
													Remove {member.name} from this team? Their sessions
													will be invalidated, team vault access revoked, and
													all shared vault keys will be rotated. They will be
													moved to a free personal plan.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel disabled={isBusy}>
													Cancel
												</AlertDialogCancel>
												<AlertDialogAction
													disabled={isBusy}
													onClick={() => handleRemoveMember(member.userId)}
												>
													{removingUserId === member.userId
														? "Removing & rotating keys..."
														: "Remove member"}
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
