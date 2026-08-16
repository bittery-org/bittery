/**
 * M1-C6 — item list for one vault. Pushed from `/vault`; each row navigates to
 * `/vault/$id/$itemId`. No virtualisation: the spike measured ~51ms to decrypt 2 000 items, so a
 * plain list is fine for M1.
 *
 * M3-C2 adds a "+" header action (`CreateItemSheet`, preselected to this vault) and a favorite
 * star on every row (`MobileItemRow`, `useFavoriteToggle`).
 */

import {
	useAllVaultKeys,
	useVaultInfo,
	useVaultItems,
} from "@bittery/core/hooks";
import { CreateItemSheet, Skeleton } from "@bittery/ui";
import { IconPlus, IconQrCode } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MobileScreen } from "@/components/mobile-screen";
import { MobileItemRow } from "@/components/vault/item-row";
import { useCreateItemFlow } from "@/hooks/use-create-item-flow";
import { useFavoriteToggle } from "@/hooks/use-favorite-toggle";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/$id/")({
	component: VaultItemListScreen,
});

function ItemListSkeleton() {
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

function VaultItemListScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { id } = Route.useParams();
	const { vaultInfo } = useVaultInfo(id);
	const { items, isLoading } = useVaultItems(id);
	const { vaultKeys } = useAllVaultKeys();
	const createItemFlow = useCreateItemFlow(vaultKeys);
	const { handleToggle } = useFavoriteToggle();

	return (
		<MobileScreen
			title={vaultInfo?.vaultName ?? m.mob_vault_items_fallback_title()}
			backLabel={m.mob_common_go_back()}
			onBack={() => navigate({ to: "/vault" })}
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
				<ItemListSkeleton />
			) : items.length === 0 ? (
				<div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
					<h2 className="font-semibold text-lg">
						{m.mob_vault_items_empty_no_items()}
					</h2>
					<p className="text-muted-foreground text-sm">
						{m.mob_vault_items_empty_description()}
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-px p-1.5">
					{items.map((item) => (
						<MobileItemRow
							key={item.id}
							item={item}
							onSelect={() =>
								navigate({
									to: "/vault/$id/$itemId",
									params: { id, itemId: item.id },
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
				selectedVaultId={id}
				side="bottom"
				onCreateItem={createItemFlow.handleCreateItem}
			/>
		</MobileScreen>
	);
}
