/**
 * M3-C2 — the full favorites list. Not a bottom-tab screen (see the nav decision in
 * `docs/mobile-migration-decisions.md`) — reached from the "Favorites" section header on
 * `/vault/all-items`, or by favoriting an item anywhere. Pushed like a vault's item list, so it
 * uses `MobileScreen`, not `TabScreen`.
 */

import { useItemListFilters, useItems } from "@bittery/core/hooks";
import { Skeleton } from "@bittery/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MobileScreen } from "@/components/mobile-screen";
import { MobileItemRow } from "@/components/vault/item-row";
import { useFavoriteToggle } from "@/hooks/use-favorite-toggle";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/favorites/")({
	component: FavoritesScreen,
});

function FavoritesSkeleton() {
	return (
		<div className="flex flex-col gap-px p-1.5">
			{[0, 1, 2].map((row) => (
				<div key={row} className="flex items-center gap-2.5 px-2.5 py-2">
					<Skeleton className="size-10 rounded-lg" />
					<div className="flex-1 space-y-1.5">
						<Skeleton className="h-3.5 w-40" />
						<Skeleton className="h-3 w-24" />
					</div>
				</div>
			))}
		</div>
	);
}

function FavoritesScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { items, isLoading } = useItems();
	const { filteredItems: favoriteItems } = useItemListFilters({
		items: items.filter((item) => item.favorite),
	});
	const { handleToggle } = useFavoriteToggle();

	return (
		<MobileScreen
			title={m.vaults_favorites_title()}
			backLabel={m.mob_common_go_back()}
			onBack={() => navigate({ to: "/vault/all-items" })}
		>
			{isLoading ? (
				<FavoritesSkeleton />
			) : favoriteItems.length === 0 ? (
				<div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
					<h2 className="font-semibold text-lg">
						{m.vaults_favorites_empty_title()}
					</h2>
					<p className="text-muted-foreground text-sm">
						{m.vaults_favorites_empty_description()}
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-px p-1.5">
					{favoriteItems.map((item) => (
						<MobileItemRow
							key={item.id}
							item={item}
							showVaultName
							onSelect={() =>
								navigate({
									to: "/vault/favorites/$itemId",
									params: { itemId: item.id },
								})
							}
							onToggleFavorite={() => handleToggle(item)}
						/>
					))}
				</div>
			)}
		</MobileScreen>
	);
}
