import { maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { VaultItemListRow } from "@bittery/ui";
import { IconClock, IconPasskey, IconStar } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { Favicon } from "@/components/vault/favicon";
import { useI18n } from "@/providers/i18n-provider";

type RowItem = DecryptedItemWithContext & {
	id: string;
	vaultId: string;
	vault?: { name: string } | null;
};

interface MobileItemRowProps {
	item: RowItem;
	onSelect: () => void;
	onToggleFavorite: () => void;
	/** All-items / favorites / tag / search span multiple vaults; the per-vault list does not. */
	showVaultName?: boolean;
}

/**
 * Shared item row for every mobile list screen (per-vault items, all-items, favorites, tag,
 * search results). Wraps `@bittery/ui`'s `VaultItemListRow`, which owns the whole row as a
 * click target via an absolutely-positioned `z-0` button, and adds a favorite star as a later
 * DOM sibling inside a `relative` wrapper — later siblings paint on top without an explicit
 * `z-index` fight, and `stopPropagation` keeps the tap from also firing row selection. Desktop
 * has no equivalent: `VaultItemListRow` takes no trailing-action slot, and the one desktop
 * screen with a row-level favorite toggle (`apps/desktop/src/routes/vault/$id/tag/$tagName.tsx`)
 * hand-rolls its own row rather than reusing `VaultItemListRow`, for the same reason.
 */
export function MobileItemRow({
	item,
	onSelect,
	onToggleFavorite,
	showVaultName = false,
}: MobileItemRowProps) {
	const { m } = useI18n();
	const maskedCardNumber = item.cardNumber
		? maskCardNumber(item.cardNumber)
		: undefined;
	const hasPasskeys =
		item.category === "login" && (item.passkeys?.length ?? 0) > 0;
	const vaultName = showVaultName ? item.vault?.name : undefined;

	return (
		<div className="relative">
			<VaultItemListRow
				itemTitle={item.title}
				ariaLabel={m.vaults_detail_items_list_item_action_select({
					title: item.title,
				})}
				leadingVisual={<Favicon item={item} size="sm" />}
				indicators={
					<>
						{item.category === "login" && item.totpSecret && (
							<IconClock className="size-3 shrink-0 text-muted-foreground" />
						)}
						{hasPasskeys && (
							<IconPasskey className="size-3 shrink-0 text-muted-foreground" />
						)}
					</>
				}
				secondaryText={item.username ?? undefined}
				tertiaryText={vaultName ?? maskedCardNumber}
				isSelected={false}
				onPrimaryAction={onSelect}
				className="pr-10"
			/>
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					onToggleFavorite();
				}}
				aria-label={
					item.favorite
						? m.vaults_detail_items_list_item_action_remove_favorite()
						: m.vaults_detail_items_list_item_action_add_favorite()
				}
				className={cn(
					"absolute top-1/2 right-1 z-20 flex size-9 -translate-y-1/2 items-center justify-center rounded-md active:bg-foreground/10",
					item.favorite ? "text-yellow-500" : "text-muted-foreground",
				)}
			>
				<IconStar
					className="size-4"
					fill={item.favorite ? "currentColor" : "none"}
				/>
			</button>
		</div>
	);
}
