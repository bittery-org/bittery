import type { DecryptedItem } from "@bittery/shared/types";
import { Button, Skeleton } from "@bittery/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useCallback } from "react";
import { ItemDetailPanel } from "@/components/item-detail-panel";

export function ItemDetailPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { itemId } = useParams({ from: "/item/$itemId" });

	const { data: item, isLoading } = useQuery<DecryptedItem | null>({
		queryKey: ["vault-item", itemId],
		queryFn: async () => {
			const response = await chrome.runtime.sendMessage({
				type: "GET_VAULT_ITEM",
				payload: { itemId },
			});
			return response.item;
		},
	});

	const handleItemUpdated = useCallback(() => {
		// Invalidate the query to refresh the item data
		queryClient.invalidateQueries({ queryKey: ["vault-item", itemId] });
	}, [queryClient, itemId]);

	if (isLoading) {
		return (
			<div className="space-y-4 p-4">
				<Skeleton className="h-8 w-32" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	if (!item) {
		return (
			<div className="flex h-full items-center justify-center p-4">
				<p className="text-muted-foreground text-sm">Item not found</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="border-b bg-background px-4 py-3">
				<div className="flex items-center gap-2">
					<Button
						size="icon"
						variant="ghost"
						onClick={() => navigate({ to: "/vault" })}
					>
						<ArrowLeft size={18} />
					</Button>
					<div>
						<div className="font-semibold text-lg">Item details</div>
						<div className="text-muted-foreground text-xs">
							View and copy saved credentials
						</div>
					</div>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto p-5">
				<ItemDetailPanel item={item} onItemUpdated={handleItemUpdated} />
			</div>
		</div>
	);
}
