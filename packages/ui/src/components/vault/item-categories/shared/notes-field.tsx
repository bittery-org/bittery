import { useI18n } from "@bittery/i18n/react";
import { Textarea } from "../../../textarea";
import { Label } from "../../../label";

interface NotesFieldProps {
	field: {
		name: string;
		state: { value: string };
		handleBlur: () => void;
		handleChange: (value: string) => void;
	};
	placeholder?: string;
	rows?: number;
	label?: string;
}

export function NotesField({
	field,
	placeholder,
	rows = 4,
	label,
}: NotesFieldProps) {
	const { m } = useI18n();
	const resolvedPlaceholder =
		placeholder ??
		m.vaults_detail_items_form_field_notes_placeholder_default();
	const resolvedLabel =
		label ?? m.vaults_detail_items_form_field_notes_label();

	return (
		<div className="space-y-2">
			<Label htmlFor={field.name}>{resolvedLabel}</Label>
			<Textarea
				id={field.name}
				name={field.name}
				value={field.state.value}
				onBlur={field.handleBlur}
				onChange={(e) => field.handleChange(e.target.value)}
				placeholder={resolvedPlaceholder}
				rows={rows}
			/>
		</div>
	);
}
