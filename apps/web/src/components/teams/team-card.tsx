import { Badge, Card, CardContent, CardHeader, CardTitle } from "@bittery/ui";
import { Link } from "@tanstack/react-router";
import { Users } from "lucide-react";

interface TeamCardProps {
	id: string;
	name: string;
	role: string;
	memberCount: number;
}

export function TeamCard({ id, name, role, memberCount }: TeamCardProps) {
	return (
		<Link to="/teams/$teamId" params={{ teamId: id }}>
			<Card className="cursor-pointer transition-colors hover:bg-muted/50">
				<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
					<CardTitle className="font-medium text-lg">{name}</CardTitle>
					<Badge variant={role === "owner" ? "default" : "secondary"}>
						{role}
					</Badge>
				</CardHeader>
				<CardContent>
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Users className="h-4 w-4" />
						<span>
							{memberCount} member{memberCount !== 1 ? "s" : ""}
						</span>
					</div>
				</CardContent>
			</Card>
		</Link>
	);
}
