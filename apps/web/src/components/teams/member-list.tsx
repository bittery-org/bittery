import {
	Avatar,
	AvatarFallback,
	Badge,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@bittery/ui";

interface Member {
	userId: string;
	name: string;
	email: string;
	role: "owner" | "admin" | "member";
	joinedAt: string | null;
}

interface MemberListProps {
	members: Member[];
}

export function MemberList({ members }: MemberListProps) {
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
							<Badge
								variant={member.role === "owner" ? "default" : "secondary"}
							>
								{member.role}
							</Badge>
						</TableCell>
						<TableCell className="text-muted-foreground">
							{member.joinedAt
								? new Date(member.joinedAt).toLocaleDateString()
								: "—"}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
