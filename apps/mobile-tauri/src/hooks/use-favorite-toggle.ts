import { useToggleFavorite } from "@bittery/core/hooks";
import { toast } from "@bittery/ui";
import { useI18n } from "@/providers/i18n-provider";

interface FavoritableItem {
	id: string;
	vaultId: string;
	favorite?: boolean;
	accountId?: string;
	account?: { accountId?: string } | null;
}

/**
 * List-row favorite toggling, shared by every screen that renders `MobileItemRow` (vault items,
 * all-items, favorites, tag, search). Mirrors desktop's per-vault tag route
 * (`apps/desktop/src/routes/vault/$id/tag/$tagName.tsx`), which is the one desktop screen that
 * toggles favorite from a list row rather than only from the detail page.
 */
export function useFavoriteToggle() {
	const { m } = useI18n();
	const toggleFavorite = useToggleFavorite();

	const handleToggle = (item: FavoritableItem) => {
		const accountId = item.accountId ?? item.account?.accountId;
		if (!accountId) return;
		toggleFavorite.mutate(
			{
				itemId: item.id,
				vaultId: item.vaultId,
				favorite: !item.favorite,
				accountId,
			},
			{
				onError: () => {
					toast.error(
						m.vaults_detail_items_list_toast_favorite_update_failed(),
					);
				},
			},
		);
	};

	return { handleToggle, isPending: toggleFavorite.isPending };
}
