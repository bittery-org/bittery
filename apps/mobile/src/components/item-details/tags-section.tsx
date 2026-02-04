import { Card, Chip } from "heroui-native";
import { View } from "react-native";

interface TagsSectionProps {
	tags?: string[];
}

export function TagsSection({ tags }: TagsSectionProps) {
	if (!tags || tags.length === 0) return null;

	return (
		<Card variant="default" className="mb-2">
			<Card.Body className="py-3">
				<Card.Description className="mb-2">Tags</Card.Description>
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
