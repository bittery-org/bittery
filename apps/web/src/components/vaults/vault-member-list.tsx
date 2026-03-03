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
			toast.success("Role updated");
			await invalidator.invalidateVaultMembers(vaultId);
		},
		onError: (error: Error) => {
			toast.error(error.message);
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
				throw new Error("Could not decrypt vault key. Please log in again.");
			}

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
				`Member removed and vault key rotated (${result.keyRotation?.itemsReEncrypted ?? 0} items re-encrypted)`,
			);
			await invalidator.invalidateVaultMembers(vaultId);
		} catch (error) {
			console.error("Key rotation failed:", error);
			toast.error(
				error instanceof Error ? error.message : "Failed to remove member",
			);
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

	const getRoleDescription = (role: string) => {
		switch (role) {
			case "owner":
				return "Full control";
			case "admin":
				return "Manage members & items";
			case "member":
				return "View & edit items";
			case "read-only":
				return "View only";
			default:
				return "";
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
				<p className="text-muted-foreground">No members in this vault.</p>
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
										onValueChange={(
											value: "admin" | "member" | "read-only",
										) =>
											handleRoleChange(member.userId, value)
										}
										disabled={
											updateRoleMutation.isPending ||
											(userRole === "admin" &&
												member.role === "admin")
										}
									>
										<SelectTrigger className="h-7 w-28 text-xs">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="admin">Admin</SelectItem>
											<SelectItem value="member">Member</SelectItem>
											<SelectItem value="read-only">Read-only</SelectItem>
										</SelectContent>
									</Select>
								) : (
									<Badge
										variant={getRoleBadgeVariant(member.role)}
										className="px-2 py-0.5 text-xs capitalize"
									>
										{member.role}
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
													Remove Member
												</AlertDialogTitle>
												<AlertDialogDescription>
													Are you sure you want to remove{" "}
													<span className="font-medium text-foreground">
														{member.name}
													</span>{" "}
													from this vault? They will lose
													access to all items.
													<br />
													<br />
													<span className="text-muted-foreground text-xs">
														The vault encryption key will
														be rotated and all items
														re-encrypted for security.
													</span>
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel
													disabled={isRotating}
												>
													Cancel
												</AlertDialogCancel>
												<AlertDialogAction
													onClick={() =>
														handleRemove(member.userId)
													}
													disabled={isRotating}
													className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
												>
													{isRotating ? (
														<>
															<Loader2 className="mr-2 h-4 w-4 animate-spin" />
															Rotating keys...
														</>
													) : (
														"Remove"
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
