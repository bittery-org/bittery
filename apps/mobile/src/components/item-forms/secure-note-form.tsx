import { Input, Label, TextField } from "heroui-native";
import { forwardRef, useImperativeHandle, useState } from "react";

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
	const [note, setNote] = useState(initialData?.note || "");

	useImperativeHandle(ref, () => ({
		getData: () => ({
			note,
		}),
		isValid: () => true, // No validation needed
	}));

	return (
		<TextField className="mb-4">
			<Label>Note</Label>
			<Input
				placeholder="Enter your secure note..."
				value={note}
				onChangeText={setNote}
				multiline
				numberOfLines={6}
				textAlignVertical="top"
				style={{ minHeight: 120 }}
			/>
		</TextField>
	);
});

SecureNoteForm.displayName = "SecureNoteForm";
