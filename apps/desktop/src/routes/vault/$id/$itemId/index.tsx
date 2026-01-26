import { useAvailableTags, useDecryptedItems } from "@bittery/hooks";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { storage } from "@/lib/storage";
import { ItemDetailPage } from "../../../../components/vault/item-detail-page";

export const Route = createFileRoute("/vault/$id/$itemId/")({
	component: VaultItemComponent,
});

function VaultItemComponent() {
	const { itemId, id: selectedVaultId } = Route.useParams();
	const navigate = useNavigate();

	// Get all items in vault for available tags
	const { items: allVaultItems } = useDecryptedItems(selectedVaultId);
	const availableTags = useAvailableTags(allVaultItems);

	// Get vault info from storage
	const { data: currentVault } = useQuery({
		queryKey: ["vault-keys", selectedVaultId],
		queryFn: async () => {
			const keys = await storage.getVaultKeys();
			if (!keys) return null;
			return keys.find((v) => v.vaultId === selectedVaultId);
		},
	});

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

	const vaultInfo = currentVault
		? {
				name: currentVault.vaultName,
				icon: currentVault.vaultIcon,
				imageUrl: currentVault.vaultImageUrl,
			}
		: undefined;

	return (
		<ItemDetailPage
			itemId={itemId}
			vaultInfo={vaultInfo}
			availableTags={availableTags}
			onTagClick={handleTagClick}
		/>
	);
}
