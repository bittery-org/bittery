import { useI18n } from "@bittery/i18n/react";
import { useForm } from "@tanstack/react-form";
import { toast } from "../../sonner";
import {
	type BaseFormProps,
	FormWrapper,
	NotesField,
	TitleField,
	useFormVault,
} from "./shared";

export interface SecureNoteFormData {
	title: string;
	note: string;
	tags?: string[];
}

interface SecureNoteFormProps extends BaseFormProps {
	initialData?: Partial<SecureNoteFormData>;
	onSubmit: (data: SecureNoteFormData, vaultId: string) => Promise<void> | void;
}

export function SecureNoteForm({
	initialData,
	onSubmit,
	onCancel,
	submitLabel,
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: SecureNoteFormProps) {
	const { m } = useI18n();
	const { currentVaultId, setCurrentVaultId } = useFormVault(
		vaults,
		selectedVaultId,
	);

	const form = useForm({
		defaultValues: {
			title: initialData?.title || "",
			note: initialData?.note || "",
		},
		onSubmit: async ({ value }) => {
			try {
				const submitData: SecureNoteFormData = {
					...value,
					tags: initialData?.tags,
				};
				await onSubmit(submitData, currentVaultId);
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: m.vaults_detail_items_form_toast_save_note_failed();
				toast.error(errorMessage);
			}
		},
	});

	return (
		<FormWrapper
			onSubmit={form.handleSubmit}
			onCancel={onCancel}
			submitLabel={submitLabel}
			isSubmitting={isSubmitting}
			vaults={vaults}
			currentVaultId={currentVaultId}
			onVaultChange={setCurrentVaultId}
		>
			<div>
				<form.Field name="title">
					{(field) => (
						<TitleField
							field={field}
							placeholder={m.vaults_detail_items_form_secure_note_placeholder_title()}
						/>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="note">
					{(field) => (
						<NotesField
							field={field as any}
							label={m.vaults_detail_items_form_secure_note_field_note_content_required()}
							placeholder={m.vaults_detail_items_form_secure_note_placeholder_note_content()}
							rows={12}
						/>
					)}
				</form.Field>
			</div>
		</FormWrapper>
	);
}
