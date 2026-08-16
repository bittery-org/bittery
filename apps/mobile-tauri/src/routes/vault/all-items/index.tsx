/**
 * The Items tab — the app's centre of gravity. Every item across every unlocked vault, favorites
 * pinned above the rest, filtered by a category rail. Ported from `apps/mobile/app/(tabs)/index.tsx`.
 *
 * Search is not a tab any more (DESIGN-NATIVE.md § Information architecture): the app-bar action
 * pushes `/vault/search`. The "Favorites" section label stays the entry point to `/vault/favorites`,
 * which has no tab of its own either.
 */

import {
	useAllVaultKeys,
	useItemListFilters,
	useItems,
} from "@bittery/core/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import {
	IconChevronRight,
	IconClock,
	IconCreditCard,
	IconFileLock,
	IconKey,
	IconLayoutGrid,
	IconQrCode,
	IconSearch,
	IconUser,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ComponentType } from "react";
import {
	BarButton,
	EmptyState,
	Fab,
	iconClass,
	ListCard,
	Pressable,
	SectionLabel,
} from "@/components/ui";
import { CreateItemSheet } from "@/components/vault/create-item-sheet";
import { MobileItemRow } from "@/components/vault/item-row";
import { ItemsSkeleton } from "@/components/vault/items-skeleton";
import { TabScreen } from "@/components/vault/tab-screen";
import { useCreateItemFlow } from "@/hooks/use-create-item-flow";
import { useFavoriteToggle } from "@/hooks/use-favorite-toggle";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/all-items/")({
	component: AllItemsScreen,
});

type CategoryValue = ItemCategory | "all";

const CATEGORY_GLYPHS: Record<
	CategoryValue,
	ComponentType<{ className?: string }>
> = {
	all: IconLayoutGrid,
	login: IconKey,
	"credit-card": IconCreditCard,
	identity: IconUser,
	"secure-note": IconFileLock,
	totp: IconClock,
};

function AllItemsScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { items, isLoading } = useItems();
	const { vaultKeys } = useAllVaultKeys();
	const {
		favoriteItems,
		regularItems,
		categoryFilter,
		setCategoryFilter,
		hasActiveFilters,
	} = useItemListFilters({ items });
	const createItemFlow = useCreateItemFlow(vaultKeys);
	const { handleToggle } = useFavoriteToggle();

	const hasRows = favoriteItems.length > 0 || regularItems.length > 0;

	const openItem = (itemId: string) =>
		navigate({ to: "/vault/all-items/$itemId", params: { itemId } });

	return (
		<TabScreen
			title={m.mob_tab_all_items()}
			activeTab="items"
			aurora
			actions={
				<>
					<BarButton
						onClick={() => navigate({ to: "/vault/search" })}
						aria-label={m.mob_tab_search()}
					>
						<IconSearch className={iconClass.bar} />
					</BarButton>
					<BarButton
						onClick={() => void createItemFlow.scanTotpQr()}
						aria-label={m.mob_form_totp_scan_qr()}
					>
						<IconQrCode className={iconClass.bar} />
					</BarButton>
				</>
			}
			toolbar={
				<CategoryRail value={categoryFilter} onChange={setCategoryFilter} />
			}
			overlay={
				<Fab
					onPress={() => createItemFlow.setIsOpen(true)}
					ariaLabel={m.mob_create_item_header()}
				/>
			}
		>
			{isLoading ? (
				<ItemsSkeleton />
			) : !hasRows ? (
				hasActiveFilters ? (
					<EmptyState
						className="min-h-full"
						icon={IconSearch}
						title={m.mob_items_empty_no_items_filtered()}
						description={m.mob_items_empty_try_filter()}
					/>
				) : (
					<EmptyState
						className="min-h-full"
						icon={IconKey}
						title={m.mob_items_empty_no_items()}
						description={m.mob_items_empty_add_items_description()}
						action={{
							label: m.mob_vault_items_empty_add_item(),
							onPress: () => createItemFlow.setIsOpen(true),
						}}
					/>
				)
			) : (
				<div className="flex flex-col gap-6 px-4 pt-4">
					{favoriteItems.length > 0 ? (
						<section>
							{/* The label is the affordance: favorites has no tab, so this is how the
							    full list is reached. */}
							<Pressable
								onClick={() => navigate({ to: "/vault/favorites" })}
								className="w-full rounded-lg"
								aria-label={m.vaults_favorites_title()}
							>
								<SectionLabel
									trailing={
										<IconChevronRight
											className={cn(
												iconClass.chip,
												"text-muted-foreground opacity-60",
											)}
										/>
									}
								>
									{m.mob_items_section_favorites()}
								</SectionLabel>
							</Pressable>
							<ListCard>
								{favoriteItems.map((item) => (
									<MobileItemRow
										key={item.id}
										item={item}
										showVaultName
										onSelect={() => openItem(item.id)}
										onToggleFavorite={() => handleToggle(item)}
									/>
								))}
							</ListCard>
						</section>
					) : null}

					{regularItems.length > 0 ? (
						<section>
							{favoriteItems.length > 0 ? (
								<SectionLabel>{m.mob_items_section_all()}</SectionLabel>
							) : null}
							<ListCard>
								{regularItems.map((item) => (
									<MobileItemRow
										key={item.id}
										item={item}
										showVaultName
										onSelect={() => openItem(item.id)}
										onToggleFavorite={() => handleToggle(item)}
									/>
								))}
							</ListCard>
						</section>
					) : null}
				</div>
			)}

			<CreateItemSheet
				open={createItemFlow.isOpen}
				onOpenChange={createItemFlow.setIsOpen}
				vaults={createItemFlow.vaultOptions}
				initialCategory={createItemFlow.initialCategory}
				onCreateItem={createItemFlow.handleCreateItem}
			/>
		</TabScreen>
	);
}

/**
 * Horizontal category rail. `-mx-4 px-4` cancels the toolbar's own inset so the rail scrolls
 * edge to edge — a filter row that stops short of the screen edge reads as a boxed web control.
 */
function CategoryRail({
	value,
	onChange,
}: {
	value: CategoryValue;
	onChange: (value: CategoryValue) => void;
}) {
	const { m } = useI18n();

	const chips: Array<[CategoryValue, string]> = [
		["all", m.mob_category_chip_all()],
		["login", m.mob_category_login()],
		["credit-card", m.mob_category_credit_card()],
		["identity", m.mob_category_identity()],
		["secure-note", m.mob_category_secure_note()],
		["totp", m.mob_category_totp()],
	];

	return (
		<div className="-mx-4 flex gap-2 overflow-x-auto px-4 py-0.5">
			{chips.map(([key, label]) => {
				const Glyph = CATEGORY_GLYPHS[key];
				const isActive = key === value;

				return (
					<Pressable
						key={key}
						onClick={() => onChange(key)}
						aria-pressed={isActive}
						className={cn(
							"flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 font-medium text-sm",
							isActive
								? "border-primary/15 bg-selected text-foreground"
								: "border-border bg-surface text-muted-foreground",
						)}
					>
						<Glyph className={iconClass.chip} />
						{label}
					</Pressable>
				);
			})}
		</div>
	);
}
