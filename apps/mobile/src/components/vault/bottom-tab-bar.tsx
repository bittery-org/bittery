import { IconLayoutGrid, IconLibrary, IconSettings } from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { TabBar } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

export type TabKey = "items" | "browse" | "settings";

/**
 * Three tabs, matching `apps/mobile` (DESIGN-NATIVE.md § Information architecture):
 *
 * | Items    | `/vault/all-items` | every item, sectioned, with the search action and the FAB |
 * | Browse   | `/vault`           | segmented Vaults / Tags                                   |
 * | Settings | `/vault/settings`  | grouped setting cards                                     |
 *
 * This replaces the five-tab bar the migration shipped (Vaults, All Items, Tags, Trash,
 * Search). Five destinations is a desktop sidebar wearing a tab bar: two of them were not
 * destinations at all. **Search** is a mode of Items — the app-bar action swaps the bar for
 * a focused field — and **Trash** is a rare, reversible place that belongs in the account
 * sheet and in Settings, not in the app's primary navigation.
 *
 * `/vault/tags`, `/vault/trash` and `/vault/search` all stay routable; Browse, the account
 * sheet and the Items app bar push into them.
 *
 * Rendered only on the three tab-root screens — pushed screens (`/vault/$id`, any `$itemId`
 * detail, `/vault/tag/$tagName`) render `MobileScreen` and have no tab bar.
 */
export function BottomTabBar({ active }: { active: TabKey }) {
	const { m } = useI18n();
	const navigate = useNavigate();

	return (
		<TabBar
			active={active}
			ariaLabel={m.mob_tab_vaults()}
			tabs={[
				{
					key: "items",
					label: m.mob_tab_all_items(),
					icon: IconLayoutGrid,
					onSelect: () => void navigate({ to: "/vault/all-items" }),
				},
				{
					key: "browse",
					label: m.mob_browse_title(),
					// `IconVault` reads as an ambiguous boxed X at 20px. `IconLibrary` is what
					// `apps/mobile` uses for the same tab, so both apps now match.
					icon: IconLibrary,
					onSelect: () => void navigate({ to: "/vault" }),
				},
				{
					key: "settings",
					label: m.mob_settings_title(),
					icon: IconSettings,
					onSelect: () => void navigate({ to: "/vault/settings" }),
				},
			]}
		/>
	);
}
