import type { CustomField } from "@bittery/shared/types";
import { useI18n } from "@/providers/i18n-provider";
import { DetailSection } from "./detail-section";
import { FieldGroup } from "./field-row";
import type { FieldDefinition } from "./types";

interface CustomFieldsProps {
	fields?: CustomField[];
	onCopy: (value: string, label: string) => Promise<void>;
}

export function CustomFields({ fields, onCopy }: CustomFieldsProps) {
	const { m } = useI18n();
	if (!fields || fields.length === 0) return null;

	const definitions: FieldDefinition[] = fields.map((field) => ({
		key: field.id,
		label: field.label,
		value: field.value,
		masked: field.type === "password",
		mono: field.type === "password",
		multiline: field.type !== "password",
	}));

	return (
		<DetailSection title={m.mob_detail_section_custom_fields()}>
			<FieldGroup fields={definitions} onCopy={onCopy} />
		</DetailSection>
	);
}
