import { Card, Chip } from "heroui-native";
import { View } from "react-native";
import { useI18n } from "@/providers/i18n-provider";

interface TagsSectionProps {
	tags?: string[];
}

export function TagsSection({ tags }: TagsSectionProps) {
	const { m } = useI18n();
	if (!tags || tags.length === 0) return null;

	return (
		<Card variant="default" className="mb-2">
			<Card.Body className="py-3">
				<Card.Description className="mb-2">{m.mob_detail_field_tags()}</Card.Description>
				<View className="flex-row flex-wrap gap-2">
					{tags.map((tag) => (
						<Chip key={tag} size="sm" variant="secondary">
							<Chip.Label>{tag}</Chip.Label>
						</Chip>
					))}
				</View>
			</Card.Body>
		</Card>
	);
}
