import { normalizeServerUrl } from "@bittery/shared/server-url";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import {
	Button,
	ControlField,
	Description,
	Input,
	Label,
	TextField,
} from "heroui-native";
import {
	ArrowLeft,
	Copy,
	Eye,
	EyeOff,
	Key,
	Lock,
	Mail,
	Server,
	User,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	Text,
	View,
} from "react-native";
import { withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";
import { defaultServerUrl } from "@/constants/server-url";
import { generateSecretKey } from "../../src/lib/crypto";

// Create styled icon components
const StyledServer = withUniwind(Server);
const StyledMail = withUniwind(Mail);
const StyledLock = withUniwind(Lock);
const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);
const StyledUser = withUniwind(User);
const StyledKey = withUniwind(Key);
const StyledCopy = withUniwind(Copy);
const StyledArrowLeft = withUniwind(ArrowLeft);

export default function SignupScreen() {
	const router = useRouter();

	const [step, setStep] = useState<"form" | "secret-key">("form");
	const [serverUrl, setServerUrl] = useState(defaultServerUrl);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [generatedSecretKey, setGeneratedSecretKey] = useState("");
	const [hasConfirmedSave, setHasConfirmedSave] = useState(false);

	useEffect(() => {
		// Generate secret key on mount
		const key = generateSecretKey();
		setGeneratedSecretKey(key);
	}, []);

	const handleContinueToSecretKey = () => {
		if (!name.trim() || !email.trim() || !password.trim()) {
			Alert.alert("Error", "Please fill in all fields");
			return;
		}

		if (password !== confirmPassword) {
			Alert.alert("Error", "Passwords do not match");
			return;
		}

		if (password.length < 8) {
			Alert.alert("Error", "Password must be at least 8 characters");
			return;
		}

		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) {
			Alert.alert("Error", "Invalid server URL");
			return;
		}

		setStep("secret-key");
	};

	const handleCopySecretKey = async () => {
		await Clipboard.setStringAsync(generatedSecretKey);
		Alert.alert("Copied", "Secret Key copied to clipboard");
	};

	const handleContinueToLogin = () => {
		if (!hasConfirmedSave) {
			Alert.alert(
				"Important",
				"Please confirm that you have saved your Secret Key. You will need it to log in to your account.",
			);
			return;
		}

		// Navigate to login with the generated credentials
		Alert.alert(
			"Account Created",
			"Please sign in with your email, password, and the Secret Key you just saved.",
			[
				{
					text: "Go to Login",
					onPress: () => router.replace("/(auth)/login"),
				},
			],
		);
	};

	if (step === "secret-key") {
		return (
			<SafeAreaView className="flex-1 bg-background">
				<ScrollView
					className="flex-1"
					contentContainerClassName="flex-1"
					keyboardShouldPersistTaps="handled"
				>
					<View className="flex-1 justify-center px-6 py-8">
						{/* Back Button */}
						<Button
							onPress={() => setStep("form")}
							variant="ghost"
							className="mb-6 self-start"
						>
							<View className="flex-row items-center">
								<StyledArrowLeft size={20} className="text-muted" />
								<Text className="ml-2 text-muted">Back</Text>
							</View>
						</Button>

						{/* Header */}
						<View className="mb-8 items-center">
							<Button
								isIconOnly
								variant="primary"
								size="lg"
								className="mb-4 h-20 w-20 rounded-2xl bg-amber-500"
								isDisabled
							>
								<StyledKey size={40} className="text-white" />
							</Button>
							<Text className="font-bold text-2xl text-foreground">
								Your Secret Key
							</Text>
							<Text className="mt-2 text-center text-muted">
								This key is required to access your account. Save it somewhere
								safe!
							</Text>
						</View>

						{/* Warning */}
						<View className="mb-6 rounded-lg bg-amber-50 p-4">
							<Text className="mb-2 font-semibold text-amber-800">
								Important!
							</Text>
							<Text className="text-amber-700">
								• Your Secret Key cannot be recovered if lost{"\n"}• Write it
								down or save it in a secure location{"\n"}• You'll need both
								your password AND this key to log in{"\n"}• Never share your
								Secret Key with anyone
							</Text>
						</View>

						{/* Secret Key Display */}
						<View className="mb-6">
							<Text className="mb-2 font-medium text-foreground text-sm">
								Your Secret Key
							</Text>
							<View className="rounded-lg border-2 border-primary border-dashed bg-primary/5 p-4">
								<Text
									className="text-center font-mono text-lg text-primary"
									selectable
								>
									{generatedSecretKey}
								</Text>
							</View>
							<Button
								onPress={handleCopySecretKey}
								variant="secondary"
								className="mt-3"
							>
								<View className="flex-row items-center">
									<StyledCopy size={18} className="text-muted" />
									<Text className="ml-2 text-muted">Copy to Clipboard</Text>
								</View>
							</Button>
						</View>

						{/* Confirmation Checkbox */}
						<ControlField
							isSelected={hasConfirmedSave}
							onSelectedChange={setHasConfirmedSave}
						>
							<Label className="flex-1">
								I have saved my Secret Key in a secure location and understand I
								will need it to access my account.
							</Label>
							<ControlField.Indicator />
						</ControlField>

						{/* Continue Button */}
						<Button
							onPress={handleContinueToLogin}
							isDisabled={!hasConfirmedSave}
							variant="primary"
							size="lg"
							className="mt-6"
						>
							Continue to Login
						</Button>
					</View>
				</ScrollView>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView className="flex-1 bg-background">
			<KeyboardAvoidingView
				behavior={Platform.OS === "ios" ? "padding" : "height"}
				contentContainerClassName="flex-1"
				className="flex-1"
			>
				<ScrollView
					className="flex-1"
					contentContainerClassName="flex-1"
					keyboardShouldPersistTaps="handled"
				>
					<View className="flex-1 justify-center px-6 py-8">
						{/* Back Button */}
						<Button
							onPress={() => router.back()}
							variant="ghost"
							className="mb-6 self-start"
						>
							<View className="flex-row items-center">
								<StyledArrowLeft size={20} className="text-muted" />
								<Text className="ml-2 text-muted">Back to Login</Text>
							</View>
						</Button>

						{/* Header */}
						<View className="mb-8 items-center">
							<Button
								isIconOnly
								variant="primary"
								size="lg"
								className="mb-4 h-20 w-20 rounded-2xl"
								isDisabled
							>
								<Lock size={40} color="#fff" />
							</Button>
							<Text className="font-bold text-2xl text-foreground">
								Create Account
							</Text>
							<Text className="mt-2 text-center text-muted">
								Set up your secure Bittery vault
							</Text>
						</View>

						{/* Form */}
						<View className="gap-4">
							{/* Server URL */}
							<TextField>
								<Label>Server URL</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder="https://your-server.com"
										value={serverUrl}
										onChangeText={setServerUrl}
										autoCapitalize="none"
										autoCorrect={false}
										keyboardType="url"
										className="flex-1 pr-4 pl-12"
									/>
									<StyledServer
										size={20}
										className="absolute left-3.5 text-muted"
										pointerEvents="none"
									/>
								</View>
								<Description>
									Use your self-hosted Bittery server URL
								</Description>
							</TextField>

							{/* Name */}
							<TextField>
								<Label>Name</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder="Your name"
										value={name}
										onChangeText={setName}
										autoCapitalize="words"
										textContentType="name"
										className="flex-1 pr-4 pl-12"
									/>
									<StyledUser
										size={20}
										className="absolute left-3.5 text-muted"
										pointerEvents="none"
									/>
								</View>
							</TextField>

							{/* Email */}
							<TextField>
								<Label>Email</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder="you@example.com"
										value={email}
										onChangeText={setEmail}
										autoCapitalize="none"
										autoCorrect={false}
										keyboardType="email-address"
										textContentType="emailAddress"
										className="flex-1 pr-4 pl-12"
									/>
									<StyledMail
										size={20}
										className="absolute left-3.5 text-muted"
										pointerEvents="none"
									/>
								</View>
							</TextField>

							{/* Password */}
							<TextField>
								<Label>Password</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder="Create a strong password"
										value={password}
										onChangeText={setPassword}
										secureTextEntry={!showPassword}
										textContentType="newPassword"
										className="flex-1 pr-12 pl-12"
									/>
									<StyledLock
										size={20}
										className="absolute left-3.5 text-muted"
										pointerEvents="none"
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
								<Description>Minimum 8 characters</Description>
							</TextField>

							{/* Confirm Password */}
							<TextField>
								<Label>Confirm Password</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder="Confirm your password"
										value={confirmPassword}
										onChangeText={setConfirmPassword}
										secureTextEntry={!showPassword}
										textContentType="newPassword"
										className="flex-1 pr-4 pl-12"
									/>
									<StyledLock
										size={20}
										className="absolute left-3.5 text-muted"
										pointerEvents="none"
									/>
								</View>
							</TextField>

							{/* Continue Button */}
							<Button
								onPress={handleContinueToSecretKey}
								variant="primary"
								size="lg"
								className="mt-4"
							>
								Continue
							</Button>
						</View>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
