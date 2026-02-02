import { normalizeServerUrl } from "@bittery/shared/server-url";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
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
	ScrollView,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "@/components/safe-area-view";
import { generateSecretKey } from "../../src/lib/crypto";

const DEFAULT_SERVER_URL =
	process.env.EXPO_PUBLIC_SERVER_URL || "http://localhost:3000";

export default function SignupScreen() {
	const router = useRouter();

	const [step, setStep] = useState<"form" | "secret-key">("form");
	const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
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
				<ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
					<View className="flex-1 px-6 py-8">
						{/* Back Button */}
						<TouchableOpacity
							onPress={() => setStep("form")}
							className="mb-6 flex-row items-center"
						>
							<ArrowLeft size={20} color="#6b7280" />
							<Text className="ml-2 text-muted-foreground">Back</Text>
						</TouchableOpacity>

						{/* Header */}
						<View className="mb-8 items-center">
							<View className="mb-4 h-20 w-20 items-center justify-center rounded-2xl bg-amber-500">
								<Key size={40} color="#fff" />
							</View>
							<Text className="font-bold text-2xl text-foreground">
								Your Secret Key
							</Text>
							<Text className="mt-2 text-center text-muted-foreground">
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
							<TouchableOpacity
								onPress={handleCopySecretKey}
								className="mt-3 flex-row items-center justify-center rounded-lg border border-input py-3"
							>
								<Copy size={18} color="#6b7280" />
								<Text className="ml-2 text-muted-foreground">
									Copy to Clipboard
								</Text>
							</TouchableOpacity>
						</View>

						{/* Confirmation Checkbox */}
						<TouchableOpacity
							onPress={() => setHasConfirmedSave(!hasConfirmedSave)}
							className="mb-6 flex-row items-start"
						>
							<View
								className={`mr-3 h-6 w-6 items-center justify-center rounded border-2 ${
									hasConfirmedSave
										? "border-primary bg-primary"
										: "border-input bg-background"
								}`}
							>
								{hasConfirmedSave && (
									<Text className="text-primary-foreground">✓</Text>
								)}
							</View>
							<Text className="flex-1 text-foreground">
								I have saved my Secret Key in a secure location and understand I
								will need it to access my account.
							</Text>
						</TouchableOpacity>

						{/* Continue Button */}
						<TouchableOpacity
							onPress={handleContinueToLogin}
							className={`rounded-lg py-4 ${
								hasConfirmedSave ? "bg-primary" : "bg-primary/50"
							}`}
						>
							<Text className="text-center font-semibold text-primary-foreground">
								Continue to Login
							</Text>
						</TouchableOpacity>
					</View>
				</ScrollView>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView className="flex-1 bg-background">
			<KeyboardAvoidingView
				behavior={Platform.OS === "ios" ? "padding" : "height"}
				className="flex-1"
			>
				<ScrollView
					className="flex-1"
					contentContainerStyle={{ flexGrow: 1 }}
					keyboardShouldPersistTaps="handled"
				>
					<View className="flex-1 px-6 py-8">
						{/* Back Button */}
						<TouchableOpacity
							onPress={() => router.back()}
							className="mb-6 flex-row items-center"
						>
							<ArrowLeft size={20} color="#6b7280" />
							<Text className="ml-2 text-muted-foreground">Back to Login</Text>
						</TouchableOpacity>

						{/* Header */}
						<View className="mb-8 items-center">
							<View className="mb-4 h-20 w-20 items-center justify-center rounded-2xl bg-primary">
								<Lock size={40} color="#fff" />
							</View>
							<Text className="font-bold text-2xl text-foreground">
								Create Account
							</Text>
							<Text className="mt-2 text-center text-muted-foreground">
								Set up your secure Bittery vault
							</Text>
						</View>

						{/* Form */}
						<View className="space-y-4">
							{/* Server URL */}
							<View>
								<Text className="mb-2 font-medium text-foreground text-sm">
									Server URL
								</Text>
								<View className="flex-row items-center rounded-lg border border-input bg-background px-3">
									<Server size={20} color="#6b7280" />
									<TextInput
										className="ml-3 flex-1 py-3 text-foreground"
										placeholder="https://your-server.com"
										value={serverUrl}
										onChangeText={setServerUrl}
										autoCapitalize="none"
										autoCorrect={false}
										keyboardType="url"
									/>
								</View>
							</View>

							{/* Name */}
							<View>
								<Text className="mb-2 font-medium text-foreground text-sm">
									Name
								</Text>
								<View className="flex-row items-center rounded-lg border border-input bg-background px-3">
									<User size={20} color="#6b7280" />
									<TextInput
										className="ml-3 flex-1 py-3 text-foreground"
										placeholder="Your name"
										value={name}
										onChangeText={setName}
										autoCapitalize="words"
										textContentType="name"
									/>
								</View>
							</View>

							{/* Email */}
							<View>
								<Text className="mb-2 font-medium text-foreground text-sm">
									Email
								</Text>
								<View className="flex-row items-center rounded-lg border border-input bg-background px-3">
									<Mail size={20} color="#6b7280" />
									<TextInput
										className="ml-3 flex-1 py-3 text-foreground"
										placeholder="you@example.com"
										value={email}
										onChangeText={setEmail}
										autoCapitalize="none"
										autoCorrect={false}
										keyboardType="email-address"
										textContentType="emailAddress"
									/>
								</View>
							</View>

							{/* Password */}
							<View>
								<Text className="mb-2 font-medium text-foreground text-sm">
									Password
								</Text>
								<View className="flex-row items-center rounded-lg border border-input bg-background px-3">
									<Lock size={20} color="#6b7280" />
									<TextInput
										className="ml-3 flex-1 py-3 text-foreground"
										placeholder="Create a strong password"
										value={password}
										onChangeText={setPassword}
										secureTextEntry={!showPassword}
										textContentType="newPassword"
									/>
									<TouchableOpacity
										onPress={() => setShowPassword(!showPassword)}
									>
										{showPassword ? (
											<EyeOff size={20} color="#6b7280" />
										) : (
											<Eye size={20} color="#6b7280" />
										)}
									</TouchableOpacity>
								</View>
								<Text className="mt-1 text-muted-foreground text-xs">
									Minimum 8 characters
								</Text>
							</View>

							{/* Confirm Password */}
							<View>
								<Text className="mb-2 font-medium text-foreground text-sm">
									Confirm Password
								</Text>
								<View className="flex-row items-center rounded-lg border border-input bg-background px-3">
									<Lock size={20} color="#6b7280" />
									<TextInput
										className="ml-3 flex-1 py-3 text-foreground"
										placeholder="Confirm your password"
										value={confirmPassword}
										onChangeText={setConfirmPassword}
										secureTextEntry={!showPassword}
										textContentType="newPassword"
									/>
								</View>
							</View>

							{/* Continue Button */}
							<TouchableOpacity
								onPress={handleContinueToSecretKey}
								className="mt-4 rounded-lg bg-primary py-4"
							>
								<Text className="text-center font-semibold text-primary-foreground">
									Continue
								</Text>
							</TouchableOpacity>
						</View>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
