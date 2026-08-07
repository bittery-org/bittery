import { Input } from "heroui-native";
import { forwardRef, useImperativeHandle, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { FormField } from "./form-field";

export interface SecureNoteFormData {
	note: string;
}

export interface SecureNoteFormRef {
	getData: () => SecureNoteFormData;
	isValid: () => boolean;
}

interface SecureNoteFormProps {
	initialData?: Partial<SecureNoteFormData>;
}

export const SecureNoteForm = forwardRef<
	SecureNoteFormRef,
	SecureNoteFormProps
>(({ initialData }, ref) => {
	const { m } = useI18n();
	const [note, setNote] = useState(initialData?.note || "");

	useImperativeHandle(ref, () => ({
		getData: () => ({
			note,
		}),
		isValid: () => true, // No validation needed
	}));

	return (
		<FormField label={m.mob_form_note_label()}>
			<Input
				placeholder={m.mob_form_note_placeholder()}
				value={note}
				onChangeText={setNote}
				multiline
				numberOfLines={8}
				textAlignVertical="top"
				style={{ minHeight: 160 }}
			/>
		</FormField>
	);
});

SecureNoteForm.displayName = "SecureNoteForm";
