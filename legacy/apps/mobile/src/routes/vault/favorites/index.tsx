/**
 * The full favorites list. Not a tab — it is pushed from the "Favorites" section label on the
 * Items tab, so it uses `MobileScreen` and has a back affordance.
 */

import { useItemListFilters, useItems } from "@bittery/core/hooks";
import { IconStar } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MobileScreen } from "@/components/mobile-screen";
import { EmptyState, ListCard } from "@/components/ui";
import { MobileItemRow } from "@/components/vault/item-row";
import { ItemsSkeleton } from "@/components/vault/items-skeleton";
import { useFavoriteToggle } from "@/hooks/use-favorite-toggle";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/favorites/")({
	component: FavoritesScreen,
});

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
				<ItemsSkeleton count={4} />
			) : favoriteItems.length === 0 ? (
				<EmptyState
					className="min-h-full"
					icon={IconStar}
					title={m.vaults_favorites_empty_title()}
					description={m.vaults_favorites_empty_description()}
				/>
			) : (
				<div className="px-4 pt-4">
					<ListCard>
						{favoriteItems.map((item) => (
							<MobileItemRow
								key={item.id}
								item={item}
								onSelect={() =>
									navigate({
										to: "/vault/favorites/$itemId",
										params: { itemId: item.id },
									})
								}
								onToggleFavorite={() => handleToggle(item)}
							/>
						))}
					</ListCard>
				</div>
			)}
		</MobileScreen>
	);
}
