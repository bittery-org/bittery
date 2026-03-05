import { Button } from "@bittery/ui";
import { useI18n } from "@/providers/i18n-provider";

interface FormActionsProps {
	onCancel: () => void;
	submitLabel?: string;
	isSubmitting?: boolean;
}

export function FormActions({
	onCancel,
	submitLabel,
	isSubmitting = false,
}: FormActionsProps) {
	const { m } = useI18n();
	const resolvedSubmitLabel =
		submitLabel ?? m["vaults.detail.items.form.action.save"]();

	return (
		<div className="flex flex-1 justify-end gap-2">
			<Button
				type="button"
				variant="outline"
				onClick={onCancel}
				disabled={isSubmitting}
				data-testid="item-form-cancel-button"
			>
				{m["vaults.detail.items.detail.action.cancel"]()}
			</Button>
			<Button
				type="submit"
				disabled={isSubmitting}
				data-testid="item-form-submit-button"
			>
				{isSubmitting
					? m["vaults.detail.items.form.action.saving"]()
					: resolvedSubmitLabel}
			</Button>
		</div>
	);
}
