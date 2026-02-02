import { TextField } from "heroui-native";
import { forwardRef, useImperativeHandle, useState } from "react";
import { View } from "react-native";

export interface IdentityFormData {
	firstName: string;
	lastName: string;
	email?: string;
}

export interface IdentityFormRef {
	getData: () => IdentityFormData;
	isValid: () => boolean;
}

export const IdentityForm = forwardRef<IdentityFormRef>((_, ref) => {
	const [firstName, setFirstName] = useState("");
	const [lastName, setLastName] = useState("");
	const [email, setEmail] = useState("");

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
					<TextField.Label>First Name</TextField.Label>
					<TextField.Input
						placeholder="First name"
						value={firstName}
						onChangeText={setFirstName}
						autoCapitalize="words"
					/>
				</TextField>

				<TextField className="flex-1">
					<TextField.Label>Last Name</TextField.Label>
					<TextField.Input
						placeholder="Last name"
						value={lastName}
						onChangeText={setLastName}
						autoCapitalize="words"
					/>
				</TextField>
			</View>

			<TextField className="mb-4">
				<TextField.Label>Email</TextField.Label>
				<TextField.Input
					placeholder="email@example.com"
					value={email}
					onChangeText={setEmail}
					autoCapitalize="none"
					keyboardType="email-address"
				/>
			</TextField>
		</>
	);
});

IdentityForm.displayName = "IdentityForm";
