import { useRPC } from "@bittery/shared/rpc";
import { Card, CardContent, Skeleton } from "@bittery/ui";
import {
	IconKeyOutlineDuo18 as Key,
	IconLockOutlineDuo18 as Lock,
	IconEnvelopeOutlineDuo18 as Mail,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useI18n } from "@/providers/i18n-provider";

export function StatsCards() {
	const rpc = useRPC();
	const statsQuery = useQuery(rpc.vault.stats.queryOptions());
	const invitationsQuery = useQuery(
		rpc.team.invitations.pending.queryOptions(),
	);
	const { m } = useI18n();
	const isLoading = statsQuery.isLoading || invitationsQuery.isLoading;

	const stats = [
		{
			id: "teams",
			title: m.dashboard_stats_card_teams_title(),
			value: statsQuery.data?.teamCount ?? 0,
			icon: Users,
			description: m.dashboard_stats_card_teams_description(),
		},
		{
			id: "vaults",
			title: m.dashboard_stats_card_vaults_title(),
			value: statsQuery.data?.vaultCount ?? 0,
			icon: Lock,
			description: m.dashboard_stats_card_vaults_description(),
		},
		{
			id: "items",
			title: m.dashboard_stats_card_items_title(),
			value: statsQuery.data?.itemCount ?? 0,
			icon: Key,
			description: m.dashboard_stats_card_items_description(),
		},
		{
			id: "invites",
			title: m.dashboard_stats_card_invites_title(),
			value: invitationsQuery.data?.length ?? 0,
			icon: Mail,
			description: m.dashboard_stats_card_invites_description(),
		},
	];

	return (
		<div className="grid gap-4 sm:grid-cols-2">
			{stats.map((stat) => (
				<Card key={stat.id} className="gap-4 rounded-lg border bg-card py-5">
					<CardContent className="flex h-full flex-col justify-between gap-4 px-5">
						<div className="flex items-start justify-between gap-3">
							<div className="space-y-1.5">
								<p className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
									{stat.title}
								</p>
								<p className="text-muted-foreground text-sm">
									{stat.description}
								</p>
							</div>
							<div className="inline-flex size-9 items-center justify-center rounded-md border bg-foreground/3 text-muted-foreground">
								<stat.icon className="h-4 w-4" />
							</div>
						</div>

						<div className="font-semibold text-xl tabular-nums">
							{isLoading ? <Skeleton className="h-6 w-16" /> : stat.value}
						</div>
					</CardContent>
				</Card>
			))}
		</div>
	);
}
