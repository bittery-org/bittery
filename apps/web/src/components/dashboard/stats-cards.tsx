import { useTRPC } from "@bittery/shared/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { Key, Lock, Users } from "lucide-react";

export function StatsCards() {
	const trpc = useTRPC();
	const statsQuery = useQuery(trpc.vault.stats.queryOptions());

	const stats = [
		{
			title: "Teams",
			value: statsQuery.data?.teamCount ?? 0,
			icon: Users,
			description: "Teams you belong to",
		},
		{
			title: "Vaults",
			value: statsQuery.data?.vaultCount ?? 0,
			icon: Lock,
			description: "Accessible vaults",
		},
		{
			title: "Items",
			value: statsQuery.data?.itemCount ?? 0,
			icon: Key,
			description: "Stored credentials",
		},
	];

	return (
		<div className="grid gap-4 md:grid-cols-3">
			{stats.map((stat) => (
				<Card key={stat.title}>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="font-medium text-sm">{stat.title}</CardTitle>
						<stat.icon className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="font-bold text-2xl">
							{statsQuery.isLoading ? "..." : stat.value}
						</div>
						<p className="text-muted-foreground text-xs">{stat.description}</p>
					</CardContent>
				</Card>
			))}
		</div>
	);
}
