import { useTRPC } from "@bittery/shared/trpc";
import { Skeleton } from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { TeamCard } from "@/components/teams/team-card";

export const Route = createFileRoute("/_app/teams/")({
	component: TeamsPage,
});

function TeamsPage() {
	const trpc = useTRPC();
	const teamsQuery = useQuery(trpc.team.list.queryOptions());

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="font-bold text-3xl tracking-tight">Teams</h1>
					<p className="text-muted-foreground">
						Manage your team and collaborate with others.
					</p>
				</div>
			</div>

			{teamsQuery.isLoading ? (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					<Skeleton className="h-32" />
				</div>
			) : !teamsQuery.data ? (
				<div className="rounded-lg border border-dashed p-8 text-center">
					<h3 className="font-medium text-lg">No team yet</h3>
					<p className="mt-1 text-muted-foreground text-sm">
						You don't have a team. This should not happen.
					</p>
				</div>
			) : (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					<TeamCard
						key={teamsQuery.data.id}
						id={teamsQuery.data.id}
						name={teamsQuery.data.name}
						role={teamsQuery.data.role}
						memberCount={teamsQuery.data.memberCount}
					/>
				</div>
			)}
		</div>
	);
}
