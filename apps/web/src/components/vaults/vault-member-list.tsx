import type { VaultMember } from "@bittery/api-contract";
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
	IconLoaderCircle as Loader2,
	IconShieldCheck as Shield,
	IconTrash as Trash2,
	IconUsers as Users,
} from "@bittery/ui/icons";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useVaultKeyRotation } from "@/hooks/use-vault-key-rotation";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface VaultMemberListProps {
	vaultId: string;
	members: readonly VaultMember[];
	userRole: string;
}

export function VaultMemberList({
	vaultId,
	members,
	userRole,
}: VaultMemberListProps) {
	const api = useApiClient();
	const rotation = useVaultKeyRotation();
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
		}) =>
			api.vaults.members.updateRole(
				input.vaultId,
				input.userId,
				{
					role: input.role,
				},
				{},
			),
		onSuccess: async () => {
			toast.success(m.vaults_member_list_toast_role_updated());
			await invalidator.invalidateVaultMembers(vaultId);
		},
		onError: () => {
			toast.error(m.vaults_member_list_toast_role_update_failed());
		},
	});

	const handleRoleChange = (
		userId: string,
		newRole: "admin" | "member" | "read-only",
	) => {
		updateRoleMutation.mutate({ vaultId, userId, role: newRole });
	};

	const handleRemove = async (userId: string) => {
		setIsRotating(true);
		setRotatingUserId(userId);

		try {
			const currentUserId = await storage.getActiveAccountUserId();
			if (!currentUserId) {
				throw new Error("session_data_missing");
			}

			const outcome = await rotation.rotate({
				intent: { kind: "vault-member-removal", vaultId, userId },
				currentUserId,
			});
			toast.success(
				m.vaults_member_list_toast_member_removed(),
				outcome.kind === "refresh_required"
					? { description: m.vault_key_rotation_refresh_required() }
					: undefined,
			);
			await invalidator.invalidateVaultMembers(vaultId);
		} catch (error) {
			console.error("Key rotation failed:", error);
			if (error instanceof Error) {
				switch (error.message) {
					case "vault_key_decrypt_failed":
						toast.error(m.vaults_member_list_error_vault_key_decrypt_failed());
						break;
					case "master_unlock_key_missing":
					case "The account is locked.":
						toast.error(m.vaults_member_list_error_master_unlock_key_missing());
						break;
					case "session_data_missing":
						toast.error(m.vaults_member_list_error_session_data_missing());
						break;
					case "rotated_key_missing":
						toast.error(m.vaults_member_list_error_rotated_key_missing());
						break;
					default:
						toast.error(m.vaults_member_list_toast_remove_failed());
						break;
				}
			} else {
				toast.error(m.vaults_member_list_toast_remove_failed());
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
				return m.vaults_common_role_owner();
			case "admin":
				return m.vaults_common_role_admin();
			case "member":
				return m.vaults_common_role_member();
			case "read-only":
				return m.vaults_common_role_read_only();
			default:
				return role;
		}
	};

	// Sort: owner first, then admin, then member, then read-only
	const sortedMembers = [...members].sort((a, b) => {
		const order: Record<string, number> = {
			owner: 0,
			admin: 1,
			member: 2,
			"read-only": 3,
		};
		return (order[a.role] ?? 4) - (order[b.role] ?? 4);
	});

	if (members.length === 0) {
		return (
			<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
				<div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
					<Users className="h-6 w-6 text-muted-foreground" />
				</div>
				<p className="text-muted-foreground">{m.vaults_member_list_empty()}</p>
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
							data-testid="member-row"
							data-member-id={member.userId}
							data-member-email={member.email}
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
										<SelectTrigger
											className="h-7 w-28 text-xs"
											data-testid="member-role-select"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="admin">
												{m.vaults_common_role_admin()}
											</SelectItem>
											<SelectItem value="member">
												{m.vaults_common_role_member()}
											</SelectItem>
											<SelectItem value="read-only">
												{m.vaults_common_role_read_only()}
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
													{m.vaults_member_list_remove_dialog_title()}
												</AlertDialogTitle>
												<AlertDialogDescription>
													{m.vaults_member_list_remove_dialog_description({
														name: member.name,
													})}
													<br />
													<br />
													<span className="text-muted-foreground text-xs">
														{m.vaults_member_list_remove_dialog_rotation_notice()}
													</span>
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel disabled={isRotating}>
													{m.vaults_member_list_remove_dialog_action_cancel()}
												</AlertDialogCancel>
												<AlertDialogAction
													onClick={() => handleRemove(member.userId)}
													disabled={isRotating}
													className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
												>
													{isRotating ? (
														<>
															<Loader2 className="mr-2 h-4 w-4 animate-spin" />
															{m.vaults_member_list_remove_dialog_action_rotating()}
														</>
													) : (
														m.vaults_member_list_remove_dialog_action_confirm()
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
