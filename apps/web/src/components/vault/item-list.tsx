import { detectCardBrand, maskCardNumber } from "@bittery/shared/credit-card";
import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import {
	Badge,
	Button,
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
import { useMutation } from "@tanstack/react-query";
import { Key, Search, Smartphone, Star, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useQueryInvalidator } from "../../providers/sync-provider";
import { Favicon } from "./favicon";

interface ItemListProps {
	items: DecryptedItem[];
	isLoading: boolean;
	vaultId: string;
	onItemSelect?: (item: DecryptedItem) => void;
	selectedItemId?: string;
}

type CategoryFilter = "all" | ItemCategory;

const CATEGORY_OPTIONS: { value: CategoryFilter; label: string }[] = [
	{ value: "all", label: "All Categories" },
	{ value: "login", label: "Logins" },
	{ value: "secure-note", label: "Secure Notes" },
	{ value: "credit-card", label: "Credit Cards" },
	{ value: "identity", label: "Identities" },
	{ value: "totp", label: "TOTP" },
];

export function ItemList({
	items,
	isLoading,
	vaultId,
	onItemSelect,
	selectedItemId,
}: ItemListProps) {
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	const [searchQuery, setSearchQuery] = useState("");
	const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");

	// Mutation to toggle favorite
	const toggleFavoriteMutation = useMutation({
		mutationFn: (params: { itemId: string; favorite: boolean }) =>
			trpcClient.vault.toggleFavorite.mutate(params),
		onSuccess: (_data, variables) => {
			toast.success("Favorite updated");
			// Invalidate item to refresh the items
			invalidator.invalidateItem(variables.itemId, vaultId);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to update favorite");
		},
	});

	const handleToggleFavorite = (
		e: React.MouseEvent,
		itemId: string,
		currentFavorite: boolean,
	) => {
		e.preventDefault();
		e.stopPropagation();
		toggleFavoriteMutation.mutate({
			itemId,
			favorite: !currentFavorite,
		});
	};

	// Filter and search items
	const filteredItems = useMemo(() => {
		let result = [...items];

		// Apply category filter
		if (categoryFilter !== "all") {
			result = result.filter((item) => item.category === categoryFilter);
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
	}, [items, categoryFilter, searchQuery]);

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

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4">
			{/* Search and Filter Bar - Fixed Header */}
			<div className="flex shrink-0 gap-2">
				<div className="relative flex-1">
					<Search className="-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-muted-foreground" />
					<Input
						type="text"
						placeholder="Search items..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pr-9 pl-9"
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							className="-translate-y-1/2 absolute top-1/2 right-3 text-muted-foreground hover:text-foreground"
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
						<SelectValue placeholder="Category" />
					</SelectTrigger>
					<SelectContent>
						{CATEGORY_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* Results summary - Fixed */}
			{(searchQuery || categoryFilter !== "all") && (
				<div className="flex shrink-0 items-center gap-2 text-muted-foreground text-sm">
					<span>
						{filteredItems.length} result{filteredItems.length !== 1 ? "s" : ""}
					</span>
					{(searchQuery || categoryFilter !== "all") && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setSearchQuery("");
								setCategoryFilter("all");
							}}
							className="h-6 px-2 text-xs"
						>
							Clear filters
						</Button>
					)}
				</div>
			)}

			{/* Scrollable Items List */}
			{filteredItems.length === 0 ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center py-12 text-center">
					<div className="mb-4 rounded-full bg-muted p-4">
						<Key className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="mb-1 font-semibold">
						{searchQuery || categoryFilter !== "all"
							? "No matching items"
							: "No items yet"}
					</h3>
					<p className="max-w-sm text-muted-foreground text-sm">
						{searchQuery || categoryFilter !== "all"
							? "Try adjusting your search or filters"
							: "Create your first item in the desktop app"}
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
									Favorites ({favoriteItems.length})
								</div>
								{favoriteItems.map((item) => (
									<ItemRow
										key={item.id}
										item={item}
										isSelected={selectedItemId === item.id}
										onSelect={onItemSelect}
										onToggleFavorite={handleToggleFavorite}
									/>
								))}
							</>
						)}

						{/* All Items Section */}
						{regularItems.length > 0 && (
							<>
								{favoriteItems.length > 0 && (
									<div className="mt-4 px-2 py-2 font-semibold text-muted-foreground text-xs uppercase">
										All Items ({regularItems.length})
									</div>
								)}
								{regularItems.map((item) => (
									<ItemRow
										key={item.id}
										item={item}
										isSelected={selectedItemId === item.id}
										onSelect={onItemSelect}
										onToggleFavorite={handleToggleFavorite}
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
}

function ItemRow({
	item,
	isSelected,
	onSelect,
	onToggleFavorite,
}: ItemRowProps) {
	const maskedCardNumber = item.cardNumber
		? maskCardNumber(item.cardNumber)
		: undefined;
	const cardBrand = item.cardNumber
		? detectCardBrand(item.cardNumber)
		: undefined;

	return (
		<div
			className={`relative flex items-center gap-3 rounded-lg border p-3 transition-colors ${
				isSelected
					? "border-primary/50 bg-muted/60"
					: "border-transparent hover:bg-muted/30"
			}`}
		>
			{/* Invisible button overlay for main selection */}
			<button
				type="button"
				onClick={() => onSelect?.(item)}
				className="absolute inset-0 z-0 cursor-pointer rounded-lg"
				aria-label={`Select ${item.title}`}
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
							<span title="Has 2FA">
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
				</div>
				<Badge variant="outline" className="shrink-0 capitalize">
					{item.category.replace("-", " ")}
				</Badge>
			</div>

			{/* Favorite button - interactive, above the overlay */}
			<button
				type="button"
				onClick={(e) => onToggleFavorite(e, item.id, item.favorite)}
				aria-label={item.favorite ? "Remove from favorites" : "Add to favorites"}
				className={`relative z-10 shrink-0 transition-colors ${
					item.favorite
						? "text-yellow-500 hover:text-yellow-600"
						: "text-muted-foreground hover:text-yellow-500"
				}`}
			>
				<Star
					className="h-4 w-4"
					fill={item.favorite ? "currentColor" : "none"}
				/>
			</button>
		</div>
	);
}
