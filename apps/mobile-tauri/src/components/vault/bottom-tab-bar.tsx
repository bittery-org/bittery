import {
	IconLayoutGrid,
	IconSearch,
	IconTag,
	IconTrash,
	IconVault,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";

export type TabKey = "vaults" | "all-items" | "tags" | "trash" | "search";

const TABS: Array<{
	key: TabKey;
	to: string;
	icon: typeof IconVault;
}> = [
	{ key: "vaults", to: "/vault", icon: IconVault },
	{ key: "all-items", to: "/vault/all-items", icon: IconLayoutGrid },
	{ key: "tags", to: "/vault/tags", icon: IconTag },
	{ key: "trash", to: "/vault/trash", icon: IconTrash },
	{ key: "search", to: "/vault/search", icon: IconSearch },
];

/**
 * D12 (see `docs/mobile-migration-decisions.md`) — mobile's answer to desktop's sidebar. Five
 * tabs mirror the `mob_tab_*` i18n keys already carried over from the Expo app: Vaults, All
 * Items, Tags, Trash, Search. Favorites has no tab (no surviving key for one); it is reached
 * from the "Favorites" section header on the All Items screen, and via the star toggle on any
 * item row or the item detail screen.
 *
 * Rendered only on the five tab-root screens — pushed screens (`/vault/$id`, any `$itemId`
 * detail, `/vault/tag/$tagName`) render `MobileScreen` instead and have no tab bar, keeping the
 * existing push/back stack intact per the migration brief.
 */
export function BottomTabBar({ active }: { active: TabKey }) {
	const { m } = useI18n();
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (s) => s.location.pathname });

	const labels: Record<TabKey, string> = {
		vaults: m.mob_tab_vaults(),
		"all-items": m.mob_tab_all_items(),
		tags: m.mob_tab_tags(),
		trash: m.mob_tab_trash(),
		search: m.mob_tab_search(),
	};

	return (
		<nav
			className="flex shrink-0 items-stretch border-t bg-background"
			style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
			aria-label={m.mob_tab_vaults()}
		>
			{TABS.map((tab) => {
				const isActive = tab.key === active || pathname === tab.to;
				const Icon = tab.icon;
				return (
					<button
						key={tab.key}
						type="button"
						onClick={() => navigate({ to: tab.to })}
						aria-current={isActive ? "page" : undefined}
						className={cn(
							"flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10.5px]",
							isActive
								? "text-foreground"
								: "text-muted-foreground active:bg-foreground/5",
						)}
					>
						<Icon className={cn("size-5", isActive && "text-primary")} />
						<span className="truncate">{labels[tab.key]}</span>
					</button>
				);
			})}
		</nav>
	);
}
