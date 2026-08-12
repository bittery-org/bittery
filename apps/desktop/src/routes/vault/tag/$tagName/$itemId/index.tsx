import { useAvailableTags, useItems, useVaultInfo } from "@bittery/core/hooks";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { ItemDetailPage } from "../../../../../components/vault/item-detail-page";

export const Route = createFileRoute("/vault/tag/$tagName/$itemId/")({
	component: TagItemComponent,
});

function TagItemComponent() {
	const { itemId } = Route.useParams();
	const navigate = useNavigate();

	// Unified hook - automatically handles single-account vs "All Accounts" mode
	const { items: allItems } = useItems();
	const availableTags = useAvailableTags(allItems);

	// Get vault ID from the item
	const currentItem = allItems.find((i) => i.id === itemId);
	const vaultId = currentItem?.vaultId;

	// Get complete vault info including account metadata
	const { vaultInfo: currentVault } = useVaultInfo(vaultId ?? "");

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
