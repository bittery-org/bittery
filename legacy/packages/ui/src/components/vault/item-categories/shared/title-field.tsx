import { useI18n } from "@bittery/i18n/react";
import { Input } from "../../../input";
import { Label } from "../../../label";

interface TitleFieldProps {
	field: {
		name: string;
		state: { value: string };
		handleBlur: () => void;
		handleChange: (value: string) => void;
	};
	placeholder?: string;
	label?: string;
	autoFocus?: boolean;
}

export function TitleField({
	field,
	placeholder,
	label,
	autoFocus,
}: TitleFieldProps) {
	const { m } = useI18n();
	const resolvedPlaceholder =
		placeholder ??
		m.vaults_detail_items_form_field_title_placeholder_default();
	const resolvedLabel =
		label ?? m.vaults_detail_items_form_field_title_label_required();

	return (
		<div className="space-y-2">
			<Label htmlFor={field.name}>{resolvedLabel}</Label>
			<Input
				id={field.name}
				name={field.name}
				value={field.state.value}
				onBlur={field.handleBlur}
				onChange={(e) => field.handleChange(e.target.value)}
				placeholder={resolvedPlaceholder}
				required
				autoFocus={autoFocus}
			/>
		</div>
	);
}
