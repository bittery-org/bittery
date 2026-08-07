import { useI18n } from "@/providers/i18n-provider";
import { DetailSection } from "./detail-section";
import { FieldGroup } from "./field-row";

interface NotesSectionProps {
	notes: string | undefined;
	/** Secure notes already render their body as the item's main field. */
	showForSecureNote?: boolean;
	onCopy: (value: string, label: string) => Promise<void>;
}

export function NotesSection({
	notes,
	showForSecureNote = false,
	onCopy,
}: NotesSectionProps) {
	const { m } = useI18n();
	if (!notes || showForSecureNote) return null;

	return (
		<DetailSection title={m.mob_detail_field_notes()}>
			<FieldGroup
				fields={[
					{
						key: "notes",
						label: m.mob_detail_field_notes(),
						value: notes,
						multiline: true,
					},
				]}
				onCopy={onCopy}
			/>
		</DetailSection>
	);
}
