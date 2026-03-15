import { useItems } from "@bittery/core/hooks";
import { Badge } from "@bittery/ui";
import { IconStarOutlineDuo18 } from "@bittery/ui/icons";
import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";
import { ItemListRow } from "../../../components/vault/item-list-row";

export const Route = createFileRoute("/vault/favorites")({
	component: RouteComponent,
});

function RouteComponent() {
	const { m } = useI18n();
	const { itemId } = useParams({ strict: false });

	// Unified hook - automatically handles single-account vs "All Accounts" mode
	const { items: allItems, isLoading } = useItems();

	// Filter only favorites and sort by updatedAt
	const favoriteItems = allItems
		.filter((item) => item.favorite)
		.sort(
			(a, b) =>
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		);

	if (isLoading) {
		return (
			<div className="flex w-78 flex-col border-r bg-background">
				<div className="flex flex-1 items-center justify-center">
					<div className="text-muted-foreground text-sm">
						{m.vaults_favorites_loading()}
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
					<IconStarOutlineDuo18
						className="size-4 text-yellow-500"
						fill="currentColor"
					/>
					<span className="font-medium">{m.vaults_favorites_title()}</span>
					<Badge variant="secondary" className="ml-auto">
						{favoriteItems.length}
					</Badge>
				</div>

				<div className="flex-1 overflow-y-auto">
					{favoriteItems.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<div className="mb-4 inline-flex rounded-full bg-muted p-4">
								<IconStarOutlineDuo18 className="size-8 text-muted-foreground" />
							</div>
							<h3 className="mb-2 font-semibold">
								{m.vaults_favorites_empty_title()}
							</h3>
							<p className="text-muted-foreground text-sm">
								{m.vaults_favorites_empty_description()}
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{favoriteItems.map((item) => (
								<ItemListRow
									key={item.id}
									item={item}
									isSelected={itemId === item.id}
									linkTo="/vault/favorites/$itemId"
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
