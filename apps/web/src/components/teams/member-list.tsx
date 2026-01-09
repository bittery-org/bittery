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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

interface Member {
	id: string;
	userId: string;
	name: string;
	email: string;
	role: "owner" | "admin" | "member";
	joinedAt: Date | null;
}

interface MemberListProps {
	teamId: string;
	members: Member[];
	userRole: string;
}

export function MemberList({ teamId, members, userRole }: MemberListProps) {
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const canManage = userRole === "owner" || userRole === "admin";

	const updateRoleMutation = useMutation({
		mutationFn: (input: { teamId: string; userId: string; role: "admin" | "member" }) =>
			trpcClient.team.members.updateRole.mutate(input),
		onSuccess: () => {
			toast.success("Role updated");
			queryClient.invalidateQueries({ queryKey: ["team"] });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const removeMutation = useMutation({
		mutationFn: (input: { teamId: string; userId: string }) =>
			trpcClient.team.members.remove.mutate(input),
		onSuccess: () => {
			toast.success("Member removed");
			queryClient.invalidateQueries({ queryKey: ["team"] });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleRoleChange = (userId: string, newRole: "admin" | "member") => {
		updateRoleMutation.mutate({ teamId, userId, role: newRole });
	};

	const handleRemove = (userId: string) => {
		removeMutation.mutate({ teamId, userId });
	};

	const getInitials = (name: string) =>
		name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Member</TableHead>
					<TableHead>Role</TableHead>
					<TableHead>Joined</TableHead>
					{canManage && <TableHead className="w-[100px]">Actions</TableHead>}
				</TableRow>
			</TableHeader>
			<TableBody>
				{members.map((member) => (
					<TableRow key={member.id}>
						<TableCell>
							<div className="flex items-center gap-3">
								<Avatar className="h-8 w-8">
									<AvatarFallback className="text-xs">
										{getInitials(member.name)}
									</AvatarFallback>
								</Avatar>
								<div>
									<div className="font-medium">{member.name}</div>
									<div className="text-sm text-muted-foreground">
										{member.email}
									</div>
								</div>
							</div>
						</TableCell>
						<TableCell>
							{canManage && member.role !== "owner" ? (
								<Select
									value={member.role}
									onValueChange={(value: "admin" | "member") =>
										handleRoleChange(member.userId, value)
									}
									disabled={
										updateRoleMutation.isPending ||
										(userRole === "admin" && member.role === "admin")
									}
								>
									<SelectTrigger className="w-[100px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="admin">Admin</SelectItem>
										<SelectItem value="member">Member</SelectItem>
									</SelectContent>
								</Select>
							) : (
								<Badge
									variant={member.role === "owner" ? "default" : "secondary"}
								>
									{member.role}
								</Badge>
							)}
						</TableCell>
						<TableCell className="text-muted-foreground">
							{member.joinedAt
								? new Date(member.joinedAt).toLocaleDateString()
								: "—"}
						</TableCell>
						{canManage && (
							<TableCell>
								{member.role !== "owner" &&
									!(userRole === "admin" && member.role === "admin") && (
										<AlertDialog>
											<AlertDialogTrigger asChild>
												<Button variant="ghost" size="icon">
													<Trash2 className="h-4 w-4 text-destructive" />
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>Remove Member</AlertDialogTitle>
													<AlertDialogDescription>
														Are you sure you want to remove {member.name} from
														this team? They will lose access to all team vaults.
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel>Cancel</AlertDialogCancel>
													<AlertDialogAction
														onClick={() => handleRemove(member.userId)}
													>
														Remove
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
