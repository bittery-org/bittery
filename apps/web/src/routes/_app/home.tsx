import { useTRPC } from "@bittery/shared/trpc";
import { Badge, Button } from "@bittery/ui";
import {
	IconMagicShieldOutlineDuo18 as ShieldCheck,
	IconVault3OutlineDuo18 as Vault,
} from "@bittery/ui/icons";
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
			<section className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-7">
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent" />
				<div className="pointer-events-none absolute -top-24 right-0 h-56 w-56 rounded-full bg-muted/50 blur-3xl" />

				<div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
					<div className="space-y-4">
						<Badge variant="secondary" className="w-fit">
							{m["dashboard.home.hero_badge"]()}
						</Badge>
						<div className="space-y-2">
							<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl">
								{name
									? m["dashboard.home.hero_heading.named"]({ name })
									: m["dashboard.home.hero_heading.default"]()}
							</h1>
							<p className="max-w-2xl text-muted-foreground">
								{m["dashboard.home.hero_description"]()}
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
							<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
								<ShieldCheck className="h-3.5 w-3.5" />
								{m["dashboard.home.hero_pill.zero_knowledge"]()}
							</div>
							<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
								<Vault className="h-3.5 w-3.5" />
								{m["dashboard.home.hero_pill.vault_activity"]()}
							</div>
						</div>
					</div>

					<div className="flex flex-wrap gap-2 lg:justify-end">
						<Button asChild>
							<Link to="/vaults">
								{m["dashboard.home.button.open_vaults"]()}
							</Link>
						</Button>
						<Button variant="outline" asChild>
							<Link to="/settings">
								{m["dashboard.home.button.account_settings"]()}
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
