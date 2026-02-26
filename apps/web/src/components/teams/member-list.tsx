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
import {
	IconTrash2OutlineDuo18 as Trash2,
	IconUserOutlineDuo18 as UserMinus,
} from "@bittery/ui/icons";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
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
	const [deletingUserId, setDeletingUserId] = useState<string | null>(null);

	const canManageMembers =
		currentUserRole === "owner" || currentUserRole === "admin";
	const canPermanentlyDelete = currentUserRole === "owner";

	const removeMemberMutation = useMutation({
		mutationFn: (input: { teamId: string; userId: string }) =>
			trpcClient.team.members.remove.mutate(input),
		onSuccess: async (data) => {
			toast.success("Member removed from team");
			if (data.warning === "rotate_shared_credentials") {
				toast.info(
					"Shared credentials this user could access should be rotated.",
				);
			}
			await invalidator.invalidateTeam();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSettled: () => {
			setRemovingUserId(null);
		},
	});

	const deleteAccountMutation = useMutation({
		mutationFn: (input: { teamId: string; userId: string }) =>
			trpcClient.team.members.deleteAccount.mutate({
				...input,
				confirmation: "DELETE",
			}),
		onSuccess: async () => {
			toast.success("Account permanently deleted");
			await invalidator.invalidateTeam();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSettled: () => {
			setDeletingUserId(null);
		},
	});

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

	const isBusy =
		removeMemberMutation.isPending || deleteAccountMutation.isPending;

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
				const canDelete =
					canPermanentlyDelete && !isCurrentUser && member.role !== "owner";

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

							{canManageMembers && (canRemove || canDelete) && (
								<div className="flex items-center gap-1">
									{canRemove && (
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
														Remove {member.name} from this team? Their current
														sessions will be invalidated and their team vault
														access will be revoked.
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel disabled={isBusy}>
														Cancel
													</AlertDialogCancel>
													<AlertDialogAction
														disabled={isBusy}
														onClick={() => {
															setRemovingUserId(member.userId);
															removeMemberMutation.mutate({
																teamId,
																userId: member.userId,
															});
														}}
													>
														{removingUserId === member.userId
															? "Removing..."
															: "Remove member"}
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									)}

									{canDelete && (
										<AlertDialog>
											<AlertDialogTrigger asChild>
												<Button
													variant="ghost"
													size="sm"
													disabled={isBusy}
													className="h-7 gap-1.5 px-2 text-destructive text-xs hover:bg-destructive/10 hover:text-destructive"
												>
													<Trash2 className="h-3.5 w-3.5" />
													Delete
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>
														Delete Account Permanently
													</AlertDialogTitle>
													<AlertDialogDescription>
														This permanently deletes {member.name}'s account and
														all associated data. This action cannot be undone.
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel disabled={isBusy}>
														Cancel
													</AlertDialogCancel>
													<AlertDialogAction
														disabled={isBusy}
														onClick={() => {
															setDeletingUserId(member.userId);
															deleteAccountMutation.mutate({
																teamId,
																userId: member.userId,
															});
														}}
													>
														{deletingUserId === member.userId
															? "Deleting..."
															: "Delete permanently"}
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									)}
								</div>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}
