import { useI18n } from "@bittery/i18n/react";
import { Button } from "../../../button";

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
		submitLabel ?? m.vaults_detail_items_form_action_save();

	return (
		<div className="flex flex-1 justify-end gap-2">
			<Button
				type="button"
				variant="outline"
				onClick={onCancel}
				disabled={isSubmitting}
				data-testid="item-form-cancel-button"
			>
				{m.vaults_detail_items_detail_action_cancel()}
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
