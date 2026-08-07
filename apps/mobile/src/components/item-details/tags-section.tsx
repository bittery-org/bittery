import { Text, View } from "react-native";
import { ListCard } from "@/components/ui";
import { getTagColorFromName } from "@/lib/tag-color";
import { useI18n } from "@/providers/i18n-provider";
import { DetailSection } from "./detail-section";

interface TagsSectionProps {
	tags?: string[];
}

export function TagsSection({ tags }: TagsSectionProps) {
	const { m } = useI18n();
	if (!tags || tags.length === 0) return null;

	return (
		<DetailSection title={m.mob_detail_field_tags()}>
			<ListCard>
				<View className="flex-row flex-wrap gap-2 p-3">
					{tags.map((tag) => (
						<View
							key={tag}
							className="flex-row items-center gap-2 rounded-full border border-border bg-default px-3 py-1.5"
						>
							<View
								aria-hidden
								className="h-1.5 w-1.5 rounded-full"
								style={{ backgroundColor: getTagColorFromName(tag) }}
							/>
							<Text className="font-medium text-foreground text-sm">{tag}</Text>
						</View>
					))}
				</View>
			</ListCard>
		</DetailSection>
	);
}
