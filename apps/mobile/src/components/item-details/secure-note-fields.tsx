import { Card } from "heroui-native";
import { useI18n } from "@/providers/i18n-provider";
import type { ItemDetailProps } from "./types";

export function SecureNoteFields({ item }: ItemDetailProps) {
	const { m } = useI18n();

	return (
		<Card variant="default" className="mb-2">
			<Card.Body className="py-3">
				<Card.Description className="mb-2">{m.mob_detail_field_note()}</Card.Description>
				<Card.Title className="font-normal text-base" selectable>
					{item.note || item.notes}
				</Card.Title>
			</Card.Body>
		</Card>
	);
}
