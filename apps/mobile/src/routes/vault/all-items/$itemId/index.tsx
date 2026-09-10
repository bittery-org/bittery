import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ItemDetailScreen } from "@/components/vault/item-detail-screen";

export const Route = createFileRoute("/vault/all-items/$itemId/")({
	component: AllItemsDetailScreen,
});

function AllItemsDetailScreen() {
	const navigate = useNavigate();
	const { itemId } = Route.useParams();

	return (
		<ItemDetailScreen
			itemId={itemId}
			onBack={() => navigate({ to: "/vault/all-items" })}
		/>
	);
}
