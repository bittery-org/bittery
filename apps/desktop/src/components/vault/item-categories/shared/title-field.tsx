import { Input, Label } from "@bittery/ui";

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
	placeholder = "My Item",
	label = "Title *",
	autoFocus,
}: TitleFieldProps) {
	return (
		<div className="space-y-2">
			<Label htmlFor={field.name}>{label}</Label>
			<Input
				id={field.name}
				name={field.name}
				value={field.state.value}
				onBlur={field.handleBlur}
				onChange={(e) => field.handleChange(e.target.value)}
				placeholder={placeholder}
				required
				autoFocus={autoFocus}
			/>
		</div>
	);
}
