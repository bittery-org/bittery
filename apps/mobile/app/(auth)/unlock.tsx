import {
	useBiometricUnlock,
	usePlatformStorage,
	useQuickUnlock,
	useQuickUnlockAll,
	useSessionState,
} from "@bittery/core/hooks";
import { useRouter } from "expo-router";
import {
	Avatar,
	Button,
	Input,
	Label,
	Select,
	TextField,
	useToast,
} from "heroui-native";
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
	Users,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
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
const StyledUserPlus = withUniwind(UserPlus);
const StyledChevronDown = withUniwind(ChevronDown);
const StyledUsers = withUniwind(Users);

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
	const [targetAccount, setTargetAccount] = useState<AccountMetadata | null>(
		null,
	);
	const [unlockMode, setUnlockMode] = useState<"single" | "all">(
		isAllAccountsMode ? "all" : "single",
	);
	const [selectedAccountValue, setSelectedAccountValue] = useState<{
		value: string;
		label: string;
	}>({ value: "", label: "" });
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

	const setNativeMuksForEmails = useCallback(async (emails: string[]) => {
		if (Platform.OS !== "android" || !CredentialProvider.isAvailable()) return;

		for (const email of emails) {
			const muk = await storage.getMasterUnlockKey(email);
			const sessionData = await storage.getStoredSessionData(email);
			if (muk && sessionData?.userId) {
				const mukBase64 = arrayBufferToBase64(muk);
				CredentialProvider.setMasterUnlockKey(mukBase64, sessionData.userId);
			}
		}
	}, []);

	useEffect(() => {
		if (activeAccount && unlockMode === "single") {
			setTargetAccount(activeAccount);
			setSelectedAccountValue({
				value: activeAccount.email,
				label:
					activeAccount.teamName ||
					activeAccount.name ||
					activeAccount.email.split("@")[0],
			});
		}
		if (!activeAccount && unlockMode === "single" && allAccounts.length > 0) {
			setTargetAccount(allAccounts[0]);
			setSelectedAccountValue({
				value: allAccounts[0].email,
				label:
					allAccounts[0].teamName ||
					allAccounts[0].name ||
					allAccounts[0].email.split("@")[0],
			});
		}
	}, [activeAccount, allAccounts, unlockMode]);

	useEffect(() => {
		if (activeAccountConfig?.type === "all") {
			setUnlockMode("all");
			setTargetAccount(null);
			setSelectedAccountValue({
				value: "all",
				label: "All Accounts",
			});
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
					emails.map((email) => storage.isMasterPasswordReentryRequired(email)),
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
			result: {
				unlocked: string[];
				failed: Array<{ email: string; error: string }>;
			},
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
		[
			allAccounts.length,
			refreshAccounts,
			router,
			setNativeMuksForEmails,
			toast,
		],
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
				await finalizeAllAccountsUnlock(result, result.failed.length > 0);
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

	// Get initials from email or name
	const getInitials = (account?: AccountMetadata | null) => {
		if (!account) return "?";
		if (account.name) {
			const parts = account.name.split(" ");
			if (parts.length >= 2) {
				return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
			}
			return account.name.substring(0, 2).toUpperCase();
		}
		return account.email.substring(0, 2).toUpperCase();
	};

	const handleAccountChange = (
		option: { value: string; label: string } | undefined,
	) => {
		if (!option) return;

		setSelectedAccountValue(option);
		if (option.value === "all") {
			setUnlockMode("all");
			setTargetAccount(null);
		} else {
			const account = allAccounts.find((acc) => acc.email === option.value);
			if (account) {
				setUnlockMode("single");
				setTargetAccount(account);
			}
		}
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
			: (sessionState?.requiresPasswordReentry ?? false);
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
				contentContainerClassName="flex-1"
				className="flex-1"
			>
				<ScrollView
					className="flex-1"
					contentContainerClassName="flex-1"
					keyboardShouldPersistTaps="handled"
				>
					<View className="flex-1 justify-center px-6 py-8">
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
								Unlock Bittery
							</Text>
						</View>

						{/* Account Selector */}
						<View className="mb-6">
							{allAccounts.length > 1 ? (
								<Select
									value={selectedAccountValue}
									onValueChange={handleAccountChange}
								>
									<Select.Trigger>
										<View className="flex-row items-center justify-center gap-3 rounded-2xl bg-surface px-4 py-3">
											{unlockMode === "all" ? (
												<Avatar size="md" alt="All Accounts">
													<Avatar.Fallback>
														<StyledUsers size={20} className="text-muted" />
													</Avatar.Fallback>
												</Avatar>
											) : (
												<Avatar
													size="md"
													alt={
														targetAccount?.name ||
														targetAccount?.email ||
														"Account"
													}
												>
													{targetAccount?.teamAvatarUrl && (
														<Avatar.Image
															source={{ uri: targetAccount.teamAvatarUrl }}
														/>
													)}
													<Avatar.Fallback>
														{getInitials(targetAccount)}
													</Avatar.Fallback>
												</Avatar>
											)}
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
											<StyledChevronDown size={20} className="text-muted" />
										</View>
									</Select.Trigger>
									<Select.Portal>
										<Select.Overlay />
										<Select.Content presentation="dialog">
											<Select.ListLabel>Select Account</Select.ListLabel>
											{allAccounts.length > 1 && (
												<Select.Item value="all" label="All Accounts">
													<View className="flex-row items-center gap-3">
														<Avatar size="md" alt="All Accounts">
															<Avatar.Fallback>
																<StyledUsers size={20} className="text-muted" />
															</Avatar.Fallback>
														</Avatar>
														<View className="flex-1">
															<Select.ItemLabel />
															<Text className="text-muted text-sm">
																{allAccounts.length} accounts
															</Text>
														</View>
													</View>
													<Select.ItemIndicator />
												</Select.Item>
											)}
											{allAccounts.map((account) => (
												<Select.Item
													key={account.email}
													value={account.email}
													label={
														account.teamName ||
														account.name ||
														account.email.split("@")[0]
													}
												>
													<View className="flex-row items-center gap-3">
														<Avatar
															size="md"
															alt={account.name || account.email}
														>
															{account.teamAvatarUrl && (
																<Avatar.Image
																	source={{ uri: account.teamAvatarUrl }}
																/>
															)}
															<Avatar.Fallback>
																{getInitials(account)}
															</Avatar.Fallback>
														</Avatar>
														<View className="flex-1">
															<Select.ItemLabel />
															<Text className="text-muted text-sm">
																{account.email}
															</Text>
														</View>
													</View>
													<Select.ItemIndicator />
												</Select.Item>
											))}
										</Select.Content>
									</Select.Portal>
								</Select>
							) : (
								targetAccount && (
									<View className="items-center">
										<View className="mb-2">
											<Avatar
												size="lg"
												alt={targetAccount.name || targetAccount.email}
											>
												{targetAccount.teamAvatarUrl && (
													<Avatar.Image
														source={{ uri: targetAccount.teamAvatarUrl }}
													/>
												)}
												<Avatar.Fallback>
													{getInitials(targetAccount)}
												</Avatar.Fallback>
											</Avatar>
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
										autoFocus
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
								onPress={() => router.push("/(auth)/login")}
								variant="ghost"
								className="mt-2"
							>
								<View className="flex-row items-center">
									<StyledUserPlus size={16} className="text-muted" />
									<Text className="ml-2 text-muted">
										Sign in with different account
									</Text>
								</View>
							</Button>
						</View>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
