import { Card } from "heroui-native";

interface ItemMetadataProps {
	createdAt: string | Date;
	updatedAt: string | Date;
}

export function ItemMetadata({ createdAt, updatedAt }: ItemMetadataProps) {
	return (
		<Card variant="transparent" className="mb-4">
			<Card.Body className="py-3">
				<Card.Description className="text-xs">
					Created: {new Date(createdAt).toLocaleString()}
				</Card.Description>
				<Card.Description className="text-xs">
					Updated: {new Date(updatedAt).toLocaleString()}
				</Card.Description>
			</Card.Body>
		</Card>
	);
}
