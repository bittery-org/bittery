import { Input } from "heroui-native";
import { forwardRef, useImperativeHandle, useState } from "react";
import { Pressable, View } from "react-native";
import { IconSparkles, iconSize } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import { PasswordGenerator } from "../password-generator";
import { FormField, SecretInput } from "./form-field";

export interface LoginFormData {
	username: string;
	password: string;
	url?: string;
	urls?: string[];
}

export interface LoginFormRef {
	getData: () => LoginFormData;
	isValid: () => boolean;
}

interface LoginFormProps {
	initialData?: Partial<LoginFormData>;
}

export const LoginForm = forwardRef<LoginFormRef, LoginFormProps>(
	({ initialData }, ref) => {
		const { m } = useI18n();
		const [username, setUsername] = useState(initialData?.username || "");
		const [password, setPassword] = useState(initialData?.password || "");
		const [url, setUrl] = useState(
			initialData?.url || initialData?.urls?.[0] || "",
		);
		const [isPasswordRevealed, setIsPasswordRevealed] = useState(false);

		useImperativeHandle(ref, () => ({
			getData: () => ({
				username,
				password,
				url: url || undefined,
				urls: url ? [url] : undefined,
			}),
			isValid: () => true, // Login forms have no required fields beyond title
		}));

		return (
			<>
				<FormField label={m.mob_form_login_username_label()}>
					<Input
						placeholder={m.mob_form_login_username_placeholder()}
						value={username}
						onChangeText={setUsername}
						autoCapitalize="none"
						autoCorrect={false}
					/>
				</FormField>

				<FormField label={m.mob_form_login_password_label()}>
					<View className="w-full flex-row items-center gap-2">
						<View className="flex-1">
							<SecretInput
								placeholder={m.mob_form_login_password_placeholder()}
								value={password}
								onChangeText={setPassword}
								isRevealed={isPasswordRevealed}
								onToggleReveal={() =>
									setIsPasswordRevealed(!isPasswordRevealed)
								}
								revealLabel={m.mob_form_login_password_label()}
								className="font-mono"
							/>
						</View>
						<PasswordGenerator onPasswordGenerated={setPassword}>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={m.mob_password_gen_title()}
								className="h-12 w-12 items-center justify-center rounded-xl border border-accent/25 bg-selected"
							>
								<IconSparkles size={iconSize.bar} className="text-accent" />
							</Pressable>
						</PasswordGenerator>
					</View>
				</FormField>

				<FormField label={m.mob_form_login_url_label()}>
					<Input
						placeholder={m.mob_form_login_url_placeholder()}
						value={url}
						onChangeText={setUrl}
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="url"
					/>
				</FormField>
			</>
		);
	},
);

LoginForm.displayName = "LoginForm";
