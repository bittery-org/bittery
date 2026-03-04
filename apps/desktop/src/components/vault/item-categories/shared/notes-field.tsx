import { Label } from "@bittery/ui";
import { Textarea } from "@bittery/ui/components/textarea";
import { useI18n } from "../../../../providers/i18n-provider";

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
		m["vaults.detail.items.form.field.notes.placeholder.default"]();
	const resolvedLabel =
		label ?? m["vaults.detail.items.form.field.notes.label"]();

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
