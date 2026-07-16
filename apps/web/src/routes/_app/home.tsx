import { useRPC } from "@bittery/shared/rpc";
import { Button } from "@bittery/ui";
import { IconMagicShieldOutlineDuo18 as ShieldCheck } from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DownloadCard } from "@/components/dashboard/download-card";
import { PendingInvitations } from "@/components/dashboard/pending-invitations";
import { StatsCards } from "@/components/dashboard/stats-cards";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/home")({
	component: RouteComponent,
	head: () => ({
		meta: [{ title: "Dashboard - Bittery" }],
	}),
});

function RouteComponent() {
	const rpc = useRPC();
	const userQuery = useQuery(rpc.auth.me.queryOptions());
	const { m } = useI18n();
	const name = userQuery.data?.name;

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 pb-3">
			<div className="flex items-center gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
					<ShieldCheck className="size-4" />
				</div>
				<div className="min-w-0">
					<h1 className="truncate font-semibold text-lg tracking-[-0.015em]">
						{name
							? m.dashboard_home_hero_heading_named({ name })
							: m.dashboard_home_hero_heading_default()}
					</h1>
					<p className="text-muted-foreground text-xs">
						{m.dashboard_home_hero_description()}
					</p>
				</div>

				<div className="ml-auto flex items-center gap-2">
					<Button variant="outline" size="sm" asChild>
						<Link to="/settings">
							{m.dashboard_home_button_account_settings()}
						</Link>
					</Button>
					<Button size="sm" asChild>
						<Link to="/vaults">{m.dashboard_home_button_open_vaults()}</Link>
					</Button>
				</div>
			</div>

			<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
				<div className="space-y-4">
					<section className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
								{m.dashboard_home_metrics_heading()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m.dashboard_home_metrics_description()}
							</p>
						</div>
						<StatsCards />
					</section>

					<PendingInvitations />
				</div>

				<div className="xl:sticky xl:top-6 xl:self-start">
					<DownloadCard />
				</div>
			</div>
		</div>
	);
}
