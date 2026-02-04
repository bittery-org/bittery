import { Card } from "heroui-native";
import type { ItemDetailProps } from "./types";

export function SecureNoteFields({ item }: ItemDetailProps) {
	return (
		<Card variant="default" className="mb-2">
			<Card.Body className="py-3">
				<Card.Description className="mb-2">Note</Card.Description>
				<Card.Title className="font-normal text-base" selectable>
					{item.note || item.notes}
				</Card.Title>
			</Card.Body>
		</Card>
	);
}
