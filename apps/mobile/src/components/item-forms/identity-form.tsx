import { Input, Label, TextField } from "heroui-native";
import { forwardRef, useImperativeHandle, useState } from "react";
import { View } from "react-native";
import { useI18n } from "@/providers/i18n-provider";

export interface IdentityFormData {
	firstName: string;
	lastName: string;
	email?: string;
}

export interface IdentityFormRef {
	getData: () => IdentityFormData;
	isValid: () => boolean;
}

interface IdentityFormProps {
	initialData?: Partial<IdentityFormData>;
}

export const IdentityForm = forwardRef<IdentityFormRef, IdentityFormProps>(
	({ initialData }, ref) => {
		const { m } = useI18n();
		const [firstName, setFirstName] = useState(initialData?.firstName || "");
		const [lastName, setLastName] = useState(initialData?.lastName || "");
		const [email, setEmail] = useState(initialData?.email || "");

		useImperativeHandle(ref, () => ({
			getData: () => ({
				firstName,
				lastName,
				email: email || undefined,
			}),
			isValid: () => true, // Add validation as needed
		}));

		return (
			<>
				<View className="mb-4 flex-row gap-2">
					<TextField className="flex-1">
						<Label>{m.mob_form_identity_first_name_label()}</Label>
						<Input
							placeholder={m.mob_form_identity_first_name_placeholder()}
							value={firstName}
							onChangeText={setFirstName}
							autoCapitalize="words"
						/>
					</TextField>

					<TextField className="flex-1">
						<Label>{m.mob_form_identity_last_name_label()}</Label>
						<Input
							placeholder={m.mob_form_identity_last_name_placeholder()}
							value={lastName}
							onChangeText={setLastName}
							autoCapitalize="words"
						/>
					</TextField>
				</View>

				<TextField className="mb-4">
					<Label>{m.mob_form_identity_email_label()}</Label>
					<Input
						placeholder={m.mob_form_identity_email_placeholder()}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						keyboardType="email-address"
					/>
				</TextField>
			</>
		);
	},
);

IdentityForm.displayName = "IdentityForm";
