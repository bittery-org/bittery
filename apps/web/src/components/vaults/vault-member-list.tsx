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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import {
	IconLoader2OutlineDuo18 as Loader2,
	IconMagicShieldOutlineDuo18 as Shield,
	IconTrash2OutlineDuo18 as Trash2,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { decrypt, performKeyRotation, rsaDecrypt } from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface VaultMember {
	userId: string;
	name: string;
	email: string;
	role: "owner" | "admin" | "member" | "read-only";
}

interface VaultMemberListProps {
	vaultId: string;
	members: VaultMember[];
	userRole: string;
}

export function VaultMemberList({
	vaultId,
	members,
	userRole,
}: VaultMemberListProps) {
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const { m } = useI18n();
	const canManage = userRole === "owner" || userRole === "admin";
	const [isRotating, setIsRotating] = useState(false);
	const [rotatingUserId, setRotatingUserId] = useState<string | null>(null);

	const updateRoleMutation = useMutation({
		mutationFn: (input: {
			vaultId: string;
			userId: string;
			role: "admin" | "member" | "read-only";
		}) => trpcClient.vault.members.updateRole.mutate(input),
		onSuccess: async () => {
			toast.success(m["vaults.member_list.toast.role_updated"]());
			await invalidator.invalidateVaultMembers(vaultId);
		},
		onError: () => {
			toast.error(m["vaults.member_list.toast.role_update_failed"]());
		},
	});

	const handleRoleChange = (
		userId: string,
		newRole: "admin" | "member" | "read-only",
	) => {
		updateRoleMutation.mutate({ vaultId, userId, role: newRole });
	};

	/**
	 * Handle member removal with key rotation
	 * This performs the following steps:
	 * 1. Get the current decrypted vault key and Master Unlock Key
	 * 2. Fetch rotation data (remaining members' public keys and all items)
	 * 3. Perform key rotation (generate new key, re-encrypt items, encrypt new key for members)
	 *    - Current user's key is encrypted with MUK (AES-GCM)
	 *    - Other members' keys are encrypted with RSA
	 * 4. Submit to server which updates all the encrypted data
	 */
	const handleRemove = async (userId: string) => {
		setIsRotating(true);
		setRotatingUserId(userId);

		try {
			// Step 1: Get the current decrypted vault key and Master Unlock Key
			const currentVaultKey = await getDecryptedVaultKey({
				vaultId,
				storage,
				crypto: {
					decrypt,
					rsaDecrypt,
				} as VaultKeyCryptoProvider,
			});
			if (!currentVaultKey) {
				throw new Error("vault_key_decrypt_failed");
			}

			const masterUnlockKey = await storage.getMasterUnlockKey();
			if (!masterUnlockKey) {
				throw new Error("master_unlock_key_missing");
			}

			const currentUserId = await storage.getActiveAccountUserId();
			if (!currentUserId) {
				throw new Error("session_data_missing");
			}

			// Step 2: Get rotation data from server
			const rotationData = await trpcClient.vault.members.getRotationData.query(
				{
					vaultId,
					excludeUserId: userId,
				},
			);

			// Step 3: Perform key rotation on client side
			const rotationResult = await performKeyRotation(
				currentVaultKey,
				rotationData.members.map((m) => ({
					userId: m.userId,
					publicKey: m.publicKey,
				})),
				rotationData.items,
				currentUserId,
				masterUnlockKey,
			);

			// Step 4: Submit to server
			const result = await trpcClient.vault.members.remove.mutate({
				vaultId,
				userId,
				keyRotation: {
					memberKeys: rotationResult.memberEncryptedKeys,
					reEncryptedItems: rotationResult.reEncryptedItems,
				},
			});

			// Step 5: Update local session storage with new vault key
			// Find and update the vault key in session storage
			const vaultKeys = await storage.getVaultKeys();
			if (vaultKeys) {
				const updatedVaultKeys = vaultKeys.map((vk) => {
					if (vk.vaultId === vaultId) {
						// Find the current user's new encrypted key from the rotation result
						const myNewKey = rotationResult.memberEncryptedKeys.find((mk) => {
							// We need to find our own key - get current user from members list
							const currentMember = rotationData.members.find(
								(m) => m.userId === mk.userId,
							);
							return currentMember !== undefined;
						});
						if (myNewKey) {
							return { ...vk, encryptedVaultKey: myNewKey.encryptedVaultKey };
						}
					}
					return vk;
				});
				await storage.storeVaultKeys(updatedVaultKeys);
			}

			toast.success(
				m["vaults.member_list.toast.member_removed_rotated"]({
					count: result.keyRotation?.itemsReEncrypted ?? 0,
				}),
			);
			await invalidator.invalidateVaultMembers(vaultId);
		} catch (error) {
			console.error("Key rotation failed:", error);
			if (error instanceof Error) {
				switch (error.message) {
					case "vault_key_decrypt_failed":
						toast.error(
							m["vaults.member_list.error.vault_key_decrypt_failed"](),
						);
						break;
					case "master_unlock_key_missing":
						toast.error(
							m["vaults.member_list.error.master_unlock_key_missing"](),
						);
						break;
					case "session_data_missing":
						toast.error(m["vaults.member_list.error.session_data_missing"]());
						break;
					default:
						toast.error(m["vaults.member_list.toast.remove_failed"]());
						break;
				}
			} else {
				toast.error(m["vaults.member_list.toast.remove_failed"]());
			}
		} finally {
			setIsRotating(false);
			setRotatingUserId(null);
		}
	};

	const getInitials = (name: string) =>
		name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);

	const getRoleBadgeVariant = (role: string) => {
		switch (role) {
			case "owner":
				return "default";
			case "admin":
				return "secondary";
			case "read-only":
				return "outline";
			default:
				return "secondary";
		}
	};

	const getRoleLabel = (role: VaultMember["role"]) => {
		switch (role) {
			case "owner":
				return m["vaults.common.role.owner"]();
			case "admin":
				return m["vaults.common.role.admin"]();
			case "member":
				return m["vaults.common.role.member"]();
			case "read-only":
				return m["vaults.common.role.read_only"]();
			default:
				return role;
		}
	};

	// Sort: owner first, then admin, then member, then read-only
	const sortedMembers = [...members].sort((a, b) => {
		const order = { owner: 0, admin: 1, member: 2, "read-only": 3 };
		return (order[a.role] ?? 4) - (order[b.role] ?? 4);
	});

	if (members.length === 0) {
		return (
			<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
				<div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
					<Users className="h-6 w-6 text-muted-foreground" />
				</div>
				<p className="text-muted-foreground">
					{m["vaults.member_list.empty"]()}
				</p>
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-xl border">
			<div className="divide-y">
				{sortedMembers.map((member) => {
					const isOwner = member.role === "owner";
					const canRemove =
						canManage &&
						!isOwner &&
						!(userRole === "admin" && member.role === "admin");

					return (
						<div
							key={member.userId}
							className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30"
						>
							<Avatar className="h-9 w-9 shrink-0">
								<AvatarFallback className="font-medium text-xs">
									{getInitials(member.name)}
								</AvatarFallback>
							</Avatar>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="truncate font-medium text-sm">
										{member.name}
									</span>
									{isOwner && (
										<Shield className="h-3.5 w-3.5 shrink-0 text-primary" />
									)}
								</div>
								<p className="truncate text-muted-foreground text-xs">
									{member.email}
								</p>
							</div>

							<div className="flex shrink-0 items-center gap-2">
								{canManage && !isOwner ? (
									<Select
										value={member.role}
										onValueChange={(value: "admin" | "member" | "read-only") =>
											handleRoleChange(member.userId, value)
										}
										disabled={
											updateRoleMutation.isPending ||
											(userRole === "admin" && member.role === "admin")
										}
									>
										<SelectTrigger className="h-7 w-28 text-xs">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="admin">
												{m["vaults.common.role.admin"]()}
											</SelectItem>
											<SelectItem value="member">
												{m["vaults.common.role.member"]()}
											</SelectItem>
											<SelectItem value="read-only">
												{m["vaults.common.role.read_only"]()}
											</SelectItem>
										</SelectContent>
									</Select>
								) : (
									<Badge
										variant={getRoleBadgeVariant(member.role)}
										className="px-2 py-0.5 text-xs capitalize"
									>
										{getRoleLabel(member.role)}
									</Badge>
								)}

								{canRemove && (
									<AlertDialog>
										<AlertDialogTrigger asChild>
											<Button
												variant="ghost"
												size="icon"
												className="h-7 w-7 text-muted-foreground hover:text-destructive"
												disabled={isRotating}
											>
												{rotatingUserId === member.userId ? (
													<Loader2 className="h-3.5 w-3.5 animate-spin" />
												) : (
													<Trash2 className="h-3.5 w-3.5" />
												)}
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													{m["vaults.member_list.remove_dialog.title"]()}
												</AlertDialogTitle>
												<AlertDialogDescription>
													{m["vaults.member_list.remove_dialog.description"]({
														name: member.name,
													})}
													<br />
													<br />
													<span className="text-muted-foreground text-xs">
														{m[
															"vaults.member_list.remove_dialog.rotation_notice"
														]()}
													</span>
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel disabled={isRotating}>
													{m[
														"vaults.member_list.remove_dialog.action.cancel"
													]()}
												</AlertDialogCancel>
												<AlertDialogAction
													onClick={() => handleRemove(member.userId)}
													disabled={isRotating}
													className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
												>
													{isRotating ? (
														<>
															<Loader2 className="mr-2 h-4 w-4 animate-spin" />
															{m[
																"vaults.member_list.remove_dialog.action.rotating"
															]()}
														</>
													) : (
														m[
															"vaults.member_list.remove_dialog.action.confirm"
														]()
													)}
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
