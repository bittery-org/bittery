import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { ItemDetailPage } from "../../../../../components/vault/item-detail-page";
import { useAllDecryptedItems } from "../../../../../hooks/use-all-decrypted-items";
import { useAvailableTags } from "../../../../../hooks/use-available-tags";

export const Route = createFileRoute("/vault/tag/$tagName/$itemId/")({
	component: TagItemComponent,
});

function TagItemComponent() {
	const { itemId } = Route.useParams();
	const navigate = useNavigate();

	const { items: allItems } = useAllDecryptedItems();
	const availableTags = useAvailableTags(allItems);

	const currentVault = allItems.find((i) => i.id === itemId)?.vault;

	const handleTagClick = useCallback(
		(clickedTagName: string) => {
			navigate({
				to: "/vault/tag/$tagName",
				params: { tagName: encodeURIComponent(clickedTagName) },
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
