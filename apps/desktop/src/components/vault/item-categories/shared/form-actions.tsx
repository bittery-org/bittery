import { Button } from "@bittery/ui";

interface FormActionsProps {
	onCancel: () => void;
	submitLabel?: string;
	isSubmitting?: boolean;
}

export function FormActions({
	onCancel,
	submitLabel = "Save",
	isSubmitting = false,
}: FormActionsProps) {
	return (
		<div className="flex flex-1 justify-end gap-2">
			<Button
				type="button"
				variant="outline"
				onClick={onCancel}
				disabled={isSubmitting}
			>
				Cancel
			</Button>
			<Button type="submit" disabled={isSubmitting}>
				{isSubmitting ? "Saving..." : submitLabel}
			</Button>
		</div>
	);
}
