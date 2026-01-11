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
	const queryClient = useQueryClient();
	const canManage = userRole === "owner" || userRole === "admin";

	const updateRoleMutation = useMutation({
		mutationFn: (input: {
			vaultId: string;
			userId: string;
			role: "admin" | "member" | "read-only";
		}) => trpcClient.vault.members.updateRole.mutate(input),
		onSuccess: () => {
			toast.success("Role updated");
			queryClient.invalidateQueries({ queryKey: ["vault"] });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const removeMutation = useMutation({
		mutationFn: (input: { vaultId: string; userId: string }) =>
			trpcClient.vault.members.remove.mutate(input),
		onSuccess: () => {
			toast.success("Member removed");
			queryClient.invalidateQueries({ queryKey: ["vault"] });
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

	const handleRemove = (userId: string) => {
		removeMutation.mutate({ vaultId, userId });
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
												<Button variant="ghost" size="icon">
													<Trash2 className="h-4 w-4 text-destructive" />
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>Remove Member</AlertDialogTitle>
													<AlertDialogDescription>
														Are you sure you want to remove {member.name} from
														this vault? They will lose access to all items in
														this vault.
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
