import { useRPC } from "@bittery/shared/rpc";
import { Button } from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DevicesCard } from "@/components/dashboard/devices-card";
import { DownloadCtaCard } from "@/components/dashboard/download-cta-card";
import { PendingInvitations } from "@/components/dashboard/pending-invitations";
import { RecentActivityCard } from "@/components/dashboard/recent-activity-card";
import { SecurityPostureCard } from "@/components/dashboard/security-posture-card";
import { StatStrip } from "@/components/dashboard/stat-strip";
import { VaultsCard } from "@/components/dashboard/vaults-card";
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
			{/* Hero — reuses the sanctioned item-detail title-glow recipe */}
			<div className="relative">
				<div
					aria-hidden
					className="pointer-events-none absolute -top-10 -left-5 h-[200px] w-[340px] bg-[radial-gradient(60%_60%_at_30%_40%,color-mix(in_oklab,var(--color-primary-deep)_6%,transparent),transparent_70%)] dark:bg-[radial-gradient(60%_60%_at_30%_40%,color-mix(in_oklab,var(--color-primary-deep)_9%,transparent),transparent_70%)]"
				/>
				<div className="relative flex items-center gap-3">
					<div className="min-w-0">
						<h1 className="truncate font-semibold text-xl tracking-[-0.015em]">
							{name
								? m.dashboard_home_greeting_named({ name })
								: m.dashboard_home_greeting_default()}
						</h1>
						<p className="mt-0.5 text-muted-foreground text-sm">
							{m.dashboard_home_hero_subtitle()}
						</p>
					</div>
					<div className="ml-auto flex shrink-0 items-center gap-2">
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
			</div>

			<StatStrip />

			<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
				<div className="flex flex-col gap-4">
					<SecurityPostureCard />
					<RecentActivityCard />
				</div>

				<div className="flex flex-col gap-4 xl:sticky xl:top-6 xl:self-start">
					<VaultsCard />
					<PendingInvitations />
					<DownloadCtaCard />
					<DevicesCard />
				</div>
			</div>
		</div>
	);
}
