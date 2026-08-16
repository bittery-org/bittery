/**
 * M3-C2 — "All Items" tab (D12). Every item across every unlocked vault, favorites pinned to the
 * top under their own section header (mirrors desktop's `/vault/all-items`,
 * `apps/desktop/src/routes/vault/all-items/route.tsx). The "Favorites" section header doubles
 * as the entry point to the dedicated `/vault/favorites` list — there is no bottom-tab entry for
 * favorites (see the nav decision in `docs/mobile-migration-decisions.md`).
 */

import {
	useAllVaultKeys,
	useItemListFilters,
	useItems,
} from "@bittery/core/hooks";
import { CreateItemSheet, Skeleton } from "@bittery/ui";
import { IconChevronRight, IconPlus, IconQrCode } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MobileItemRow } from "@/components/vault/item-row";
import { TabScreen } from "@/components/vault/tab-screen";
import { useCreateItemFlow } from "@/hooks/use-create-item-flow";
import { useFavoriteToggle } from "@/hooks/use-favorite-toggle";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/all-items/")({
	component: AllItemsScreen,
});

function AllItemsSkeleton() {
	return (
		<div className="flex flex-col gap-px p-1.5">
			{[0, 1, 2, 3].map((row) => (
				<div key={row} className="flex items-center gap-2.5 px-2.5 py-2">
					<Skeleton className="size-10 rounded-lg" />
					<div className="flex-1 space-y-1.5">
						<Skeleton className="h-3.5 w-40" />
						<Skeleton className="h-3 w-24" />
					</div>
				</div>
			))}
		</div>
	);
}

function AllItemsScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { items, isLoading } = useItems();
	const { vaultKeys } = useAllVaultKeys();
	const { favoriteItems, regularItems } = useItemListFilters({ items });
	const createItemFlow = useCreateItemFlow(vaultKeys);
	const { handleToggle } = useFavoriteToggle();

	return (
		<TabScreen
			title={m.mob_tab_all_items()}
			activeTab="all-items"
			headerEnd={
				<>
					{/* "Scan TOTP QR" has no existing i18n key — hard-coded English per the
					    migration brief; see the chunk report for the full list. */}
					<button
						type="button"
						onClick={() => void createItemFlow.scanTotpQr()}
						aria-label="Scan TOTP QR code"
						title="Scan TOTP QR code"
						className="flex size-11 shrink-0 items-center justify-center rounded-md text-foreground active:bg-foreground/5"
					>
						<IconQrCode className="size-5" />
					</button>
					<button
						type="button"
						onClick={() => createItemFlow.setIsOpen(true)}
						aria-label={m.mob_create_item_header()}
						className="flex size-11 shrink-0 items-center justify-center rounded-md text-foreground active:bg-foreground/5"
					>
						<IconPlus className="size-5" />
					</button>
				</>
			}
		>
			{isLoading ? (
				<AllItemsSkeleton />
			) : items.length === 0 ? (
				<div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
					<h2 className="font-semibold text-lg">
						{m.mob_items_empty_no_items()}
					</h2>
					<p className="text-muted-foreground text-sm">
						{m.mob_items_empty_add_items_description()}
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-px p-1.5">
					{favoriteItems.length > 0 && (
						<button
							type="button"
							onClick={() => navigate({ to: "/vault/favorites" })}
							className="mt-1 mb-1 flex min-h-9 w-full items-center justify-between px-2.5 text-left"
						>
							<span className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
								{m.mob_items_section_favorites()}
							</span>
							<IconChevronRight className="size-3.5 text-muted-foreground" />
						</button>
					)}
					{favoriteItems.map((item) => (
						<MobileItemRow
							key={item.id}
							item={item}
							showVaultName
							onSelect={() =>
								navigate({
									to: "/vault/all-items/$itemId",
									params: { itemId: item.id },
								})
							}
							onToggleFavorite={() => handleToggle(item)}
						/>
					))}
					{favoriteItems.length > 0 && regularItems.length > 0 && (
						<div className="mt-3 mb-1 px-2.5 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
							{m.mob_items_section_all()}
						</div>
					)}
					{regularItems.map((item) => (
						<MobileItemRow
							key={item.id}
							item={item}
							showVaultName
							onSelect={() =>
								navigate({
									to: "/vault/all-items/$itemId",
									params: { itemId: item.id },
								})
							}
							onToggleFavorite={() => handleToggle(item)}
						/>
					))}
				</div>
			)}

			<CreateItemSheet
				open={createItemFlow.isOpen}
				onOpenChange={createItemFlow.setIsOpen}
				vaults={createItemFlow.vaultOptions}
				side="bottom"
				onCreateItem={createItemFlow.handleCreateItem}
			/>
		</TabScreen>
	);
}
