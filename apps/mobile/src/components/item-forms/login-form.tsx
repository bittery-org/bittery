import { Button, TextField } from "heroui-native";
import { Eye, EyeOff, Sparkles } from "lucide-react-native";
import { forwardRef, useImperativeHandle, useState } from "react";
import { Pressable, View } from "react-native";
import { withUniwind } from "uniwind";
import { PasswordGenerator } from "../password-generator";

const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);
const StyledSparkles = withUniwind(Sparkles);

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
		const [username, setUsername] = useState(initialData?.username || "");
		const [password, setPassword] = useState(initialData?.password || "");
		const [url, setUrl] = useState(
			initialData?.url || initialData?.urls?.[0] || "",
		);
		const [showPassword, setShowPassword] = useState(false);

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
			<TextField className="mb-4">
				<TextField.Label>Username</TextField.Label>
				<TextField.Input
					placeholder="Enter username"
					value={username}
					onChangeText={setUsername}
					autoCapitalize="none"
					autoCorrect={false}
				/>
			</TextField>

			<TextField className="mb-4">
				<TextField.Label>Password</TextField.Label>
				<View className="w-full flex-row items-center gap-2">
					<View className="flex-1 flex-row items-center">
						<TextField.Input
							placeholder="Enter password"
							value={password}
							onChangeText={setPassword}
							secureTextEntry={!showPassword}
							className="flex-1 pr-12"
						/>
						<Pressable
							onPress={() => setShowPassword(!showPassword)}
							className="absolute right-4"
						>
							{showPassword ? (
								<StyledEyeOff size={20} className="text-muted" />
							) : (
								<StyledEye size={20} className="text-muted" />
							)}
						</Pressable>
					</View>
					<PasswordGenerator
						onPasswordGenerated={(generatedPassword) => {
							setPassword(generatedPassword);
						}}
					>
						<Button
							isIconOnly
							variant="primary"
						>
							<StyledSparkles size={20} className="text-accent-foreground" />
						</Button>
					</PasswordGenerator>
				</View>
			</TextField>

			<TextField className="mb-4">
				<TextField.Label>Website URL</TextField.Label>
				<TextField.Input
					placeholder="https://example.com"
					value={url}
					onChangeText={setUrl}
					autoCapitalize="none"
					autoCorrect={false}
					keyboardType="url"
				/>
			</TextField>
		</>
	);
	},
);

LoginForm.displayName = "LoginForm";
