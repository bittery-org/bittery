import { maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { VaultItemListRow } from "@bittery/ui";
import {
	IconCircleKeyOutlineDuo18,
	IconMobileOutlineDuo18,
} from "@bittery/ui/icons";
import { useDraggable } from "@dnd-kit/core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import type { DragItemData } from "../../providers/dnd-provider";
import { useVaultDnd } from "../../providers/dnd-provider";
import { useI18n } from "../../providers/i18n-provider";
import { Favicon } from "./favicon";

interface ItemListRowProps {
	item: DecryptedItemWithContext;
	isSelected: boolean;
	linkTo: string;
	linkParams: Record<string, string>;
	vaultId: string;
}

export function ItemListRow({
	item,
	isSelected,
	linkTo,
	linkParams,
	vaultId,
}: ItemListRowProps) {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { isDragging: isAnyItemDragging } = useVaultDnd();
	const maskedCardNumber = item.cardNumber
		? maskCardNumber(item.cardNumber)
		: undefined;
	const hasPasskeys =
		item.category === "login" && (item.passkeys?.length ?? 0) > 0;

	const dragData: DragItemData = {
		type: "vault-item",
		item,
		sourceVaultId: vaultId,
	};

	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: `item-${item.id}`,
		data: dragData,
	});

	const setRowRef = useCallback(
		(node: HTMLDivElement | null) => {
			setNodeRef(node);

			if (!node || !isSelected) {
				return;
			}

			requestAnimationFrame(() => {
				node.scrollIntoView({ block: "nearest", inline: "nearest" });
			});
		},
		[isSelected, setNodeRef],
	);

	const handleClick = () => {
		// Only navigate if not dragging
		if (!isDragging) {
			navigate({ to: linkTo, params: linkParams });
		}
	};

	return (
		<VaultItemListRow
			ref={setRowRef}
			{...listeners}
			{...attributes}
			className="mb-1"
			itemTitle={item.title}
			ariaLabel={m.vaults_detail_items_list_item_action_select({
				title: item.title,
			})}
			leadingVisual={<Favicon item={item} size="sm" />}
			indicators={
				<>
					{item.category === "login" && item.totpSecret && (
						<span title={m.vaults_detail_items_list_item_badge_has_2fa()}>
							<IconMobileOutlineDuo18 className="size-3 shrink-0 text-muted-foreground" />
						</span>
					)}
					{hasPasskeys && (
						<span
							title={m.vaults_detail_items_detail_login_passkeys_label_single({
								count: 1,
							})}
						>
							<IconCircleKeyOutlineDuo18 className="size-3 shrink-0 text-muted-foreground" />
						</span>
					)}
				</>
			}
			secondaryText={item.username}
			tertiaryText={maskedCardNumber}
			isSelected={isSelected}
			isAnyItemDragging={isAnyItemDragging}
			isDragging={isDragging}
			onPrimaryAction={handleClick}
		/>
	);
}
