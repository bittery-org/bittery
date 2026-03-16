import type { ItemCategory } from "@bittery/shared/types";
import { useMemo, useState } from "react";

export type ItemListCategoryFilter = "all" | ItemCategory;
export type ItemListSortField = "title" | "createdAt" | "updatedAt";
export type ItemListSortDirection = "asc" | "desc";

export interface ItemListFilterable {
	title: string;
	category: ItemCategory;
	createdAt: string | Date;
	updatedAt: string | Date;
	favorite?: boolean;
	username?: string | null;
	url?: string | null;
	email?: string | null;
	notes?: string | null;
	note?: string | null;
}

interface UseItemListFiltersOptions<TItem extends ItemListFilterable> {
	items: TItem[];
	initialCategoryFilter?: ItemListCategoryFilter;
	initialSearchQuery?: string;
	initialSortField?: ItemListSortField;
	initialSortDirection?: ItemListSortDirection;
}

export function useItemListFilters<TItem extends ItemListFilterable>({
	items,
	initialCategoryFilter = "all",
	initialSearchQuery = "",
	initialSortField = "updatedAt",
	initialSortDirection = "desc",
}: UseItemListFiltersOptions<TItem>) {
	const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
	const [categoryFilter, setCategoryFilter] =
		useState<ItemListCategoryFilter>(initialCategoryFilter);
	const [sortField, setSortField] = useState<ItemListSortField>(initialSortField);
	const [sortDirection, setSortDirection] =
		useState<ItemListSortDirection>(initialSortDirection);

	const filteredItems = useMemo(() => {

        console.log('filtering items');
        

		let result = [...items];

		if (categoryFilter !== "all") {
			result = result.filter((item) => item.category === categoryFilter);
		}

		const normalizedQuery = searchQuery.trim().toLowerCase();
		if (normalizedQuery.length > 0) {
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
					field?.toLowerCase().includes(normalizedQuery),
				);
			});
		}

		const compareBySortField = (a: TItem, b: TItem) => {
			if (sortField === "title") {
				return a.title.localeCompare(b.title, undefined, {
					sensitivity: "base",
				});
			}

			const aDate = new Date(
				sortField === "createdAt" ? a.createdAt : a.updatedAt,
			).getTime();
			const bDate = new Date(
				sortField === "createdAt" ? b.createdAt : b.updatedAt,
			).getTime();
			return aDate - bDate;
		};

		result.sort((a, b) => {
			if (a.favorite && !b.favorite) return -1;
			if (!a.favorite && b.favorite) return 1;

			const sortValue = compareBySortField(a, b);
			return sortDirection === "asc" ? sortValue : -sortValue;
		});

		return result;
	}, [items, categoryFilter, searchQuery, sortField, sortDirection]);

	const favoriteItems = useMemo(
		() => filteredItems.filter((item) => item.favorite),
		[filteredItems],
	);
	const regularItems = useMemo(
		() => filteredItems.filter((item) => !item.favorite),
		[filteredItems],
	);
	const hasActiveFilters =
		searchQuery.trim().length > 0 || categoryFilter !== "all";

	return {
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
	};
}