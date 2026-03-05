import { useItems } from "@bittery/core/hooks";
import { Badge } from "@bittery/ui";
import { IconGrid2OutlineDuo18 } from "@bittery/ui/icons";
import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";
import { ItemListRow } from "../../../components/vault/item-list-row";

export const Route = createFileRoute("/vault/all-items")({
	component: RouteComponent,
});

function RouteComponent() {
	const { m } = useI18n();
	const { itemId } = useParams({ strict: false });

	// Unified hook - automatically handles single-account vs "All Accounts" mode
	const { items, isLoading } = useItems();

	// Sort items: favorites first, then by updatedAt
	const sortedItems = [...items].sort((a, b) => {
		if (a.favorite && !b.favorite) return -1;
		if (!a.favorite && b.favorite) return 1;
		return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
	});

	// Split into favorites and regular items
	const favoriteItems = sortedItems.filter((item) => item.favorite);
	const regularItems = sortedItems.filter((item) => !item.favorite);

	if (isLoading) {
		return (
			<div className="flex w-78 flex-col border-r bg-background">
				<div className="flex flex-1 items-center justify-center">
					<div className="text-muted-foreground text-sm">
						{m["vaults.favorites.loading"]()}
					</div>
				</div>
			</div>
		);
	}

	return (
		<>
			<div className="flex w-78 flex-col border-r bg-background">
				{/* Header */}
				<div className="flex items-center gap-2 border-b px-4 py-3">
					<IconGrid2OutlineDuo18 className="size-4 text-muted-foreground" />
					<span className="font-medium">
						{m["vaults.sidebar.link.all_objects"]()}
					</span>
					<Badge variant="secondary" className="ml-auto">
						{items.length}
					</Badge>
				</div>

				<div className="flex-1 overflow-y-auto">
					{items.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">
								{m["vaults.detail.items.list.empty.default.title"]()}
							</h3>
							<p className="text-muted-foreground text-sm">
								{m["vaults.detail.items.list.empty.default.description"]()}
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{favoriteItems.length > 0 && (
								<>
									<div className="mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
										{m["vaults.favorites.title"]()}
									</div>
									{favoriteItems.map((item) => (
										<ItemListRow
											key={item.id}
											item={item}
											isSelected={itemId === item.id}
											linkTo="/vault/all-items/$itemId"
											linkParams={{ itemId: item.id }}
											vaultId={item.vaultId}
										/>
									))}
									<div className="mt-4 mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
										{m["vaults.detail.tab.items"]()}
									</div>
								</>
							)}
							{regularItems.map((item) => (
								<ItemListRow
									key={item.id}
									item={item}
									isSelected={itemId === item.id}
									linkTo="/vault/all-items/$itemId"
									linkParams={{ itemId: item.id }}
									vaultId={item.vaultId}
								/>
							))}
						</div>
					)}
				</div>
			</div>

			<div className="flex h-full min-w-0 flex-1 flex-col">
				<div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
					<Outlet />
				</div>
			</div>
		</>
	);
}
