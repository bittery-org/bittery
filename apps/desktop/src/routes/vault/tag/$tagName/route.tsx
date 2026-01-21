import { useTRPCClient } from "@bittery/shared/trpc";
import { Badge, Button } from "@bittery/ui";
import { useMutation } from "@tanstack/react-query";
import {
	createFileRoute,
	Outlet,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { ArrowLeft, Tag } from "lucide-react";
import { ItemListRow } from "../../../../components/vault/item-list-row";
import { getTagColorFromName } from "../../../../components/vault/tag-badge";
import { useAllDecryptedItems } from "../../../../hooks/use-all-decrypted-items";
import { useQueryInvalidator } from "../../../../providers/sync-provider";

export const Route = createFileRoute("/vault/tag/$tagName")({
	component: CrossVaultTagRouteComponent,
});

function CrossVaultTagRouteComponent() {
	const { tagName } = Route.useParams();
	const { itemId } = useParams({ strict: false });
	const navigate = useNavigate();
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	// Decode the tag name from URL
	const decodedTagName = decodeURIComponent(tagName);
	const tagColor = getTagColorFromName(decodedTagName);

	// Fetch and decrypt all items
	const { items: allItems, isLoading } = useAllDecryptedItems();

	// Filter items by tag
	const filteredItems = allItems.filter((item) =>
		item.tags?.includes(decodedTagName),
	);

	// Sort: favorites first, then by updatedAt
	const sortedItems = [...filteredItems].sort((a, b) => {
		if (a.favorite && !b.favorite) return -1;
		if (!a.favorite && b.favorite) return 1;
		return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
	});

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
					<Button
						variant="ghost"
						size="icon"
						className="size-6"
						onClick={() => navigate({ to: "/vault/all-items" })}
					>
						<ArrowLeft className="size-4" />
					</Button>
					<Tag className="size-4" style={{ color: tagColor }} />
					<span className="truncate font-medium">{decodedTagName}</span>
					<Badge variant="secondary" className="ml-auto">
						{filteredItems.length}
					</Badge>
				</div>

				<div className="flex-1 overflow-y-auto">
					{filteredItems.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<div
								className="mb-4 inline-flex rounded-full p-4"
								style={{ backgroundColor: `${tagColor}20` }}
							>
								<Tag className="size-8" style={{ color: tagColor }} />
							</div>
							<h3 className="mb-2 font-semibold">No items with this tag</h3>
							<p className="text-muted-foreground text-sm">
								Items tagged with "{decodedTagName}" will appear here
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{sortedItems.map((item) => (
								<ItemListRow
									key={item.id}
									item={item}
									isSelected={itemId === item.id}
									onToggleFavorite={(e) =>
										handleToggleFavorite(e, item.id, item.favorite)
									}
									linkTo="/vault/tag/$tagName/$itemId"
									linkParams={{
										tagName: encodeURIComponent(decodedTagName),
										itemId: item.id,
									}}
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
