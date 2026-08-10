import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
import { Badge, Button, VaultAvatar } from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";

export function VaultsCard() {
	const api = useApiClient();
	const vaultsQuery = useQuery(apiQueries.vaults.list(api));
	const { m } = useI18n();
	const vaults = vaultsQuery.data ?? [];

	return (
		<section className="rounded-lg border bg-card">
			<div className="flex items-center gap-3 border-b p-4">
				<h2 className="min-w-0 flex-1 font-medium text-sm">
					{m.dashboard_stats_card_vaults_title()}
				</h2>
				<Button variant="ghost" size="sm" asChild>
					<Link to="/vaults">{m.dashboard_home_view_all()}</Link>
				</Button>
			</div>
			{vaults.length > 0 ? (
				<div className="divide-y">
					{vaults.slice(0, 5).map((vault) => (
						<Link
							key={vault.id}
							to="/vaults/$vaultId"
							params={{ vaultId: vault.id }}
							search={{}}
							className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-foreground/4"
						>
							<VaultAvatar
								name={vault.name}
								icon={vault.icon}
								imageUrl={vault.imageUrl}
								size="sm"
							/>
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium text-sm">{vault.name}</p>
								<p className="mt-0.5 text-muted-foreground text-xs">
									{vault.items.length === 1
										? m.dashboard_home_items_count_single({ count: 1 })
										: m.dashboard_home_items_count_plural({
												count: vault.items.length,
											})}
								</p>
							</div>
							<Badge
								variant="outline"
								className="shrink-0 text-[10px] text-muted-foreground"
							>
								{vault.role}
							</Badge>
						</Link>
					))}
				</div>
			) : (
				<p className="px-4 py-3 text-muted-foreground text-sm">
					{m.dashboard_home_vaults_empty()}
				</p>
			)}
		</section>
	);
}
