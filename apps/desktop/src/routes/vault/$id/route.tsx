import { useVaultItems } from "@bittery/hooks";
import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { ItemListRow } from "../../../components/vault/item-list-row";

export const Route = createFileRoute("/vault/$id")({
	component: RouteComponent,
});

function RouteComponent() {
	const { id, itemId } = useParams({ strict: false });

	// Fetch and decrypt items for the selected vault
	// useVaultItems automatically handles single-account vs all-accounts mode
	const { items: decryptedItems, isLoading } = useVaultItems(id || "");

	// Sort items by favorite status
	const items = [...decryptedItems].sort((a, b) => {
		// Sort favorites first
		if (a.favorite && !b.favorite) return -1;
		if (!a.favorite && b.favorite) return 1;
		return 0;
	});

	// Split into favorites and regular items
	const favoriteItems = items.filter((item) => item.favorite);
	const regularItems = items.filter((item) => !item.favorite);

	if (isLoading) {
		return (
			<div className="flex w-78 flex-col border-r bg-background">
				<div className="flex flex-1 items-center justify-center">
					<div className="text-muted-foreground text-sm">Loading items...</div>
				</div>
			</div>
		);
	}

	return (
		<>
			<div className="flex w-78 flex-col border-r bg-background">
				<div className="flex-1 overflow-y-auto">
					{items.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">No items yet</h3>
							<p className="text-muted-foreground text-sm">
								Create your first item
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{favoriteItems.length > 0 && (
								<>
									<div className="mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
										Favorites
									</div>
									{id &&
										favoriteItems.map((item) => (
											<ItemListRow
												key={item.id}
												item={item}
												isSelected={itemId === item.id}
												linkTo="/vault/$id/$itemId"
												linkParams={{ id, itemId: item.id }}
												vaultId={id}
											/>
										))}
									<div className="mt-4 mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
										All Items
									</div>
								</>
							)}
							{id &&
								regularItems.map((item) => (
									<ItemListRow
										key={item.id}
										item={item}
										isSelected={itemId === item.id}
										linkTo="/vault/$id/$itemId"
										linkParams={{ id, itemId: item.id }}
										vaultId={id}
									/>
								))}
						</div>
					)}
				</div>
			</div>

			<div className="flex h-full flex-1 flex-col">
				<div className="flex flex-1 flex-col overflow-y-auto">
					<Outlet />
				</div>
			</div>
		</>
	);
}
