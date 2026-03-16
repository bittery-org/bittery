import { useItemListFilters, useItems } from "@bittery/core/hooks";
import {
	Badge,
	VaultItemListControls,
} from "@bittery/ui";
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
	const {
		searchQuery,
		setSearchQuery,
		categoryFilter,
		setCategoryFilter,
		sortField,
		setSortField,
		sortDirection,
		setSortDirection,
		filteredItems,
		favoriteItems,
		regularItems,
		hasActiveFilters,
	} = useItemListFilters({ items });

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
				<VaultItemListControls
					categoryFilter={categoryFilter}
					onCategoryFilterChange={setCategoryFilter}
					searchQuery={searchQuery}
					onSearchQueryChange={setSearchQuery}
					sortField={sortField}
					onSortFieldChange={setSortField}
					sortDirection={sortDirection}
					onSortDirectionChange={setSortDirection}
				/>

				<div className="flex-1 overflow-y-auto">
					{filteredItems.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">
								{hasActiveFilters
									? m.vaults_detail_items_list_empty_filtered_title()
									: m.vaults_detail_items_list_empty_default_title()}
							</h3>
							<p className="text-muted-foreground text-sm">
								{hasActiveFilters
									? m.vaults_detail_items_list_empty_filtered_description()
									: m.vaults_detail_items_list_empty_default_description()}
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{favoriteItems.length > 0 && (
								<>
									<div className="mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
										{m.vaults_favorites_title()}
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
										{m.vaults_detail_tab_items()}
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
