import { useI18n } from "@bittery/i18n/react";
import type { ItemCategory } from "@bittery/shared/types";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";
import {
	IconCalendarOutlineDuo18,
	IconCreditCardLockOutlineDuo18,
	IconFileLockOutlineDuo18,
	IconGrid2OutlineDuo18,
	IconIdBadge2OutlineDuo18,
	IconKeyOutlineDuo18,
	IconMagnifier3OutlineDuo18,
	IconMobileOutlineDuo18,
	IconSortObjTopToBottomOutlineDuo18,
	IconVShapedArrowDownOutlineDuo18,
	IconVShapedArrowUpOutlineDuo18,
	IconXmarkOutlineDuo18,
} from "../../icons";
import { Button } from "../button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../dropdown-menu";
import { Input } from "../input";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from "../select";

type IconComponent = ComponentType<{ className?: string }>;

export type ItemListCategoryFilter = "all" | ItemCategory;
export type ItemListSortField = "title" | "createdAt" | "updatedAt";
export type ItemListSortDirection = "asc" | "desc";

interface CategoryOption {
	value: ItemListCategoryFilter;
	icon: IconComponent;
	label: (m: ReturnType<typeof useI18n>["m"]) => string;
}

const CATEGORY_OPTIONS: CategoryOption[] = [
	{
		value: "all",
		icon: IconGrid2OutlineDuo18,
		label: (m) => m.vaults_detail_items_list_filter_category_all(),
	},
	{
		value: "login",
		icon: IconKeyOutlineDuo18,
		label: (m) => m.vaults_detail_items_list_filter_category_logins(),
	},
	{
		value: "secure-note",
		icon: IconFileLockOutlineDuo18,
		label: (m) => m.vaults_detail_items_list_filter_category_secure_notes(),
	},
	{
		value: "credit-card",
		icon: IconCreditCardLockOutlineDuo18,
		label: (m) => m.vaults_detail_items_list_filter_category_credit_cards(),
	},
	{
		value: "identity",
		icon: IconIdBadge2OutlineDuo18,
		label: (m) => m.vaults_detail_items_list_filter_category_identities(),
	},
	{
		value: "totp",
		icon: IconMobileOutlineDuo18,
		label: (m) => m.vaults_detail_items_list_filter_category_totp(),
	},
];

const DEFAULT_CATEGORY_OPTION = CATEGORY_OPTIONS[0]!;

interface VaultItemListControlsProps {
	categoryFilter: ItemListCategoryFilter;
	onCategoryFilterChange: (value: ItemListCategoryFilter) => void;
	searchQuery: string;
	onSearchQueryChange: (value: string) => void;
	sortField: ItemListSortField;
	onSortFieldChange: (value: ItemListSortField) => void;
	sortDirection: ItemListSortDirection;
	onSortDirectionChange: (value: ItemListSortDirection) => void;
}

export function VaultItemListControls({
	categoryFilter,
	onCategoryFilterChange,
	searchQuery,
	onSearchQueryChange,
	sortField,
	onSortFieldChange,
	sortDirection,
	onSortDirectionChange,
}: VaultItemListControlsProps) {
	const { m } = useI18n();
	const [isSearchOpen, setIsSearchOpen] = useState(false);

	const selectedCategory = useMemo(
		() =>
			CATEGORY_OPTIONS.find((option) => option.value === categoryFilter) ??
			DEFAULT_CATEGORY_OPTION,
		[categoryFilter],
	);

	return (
		<div className="flex shrink-0 items-center justify-between gap-1 border-b px-2 py-1.5">
			<Select
				value={categoryFilter}
				onValueChange={(value) => onCategoryFilterChange(value as ItemListCategoryFilter)}
			>
				<SelectTrigger className="h-7 min-w-0 w-44 border-0 bg-transparent px-2 text-xs shadow-none focus:ring-0">
					<div className="flex min-w-0 items-center gap-1.5">
						<selectedCategory.icon className="size-3.5 shrink-0" />
						<span className="truncate">{selectedCategory.label(m)}</span>
					</div>
				</SelectTrigger>
				<SelectContent className="w-52">
					{CATEGORY_OPTIONS.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							<div className="flex items-center gap-2">
								<option.icon className="size-3.5" />
								<span>{option.label(m)}</span>
							</div>
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<div className="flex items-center gap-0.5">
				<Popover open={isSearchOpen} onOpenChange={setIsSearchOpen}>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="h-7 w-7 p-0"
							aria-label={m.vaults_detail_items_list_search_toggle()}
						>
							<IconMagnifier3OutlineDuo18 className="size-3.5" />
						</Button>
					</PopoverTrigger>
					<PopoverContent align="end" className="w-[260px] p-2" sideOffset={6}>
						<div className="flex items-center gap-1">
							<IconMagnifier3OutlineDuo18 className="size-3.5 shrink-0 text-muted-foreground" />
							<Input
								autoFocus
								value={searchQuery}
								onChange={(event) => onSearchQueryChange(event.target.value)}
								placeholder={m.vaults_detail_items_list_search_placeholder()}
								className="h-8 border-0 px-0 text-sm shadow-none focus-visible:ring-0"
							/>
							{searchQuery ? (
								<Button
									variant="ghost"
									size="sm"
									className="h-6 w-6 p-0"
									onClick={() => onSearchQueryChange("")}
								>
									<IconXmarkOutlineDuo18 className="size-3.5" />
								</Button>
							) : null}
						</div>
					</PopoverContent>
				</Popover>

				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="h-7 w-7 p-0"
							aria-label={m.vaults_detail_items_list_sort_toggle()}
						>
							<IconSortObjTopToBottomOutlineDuo18 className="size-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-56">
						<DropdownMenuLabel className="text-muted-foreground text-xs">
							{m.vaults_detail_items_list_sort_menu_label()}
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={sortField}
							onValueChange={(value) => onSortFieldChange(value as ItemListSortField)}
						>
							<DropdownMenuRadioItem value="title">
								<IconSortObjTopToBottomOutlineDuo18 className="mr-2 size-3.5" />
								{m.vaults_detail_items_list_sort_field_title()}
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="createdAt">
								<IconCalendarOutlineDuo18 className="mr-2 size-3.5" />
								{m.vaults_detail_items_list_sort_field_created_at()}
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="updatedAt">
								<IconCalendarOutlineDuo18 className="mr-2 size-3.5" />
								{m.vaults_detail_items_list_sort_field_updated_at()}
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-muted-foreground text-xs">
							{m.vaults_detail_items_list_sort_direction_label()}
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={sortDirection}
							onValueChange={(value) =>
								onSortDirectionChange(value as ItemListSortDirection)
							}
						>
							<DropdownMenuRadioItem value="asc">
								<IconVShapedArrowUpOutlineDuo18 className="mr-2 size-3.5" />
								{m.vaults_detail_items_list_sort_direction_asc()}
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="desc">
								<IconVShapedArrowDownOutlineDuo18 className="mr-2 size-3.5" />
								{m.vaults_detail_items_list_sort_direction_desc()}
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}