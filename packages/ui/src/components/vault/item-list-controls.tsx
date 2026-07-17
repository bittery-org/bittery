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
import { cn } from "../../lib/utils";
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
		<div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b px-2">
			<Select
				value={categoryFilter}
				onValueChange={(value) => onCategoryFilterChange(value as ItemListCategoryFilter)}
			>
				<SelectTrigger className="h-7 w-auto min-w-0 max-w-44 gap-1 rounded-md border-0 bg-transparent px-2 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground dark:bg-transparent dark:hover:bg-accent/50 dark:data-[state=open]:bg-accent/50 [&>svg]:size-3">
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
							className={cn(
								"size-7 rounded-md p-0 data-[state=open]:bg-accent data-[state=open]:text-foreground dark:data-[state=open]:bg-accent/50",
								searchQuery &&
									"bg-accent text-foreground dark:bg-accent/50",
							)}
							aria-label={m.vaults_detail_items_list_search_toggle()}
						>
							<IconMagnifier3OutlineDuo18 className="size-3.5" />
						</Button>
					</PopoverTrigger>
					<PopoverContent align="end" className="w-64 overflow-hidden p-0" sideOffset={6}>
						<div className="flex h-9 items-center gap-2 px-3">
							<IconMagnifier3OutlineDuo18 className="size-3.5 shrink-0 text-muted-foreground" />
							<input
								autoFocus
								value={searchQuery}
								onChange={(event) => onSearchQueryChange(event.target.value)}
								placeholder={m.vaults_detail_items_list_search_placeholder()}
								className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
							/>
							{searchQuery ? (
								<button
									type="button"
									onClick={() => onSearchQueryChange("")}
									aria-label={m.vaults_detail_items_list_search_clear()}
									className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground"
								>
									<IconXmarkOutlineDuo18 className="size-3.5" />
								</button>
							) : null}
						</div>
					</PopoverContent>
				</Popover>

				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="size-7 rounded-md p-0 data-[state=open]:bg-accent data-[state=open]:text-foreground dark:data-[state=open]:bg-accent/50"
							aria-label={m.vaults_detail_items_list_sort_toggle()}
						>
							<IconSortObjTopToBottomOutlineDuo18 className="size-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-48">
						<DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.06em]">
							{m.vaults_detail_items_list_sort_menu_label()}
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={sortField}
							onValueChange={(value) => onSortFieldChange(value as ItemListSortField)}
						>
							<DropdownMenuRadioItem value="title">
								<IconSortObjTopToBottomOutlineDuo18 className="size-3.5" />
								{m.vaults_detail_items_list_sort_field_title()}
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="createdAt">
								<IconCalendarOutlineDuo18 className="size-3.5" />
								{m.vaults_detail_items_list_sort_field_created_at()}
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="updatedAt">
								<IconCalendarOutlineDuo18 className="size-3.5" />
								{m.vaults_detail_items_list_sort_field_updated_at()}
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.06em]">
							{m.vaults_detail_items_list_sort_direction_label()}
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={sortDirection}
							onValueChange={(value) =>
								onSortDirectionChange(value as ItemListSortDirection)
							}
						>
							<DropdownMenuRadioItem value="asc">
								<IconVShapedArrowUpOutlineDuo18 className="size-3.5" />
								{m.vaults_detail_items_list_sort_direction_asc()}
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="desc">
								<IconVShapedArrowDownOutlineDuo18 className="size-3.5" />
								{m.vaults_detail_items_list_sort_direction_desc()}
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}