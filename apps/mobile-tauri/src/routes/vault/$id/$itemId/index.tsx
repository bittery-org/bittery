/**
 * M3-C2 — item detail, now writable. Edit/delete/move/favorite/tags/passkeys/password-history
 * all live in the shared `ItemDetailScreen` (`@/components/vault/item-detail-screen`); this
 * file only supplies the back target, back to this vault's item list.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ItemDetailScreen } from "@/components/vault/item-detail-screen";

export const Route = createFileRoute("/vault/$id/$itemId/")({
	component: ItemDetailRouteScreen,
});

function ItemDetailRouteScreen() {
	const navigate = useNavigate();
	const { id, itemId } = Route.useParams();

	return (
		<ItemDetailScreen
			itemId={itemId}
			onBack={() => navigate({ to: "/vault/$id", params: { id } })}
		/>
	);
}
