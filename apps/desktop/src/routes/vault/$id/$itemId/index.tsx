import {
	useAvailableTags,
	useVaultInfo,
	useVaultItems,
} from "@bittery/core/hooks";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { ItemDetailPage } from "../../../../components/vault/item-detail-page";

export const Route = createFileRoute("/vault/$id/$itemId/")({
	component: VaultItemComponent,
});

function VaultItemComponent() {
	const { itemId, id: selectedVaultId } = Route.useParams();
	const navigate = useNavigate();

	// Get all items in vault for available tags
	const { items: allVaultItems } = useVaultItems(selectedVaultId);
	const availableTags = useAvailableTags(allVaultItems);

	// Get vault info from storage (now includes account metadata)
	const { vaultInfo: currentVault } = useVaultInfo(selectedVaultId);

	// Handle tag click - navigate to per-vault tag view
	const handleTagClick = useCallback(
		(tagName: string) => {
			navigate({
				to: "/vault/$id/tag/$tagName",
				params: { id: selectedVaultId, tagName: encodeURIComponent(tagName) },
			});
		},
		[navigate, selectedVaultId],
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
