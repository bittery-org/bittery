import { useRPC } from "@bittery/shared/rpc";
import { Skeleton } from "@bittery/ui";
import {
	IconKeyOutlineDuo18 as Key,
	IconLaptop2OutlineDuo18 as Laptop,
	IconLockOutlineDuo18 as Lock,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useI18n } from "@/providers/i18n-provider";

export function StatStrip() {
	const rpc = useRPC();
	const statsQuery = useQuery(rpc.vault.stats.queryOptions());
	const devicesQuery = useQuery(rpc.auth.listDevices.queryOptions());
	const { m } = useI18n();
	const isLoading = statsQuery.isLoading || devicesQuery.isLoading;

	const cells = [
		{
			id: "vaults",
			label: m.dashboard_stats_card_vaults_title(),
			value: Number(statsQuery.data?.vaultCount ?? 0),
			icon: Lock,
		},
		{
			id: "items",
			label: m.dashboard_stats_card_items_title(),
			value: Number(statsQuery.data?.itemCount ?? 0),
			icon: Key,
		},
		{
			id: "teams",
			label: m.dashboard_stats_card_teams_title(),
			value: Number(statsQuery.data?.teamCount ?? 0),
			icon: Users,
		},
		{
			id: "devices",
			label: m.dashboard_home_devices_title(),
			value: devicesQuery.data?.length ?? 0,
			icon: Laptop,
		},
	];

	return (
		<div className="grid grid-cols-2 rounded-lg border bg-card sm:grid-cols-4 sm:divide-x">
			{cells.map((cell) => (
				<div key={cell.id} className="flex items-center gap-3 px-4 py-3.5">
					<div className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border bg-foreground/3 text-muted-foreground">
						<cell.icon className="size-4" />
					</div>
					<div className="min-w-0">
						<p className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
							{cell.label}
						</p>
						<p className="font-semibold text-lg tabular-nums leading-6">
							{isLoading ? <Skeleton className="mt-1 h-5 w-10" /> : cell.value}
						</p>
					</div>
				</div>
			))}
		</div>
	);
}
