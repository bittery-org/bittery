import { performKeyRotation } from "@bittery/crypto/key-rotation";
import {
	getDecryptedVaultKey,
	getMasterUnlockKey,
	getStoredSessionData,
	getVaultKeys,
	storeVaultKeys,
} from "@bittery/crypto/session-storage";
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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	toast,
} from "@bittery/ui";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
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
			const currentVaultKey = await getDecryptedVaultKey(vaultId);
			if (!currentVaultKey) {
				throw new Error("Could not decrypt vault key. Please log in again.");
			}

			const masterUnlockKey = await getMasterUnlockKey();
			if (!masterUnlockKey) {
				throw new Error("Master Unlock Key not available. Please log in again.");
			}

			const sessionData = getStoredSessionData();
			if (!sessionData) {
				throw new Error("Session data not available. Please log in again.");
			}
			const currentUserId = sessionData.userId;

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
			const vaultKeys = getVaultKeys();
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
				storeVaultKeys(updatedVaultKeys);
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

	if (members.length === 0) {
		return (
			<p className="py-4 text-center text-muted-foreground">
				No members in this vault.
			</p>
		);
	}

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Member</TableHead>
					<TableHead>Role</TableHead>
					{canManage && <TableHead className="w-[100px]">Actions</TableHead>}
				</TableRow>
			</TableHeader>
			<TableBody>
				{members.map((member) => (
					<TableRow key={member.userId}>
						<TableCell>
							<div className="flex items-center gap-3">
								<Avatar className="h-8 w-8">
									<AvatarFallback className="text-xs">
										{getInitials(member.name)}
									</AvatarFallback>
								</Avatar>
								<div>
									<div className="font-medium">{member.name}</div>
									<div className="text-muted-foreground text-sm">
										{member.email}
									</div>
								</div>
							</div>
						</TableCell>
						<TableCell>
							{canManage && member.role !== "owner" ? (
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
									<SelectTrigger className="w-[120px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="admin">Admin</SelectItem>
										<SelectItem value="member">Member</SelectItem>
										<SelectItem value="read-only">Read-only</SelectItem>
									</SelectContent>
								</Select>
							) : (
								<Badge variant={getRoleBadgeVariant(member.role)}>
									{member.role}
								</Badge>
							)}
						</TableCell>
						{canManage && (
							<TableCell>
								{member.role !== "owner" &&
									!(userRole === "admin" && member.role === "admin") && (
										<AlertDialog>
											<AlertDialogTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													disabled={isRotating}
												>
													{rotatingUserId === member.userId ? (
														<Loader2 className="h-4 w-4 animate-spin" />
													) : (
														<Trash2 className="h-4 w-4 text-destructive" />
													)}
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>Remove Member</AlertDialogTitle>
													<AlertDialogDescription>
														Are you sure you want to remove {member.name} from
														this vault? They will lose access to all items in
														this vault.
														<br />
														<br />
														<span className="text-muted-foreground text-xs">
															Note: This will rotate the vault encryption key
															and re-encrypt all items for security.
														</span>
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel disabled={isRotating}>
														Cancel
													</AlertDialogCancel>
													<AlertDialogAction
														onClick={() => handleRemove(member.userId)}
														disabled={isRotating}
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
							</TableCell>
						)}
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
