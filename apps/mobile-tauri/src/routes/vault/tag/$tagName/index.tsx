/**
 * M3-C2 — items across every vault carrying one tag. Pushed from `/vault/tags`, from the
 * per-item "Tags" list (tapping a tag), or from a search result tag. Mirrors desktop's
 * `/vault/tag/$tagName` (`apps/desktop/src/routes/vault/tag/$tagName/route.tsx`).
 */

import { useItemListFilters, useItems } from "@bittery/core/hooks";
import { getTagColorFromName, Skeleton } from "@bittery/ui";
import { IconTag } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MobileScreen } from "@/components/mobile-screen";
import { MobileItemRow } from "@/components/vault/item-row";
import { useFavoriteToggle } from "@/hooks/use-favorite-toggle";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/tag/$tagName/")({
	component: TagItemsScreen,
});

function TagItemsSkeleton() {
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

function TagItemsScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { tagName } = Route.useParams();
	const decodedTagName = decodeURIComponent(tagName);
	const tagColor = getTagColorFromName(decodedTagName);

	const { items: allItems, isLoading } = useItems();
	const { filteredItems: taggedItems } = useItemListFilters({
		items: allItems.filter((item) => item.tags?.includes(decodedTagName)),
	});
	const { handleToggle } = useFavoriteToggle();

	return (
		<MobileScreen
			title={
				<span className="inline-flex items-center gap-1.5">
					<IconTag className="size-3.5 shrink-0" style={{ color: tagColor }} />
					<span className="truncate">{decodedTagName}</span>
				</span>
			}
			backLabel={m.mob_common_go_back()}
			onBack={() => navigate({ to: "/vault/tags" })}
		>
			{isLoading ? (
				<TagItemsSkeleton />
			) : taggedItems.length === 0 ? (
				<div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
					<h2 className="font-semibold text-lg">
						{m.mob_tag_filter_empty_title()}
					</h2>
					<p className="text-muted-foreground text-sm">
						{m.mob_tag_filter_empty_no_items_description()}
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-px p-1.5">
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
				</div>
			)}
		</MobileScreen>
	);
}
