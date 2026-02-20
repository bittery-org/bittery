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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
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

	const isBusy =
		removeMemberMutation.isPending || deleteAccountMutation.isPending;

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Member</TableHead>
					<TableHead>Role</TableHead>
					<TableHead>Joined</TableHead>
					{canManageMembers && (
						<TableHead className="w-[180px]">Actions</TableHead>
					)}
				</TableRow>
			</TableHeader>
			<TableBody>
				{members.map((member) => {
					const isCurrentUser = member.userId === currentUserId;
					const canRemove =
						canManageMembers && !isCurrentUser && member.role !== "owner";
					const canDelete =
						canPermanentlyDelete && !isCurrentUser && member.role !== "owner";

					return (
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
								<Badge
									variant={member.role === "owner" ? "default" : "secondary"}
								>
									{getRoleLabel(member.role)}
								</Badge>
							</TableCell>
							<TableCell className="text-muted-foreground">
								{member.joinedAt
									? new Date(member.joinedAt).toLocaleDateString()
									: "—"}
							</TableCell>
							{canManageMembers && (
								<TableCell>
									<div className="flex items-center gap-2">
										{canRemove && (
											<AlertDialog>
												<AlertDialogTrigger asChild>
													<Button variant="outline" size="sm" disabled={isBusy}>
														<UserMinus className="mr-2 h-4 w-4" />
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
														variant="destructive"
														size="sm"
														disabled={isBusy}
													>
														<Trash2 className="mr-2 h-4 w-4" />
														Delete permanently
													</Button>
												</AlertDialogTrigger>
												<AlertDialogContent>
													<AlertDialogHeader>
														<AlertDialogTitle>
															Delete Account Permanently
														</AlertDialogTitle>
														<AlertDialogDescription>
															This permanently deletes {member.name}'s account
															and all associated data. This action cannot be
															undone.
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
								</TableCell>
							)}
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
