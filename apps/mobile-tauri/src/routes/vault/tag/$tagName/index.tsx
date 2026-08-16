/**
 * Items across every vault carrying one tag. Pushed from the tags list, from Browse's Tags
 * segment, from an item's own tag chips, or from a search result.
 */

import { useItemListFilters, useItems } from "@bittery/core/hooks";
import { IconTag } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MobileScreen } from "@/components/mobile-screen";
import { EmptyState, ListCard } from "@/components/ui";
import { MobileItemRow } from "@/components/vault/item-row";
import { ItemsSkeleton } from "@/components/vault/items-skeleton";
import { TagDot } from "@/components/vault/tag-list";
import { useFavoriteToggle } from "@/hooks/use-favorite-toggle";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/tag/$tagName/")({
	component: TagItemsScreen,
});

function TagItemsScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { tagName } = Route.useParams();
	const decodedTagName = decodeURIComponent(tagName);

	const { items: allItems, isLoading } = useItems();
	const { filteredItems: taggedItems } = useItemListFilters({
		items: allItems.filter((item) => item.tags?.includes(decodedTagName)),
	});
	const { handleToggle } = useFavoriteToggle();

	return (
		<MobileScreen
			title={
				<span className="flex min-w-0 items-center gap-2">
					<TagDot name={decodedTagName} />
					<span className="truncate">{decodedTagName}</span>
				</span>
			}
			backLabel={m.mob_common_go_back()}
			onBack={() => navigate({ to: "/vault/tags" })}
		>
			{isLoading ? (
				<ItemsSkeleton count={4} />
			) : taggedItems.length === 0 ? (
				<EmptyState
					className="min-h-full"
					icon={IconTag}
					title={m.mob_tag_filter_empty_title()}
					description={m.mob_tag_filter_empty_no_items_description()}
				/>
			) : (
				<div className="px-4 pt-4">
					<ListCard>
						{taggedItems.map((item) => (
							<MobileItemRow
								key={item.id}
								item={item}
								showVaultName
								onSelect={() =>
									navigate({
										to: "/vault/tag/$tagName/$itemId",
										params: { tagName, itemId: item.id },
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
