import { useTRPC } from "@bittery/shared/trpc";
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
	const trpc = useTRPC();
	const statsQuery = useQuery(trpc.vault.stats.queryOptions());
	const invitationsQuery = useQuery(
		trpc.team.invitations.pending.queryOptions(),
	);
	const { m } = useI18n();
	const isLoading = statsQuery.isLoading || invitationsQuery.isLoading;

	const stats = [
		{
			id: "teams",
			title: m["dashboard.stats.card.teams.title"](),
			value: statsQuery.data?.teamCount ?? 0,
			icon: Users,
			description: m["dashboard.stats.card.teams.description"](),
			barWidth: "45%",
		},
		{
			id: "vaults",
			title: m["dashboard.stats.card.vaults.title"](),
			value: statsQuery.data?.vaultCount ?? 0,
			icon: Lock,
			description: m["dashboard.stats.card.vaults.description"](),
			barWidth: "62%",
		},
		{
			id: "items",
			title: m["dashboard.stats.card.items.title"](),
			value: statsQuery.data?.itemCount ?? 0,
			icon: Key,
			description: m["dashboard.stats.card.items.description"](),
			barWidth: "78%",
		},
		{
			id: "invites",
			title: m["dashboard.stats.card.invites.title"](),
			value: invitationsQuery.data?.length ?? 0,
			icon: Mail,
			description: m["dashboard.stats.card.invites.description"](),
			barWidth: "36%",
		},
	];

	return (
		<div className="grid gap-4 sm:grid-cols-2">
			{stats.map((stat) => (
				<Card
					key={stat.id}
					className="group relative gap-4 overflow-hidden border-border/70 py-5 transition-all hover:-translate-y-0.5 hover:shadow-md"
				>
					<div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-border/80" />
					<CardContent className="flex h-full flex-col justify-between gap-4 px-5">
						<div className="flex items-start justify-between gap-3">
							<div className="space-y-1.5">
								<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.14em]">
									{stat.title}
								</p>
								<p className="text-muted-foreground text-sm">
									{stat.description}
								</p>
							</div>
							<div className="inline-flex size-9 items-center justify-center rounded-md border bg-muted/60 text-muted-foreground">
								<stat.icon className="h-4 w-4" />
							</div>
						</div>

						<div className="space-y-3">
							<div className="font-semibold text-3xl tabular-nums tracking-tight">
								{isLoading ? <Skeleton className="h-9 w-16" /> : stat.value}
							</div>
							<div className="h-1.5 w-full rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-foreground/40 transition-all"
									style={{ width: stat.barWidth }}
								/>
							</div>
						</div>
					</CardContent>
				</Card>
			))}
		</div>
	);
}
