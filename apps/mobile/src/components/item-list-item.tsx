import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { PressableFeedback, useThemeColor } from "heroui-native";
import { memo } from "react";
import { Text, View } from "react-native";
import { IconStar, layout } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";
import { ItemIcon } from "./item-icon";
import { VaultBadge } from "./vault-badge";

type Messages = ReturnType<typeof useI18n>["m"];

/** Login rows show who the credential belongs to; every other category names itself. */
function getSubtitle(item: DecryptedItemWithContext, m: Messages) {
	switch (item.category) {
		case "login":
			return item.username || item.url || null;
		case "credit-card":
			return m.mob_category_credit_card();
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

interface ItemListItemProps {
	item: DecryptedItemWithContext;
	vault?: {
		id: string;
		name: string;
		type: string;
	};
	showVaultBadge?: boolean;
	onPress: () => void;
	rightContent?: React.ReactNode;
	/**
	 * `"grouped"` paints its own card chrome from the position flags. `"plain"`
	 * emits the bare row so a parent (a swipeable, say) can own the card.
	 */
	variant?: "grouped" | "plain";
	/** Position inside its grouped card, which decides the rounded corners. */
	isFirstInSection?: boolean;
	isLastInSection?: boolean;
}

export const ItemListItem = memo(function ItemListItem({
	item,
	vault,
	showVaultBadge = false,
	onPress,
	rightContent,
	variant = "grouped",
	isFirstInSection = false,
	isLastInSection = false,
}: ItemListItemProps) {
	const { m } = useI18n();
	const warning = useThemeColor("warning");
	const subtitle = getSubtitle(item, m);
	const badge = showVaultBadge && vault ? vault : null;

	const row = (
		<PressableFeedback
			onPress={onPress}
			className="flex-row items-center bg-surface px-3.5"
			style={{ minHeight: layout.rowHeight }}
		>
			<PressableFeedback.Highlight />
			<ItemIcon
				item={item}
				category={item.category}
				title={item.title}
				size="md"
				className="mr-3"
			/>
			<View className="min-w-0 flex-1">
				<View className="flex-row items-center">
					<Text
						numberOfLines={1}
						className="shrink font-medium text-base text-foreground"
					>
						{item.title}
					</Text>
					{item.favorite ? (
						<IconStar
							size={13}
							fill={warning}
							className="ml-1.5 shrink-0 text-warning"
						/>
					) : null}
				</View>
				{subtitle || badge ? (
					<View className="mt-0.5 flex-row items-center gap-1.5">
						{badge ? <VaultBadge name={badge.name} type={badge.type} /> : null}
						{subtitle ? (
							<Text
								numberOfLines={1}
								className="min-w-0 flex-1 text-muted text-sm"
							>
								{subtitle}
							</Text>
						) : null}
					</View>
				) : null}
			</View>
			{rightContent ? (
				<View className="ml-2 shrink-0">{rightContent}</View>
			) : null}
		</PressableFeedback>
	);

	if (variant === "plain") {
		return row;
	}

	return (
		<View className="px-4">
			<View
				className={cn(
					"overflow-hidden border-border border-x bg-surface",
					isFirstInSection ? "rounded-t-2xl border-t" : "",
					isLastInSection ? "rounded-b-2xl border-b" : "",
				)}
			>
				{isFirstInSection ? null : <View className="ml-14 h-px bg-border" />}
				{row}
			</View>
		</View>
	);
});
