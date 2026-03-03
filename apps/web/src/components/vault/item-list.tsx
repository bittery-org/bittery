import { useAvailableTags, useToggleFavorite } from "@bittery/core/hooks";
import { detectCardBrand, maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import {
	Badge,
	Button,
	Checkbox,
	cn,
	Input,
	ScrollArea,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Skeleton,
	toast,
} from "@bittery/ui";
import {
	IconKeyOutlineDuo18 as Key,
	IconMagnifier3OutlineDuo18 as Search,
	IconMobileOutlineDuo18 as Smartphone,
	IconStarOutlineDuo18 as Star,
	IconXmarkOutlineDuo18 as X,
} from "@bittery/ui/icons";
import { useMemo, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { Favicon } from "./favicon";
import { TagBadge } from "./tag-badge";
import { TagFilter } from "./tag-filter";

interface ItemListProps {
	items: DecryptedItem[];
	isLoading: boolean;
	vaultId: string;
	canWriteItems?: boolean;
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
		| "vaults.detail.items.list.filter.category.all"
		| "vaults.detail.items.list.filter.category.logins"
		| "vaults.detail.items.list.filter.category.secure_notes"
		| "vaults.detail.items.list.filter.category.credit_cards"
		| "vaults.detail.items.list.filter.category.identities"
		| "vaults.detail.items.list.filter.category.totp";
}[] = [
	{ value: "all", labelKey: "vaults.detail.items.list.filter.category.all" },
	{
		value: "login",
		labelKey: "vaults.detail.items.list.filter.category.logins",
	},
	{
		value: "secure-note",
		labelKey: "vaults.detail.items.list.filter.category.secure_notes",
	},
	{
		value: "credit-card",
		labelKey: "vaults.detail.items.list.filter.category.credit_cards",
	},
	{
		value: "identity",
		labelKey: "vaults.detail.items.list.filter.category.identities",
	},
	{ value: "totp", labelKey: "vaults.detail.items.list.filter.category.totp" },
];

function getCategoryBadgeLabel(
	category: ItemCategory,
	m: ReturnType<typeof useI18n>["m"],
) {
	switch (category) {
		case "login":
			return m["vaults.detail.items.category.login.title"]();
		case "secure-note":
			return m["vaults.detail.items.category.secure_note.title"]();
		case "credit-card":
			return m["vaults.detail.items.category.credit_card.title"]();
		case "identity":
			return m["vaults.detail.items.category.identity.title"]();
		case "totp":
			return m["vaults.detail.items.category.totp.title"]();
		default:
			return category;
	}
}

export function ItemList({
	items,
	isLoading,
	vaultId,
	canWriteItems = true,
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

	// Mutation to toggle favorite
	const toggleFavorite = useToggleFavorite();

	const handleToggleFavorite = async (
		e: React.MouseEvent,
		itemId: string,
		currentFavorite: boolean,
	) => {
		e.preventDefault();
		e.stopPropagation();
		try {
			await toggleFavorite.mutateAsync({
				itemId,
				vaultId,
				favorite: !currentFavorite,
			});
			toast.success(m["vaults.detail.items.list.toast.favorite_updated"]());
		} catch (error) {
			toast.error(m["vaults.detail.items.list.toast.favorite_update_failed"]());
			console.error(error);
		}
	};

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
				<div className="flex shrink-0 gap-2">
					<Skeleton className="h-10 flex-1" />
					<Skeleton className="h-10 w-40" />
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
		<div className="flex min-h-0 flex-1 flex-col gap-4">
			{/* Search and Filter Bar - Fixed Header */}
			<div className="flex shrink-0 flex-col gap-2">
				<div className="flex gap-2">
					<div className="relative flex-1">
						<Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							type="text"
							placeholder={m["vaults.detail.items.list.search.placeholder"]()}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pr-9 pl-9"
						/>
						{searchQuery && (
							<button
								type="button"
								onClick={() => setSearchQuery("")}
								className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
							>
								<X className="h-4 w-4" />
							</button>
						)}
					</div>
					<Select
						value={categoryFilter}
						onValueChange={(value: CategoryFilter) => setCategoryFilter(value)}
					>
						<SelectTrigger className="w-40">
							<SelectValue
								placeholder={m["vaults.detail.items.list.filter.category.placeholder"]()}
							/>
						</SelectTrigger>
						<SelectContent>
							{CATEGORY_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{m[option.labelKey]()}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{/* Tag filter */}
				{availableTags.length > 0 && (
					<div className="flex items-center gap-2">
						<TagFilter
							tags={availableTags}
							selectedTags={selectedTags}
							onSelectionChange={setSelectedTags}
						/>
					</div>
				)}
			</div>

			{/* Results summary - Fixed */}
			{hasActiveFilters && (
				<div className="flex shrink-0 items-center gap-2 text-muted-foreground text-sm">
					<span>
						{filteredItems.length === 1
							? m["vaults.detail.items.list.results.single"]({
									count: filteredItems.length,
								})
							: m["vaults.detail.items.list.results.plural"]({
									count: filteredItems.length,
								})}
					</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setSearchQuery("");
							setCategoryFilter("all");
							setSelectedTags([]);
						}}
						className="h-6 px-2 text-xs"
					>
						{m["vaults.detail.items.list.action.clear_filters"]()}
					</Button>
				</div>
			)}

			{/* Selection mode header */}
			{selectionMode && filteredItems.length > 0 && (
				<div className="flex shrink-0 items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
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
								? m["vaults.detail.items.list.selection.selected.single"]({
										count: selectedItemIds.length,
									})
								: m["vaults.detail.items.list.selection.selected.plural"]({
										count: selectedItemIds.length,
									})
							: m["vaults.detail.items.list.selection.select_all"]()}
					</span>
				</div>
			)}

			{/* Scrollable Items List */}
			{filteredItems.length === 0 ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center py-12 text-center">
					<div className="mb-4 rounded-full bg-muted p-4">
						<Key className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="mb-1 font-semibold">
						{hasActiveFilters
							? m["vaults.detail.items.list.empty.filtered.title"]()
							: m["vaults.detail.items.list.empty.default.title"]()}
					</h3>
					<p className="max-w-sm text-muted-foreground text-sm">
						{hasActiveFilters
							? m["vaults.detail.items.list.empty.filtered.description"]()
							: m["vaults.detail.items.list.empty.default.description"]()}
					</p>
				</div>
			) : (
				<ScrollArea
					className="min-h-0 flex-1"
					data-testid="vault-items-scroll-area"
				>
					<div className="space-y-1 pr-4">
						{/* Favorites Section */}
						{favoriteItems.length > 0 && (
							<>
								<div className="px-2 py-2 font-semibold text-muted-foreground text-xs uppercase">
									{m["vaults.detail.items.list.section.favorites"]({
										count: favoriteItems.length,
									})}
								</div>
								{favoriteItems.map((item) => (
									<ItemRow
										key={item.id}
										item={item}
										isSelected={selectedItemId === item.id}
										onSelect={onItemSelect}
										onToggleFavorite={handleToggleFavorite}
										canWriteItems={canWriteItems}
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
										{m["vaults.detail.items.list.section.all_items"]({
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
										onToggleFavorite={handleToggleFavorite}
										canWriteItems={canWriteItems}
										selectionMode={selectionMode}
										isChecked={selectedItemIds.includes(item.id)}
										onToggleCheck={() => handleToggleSelection(item.id)}
									/>
								))}
							</>
						)}
					</div>
				</ScrollArea>
			)}
		</div>
	);
}

interface ItemRowProps {
	item: DecryptedItem;
	isSelected: boolean;
	onSelect?: (item: DecryptedItem) => void;
	onToggleFavorite: (
		e: React.MouseEvent,
		itemId: string,
		currentFavorite: boolean,
	) => void;
	canWriteItems: boolean;
	selectionMode?: boolean;
	isChecked?: boolean;
	onToggleCheck?: () => void;
}

function ItemRow({
	item,
	isSelected,
	onSelect,
	onToggleFavorite,
	canWriteItems,
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

	return (
		<div
			className={cn(
				"relative",
				"flex",
				"items-center",
				"gap-3",
				"rounded-lg",
				"border",
				"p-3",
				"transition-colors",
				isSelected
					? "border-primary/50 bg-muted/60"
					: isChecked
						? "border-primary/30 bg-primary/5"
						: "border-transparent hover:bg-muted/30",
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
				className="absolute inset-0 z-0 cursor-pointer rounded-lg"
				aria-label={m["vaults.detail.items.list.item.action.select"]({
					title: item.title,
				})}
			/>

			{/* Content - pointer-events-none so clicks pass through to overlay */}
			<div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-3">
				<Favicon
					url={item.url}
					title={item.title}
					category={item.category}
					cardBrand={cardBrand}
					size="md"
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate font-medium">{item.title}</span>
						{/* TOTP indicator for login items */}
						{item.category === "login" && item.totpSecret && (
							<span title={m["vaults.detail.items.list.item.badge.has_2fa"]()}>
								<Smartphone className="h-3 w-3 shrink-0 text-primary" />
							</span>
						)}
					</div>
					{item.username && (
						<div className="truncate text-muted-foreground text-sm">
							{item.username}
						</div>
					)}
					{maskedCardNumber && (
						<div className="truncate text-muted-foreground text-sm">
							{maskedCardNumber}
						</div>
					)}
					{/* Display tags */}
					{item.tags && item.tags.length > 0 && (
						<div className="mt-1 flex flex-wrap gap-1">
							{item.tags.slice(0, 3).map((tag) => (
								<TagBadge key={tag} name={tag} size="sm" />
							))}
							{item.tags.length > 3 && (
								<span className="text-muted-foreground text-xs">
									{item.tags.length - 3 === 1
										? m["vaults.detail.items.list.item.tags.more.single"]({
												count: item.tags.length - 3,
											})
										: m["vaults.detail.items.list.item.tags.more.plural"]({
												count: item.tags.length - 3,
											})}
								</span>
							)}
						</div>
					)}
				</div>
				<Badge variant="outline" className="shrink-0 capitalize">
					{getCategoryBadgeLabel(item.category, m)}
				</Badge>
			</div>

			{/* Favorite button - interactive, above the overlay */}
			{!selectionMode && canWriteItems && (
				<button
					type="button"
					onClick={(e) => onToggleFavorite(e, item.id, item.favorite)}
					aria-label={
						item.favorite
							? m["vaults.detail.items.list.item.action.remove_favorite"]()
							: m["vaults.detail.items.list.item.action.add_favorite"]()
					}
					className={cn(
						"relative",
						"z-10",
						"shrink-0",
						"transition-colors",
						item.favorite
							? "text-yellow-500 hover:text-yellow-600"
							: "text-muted-foreground hover:text-yellow-500",
					)}
				>
					<Star
						className="h-4 w-4"
						fill={item.favorite ? "currentColor" : "none"}
					/>
				</button>
			)}
		</div>
	);
}
