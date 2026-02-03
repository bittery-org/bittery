import {
	useBiometricUnlock,
	usePlatformStorage,
	useQuickUnlock,
	useSessionState,
} from "@bittery/hooks";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
	AlertCircle,
	Eye,
	EyeOff,
	Fingerprint,
	KeyRound,
	Lock,
	ScanFace,
	ShieldCheck,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
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
import CredentialProvider from "../modules/credential-provider";
import { useAccount } from "../src/contexts/account-context";
import { arrayBufferToBase64 } from "../src/lib/crypto";
import { useServerUrl } from "../src/lib/trpc";
import { getBiometricErrorMessage, storage } from "../src/services/storage";

/**
 * Autofill Unlock Screen
 *
 * This screen is launched from Android's Credential Provider Service when:
 * 1. User taps "Unlock Bittery" from autofill suggestions
 * 2. 30-day master password re-entry is required
 * 3. No biometric escrow is available
 *
 * Deep link format: bittery://autofill-unlock?passwordRequired={true|false}
 */
export default function AutofillUnlockScreen() {
	const router = useRouter();
	const params = useLocalSearchParams<{
		passwordRequired?: string;
	}>();
	const platformStorage = usePlatformStorage();
	const { setServerUrl: setGlobalServerUrl } = useServerUrl();
	const { activeAccount, refreshAccounts } = useAccount();

	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [biometricType, setBiometricType] = useState<string | null>(null);
	const [biometricError, setBiometricError] = useState<string | null>(null);

	// Parse password required flag from deep link
	const passwordRequired = params.passwordRequired === "true";

	// Get session state for the active account
	const { data: sessionState, refetch: refetchSessionState } = useSessionState(
		activeAccount?.email,
		{ enabled: !!activeAccount },
	);

	// Load biometric type on mount
	const loadBiometricType = useCallback(async () => {
		const type = await platformStorage.getBiometricType?.();
		setBiometricType(type ?? null);
	}, [platformStorage]);

	useEffect(() => {
		if (activeAccount) {
			loadBiometricType();
		}
	}, [activeAccount, loadBiometricType]);

	// Biometric unlock hook
	const biometricUnlock = useBiometricUnlock({
		onSuccess: async () => {
			if (!activeAccount) return;

			// Restore auth token and vault keys
			const token = await storage.getAuthToken(activeAccount.email);
			const vaultKeys = await storage.getVaultKeys(activeAccount.email);

			if (token && vaultKeys) {
				// Decrypt and store master unlock key
				const masterUnlockKey = await storage.decryptStoredMasterUnlockKey(
					activeAccount.email,
					true, // Skip biometric since we just authenticated
				);

				if (masterUnlockKey) {
					await storage.storeMasterUnlockKey(
						masterUnlockKey,
						activeAccount.email,
					);

					// Set MUK in native CredentialProvider for autofill decryption
					if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
						const mukBase64 = arrayBufferToBase64(masterUnlockKey);
						const setResult = CredentialProvider.setMasterUnlockKey(mukBase64);
						console.log(
							`[AutofillUnlock] Set native MUK after biometric: ${setResult}`,
						);

						// Verify it was set
						const isUnlocked = CredentialProvider.isVaultUnlocked();
						console.log(
							`[AutofillUnlock] Vault unlocked after biometric: ${isUnlocked}`,
						);
					}
				}

				// Load server URL for this account
				const serverUrl = await storage.getServerUrl(activeAccount.email);
				if (serverUrl) {
					setGlobalServerUrl(serverUrl);
				}

				// Set as active account
				await storage.setActiveAccount({
					type: "single",
					email: activeAccount.email,
				});
				await refreshAccounts();

				// Show success message and close (user returns to autofill)
				Alert.alert(
					"Unlocked",
					"Your vault is now unlocked. Return to the app to use autofill.",
					[
						{
							text: "OK",
							onPress: () => {
								// Close this screen - user can now use autofill
								if (router.canGoBack()) {
									router.back();
								} else {
									router.replace("/(vault)");
								}
							},
						},
					],
				);
			} else {
				Alert.alert(
					"Session Expired",
					"Please log in again with your credentials.",
				);
				await storage.clearAllStoredData(activeAccount.email);
				router.replace("/(auth)/login");
			}
		},
		onError: (error) => {
			// Show specific error message
			const errorMessage =
				error.message || getBiometricErrorMessage(error.type || "unknown");

			if (error.type === "master_password_required") {
				setBiometricError(errorMessage);
				// Refetch session state to update requiresPasswordReentry
				refetchSessionState();
			} else if (error.type === "lockout") {
				setBiometricError(errorMessage);
			} else if (error.type === "user_cancelled") {
				// User cancelled, don't show error
			} else {
				setBiometricError(errorMessage);
			}
		},
	});

	// Quick unlock (password) hook
	const quickUnlock = useQuickUnlock({
		onSuccess: async (result) => {
			if (!activeAccount) return;

			// Load server URL for this account
			const serverUrl = await storage.getServerUrl(activeAccount.email);
			if (serverUrl) {
				setGlobalServerUrl(serverUrl);
			}

			// Set MUK in native CredentialProvider for autofill decryption
			if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
				const mukBase64 = arrayBufferToBase64(result.masterUnlockKey);
				const setResult = CredentialProvider.setMasterUnlockKey(mukBase64);
				console.log(
					`[AutofillUnlock] Set native MUK after password: ${setResult}`,
				);

				// Verify it was set
				const isUnlocked = CredentialProvider.isVaultUnlocked();
				console.log(
					`[AutofillUnlock] Vault unlocked after password: ${isUnlocked}`,
				);

				// Update 30-day master password entry timestamp in native
				CredentialProvider.updateLastMasterPasswordEntry();

				// Escrow MUK with biometric for future quick unlocks
				const biometricAvailable =
					await platformStorage.isBiometricAvailable?.();
				const biometricEnabled = await platformStorage.isBiometricEnabled?.(
					activeAccount.email,
				);
				if (biometricAvailable && biometricEnabled) {
					try {
						await CredentialProvider.escrowMukWithBiometric({
							email: activeAccount.email,
						});
					} catch (escrowError) {
						// Escrow is optional, don't fail the unlock
						console.warn("Failed to escrow MUK with biometric:", escrowError);
					}
				}
			}

			// Refresh account context
			await refreshAccounts();

			// Show success message and close (user returns to autofill)
			Alert.alert(
				"Unlocked",
				"Your vault is now unlocked. Return to the app to use autofill.",
				[
					{
						text: "OK",
						onPress: () => {
							// Close this screen - user can now use autofill
							if (router.canGoBack()) {
								router.back();
							} else {
								router.replace("/(vault)");
							}
						},
					},
				],
			);
		},
		onError: (error) => {
			console.error("Unlock error:", error);
			Alert.alert(
				"Error",
				error instanceof Error ? error.message : "Unlock failed",
			);
		},
	});

	const handleBiometricUnlock = async () => {
		if (!activeAccount) return;

		// Check if master password is required first (UI-level check for immediate feedback)
		if (sessionState?.requiresPasswordReentry || passwordRequired) {
			setBiometricError(
				"For your security, please enter your master password. This is required every 30 days.",
			);
			return;
		}

		setBiometricError(null);
		biometricUnlock.mutate({ email: activeAccount.email });
	};

	const handlePasswordUnlock = async () => {
		if (!activeAccount || !password.trim()) {
			Alert.alert("Error", "Please enter your password");
			return;
		}

		setBiometricError(null);

		// Load server URL for this account before making the request
		const serverUrl = await storage.getServerUrl(activeAccount.email);
		if (serverUrl) {
			setGlobalServerUrl(serverUrl);
		}

		quickUnlock.mutate({
			email: activeAccount.email,
			password,
		});
	};

	// If no account, redirect to login
	if (!activeAccount) {
		router.replace("/(auth)/login");
		return null;
	}

	const loading = biometricUnlock.isPending || quickUnlock.isPending;
	const requiresPasswordReentry =
		passwordRequired || sessionState?.requiresPasswordReentry || false;
	const canUseBiometric =
		sessionState?.canBiometricUnlock && !requiresPasswordReentry;

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
						{/* Header - Autofill Unlock */}
						<View className="mb-8 items-center">
							<View className="mb-4 h-20 w-20 items-center justify-center rounded-2xl bg-primary">
								<ShieldCheck size={40} color="#fff" />
							</View>
							<Text className="font-bold text-2xl text-foreground">
								Unlock for Autofill
							</Text>
							<Text className="mt-2 text-center text-muted">
								{activeAccount.email}
							</Text>
						</View>

						{/* Master Password Required Notice */}
						{requiresPasswordReentry && (
							<View className="mb-4 flex-row items-start rounded-lg bg-amber-50 p-4">
								<KeyRound size={20} color="#f59e0b" />
								<View className="ml-3 flex-1">
									<Text className="font-medium text-amber-800">
										Password Required
									</Text>
									<Text className="text-amber-700 text-sm">
										For your security, please enter your master password. This
										is required every 30 days.
									</Text>
								</View>
							</View>
						)}

						{/* Biometric Error Message */}
						{biometricError && !requiresPasswordReentry && (
							<View className="mb-4 flex-row items-start rounded-lg bg-red-50 p-4">
								<AlertCircle size={20} color="#ef4444" />
								<Text className="ml-3 flex-1 text-red-700 text-sm">
									{biometricError}
								</Text>
							</View>
						)}

						{/* Biometric Unlock */}
						{canUseBiometric && (
							<View className="mb-4">
								<TouchableOpacity
									onPress={handleBiometricUnlock}
									disabled={loading}
									className={`flex-row items-center justify-center rounded-lg border border-input py-4 ${
										loading ? "opacity-50" : ""
									}`}
								>
									{biometricType === "Face ID" ? (
										<ScanFace size={24} color="#6b7280" />
									) : (
										<Fingerprint size={24} color="#6b7280" />
									)}
									<Text className="ml-3 font-medium text-foreground">
										{loading
											? "Authenticating..."
											: `Unlock with ${biometricType || "Biometric"}`}
									</Text>
								</TouchableOpacity>
								<View className="my-4 flex-row items-center">
									<View className="h-px flex-1 bg-border" />
									<Text className="mx-4 text-muted">or</Text>
									<View className="h-px flex-1 bg-border" />
								</View>
							</View>
						)}

						{/* Password Form */}
						<View className="flex gap-5">
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
										autoFocus={requiresPasswordReentry}
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

							<TouchableOpacity
								onPress={handlePasswordUnlock}
								disabled={loading}
								className={`rounded-lg py-4 ${
									loading ? "bg-primary/50" : "bg-primary"
								}`}
							>
								<Text className="text-center font-semibold text-primary-foreground">
									{loading ? "Unlocking..." : "Unlock"}
								</Text>
							</TouchableOpacity>

							<TouchableOpacity
								onPress={() => {
									if (router.canGoBack()) {
										router.back();
									} else {
										router.replace("/(vault)");
									}
								}}
								className="mt-4"
							>
								<Text className="text-center text-muted">
									Cancel
								</Text>
							</TouchableOpacity>
						</View>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
