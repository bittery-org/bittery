import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { ItemDetailPage } from "../../../../components/vault/item-detail-page";
import { useAllDecryptedItems, useAvailableTags } from "@bittery/hooks";

export const Route = createFileRoute("/vault/favorites/$itemId/")({
	component: FavoritesItemComponent,
});

function FavoritesItemComponent() {
	const { itemId } = Route.useParams();
	const navigate = useNavigate();

	const { items: allItems } = useAllDecryptedItems();
	const availableTags = useAvailableTags(allItems);

	const currentVault = allItems.find((i) => i.id === itemId)?.vault;

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
