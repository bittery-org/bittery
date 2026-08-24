import type { ItemProjectionStatus } from "@bittery/client-runtime/protocol";
import { useItemListFilters } from "@bittery/core/hooks";
import { detectCardBrand, maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import {
	ActiveRail,
	Checkbox,
	type DragItemData,
	Skeleton,
	VaultItemListControls,
	VaultItemListRow,
} from "@bittery/ui";
import {
	IconClock as Clock,
	IconKey as Key,
	IconSmartphone as Smartphone,
	IconTriangleAlert as TriangleAlert,
} from "@bittery/ui/icons";
import { useDraggable } from "@dnd-kit/core";
import { useCallback, useRef } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { useVaultDnd } from "@/providers/vault-dnd-provider";
import { Favicon } from "./favicon";

/**
 * A list Item, plus what the Runtime says about it when the Runtime is the reader.
 *
 * Optional because the importers, the extension bridge, and the share views still pass plain
 * repository Items. A row without a status renders exactly as it did before.
 */
export type ItemListEntry = DecryptedItemWithContext & {
	runtimeStatus?: ItemProjectionStatus;
};

interface ItemListProps {
	items: ItemListEntry[];
	isLoading: boolean;
	onItemSelect?: (item: ItemListEntry) => void;
	selectedItemId?: string;
	selectionMode?: boolean;
	selectedItemIds?: string[];
	onSelectionChange?: (selectedIds: string[]) => void;
}

export function ItemList({
	items,
	isLoading,
	onItemSelect,
	selectedItemId,
	selectionMode = false,
	selectedItemIds = [],
	onSelectionChange,
}: ItemListProps) {
	const { m } = useI18n();
	const listScrollRef = useRef<HTMLDivElement>(null);
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
			<div className="flex min-h-0 flex-1 flex-col gap-4">
				<div className="flex shrink-0 flex-col gap-2 sm:flex-row">
					<Skeleton className="h-10 flex-1" />
					<Skeleton className="h-10 w-full sm:w-40" />
				</div>
				<div className="min-h-0 flex-1 space-y-2">
					{[1, 2, 3, 4, 5].map((i) => (
						<Skeleton key={i} className="h-16" />
					))}
				</div>
			</div>
		);
	}

	// Handle selection toggle
	const handleToggleSelection = (itemId: string) => {
		if (!onSelectionChange) return;
		if (selectedItemIds.includes(itemId)) {
			onSelectionChange(selectedItemIds.filter((id) => id !== itemId));
		} else {
			onSelectionChange([...selectedItemIds, itemId]);
		}
	};

	// Handle select all in filtered view
	const handleSelectAll = () => {
		if (!onSelectionChange) return;
		const allFilteredIds = filteredItems.map((item) => item.id);
		if (selectedItemIds.length === allFilteredIds.length) {
			onSelectionChange([]);
		} else {
			onSelectionChange(allFilteredIds);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
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

			{/* Selection mode header */}
			{selectionMode && filteredItems.length > 0 && (
				<div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
					<Checkbox
						checked={
							selectedItemIds.length === filteredItems.length &&
							filteredItems.length > 0
						}
						onCheckedChange={handleSelectAll}
					/>
					<span className="text-sm">
						{selectedItemIds.length > 0
							? selectedItemIds.length === 1
								? m.vaults_detail_items_list_selection_selected_single({
										count: selectedItemIds.length,
									})
								: m.vaults_detail_items_list_selection_selected_plural({
										count: selectedItemIds.length,
									})
							: m.vaults_detail_items_list_selection_select_all()}
					</span>
				</div>
			)}

			{/* Scrollable Items List */}
			{filteredItems.length === 0 ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center">
					<div className="mb-4 inline-flex rounded-full border bg-foreground/3 p-4">
						<Key className="size-6 text-muted-foreground" />
					</div>
					<h3 className="mb-1 font-medium text-sm">
						{hasActiveFilters
							? m.vaults_detail_items_list_empty_filtered_title()
							: m.vaults_detail_items_list_empty_default_title()}
					</h3>
					<p className="max-w-sm text-muted-foreground text-sm">
						{hasActiveFilters
							? m.vaults_detail_items_list_empty_filtered_description()
							: m.vaults_detail_items_list_empty_default_description()}
					</p>
				</div>
			) : (
				<div
					ref={listScrollRef}
					className="relative min-h-0 flex-1 overflow-y-auto"
					data-testid="vault-items-scroll-area"
				>
					<ActiveRail containerRef={listScrollRef} />
					<div className="space-y-1 p-2">
						{/* Favorites Section */}
						{favoriteItems.length > 0 && (
							<>
								<div className="px-2 py-1.5 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
									{m.vaults_detail_items_list_section_favorites({
										count: favoriteItems.length,
									})}
								</div>
								{favoriteItems.map((item) => (
									<ItemRow
										key={item.id}
										item={item}
										isSelected={selectedItemId === item.id}
										onSelect={onItemSelect}
										selectionMode={selectionMode}
										isChecked={selectedItemIds.includes(item.id)}
										onToggleCheck={() => handleToggleSelection(item.id)}
									/>
								))}
							</>
						)}

						{/* All Items Section */}
						{regularItems.length > 0 && (
							<>
								{favoriteItems.length > 0 && (
									<div className="mt-3 px-2 py-1.5 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
										{m.vaults_detail_items_list_section_all_items({
											count: regularItems.length,
										})}
									</div>
								)}
								{regularItems.map((item) => (
									<ItemRow
										key={item.id}
										item={item}
										isSelected={selectedItemId === item.id}
										onSelect={onItemSelect}
										selectionMode={selectionMode}
										isChecked={selectedItemIds.includes(item.id)}
										onToggleCheck={() => handleToggleSelection(item.id)}
									/>
								))}
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

interface ItemRowProps {
	item: ItemListEntry;
	isSelected: boolean;
	onSelect?: (item: ItemListEntry) => void;
	selectionMode?: boolean;
	isChecked?: boolean;
	onToggleCheck?: () => void;
}

function ItemRow({
	item,
	isSelected,
	onSelect,
	selectionMode = false,
	isChecked = false,
	onToggleCheck,
}: ItemRowProps) {
	const { m } = useI18n();
	const { isDragging: isAnyItemDragging } = useVaultDnd();
	const maskedCardNumber = item.cardNumber
		? maskCardNumber(item.cardNumber)
		: undefined;
	const cardBrand = item.cardNumber
		? detectCardBrand(item.cardNumber)
		: undefined;

	const accountId = item.accountId ?? item.account?.accountId;
	const dragData: DragItemData | undefined = accountId
		? {
				type: "vault-item",
				item,
				sourceVaultId: item.vaultId,
				accountId,
			}
		: undefined;

	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: `item-${item.id}`,
		data: dragData,
		disabled: selectionMode,
	});

	const setRowRef = useCallback(
		(node: HTMLDivElement | null) => {
			setNodeRef(node);
			if (!node || !isSelected) return;
			requestAnimationFrame(() => {
				node.scrollIntoView({ block: "nearest", inline: "nearest" });
			});
		},
		[isSelected, setNodeRef],
	);

	return (
		<VaultItemListRow
			ref={setRowRef}
			{...(!selectionMode ? listeners : {})}
			{...(!selectionMode ? attributes : {})}
			itemTitle={item.title}
			ariaLabel={m.vaults_detail_items_list_item_action_select({
				title: item.title,
			})}
			leadingVisual={<Favicon item={item} cardBrand={cardBrand} size="md" />}
			indicators={
				<>
					{/* A write the Server has not accepted is not a saved Item, and a list that
					    looks identical either way would say it was. */}
					{item.runtimeStatus === "pending" && (
						<span
							title={m.vaults_detail_items_status_pending()}
							data-testid="item-status-pending"
						>
							<Clock className="h-3 w-3 shrink-0 text-muted-foreground" />
						</span>
					)}
					{item.runtimeStatus === "failed" && (
						<span
							title={m.vaults_detail_items_status_failed()}
							data-testid="item-status-failed"
						>
							<TriangleAlert className="h-3 w-3 shrink-0 text-destructive" />
						</span>
					)}
					{item.category === "login" && item.totpSecret ? (
						<span title={m.vaults_detail_items_list_item_badge_has_2fa()}>
							{/* PROTOTYPE: most variants have no purple fill, so the flipped
							    foreground colour would be invisible in light mode. */}
							<Smartphone className="h-3 w-3 shrink-0 text-muted-foreground" />
						</span>
					) : null}
				</>
			}
			secondaryText={item.username}
			tertiaryText={maskedCardNumber}
			isSelected={isSelected}
			selectionMode={selectionMode}
			isChecked={isChecked}
			isAnyItemDragging={isAnyItemDragging}
			isDragging={isDragging}
			onPrimaryAction={() => onSelect?.(item)}
			onToggleCheck={onToggleCheck}
			dataTestId="item-row"
			dataItemId={item.id}
		/>
	);
}
