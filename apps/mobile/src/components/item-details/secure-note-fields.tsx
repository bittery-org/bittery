import { useI18n } from "@/providers/i18n-provider";
import { DetailSection } from "./detail-section";
import { FieldGroup } from "./field-row";
import type { ItemDetailProps } from "./types";

export function SecureNoteFields({ item, onCopy }: ItemDetailProps) {
	const { m } = useI18n();

	return (
		<DetailSection title={m.mob_detail_field_note()}>
			<FieldGroup
				fields={[
					{
						key: "note",
						label: m.mob_detail_field_note(),
						value: item.note || item.notes,
						multiline: true,
					},
				]}
				onCopy={onCopy}
			/>
		</DetailSection>
	);
}
