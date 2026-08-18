/**
 * The shared item row for every list in the app (per-vault items, Items, favorites, tag).
 * Ported from `apps/mobile/src/components/item-list-item.tsx`.
 *
 * It used to wrap `@bittery/ui`'s `VaultItemListRow`, a dense desktop row sized for a mouse. This
 * is the native shape instead: a 56pt row, a 40pt leading tile, a title line that carries the
 * TOTP and passkey indicators, and a second line for the identifying detail (username, category,
 * masked card). Vault name stays off the row — it belongs on the item, not in the list.
 * The row paints no background or border — it lives inside a `ListCard`, which owns the card
 * chrome and the hairlines between rows.
 */

import { maskCardNumber } from "@bittery/shared/credit-card";
import { getDomainFromUrl } from "@bittery/shared/favicon";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { IconClock, IconPasskey, IconStar } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { iconClass, layout, Pressable } from "@/components/ui";
import { Favicon } from "@/components/vault/favicon";
import { useI18n } from "@/providers/i18n-provider";

type Messages = ReturnType<typeof useI18n>["m"];

type RowItem = DecryptedItemWithContext & {
	id: string;
	vaultId: string;
};

interface MobileItemRowProps {
	item: RowItem;
	onSelect: () => void;
	onToggleFavorite: () => void;
}

/** Login rows show who the credential belongs to; every other category names itself. */
function getSubtitle(item: RowItem, m: Messages): string | null {
	switch (item.category) {
		case "login":
			return (
				item.username || (item.url ? getDomainFromUrl(item.url) : null) || null
			);
		case "credit-card":
			return item.cardNumber
				? maskCardNumber(item.cardNumber)
				: m.mob_category_credit_card();
		case "identity":
			return m.mob_category_identity();
		case "secure-note":
			return m.mob_category_secure_note();
		case "totp":
			return m.mob_category_totp();
		default:
			return null;
	}
}

export function MobileItemRow({
	item,
	onSelect,
	onToggleFavorite,
}: MobileItemRowProps) {
	const { m } = useI18n();

	const subtitle = getSubtitle(item, m);
	const hasTotp = item.category === "login" && Boolean(item.totpSecret);
	const hasPasskeys =
		item.category === "login" && (item.passkeys?.length ?? 0) > 0;

	return (
		<div className="relative">
			<Pressable
				onClick={onSelect}
				aria-label={m.vaults_detail_items_list_item_action_select({
					title: item.title,
				})}
				className="flex w-full items-center gap-3 py-2 pr-12 pl-4"
				style={{ minHeight: layout.rowHeight }}
			>
				<Favicon item={item} title={item.title} size="md" />

				<div className="min-w-0 flex-1 text-left">
					<div className="flex items-center gap-1.5">
						<span className="min-w-0 shrink truncate font-medium text-base text-foreground">
							{item.title}
						</span>
						{hasTotp ? (
							<IconClock className="size-3.5 shrink-0 text-muted-foreground" />
						) : null}
						{hasPasskeys ? (
							<IconPasskey className="size-3.5 shrink-0 text-muted-foreground" />
						) : null}
					</div>
					{subtitle ? (
						<div className="mt-0.5 truncate text-muted-foreground text-sm">
							{subtitle}
						</div>
					) : null}
				</div>
			</Pressable>

			{/*
			 * The star is a sibling of the row, not a child: a 44pt button cannot nest inside the
			 * row's own button element, and a later sibling paints above it without a z-index
			 * fight. An unset star stays very low contrast — a list of 200 outlined stars reads as
			 * a rating widget, not as a list of secrets.
			 */}
			<Pressable
				onClick={onToggleFavorite}
				aria-label={
					item.favorite
						? m.vaults_detail_items_list_item_action_remove_favorite()
						: m.vaults_detail_items_list_item_action_add_favorite()
				}
				className="absolute top-1/2 right-1 flex size-11 -translate-y-1/2 items-center justify-center rounded-full"
			>
				<IconStar
					className={cn(
						iconClass.row,
						item.favorite ? "text-warning" : "text-muted-foreground/40",
					)}
					fill={item.favorite ? "currentColor" : "none"}
				/>
			</Pressable>
		</div>
	);
}
