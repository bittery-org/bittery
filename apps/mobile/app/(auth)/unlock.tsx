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
import { Button, PressableFeedback, Select, useToast } from "heroui-native";
import { useCallback, useMemo, useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	Text,
	View,
} from "react-native";
import {
	AccountAvatar,
	AuthDivider,
	BiometricGlyph,
	BrandLockup,
	getAccountLabel,
	InlineNotice,
	PasswordField,
} from "@/components/auth-kit";
import {
	BrandButton,
	IconAlertCircle,
	IconChevronDown,
	IconKeyRound,
	IconLock,
	IconUserPlus,
	IconUsers,
	iconSize,
	layout,
	Screen,
	useBottomInset,
} from "@/components/ui";
import { useAccount } from "@/contexts/account-context";
import { useServerUrl } from "@/lib/api";
import { resolveBiometricErrorMessage } from "@/lib/biometric-error-message";
import { useBiometricType } from "@/lib/biometric-type";
import { useI18n } from "@/providers/i18n-provider";
import { mirrorBorrowedMasterUnlockKeysToCredentialProvider } from "@/services/credential-provider-master-unlock-key";
import { lifecycleDeps } from "@/services/lifecycle";
import { itemCache, storage } from "@/services/storage";
import CredentialProvider from "../../modules/credential-provider";

const ALL_ACCOUNTS_VALUE = "all";

export default function UnlockScreen() {
	const router = useRouter();
	const { toast } = useToast();
	const { m } = useI18n();
	const { setServerUrl: setGlobalServerUrl } = useServerUrl();
	const { allAccounts, activeAccount, refreshAccounts } = useAccount();
	const bottomInset = useBottomInset();

	const [password, setPassword] = useState("");
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

		// The picked account wins over the active one, otherwise choosing a second
		// account in the picker would silently unlock the active one instead.
		return (
			allAccounts.find((account) => account.accountId === selectedAccountId) ??
			activeAccount ??
			allAccounts[0] ??
			null
		);
	}, [activeAccount, allAccounts, selectedAccountId, unlockMode]);
	const selectedAccountValue = useMemo(() => {
		if (unlockMode === "all") {
			return { value: ALL_ACCOUNTS_VALUE, label: m.mob_unlock_all_accounts() };
		}

		if (!targetAccount) {
			return undefined;
		}

		return {
			value: targetAccount.accountId,
			label: getAccountLabel(targetAccount, m.mob_settings_account_fallback()),
		};
	}, [
		targetAccount,
		unlockMode,
		m.mob_unlock_all_accounts,
		m.mob_settings_account_fallback,
	]);

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
					{
						storage,
						itemCache,
						credentialMirror: lifecycleDeps.credentialMirror,
					},
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

	const handleAccountChange = (
		option: { value: string; label: string } | undefined,
	) => {
		if (!option) return;

		if (option.value === ALL_ACCOUNTS_VALUE) {
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
	const accountFallback = m.mob_settings_account_fallback();
	const isAllMode = unlockMode === "all";

	return (
		<Screen aurora>
			<KeyboardAvoidingView
				className="flex-1"
				behavior={Platform.OS === "ios" ? "padding" : undefined}
			>
				<ScrollView
					className="flex-1"
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="interactive"
					showsVerticalScrollIndicator={false}
					contentContainerStyle={{
						flexGrow: 1,
						paddingHorizontal: layout.screenPadding,
						paddingTop: layout.gap.lg,
						paddingBottom: bottomInset,
					}}
				>
					<BrandLockup />

					{/* The form centres itself in whatever the wordmark leaves. */}
					<View className="mt-10 flex-1 justify-center gap-4">
						{allAccounts.length > 1 ? (
							<Select
								value={selectedAccountValue}
								onValueChange={handleAccountChange}
								presentation="dialog"
							>
								<Select.Trigger>
									<View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface px-3.5 py-3 shadow-surface">
										{isAllMode ? (
											<View className="h-10 w-10 items-center justify-center rounded-xl border border-border bg-default">
												<IconUsers
													size={iconSize.bar}
													className="text-foreground"
												/>
											</View>
										) : (
											<AccountAvatar account={targetAccount} />
										)}
										<View className="min-w-0 flex-1">
											<Text
												numberOfLines={1}
												className="font-medium text-base text-foreground"
											>
												{isAllMode
													? m.mob_unlock_all_accounts()
													: targetAccount
														? getAccountLabel(targetAccount, accountFallback)
														: accountFallback}
											</Text>
											<Text numberOfLines={1} className="text-muted text-sm">
												{isAllMode
													? m.mob_unlock_accounts_count({
															count: String(allAccounts.length),
														})
													: targetAccount?.email}
											</Text>
										</View>
										<IconChevronDown
											size={iconSize.bar}
											className="text-muted"
										/>
									</View>
								</Select.Trigger>
								<Select.Portal>
									<Select.Overlay />
									<Select.Content presentation="dialog">
										<Select.ListLabel>
											{m.mob_unlock_select_account()}
										</Select.ListLabel>
										<Select.Item
											value={ALL_ACCOUNTS_VALUE}
											label={m.mob_unlock_all_accounts()}
										>
											<View className="flex-row items-center gap-3">
												<View className="h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface-tertiary">
													<IconUsers
														size={iconSize.bar}
														className="text-foreground"
													/>
												</View>
												<View className="min-w-0 flex-1">
													<Select.ItemLabel />
													<Text
														numberOfLines={1}
														className="text-muted text-sm"
													>
														{m.mob_unlock_accounts_count({
															count: String(allAccounts.length),
														})}
													</Text>
												</View>
											</View>
											<Select.ItemIndicator />
										</Select.Item>
										{allAccounts.map((account) => (
											<Select.Item
												key={account.accountId}
												value={account.accountId}
												label={getAccountLabel(account, accountFallback)}
											>
												<View className="flex-row items-center gap-3">
													<AccountAvatar account={account} />
													<View className="min-w-0 flex-1">
														<Select.ItemLabel />
														<Text
															numberOfLines={1}
															className="text-muted text-sm"
														>
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
						) : targetAccount ? (
							// Same card as the multi-account picker, minus the affordance,
							// so the screen does not change shape with the account count.
							<View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface px-3.5 py-3 shadow-surface">
								<AccountAvatar account={targetAccount} />
								<View className="min-w-0 flex-1">
									<Text
										numberOfLines={1}
										className="font-medium text-base text-foreground"
									>
										{getAccountLabel(targetAccount, accountFallback)}
									</Text>
									<Text numberOfLines={1} className="text-muted text-sm">
										{targetAccount.email}
									</Text>
								</View>
							</View>
						) : null}

						{requiresPasswordReentry ? (
							<InlineNotice
								tone="warning"
								icon={IconKeyRound}
								title={m.mob_unlock_password_required_title()}
								description={m.mob_unlock_password_required_description()}
							/>
						) : null}

						{biometricError && !requiresPasswordReentry ? (
							<InlineNotice
								tone="danger"
								icon={IconAlertCircle}
								description={biometricError}
							/>
						) : null}

						{canUseBiometric ? (
							<>
								<BrandButton
									label={
										loading
											? m.mob_unlock_authenticating()
											: m.mob_unlock_biometric_label({
													biometricType: biometricTypeLabel,
												})
									}
									onPress={handleBiometricUnlock}
									isDisabled={loading}
									size="lg"
									leading={
										<BiometricGlyph
											token={biometricTypeToken}
											size={iconSize.bar}
											className="text-accent-foreground"
										/>
									}
								/>
								<AuthDivider label={m.mob_unlock_or_divider()} />
							</>
						) : null}

						<PasswordField
							label={m.mob_unlock_password_label()}
							placeholder={m.mob_unlock_password_placeholder()}
							value={password}
							onChangeText={setPassword}
							icon={IconLock}
							autoFocus={!canUseBiometric}
							onSubmit={handlePasswordUnlock}
						/>

						{canUseBiometric ? (
							<Button
								onPress={handlePasswordUnlock}
								isDisabled={loading}
								variant="secondary"
								size="lg"
							>
								{loading
									? m.mob_unlock_button_unlocking()
									: m.mob_unlock_button_unlock()}
							</Button>
						) : (
							<BrandButton
								label={
									loading
										? m.mob_unlock_button_unlocking()
										: m.mob_unlock_button_unlock()
								}
								onPress={handlePasswordUnlock}
								isLoading={loading}
								size="lg"
							/>
						)}

						<PressableFeedback
							onPress={() => router.push("/(auth)/login")}
							accessibilityRole="button"
							className="h-11 flex-row items-center justify-center gap-2 rounded-xl"
						>
							<PressableFeedback.Highlight />
							<IconUserPlus size={iconSize.chip} className="text-muted" />
							<Text className="font-medium text-muted text-sm">
								{m.mob_unlock_different_account()}
							</Text>
						</PressableFeedback>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</Screen>
	);
}
