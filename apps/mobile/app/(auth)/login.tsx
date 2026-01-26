import { useLogin } from "@bittery/hooks";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { useRouter } from "expo-router";
import {
	Eye,
	EyeOff,
	Fingerprint,
	Lock,
	Mail,
	Server,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	Switch,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAccount } from "../../src/contexts/account-context";
import { useServerUrl } from "../../src/lib/trpc";
import { type AccountMetadata, storage } from "../../src/services/storage";

const DEFAULT_SERVER_URL =
	process.env.EXPO_PUBLIC_SERVER_URL || "http://localhost:3000";

export default function LoginScreen() {
	const router = useRouter();
	const { setServerUrl: setGlobalServerUrl } = useServerUrl();
	const { refreshAccounts } = useAccount();

	const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [enableBiometric, setEnableBiometric] = useState(true);
	const [biometricAvailable, setBiometricAvailable] = useState(false);
	const [biometricType, setBiometricType] = useState<string | null>(null);
	const [biometricDetails, setBiometricDetails] = useState<{
		hasHardware: boolean;
		isEnrolled: boolean;
	}>({ hasHardware: false, isEnrolled: false });

	useEffect(() => {
		async function checkBiometric() {
			const details = await storage.getBiometricAvailabilityDetails();
			setBiometricDetails({
				hasHardware: details.hasHardware,
				isEnrolled: details.isEnrolled,
			});

			// Biometric is only "available" if hardware exists AND biometrics are enrolled
			const available = details.hasHardware && details.isEnrolled;
			setBiometricAvailable(available);

			if (available) {
				const type = await storage.getBiometricType();
				setBiometricType(type);
			}
		}
		checkBiometric();
	}, []);

	// Use the shared login hook
	const loginMutation = useLogin({
		enableBiometric: enableBiometric && biometricAvailable,
		onSuccess: async (result, input) => {
			const normalizedEmail = input.email.toLowerCase();
			const normalizedServerUrl = normalizeServerUrl(serverUrl);

			// Store server URL per-account (mobile-specific)
			if (normalizedServerUrl) {
				await storage.storeServerUrl(normalizedServerUrl, normalizedEmail);
			}

			// Create account metadata (mobile-specific multi-account support)
			const secretKeyHint = `${input.secretKey.substring(0, 5)}...`;
			const accountMetadata: AccountMetadata = {
				email: normalizedEmail,
				userId: result.user.id,
				name: result.user.name || normalizedEmail.split("@")[0],
				teamName: result.user.teamName,
				secretKeyHint,
				addedAt: Date.now(),
				lastActiveAt: Date.now(),
				biometricEnabled: enableBiometric && biometricAvailable,
			};

			// Add to accounts list
			await storage.addAccountToList(accountMetadata);

			// Refresh account context
			await refreshAccounts();

			// Navigate to vault
			router.replace("/(vault)");
		},
		onError: (error) => {
			Alert.alert(
				"Error",
				error instanceof Error ? error.message : "Login failed",
			);
		},
	});

	const handleLogin = async () => {
		if (!email.trim() || !password.trim() || !secretKey.trim()) {
			Alert.alert("Error", "Please fill in all fields");
			return;
		}

		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) {
			Alert.alert("Error", "Invalid server URL");
			return;
		}

		// Update global server URL
		setGlobalServerUrl(normalizedServerUrl);

		// Allow UI to re-render and show loading state before heavy crypto work
		await new Promise((resolve) => setTimeout(resolve, 50));

		await loginMutation.mutateAsync({
			email,
			password,
			secretKey,
			enableBiometric: enableBiometric && biometricAvailable,
		});
	};

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
					<View className="flex-1 justify-center px-6 py-8">
						{/* Header */}
						<View className="mb-8 items-center">
							<TouchableOpacity
								className="mb-4 h-20 w-20 items-center justify-center rounded-2xl bg-primary"
								onPress={() => {
									// DEV ONLY: Auto-fill credentials
									setEmail("j.sigmund@qrawall.com");
									setPassword("Hofmann01");
									setSecretKey("A3-L2OFDR-LDNVBB-CYKMG-SFWAO-QIID3");
								}}
							>
								<Lock size={40} color="#fff" />
							</TouchableOpacity>
							<Text className="font-bold text-2xl text-foreground">
								Sign in to Bittery
							</Text>
							<Text className="mt-2 text-center text-muted-foreground">
								Enter your credentials to access your vault
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
								<Text className="mt-1 text-muted-foreground text-xs">
									Use your self-hosted Bittery server URL
								</Text>
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
										placeholder="Enter your password"
										value={password}
										onChangeText={setPassword}
										secureTextEntry={!showPassword}
										textContentType="password"
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
							</View>

							{/* Secret Key */}
							<View>
								<Text className="mb-2 font-medium text-foreground text-sm">
									Secret Key
								</Text>
								<TextInput
									className="rounded-lg border border-input bg-background px-4 py-3 font-mono text-foreground"
									placeholder="A3-XXXXXX-XXXXXX-XXXXX"
									value={secretKey}
									onChangeText={setSecretKey}
									autoCapitalize="characters"
									autoCorrect={false}
								/>
								<Text className="mt-1 text-muted-foreground text-xs">
									Your Secret Key was provided when you created your account
								</Text>
							</View>

							{/* Biometric Toggle */}
							{biometricAvailable && (
								<View className="flex-row items-center justify-between rounded-lg border border-input bg-background px-4 py-3">
									<View className="mr-3 flex-1 flex-row items-center">
										<Fingerprint size={20} color="#6b7280" />
										<View className="ml-3 flex-1">
											<Text className="text-foreground">
												Enable {biometricType || "biometric"} unlock
											</Text>
											<Text className="text-muted-foreground text-xs">
												Quickly unlock with {biometricType || "biometrics"}
											</Text>
										</View>
									</View>
									<Switch
										value={enableBiometric}
										onValueChange={setEnableBiometric}
									/>
								</View>
							)}

							{/* Show message if device has hardware but no biometrics enrolled */}
							{biometricDetails.hasHardware && !biometricDetails.isEnrolled && (
								<View className="rounded-lg bg-amber-50 p-4">
									<View className="flex-row items-start">
										<Fingerprint size={20} color="#f59e0b" />
										<View className="ml-3 flex-1">
											<Text className="font-medium text-amber-800">
												Biometric Not Set Up
											</Text>
											<Text className="text-amber-700 text-sm">
												Set up {biometricType || "Face ID/Touch ID"} in your
												device settings to enable quick unlock.
											</Text>
										</View>
									</View>
								</View>
							)}

							{/* Login Button */}
							<TouchableOpacity
								onPress={handleLogin}
								disabled={loginMutation.isPending}
								className={`mt-4 rounded-lg py-4 ${
									loginMutation.isPending ? "bg-primary/50" : "bg-primary"
								}`}
							>
								<Text className="text-center font-semibold text-primary-foreground">
									{loginMutation.isPending ? "Signing in..." : "Sign In"}
								</Text>
							</TouchableOpacity>

							{/* Sign Up Link */}
							<TouchableOpacity
								onPress={() => router.push("/(auth)/signup")}
								className="mt-4"
							>
								<Text className="text-center text-muted-foreground">
									Don't have an account?{" "}
									<Text className="font-semibold text-primary">Sign up</Text>
								</Text>
							</TouchableOpacity>
						</View>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
