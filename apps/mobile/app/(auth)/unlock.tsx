import {
	useBiometricUnlock,
	usePlatformStorage,
	useQuickUnlock,
	useQuickUnlockAll,
	useSessionState,
} from "@bittery/hooks";
import { useRouter } from "expo-router";
import {
	AlertCircle,
	ChevronDown,
	Eye,
	EyeOff,
	Fingerprint,
	KeyRound,
	Lock,
	ScanFace,
	UserPlus,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
	Modal,
	Platform,
	ScrollView,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { useToast } from "heroui-native";
import { SafeAreaView } from "@/components/safe-area-view";
import CredentialProvider from "../../modules/credential-provider";
import { useAccount } from "../../src/contexts/account-context";
import { arrayBufferToBase64 } from "../../src/lib/crypto";
import { useServerUrl } from "../../src/lib/trpc";
import {
	type AccountMetadata,
	getBiometricErrorMessage,
	storage,
} from "../../src/services/storage";

export default function UnlockScreen() {
	const router = useRouter();
	const { toast } = useToast();
	const platformStorage = usePlatformStorage();
	const { setServerUrl: setGlobalServerUrl } = useServerUrl();
	const {
		allAccounts,
		activeAccount,
		activeAccountConfig,
		isAllAccountsMode,
		refreshAccounts,
	} = useAccount();

	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [showAccountPicker, setShowAccountPicker] = useState(false);
	const [targetAccount, setTargetAccount] = useState<AccountMetadata | null>(
		null,
	);
	const [unlockMode, setUnlockMode] = useState<"single" | "all">(
		isAllAccountsMode ? "all" : "single",
	);
	const [allAccountsStatus, setAllAccountsStatus] = useState<{
		canBiometricUnlock: boolean;
		requiresPasswordReentry: boolean;
		isLoading: boolean;
	}>({
		canBiometricUnlock: false,
		requiresPasswordReentry: false,
		isLoading: false,
	});
	const [biometricType, setBiometricType] = useState<string | null>(null);
	const [biometricError, setBiometricError] = useState<string | null>(null);

	// Get session state for the target account
	const { data: sessionState, refetch: refetchSessionState } = useSessionState(
		targetAccount?.email,
		{ enabled: unlockMode === "single" && !!targetAccount },
	);

	// Load biometric type on mount
	const loadBiometricType = useCallback(async () => {
		const type = await platformStorage.getBiometricType?.();
		setBiometricType(type ?? null);
	}, [platformStorage]);

	const setNativeMuksForEmails = useCallback(
		async (emails: string[]) => {
			if (Platform.OS !== "android" || !CredentialProvider.isAvailable()) return;

			for (const email of emails) {
				const muk = await storage.getMasterUnlockKey(email);
				const sessionData = await storage.getStoredSessionData(email);
				if (muk && sessionData?.userId) {
					const mukBase64 = arrayBufferToBase64(muk);
					CredentialProvider.setMasterUnlockKey(mukBase64, sessionData.userId);
				}
			}
		},
		[],
	);

	useEffect(() => {
		if (activeAccount && unlockMode === "single") {
			setTargetAccount(activeAccount);
		}
		if (!activeAccount && unlockMode === "single" && allAccounts.length > 0) {
			setTargetAccount(allAccounts[0]);
		}
	}, [activeAccount, allAccounts, unlockMode]);

	useEffect(() => {
		if (activeAccountConfig?.type === "all") {
			setUnlockMode("all");
			setTargetAccount(null);
		}
	}, [activeAccountConfig]);

	useEffect(() => {
		if (unlockMode === "all") {
			setPassword("");
			setBiometricError(null);
		}
	}, [unlockMode]);

	useEffect(() => {
		if (unlockMode === "all" || targetAccount) {
			loadBiometricType();
		}
	}, [unlockMode, targetAccount, loadBiometricType]);

	useEffect(() => {
		if (unlockMode !== "all") return;
		let cancelled = false;

		const loadAllAccountsStatus = async () => {
			setAllAccountsStatus((prev) => ({ ...prev, isLoading: true }));
			const emails = allAccounts.map((account) => account.email);
			if (emails.length === 0) {
				setAllAccountsStatus({
					canBiometricUnlock: false,
					requiresPasswordReentry: false,
					isLoading: false,
				});
				return;
			}

			const [biometricFlags, reentryFlags] = await Promise.all([
				Promise.all(emails.map((email) => storage.canBiometricUnlock(email))),
				Promise.all(
					emails.map((email) =>
						storage.isMasterPasswordReentryRequired(email),
					),
				),
			]);

			if (cancelled) return;

			setAllAccountsStatus({
				canBiometricUnlock: biometricFlags.some(Boolean),
				requiresPasswordReentry: reentryFlags.some(Boolean),
				isLoading: false,
			});
		};

		loadAllAccountsStatus();

		return () => {
			cancelled = true;
		};
	}, [unlockMode, allAccounts]);

	// Biometric unlock hook
	const biometricUnlock = useBiometricUnlock({
		onSuccess: async () => {
			if (!targetAccount) return;

			// Restore auth token and vault keys
			const token = await storage.getAuthToken(targetAccount.email);
			const vaultKeys = await storage.getVaultKeys(targetAccount.email);

			if (token && vaultKeys) {
				// Decrypt and store master unlock key
				const masterUnlockKey = await storage.decryptStoredMasterUnlockKey(
					targetAccount.email,
					true, // Skip biometric since we just authenticated
				);

				if (masterUnlockKey) {
					await storage.storeMasterUnlockKey(
						masterUnlockKey,
						targetAccount.email,
					);

					await setNativeMuksForEmails([targetAccount.email]);
				}

				// Load server URL for this account
				const serverUrl = await storage.getServerUrl(targetAccount.email);
				if (serverUrl) {
					setGlobalServerUrl(serverUrl);
				}

				// Set as active account
				await storage.setActiveAccount({
					type: "single",
					email: targetAccount.email,
				});
				await refreshAccounts();

				router.replace("/(vault)");
			} else {
				Alert.alert(
					"Session Expired",
					"Please log in again with your credentials.",
				);
				await storage.clearAllStoredData(targetAccount.email);
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
			if (!targetAccount) return;

			// Load server URL for this account
			const serverUrl = await storage.getServerUrl(targetAccount.email);
			if (serverUrl) {
				setGlobalServerUrl(serverUrl);
			}

			// Set MUK in native CredentialProvider for autofill decryption
			if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
				await setNativeMuksForEmails([targetAccount.email]);

				// Update 30-day master password entry timestamp in native
				CredentialProvider.updateLastMasterPasswordEntry();

				// Escrow MUK with biometric for future quick unlocks
				const biometricAvailable =
					await platformStorage.isBiometricAvailable?.();
				const biometricEnabled = await platformStorage.isBiometricEnabled?.(
					targetAccount.email,
				);
				if (biometricAvailable && biometricEnabled) {
					try {
						await CredentialProvider.escrowMukWithBiometric({
							email: targetAccount.email,
							userId: result.user.id,
						});
					} catch (escrowError) {
						// Escrow is optional, don't fail the unlock
						console.warn("Failed to escrow MUK with biometric:", escrowError);
					}
				}
			}

			// Update account metadata
			const updatedMetadata: AccountMetadata = {
				...targetAccount,
				teamName: result.user.teamName,
				lastActiveAt: Date.now(),
			};
			await storage.addAccountToList(updatedMetadata);

			// Refresh account context
			await refreshAccounts();

			router.replace("/(vault)");
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
			result: { unlocked: string[]; failed: Array<{ email: string; error: string }> },
			showPartialToast: boolean,
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

			if (showPartialToast) {
				toast.show({
					variant: "warning",
					label: `Unlocked ${result.unlocked.length} of ${allAccounts.length} accounts`,
					placement: "bottom",
				});
			}

			router.replace("/(vault)");
		},
		[allAccounts.length, refreshAccounts, router, setNativeMuksForEmails, toast],
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
		if (unlockMode === "all") {
			if (allAccountsStatus.requiresPasswordReentry) {
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
				await finalizeAllAccountsUnlock(
					result,
					result.failed.length > 0,
				);
			} catch (error) {
				console.error("Biometric unlock all failed:", error);
				setBiometricError("Biometric authentication failed.");
			}
			return;
		}

		if (!targetAccount) return;

		// Check if master password is required first (UI-level check for immediate feedback)
		if (sessionState?.requiresPasswordReentry) {
			setBiometricError(
				"For your security, please enter your master password. This is required every 30 days.",
			);
			return;
		}

		setBiometricError(null);
		biometricUnlock.mutate({ email: targetAccount.email });
	};

	const handlePasswordUnlock = async () => {
		if (unlockMode === "all") {
			if (!password.trim()) {
				Alert.alert("Error", "Please enter your password");
				return;
			}

			setBiometricError(null);
			quickUnlockAll.mutate({ password });
			return;
		}

		if (!targetAccount || !password.trim()) {
			Alert.alert("Error", "Please enter your password");
			return;
		}

		setBiometricError(null);

		// Load server URL for this account before making the request
		const serverUrl = await storage.getServerUrl(targetAccount.email);
		if (serverUrl) {
			setGlobalServerUrl(serverUrl);
		}

		quickUnlock.mutate({
			email: targetAccount.email,
			password,
		});
	};

	const handleSwitchAccount = async (account: AccountMetadata) => {
		setShowAccountPicker(false);
		setUnlockMode("single");
		setTargetAccount(account);
		setPassword("");
		setBiometricError(null);
	};

	const handleSelectAllAccounts = () => {
		setShowAccountPicker(false);
		setUnlockMode("all");
		setTargetAccount(null);
		setPassword("");
		setBiometricError(null);
	};

	// If no accounts, redirect to login
	if (allAccounts.length === 0) {
		router.replace("/(auth)/login");
		return null;
	}

	const loading =
		biometricUnlock.isPending ||
		quickUnlock.isPending ||
		quickUnlockAll.isPending;
	const requiresPasswordReentry =
		unlockMode === "all"
			? allAccountsStatus.requiresPasswordReentry
			: sessionState?.requiresPasswordReentry ?? false;
	const canUseBiometric =
		unlockMode === "all"
			? allAccountsStatus.canBiometricUnlock &&
				!requiresPasswordReentry &&
				!allAccountsStatus.isLoading
			: sessionState?.canBiometricUnlock && !requiresPasswordReentry;

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
							<View className="mb-4 h-20 w-20 items-center justify-center rounded-2xl bg-primary">
								<Lock size={40} color="#fff" />
							</View>
							<Text className="font-bold text-2xl text-foreground">
								Unlock Bittery
							</Text>
						</View>

						{/* Account Selector */}
						<View className="mb-6">
							{allAccounts.length > 1 ? (
								<TouchableOpacity
									onPress={() => setShowAccountPicker(true)}
									className="flex-row items-center justify-center rounded-lg border border-input bg-background px-4 py-3"
								>
									<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-primary">
										<Text className="font-semibold text-primary-foreground">
											{unlockMode === "all"
												? "All"
												: targetAccount?.name.charAt(0).toUpperCase() || "A"}
										</Text>
									</View>
									<View className="flex-1">
										<Text className="font-medium text-foreground">
											{unlockMode === "all"
												? "All Accounts"
												: targetAccount?.teamName ||
													targetAccount?.name ||
													targetAccount?.email.split("@")[0]}
										</Text>
										<Text className="text-muted text-sm">
											{unlockMode === "all"
												? `${allAccounts.length} accounts`
												: targetAccount?.email}
										</Text>
									</View>
									<ChevronDown size={20} color="#6b7280" />
								</TouchableOpacity>
							) : (
								targetAccount && (
									<View className="items-center">
										<View className="mb-2 h-12 w-12 items-center justify-center rounded-full bg-primary">
											<Text className="font-semibold text-lg text-primary-foreground">
												{targetAccount.name.charAt(0).toUpperCase()}
											</Text>
										</View>
										<Text className="font-medium text-foreground">
											{targetAccount.email}
										</Text>
									</View>
								)
							)}
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
										autoFocus
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
								onPress={() => router.push("/(auth)/login")}
								className="mt-4 flex-row items-center justify-center"
							>
								<UserPlus size={16} color="#6b7280" />
								<Text className="ml-2 text-muted">
									Sign in with different account
								</Text>
							</TouchableOpacity>
						</View>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>

			{/* Account Picker Modal */}
			<Modal
				visible={showAccountPicker}
				transparent
				animationType="slide"
				onRequestClose={() => setShowAccountPicker(false)}
			>
				<TouchableOpacity
					activeOpacity={1}
					onPress={() => setShowAccountPicker(false)}
					className="flex-1 justify-end bg-black/50"
				>
					<View className="rounded-t-3xl bg-background pb-8">
						<View className="items-center py-4">
							<View className="h-1 w-12 rounded-full bg-border" />
						</View>
						<Text className="mb-4 px-6 font-semibold text-foreground text-lg">
							Select Account
						</Text>
						{allAccounts.length > 1 && (
							<TouchableOpacity
								onPress={handleSelectAllAccounts}
								className="flex-row items-center px-6 py-3"
							>
								<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-primary">
									<Text className="font-semibold text-primary-foreground">
										All
									</Text>
								</View>
								<View className="flex-1">
									<Text className="font-medium text-foreground">
										All Accounts
									</Text>
									<Text className="text-muted text-sm">
										{allAccounts.length} accounts
									</Text>
								</View>
								{unlockMode === "all" && (
									<View className="h-2 w-2 rounded-full bg-primary" />
								)}
							</TouchableOpacity>
						)}
						{allAccounts.map((account) => (
							<TouchableOpacity
								key={account.email}
								onPress={() => handleSwitchAccount(account)}
								className="flex-row items-center px-6 py-3"
							>
								<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-primary">
									<Text className="font-semibold text-primary-foreground">
										{account.name.charAt(0).toUpperCase()}
									</Text>
								</View>
								<View className="flex-1">
									<Text className="font-medium text-foreground">
										{account.teamName ||
											account.name ||
											account.email.split("@")[0]}
									</Text>
									<Text className="text-muted text-sm">
										{account.email}
									</Text>
								</View>
								{unlockMode === "single" &&
									account.email === targetAccount?.email && (
									<View className="h-2 w-2 rounded-full bg-primary" />
								)}
							</TouchableOpacity>
						))}
					</View>
				</TouchableOpacity>
			</Modal>
		</SafeAreaView>
	);
}
