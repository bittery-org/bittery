import { useThemeColor } from "heroui-native";
import { memo } from "react";
import { Text, View } from "react-native";
import { IconStar, SectionLabel } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import type { ItemSectionKind } from "@/utils/build-item-sections";

export interface ItemSectionHeaderProps {
	kind: ItemSectionKind;
	count: number;
}

export const ItemSectionHeader = memo(function ItemSectionHeader({
	kind,
	count,
}: ItemSectionHeaderProps) {
	const { m } = useI18n();
	const warning = useThemeColor("warning");
	const isFavorites = kind === "favorites";

	return (
		<View className="flex-row items-center gap-1.5 px-4 pt-6 pb-2">
			{isFavorites ? (
				<IconStar size={12} fill={warning} className="text-warning" />
			) : null}
			<SectionLabel className="flex-1 px-0 pb-0">
				{isFavorites
					? m.mob_items_section_favorites()
					: m.mob_items_section_all()}
			</SectionLabel>
			<Text className="font-semibold text-2xs text-muted">{count}</Text>
		</View>
	);
});
