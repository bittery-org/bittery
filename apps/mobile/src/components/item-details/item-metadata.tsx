import { Text, View } from "react-native";
import { useI18n } from "@/providers/i18n-provider";

interface ItemMetadataProps {
	createdAt: string | Date;
	updatedAt: string | Date;
}

/** Closing footnote of the detail view — never a card, never emphasised. */
export function ItemMetadata({ createdAt, updatedAt }: ItemMetadataProps) {
	const { m } = useI18n();

	return (
		<View className="items-center gap-1 pt-2">
			<Text className="text-muted text-xs">
				{m.mob_detail_field_created({
					date: new Date(createdAt).toLocaleString(),
				})}
			</Text>
			<Text className="text-muted text-xs">
				{m.mob_detail_field_updated({
					date: new Date(updatedAt).toLocaleString(),
				})}
			</Text>
		</View>
	);
}
