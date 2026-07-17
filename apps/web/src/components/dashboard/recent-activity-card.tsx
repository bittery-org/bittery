import { useItems } from "@bittery/core/hooks";
import { Button } from "@bittery/ui";
import { IconChevronRight as ArrowRight } from "@bittery/ui/icons";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { de as dateFnsDe, enUS as dateFnsEnUS } from "date-fns/locale";
import { useMemo } from "react";
import { Favicon } from "@/components/vault/favicon";
import { useI18n } from "@/providers/i18n-provider";

export function RecentActivityCard() {
	const { m, locale } = useI18n();
	const dateLocale = locale === "de" ? dateFnsDe : dateFnsEnUS;
	const { items } = useItems();

	const recentItems = useMemo(
		() =>
			[...items]
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
				.slice(0, 6),
		[items],
	);

	return (
		<section className="rounded-lg border bg-card">
			<div className="flex items-center gap-3 border-b p-4">
				<div className="min-w-0 flex-1">
					<h2 className="font-medium text-sm">
						{m.dashboard_home_recent_title()}
					</h2>
					<p className="mt-0.5 text-muted-foreground text-xs">
						{m.dashboard_home_recent_description()}
					</p>
				</div>
				<Button variant="ghost" size="sm" asChild>
					<Link to="/vaults">
						{m.dashboard_home_view_all()}
						<ArrowRight className="ml-1 size-3.5" />
					</Link>
				</Button>
			</div>
			{recentItems.length > 0 ? (
				<div className="divide-y">
					{recentItems.map((item) => (
						<Link
							key={item.id}
							to="/vaults/$vaultId"
							params={{ vaultId: item.vaultId }}
							search={{ itemId: item.id }}
							className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-foreground/4"
						>
							<Favicon item={item} size="sm" />
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium text-sm">{item.title}</p>
								<p className="mt-0.5 truncate text-muted-foreground text-xs">
									{item.vault?.name}
								</p>
							</div>
							<span className="shrink-0 text-muted-foreground text-xs">
								{m.dashboard_home_updated_time({
									time: formatDistanceToNow(new Date(item.updatedAt), {
										addSuffix: true,
										locale: dateLocale,
									}),
								})}
							</span>
						</Link>
					))}
				</div>
			) : (
				<p className="px-4 py-3 text-muted-foreground text-sm">
					{m.dashboard_home_recent_empty()}
				</p>
			)}
		</section>
	);
}
