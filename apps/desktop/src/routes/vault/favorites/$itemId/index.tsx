import { useAvailableTags, useItems, useVaultInfo } from "@bittery/hooks";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
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

	// Get vault ID from the item
	const currentItem = allItems.find((i) => i.id === itemId);
	const vaultId = currentItem?.vaultId;

	// Get complete vault info including account metadata
	const { vaultInfo: currentVault } = useVaultInfo(vaultId ?? "");

	const handleTagClick = useCallback(
		(tagName: string) => {
			navigate({
				to: "/vault/tag/$tagName",
				params: { tagName: encodeURIComponent(tagName) },
			});
		},
		[navigate],
	);

	const vaultInfo = useMemo(
		() =>
			currentVault
				? {
						name: currentVault.vaultName,
						type: currentVault.vaultType,
						icon: currentVault.vaultIcon,
						imageUrl: currentVault.vaultImageUrl,
						accountName: currentVault.accountName,
						accountTeamName: currentVault.accountTeamName,
						accountTeamAvatarUrl: currentVault.accountTeamAvatarUrl,
					}
				: undefined,
		[currentVault],
	);

	return (
		<ItemDetailPage
			itemId={itemId}
			vaultInfo={vaultInfo}
			availableTags={availableTags}
			onTagClick={handleTagClick}
		/>
	);
}
