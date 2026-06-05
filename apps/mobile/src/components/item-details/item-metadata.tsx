import { Card } from "heroui-native";
import { useI18n } from "@/providers/i18n-provider";

interface ItemMetadataProps {
	createdAt: string | Date;
	updatedAt: string | Date;
}

export function ItemMetadata({ createdAt, updatedAt }: ItemMetadataProps) {
	const { m } = useI18n();

	return (
		<Card variant="default" className="mb-4">
			<Card.Body className="py-3">
				<Card.Description className="text-xs">
					{m.mob_detail_field_created({
						date: new Date(createdAt).toLocaleString(),
					})}
				</Card.Description>
				<Card.Description className="text-xs">
					{m.mob_detail_field_updated({
						date: new Date(updatedAt).toLocaleString(),
					})}
				</Card.Description>
			</Card.Body>
		</Card>
	);
}
