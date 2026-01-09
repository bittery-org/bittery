import { useTRPC } from "@bittery/shared/trpc";
import { Skeleton } from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
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
					<h1 className="text-3xl font-bold tracking-tight">Teams</h1>
					<p className="text-muted-foreground">
						Manage your teams and collaborate with others.
					</p>
				</div>
				<CreateTeamDialog />
			</div>

			{teamsQuery.isLoading ? (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{[1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-32" />
					))}
				</div>
			) : teamsQuery.data?.length === 0 ? (
				<div className="rounded-lg border border-dashed p-8 text-center">
					<h3 className="text-lg font-medium">No teams yet</h3>
					<p className="mt-1 text-sm text-muted-foreground">
						Create a team to start collaborating with others.
					</p>
				</div>
			) : (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{teamsQuery.data?.map((team) => (
						<TeamCard
							key={team.id}
							id={team.id}
							name={team.name}
							role={team.role}
							memberCount={team.memberCount}
						/>
					))}
				</div>
			)}
		</div>
	);
}
