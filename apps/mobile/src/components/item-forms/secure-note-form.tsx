import { TextField } from "heroui-native";
import { forwardRef, useImperativeHandle, useState } from "react";

export interface SecureNoteFormData {
	note: string;
}

export interface SecureNoteFormRef {
	getData: () => SecureNoteFormData;
	isValid: () => boolean;
}

export const SecureNoteForm = forwardRef<SecureNoteFormRef>((_, ref) => {
	const [note, setNote] = useState("");

	useImperativeHandle(ref, () => ({
		getData: () => ({
			note,
		}),
		isValid: () => true, // No validation needed
	}));

	return (
		<TextField className="mb-4">
			<TextField.Label>Note</TextField.Label>
			<TextField.Input
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
