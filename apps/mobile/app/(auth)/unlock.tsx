import {
	useBiometricUnlock,
	useQuickUnlock,
	useQuickUnlockAll,
	useSessionState,
} from "@bittery/core/hooks";
import { removeAccount } from "@bittery/core/services/account-lifecycle";
import {
	type UnlockOutcome,
	unlockAllWithBiometric,
} from "@bittery/core/services/unlock";
import { useQuery } from "@tanstack/react-query";
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
import { useCallback, useMemo, useState } from "react";
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
const StyledUserPlus = withUniwind(UserPlus);
const StyledChevronDown = withUniwind(ChevronDown);
const StyledUsers = withUniwind(Users);

import CredentialProvider from "../../modules/credential-provider";
import { useAccount } from "../../src/contexts/account-context";
import { resolveBiometricErrorMessage } from "../../src/lib/biometric-error-message";
import { useServerUrl } from "../../src/lib/rpc";
import { useI18n } from "../../src/providers/i18n-provider";
import { mirrorBorrowedMasterUnlockKeysToCredentialProvider } from "../../src/services/credential-provider-master-unlock-key";
import { lifecycleDeps } from "../../src/services/lifecycle";
import {
	type AccountMetadata,
	itemCache,
	storage,
} from "../../src/services/storage";

export default function UnlockScreen() {
	const router = useRouter();
	const { toast } = useToast();
	const { m } = useI18n();
	const { setServerUrl: setGlobalServerUrl } = useServerUrl();
	const { allAccounts, activeAccount, refreshAccounts } = useAccount();

	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [selectedAccountId, setSelectedAccountId] = useState(
		activeAccount?.accountId ?? allAccounts[0]?.accountId ?? "",
	);
	const [manualUnlockMode, setManualUnlockMode] = useState<"single" | "all">(
		"single",
	);
	const [biometricError, setBiometricError] = useState<string | null>(null);
	// "all" here is an "unlock every account" convenience action; its result
	// still sets a single active account (the app never operates on all at once).
	const unlockMode = manualUnlockMode;
	const targetAccount = useMemo(() => {
		if (unlockMode !== "single") {
			return null;
		}

		return (
			activeAccount ??
			allAccounts.find((account) => account.accountId === selectedAccountId) ??
			allAccounts[0] ??
			null
		);
	}, [activeAccount, allAccounts, selectedAccountId, unlockMode]);
	const selectedAccountValue = useMemo(() => {
		if (unlockMode === "all") {
			return { value: "all", label: m.mob_unlock_all_accounts() };
		}

		if (!targetAccount) {
			return undefined;
		}

		return {
			value: targetAccount.accountId,
			label:
				targetAccount.teamName ||
				targetAccount.name ||
				targetAccount.email.split("@")[0],
		};
	}, [targetAccount, unlockMode, m.mob_unlock_all_accounts]);

	// Get session state for the target account
	const { data: sessionState, refetch: refetchSessionState } = useSessionState(
		targetAccount?.accountId,
		{ enabled: unlockMode === "single" && !!targetAccount },
	);
	const { label: biometricTypeLabel, token: biometricTypeToken } =
		useBiometricType({ enabled: unlockMode === "all" || !!targetAccount });
	const allAccountsStatusQuery = useQuery({
		queryKey: [
			"unlock",
			"all-accounts-status",
			allAccounts.map((account) => account.email).join("|"),
		],
		queryFn: async () => {
			if (allAccounts.length === 0) {
				return {
					canBiometricUnlock: false,
					requiresPasswordReentry: false,
					isLoading: false,
				};
			}

			const [biometricFlags, reentryFlags] = await Promise.all([
				Promise.all(
					allAccounts.map((account) =>
						storage.canBiometricUnlock(account.accountId),
					),
				),
				Promise.all(
					allAccounts.map((account) =>
						storage.isMasterPasswordReentryRequired(account.accountId),
					),
				),
			]);

			return {
				canBiometricUnlock: biometricFlags.some(Boolean),
				requiresPasswordReentry: reentryFlags.some(Boolean),
				isLoading: false,
			};
		},
		enabled: unlockMode === "all",
	});
	const allAccountsStatus = allAccountsStatusQuery.data ?? {
		canBiometricUnlock: false,
		requiresPasswordReentry: false,
		isLoading: allAccountsStatusQuery.isLoading,
	};

	// Biometric unlock hook
	const biometricUnlock = useBiometricUnlock({
		// The OS renders this string, so it is user-facing copy and has to be
		// translated here rather than authored inside the hook.
		promptMessage: m.biometric_prompt_unlock_bittery(),
		onSuccess: async () => {
			if (!targetAccount) return;

			// Restore auth token and vault keys
			const token = await storage.getAuthToken(targetAccount.accountId);
			const vaultKeys = await storage.getVaultKeys(targetAccount.accountId);

			if (token && vaultKeys) {
				await mirrorBorrowedMasterUnlockKeysToCredentialProvider([
					targetAccount.accountId,
				]);

				// Load server URL for this account
				const serverUrl = await storage.getServerUrl(targetAccount.accountId);
				if (serverUrl) {
					setGlobalServerUrl(serverUrl);
				}

				await refreshAccounts();

				router.replace("/(vault)");
			} else {
				Alert.alert(
					m.mob_unlock_alert_session_expired_title(),
					m.mob_unlock_alert_session_expired_message(),
				);
				// The stored session is unusable, so the account goes off the device
				// entirely — removal sequences the store, the item cache and the native
				// autofill mirror together.
				await removeAccount(targetAccount.accountId, lifecycleDeps);
				router.replace("/(auth)/login");
			}
		},
		onError: (error) => {
			// The period only rides along with `master_password_required`, and without it
			// the copy falls back to the variant that cannot name the interval.
			const errorMessage = resolveBiometricErrorMessage(
				{
					error: error.type,
					masterPasswordReentryPeriodMs: error.masterPasswordReentryPeriodMs,
				},
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
		onSuccess: async () => {
			if (!targetAccount) return;

			// Load server URL for this account
			const serverUrl = await storage.getServerUrl(targetAccount.accountId);
			if (serverUrl) {
				setGlobalServerUrl(serverUrl);
			}

			// Set MUK in native CredentialProvider for autofill decryption
			if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
				await mirrorBorrowedMasterUnlockKeysToCredentialProvider([
					targetAccount.accountId,
				]);

				// Update 30-day master password entry timestamp in native
				CredentialProvider.updateLastMasterPasswordEntry();

				// Escrow MUK with biometric for future quick unlocks
				const biometricAvailable = await storage.isBiometricAvailable();
				const biometricEnabled = await storage.isBiometricEnabled(
					targetAccount.accountId,
				);
				if (biometricAvailable && biometricEnabled) {
					// The escrow has to name the same id the native provider was keyed with
					// above: the session's userId, not the account record's.
					const sessionData = await storage.getStoredSessionData(
						targetAccount.accountId,
					);
					if (sessionData?.userId) {
						try {
							await CredentialProvider.escrowMukWithBiometric({
								email: targetAccount.email,
								userId: sessionData.userId,
							});
						} catch (escrowError) {
							// Escrow is optional, don't fail the unlock
							console.warn("Failed to escrow MUK with biometric:", escrowError);
						}
					}
				}
			}

			// Refresh account context
			await refreshAccounts();

			router.replace("/(vault)");
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

	const finalizeAllAccountsUnlock = useCallback(
		async ({ unlocked, failed }: UnlockOutcome) => {
			if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
				await mirrorBorrowedMasterUnlockKeysToCredentialProvider(unlocked);
			}

			await refreshAccounts();

			if (failed.length > 0) {
				toast.show({
					variant: "warning",
					label: m.mob_unlock_partial_toast({
						unlocked: String(unlocked.length),
						total: String(allAccounts.length),
					}),
					placement: "bottom",
				});
			}

			router.replace("/(vault)");
		},
		[
			allAccounts.length,
			refreshAccounts,
			router,
			toast,
			m.mob_unlock_partial_toast,
		],
	);

	const quickUnlockAll = useQuickUnlockAll({
		onSuccess: finalizeAllAccountsUnlock,
		onPartialSuccess: finalizeAllAccountsUnlock,
		onError: (error) => {
			console.error("Unlock all error:", error);
			Alert.alert(
				m.mob_unlock_alert_error_title(),
				error.message || m.mob_unlock_alert_error_unlock_failed(),
			);
		},
	});

	const handleBiometricUnlock = async () => {
		if (unlockMode === "all") {
			if (allAccountsStatus.requiresPasswordReentry) {
				setBiometricError(m.mob_unlock_password_required_description());
				return;
			}

			setBiometricError(null);

			try {
				const outcome = await unlockAllWithBiometric(
					{
						// One OS prompt for every account; the reason it displays is translated
						// here rather than defaulted to English inside `AccountStore`.
						promptMessage: m.biometric_prompt_unlock_all_accounts(),
					},
					{ storage, itemCache },
				);
				if (outcome.unlocked.length === 0) {
					setBiometricError(m.mob_unlock_biometric_failed());
					return;
				}
				await finalizeAllAccountsUnlock(outcome);
			} catch (error) {
				console.error("Biometric unlock all failed:", error);
				setBiometricError(m.mob_unlock_biometric_failed());
			}
			return;
		}

		if (!targetAccount) return;

		// Check if master password is required first (UI-level check for immediate feedback)
		if (sessionState?.requiresPasswordReentry) {
			setBiometricError(m.mob_unlock_password_required_description());
			return;
		}

		setBiometricError(null);
		biometricUnlock.mutate({ accountId: targetAccount.accountId });
	};

	const handlePasswordUnlock = async () => {
		if (unlockMode === "all") {
			if (!password.trim()) {
				Alert.alert(
					m.mob_unlock_alert_error_title(),
					m.mob_unlock_alert_error_enter_password(),
				);
				return;
			}

			setBiometricError(null);
			quickUnlockAll.mutate({ password });
			return;
		}

		if (!targetAccount || !password.trim()) {
			Alert.alert(
				m.mob_unlock_alert_error_title(),
				m.mob_unlock_alert_error_enter_password(),
			);
			return;
		}

		setBiometricError(null);

		// Load server URL for this account before making the request
		const serverUrl = await storage.getServerUrl(targetAccount.accountId);
		if (serverUrl) {
			setGlobalServerUrl(serverUrl);
		}

		quickUnlock.mutate({
			accountId: targetAccount.accountId,
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

		if (option.value === "all") {
			setManualUnlockMode("all");
		} else {
			setManualUnlockMode("single");
			setSelectedAccountId(option.value);
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
				behavior={Platform.OS === "ios" ? "padding" : undefined}
				contentContainerClassName="grow"
				className="flex-1"
			>
				<ScrollView
					className="flex-1"
					contentContainerClassName="grow"
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
								{m.mob_unlock_title()}
							</Text>
						</View>

						{/* Account Selector */}
						<View className="mb-6">
							{allAccounts.length > 1 ? (
								<Select
									value={selectedAccountValue}
									onValueChange={handleAccountChange}
									presentation="dialog"
								>
									<Select.Trigger>
										<View className="flex-row items-center justify-center gap-3 rounded-2xl bg-surface px-4 py-3">
											{unlockMode === "all" ? (
												<Avatar size="md" alt={m.mob_unlock_all_accounts()}>
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
														m.mob_settings_account_fallback()
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
														? m.mob_unlock_all_accounts()
														: targetAccount?.teamName ||
															targetAccount?.name ||
															targetAccount?.email.split("@")[0]}
												</Text>
												<Text className="text-muted text-sm">
													{unlockMode === "all"
														? m.mob_unlock_accounts_count({
																count: String(allAccounts.length),
															})
														: targetAccount?.email}
												</Text>
											</View>
											<StyledChevronDown size={20} className="text-muted" />
										</View>
									</Select.Trigger>
									<Select.Portal>
										<Select.Overlay />
										<Select.Content presentation="dialog">
											<Select.ListLabel>
												{m.mob_unlock_select_account()}
											</Select.ListLabel>
											{allAccounts.length > 1 && (
												<Select.Item
													value="all"
													label={m.mob_unlock_all_accounts()}
												>
													<View className="flex-row items-center gap-3">
														<Avatar size="md" alt={m.mob_unlock_all_accounts()}>
															<Avatar.Fallback>
																<StyledUsers size={20} className="text-muted" />
															</Avatar.Fallback>
														</Avatar>
														<View className="flex-1">
															<Select.ItemLabel />
															<Text className="text-muted text-sm">
																{m.mob_unlock_accounts_count({
																	count: String(allAccounts.length),
																})}
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
								{loading
									? m.mob_unlock_button_unlocking()
									: m.mob_unlock_button_unlock()}
							</Button>

							<Button
								onPress={() => router.push("/(auth)/login")}
								variant="ghost"
								className="mt-2"
							>
								<View className="flex-row items-center">
									<StyledUserPlus size={16} className="text-muted" />
									<Text className="ml-2 text-muted">
										{m.mob_unlock_different_account()}
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
