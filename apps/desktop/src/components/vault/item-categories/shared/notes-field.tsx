import { Label } from "@bittery/ui";
import { Textarea } from "@bittery/ui/components/textarea";

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
	placeholder = "Additional notes...",
	rows = 4,
	label = "Notes",
}: NotesFieldProps) {
	return (
		<div className="space-y-2">
			<Label htmlFor={field.name}>{label}</Label>
			<Textarea
				id={field.name}
				name={field.name}
				value={field.state.value}
				onBlur={field.handleBlur}
				onChange={(e) => field.handleChange(e.target.value)}
				placeholder={placeholder}
				rows={rows}
			/>
		</div>
	);
}
