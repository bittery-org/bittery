import { useI18n } from "@bittery/i18n/react";
import { Button } from "../../../button";

interface FormActionsProps {
	onCancel: () => void;
	submitLabel?: string;
	cancelLabel?: string;
	isSubmitting?: boolean;
}

export function FormActions({
	onCancel,
	submitLabel,
	cancelLabel,
	isSubmitting = false,
}: FormActionsProps) {
	const { m } = useI18n();
	const resolvedSubmitLabel =
		submitLabel ?? m.vaults_detail_items_form_action_save();
	const resolvedCancelLabel =
		cancelLabel ?? m.vaults_detail_items_detail_action_cancel();

	return (
		<div className="flex flex-1 justify-end gap-2">
			<Button
				type="button"
				variant="outline"
				onClick={onCancel}
				disabled={isSubmitting}
				data-testid="item-form-cancel-button"
			>
				{resolvedCancelLabel}
			</Button>
			<Button
				type="submit"
				disabled={isSubmitting}
				data-testid="item-form-submit-button"
			>
				{isSubmitting
					? m.vaults_detail_items_form_action_saving()
					: resolvedSubmitLabel}
			</Button>
		</div>
	);
}
