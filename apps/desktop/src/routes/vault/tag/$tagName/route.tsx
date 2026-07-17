import { useItemListFilters, useItems } from "@bittery/core/hooks";
import {
	Badge,
	Button,
	getTagColorFromName,
	VaultItemListControls,
} from "@bittery/ui";
import { IconArrowLeft, IconTag } from "@bittery/ui/icons";
import {
	createFileRoute,
	Outlet,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";
import { ItemListRow } from "../../../../components/vault/item-list-row";

export const Route = createFileRoute("/vault/tag/$tagName")({
	component: CrossVaultTagRouteComponent,
});

function CrossVaultTagRouteComponent() {
	const { m } = useI18n();
	const { tagName } = Route.useParams();
	const { itemId } = useParams({ strict: false });
	const navigate = useNavigate();

	// Decode the tag name from URL
	const decodedTagName = decodeURIComponent(tagName);
	const tagColor = getTagColorFromName(decodedTagName);

	// Unified hook - automatically handles single-account vs "All Accounts" mode
	const { items: allItems, isLoading } = useItems();
	const {
		searchQuery,
		setSearchQuery,
		categoryFilter,
		setCategoryFilter,
		sortField,
		setSortField,
		sortDirection,
		setSortDirection,
		filteredItems: sortedItems,
		hasActiveFilters,
	} = useItemListFilters({
		items: allItems.filter((item) => item.tags?.includes(decodedTagName)),
	});

	if (isLoading) {
		return (
			<div className="flex w-78 flex-col border-r bg-background">
				<div className="flex flex-1 items-center justify-center">
					<div className="text-muted-foreground text-sm">
						{m.vaults_tag_loading()}
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
					<Button
						variant="ghost"
						size="icon"
						className="size-6"
						onClick={() => navigate({ to: "/vault/all-items" })}
					>
						<IconArrowLeft className="size-4" />
					</Button>
					<IconTag className="size-4" style={{ color: tagColor }} />
					<span className="truncate font-medium">{decodedTagName}</span>
					<Badge variant="secondary" className="ml-auto">
						{sortedItems.length}
					</Badge>
				</div>
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
					{sortedItems.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">
								{hasActiveFilters
									? m.vaults_detail_items_list_empty_filtered_title()
									: m.vaults_tag_empty_title()}
							</h3>
							<p className="text-muted-foreground text-sm">
								{hasActiveFilters
									? m.vaults_detail_items_list_empty_filtered_description()
									: m.vaults_tag_empty_description({
											tagName: decodedTagName,
										})}
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{sortedItems.map((item) => (
								<ItemListRow
									key={item.id}
									item={item}
									isSelected={itemId === item.id}
									linkTo="/vault/tag/$tagName/$itemId"
									linkParams={{
										tagName: encodeURIComponent(decodedTagName),
										itemId: item.id,
									}}
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
