import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ItemDetailScreen } from "@/components/vault/item-detail-screen";

export const Route = createFileRoute("/vault/tag/$tagName/$itemId/")({
	component: TagItemDetailScreen,
});

function TagItemDetailScreen() {
	const navigate = useNavigate();
	const { tagName, itemId } = Route.useParams();

	return (
		<ItemDetailScreen
			itemId={itemId}
			onBack={() =>
				navigate({ to: "/vault/tag/$tagName", params: { tagName } })
			}
		/>
	);
}
