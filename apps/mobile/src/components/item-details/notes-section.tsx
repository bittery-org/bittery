import { Card } from "heroui-native";

interface NotesSectionProps {
  notes: string | undefined;
  showForSecureNote?: boolean;
}

export function NotesSection({ notes, showForSecureNote = false }: NotesSectionProps) {
  if (!notes || showForSecureNote) return null;

  return (
    <Card variant="default" className="mb-2">
      <Card.Body className="py-3">
        <Card.Description className="mb-2">Notes</Card.Description>
        <Card.Title className="font-normal text-base" selectable>
          {notes}
        </Card.Title>
      </Card.Body>
    </Card>
  );
}
