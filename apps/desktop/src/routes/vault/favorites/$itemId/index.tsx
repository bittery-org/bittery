import { useAvailableTags, useItems } from "@bittery/hooks";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { ItemDetailPage } from "../../../../components/vault/item-detail-page";

export const Route = createFileRoute("/vault/favorites/$itemId/")({
	component: FavoritesItemComponent,
});

function FavoritesItemComponent() {
	const { itemId } = Route.useParams();
	const navigate = useNavigate();

	// Unified hook - automatically handles single-account vs "All Accounts" mode
	const { items: allItems } = useItems();
	const availableTags = useAvailableTags(allItems);

	// Get vault info from the item
	const currentItem = allItems.find((i) => i.id === itemId);
	const currentVault = currentItem?.vault;

	const handleTagClick = useCallback(
		(tagName: string) => {
			navigate({
				to: "/vault/tag/$tagName",
				params: { tagName: encodeURIComponent(tagName) },
			});
		},
		[navigate],
	);

	return (
		<ItemDetailPage
			itemId={itemId}
			vaultInfo={currentVault}
			availableTags={availableTags}
			onTagClick={handleTagClick}
		/>
	);
}
