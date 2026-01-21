import { useTRPCClient } from "@bittery/shared/trpc";
import { Badge } from "@bittery/ui";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { ItemListRow } from "../../../components/vault/item-list-row";
import { useAllDecryptedItems } from "../../../hooks/use-all-decrypted-items";
import { useQueryInvalidator } from "../../../providers/sync-provider";

export const Route = createFileRoute("/vault/favorites")({
	component: RouteComponent,
});

function RouteComponent() {
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const { itemId } = useParams({ strict: false });

	const { items: allItems, isLoading } = useAllDecryptedItems();

	// Filter only favorites and sort by updatedAt
	const favoriteItems = allItems
		.filter((item) => item.favorite)
		.sort(
			(a, b) =>
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		);

	// Mutation to toggle favorite
	const toggleFavoriteMutation = useMutation({
		mutationFn: async (params: { itemId: string; favorite: boolean }) => {
			return trpcClient.vault.toggleFavorite.mutate(params);
		},
		onSuccess: (_data, variables) => {
			const item = allItems.find((i) => i.id === variables.itemId);
			if (item) {
				invalidator.invalidateItem(variables.itemId, item.vaultId);
			}
		},
	});

	const handleToggleFavorite = (
		e: React.MouseEvent,
		id: string,
		currentFavorite: boolean,
	) => {
		e.preventDefault();
		e.stopPropagation();
		toggleFavoriteMutation.mutate({
			itemId: id,
			favorite: !currentFavorite,
		});
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
					<Star className="size-4 text-yellow-500" fill="currentColor" />
					<span className="font-medium">Favorites</span>
					<Badge variant="secondary" className="ml-auto">
						{favoriteItems.length}
					</Badge>
				</div>

				<div className="flex-1 overflow-y-auto">
					{favoriteItems.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<div className="mb-4 inline-flex rounded-full bg-muted p-4">
								<Star className="size-8 text-muted-foreground" />
							</div>
							<h3 className="mb-2 font-semibold">No favorites yet</h3>
							<p className="text-muted-foreground text-sm">
								Star items to add them to favorites
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{favoriteItems.map((item) => (
								<ItemListRow
									key={item.id}
									item={item}
									isSelected={itemId === item.id}
									onToggleFavorite={(e) =>
										handleToggleFavorite(e, item.id, item.favorite)
									}
									linkTo="/vault/favorites/$itemId"
									linkParams={{ itemId: item.id }}
									showVaultBadge
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
