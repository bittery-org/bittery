import { Card } from "heroui-native";
import { useI18n } from "@/providers/i18n-provider";

interface NotesSectionProps {
	notes: string | undefined;
	showForSecureNote?: boolean;
}

export function NotesSection({
	notes,
	showForSecureNote = false,
}: NotesSectionProps) {
	const { m } = useI18n();
	if (!notes || showForSecureNote) return null;

	return (
		<Card variant="default" className="mb-2">
			<Card.Body className="py-3">
				<Card.Description className="mb-2">{m.mob_detail_field_notes()}</Card.Description>
				<Card.Title className="font-normal text-base" selectable>
					{notes}
				</Card.Title>
			</Card.Body>
		</Card>
	);
}
