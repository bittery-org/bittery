import type { TeamMember } from "@bittery/api-contract";
import { formatDate } from "@bittery/i18n/format/browser";
import {
	Avatar,
	AvatarFallback,
	Badge,
	Button,
	ConfirmDialog,
	toast,
} from "@bittery/ui";
import { IconUser as UserMinus } from "@bittery/ui/icons";
import { useState } from "react";
import { useVaultKeyRotation } from "@/hooks/use-vault-key-rotation";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";
import { TeamRotationError } from "./team-rotation-error";

interface MemberListProps {
	teamId: string;
	members: readonly TeamMember[];
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
	const rotation = useVaultKeyRotation();
	const invalidator = useQueryInvalidator();
	const [removingUserId, setRemovingUserId] = useState<string | null>(null);
	const [isRotating, setIsRotating] = useState(false);
	const { m } = useI18n();

	const handleRemoveMember = async (userId: string) => {
		setIsRotating(true);
		setRemovingUserId(userId);

		try {
			const currentUserId = await storage.getActiveAccountUserId();
			if (!currentUserId) {
				throw new TeamRotationError("SESSION_DATA_MISSING");
			}

			const outcome = await rotation.rotate({
				intent: { kind: "team-member-removal", teamId, userId },
				currentUserId,
			});
			toast.success(
				m.team_members_toast_remove_success(),
				outcome.kind === "refresh_required"
					? { description: m.vault_key_rotation_refresh_required() }
					: undefined,
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

	const getRoleLabel = (role: TeamMember["role"]) => {
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

	const getRoleBadgeVariant = (role: TeamMember["role"]) => {
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
									<ConfirmDialog
										trigger={
											<Button
												variant="ghost"
												size="sm"
												disabled={isBusy}
												className="h-7 gap-1.5 px-2 text-muted-foreground text-xs hover:text-foreground"
											>
												<UserMinus className="h-3.5 w-3.5" />
												{m.team_members_action_remove()}
											</Button>
										}
										title={m.team_members_remove_dialog_title()}
										description={m.team_members_remove_dialog_description({
											name: member.name,
										})}
										cancelLabel={m.team_common_action_cancel()}
										confirmLabel={
											removingUserId === member.userId
												? m.team_members_remove_dialog_action_removing()
												: m.team_members_remove_dialog_action_confirm()
										}
										onConfirm={() => handleRemoveMember(member.userId)}
										busy={isBusy}
									/>
								</div>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}
