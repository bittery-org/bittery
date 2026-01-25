import { normalizeServerUrl } from "@bittery/crypto/server-url";
import type { AccountMetadata } from "@bittery/crypto/storage-react-native";
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
import {
	deriveClientSession,
	deriveKeys,
	generateClientEphemeral,
	validateSecretKey,
	verifyServerSession,
} from "../../src/lib/crypto";
import { useServerUrl, useTRPCClient } from "../../src/lib/trpc";
import * as storage from "../../src/services/storage";

const DEFAULT_SERVER_URL =
	process.env.EXPO_PUBLIC_SERVER_URL || "http://localhost:3000";

export default function LoginScreen() {
	const router = useRouter();
	const trpcClient = useTRPCClient();
	const { setServerUrl: setGlobalServerUrl } = useServerUrl();
	const { refreshAccounts } = useAccount();

	const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [loading, setLoading] = useState(false);
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

	const handleLogin = async () => {
		console.log("[LOGIN] handleLogin called");
		const startTime = performance.now();

		if (!email.trim() || !password.trim() || !secretKey.trim()) {
			Alert.alert("Error", "Please fill in all fields");
			return;
		}
		console.log(
			"[LOGIN] Fields validated:",
			performance.now() - startTime,
			"ms",
		);

		if (!validateSecretKey(secretKey)) {
			Alert.alert("Error", "Invalid Secret Key format");
			return;
		}
		console.log(
			"[LOGIN] Secret key validated:",
			performance.now() - startTime,
			"ms",
		);

		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) {
			Alert.alert("Error", "Invalid server URL");
			return;
		}
		console.log(
			"[LOGIN] Server URL normalized:",
			performance.now() - startTime,
			"ms",
		);

		console.log(
			"[LOGIN] About to setLoading(true):",
			performance.now() - startTime,
			"ms",
		);
		setLoading(true);
		console.log(
			"[LOGIN] setLoading(true) called:",
			performance.now() - startTime,
			"ms",
		);

		// Allow UI to re-render and show loading state before heavy crypto work
		await new Promise((resolve) => setTimeout(resolve, 50));
		console.log(
			"[LOGIN] UI render delay completed:",
			performance.now() - startTime,
			"ms",
		);

		try {
			// Update global server URL
			setGlobalServerUrl(normalizedServerUrl);
			console.log(
				"[LOGIN] Global server URL set:",
				performance.now() - startTime,
				"ms",
			);

			// 1. Derive keys from password + secret key
			console.log("[LOGIN] Starting deriveKeys...");
			const deriveKeysStart = performance.now();
			const { authKey, masterUnlockKey } = await deriveKeys(
				password,
				secretKey,
				email,
			);
			console.log(
				"[LOGIN] deriveKeys completed:",
				performance.now() - startTime,
				"ms (took",
				performance.now() - deriveKeysStart,
				"ms)",
			);

			// Convert authKey to password string for SRP
			const srpPassword = new TextDecoder().decode(authKey);

			// 2. Generate client ephemeral key pair
			console.log("[LOGIN] Generating client ephemeral...");
			const ephemeralStart = performance.now();
			const clientEphemeral = generateClientEphemeral();
			console.log(
				"[LOGIN] Client ephemeral generated:",
				performance.now() - startTime,
				"ms (took",
				performance.now() - ephemeralStart,
				"ms)",
			);

			// 3. Send client public key to server and get challenge
			console.log("[LOGIN] Starting startLogin mutation...");
			const startLoginStart = performance.now();
			const startResult = await trpcClient.auth.startLogin.mutate({
				email,
				clientPublicKey: clientEphemeral.publicKey,
			});
			console.log(
				"[LOGIN] startLogin completed:",
				performance.now() - startTime,
				"ms (took",
				performance.now() - startLoginStart,
				"ms)",
			);

			// 4. Derive session and compute proof
			console.log("[LOGIN] Deriving client session...");
			const sessionStart = performance.now();
			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{
					salt: startResult.salt,
					serverPublicKey: startResult.serverPublicKey,
				},
				srpPassword,
			);
			console.log(
				"[LOGIN] Client session derived:",
				performance.now() - startTime,
				"ms (took",
				performance.now() - sessionStart,
				"ms)",
			);

			// 5. Send proof to server and get session
			console.log("[LOGIN] Starting finishLogin mutation...");
			const finishLoginStart = performance.now();
			const finishResult = await trpcClient.auth.finishLogin.mutate({
				userId: startResult.userId,
				serverSecret: startResult.serverSecret,
				clientPublicKey: clientEphemeral.publicKey,
				clientProof: clientSession.proof,
			});
			console.log(
				"[LOGIN] finishLogin completed:",
				performance.now() - startTime,
				"ms (took",
				performance.now() - finishLoginStart,
				"ms)",
			);

			if (!finishResult.serverProof) {
				Alert.alert("Error", "Login failed - invalid server proof");
				return;
			}

			// 6. Verify server's proof (completes mutual authentication)
			console.log("[LOGIN] Verifying server session...");
			const verifyStart = performance.now();
			await verifyServerSession(
				clientEphemeral.publicKey,
				clientSession,
				finishResult.serverProof,
			);
			console.log(
				"[LOGIN] Server session verified:",
				performance.now() - startTime,
				"ms (took",
				performance.now() - verifyStart,
				"ms)",
			);

			const normalizedEmail = email.toLowerCase();

			// Enable biometric if requested
			if (enableBiometric && biometricAvailable) {
				console.log("[LOGIN] Enabling biometric...");
				const biometricStart = performance.now();
				await storage.enableBiometric(normalizedEmail);
				console.log(
					"[LOGIN] Biometric enabled:",
					performance.now() - startTime,
					"ms (took",
					performance.now() - biometricStart,
					"ms)",
				);
			}

			// Store auth data
			console.log("[LOGIN] Storing auth data...");
			const storeStart = performance.now();
			await storage.storeAuthToken(finishResult.token, normalizedEmail);
			console.log(
				"[LOGIN] Auth token stored:",
				performance.now() - startTime,
				"ms",
			);
			await storage.storeVaultKeys(finishResult.vaultKeys, normalizedEmail);
			console.log(
				"[LOGIN] Vault keys stored:",
				performance.now() - startTime,
				"ms",
			);

			// Store encrypted private key for RSA decryption
			if (finishResult.user.encryptedPrivateKey) {
				await storage.storeEncryptedPrivateKey(
					finishResult.user.encryptedPrivateKey,
					normalizedEmail,
				);
				console.log(
					"[LOGIN] Encrypted private key stored:",
					performance.now() - startTime,
					"ms",
				);
			}

			await storage.storeSecretKey(secretKey, normalizedEmail);
			console.log(
				"[LOGIN] Secret key stored:",
				performance.now() - startTime,
				"ms",
			);
			await storage.storeSessionData(
				masterUnlockKey,
				normalizedEmail,
				finishResult.user.id,
			);
			console.log(
				"[LOGIN] Session data stored:",
				performance.now() - startTime,
				"ms",
			);
			await storage.storeMasterUnlockKey(masterUnlockKey, normalizedEmail);
			console.log(
				"[LOGIN] Master unlock key stored:",
				performance.now() - startTime,
				"ms",
			);
			await storage.storeServerUrl(normalizedServerUrl, normalizedEmail);
			console.log(
				"[LOGIN] Server URL stored:",
				performance.now() - startTime,
				"ms (total store time:",
				performance.now() - storeStart,
				"ms)",
			);

			// Create account metadata
			console.log("[LOGIN] Creating account metadata...");
			const secretKeyHint = `${secretKey.substring(0, 5)}...`;
			const accountMetadata: AccountMetadata = {
				email: normalizedEmail,
				userId: finishResult.user.id,
				name: finishResult.user.name || normalizedEmail.split("@")[0],
				teamName: finishResult.user.teamName,
				secretKeyHint,
				addedAt: Date.now(),
				lastActiveAt: Date.now(),
				biometricEnabled: enableBiometric && biometricAvailable,
			};

			// Add to accounts list and set as active
			console.log("[LOGIN] Adding account to list...");
			const accountListStart = performance.now();
			await storage.addAccountToList(accountMetadata);
			console.log(
				"[LOGIN] Account added to list:",
				performance.now() - startTime,
				"ms (took",
				performance.now() - accountListStart,
				"ms)",
			);
			await storage.setActiveAccount(normalizedEmail);
			console.log(
				"[LOGIN] Active account set:",
				performance.now() - startTime,
				"ms",
			);

			// Refresh account context
			console.log("[LOGIN] Refreshing accounts...");
			const refreshStart = performance.now();
			await refreshAccounts();
			console.log(
				"[LOGIN] Accounts refreshed:",
				performance.now() - startTime,
				"ms (took",
				performance.now() - refreshStart,
				"ms)",
			);

			// Navigate to vault
			console.log(
				"[LOGIN] Navigating to vault... Total time:",
				performance.now() - startTime,
				"ms",
			);
			router.replace("/(vault)");
		} catch (error) {
			console.error("[LOGIN] Login error:", error);
			console.error(
				"[LOGIN] Error occurred at:",
				performance.now() - startTime,
				"ms",
			);
			Alert.alert(
				"Error",
				error instanceof Error ? error.message : "Login failed",
			);
		} finally {
			console.log("[LOGIN] Finally block - setLoading(false)");
			setLoading(false);
		}
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
								disabled={loading}
								className={`mt-4 rounded-lg py-4 ${
									loading ? "bg-primary/50" : "bg-primary"
								}`}
							>
								<Text className="text-center font-semibold text-primary-foreground">
									{loading ? "Signing in..." : "Sign In"}
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
