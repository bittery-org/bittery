import { useAvailableTags } from "@bittery/core/hooks";
import { detectCardBrand, maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import {
	Button,
	Checkbox,
	cn,
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Skeleton,
	TagBadge,
} from "@bittery/ui";
import {
	IconSortObjTopToBottomOutlineDuo18 as Filter,
	IconKeyOutlineDuo18 as Key,
	IconMagnifier3OutlineDuo18 as Search,
	IconMobileOutlineDuo18 as Smartphone,
	IconXmarkOutlineDuo18 as X,
} from "@bittery/ui/icons";
import { useCallback, useMemo, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { Favicon } from "./favicon";

interface ItemListProps {
	items: DecryptedItem[];
	isLoading: boolean;
	onItemSelect?: (item: DecryptedItem) => void;
	selectedItemId?: string;
	selectionMode?: boolean;
	selectedItemIds?: string[];
	onSelectionChange?: (selectedIds: string[]) => void;
}

type CategoryFilter = "all" | ItemCategory;

const CATEGORY_OPTIONS: {
	value: CategoryFilter;
	labelKey:
		| "vaults_detail_items_list_filter_category_all"
		| "vaults_detail_items_list_filter_category_logins"
		| "vaults_detail_items_list_filter_category_secure_notes"
		| "vaults_detail_items_list_filter_category_credit_cards"
		| "vaults_detail_items_list_filter_category_identities"
		| "vaults_detail_items_list_filter_category_totp";
}[] = [
	{ value: "all", labelKey: "vaults_detail_items_list_filter_category_all" },
	{
		value: "login",
		labelKey: "vaults_detail_items_list_filter_category_logins",
	},
	{
		value: "secure-note",
		labelKey: "vaults_detail_items_list_filter_category_secure_notes",
	},
	{
		value: "credit-card",
		labelKey: "vaults_detail_items_list_filter_category_credit_cards",
	},
	{
		value: "identity",
		labelKey: "vaults_detail_items_list_filter_category_identities",
	},
	{ value: "totp", labelKey: "vaults_detail_items_list_filter_category_totp" },
];

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
	const [searchQuery, setSearchQuery] = useState("");
	const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
	const [selectedTags, setSelectedTags] = useState<string[]>([]);

	// Get available tags from decrypted items
	const availableTags = useAvailableTags(items);

	// Filter and search items
	const filteredItems = useMemo(() => {
		let result = [...items];

		// Apply category filter
		if (categoryFilter !== "all") {
			result = result.filter((item) => item.category === categoryFilter);
		}

		// Apply tag filter
		if (selectedTags.length > 0) {
			result = result.filter((item) =>
				item.tags?.some((tag) => selectedTags.includes(tag)),
			);
		}

		// Apply search filter
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			result = result.filter((item) => {
				const searchableFields = [
					item.title,
					item.username,
					item.url,
					item.email,
					item.notes,
					item.note,
				].filter(Boolean);
				return searchableFields.some((field) =>
					field?.toLowerCase().includes(query),
				);
			});
		}

		// Sort by favorite first, then by updatedAt
		result.sort((a, b) => {
			if (a.favorite && !b.favorite) return -1;
			if (!a.favorite && b.favorite) return 1;
			return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
		});

		return result;
	}, [items, categoryFilter, searchQuery, selectedTags]);

	// Split into favorites and regular items
	const favoriteItems = filteredItems.filter((item) => item.favorite);
	const regularItems = filteredItems.filter((item) => !item.favorite);

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

	const hasActiveFilters =
		searchQuery || categoryFilter !== "all" || selectedTags.length > 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Compact search + filter row */}
			<div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
				<Search className="size-3.5 shrink-0 text-muted-foreground" />
				<input
					type="text"
					placeholder={m.vaults_detail_items_list_search_placeholder()}
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
				/>
				{searchQuery && (
					<button
						type="button"
						onClick={() => setSearchQuery("")}
						className="text-muted-foreground hover:text-foreground"
					>
						<X className="size-3.5" />
					</button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className={cn(
								"h-6 w-6 p-0",
								(categoryFilter !== "all" || selectedTags.length > 0) &&
									"text-primary",
							)}
						>
							<Filter className="size-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-48">
						<DropdownMenuLabel className="text-muted-foreground text-xs">
							{m.vaults_detail_items_list_filter_category_placeholder()}
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={categoryFilter}
							onValueChange={(value) =>
								setCategoryFilter(value as CategoryFilter)
							}
						>
							{CATEGORY_OPTIONS.map((option) => (
								<DropdownMenuRadioItem key={option.value} value={option.value}>
									{m[option.labelKey]()}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
						{availableTags.length > 0 && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuLabel className="text-muted-foreground text-xs">
									{m.vaults_detail_items_tag_filter_button_default()}
								</DropdownMenuLabel>
								{availableTags.map((tag) => (
									<DropdownMenuCheckboxItem
										key={tag}
										checked={selectedTags.includes(tag)}
										onCheckedChange={(checked) => {
											if (checked) {
												setSelectedTags([...selectedTags, tag]);
											} else {
												setSelectedTags(selectedTags.filter((t) => t !== tag));
											}
										}}
									>
										{tag}
									</DropdownMenuCheckboxItem>
								))}
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Active tag pills */}
			{selectedTags.length > 0 && (
				<div className="flex shrink-0 flex-wrap gap-1 border-b px-2 py-1.5">
					{selectedTags.map((tag) => (
						<TagBadge
							key={tag}
							name={tag}
							size="sm"
							onRemove={() =>
								setSelectedTags(selectedTags.filter((t) => t !== tag))
							}
						/>
					))}
				</div>
			)}

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
					<div className="mb-4 rounded-full bg-muted p-4">
						<Key className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="mb-1 font-semibold">
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
					className="min-h-0 flex-1 overflow-y-auto"
					data-testid="vault-items-scroll-area"
				>
					<div className="space-y-1 p-2">
						{/* Favorites Section */}
						{favoriteItems.length > 0 && (
							<>
								<div className="px-2 py-2 font-semibold text-muted-foreground text-xs uppercase">
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
									<div className="mt-4 px-2 py-2 font-semibold text-muted-foreground text-xs uppercase">
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
	item: DecryptedItem;
	isSelected: boolean;
	onSelect?: (item: DecryptedItem) => void;
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
	const maskedCardNumber = item.cardNumber
		? maskCardNumber(item.cardNumber)
		: undefined;
	const cardBrand = item.cardNumber
		? detectCardBrand(item.cardNumber)
		: undefined;

	const setRowRef = useCallback(
		(node: HTMLDivElement | null) => {
			if (!node || !isSelected) return;
			requestAnimationFrame(() => {
				node.scrollIntoView({ block: "nearest", inline: "nearest" });
			});
		},
		[isSelected],
	);

	return (
		<div
			ref={setRowRef}
			className={cn(
				"relative flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 transition-colors",
				isSelected
					? "bg-primary text-primary-foreground"
					: isChecked
						? "border border-primary/30 bg-primary/5"
						: "hover:bg-primary/10",
			)}
		>
			{/* Selection checkbox in selection mode */}
			{selectionMode && (
				<div className="relative z-10">
					<Checkbox
						checked={isChecked}
						onCheckedChange={onToggleCheck}
						onClick={(e) => e.stopPropagation()}
					/>
				</div>
			)}

			{/* Invisible button overlay for main selection */}
			<button
				type="button"
				onClick={() => (selectionMode ? onToggleCheck?.() : onSelect?.(item))}
				className="absolute inset-0 z-0 cursor-pointer rounded-md"
				aria-label={m.vaults_detail_items_list_item_action_select({
					title: item.title,
				})}
			/>

			{/* Content - pointer-events-none so clicks pass through to overlay */}
			<div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-3">
				<Favicon item={item} cardBrand={cardBrand} size="md" />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span className="truncate font-medium text-sm">{item.title}</span>
						{/* TOTP indicator for login items */}
						{item.category === "login" && item.totpSecret && (
							<span title={m.vaults_detail_items_list_item_badge_has_2fa()}>
								<Smartphone
									className={cn(
										"h-3 w-3 shrink-0",
										isSelected
											? "text-primary-foreground"
											: "text-muted-foreground",
									)}
								/>
							</span>
						)}
					</div>
					{item.username && (
						<div
							className={cn(
								"mt-0.5 truncate text-xs",
								isSelected
									? "text-primary-foreground"
									: "text-muted-foreground",
							)}
						>
							{item.username}
						</div>
					)}
					{maskedCardNumber && (
						<div
							className={cn(
								"mt-0.5 truncate text-xs",
								isSelected
									? "text-primary-foreground"
									: "text-muted-foreground",
							)}
						>
							{maskedCardNumber}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
