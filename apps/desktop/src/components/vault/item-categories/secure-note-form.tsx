import { toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
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
	submitLabel = "Save",
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: SecureNoteFormProps) {
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
					error instanceof Error ? error.message : "Failed to save note";
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
					{(field) => <TitleField field={field} placeholder="My Secure Note" />}
				</form.Field>
			</div>

			<div>
				<form.Field name="note">
					{(field) => (
						<NotesField
							field={field as any}
							label="Note Content *"
							placeholder="Write your secure note here..."
							rows={12}
						/>
					)}
				</form.Field>
			</div>
		</FormWrapper>
	);
}
