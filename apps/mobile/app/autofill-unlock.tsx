import {
	useBiometricUnlock,
	useQuickUnlock,
	useSessionState,
} from "@bittery/core/hooks";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Input, Label, TextField } from "heroui-native";
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
import { useCallback, useState } from "react";
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
import { useBiometricType } from "@/lib/biometric-type";

// Create styled icon components
const StyledLock = withUniwind(Lock);
const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);
const StyledFingerprint = withUniwind(Fingerprint);
const StyledScanFace = withUniwind(ScanFace);
const StyledKeyRound = withUniwind(KeyRound);
const StyledAlertCircle = withUniwind(AlertCircle);
const StyledShieldCheck = withUniwind(ShieldCheck);

import CredentialProvider from "../modules/credential-provider";
import { useAccount } from "../src/contexts/account-context";
import { resolveBiometricErrorMessage } from "../src/lib/biometric-error-message";
import { arrayBufferToBase64 } from "../src/lib/crypto";
import { useServerUrl } from "../src/lib/rpc";
import { useI18n } from "../src/providers/i18n-provider";
import { itemCache, storage } from "../src/services/storage";

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
	const { m } = useI18n();
	const params = useLocalSearchParams<{
		passwordRequired?: string;
	}>();
	const { setServerUrl: setGlobalServerUrl } = useServerUrl();
	const { activeAccount, allAccounts, refreshAccounts } = useAccount();

	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [biometricError, setBiometricError] = useState<string | null>(null);

	// Parse password required flag from deep link
	const passwordRequired = params.passwordRequired === "true";

	// Get session state for the active account
	const { data: sessionState, refetch: refetchSessionState } = useSessionState(
		activeAccount?.accountId,
		{ enabled: !!activeAccount },
	);
	const { label: biometricTypeLabel, token: biometricTypeToken } =
		useBiometricType({ enabled: !!activeAccount });

	const setNativeMuksForAccountIds = useCallback(
		async (accountIds: string[]) => {
			if (Platform.OS !== "android" || !CredentialProvider.isAvailable())
				return;

			for (const accountId of accountIds) {
				const muk = await storage.getMasterUnlockKey(accountId);
				const sessionData = await storage.getStoredSessionData(accountId);
				const autoLockTimeoutMs =
					await storage.getAutoLockTimeoutOrDefault(accountId);
				if (muk && sessionData?.userId) {
					const mukBase64 = arrayBufferToBase64(muk);
					CredentialProvider.setMasterUnlockKey(
						mukBase64,
						sessionData.userId,
						autoLockTimeoutMs,
					);
				}
			}
		},
		[],
	);

	// Biometric unlock hook
	const biometricUnlock = useBiometricUnlock({
		// The OS renders this string, so it is user-facing copy and has to be translated
		// here; the hook's own default is a hardcoded English fallback.
		promptMessage: m.biometric_prompt_unlock_bittery(),
		onSuccess: async () => {
			if (!activeAccount) return;

			// Restore auth token and vault keys
			const token = await storage.getAuthToken(activeAccount.accountId);
			const vaultKeys = await storage.getVaultKeys(activeAccount.accountId);

			if (token && vaultKeys) {
				// Decrypt and store master unlock key
				const masterUnlockKey = await storage.decryptStoredMasterUnlockKey(
					activeAccount.accountId,
					true, // Skip biometric since we just authenticated
				);

				if (masterUnlockKey) {
					await storage.setMasterUnlockKey(
						masterUnlockKey,
						activeAccount.accountId,
					);

					await setNativeMuksForAccountIds([activeAccount.accountId]);
				}

				// Load server URL for this account
				const serverUrl = await storage.getServerUrl(activeAccount.accountId);
				if (serverUrl) {
					setGlobalServerUrl(serverUrl);
				}

				// Set as active account
				await storage.setActiveAccount({
					type: "single",
					accountId: activeAccount.accountId,
				});
				await refreshAccounts();

				// Show success message and close (user returns to autofill)
				Alert.alert(
					m.mob_autofill_unlock_alert_unlocked_title(),
					m.mob_autofill_unlock_alert_unlocked_message(),
					[
						{
							text: m.mob_autofill_unlock_alert_ok(),
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
					m.mob_unlock_alert_session_expired_title(),
					m.mob_unlock_alert_session_expired_message(),
				);
				// Sign-out-grade wipe, so the encrypted item cache has to go with it:
				// `AccountStore` sits on a `PlatformPort` and cannot reach the record
				// store, so leaving this out would strand this account's ciphertext on
				// disk after its keys are gone. See packages/storage/CONTEXT.md §4.2.
				await storage.clearAllStoredData(activeAccount.accountId);
				await itemCache.clearItemCache(activeAccount.accountId);
				router.replace("/(auth)/login");
			}
		},
		onError: (error) => {
			// Render from `error.type`, never from `error.message`: that string is an
			// English diagnostic (`AccountStore`'s fallbacks, or the raw native error code
			// the react-native port carries through) and is for logs, not for a screen.
			const errorMessage = resolveBiometricErrorMessage(
				{ error: error.type },
				m,
			);

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
			const serverUrl = await storage.getServerUrl(activeAccount.accountId);
			if (serverUrl) {
				setGlobalServerUrl(serverUrl);
			}

			// Set MUK in native CredentialProvider for autofill decryption
			if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
				await setNativeMuksForAccountIds([activeAccount.accountId]);

				// Update 30-day master password entry timestamp in native
				CredentialProvider.updateLastMasterPasswordEntry();

				// Escrow MUK with biometric for future quick unlocks
				const biometricAvailable = await storage.isBiometricAvailable();
				const biometricEnabled = await storage.isBiometricEnabled(
					activeAccount.accountId,
				);
				if (biometricAvailable && biometricEnabled) {
					try {
						await CredentialProvider.escrowMukWithBiometric({
							email: activeAccount.email,
							userId: result.user.id,
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
				m.mob_autofill_unlock_alert_unlocked_title(),
				m.mob_autofill_unlock_alert_unlocked_message(),
				[
					{
						text: m.mob_autofill_unlock_alert_ok(),
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
				m.mob_unlock_alert_error_title(),
				error instanceof Error
					? error.message
					: m.mob_unlock_alert_error_unlock_failed(),
			);
		},
	});

	const handleBiometricUnlock = async () => {
		if (!activeAccount) return;

		// Check if master password is required first (UI-level check for immediate feedback)
		if (sessionState?.requiresPasswordReentry || passwordRequired) {
			setBiometricError(m.mob_unlock_password_required_description());
			return;
		}

		setBiometricError(null);
		biometricUnlock.mutate({ accountId: activeAccount.accountId });
	};

	const handlePasswordUnlock = async () => {
		if (!activeAccount || !password.trim()) {
			Alert.alert(
				m.mob_unlock_alert_error_title(),
				m.mob_unlock_alert_error_enter_password(),
			);
			return;
		}

		setBiometricError(null);

		// Load server URL for this account before making the request
		const serverUrl = await storage.getServerUrl(activeAccount.accountId);
		if (serverUrl) {
			setGlobalServerUrl(serverUrl);
		}

		quickUnlock.mutate({
			accountId: activeAccount.accountId,
			password,
		});
	};

	// If no accounts, redirect to login
	if (!activeAccount || allAccounts.length === 0) {
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
				contentContainerClassName="flex-1"
				className="flex-1"
			>
				<ScrollView
					className="flex-1"
					contentContainerClassName="flex-1"
					keyboardShouldPersistTaps="handled"
				>
					<View className="flex-1 justify-center px-6 py-8">
						{/* Header - Autofill Unlock */}
						<View className="mb-8 items-center">
							<Button
								isIconOnly
								variant="primary"
								size="lg"
								className="mb-4 h-20 w-20 rounded-2xl"
								isDisabled
							>
								<StyledShieldCheck size={40} className="text-white" />
							</Button>
							<Text className="font-bold text-2xl text-foreground">
								{m.mob_autofill_unlock_title()}
							</Text>
							<Text className="mt-2 text-center text-muted">
								{activeAccount?.email}
							</Text>
						</View>

						{/* Master Password Required Notice */}
						{requiresPasswordReentry && (
							<View className="mb-4 flex-row items-start rounded-lg bg-amber-50 p-4">
								<StyledKeyRound size={20} className="text-amber-600" />
								<View className="ml-3 flex-1">
									<Text className="font-medium text-amber-800">
										{m.mob_unlock_password_required_title()}
									</Text>
									<Text className="text-amber-700 text-sm">
										{m.mob_unlock_password_required_description()}
									</Text>
								</View>
							</View>
						)}

						{/* Biometric Error Message */}
						{biometricError && !requiresPasswordReentry && (
							<View className="mb-4 flex-row items-start rounded-lg bg-red-50 p-4">
								<StyledAlertCircle size={20} className="text-red-500" />
								<Text className="ml-3 flex-1 text-red-700 text-sm">
									{biometricError}
								</Text>
							</View>
						)}

						{/* Biometric Unlock */}
						{canUseBiometric && (
							<View className="mb-4">
								<Button
									onPress={handleBiometricUnlock}
									isDisabled={loading}
									variant="secondary"
									size="lg"
								>
									<View className="flex-row items-center">
										{biometricTypeToken === "face" ? (
											<StyledScanFace size={24} className="text-muted" />
										) : (
											<StyledFingerprint size={24} className="text-muted" />
										)}
										<Text className="ml-3 font-medium text-foreground">
											{loading
												? m.mob_unlock_authenticating()
												: m.mob_unlock_biometric_label({
														biometricType: biometricTypeLabel,
													})}
										</Text>
									</View>
								</Button>
								<View className="my-4 flex-row items-center">
									<View className="h-px flex-1 bg-border" />
									<Text className="mx-4 text-muted">
										{m.mob_unlock_or_divider()}
									</Text>
									<View className="h-px flex-1 bg-border" />
								</View>
							</View>
						)}

						{/* Password Form */}
						<View className="gap-4">
							<TextField>
								<Label>{m.mob_unlock_password_label()}</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder={m.mob_unlock_password_placeholder()}
										value={password}
										onChangeText={setPassword}
										secureTextEntry={!showPassword}
										textContentType="password"
										autoFocus={requiresPasswordReentry}
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
								onPress={handlePasswordUnlock}
								isDisabled={loading}
								variant="primary"
								size="lg"
							>
								{loading
									? m.mob_unlock_button_unlocking()
									: m.mob_unlock_button_unlock()}
							</Button>

							<Button
								onPress={() => {
									if (router.canGoBack()) {
										router.back();
									} else {
										router.replace("/(vault)");
									}
								}}
								variant="ghost"
								className="mt-2"
							>
								{m.mob_settings_cancel()}
							</Button>
						</View>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
