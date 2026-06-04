import type { DecryptedItem } from "@bittery/shared/types";
import { Button, Skeleton } from "@bittery/ui";
import { IconArrowLeftOutlineDuo18 } from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { ItemDetailPanel } from "@/components/item-detail-panel";
import { useI18n } from "@/providers/i18n-provider";
import { createExtensionInvalidator } from "@/lib/query-invalidation";

export function ItemDetailPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { m } = useI18n();
	const { itemId } = useParams({ from: "/item/$itemId" });
	const invalidator = useMemo(
		() => createExtensionInvalidator(queryClient),
		[queryClient],
	);

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
		// Invalidate both the single item query and the items list
		// Note: We pass empty vaultId since we don't have it readily available
		// The invalidator will still properly invalidate all relevant queries
		invalidator.invalidateItem(itemId, item?.vaultId ?? "");
	}, [invalidator, itemId, item?.vaultId]);

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
				<p className="text-muted-foreground text-sm">{m.ext_item_detail_not_found()}</p>
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
						<IconArrowLeftOutlineDuo18 className="size-[18px]" />
					</Button>
					<div>
						<div className="font-semibold text-lg">{m.ext_item_detail_title()}</div>
						<div className="text-muted-foreground text-xs">
							{m.ext_item_detail_description()}
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
