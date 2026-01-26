import { useAllDecryptedItems, useToggleFavorite } from "@bittery/hooks";
import { Badge } from "@bittery/ui";
import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { LayoutGrid } from "lucide-react";
import { ItemListRow } from "../../../components/vault/item-list-row";

export const Route = createFileRoute("/vault/all-items")({
	component: RouteComponent,
});

function RouteComponent() {
	const { itemId } = useParams({ strict: false });

	const { items, isLoading } = useAllDecryptedItems();

	// Sort items: favorites first, then by updatedAt
	const sortedItems = [...items].sort((a, b) => {
		if (a.favorite && !b.favorite) return -1;
		if (!a.favorite && b.favorite) return 1;
		return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
	});

	// Split into favorites and regular items
	const favoriteItems = sortedItems.filter((item) => item.favorite);
	const regularItems = sortedItems.filter((item) => !item.favorite);

	// Mutation to toggle favorite
	const toggleFavorite = useToggleFavorite();

	const handleToggleFavorite = (
		e: React.MouseEvent,
		id: string,
		currentFavorite: boolean,
	) => {
		e.preventDefault();
		e.stopPropagation();
		const item = items.find((i) => i.id === id);
		if (item) {
			toggleFavorite.mutate({
				itemId: id,
				vaultId: item.vaultId,
				favorite: !currentFavorite,
			});
		}
	};

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
				{/* Header */}
				<div className="flex items-center gap-2 border-b px-4 py-3">
					<LayoutGrid className="size-4 text-muted-foreground" />
					<span className="font-medium">All Objects</span>
					<Badge variant="secondary" className="ml-auto">
						{items.length}
					</Badge>
				</div>

				<div className="flex-1 overflow-y-auto">
					{items.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">No items yet</h3>
							<p className="text-muted-foreground text-sm">
								Create your first item in any vault
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{favoriteItems.length > 0 && (
								<>
									<div className="mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
										Favorites
									</div>
									{favoriteItems.map((item) => (
										<ItemListRow
											key={item.id}
											item={item}
											isSelected={itemId === item.id}
											onToggleFavorite={(e) =>
												handleToggleFavorite(e, item.id, item.favorite)
											}
											linkTo="/vault/all-items/$itemId"
											linkParams={{ itemId: item.id }}
											showVaultBadge
											vaultId={item.vaultId}
										/>
									))}
									<div className="mt-4 mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
										All Items
									</div>
								</>
							)}
							{regularItems.map((item) => (
								<ItemListRow
									key={item.id}
									item={item}
									isSelected={itemId === item.id}
									onToggleFavorite={(e) =>
										handleToggleFavorite(e, item.id, item.favorite)
									}
									linkTo="/vault/all-items/$itemId"
									linkParams={{ itemId: item.id }}
									showVaultBadge
									vaultId={item.vaultId}
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
