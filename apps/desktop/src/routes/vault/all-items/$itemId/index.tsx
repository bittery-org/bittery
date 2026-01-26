import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { ItemDetailPage } from "../../../../components/vault/item-detail-page";
import { useAllDecryptedItems, useAvailableTags } from "@bittery/hooks";

export const Route = createFileRoute("/vault/all-items/$itemId/")({
	component: AllItemsItemComponent,
});

function AllItemsItemComponent() {
	const { itemId } = Route.useParams();
	const navigate = useNavigate();

	// Get all items for available tags and vault info
	const { items: allItems } = useAllDecryptedItems();
	const availableTags = useAvailableTags(allItems);

	// Get vault info from the item
	const currentVault = allItems.find((i) => i.id === itemId)?.vault;

	// Handle tag click - navigate to cross-vault tag view
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
