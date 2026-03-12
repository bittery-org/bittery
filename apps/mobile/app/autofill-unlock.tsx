import {
	useBiometricUnlock,
	usePlatformStorage,
	useQuickUnlock,
	useQuickUnlockAll,
	useSessionState,
} from "@bittery/core/hooks";
import { useQuery } from "@tanstack/react-query";
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
import { arrayBufferToBase64 } from "../src/lib/crypto";
import { resolveBiometricErrorMessage } from "../src/lib/biometric-error-message";
import { useServerUrl } from "../src/lib/trpc";
import { storage } from "../src/services/storage";

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
	const { activeAccount, isAllAccountsMode, allAccounts, refreshAccounts } =
		useAccount();

	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [biometricError, setBiometricError] = useState<string | null>(null);

	// Parse password required flag from deep link
	const passwordRequired = params.passwordRequired === "true";

	// Get session state for the active account
	const { data: sessionState, refetch: refetchSessionState } = useSessionState(
		activeAccount?.email,
		{ enabled: !!activeAccount && !isAllAccountsMode },
	);
	const biometricTypeQuery = useQuery({
		queryKey: ["autofill-unlock", "biometric-type"],
		queryFn: async () => {
			return (await platformStorage.getBiometricType?.()) ?? null;
		},
		enabled: !!activeAccount || isAllAccountsMode,
	});
	const biometricType = biometricTypeQuery.data ?? null;
	const allAccountsStatusQuery = useQuery({
		queryKey: [
			"autofill-unlock",
			"all-accounts-status",
			allAccounts.map((account) => account.email).join("|"),
		],
		queryFn: async () => {
			const emails = allAccounts.map((account) => account.email);
			if (emails.length === 0) {
				return {
					canBiometricUnlock: false,
					requiresPasswordReentry: false,
					isLoading: false,
				};
			}

			const [biometricFlags, reentryFlags] = await Promise.all([
				Promise.all(emails.map((email) => storage.canBiometricUnlock(email))),
				Promise.all(
					emails.map((email) => storage.isMasterPasswordReentryRequired(email)),
				),
			]);

			return {
				canBiometricUnlock: biometricFlags.some(Boolean),
				requiresPasswordReentry: reentryFlags.some(Boolean),
				isLoading: false,
			};
		},
		enabled: isAllAccountsMode,
	});
	const allAccountsStatus = allAccountsStatusQuery.data ?? {
		canBiometricUnlock: false,
		requiresPasswordReentry: false,
		isLoading: allAccountsStatusQuery.isLoading,
	};

	const setNativeMuksForEmails = useCallback(async (emails: string[]) => {
		if (Platform.OS !== "android" || !CredentialProvider.isAvailable()) return;

		for (const email of emails) {
			const muk = await storage.getMasterUnlockKey(email);
			const sessionData = await storage.getStoredSessionData(email);
			const autoLockTimeoutMs =
				await storage.getAutoLockTimeoutOrDefault(email);
			if (muk && sessionData?.userId) {
				const mukBase64 = arrayBufferToBase64(muk);
				CredentialProvider.setMasterUnlockKey(
					mukBase64,
					sessionData.userId,
					autoLockTimeoutMs,
				);
			}
		}
	}, []);

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

					await setNativeMuksForEmails([activeAccount.email]);
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
				error.message || resolveBiometricErrorMessage(error.type || "unknown");

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
				await setNativeMuksForEmails([activeAccount.email]);

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

	const finalizeAllAccountsUnlock = useCallback(
		async (
			result: {
				unlocked: string[];
				failed: Array<{ email: string; error: string }>;
			},
			showPartialAlert: boolean,
		) => {
			if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
				await setNativeMuksForEmails(result.unlocked);
			}

			if (allAccounts.length > 1) {
				await storage.setActiveAccount({ type: "all" });
			} else if (result.unlocked.length === 1) {
				await storage.setActiveAccount({
					type: "single",
					email: result.unlocked[0],
				});
			}

			await refreshAccounts();

			if (showPartialAlert) {
				Alert.alert(
					"Partial Unlock",
					`Unlocked ${result.unlocked.length} of ${allAccounts.length} accounts.`,
				);
			}

			Alert.alert(
				"Unlocked",
				"Your vault is now unlocked. Return to the app to use autofill.",
				[
					{
						text: "OK",
						onPress: () => {
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
		[allAccounts.length, refreshAccounts, router, setNativeMuksForEmails],
	);

	const quickUnlockAll = useQuickUnlockAll({
		onSuccess: async (result) => {
			await finalizeAllAccountsUnlock(result, false);
		},
		onPartialSuccess: async (result) => {
			await finalizeAllAccountsUnlock(result, true);
		},
		onError: (error) => {
			console.error("Unlock all error:", error);
			Alert.alert("Error", error.message || "Unlock failed");
		},
	});

	const handleBiometricUnlock = async () => {
		if (isAllAccountsMode) {
			if (allAccountsStatus.requiresPasswordReentry || passwordRequired) {
				setBiometricError(
					"For your security, please enter your master password. This is required every 30 days.",
				);
				return;
			}

			setBiometricError(null);

			if (!storage.unlockAllAccountsWithBiometric) {
				setBiometricError("Biometric unlock is not available.");
				return;
			}

			try {
				const result = await storage.unlockAllAccountsWithBiometric();
				if (result.unlocked.length === 0) {
					setBiometricError("Biometric authentication failed.");
					return;
				}
				await finalizeAllAccountsUnlock(result, result.failed.length > 0);
			} catch (error) {
				console.error("Biometric unlock all failed:", error);
				setBiometricError("Biometric authentication failed.");
			}
			return;
		}

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
		if (isAllAccountsMode) {
			if (!password.trim()) {
				Alert.alert("Error", "Please enter your password");
				return;
			}

			setBiometricError(null);
			quickUnlockAll.mutate({ password });
			return;
		}

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

	// If no accounts, redirect to login
	if ((!activeAccount && !isAllAccountsMode) || allAccounts.length === 0) {
		router.replace("/(auth)/login");
		return null;
	}

	const loading =
		biometricUnlock.isPending ||
		quickUnlock.isPending ||
		quickUnlockAll.isPending;
	const requiresPasswordReentry =
		passwordRequired ||
		(isAllAccountsMode
			? allAccountsStatus.requiresPasswordReentry
			: sessionState?.requiresPasswordReentry) ||
		false;
	const canUseBiometric = isAllAccountsMode
		? allAccountsStatus.canBiometricUnlock &&
			!requiresPasswordReentry &&
			!allAccountsStatus.isLoading
		: sessionState?.canBiometricUnlock && !requiresPasswordReentry;

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
								Unlock for Autofill
							</Text>
							<Text className="mt-2 text-center text-muted">
								{isAllAccountsMode
									? `All Accounts • ${allAccounts.length} accounts`
									: activeAccount?.email}
							</Text>
						</View>

						{/* Master Password Required Notice */}
						{requiresPasswordReentry && (
							<View className="mb-4 flex-row items-start rounded-lg bg-amber-50 p-4">
								<StyledKeyRound size={20} className="text-amber-600" />
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
										{biometricType === "Face ID" ? (
											<StyledScanFace size={24} className="text-muted" />
										) : (
											<StyledFingerprint size={24} className="text-muted" />
										)}
										<Text className="ml-3 font-medium text-foreground">
											{loading
												? "Authenticating..."
												: `Unlock with ${biometricType || "Biometric"}`}
										</Text>
									</View>
								</Button>
								<View className="my-4 flex-row items-center">
									<View className="h-px flex-1 bg-border" />
									<Text className="mx-4 text-muted">or</Text>
									<View className="h-px flex-1 bg-border" />
								</View>
							</View>
						)}

						{/* Password Form */}
						<View className="gap-4">
							<TextField>
								<Label>Password</Label>
								<View className="w-full flex-row items-center">
									<Input
										placeholder="Enter your password"
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
								{loading ? "Unlocking..." : "Unlock"}
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
								Cancel
							</Button>
						</View>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
