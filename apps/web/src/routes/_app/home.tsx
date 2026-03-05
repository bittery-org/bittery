import { useTRPC } from "@bittery/shared/trpc";
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
	const trpc = useTRPC();
	const userQuery = useQuery(trpc.auth.me.queryOptions());
	const { m } = useI18n();
	const name = userQuery.data?.name;

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
			<section className="relative overflow-hidden rounded-2xl border bg-card p-3 sm:p-5">
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent" />

				<div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex min-w-0 items-center gap-3">
						<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted shadow-sm sm:h-10 sm:w-10">
							<ShieldCheck className="h-4 w-4 text-muted-foreground sm:h-5 sm:w-5" />
						</div>
						<div className="min-w-0">
							<h1 className="truncate font-semibold text-lg tracking-tight sm:text-xl">
								{name
									? m["dashboard.home.hero_heading.named"]({ name })
									: m["dashboard.home.hero_heading.default"]()}
							</h1>
							<p className="text-muted-foreground text-xs">
								{m["dashboard.home.hero_description"]()}
							</p>
						</div>
					</div>

					<div className="flex items-center gap-2 sm:shrink-0">
						<Button variant="outline" size="sm" className="h-8 px-2 sm:px-3" asChild>
							<Link to="/settings">
								<span className="text-xs">{m["dashboard.home.button.account_settings"]()}</span>
							</Link>
						</Button>
						<Button size="sm" className="h-8 px-2 sm:px-3" asChild>
							<Link to="/vaults">
								<span className="text-xs">{m["dashboard.home.button.open_vaults"]()}</span>
							</Link>
						</Button>
					</div>
				</div>
			</section>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
				<div className="space-y-6">
					<section className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								{m["dashboard.home.metrics_heading"]()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m["dashboard.home.metrics_description"]()}
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
