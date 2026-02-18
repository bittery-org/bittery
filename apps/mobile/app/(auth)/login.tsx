import { useLogin } from "@bittery/core/hooks";
import {
	parseDeviceSetupParams,
	type ParsedDeviceSetupPayload,
} from "@bittery/shared";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
	Button,
	ControlField,
	Description,
	Input,
	Label,
	PressableFeedback,
	TextField,
} from "heroui-native";
import {
	Eye,
	EyeOff,
	Fingerprint,
	Lock,
	Mail,
	QrCode,
	Server,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
	Alert,
	Image,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	Text,
	View,
} from "react-native";
import { withUniwind } from "uniwind";
import { DeviceSetupQrScanner } from "@/components/device-setup-qr-scanner";
import { SafeAreaView } from "@/components/safe-area-view";
import { defaultServerUrl } from "@/constants/server-url";
import { useAccount } from "../../src/contexts/account-context";
import { useServerUrl } from "../../src/lib/trpc";
import { type AccountMetadata, storage } from "../../src/services/storage";

// Create styled icon components
const StyledServer = withUniwind(Server);
const StyledMail = withUniwind(Mail);
const StyledLock = withUniwind(Lock);
const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);
const StyledFingerprint = withUniwind(Fingerprint);
const StyledQrCode = withUniwind(QrCode);

export default function LoginScreen() {
	const router = useRouter();
	const searchParams = useLocalSearchParams<{
		setup?: string;
		v?: string;
		email?: string;
		serverUrl?: string;
		secretKey?: string;
		teamName?: string;
	}>();
	const { setServerUrl: setGlobalServerUrl } = useServerUrl();
	const { refreshAccounts } = useAccount();
	const processedSetupParamsRef = useRef<string | null>(null);

	const [serverUrl, setServerUrl] = useState(defaultServerUrl);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [showSetupScanner, setShowSetupScanner] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [enableBiometric, setEnableBiometric] = useState(true);
	const [biometricAvailable, setBiometricAvailable] = useState(false);
	const [biometricType, setBiometricType] = useState<string | null>(null);
	const [biometricDetails, setBiometricDetails] = useState<{
		hasHardware: boolean;
		isEnrolled: boolean;
	}>({ hasHardware: false, isEnrolled: false });

	const applySetupPayload = (payload: ParsedDeviceSetupPayload) => {
		setEmail(payload.email);
		setServerUrl(payload.serverUrl);
		if (payload.secretKey) {
			setSecretKey(payload.secretKey);
		}
	};

	useEffect(() => {
		const signature = JSON.stringify({
			setup: searchParams.setup,
			v: searchParams.v,
			email: searchParams.email,
			serverUrl: searchParams.serverUrl,
			secretKey: searchParams.secretKey,
			teamName: searchParams.teamName,
		});

		if (processedSetupParamsRef.current === signature) {
			return;
		}

		const setupValue = Array.isArray(searchParams.setup)
			? searchParams.setup[0]
			: searchParams.setup;
		if (setupValue !== "1") {
			return;
		}

		try {
			const parsed = parseDeviceSetupParams({
				setup: searchParams.setup,
				v: searchParams.v,
				email: searchParams.email,
				serverUrl: searchParams.serverUrl,
				secretKey: searchParams.secretKey,
				teamName: searchParams.teamName,
			});

			if (!parsed) {
				return;
			}

			applySetupPayload(parsed);
			processedSetupParamsRef.current = signature;

			if (!parsed.secretKey) {
				Alert.alert(
					"Setup link loaded",
					"Email and server URL were filled. Enter your Secret Key to continue.",
				);
			}
		} catch (error) {
			processedSetupParamsRef.current = signature;
			Alert.alert(
				"Invalid setup link",
				error instanceof Error
					? error.message
					: "Could not parse this setup link.",
			);
		}
	}, [
		searchParams.email,
		searchParams.secretKey,
		searchParams.serverUrl,
		searchParams.setup,
		searchParams.teamName,
		searchParams.v,
	]);

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
				contentContainerClassName="flex-1"
				className="flex-1"
			>
				<ScrollView
					className="flex-1"
					contentContainerClassName="flex-1"
					keyboardShouldPersistTaps="handled"
				>
					<View className="flex-1 justify-center px-6 pt-2 pb-8">
						{/* Header */}
						<View className="mb-12 items-center">
							<PressableFeedback
								onPress={() => {
									// DEV ONLY: Auto-fill credentials
									setEmail("user@bittery.com");
									setPassword("Hofmann01");
									setSecretKey("A3-73ASV5-LCMRCU-B7TMM-VMH3K-QC27G");
								}}
							>
								<Image
									source={require("../../assets/logo.png")}
									style={{ width: 224, height: 76 }}
									resizeMode="contain"
								/>
							</PressableFeedback>
							<Text className="mt-1 text-center text-muted">
								Enter your credentials to access your vault
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
										placeholder="Enter your password"
										value={password}
										onChangeText={setPassword}
										secureTextEntry={!showPassword}
										textContentType="password"
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
							</TextField>

							{/* Secret Key */}
							<TextField>
								<Label>Secret Key</Label>
								<Input
									placeholder="A3-XXXXXX-XXXXXX-XXXXX"
									value={secretKey}
									onChangeText={setSecretKey}
									autoCapitalize="characters"
									autoCorrect={false}
									className="font-mono"
								/>
								<Description>
									Your Secret Key was provided when you created your account
								</Description>
								<Button
									onPress={() => setShowSetupScanner(true)}
									variant="secondary"
									className="mt-3"
								>
									<View className="flex-row items-center gap-2">
										<StyledQrCode size={18} className="text-muted" />
										<Text className="text-muted">Scan setup QR</Text>
									</View>
								</Button>
							</TextField>

							{/* Biometric Toggle */}
							{biometricAvailable && (
								<ControlField
									isSelected={enableBiometric}
									onSelectedChange={setEnableBiometric}
								>
									<View className="mt-2 flex-1 flex-row items-center gap-3">
										<StyledFingerprint size={20} className="text-muted" />
										<View className="flex-1">
											<Label>
												Enable {biometricType || "biometric"} unlock
											</Label>
											<Description>
												Quickly unlock with {biometricType || "biometrics"}
											</Description>
										</View>
									</View>
									<ControlField.Indicator />
								</ControlField>
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
							<Button
								onPress={handleLogin}
								isDisabled={loginMutation.isPending}
								variant="primary"
								size="lg"
								className="mt-4"
							>
								{loginMutation.isPending ? "Signing in..." : "Sign In"}
							</Button>

							{/* Sign Up Link */}
							<Button
								onPress={() => router.push("/(auth)/signup")}
								variant="ghost"
								className="mt-2"
							>
								<Text className="text-muted">
									Don't have an account?{" "}
									<Text className="font-semibold text-primary">Sign up</Text>
								</Text>
							</Button>
						</View>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
			<DeviceSetupQrScanner
				visible={showSetupScanner}
				onClose={() => setShowSetupScanner(false)}
				onScanSuccess={(payload) => {
					applySetupPayload(payload);
				}}
			/>
		</SafeAreaView>
	);
}
