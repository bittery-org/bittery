import { useLogin } from "@bittery/core/hooks";
import {
	type ParsedDeviceSetupPayload,
	parseDeviceSetupParams,
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
	ChevronRight,
	Eye,
	EyeOff,
	Fingerprint,
	Lock,
	Mail,
	QrCode,
	Server,
} from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { useI18n } from "../../src/providers/i18n-provider";
import { type AccountMetadata, storage } from "../../src/services/storage";

// Create styled icon components
const StyledServer = withUniwind(Server);
const StyledMail = withUniwind(Mail);
const StyledLock = withUniwind(Lock);
const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);
const StyledFingerprint = withUniwind(Fingerprint);
const StyledQrCode = withUniwind(QrCode);
const StyledChevronRight = withUniwind(ChevronRight);

export default function LoginScreen() {
	const router = useRouter();
	const { m } = useI18n();
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
	const [setupComplete, setSetupComplete] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [enableBiometric, setEnableBiometric] = useState(true);
	const [biometricAvailable, setBiometricAvailable] = useState(false);
	const [biometricType, setBiometricType] = useState<string | null>(null);
	const [biometricDetails, setBiometricDetails] = useState<{
		hasHardware: boolean;
		isEnrolled: boolean;
	}>({ hasHardware: false, isEnrolled: false });

	const applySetupPayload = useCallback((payload: ParsedDeviceSetupPayload) => {
		setEmail(payload.email);
		setServerUrl(payload.serverUrl);
		if (payload.secretKey) {
			setSecretKey(payload.secretKey);
			setSetupComplete(true);
		}
	}, []);

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
					m.login_alert_setup_loaded_title(),
					m.login_alert_setup_loaded_message(),
				);
			}
		} catch (error) {
			processedSetupParamsRef.current = signature;
			Alert.alert(
				m.login_alert_invalid_setup_title(),
				error instanceof Error
					? error.message
					: m.login_alert_invalid_setup_message(),
			);
		}
	}, [
		searchParams.email,
		searchParams.secretKey,
		searchParams.serverUrl,
		searchParams.setup,
		searchParams.teamName,
		searchParams.v,
		applySetupPayload,
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
				m.login_alert_error_title(),
				error instanceof Error ? error.message : m.login_alert_login_failed_message(),
			);
		},
	});

	const handleLogin = async () => {
		if (!email.trim() || !password.trim() || !secretKey.trim()) {
			Alert.alert(m.login_alert_error_title(), m.login_alert_fields_required_message());
			return;
		}

		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) {
			Alert.alert(m.login_alert_error_title(), m.login_alert_invalid_url_message());
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
					<View className="mb-8 items-center">
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
							{m.login_subtitle()}
						</View>

{setupComplete ? (
						/* Simplified post-scan view */
						<View className="gap-4">
							<View className="items-center gap-1">
								<Text className="font-semibold text-foreground text-xl">
									{m.login_setup_complete_welcome_back()}
								</Text>
								<Text className="text-center text-muted text-sm">
									{email} · {serverUrl}
								</Text>
							</View>

							{/* Password field only */}
							<TextField>
								<Label>{m.auth_signin_label_password()}</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder={m.auth_signin_placeholder_password()}
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

							<Button
								onPress={handleLogin}
								isDisabled={loginMutation.isPending}
								variant="primary"
								size="lg"
							>
								{loginMutation.isPending
									? m.auth_signin_button_signing_in()
									: m.auth_signin_button_sign_in()}
							</Button>

							<Button
								onPress={() => {
									setSetupComplete(false);
									setEmail("");
									setServerUrl(defaultServerUrl);
									setSecretKey("");
									setPassword("");
								}}
								variant="ghost"
							>
								<Text className="text-muted">
									{m.login_setup_complete_not_you()}
								</Text>
							</Button>
						</View>
					) : (
						/* Full login form */
						<View className="gap-4">
							{/* Setting up this device? banner */}
							<Pressable
								onPress={() => setShowSetupScanner(true)}
								className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
							>
								<View className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
									<StyledQrCode size={20} className="text-muted-foreground" />
								</View>
								<View className="flex-1">
									<Text className="font-semibold text-foreground text-sm">
										{m.login_setup_device_banner_title()}
									</Text>
									<Text className="text-muted text-xs">
										{m.login_setup_device_banner_description()}
									</Text>
								</View>
								<StyledChevronRight size={18} className="text-muted" />
							</Pressable>

							{/* Server URL */}
							<TextField>
								<Label>{m.login_server_url_label()}</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder={m.login_server_url_placeholder()}
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
								<Description>{m.login_server_url_description()}</Description>
							</TextField>

							{/* Email */}
							<TextField>
								<Label>{m.auth_signin_label_email()}</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder={m.auth_signin_placeholder_email()}
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
								<Label>{m.auth_signin_label_password()}</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder={m.auth_signin_placeholder_password()}
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
								<Label>{m.auth_signin_label_secret_key()}</Label>
								<Input
									placeholder={m.auth_signin_placeholder_secret_key()}
									value={secretKey}
									onChangeText={setSecretKey}
									autoCapitalize="characters"
									autoCorrect={false}
									className="font-mono"
								/>
								<Description>{m.auth_signin_secret_key_help()}</Description>
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
												{m.login_biometric_enable_label({
													biometricType: biometricType ?? "biometric",
												})}
											</Label>
											<Description>
												{m.login_biometric_enable_description({
													biometricType: biometricType ?? "biometrics",
												})}
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
												{m.login_biometric_not_enrolled_title()}
											</Text>
											<Text className="text-amber-700 text-sm">
												{m.login_biometric_not_enrolled_description({
													biometricType:
														biometricType ?? "Face ID/Touch ID",
												})}
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
								{loginMutation.isPending
									? m.auth_signin_button_signing_in()
									: m.auth_signin_button_sign_in()}
							</Button>

							{/* Sign Up Link */}
							<Button
								onPress={() => router.push("/(auth)/signup")}
								variant="ghost"
								className="mt-2"
							>
								<Text className="text-muted">
									{m.login_signup_link()}{" "}
									<Text className="font-semibold text-primary">
										{m.auth_signin_signup_self_hosted_button()}
									</Text>
								</Text>
							</Button>
						</View>
					)}
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
