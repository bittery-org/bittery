import { useTRPC } from "@bittery/shared/trpc";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DownloadCard } from "@/components/dashboard/download-card";
import { PendingInvitations } from "@/components/dashboard/pending-invitations";
import { StatsCards } from "@/components/dashboard/stats-cards";

export const Route = createFileRoute("/_app/home")({
	component: RouteComponent,
});

function RouteComponent() {
	const trpc = useTRPC();
	const userQuery = useQuery(trpc.auth.me.queryOptions());

	return (
		<div className="space-y-6">
			<div>
				<h1 className="font-bold text-3xl tracking-tight">
					Welcome back{userQuery.data?.name ? `, ${userQuery.data.name}` : ""}
				</h1>
				<p className="text-muted-foreground">
					Manage your teams, vaults, and settings from here.
				</p>
			</div>

			<PendingInvitations />
			<StatsCards />
			<DownloadCard />
		</div>
	);
}
